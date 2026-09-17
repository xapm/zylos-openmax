/**
 * MCP connector sink (Route A) — materialize a cws-connect `connector_kind="mcp"`
 * connection into a live LOCAL Claude Code MCP server the agent's runtime can use.
 *
 * Route A means the agent connects to the remote MCP server DIRECTLY (cws-connect
 * is not on the tools/list · tools/call path); the platform only authorizes the
 * connection and hands us its non-secret server config + a token. This module is
 * the thin sink that turns that Acquire response into a registered MCP server via
 * the Claude Code CLI (`claude mcp add/remove`), rather than hand-editing
 * `~/.claude.json` (the settled decision — see the design proposal §9.4).
 *
 *   - HTTP:  `claude mcp add -s local -t http <name> <url> -H "<Header>: <value>"`
 *   - remove: `claude mcp remove -s local <name>`
 *
 * DESIGN NOTES (all pinned by the proposal §9.4 / §10):
 *   - `-s local` scope writes `~/.claude.json` → projects[<cwd>].mcpServers, which
 *     is auto-trusted (no approval prompt) — unlike a project-level `.mcp.json`,
 *     which a headless agent could never approve. So the config MUST be written
 *     under the AGENT'S OWN launch cwd key: the comm-bridge service runs from a
 *     DIFFERENT cwd, so `process.cwd()` would land the server under the wrong
 *     projects[...] key — written "successfully" but invisible to the agent (a
 *     silent failure, §10). We resolve the agent launch cwd the same way
 *     agent-readiness.js does (ZYLOS_DIR or ~/zylos).
 *   - The server name embeds the connection_id so two connections of the SAME app
 *     never collide (owner-confirmed default).
 *   - The auth header is assembled from the Acquire response's `auth_injection`
 *     recipe ({location, name, value_template} with a literal "{token}"), NEVER a
 *     hardcoded "Authorization: Bearer". Absent auth_injection falls back to the
 *     canonical "Authorization: <scheme> <token>" convention (scheme derived from
 *     token_type, mirroring direct-exec.js), and a `none` auth_type / no token
 *     yields no auth header at all.
 *   - `protocol_version` is deliberately NOT surfaced (the REST Acquire DTO omits
 *     it; §9.4 settled to leave it out) — do not add it.
 *   - Best-effort + injectable: the command runner (`execFile`) and `cwd` are
 *     dependency-injected (matching connection-events.js / channel-connector.js),
 *     and every exec is wrapped so a CLI failure returns { ok:false } instead of
 *     throwing into the connection-event handler.
 *
 * SECURITY: the token rides in a `-H` argument (an argv, via execFile — no shell,
 * so no shell-injection surface). It is NEVER logged: success log lines carry the
 * server name, URL and cwd only, never the assembled headers, and the FAILURE path
 * never surfaces the exec error's `.message` / `.cmd` / `.stdout` / `.stderr` raw
 * (those carry the full argv incl. the `-H` auth header) — see safeExecFailure,
 * which returns an exit-code-only reason (or a secret-redacted fallback).
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import { canonicalAuthScheme } from './direct-exec.js';

const realExecFile = promisify(execFileCb);

// Default timeout for a `claude mcp` invocation. The CLI edits a local JSON file
// (no network), so this is generous — it only guards against a wedged process.
export const DEFAULT_MCP_CLI_TIMEOUT_MS = 15000;

/**
 * The agent's own launch cwd — the projects[...] key `-s local` writes under.
 * Resolved exactly like agent-readiness.js (ZYLOS_DIR or ~/zylos); NOT
 * process.cwd(), because the comm-bridge service runs from a different directory
 * than the agent runtime (see the module header / proposal §9.4 + §10).
 */
export function agentLaunchCwd() {
  return process.env.ZYLOS_DIR || path.join(process.env.HOME || os.homedir(), 'zylos');
}

/** Whether a record (Acquire response OR index entry) is an MCP connector. */
export function isMcpConnection(x) {
  if (!x || typeof x !== 'object') return false;
  return x.connector_kind === 'mcp' || x.connectorKind === 'mcp';
}

/**
 * Stable, CLI/filesystem-safe MCP server name. Embeds the connection_id so two
 * connections of the same app never collide (owner-confirmed default):
 *   openmax-<slug>-<connectionId>
 * Any character outside [A-Za-z0-9_-] is replaced with '-'; a missing slug falls
 * back to "mcp" (the connection_id — a UUID — still guarantees uniqueness).
 */
