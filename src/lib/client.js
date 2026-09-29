/**
 * Shared HTTP client for all REST calls.
 *
 * The agent only talks to ONE REST surface: cws-core (server.bff_url).
 * cws-core acts as the gateway for cws-kb and cws-as — KB/AS routes are
 * forwarded server-side, not called directly.
 *
 *   - cws-core gateway → /me, /members, /agents, /projects, /tasks, /issues,
 *                        /conversations, /conversations/{id}/messages,
 *                        /api/v1/kbs/*, /api/v1/orgs/{orgId}/*,
 *                        /api/v1/artifacts/*
 *                        base URL  : server.bff_url
 *                        scope hdr : X-Org-Id (for kb/as paths)
 *
 * Multi-org JWT routing
 * ---------------------
 * Every request resolves its bearer token via `getAccessToken(orgId)`. When
 * the caller threads an `orgId` (kbClient/asClient factories, comm-bridge's
 * per-org REST helpers `getForOrg`/`postForOrg`/...), that org's cached JWT
 * is used. When `orgId` is omitted, we fall back to `resolveDefaultOrgId()`
 * (env COCO_ORG_ID, or the single enabled org). This keeps single-org
 * deployments and one-shot CLIs working without code changes, while
 * multi-org deployments get correctly-scoped tokens per request.
 *
 * Cloudflare Access (test env only): every request is also tagged with the
 * CF-Access-Client-Id / CF-Access-Client-Secret headers from `cf-access.js`.
 * Delete that import + spread when promoting to production.
 *
 * On success: returns parsed JSON (or raw text if response is not JSON).
 * On HTTP error: throws Error whose .message is the server's error detail
 * and .status carries the HTTP status code.
 */

import { loadConfig, resolveDefaultOrgId } from './config.js';
import { getAccessToken, invalidate as invalidateToken } from './token.js';
import { cfAccessHeaders } from './cf-access.js';
import { redactSecrets } from './redact.js';

// 401 → refresh-and-retry throttle. Keyed by effective orgId (default-org
// resolved when orgId is omitted). Records the timestamp of the last
// 401-triggered refresh; subsequent 401s within the window propagate
// without re-refreshing — protects /auth/refresh from being storm-called
// during a server-side outage or a misconfigured request that always 401s.
const REFRESH_ON_401_WINDOW_MS = 10 * 60 * 1000;   // 10 minutes
const _last401RefreshByOrg = new Map();

function tryConsumeRefreshAttempt(effectiveOrgId) {
  const key = String(effectiveOrgId || '');
  const now = Date.now();
  const last = _last401RefreshByOrg.get(key) || 0;
  if (now - last < REFRESH_ON_401_WINDOW_MS) return false;
  _last401RefreshByOrg.set(key, now);
  return true;
}

let activeApiKey = null;
let activeBaseUrl = null;
let activeHeaders = null;

export function setApiKey(token)  { activeApiKey = token || null; }
export function setBaseUrl(url)   { activeBaseUrl = url || null; }
export function setHeaders(h)     { activeHeaders = h || null; }

// Back-compat alias — older callers expected setSessionToken; deprecated.
export const setSessionToken = setApiKey;

// ============================================================================
//  Base URL / token / header resolution
// ============================================================================

function resolveBaseUrl() {
  if (activeBaseUrl) return activeBaseUrl;
  if (process.env.COCO_API_URL) return process.env.COCO_API_URL;
  const cfg = loadConfig();
  return cfg.server?.bff_url
      || cfg.comm?.core_url || cfg.comm?.api_url
      || 'http://127.0.0.1:8080';
}

async function resolveToken(orgId) {
  // Prefer an explicitly-set override (tests / one-shot CLI invocations).
  if (activeApiKey) return activeApiKey;
  // Allow an env-supplied bearer to override the cached agent JWT — useful
  // for "act as user" one-shot ops (e.g. running an admin-only command from
  // the agent runtime by minting a user JWT first). Never persisted.
  if (process.env.COCO_USER_TOKEN) return process.env.COCO_USER_TOKEN;
  // Historical CLI/smoke-test name. Keep it as a compatibility fallback so
  // the environment variable documented by every operations reference is
  // actually honored by one-shot commands.
  if (process.env.COCO_AUTH_TOKEN) return process.env.COCO_AUTH_TOKEN;
  // Use the token manager: returns a cached or freshly-refreshed JWT for
  // the given org. Falls back to the raw api_key if token.js cannot reach
  // cws-core (e.g. offline). Note: the api_key works as a bearer only on
  // /auth/agent/token — every other endpoint requires a real JWT.
  try {
    return await getAccessToken(orgId || resolveDefaultOrgId());
  } catch {
    return loadConfig().agent?.api_key || '';
  }
}

