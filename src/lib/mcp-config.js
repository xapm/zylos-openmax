/**
 * MCP connector sink (Route A) — materialize a cws-connect `connector_kind="mcp"`
 * connection into a live LOCAL Claude Code MCP server the agent's runtime can use.
 *
 * Route A means the agent connects to the remote MCP server DIRECTLY (cws-connect
 * is not on the tools/list · tools/call path); the platform only authorizes the
 * connection and hands us its server config (a `raw_config` JSON template + the
 * discrete fields) plus the connection credential. This module is the thin sink
 * that turns that Acquire response into a registered MCP server via the Claude
 * Code CLI, rather than hand-editing `~/.claude.json` (settled — proposal §9.4).
 *
 * UNIFIED INSTALL (design §4.2 / §7): every transport goes through ONE path,
 * `claude mcp add-json <name> '<json>'`, which the CLI supports for
 * stdio/SSE/HTTP/WebSocket alike. We build a single MCP-server JSON object —
 * preferring the Acquire-delivered `raw_config` as the template, else assembling
 * it from the discrete fields — and INJECT the live credential into it at install
 * time (design Problem ①):
 *
 *   - HTTP/SSE/WS: the credential merges into the JSON's `headers`
 *     (Authorization etc.), per the `auth_injection` recipe; a query-placed token
 *     rides in the `url` instead.
 *   - stdio:       the credential merges into the JSON's `env` (the piece that
 *     was missing — a stdio server like github used to launch with an EMPTY env),
 *     per the `env:<KEY>` auth-injection binding cws-connect now delivers (!176).
 *
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
 *   - The auth header/env is assembled from the Acquire response's `auth_injection`
 *     recipe ({location, name, value_template} with a literal "{token}", or the
 *     string binding forms "env:KEY" / "header:Authorization(Bearer)"), NEVER a
 *     hardcoded "Authorization: Bearer". Absent auth_injection, a token defaults to
 *     the canonical "Authorization: <scheme> <token>" header (scheme derived from
 *     token_type, mirroring direct-exec.js); a `none` auth_type / no token yields
 *     no injection at all.
 *   - `protocol_version` is deliberately NOT surfaced (the REST Acquire DTO omits
 *     it; §9.4 settled to leave it out) — do not add it.
 *   - Best-effort + injectable: the command runner (`execFile`) and `cwd` are
 *     dependency-injected (matching connection-events.js / channel-connector.js),
 *     and every exec is wrapped so a CLI failure returns { ok:false } instead of
 *     throwing into the connection-event handler.
 *
 * SECURITY: the token rides inside the JSON string argument (an env value or a
 * header value), passed via execFile (argv, no shell — no shell-injection
 * surface). It is NEVER logged: success log lines carry the server name, type,
 * command-or-host and cwd only, never the assembled env/headers, and the FAILURE
 * path never surfaces the exec error's `.message` / `.cmd` / `.stdout` / `.stderr`
 * raw (those carry the full JSON incl. the injected credential) — see
 * safeExecFailure, which returns an exit-code-only reason (or a secret-redacted
 * fallback that scrubs both the raw and URL-encoded token).
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
 * Map the Acquire `mcp_server.transport` to the Claude Code MCP JSON `type`.
 * remote_http → "http", "sse" → "sse", "stdio" → "stdio". Anything unknown/empty
 * defaults to "http" — the primary remote transport. (A raw_config that already
 * carries its own `type` — e.g. "ws" — is honored verbatim and never remapped.)
 */
export function transportFlag(transport) {
  const t = String(transport || '').toLowerCase();
  if (t === 'stdio') return 'stdio';
  if (t === 'sse') return 'sse';
  return 'http';
}

/**
 * Whether an mcp_server config describes a stdio (local subprocess) connector.
 * True when the transport says stdio, OR (defensively) when it carries a `command`
 * and no `server_url` — a remote config always has server_url, a stdio one a
 * command. Decides which branch of the JSON builder runs.
 */
