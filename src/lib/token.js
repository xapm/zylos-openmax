/**
 * JWT token manager for cws-core auth flow.
 *
 * Three operations (cws-core auth.go):
 *
 *   exchange:   POST /auth/agent/token
 *               Authorization: Bearer <api_key>  (cwsk_xxx)
 *               Body: { org_id? }                 (empty body == identity-only JWT)
 *               → { access_token, access_token_expires_at,
 *                   refresh_token, refresh_token_expires_at }
 *
 *   refresh:    POST /auth/refresh
 *               Authorization: Bearer <access_token>
 *               Body: { refresh_token, org_id? }
 *               → rotated token pair
 *
 *   wsTicket:   POST /auth/ws-ticket
 *               Authorization: Bearer <access_token>
 *               Body: { org_id }   (server requires org-scoped JWT)
 *               → { ticket, expires_at }  (30s TTL, one-time)
 *
 * Per-org caching: access_tokens are bound to a specific org_id, so we
 * cache state in a Map keyed by org_id (or '' for identity-only). Disk
 * persistence likewise lives at runtime/tokens/<org_id|_identity>.json.
 *
 * Inflight Promise dedup: concurrent callers asking for the same org's JWT
 * share a single in-flight HTTP request — important on boot when N orgs spin
 * up at once and again when a CLI fan-outs several calls before the cache
 * is warm.
 *
 * Cross-process refresh single-flight: the in-memory dedup above only covers
 * one process, but several processes share one token file — the comm-bridge
 * daemon, CLI calls, and the detached channel-connect watchers (one per
 * pending QR). cws-core rotates the refresh_token on every /auth/refresh and
 * treats a second use of an already-rotated refresh_token as reuse: it revokes
 * the whole token family and blacklists its access tokens. So two processes
 * refreshing from their own stale in-memory copy kill each other's session
 * (seen as a spurious channel-connect failure when two QR waits overlap).
 * refresh() therefore takes a per-org lock file, re-reads the token file
 * under the lock, adopts a pair another process already rotated, and only
 * otherwise refreshes — always with the latest refresh_token on disk.
 *
 * Side-effect on first exchange: when org-scoped JWT comes back, we decode
 * the `member_id` claim and write it back into `config.orgs[slug].self.member_id`
 * if that field is empty. This lets interactive install skip asking the
 * operator for member_id — the agent learns its own identity from cws-core.
 *
 * No dependency on client.js — uses raw fetch to avoid circular imports.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, resolveDefaultOrgId, updateConfig } from './config.js';
import { cfAccessHeaders } from './cf-access.js';
import { redactSecrets } from './redact.js';

const HOME = process.env.HOME || '/tmp';
const TOKEN_DIR = path.join(HOME, 'zylos/components/openmax/runtime/tokens');
const REFRESH_MARGIN_MS = 60_000;   // refresh when <60 s remain on access_token
// Cross-process refresh lock. A holder older than LOCK_STALE_MS is assumed
// dead (crashed mid-refresh) and its lock is broken; waiters poll every
// LOCK_POLL_MS. Stale must exceed one refresh round trip by a wide margin.
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 50;

const LOG = '[token]';

// ── per-org in-memory cache ──────────────────────────────────────────────────
const _stateByOrg = new Map();
// Each value: { access_token, access_token_expires_at (ms),
//               refresh_token, refresh_token_expires_at (ms),
//               member_id? (decoded from claims) }

// ── inflight Promise dedup (per cache key) ──────────────────────────────────
const _inflight = new Map();  // key → Promise

function withInflight(key, factory) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = factory().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// ── config helpers ────────────────────────────────────────────────────────────

function resolveApiKey() {
  return process.env.COCO_API_KEY || loadConfig().agent?.api_key || '';
}

function resolveCoreUrl() {
  const cfg = loadConfig();
  const base = process.env.COCO_API_URL || cfg.server?.bff_url || cfg.comm?.core_url || 'http://127.0.0.1:8080';
  return base.replace(/\/$/, '');
}

function resolveOrgId(orgId) {
  if (orgId) return orgId;
  return resolveDefaultOrgId();
}

function tokenFile(orgIdOrEmpty) {
  const safe = orgIdOrEmpty ? orgIdOrEmpty : '_identity';
  return path.join(TOKEN_DIR, `${safe}.json`);
}

// ── raw HTTP helper (no auth dependency) ─────────────────────────────────────
// RPC logging mirrors client.js: stdout controlled by COCO_RPC_LOG (default ON,
// '0' = off), file sink controlled by COCO_RPC_LOG_FILE (independent of
// stdout). Logged bodies are passed through redactSecrets() first — these are
// the token-exchange endpoints, so the body itself IS the access/refresh
// token; logging the raw body defeats the point of a log toggle.

function rpcLogStdoutEnabled() {
  return process.env.COCO_RPC_LOG !== '0';
}
function rpcLogFilePath() {
  const p = process.env.COCO_RPC_LOG_FILE;
  return p && p.length > 0 ? p : null;
}
let _rpcLogFileEnsured = false;
function ensureRpcLogDir(filePath) {
  if (_rpcLogFileEnsured) return;
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch {}
  _rpcLogFileEnsured = true;
}
function appendRpcLine(line) {
  const filePath = rpcLogFilePath();
  if (!filePath) return;
  try {
    ensureRpcLogDir(filePath);
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`);
  } catch { /* best-effort */ }
}