function resolveCoreHeaders() {
  if (activeHeaders) return activeHeaders;
  const cfg = loadConfig();
  const out = {};
  const deviceId = cfg.agent?.device_id || cfg.device_id || process.env.COCO_DEVICE_ID    || '';
  const version  = cfg.agent?.app_version || cfg.app_version || process.env.COCO_CLIENT_VERSION || '';
  if (deviceId) out['X-Device-Id']      = deviceId;
  if (version)  out['X-Client-Version'] = version;
  return out;
}

// ============================================================================
//  URL building
// ============================================================================

function buildUrl(baseUrl, path, query) {
  const base = (baseUrl || '').replace(/\/$/, '');
  let url = path.startsWith('http') ? path : `${base}${path}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, String(v));
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  if (qs) url += `?${qs}`;
  return url;
}

// ============================================================================
//  Generic request impl (baseUrl + headers injected by caller)
// ============================================================================

// Verbose RPC logging
// -------------------
// Two independent sinks:
//
//   1) stdout — controlled by COCO_RPC_LOG. Default ON; set to '0' to silence
//      stdout (smoke tests do this so test client output stays clean).
//
//   2) file   — controlled by COCO_RPC_LOG_FILE. When set to a path, every
//      RPC line is also appended there (best-effort, sync append, JSON-line
//      friendly). This is **independent of COCO_RPC_LOG** — file logging
//      stays on even when stdout is silenced, which is the integration-phase
//      ask: smoke tests run with stdout off but we still want full traces
//      on disk for post-mortem. Set to empty string or unset to disable.
//
// Tagged `[rpc]` for grep-friendliness.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
  try { mkdirSync(dirname(filePath), { recursive: true }); } catch {}
  _rpcLogFileEnsured = true;
}
function appendRpcLine(line) {
  const filePath = rpcLogFilePath();
  if (!filePath) return;
  try {
    ensureRpcLogDir(filePath);
    appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`);
  } catch { /* best-effort: don't crash RPCs on disk errors */ }
}

function logRpcRequest(method, url, body, orgId, quietOnSuccess) {
  const tag = orgId ? `org=${orgId}` : '';
  const bodyStr = body === undefined ? '(no body)' : JSON.stringify(redactSecrets(body));
  const line = `[rpc] → ${method} ${url} ${tag} req: ${bodyStr}`;
  // High-frequency periodic reporters opt into quietOnSuccess: skip the stdout
  // request line entirely (the response line handles the success/error split).
  // The file sink is unaffected.
  if (!quietOnSuccess && rpcLogStdoutEnabled()) console.log(line);
  appendRpcLine(line);
}

function logRpcResponse(method, url, status, data, quietOnSuccess) {
  let bodyStr;
  try { bodyStr = typeof data === 'string' ? data : JSON.stringify(redactSecrets(data)); }
  catch { bodyStr = String(data); }
  const line = `[rpc] ← ${method} ${url} resp ${status}: ${bodyStr}`;
  // quietOnSuccess suppresses stdout only for 2xx/3xx; errors (>=400) still log
  // via console.warn so failures are never hidden. The file sink is unaffected.
  if (rpcLogStdoutEnabled() && !(quietOnSuccess && status < 400)) {
    const level = status >= 400 ? 'warn' : 'log';
    console[level](line);
  }
  appendRpcLine(line);
}