export function mcpServerName(slug, connectionId) {
  const safe = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '-');
  const s = safe(slug) || 'mcp';
  return `openmax-${s}-${safe(connectionId)}`;
}

/**
 * Map the Acquire `mcp_server.transport` to the Claude CLI `-t` transport flag.
 * P0 in scope is remote_http → "http". "sse" passes through (legacy remote), and
 * anything unknown (incl. "stdio", a P2 shape not materialized here) defaults to
 * "http" — the only remote transport we assemble a URL for.
 */
export function transportFlag(transport) {
  const t = String(transport || '').toLowerCase();
  if (t === 'remote_http' || t === 'http' || t === '' ) return 'http';
  if (t === 'sse') return 'sse';
  return 'http';
}

/** Scrub known secret substrings from a string (best-effort, all occurrences). */
function redactSecrets(str, secrets = []) {
  let out = String(str == null ? '' : str);
  for (const s of secrets) {
    if (s) out = out.split(String(s)).join('***');
  }
  return out;
}

/**
 * Build a log/return-safe failure reason for a `claude mcp` exec.
 *
 * SECURITY: a promisified execFile rejection carries the FULL argv in
 * `.message` / `.cmd` (and possibly the token in `.stdout` / `.stderr`). For an
 * `add`, that argv includes `-H "Authorization: <token>"` (and, for query-auth,
 * the token in the URL). Surfacing `e.message` raw — as the previous catch blocks
 * did — leaks the token into logs and the upstream error reason. So we NEVER
 * surface argv/message/stdout/stderr: we return the exit code alone, and only when
 * there is no exit code (a non-exec error) fall back to a secret-redacted message.
 */
function safeExecFailure(op, e, secrets = []) {
  const code = e && (e.code != null ? e.code : e.signal);
  if (code != null && code !== '') return `claude mcp ${op} failed (exit ${code})`;
  return `claude mcp ${op} failed: ${redactSecrets(e && e.message, secrets)}`;
}

/** Parse mcp_server.headers_template into a plain string→string object. */
function parseHeadersTemplate(headersTemplate) {
  if (!headersTemplate) return {};
  let obj = headersTemplate;
  // The REST DTO carries it as raw JSON; native fetch parses it to an object, but
  // tolerate a JSON string too (belt-and-suspenders for other transports).
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k) out[k] = v == null ? '' : String(v);
  }
  return out;
}

/**
 * Resolve the single auth header from the Acquire response's `auth_injection`
 * recipe (never a hardcoded Bearer). Returns { name, value } for a header-placed
 * token, or null when the token belongs in the query string (caller appends it to
 * the URL) or when there is no auth to inject (auth_type "none" / no token).
 *
 * @param {object} [opts]
 *   - accessToken   the acquired token (the {token} substitution value)
 *   - tokenType     credential token_type → default Authorization scheme
 *   - authInjection { location:'header'|'query', name, value_template }
 */
export function buildAuthHeader({ accessToken, tokenType, authInjection } = {}) {
  const token = accessToken == null ? '' : String(accessToken);
  if (authInjection && typeof authInjection === 'object' && authInjection.name) {
    // A query-placed token cannot be a header — caller rides it in the URL.
    if (authInjection.location === 'query') return null;
    const vt = typeof authInjection.value_template === 'string' && authInjection.value_template
      ? authInjection.value_template
      : '{token}';
    return { name: authInjection.name, value: vt.replace(/\{token\}/g, token) };
  }
  // No auth_injection descriptor. With no token (auth_type "none") there is no
  // header. Otherwise fall back to the canonical convention — scheme derived from
  // token_type (mirrors direct-exec.js canonicalAuthScheme), NOT a hardcoded Bearer.
  if (!token) return null;
  return { name: 'Authorization', value: `${canonicalAuthScheme(tokenType)} ${token}` };
}

/**
 * Assemble the ordered `-H` args: the connector's non-secret headers_template
 * first, then the auth header last so it WINS on a case-insensitive name clash
 * (the §5.4 merge rule: "同名头以 auth_injection 为准"). Returns a flat argv slice
 * like ["-H", "X-Tenant: acme", "-H", "Authorization: Bearer …"].
 */
export function buildHeaderArgs(mcpServer, authHeader) {
  const headers = parseHeadersTemplate(mcpServer && mcpServer.headers_template);
  if (authHeader && authHeader.name) {
    const lower = authHeader.name.toLowerCase();
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) delete headers[k];
    }
    headers[authHeader.name] = authHeader.value;
  }
  const args = [];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  return args;
}

