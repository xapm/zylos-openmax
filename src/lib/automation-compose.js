import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const MAX_BYTES = 1024 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const WORKER_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
];

export function composeWorkerEnvironment(source = process.env) {
  return { ...Object.fromEntries(WORKER_ENV_KEYS.filter(key => typeof source[key] === 'string')
    .map(key => [key, source[key]])), OPENMAX_COMPOSE_ISOLATED: '1' };
}

function requestBinding(request) {
  const s = request?.session || {};
  return createHash('sha256').update(JSON.stringify([
    s.session_id, s.conversation_id, s.org_id, s.user_id, s.agent_id, s.schema_version,
    request?.request_id, request?.form_revision, request?.schema_version, request?.content,
  ])).digest('hex');
}

export function validateComposeResult(value) {
  if (!object(value)) throw new Error('invalid compose result');
  if (value.kind === 'proposal' && object(value.draft)) return { kind: value.kind, draft: value.draft };
  if (['clarification', 'error'].includes(value.kind) && typeof value.message === 'string'
      && value.message.trim() && value.message.length <= 16000) {
    return { kind: value.kind, message: value.message };
  }
  throw new Error('invalid compose result');
}

export function validateComposeRequest(request, orgId, agentId, now = Date.now()) {
  const session = request?.session;
  if (!object(session) || session.org_id !== orgId || session.agent_id !== agentId
      || session.schema_version !== 1 || request.schema_version !== 1
      || !Number.isFinite(session.expires_at_ms) || session.expires_at_ms <= now
      || !['active', 'open'].includes(session.status)
      || request.status !== 'pending'
      || ![session.session_id, session.conversation_id, session.user_id, request.request_id].every(
        value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value))
      || typeof request.content !== 'string' || !request.content.trim()
      || Buffer.byteLength(request.content) > MAX_BYTES
      || typeof request.form_revision !== 'string') {
    throw new Error('invalid compose request binding');
  }
  return request;
}

export function validComposeWorker(config) {
  if (config?.enabled !== true || !path.isAbsolute(config.command || '')
      || !Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string')) return false;
  try { fs.accessSync(config.command, fs.constants.X_OK); return true; } catch { return false; }
}

// Only the drafting prompt enters the worker; trusted reply routing never does.
export async function runComposeWorker(config, content, { signal } = {}) {
  if (!validComposeWorker(config)) throw new Error('compose worker unavailable');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-compose-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(config.command, config.args, {
        cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        env: composeWorkerEnvironment(),
      });
      const timeoutMs = Math.min(Math.max(config.timeout_ms || 120000, 1000), 300000);
      let output = '', bytes = 0, failure;
      const fail = error => {
        failure ||= error;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* Already exited. */ }
      };
      const abort = () => fail(new Error('compose worker cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => fail(new Error('compose worker timed out')), timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) fail(new Error('compose worker output too large'));
        else output += chunk.toString();
      });
      // Never log worker stderr: it may contain user prompts or credentials.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', error => { clearTimeout(timer); reject(new Error(`compose worker failed: ${error.code || 'spawn'}`)); });
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure || code !== 0) return reject(failure || new Error('compose worker failed'));
        try { resolve(validateComposeResult(JSON.parse(output))); }
        catch { reject(new Error('compose worker returned invalid JSON')); }
      });
      child.stdin.end(JSON.stringify({ schema_version: 1, content }));
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

export function createComposeConsumer({ orgId, agentId: agentIdentity, get, post, config, authorize = async () => false, run = runComposeWorker, probe, warn = () => {}, now = Date.now }) {
  const currentAgentId = () => typeof agentIdentity === 'function' ? agentIdentity() : agentIdentity;
  let stopped = false, polling = false, registeredAt = 0, timer, readyConfig = '', probeFailedAt = 0;
  const controller = new AbortController();
  // Retain a completed result until the server acknowledges it; transport retry
  // must not invoke the model again within this process.
  const completed = new Map();
  const base = '/automation-compose';
  const unwrap = response => response?.data ?? response;
  async function tick() {
    const agentId = currentAgentId();
    if (stopped || polling || !orgId || !agentId || !validComposeWorker(config())) return;
    polling = true;
    try {
      const signature = JSON.stringify(config());
      if (readyConfig !== signature) {
        if (probeFailedAt && now() - probeFailedAt < 60000) return;
        try {
          if (probe) await probe(config());
          else validateComposeResult(await run(config(), 'Readiness check only. Return exactly {"kind":"clarification","message":"Ready"}. Do not perform any actions.', { signal: controller.signal }));
          readyConfig = signature;
          probeFailedAt = 0;
        } catch { probeFailedAt = now(); throw new Error('compose worker not ready'); }
      }
      if (!registeredAt || now() - registeredAt >= 60000) {
        await post(`${base}/capabilities/register`, { schema_version: 1 });
        registeredAt = now();
      }
      const pending = unwrap(await get(`${base}/requests/pending?limit=20`));
      if (!Array.isArray(pending)) throw new Error('invalid compose queue');
      const liveKeys = new Set(pending.map(requestBinding));
      for (const key of completed.keys()) if (!liveKeys.has(key)) completed.delete(key);
      for (const item of pending) {
        if (stopped) break;
        try {
          if (now() - registeredAt >= 60000) {
            await post(`${base}/capabilities/register`, { schema_version: 1 });
            registeredAt = now();
          }
          const request = structuredClone(validateComposeRequest(item, orgId, agentId, now()));
          const key = requestBinding(request);
          let result = completed.get(key);
          if (!result) {
            try {
              result = (await authorize(request)) === true
                ? await run(config(), request.content, { signal: controller.signal })
                : { kind: 'error', message: 'You do not have permission to draft with this agent.' };
            }
            catch {
              if (stopped) break;
              result = { kind: 'error', message: 'The agent could not generate a draft. Please try again.' };
            }
            result = validateComposeResult(result);
            completed.set(key, result);
          }
          if (stopped) break;
          // Fetch again after inference: cancelled/expired sessions and stale turns
          // must never receive a result merely because they were pending earlier.
          const latest = unwrap(await get(`${base}/sessions/${request.session.session_id}/requests/${request.request_id}`));
          if (latest.status !== 'pending') { completed.delete(key); continue; }
          validateComposeRequest(latest, orgId, agentId, now());
          if (requestBinding(latest) !== key) throw new Error('compose binding changed');
          if (currentAgentId() !== agentId) throw new Error('compose agent changed');
          if ((await authorize(latest)) !== true) {
            result = { kind: 'error', message: 'You do not have permission to draft with this agent.' };
            completed.set(key, result);
          }
          const resultRoute = `${base}/sessions/${request.session.session_id}/requests/${request.request_id}/result`;
          const envelope = {
            conversation_id: request.session.conversation_id,
            form_revision: request.form_revision, schema_version: 1, result,
          };
          try { await post(resultRoute, envelope); }
          catch (error) {
            if (![400, 422].includes(error.status) || result.kind !== 'proposal') throw error;
            const rejected = { kind: 'error', message: 'The generated draft could not be validated. Please try again.' };
            completed.set(key, rejected);
            await post(resultRoute, { ...envelope, result: rejected });
          }
          completed.delete(key);
        } catch { warn('automation compose request failed; no ordinary-message fallback'); }
      }
    } catch { warn('automation compose poll failed; no ordinary-message fallback'); }
    finally { polling = false; }
  }
  return {
    tick,
    start() { if (!timer) { timer = setInterval(() => void tick(), 5000); timer.unref?.(); void tick(); } },
    stop() { stopped = true; clearInterval(timer); controller.abort(); },
  };
}