export function isStdioConfig(mcp) {
  if (!mcp || typeof mcp !== 'object') return false;
  if (String(mcp.transport || '').toLowerCase() === 'stdio') return true;
  return !!mcp.command && !mcp.server_url;
}

/**
 * Parse mcp_server.args into a string[]. The REST DTO may deliver it as a JSON
 * array (native fetch parses it) or as a JSON string (belt-and-suspenders, like
 * parseHeadersTemplate). Anything else → []. Each element is coerced to a string.
 */
export function parseArgs(args) {
  let arr = args;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((a) => (a == null ? '' : String(a)));
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
 * `add-json`, that argv includes the JSON with the injected credential (an env
 * value or a header value), and for query-auth the token in the URL. Surfacing
 * `e.message` raw would leak the token into logs and the upstream error reason.
 * So we NEVER surface argv/message/stdout/stderr: we return the exit code alone,
 * and only when there is no exit code (a non-exec error) fall back to a
 * secret-redacted message.
 */
function safeExecFailure(op, e, secrets = []) {
  const code = e && (e.code != null ? e.code : e.signal);
  if (code != null && code !== '') return `claude mcp ${op} failed (exit ${code})`;
  return `claude mcp ${op} failed: ${redactSecrets(e && e.message, secrets)}`;
}

/** Parse a headers/env template into a plain string→string object. */
function parseStringMap(tmpl) {
  if (!tmpl) return {};
  let obj = tmpl;
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
 * Normalize an auth_injection descriptor into { location, name, valueTemplate }.
 * Accepts the structured object {location, name, value_template} AND the string
 * binding forms the design records (§5.1): "env:GITHUB_TOKEN",
 * "header:Authorization", "header:Authorization(Bearer)", "query:access_token".
 * A "(Scheme)" suffix on a string binding means the value is "<Scheme> {token}".
 * Returns null when there is no usable descriptor.
 */
export function normalizeAuthInjection(ai) {
  if (!ai) return null;
  if (typeof ai === 'string') {
    const m = ai.match(/^\s*(env|header|query)\s*:\s*([^()]+?)\s*(?:\(([^)]*)\))?\s*$/i);
    if (!m) return null;
    const name = m[2].trim();
    if (!name) return null;
    const scheme = m[3] && m[3].trim();
    return { location: m[1].toLowerCase(), name, valueTemplate: scheme ? `${scheme} {token}` : '{token}' };
  }
  if (typeof ai === 'object' && ai.name) {
    const location = String(ai.location || 'header').toLowerCase();
    const valueTemplate = typeof ai.value_template === 'string' && ai.value_template ? ai.value_template : '{token}';
    return { location, name: ai.name, valueTemplate };
  }
  return null;
}

/**
 * Resolve where + how the live credential is injected. Returns
 * { location:'header'|'env'|'query', name, value } (the {token} expanded), or
 * null when there is nothing to inject (auth_type "none" / no token and no
 * descriptor). With a descriptor we follow it verbatim (never a hardcoded
 * Bearer); with no descriptor but a token present we default to the canonical
 * Authorization header (scheme from token_type, mirroring direct-exec.js).
 */
export function resolveInjection({ accessToken, tokenType, authInjection } = {}) {
  const token = accessToken == null ? '' : String(accessToken);
  const norm = normalizeAuthInjection(authInjection);
  if (norm) {
    return { location: norm.location, name: norm.name, value: norm.valueTemplate.replace(/\{token\}/g, token) };
  }
  if (!token) return null;
  return { location: 'header', name: 'Authorization', value: `${canonicalAuthScheme(tokenType)} ${token}` };
}

/**
 * Resolve the single auth HEADER from the Acquire response's `auth_injection`
 * recipe (never a hardcoded Bearer). Returns { name, value } for a header-placed
 * token, or null when the token belongs in env or the query string, or when
 * there is no auth to inject. Kept as a focused helper for callers/tests that
 * only care about the header case; the JSON builder uses resolveInjection.
 *
 * @param {object} [opts]
 *   - accessToken   the acquired token (the {token} substitution value)
 *   - tokenType     credential token_type → default Authorization scheme
 *   - authInjection { location, name, value_template } | "header:...:" string
 */
export function buildAuthHeader({ accessToken, tokenType, authInjection } = {}) {
  const inj = resolveInjection({ accessToken, tokenType, authInjection });
  if (!inj || inj.location !== 'header') return null;
  return { name: inj.name, value: inj.value };
}

/** Merge one header into a headers object, auth WINNING on a case-insensitive
 * name clash (§5.4: "同名头以 auth_injection 为准"). Mutates + returns `headers`. */
function mergeHeader(headers, name, value) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) delete headers[k];
  }
  headers[name] = value;
  return headers;
}