/**
 * Register/refresh a connection's MCP server in the agent's local Claude Code
 * config. Idempotent: removes any same-named server first (so a token refresh
 * cleanly replaces the old one), then adds. Best-effort — returns
 * { ok:false, reason } instead of throwing.
 *
 * @param {object} conn              { id, slug } — connection identity for the name
 * @param {object} acquireResponse   the Acquire response ({ mcp_server, access_token,
 *                                    token_type, auth_injection, connector_kind })
 * @param {object} [deps]            { execFile, cwd, log, warn, timeoutMs }
 */
export async function upsertMcpServer(conn, acquireResponse, deps = {}) {
  const {
    execFile = realExecFile,
    cwd = agentLaunchCwd(),
    log = () => {},
    warn = () => {},
    timeoutMs = DEFAULT_MCP_CLI_TIMEOUT_MS,
  } = deps;
  const connId = conn && conn.id;
  try {
    const mcp = acquireResponse && acquireResponse.mcp_server;
    if (!mcp || !mcp.server_url) {
      warn(`[mcp-config] upsert skipped conn=${connId}: acquire response carries no mcp_server.server_url`);
      return { ok: false, reason: 'no-mcp-server' };
    }
    const name = mcpServerName(conn && conn.slug, connId);
    const authHeader = buildAuthHeader({
      accessToken: acquireResponse.access_token,
      tokenType: acquireResponse.token_type,
      authInjection: acquireResponse.auth_injection,
    });

    // A query-placed token rides in the URL (a header can't express it).
    let url = String(mcp.server_url);
    const ai = acquireResponse.auth_injection;
    if (ai && typeof ai === 'object' && ai.location === 'query' && ai.name) {
      const vt = typeof ai.value_template === 'string' && ai.value_template ? ai.value_template : '{token}';
      const val = vt.replace(/\{token\}/g, acquireResponse.access_token == null ? '' : String(acquireResponse.access_token));
      url += `${url.includes('?') ? '&' : '?'}${ai.name}=${encodeURIComponent(val)}`;
    }

    const headerArgs = buildHeaderArgs(mcp, authHeader);

    // Remove-then-add so a refresh replaces the prior token cleanly (a bare `add`
    // of an existing name can be rejected). The remove is best-effort — a
    // first-time add has nothing to remove.
    try {
      await execFile('claude', ['mcp', 'remove', '-s', 'local', name], { cwd, timeout: timeoutMs });
    } catch { /* no prior server registered — fine */ }

    const args = ['mcp', 'add', '-s', 'local', '-t', transportFlag(mcp.transport), name, url, ...headerArgs];
    await execFile('claude', args, { cwd, timeout: timeoutMs });
    // NEVER log headerArgs — they carry the token. Name + URL + cwd only.
    log(`[mcp-config] MCP server upserted name=${name} url=${mcp.server_url} cwd=${cwd}`);
    return { ok: true, name };
  } catch (e) {
    // Redact the token: on a failed `claude mcp add`, e.message/.cmd carry the
    // full argv including the `-H` auth header and any query-auth URL.
    const reason = safeExecFailure('add', e, [acquireResponse && acquireResponse.access_token]);
    warn(`[mcp-config] upsertMcpServer failed conn=${connId}: ${reason}`);
    return { ok: false, reason };
  }
}

/**
 * Remove a connection's MCP server from the agent's local Claude Code config.
 * Idempotent + best-effort — returns { ok:false, reason } instead of throwing
 * (removing an already-absent server is not an error we surface).
 *
 * @param {object} conn   { id, slug } — connection identity for the name
 * @param {object} [deps] { execFile, cwd, log, warn, timeoutMs }
 */
export async function removeMcpServer(conn, deps = {}) {
  const {
    execFile = realExecFile,
    cwd = agentLaunchCwd(),
    log = () => {},
    warn = () => {},
    timeoutMs = DEFAULT_MCP_CLI_TIMEOUT_MS,
  } = deps;
  const connId = conn && conn.id;
  try {
    const name = mcpServerName(conn && conn.slug, connId);
    await execFile('claude', ['mcp', 'remove', '-s', 'local', name], { cwd, timeout: timeoutMs });
    log(`[mcp-config] MCP server removed name=${name} cwd=${cwd}`);
    return { ok: true, name };
  } catch (e) {
    // `remove` argv holds no token, but stay consistent (exit-code-only) so no
    // exec message/argv is ever surfaced raw from this module.
    const reason = safeExecFailure('remove', e);
    warn(`[mcp-config] removeMcpServer failed conn=${connId}: ${reason}`);
    return { ok: false, reason };
  }
}