async function doRequest(baseUrl, method, path, { body, query, extraHeaders, orgId, timeoutMs, quietOnSuccess, retryOn401 = true } = {}) {
  const url = buildUrl(baseUrl, path, query);

  // Single attempt: resolve token, send, parse response. Returned shape lets
  // the caller decide whether to retry without re-doing all the bookkeeping.
  const sendOnce = async () => {
    const headers = {
      Accept: 'application/json',
      ...cfAccessHeaders(),
      ...(extraHeaders || {}),
    };
    const token = await resolveToken(orgId);
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    logRpcRequest(method, url, body, orgId, quietOnSuccess);

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Opt-in deadline. Native fetch has none, so a connection that is accepted
      // and then never answered hangs this promise for as long as the socket
      // stays up — which for a caller driven by an interval timer means its runs
      // pile up behind the hung one. Per-attempt (the 401 retry gets its own).
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    logRpcResponse(method, url, res.status, data, quietOnSuccess);
    return { res, data, text };
  };

  let attempt = await sendOnce();

  // 401 → refresh JWT and retry once. Throttle to one refresh per orgId per
  // REFRESH_ON_401_WINDOW_MS so an outage or misconfigured request can't
  // storm /auth/refresh. invalidate() clears the in-memory token cache;
  // the retry's resolveToken() will mint a fresh JWT via /auth/agent/token.
  if (attempt.res.status === 401 && retryOn401) {
    const effectiveOrgId = orgId || resolveDefaultOrgId() || '';
    if (tryConsumeRefreshAttempt(effectiveOrgId)) {
      console.warn(
        `[rpc] 401 on ${method} ${url}; refreshing JWT for org=${effectiveOrgId || '(identity)'} and retrying once`,
      );
      invalidateToken(effectiveOrgId);
      attempt = await sendOnce();
    } else {
      console.warn(
        `[rpc] 401 on ${method} ${url}; refresh throttled (last attempt <10min ago), propagating`,
      );
    }
  }

  const { res, data, text } = attempt;
  if (!res.ok) {
    // cws-core error envelope nests human-readable detail under `error`:
    //   { error: { title, status, detail, code, errors: [...] }, request_id, ... }
    // Previous extraction returned the whole `error` object when `detail` was
    // absent at the top level, which produced "[object Object]" as Error.message.
    // Drill into the envelope first, then fall back to flat shapes, then to text.
    let message;
    if (data && typeof data === 'object') {
      const env = (data.error && typeof data.error === 'object') ? data.error : null;
      message = (env && (env.detail || env.title))
             || data.detail
             || data.message
             || (typeof data.error === 'string' ? data.error : null);
    }
    if (!message) message = text || `HTTP ${res.status}`;
    const err = new Error(String(message));
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ============================================================================
//  Frontend URL builder
// ============================================================================

/**
 * Build a browser-navigable frontend URL. The frontend SPA is mounted at
 * `server.frontend_base_path` (default `/workspace`) on the same origin as
 * bff_url. Example:
 *
 *   frontendUrl('/knowledge?kb=xxx&node=yyy')
 *   → '{bff_url}/workspace/knowledge?kb=xxx&node=yyy'
 */
export function frontendUrl(path) {
  const base = resolveBaseUrl().replace(/\/$/, '');
  const prefix = (loadConfig().server?.frontend_base_path || '/workspace').replace(/\/$/, '');
  const p = (path && !path.startsWith('/')) ? `/${path}` : (path || '');
  return `${base}${prefix}${p}`;
}

// ============================================================================
//  cws-core client (module-global helpers — backward compatible)
// ============================================================================

async function request(method, path, opts = {}) {
  const result = await doRequest(resolveBaseUrl(), method, path, {
    ...opts,
    extraHeaders: { ...resolveCoreHeaders(), ...(opts.extraHeaders || {}) },
  });
  // cws-core wraps every response in a D8 envelope:
  //   - single:     { data, request_id, server_time }
  //   - paginated:  { data, pagination, request_id, server_time }
  if (result && typeof result === 'object' && 'data' in result && 'request_id' in result) {
    if ('pagination' in result) {
      return { data: result.data, pagination: result.pagination };
    }
    return result.data;
  }
  return result;
}

// Default-org variants (use COCO_ORG_ID env or single-enabled-org).
// `get` takes an optional `{ timeoutMs }` so a caller that must not block
// indefinitely (e.g. a best-effort pre-send roster fetch) can bound the
// request; omitting it preserves the original no-deadline behaviour.
export const get   = (path, query, { timeoutMs } = {}) => request('GET', path, { query, timeoutMs });
export const post  = (path, body)  => request('POST',   path, { body });
export const patch = (path, body)  => request('PATCH',  path, { body });
export const put   = (path, body)  => request('PUT',    path, { body });
export const del   = (path)        => request('DELETE', path);

// Org-aware variants. Use these in any code path that knows which org it's
// running on (e.g. per-org WS message handlers, multi-org CLI commands).
// They resolve the JWT against that specific org's cache, so a multi-org
// agent never accidentally calls cws-core with the wrong org's token.
export const getForOrg   = (orgId, path, query, { timeoutMs } = {}) => request('GET', path, { query, orgId, timeoutMs });
export const postForOrg  = (orgId, path, body, { timeoutMs, quietOnSuccess, retryOn401 } = {}) =>
  request('POST', path, { body, orgId, timeoutMs, quietOnSuccess, retryOn401 });

// Org-scoped GET that also attaches caller-supplied request headers — used when
// a route needs a one-shot bearer that is NOT the org JWT (e.g. cws-connect's
// X-Channel-Bind-Token, a short-lived credential-pull token). Same org-scoped
// JWT resolution + D8 envelope unwrapping as getForOrg.
export const getForOrgWithHeaders = (orgId, path, extraHeaders, query) =>
  request('GET', path, { query, orgId, extraHeaders });
export const patchForOrg = (orgId, path, body)  => request('PATCH',  path, { body,  orgId });
export const putForOrg   = (orgId, path, body, { quietOnSuccess, retryOn401 } = {}) => request('PUT', path, { body, orgId, quietOnSuccess, retryOn401 });
export const delForOrg   = (orgId, path)        => request('DELETE', path, { orgId });

/**
 * Prefix a logical path with the cws-core API prefix.
 *
 * Override via COCO_API_PREFIX to talk to a different deployment.
 */
export function apiPath(p) {
  const prefix = process.env.COCO_API_PREFIX ?? '/api/v1';
  return prefix + p;
}

// ============================================================================
//  Org-scoped clients for KB and AS routes
// ============================================================================

function makeClient(baseUrl, scopeHeaders, orgId) {
  const wrap = (method) => (path, second) => {
    const opts = method === 'GET' ? { query: second } : { body: second };
    return doRequest(baseUrl, method, path, { ...opts, extraHeaders: scopeHeaders, orgId });
  };
  return {
    get:    wrap('GET'),
    post:   wrap('POST'),
    patch:  wrap('PATCH'),
    put:    wrap('PUT'),
    del:    (path) => doRequest(baseUrl, 'DELETE', path, { extraHeaders: scopeHeaders, orgId }),
    baseUrl,
    headers: scopeHeaders,
    orgId,
  };
}

/**
 * Org-scoped client for cws-kb routes (forwarded by cws-core gateway).
 *
 * @param {string} [orgId]  override the resolved org id (else uses COCO_ORG_ID,
 *                          or the single enabled org from config.orgs)
 */
export function kbClient(orgId) {
  const oid = orgId || resolveDefaultOrgId();
  const headers = oid ? { 'X-Org-Id': oid } : {};
  return makeClient(resolveBaseUrl(), headers, oid);
}

/**
 * Org-scoped client for cws-as routes (forwarded by cws-core gateway).
 */
export function asClient(orgId) {
  const oid = orgId || resolveDefaultOrgId();
  const headers = oid ? { 'X-Org-Id': oid } : {};
  return makeClient(resolveBaseUrl(), headers, oid);
}

// ============================================================================
//  Raw helpers (used by upload flows that need direct fetch)
// ============================================================================

/**
 * PUT raw bytes to an absolute (typically pre-signed) URL.
 *
 * Pre-signed URLs carry their own AWS SigV4 auth in the query string, so we
 * don't add a Bearer token. We DO inject `CF-Access-Client-*` headers on
 * every outbound request — the BFF gateway fronts both the API and the
 * artifact storage (`{bff_url}/cws-artifacts/*`) through the same
 * Cloudflare Access zone, and any request without service-token headers
 * gets 302'd to the login page. Sending CF headers to a pure third-party
 * S3/MinIO endpoint is harmless (the headers are ignored).
 */
export async function putBytes(url, buf, contentType, extraHeaders = {}) {
  const headers = {
    'Content-Type': contentType || 'application/octet-stream',
    ...cfAccessHeaders(),
    ...extraHeaders,
  };
  const res = await fetch(url, { method: 'PUT', headers, body: buf });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`PUT ${res.status}: ${text || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return { ok: true, status: res.status };
}

/**
 * GET raw bytes from an absolute URL. Used to follow pre-signed download
 * URLs returned by cws-as. Mirrors `putBytes` re: CF Access injection.
 */
export async function getBytes(url) {
  const res = await fetch(url, { headers: cfAccessHeaders() });
  if (!res.ok) throw new Error(`GET ${res.status}: ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}