/** Parse a raw_config JSON template into a deep-cloned plain object, or null. */
function parseRawConfig(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  try { return JSON.parse(JSON.stringify(obj)); } catch { return null; }
}

/** Derive the JSON `type` for a raw_config that omits it. */
function typeOfRaw(base, mcp) {
  if (base.type) return String(base.type);
  if (base.command && !base.url) return 'stdio';
  return transportFlag(base.transport || (mcp && mcp.transport));
}

/** Append a query param to a URL string (token rides here for query-auth). */
function appendQuery(url, name, value) {
  const u = String(url || '');
  return `${u}${u.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(value)}`;
}

/**
 * Build the single MCP-server JSON object for `claude mcp add-json`, injecting
 * the live credential at install time. Prefers `rawConfig` as the template
 * (design §4.2: the stored JSON = a template with the secret left as a
 * placeholder); otherwise assembles from the discrete mcp_server fields.
 *
 * @param {object} mcpServer   the Acquire mcp_server ({ transport, server_url,
 *                             headers_template, command, args, env, raw_config })
 * @param {object} [opts]      { accessToken, tokenType, authInjection, rawConfig }
 * @returns {object} the JSON object to stringify (never mutates the inputs)
 */
export function buildMcpServerJson(mcpServer, { accessToken, tokenType, authInjection, rawConfig } = {}) {
  const mcp = mcpServer && typeof mcpServer === 'object' ? mcpServer : {};
  const raw = parseRawConfig(rawConfig);
  const injection = resolveInjection({ accessToken, tokenType, authInjection });

  let base;
  let type;
  if (raw) {
    base = raw;
    type = typeOfRaw(base, mcp);
    base.type = type;
  } else if (isStdioConfig(mcp)) {
    type = 'stdio';
    base = { type, command: mcp.command == null ? '' : String(mcp.command), args: parseArgs(mcp.args), env: parseStringMap(mcp.env) };
  } else {
    type = transportFlag(mcp.transport);
    base = { type, url: mcp.server_url == null ? '' : String(mcp.server_url), headers: parseStringMap(mcp.headers_template) };
  }
  const isStdio = String(type).toLowerCase() === 'stdio';

  // Inject the live credential (design Problem ①). stdio → env; remote → headers
  // (or the URL query for a query-placed token). An injection whose location does
  // not fit the transport (e.g. a header default for a stdio server, which has no
  // headers) is simply not applied.
  if (injection) {
    if (isStdio) {
      if (injection.location === 'env') {
        base.env = { ...(base.env && typeof base.env === 'object' ? base.env : {}), [injection.name]: injection.value };
      }
    } else if (injection.location === 'header') {
      base.headers = mergeHeader(base.headers && typeof base.headers === 'object' ? base.headers : {}, injection.name, injection.value);
    } else if (injection.location === 'query') {
      base.url = appendQuery(base.url, injection.name, injection.value);
    }
  }

  // Drop empty container fields so the JSON stays minimal (and add-json doesn't
  // record a bare `"env":{}` / `"headers":{}` / `"args":[]`).
  if (Array.isArray(base.args) && base.args.length === 0) delete base.args;
  if (base.env && typeof base.env === 'object' && Object.keys(base.env).length === 0) delete base.env;
  if (base.headers && typeof base.headers === 'object' && Object.keys(base.headers).length === 0) delete base.headers;

  return base;
}