async function corePost(endpoint, body, bearerToken) {
  const url = `${resolveCoreUrl()}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...cfAccessHeaders(),
  };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  {
    const line = `[rpc] → POST ${url} req: ${JSON.stringify(redactSecrets(body))}`;
    if (rpcLogStdoutEnabled()) console.log(line);
    appendRpcLine(line);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  {
    const redacted = typeof data === 'string' ? data : redactSecrets(data);
    const bodyStr = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
    const line = `[rpc] ← POST ${url} resp ${res.status}: ${bodyStr}`;
    if (rpcLogStdoutEnabled()) {
      const level = res.status >= 400 ? 'warn' : 'log';
      console[level](line);
    }
    appendRpcLine(line);
  }

  if (!res.ok) {
    // cws-core nests the human-readable detail under `error`:
    //   { error: { title, status, detail, code, errors: [...] }, ... }
    // A flat `data.error` extraction coerced that object to "[object Object]".
    // Mirror client.js: drill into the envelope, then flat shapes, then text.
    let msg;
    if (data && typeof data === 'object') {
      const env = (data.error && typeof data.error === 'object') ? data.error : null;
      msg = (env && (env.detail || env.title))
         || data.detail
         || data.message
         || (typeof data.error === 'string' ? data.error : null);
    }
    if (!msg) msg = text || `HTTP ${res.status}`;
    const err = new Error(`${endpoint}: ${String(msg)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toMs(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  return new Date(val).getTime() || 0;
}

// ── JWT claim decoding (no signature check — for member_id extraction only) ─

function decodeJwtClaims(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function writeBackMemberId(orgId, jwt) {
  if (!orgId || !jwt) return;
  const claims = decodeJwtClaims(jwt);
  const memberId = claims?.member_id || claims?.mid;
  if (!memberId) return;
  const cfg = loadConfig();
  for (const [slug, org] of Object.entries(cfg.orgs || {})) {
    if (org?.org_id !== orgId) continue;
    if (org.self?.member_id) return;       // already set, leave it
    updateConfig((c) => {
      const o = c.orgs?.[slug];
      if (!o) return;
      if (!o.self) o.self = { member_id: '', name: '' };
      if (!o.self.member_id) {
        o.self.member_id = memberId;
        console.log(`${LOG} auto-filled orgs.${slug}.self.member_id from JWT claims: ${memberId}`);
      }
    });
    return;
  }
}

// ── disk persistence (per-org) ───────────────────────────────────────────────

function readDisk(orgIdOrEmpty) {
  try { return JSON.parse(fs.readFileSync(tokenFile(orgIdOrEmpty), 'utf-8')); }
  catch { return null; }
}

function writeDisk(orgIdOrEmpty, state) {
  try {
    // mkdir/writeFileSync mode only applies on creation; chmod an
    // already-existing dir/file too so perms get fixed even if the file
    // predates this hardening (e.g. an existing 0644 file from before).
    fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(TOKEN_DIR, 0o700); } catch {}
    const file = tokenFile(orgIdOrEmpty);
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch (e) {
    console.warn(`${LOG} writeDisk(${orgIdOrEmpty || '_identity'}) failed:`, e.message);
  }
}

// ── cross-process refresh lock (per-org lock file) ──────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lockFile(orgIdOrEmpty) {
  return `${tokenFile(orgIdOrEmpty)}.lock`;
}

/**
 * Run `fn` while holding the per-org lock file (O_EXCL create). Fail-open on
 * filesystem errors other than EEXIST: losing the lock only reopens the race
 * this guards against, it must never block token acquisition outright.
 */
async function withFileLock(orgIdOrEmpty, fn) {
  const file = lockFile(orgIdOrEmpty);
  const owner = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let held = false;
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  } catch {}
  for (;;) {
    try {
      fs.writeFileSync(file, owner, { flag: 'wx', mode: 0o600 });
      held = true;
      break;
    } catch (e) {
      if (e?.code !== 'EEXIST') {
        console.warn(`${LOG} refresh lock(${orgIdOrEmpty || '_identity'}) unavailable, proceeding unlocked:`, e.message);
        break;
      }
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; } // vanished: retry now
      if (ageMs > LOCK_STALE_MS) {
        console.warn(`${LOG} breaking stale refresh lock(${orgIdOrEmpty || '_identity'}) age=${ageMs}ms`);
        try { fs.unlinkSync(file); } catch {}
        continue;
      }
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    if (held) {
      try {
        if (fs.readFileSync(file, 'utf-8') === owner) fs.unlinkSync(file);
      } catch {}
    }
  }
}

function isFresh(state) {
  return Boolean(state?.access_token) && state.access_token_expires_at - Date.now() > REFRESH_MARGIN_MS;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Exchange api_key for a fresh JWT pair. Pass orgId='' (or omit) for an
 * identity-only JWT (no org context). Pass a real orgId for an org-scoped
 * JWT (server validates active membership; 401 if missing).
 */
export async function exchange(orgIdArg) {
  const oid = orgIdArg || '';                  // '' == identity-only
  return withInflight(`exchange:${oid}`, async () => {
    const apiKey = resolveApiKey();
    if (!apiKey) throw new Error('token.exchange: config.agent.api_key not set');
    const body = oid ? { org_id: oid } : {};
    console.log(`${LOG} exchange org=${oid || '(identity-only)'}`);
    const raw = await corePost('/auth/agent/token', body, apiKey);
    const d = (raw && typeof raw === 'object' && raw.data) ? raw.data : raw;
    const state = {
      access_token:             d.access_token,
      access_token_expires_at:  toMs(d.access_token_expires_at),
      refresh_token:            d.refresh_token,
      refresh_token_expires_at: toMs(d.refresh_token_expires_at),
    };
    _stateByOrg.set(oid, state);
    writeDisk(oid, state);
    if (oid) writeBackMemberId(oid, state.access_token);
    console.log(`${LOG} exchange ok org=${oid || '(identity-only)'} exp=${new Date(state.access_token_expires_at).toISOString()}`);
    return state.access_token;
  });
}

export async function refresh(orgIdArg) {
  const oid = orgIdArg || '';
  return withInflight(`refresh:${oid}`, () => withFileLock(oid, async () => {
    // Re-read under the lock: the token file is the cross-process source of
    // truth. Our in-memory copy may hold a refresh_token another process has
    // already rotated; sending it again is reuse and revokes the family.
    const mem = _stateByOrg.get(oid);
    const disk = readDisk(oid);
    if (isFresh(disk) && disk.access_token !== mem?.access_token) {
      _stateByOrg.set(oid, disk);
      console.log(`${LOG} refresh org=${oid || '(identity-only)'} adopted pair rotated by another process`);
      return disk.access_token;
    }
    const s = disk?.refresh_token ? disk : mem;
    if (!s?.refresh_token) return exchange(oid);
    try {
      const body = oid ? { refresh_token: s.refresh_token, org_id: oid }
                       : { refresh_token: s.refresh_token };
      console.log(`${LOG} refresh org=${oid || '(identity-only)'}`);
      const raw = await corePost('/auth/refresh', body, s.access_token);
      const d = (raw && typeof raw === 'object' && raw.data) ? raw.data : raw;
      const state = {
        access_token:             d.access_token,
        access_token_expires_at:  toMs(d.access_token_expires_at),
        refresh_token:            d.refresh_token ?? s.refresh_token,
        refresh_token_expires_at: toMs(d.refresh_token_expires_at) || s.refresh_token_expires_at,
      };
      _stateByOrg.set(oid, state);
      writeDisk(oid, state);
      if (oid) writeBackMemberId(oid, state.access_token);
      console.log(`${LOG} refresh ok org=${oid || '(identity-only)'} exp=${new Date(state.access_token_expires_at).toISOString()}`);
      return state.access_token;
    } catch (err) {
      console.warn(`${LOG} refresh(${oid || '_identity'}) failed, re-exchanging with api_key:`, err.message);
      return exchange(oid);
    }
  }));
}

/**
 * Return a valid access token for the given org (or identity-only when orgId
 * is empty). Uses the cache when possible; falls through to refresh/exchange.
 *
 * IMPORTANT: callers that need an org-scoped JWT (e.g. before ws-ticket) must
 * pass a non-empty orgId. Callers that explicitly want identity-only (e.g.
 * org-create flow) should pass '' or omit.
 */
export async function getAccessToken(orgIdArg) {
  const oid = orgIdArg || '';
  let s = _stateByOrg.get(oid);
  if (!s) {
    s = readDisk(oid);
    if (s) _stateByOrg.set(oid, s);
  }
  const now = Date.now();
  if (s?.access_token && s.access_token_expires_at - now > REFRESH_MARGIN_MS) {
    return s.access_token;
  }
  if (s?.refresh_token) return refresh(oid);
  return exchange(oid);
}

export async function getWsTicket(orgIdArg) {
  const oid = resolveOrgId(orgIdArg);
  if (!oid) throw new Error('token.getWsTicket: org_id required (no default org configured)');
  const accessToken = await getAccessToken(oid);
  console.log(`${LOG} ws-ticket org=${oid}`);
  const raw = await corePost('/auth/ws-ticket', { org_id: oid }, accessToken);
  const d = (raw && typeof raw === 'object' && raw.data) ? raw.data : raw;
  if (!d.ticket) throw new Error('token.getWsTicket: server returned no ticket');
  console.log(`${LOG} ws-ticket ok org=${oid}`);
  return d.ticket;
}

/**
 * Invalidate the cached token for a specific org (e.g. after WS 4003).
 * If no orgId is passed, clears the entire cache.
 */
export function invalidate(orgIdArg) {
  if (orgIdArg === undefined) {
    _stateByOrg.clear();
    return;
  }
  _stateByOrg.delete(orgIdArg || '');
}