/**
 * Register/refresh a connection's MCP server in the agent's local Claude Code
 * config via the UNIFIED `claude mcp add-json` path. Idempotent: removes any
 * same-named server first (so a token refresh cleanly replaces the old one),
 * then adds. Best-effort — returns { ok:false, reason } instead of throwing.
 *
 * @param {object} conn              { id, slug } — connection identity for the name
 * @param {object} acquireResponse   the Acquire response ({ mcp_server, raw_config,
 *                                    access_token, token_type, auth_injection,
 *                                    connector_kind })
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
    // raw_config may ride on mcp_server (preferred) or at the response root.
    const rawConfig = (mcp && mcp.raw_config) != null ? mcp.raw_config
      : (acquireResponse && acquireResponse.raw_config);
    if ((!mcp || typeof mcp !== 'object') && !rawConfig) {
      warn(`[mcp-config] upsert skipped conn=${connId}: acquire response carries no mcp_server / raw_config`);
      return { ok: false, reason: 'no-mcp-server' };
    }
    const name = mcpServerName(conn && conn.slug, connId);

    const json = buildMcpServerJson(mcp, {
      accessToken: acquireResponse.access_token,
      tokenType: acquireResponse.token_type,
      authInjection: acquireResponse.auth_injection,
      rawConfig,
    });
    const isStdio = String(json.type || '').toLowerCase() === 'stdio';

    // Validate BEFORE touching the CLI so a malformed config makes zero calls.
    if (isStdio) {
      if (!json.command) {
        warn(`[mcp-config] upsert skipped conn=${connId}: stdio config carries no command`);
        return { ok: false, reason: 'no-command' };
      }
    } else if (!json.url) {
      warn(`[mcp-config] upsert skipped conn=${connId}: remote config carries no server_url`);
      return { ok: false, reason: 'no-mcp-server' };
    }

    // Remove-then-add so a refresh replaces the prior credential cleanly (a bare
    // add of an existing name can be rejected). The remove is best-effort — a
    // first-time add has nothing to remove.
    try {
      await execFile('claude', ['mcp', 'remove', '-s', 'local', name], { cwd, timeout: timeoutMs });
    } catch { /* no prior server registered — fine */ }

    const args = ['mcp', 'add-json', '-s', 'local', name, JSON.stringify(json)];
    await execFile('claude', args, { cwd, timeout: timeoutMs });
    // NEVER log the JSON — it carries the injected credential (env value / header).
    // Name + type + command-or-host + cwd only (host = url with any query stripped).
    const where = isStdio ? `command=${json.command}` : `url=${String(json.url).split('?')[0]}`;
    log(`[mcp-config] MCP server upserted (add-json) name=${name} type=${json.type} ${where} cwd=${cwd}`);
    return { ok: true, name };
  } catch (e) {
    // Redact the token: on a failed add-json, e.message/.cmd carry the full argv
    // including the JSON with the injected credential AND, for query-location
    // auth, the token in the URL where it rides as encodeURIComponent(...) — so we
    // scrub BOTH the raw token and its URL-encoded form (exact-substring redaction
    // won't catch the encoded value otherwise). encodeURIComponent is per-char, so
    // encodeURIComponent(token) is always a substring of the encoded URL value.
    const tok = acquireResponse && acquireResponse.access_token;
    const secrets = tok
      ? [...new Set([String(tok), encodeURIComponent(String(tok))])] // dedupe (equal when no special chars)
      : [];
    const reason = safeExecFailure('add-json', e, secrets);
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
