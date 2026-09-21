/**
 * Direct-mode local-egress execution for cws-connect connections.
 *
 * For a `direct` connection this agent holds a real `access_token` in the local
 * credential cache and the action catalog carries a `url_template` (+ optional
 * `headers_template`) per action. This module takes an action slug + params and:
 *
 *   1. resolves the action definition from the LOCAL catalog,
 *   2. validates params against the action's `input_schema` (lenient — the
 *      authoritative check still runs provider/server-side),
 *   3. fills `{placeholder}` tokens in the url_template (path + query) from BOTH
 *      the action params AND the credential's `url_placeholders` (connection-owned
 *      NON-secret URL parts like a self-hosted connector's `base_url` — e.g.
 *      Jenkins, whose url_template starts with "{base_url}"), builds the JSON body
 *      from the *remaining* params, and injects the credential's auth generically
 *      (canonical `Authorization: <scheme> <token>` derived from token_type, or an
 *      optional auth_injection descriptor placing it in a custom header/query)
 *      plus any templated headers,
 *   4. makes the HTTP request FROM THIS HOST directly to the provider, and
 *   5. returns the SAME shape the server execute path returns —
 *      `{ status_code, headers, body }` — as a raw passthrough (the provider
 *      body is never transformed; the LLM reads it).
 *
 * SECURITY RED LINE: request assembly is code-driven from the catalog. The
 * caller/LLM only supplies `action` + `params`; it can NEVER supply a free-form
 * URL. The action name must resolve in the catalog and the URL can only be the
 * registered `url_template` expanded with schema-checked params.
 *
 * Token lifecycle (O4): two independent signals answer two questions.
 *   - `token_type` gates whether a token can be refreshed AT ALL: cws-connect
 *     stores `"api_key"` for api_key connections (no refresh flow) and
 *     `"bearer"` for OAuth. An api_key is NEVER refreshed — not proactively, not
 *     on a 401; a provider 401 is surfaced to the user.
 *   - `expires_at` gates whether a refreshable (OAuth) token should be refreshed
 *     PROACTIVELY before the call: present AND near/expired → refresh first.
 * A refreshable token WITHOUT `expires_at` (non-expiring OAuth like GitHub) is
 * not refreshed proactively but IS refreshed reactively — a provider 401
 * triggers a single refresh + retry; a second 401 is surfaced (no loop).
 * Refresh = re-acquire via cws-core (injected `acquire`) + re-save the cache.
 *
 * Pure-ish: `fetch`, `acquire`, and `saveCache` are injectable so this is unit
 * testable without network or disk. No import-time side effects.
 */

import { redactSecrets } from './redact.js';

// Cap on the provider response we read into memory (mirrors the server-side
// 10MB read limit). A larger body is truncated (and flagged) rather than
// buffered without bound.
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

// Refresh an OAuth token this many ms BEFORE its stated expiry, so a request
// launched right at the edge does not race the clock.
export const DEFAULT_EXPIRY_SKEW_MS = 60 * 1000;

// Methods that carry a request body built from the leftover params.
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ---------------------------------------------------------------------------
//  Catalog resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an action slug ("toolkit-slug/action-name") to its catalog entry.
 * Matches on "<toolkit>/<action>" first (the canonical invoke form), then falls
 * back to a bare "<action>" match. Returns null when nothing matches.
 */
export function resolveActionDef(actions, actionSlug) {
  if (!Array.isArray(actions) || !actionSlug) return null;
  const exact = actions.find((a) => `${a.toolkit}/${a.action}` === actionSlug);
  if (exact) return exact;
  return actions.find((a) => a.action === actionSlug) || null;
}

// ---------------------------------------------------------------------------
//  Param validation (lenient — server remains the authority)
// ---------------------------------------------------------------------------

function typeMatches(value, type) {
  switch (type) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array':   return Array.isArray(value);
    case 'object':  return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null':    return value === null;
    default:        return true; // unknown/compound type — don't block
  }
}

/**
 * Validate params against an action `input_schema` (JSON Schema, body-oriented).
 * Deliberately lenient: only enforces `required` presence and declared-property
 * types. `additionalProperties` is NOT enforced because the flat `params` object
 * mixes body fields with URL path/query placeholders (which the body schema does
 * not describe). Empty/absent schema → no validation (unknown, don't block).
 */
export function validateParams(params, schema) {
  const errors = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { ok: true, errors };
  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
  for (const req of Array.isArray(schema.required) ? schema.required : []) {
    if (params[req] === undefined || params[req] === null) errors.push(`missing required param "${req}"`);
  }
  for (const [k, v] of Object.entries(params || {})) {
    const p = props[k];
    if (p && p.type && v !== undefined && v !== null && !typeMatches(v, p.type)) {
      errors.push(`param "${k}" expected type ${p.type}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
//  Request assembly (code-driven from the catalog url_template)
// ---------------------------------------------------------------------------

function hasVal(v) {
  return v !== undefined && v !== null && v !== '';
}

/**
 * Encode a PATH-segment value: percent-encode as data (so query-reserved and
 * unsafe chars are escaped) but PRESERVE the path separator "/". A resource-name
 * value like "people/me" must stay "people/me" in the path — full
 * encodeURIComponent turns it into "people%2Fme", which many providers 404.
 *
 * SECURITY (path traversal): keeping "/" literal means a caller-supplied value
 * could otherwise smuggle a "." or ".." navigation segment (e.g.
 * "a/../../admin") that the URL/HTTP client resolves UP and OUT of the
 * catalog-declared path — letting the connection credential reach an adjacent,
 * UNDECLARED endpoint of the same provider (breaking the "callers can only hit
 * URLs declared in the catalog" boundary). A bare "." / ".." segment is never a
 * legitimate resource name, and it cannot be carried as an inert literal in a
 * URL path (the WHATWG URL parser treats "..", ".%2e", "%2e.", "%2e%2e" — any
 * case — ALL as navigation, so percent-encoding the dots does not help), so any
 * such segment is REJECTED (400) rather than passed through. Names that merely
 * CONTAIN dots ("file.txt", "a.b", "...", ".hidden") are unaffected — only the
 * exact navigation segments "." / ".." are refused.
 *
 * Each remaining segment is encodeURIComponent'd and the segments are rejoined
 * with "/". For any value WITHOUT a navigation segment this is byte-for-byte
 * identical to the previous `encodeURIComponent(s).replace(/%2F/g, '/')` (only
 * an input "/" ever produces "%2F", so splitting on "/" first changes nothing
 * else); the sole behavioural change is that "." / ".." now throw.
 */
function encodePathValue(s) {
  return String(s)
    .split('/')
    .map((seg) => {
      if (seg === '.' || seg === '..') {
        throw Object.assign(
          new Error(`illegal path segment "${seg}" in path value: "." / ".." navigation is not allowed`),
          { status: 400 },
        );
      }
      return encodeURIComponent(seg);
    })
    .join('/');
}

/**
 * Validate a caller value that fills a placeholder located in the URL's
 * SCHEME/AUTHORITY (e.g. a tenant subdomain in
 * "https://{tenant}.provider.example/..."). Unlike a path value, an authority
 * value must NEVER be able to end or restructure the authority, or the caller
 * could move the whole (credentialed) request to a host of their choosing.
 *
 * SECURITY: with "/" preserved (as encodePathValue does), `tenant =
 * "attacker.example/x"` on the template above assembles to
 * "https://attacker.example/x.provider.example/..." whose host parses as
 * "attacker.example" — sending the connection's Authorization header to an
 * attacker-chosen host (SSRF + credential exfiltration). So we ALLOWLIST only
 * the characters a real authority token needs — host-label chars
 * (alphanumerics, "-", "."), ":" (port) and "[" "]" (IPv6 literal) — and reject
 * everything else (400). That refuses the authority-boundary characters "/",
 * "\" (WHATWG treats it as "/"), "?", "#", "@" (userinfo), and "%" (no
 * percent-encoding games), which are the ways a value could escape the host.
 * A value that passes is authority-safe, so it is substituted VERBATIM
 * (percent-encoding ":" would corrupt a legitimate "host:port"). A legit
 * tenant/subdomain that merely adds a label (e.g. "acme") stays inside the
 * template's own registrable domain ("acme.provider.example").
 */
function encodeAuthorityValue(s) {
  const str = String(s);
  if (!/^[A-Za-z0-9._:[\]-]+$/.test(str)) {
    throw Object.assign(
      new Error('illegal character in URL authority value (only host-label / port / IPv6 characters are allowed — it must not be able to change the request host)'),
      { status: 400 },
    );
  }
  return str;
}

/**
 * Canonicalize a credential `token_type` into the HTTP Authorization scheme word.
 * Mirrors cws-connect's `canonicalAuthScheme` (connection_service.go) EXACTLY:
 *   - ""  / "bearer" (any case) / "api_key" (any case) → "Bearer".
 *     ("api_key" is a mode marker, NOT a real scheme; providers that carry a
 *     personal token in the Authorization header expect "Bearer", so normalize
 *     it rather than emit the invalid "Authorization: api_key".)
 *   - "basic" (any case) → "Basic" (the token value already holds
 *     base64(username:token), pre-baked at connection-creation time).
 *   - anything else → returned VERBATIM (e.g. "Token", "SSWS").
 */
export function canonicalAuthScheme(tokenType) {
  const t = tokenType == null ? '' : String(tokenType);
  if (t === '' || t.toLowerCase() === 'bearer' || t.toLowerCase() === 'api_key') return 'Bearer';
  if (t.toLowerCase() === 'basic') return 'Basic';
  return t;
}

function fillTemplateValue(str, params, urlPlaceholders, consumed) {
  return String(str).replace(/\{([^}]+)\}/g, (_, key) => {
    consumed.add(key);
    if (hasVal(params[key])) return String(params[key]);
    if (hasVal(urlPlaceholders[key])) return String(urlPlaceholders[key]);
    return '';
  });
}

/**
 * Apply the GENERIC connection auth to a request in place. Mirrors cws-connect
 * (and matches assembleRequest's original inline logic EXACTLY). Two paths:
 *   - `authInjection` descriptor present ({ location, name, value_template }) →
 *     expand value_template's literal "{token}" with the token, then place it:
 *     location==='query' appends name=encodeURIComponent(expanded) to the URL
 *     (URL-encoded — it rides in the query); location==='header' sets
 *     headers[name] VERBATIM, after dropping any templated header of the same
 *     name (case-insensitive) so the descriptor truly wins (no comma-merge).
 *   - descriptor absent (today's 100% path) → set
 *     headers.Authorization = canonicalAuthScheme(tokenType) + ' ' + token.
 * Returns the (possibly query-appended) URL. `headers` is mutated in place.
 *
 * Extracted so BOTH normal request assembly and the Bug3 download branch inject
 * the connection credential identically — one auth code path, no drift.
 */
function applyAuthToRequest(url, headers, token, tokenType, authInjection) {
  if (authInjection && typeof authInjection === 'object' && authInjection.location && authInjection.name) {
    const vt = typeof authInjection.value_template === 'string' ? authInjection.value_template : '{token}';
    const expanded = vt.replace(/\{token\}/g, token == null ? '' : String(token));
    if (authInjection.location === 'query') {
      // Query value IS URL-encoded (it rides in the URL); header value is verbatim.
      return `${url}${url.includes('?') ? '&' : '?'}${authInjection.name}=${encodeURIComponent(expanded)}`;
    }
    // Drop any templated header of the SAME NAME case-insensitively before
    // setting ours — otherwise a template `x-api-key` and an injected
    // `X-API-Key` both survive as distinct object keys and Node/fetch merges
    // them into one comma-joined value, so the descriptor would not truly win.
    const lower = authInjection.name.toLowerCase();
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) delete headers[k];
    }
    headers[authInjection.name] = expanded;
    return url;
  }
  headers.Authorization = `${canonicalAuthScheme(tokenType)} ${token}`;
  return url;
}

/**
 * Build the concrete HTTP request from an action definition + params + token.
 * Returns { method, url, headers, body }. `body` is undefined when there is no
 * body to send. Throws (status 422) when the action has no url_template (catalog
 * too old for direct mode) or (status 400) when a required PATH placeholder has
 * no value.
 *
 * Placeholder rules:
 *   - PATH placeholders are required — a missing value is an error (a literal
 *     "{id}" / "{base_url}" must never reach the wire).
 *   - QUERY placeholders are optional — a missing value drops that whole
 *     key=value pair.
 *   - HEADER placeholders (from headers_template) fill from both sources too.
 *   - Any param NOT consumed by a placeholder becomes a body field (body
 *     methods only). url_placeholders never contribute to the body.
 *
 * Placeholders resolve from TWO sources: the action `params` AND the
 * credential's `url_placeholders` (connection-owned, NON-secret URL parts like a
 * self-hosted connector's `base_url`, e.g. Jenkins whose url_template starts
 * with "{base_url}"). `params` win on a name clash. A value from `params` is
 * URL-encoded (it is data — a path/query value); a value from `url_placeholders`
 * is substituted VERBATIM (it is structural — a scheme/host/base-URL prefix that
 * must not be percent-encoded, or "https://host/x" would corrupt into
 * "https%3A%2F%2F…").
 *
 * Auth injection is GENERIC (mirrors cws-connect). Two paths:
 *   - `authInjection` descriptor present ({ location, name, value_template }) →
 *     expand value_template's literal "{token}" placeholder with the token, then
 *     place it: location==='header' sets headers[name] (verbatim, NOT
 *     URL-encoded); location==='query' appends name=encodeURIComponent(expanded)
 *     to the assembled URL's query string. The descriptor WINS over a
 *     headers_template key of the same name.
 *   - descriptor absent (today's 100% path) → set
 *     headers['Authorization'] = canonicalAuthScheme(tokenType) + ' ' + token.
 *     A headers_template 'authorization' key can NEVER override this.
 *
 * @param {object} actionDef
 * @param {object} [params]           action params (caller/LLM supplied)
 * @param {string} token             the injected token (EffectiveToken — already
 *                                   pre-baked for basic/token_param modes)
 * @param {object} [urlPlaceholders] connection-owned url placeholder values
 * @param {string} [tokenType]       credential token_type → Authorization scheme
 * @param {object} [authInjection]   optional generic injection descriptor
 *                                   { location:'header'|'query', name, value_template }
 */
export function assembleRequest(actionDef, params = {}, token, urlPlaceholders = {}, tokenType = '', authInjection = null) {
  if (!actionDef || typeof actionDef.url_template !== 'string' || !actionDef.url_template) {
    throw Object.assign(
      new Error('action has no url_template — local catalog is too old for direct execution (run conn.catalog {refresh:true})'),
      { status: 422 },
    );
  }
  const method = String(actionDef.method || 'GET').toUpperCase();
  const template = actionDef.url_template;
  const uph = (urlPlaceholders && typeof urlPlaceholders === 'object') ? urlPlaceholders : {};
  const consumed = new Set();

  const qIdx = template.indexOf('?');
  const pathPart = qIdx >= 0 ? template.slice(0, qIdx) : template;
  const queryPart = qIdx >= 0 ? template.slice(qIdx + 1) : '';

  // Path placeholders — required. Resolved in TWO passes so a caller value can
  // never alter the URL authority (host):
  //   Pass 1 substitutes the connection-owned url_placeholders VERBATIM. These
  //     are trusted structural parts (scheme/host/base-URL prefix, e.g.
  //     "{base_url}" → "https://jenkins.example.com") and legitimately contain
  //     "://" and "/". Caller (params) placeholders are LEFT in place.
  //   With the trusted parts revealed, we locate the URL authority (between
  //     "scheme://" and the next "/"). Pass 2 then substitutes each caller
  //     (params) placeholder, choosing the encoder by WHERE it sits: an
  //     authority placeholder must not keep "/" (encodeAuthorityValue, rejects
  //     host-boundary chars); a pathname placeholder keeps "/" for real
  //     resource names like "people/me" (encodePathValue). Params still win over
  //     url_placeholders on a name clash (a params placeholder is deferred to
  //     pass 2, never overwritten by pass 1).
  const pass1 = pathPart.replace(/\{([^}]+)\}/g, (m, key) => {
    if (hasVal(params[key])) return m;              // caller value → defer to pass 2
    if (hasVal(uph[key])) { consumed.add(key); return String(uph[key]); } // trusted, verbatim
    return m;                                       // unresolved → pass 2 throws
  });
  // Authority span = after "scheme://" up to the next "/" (or end). Caller
  // placeholders whose offset falls inside it fill the host/authority.
  const schemeM = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(pass1);
  const authStart = schemeM ? schemeM[0].length : -1;
  let authEnd = -1;
  if (authStart >= 0) {
    const slash = pass1.indexOf('/', authStart);
    authEnd = slash === -1 ? pass1.length : slash;
  }
  const path = pass1.replace(/\{([^}]+)\}/g, (m, key, offset) => {
    consumed.add(key);
    if (hasVal(params[key])) {
      const inAuthority = authStart >= 0 && offset >= authStart && offset < authEnd;
      // Authority values NEVER keep "/" (host-safe, rejects boundary chars);
      // pathname values are DATA that keeps "/" so "people/me" stays a real
      // path. Query encoding (below) is unchanged (always encodeURIComponent).
      return inAuthority ? encodeAuthorityValue(params[key]) : encodePathValue(params[key]);
    }
    // Neither source has it (uph was already folded in pass 1). A leading
    // "{base_url}"-style placeholder is a connection-owned URL part the
    // credential should have carried — surface it as a 422 (connection/
    // credential too old) rather than a missing-param 400.
    if (pathPart.startsWith(`{${key}}`)) {
      throw Object.assign(
        new Error(`connection is missing URL placeholder "${key}" (e.g. base_url) — reconnect the connection or refresh the credential; url_placeholders did not provide it`),
        { status: 422 },
      );
    }
    throw Object.assign(new Error(`missing required path param "${key}" for action ${actionDef.toolkit}/${actionDef.action}`), { status: 400 });
  });

  // Query placeholders — optional (drop the pair when the value is absent).
  // Same two-source resolution; query values are always URL-encoded.
  const outPairs = [];
  for (const pair of queryPart.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    const rawV = eq >= 0 ? pair.slice(eq + 1) : '';
    const m = /^\{([^}]+)\}$/.exec(rawV);
    if (m) {
      const key = m[1];
      consumed.add(key);
      const v = hasVal(params[key]) ? params[key] : uph[key];
      if (!hasVal(v)) continue; // optional query param omitted
      outPairs.push(`${k}=${encodeURIComponent(String(v))}`);
    } else {
      outPairs.push(pair); // static query segment
    }
  }
  let url = path + (outPairs.length ? `?${outPairs.join('&')}` : '');

  // Bug2 — generic caller query passthrough. Some actions need extra query
  // params the catalog template doesn't declare (e.g. Drive about-get's
  // `fields=`). A caller may pass a namespaced `params._query` object whose
  // key/values are appended to the query string just assembled above.
  //   - QUERY-ONLY: we only ever append to the query section of the URL that
  //     path/query assembly already produced, so `_query` can NEVER influence
  //     the scheme, host, or path.
  //   - Absent (or non-object) `_query` → this block is skipped entirely, so the
  //     assembled URL is byte-for-byte identical to before this change.
  //   - Marked consumed (BELOW, before the body is built) so it never leaks into
  //     the request body.
  //   - Appended BEFORE the auth-injection query append (which follows), so the
  //     existing `?`/`&` separator logic and auth_injection behavior still hold.
  if (params._query !== null && typeof params._query === 'object' && !Array.isArray(params._query)) {
    consumed.add('_query');
    for (const [k, v] of Object.entries(params._query)) {
      if (!hasVal(v)) continue;
      // An Array value → one `k=<enc>` pair per element; a scalar → a single pair.
      const vals = Array.isArray(v) ? v : [v];
      for (const el of vals) {
        url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(k)}=${encodeURIComponent(String(el))}`;
      }
    }
  }

  // Headers — templated headers first (Authorization is ours, never the
  // template's), then the generic auth injection is applied last so it wins.
  const headers = {};
  const headerTemplate = (actionDef.headers_template && typeof actionDef.headers_template === 'object') ? actionDef.headers_template : {};
  for (const [hk, hv] of Object.entries(headerTemplate)) {
    if (hk.toLowerCase() === 'authorization') continue; // never let the template override our injected auth
    headers[hk] = fillTemplateValue(hv, params, uph, consumed);
  }

  // Generic auth injection (mirrors cws-connect). A descriptor, when present,
  // fully controls placement and wins over any templated header of the same
  // name; otherwise we fall back to the canonical Authorization header — the
  // path taken by 100% of connections today. (Applied after any _query pairs.)
  url = applyAuthToRequest(url, headers, token, tokenType, authInjection);

  // Body — every param not consumed by a placeholder, for body-bearing methods.
  let body;
  if (BODY_METHODS.has(method)) {
    const bodyObj = {};
    for (const [k, v] of Object.entries(params)) {
      if (!consumed.has(k)) bodyObj[k] = v;
    }
    if (Object.keys(bodyObj).length > 0) {
      body = bodyObj;
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  return { method, url, headers, body };
}

// ---------------------------------------------------------------------------
//  Token lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Can this token be refreshed at all? Gated solely by `token_type`: cws-connect
 * stores `"api_key"` for api_key connections (which have NO refresh flow) and
 * `"bearer"` for OAuth. Everything that is not explicitly `"api_key"` is treated
 * as refreshable OAuth (a missing token_type defaults to refreshable — the
 * GitHub-style no-expiry OAuth case). This is what separates a non-refreshable
 * api_key from a no-expiry OAuth token: `expires_at` alone cannot, since both
 * lack it.
 */
export function isTokenRefreshable(cred) {
  if (!cred) return false;
  // Normalized exact match: api_key is the fixed value "api_key", while OAuth's
  // token_type varies in case across providers ("Bearer"/"bearer"). Only an
  // exact (trimmed, lowercased) "api_key" is non-refreshable; every other value
  // — including any casing of bearer and anything unexpected — is OAuth.
  return String(cred.token_type || '').trim().toLowerCase() !== 'api_key';
}

function expiryMs(cred) {
  const raw = cred && cred.expires_at;
  if (raw == null) return null;
  if (typeof raw === 'number') {
    // Heuristic: values below ~year-2001-in-ms are epoch seconds.
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const parsed = Date.parse(String(raw));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Is the token at/near expiry? `expires_at` presence gates PROACTIVE refresh: a
 * token with no `expires_at` returns false — it is never proactively refreshed
 * (a refreshable one still relies on the reactive-401 backstop; this is the
 * GitHub-style no-expiry OAuth case).
 */
export function isTokenNearExpiry(cred, now = Date.now(), skewMs = DEFAULT_EXPIRY_SKEW_MS) {
  const exp = expiryMs(cred);
  if (exp == null) return false;
  return exp - now <= skewMs;
}

/**
 * Decide the execution path for a resolved connection from its cached
 * credential: `direct` iff a cached credential exists and its mode is `direct`,
 * otherwise `proxy` (server-side execute). This is the O2 mode split.
 */
export function chooseExecMode(credential) {
  return credential && credential.credential_mode === 'direct' ? 'direct' : 'proxy';
}

/**
 * Resolve the credential + execution mode for an invoke, re-acquiring on a cache
 * miss so a direct connection with NO local credential file is not wrongly
 * downgraded to proxy.
 *
 * A direct connection may have no cache file — authorized while offline, runtime/
 * wiped/reinstalled, or conn.clear_cache was run. Since cws-connect now rejects a
 * direct connection on the proxy/execute path (ErrDirectNotProxyable/422), on a
 * miss we `acquire` once: `acquire` works for both modes and returns
 * `credential_mode`, so a direct result is saved locally and used, while a proxy
 * result leaves the credential null (→ proxy path, which caches nothing). An
 * acquire FAILURE propagates — we never silently downgrade a direct call.
 *
 * @returns {Promise<{credential: object|null, mode: 'direct'|'proxy'}>}
 */
export async function resolveCredential({ orgId, connectionId, cached }, { acquire, saveCache = () => {} } = {}) {
  let credential = cached || null;
  if (!credential && acquire) {
    const acquired = await acquire(orgId, connectionId); // throws → surfaced by caller
    if (acquired && acquired.credential_mode === 'direct') {
      saveCache(connectionId, acquired);
      credential = acquired;
    }
    // proxy / unknown → leave credential null so chooseExecMode routes to proxy.
  }
  return { credential, mode: chooseExecMode(credential) };
}

// ---------------------------------------------------------------------------
//  Audit logging (O6) — URL + params only, secrets redacted, short.
// ---------------------------------------------------------------------------

// Mirrors client.js's RPC logging surfaces: stdout gated by COCO_RPC_LOG,
// file append gated by COCO_RPC_LOG_FILE. Tagged [conn.direct] for grep.
function defaultAudit(line) {
  if (process.env.COCO_RPC_LOG !== '0') console.error(line);
  const filePath = process.env.COCO_RPC_LOG_FILE;
  if (filePath && filePath.length > 0) {
    // Lazy import to keep this a leaf module in the common (no-file) path.
    import('node:fs').then(({ appendFileSync, mkdirSync }) => {
      try {
        import('node:path').then(({ dirname }) => {
          try { mkdirSync(dirname(filePath), { recursive: true }); } catch {}
          try { appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`); } catch {}
        });
      } catch {}
    }).catch(() => {});
  }
}

function auditDirectCall(method, urlTemplate, params, audit) {
  // Log the UN-expanded url_template, NOT the concrete URL: a query placeholder
  // like "?api_key={api_key}" would otherwise expand to the plaintext secret in
  // the log line. The template keeps placeholders literal ("{api_key}"), so no
  // secret can ever reach the log via the URL. Params are separately redacted
  // (redactSecrets masks secret-shaped keys), and headers (where Authorization
  // lives) are never logged. One short line.
  const safeParams = JSON.stringify(redactSecrets(params || {}));
  audit(`[conn.direct] → ${method} ${urlTemplate} params: ${safeParams}`);
}

// ---------------------------------------------------------------------------
//  HTTP send + orchestration
// ---------------------------------------------------------------------------

function headersToObject(h) {
  if (!h) return {};
  if (typeof h.entries === 'function') return Object.fromEntries(h.entries());
  if (typeof h.forEach === 'function') { const o = {}; h.forEach((v, k) => { o[k] = v; }); return o; }
  return { ...h };
}

/**
 * Read a fetch Response body with a STREAMING byte cap, so an oversized provider
 * response never fully lands in memory. Reads `res.body` incrementally and
 * accumulates up to MAX_RESPONSE_BYTES; the moment the running total exceeds the
 * cap it cancels the stream and THROWS (over-cap is an ERROR, not a silent
 * truncation — a truncated body would be a corrupt/misleading passthrough).
 *
 * Returns the RAW bytes as a Buffer — it does NOT decode. Decoding is the
 * caller's job (sendDirect), which decides utf8-vs-base64 from the response
 * content-type. Force-decoding to utf8 here would irreversibly corrupt binary
 * bodies (PDFs, images, …), replacing every non-utf8 byte with U+FFFD.
 *
 * Falls back to `res.text()` only when the response exposes no readable stream
 * (e.g. a minimal test double); that path still enforces the cap, but by then
 * the body is already buffered (and text() has already lossily decoded binary),
 * so it is a compatibility fallback, not the memory-safety or binary-fidelity
 * guarantee. Production `fetch` always provides `res.body`.
 */
async function readCappedBytes(res) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw Object.assign(
        new Error(`provider response exceeds the ${MAX_RESPONSE_BYTES}-byte cap`),
        { status: 502 },
      );
    }
    return Buffer.from(text, 'utf8');
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length ?? value.byteLength ?? 0;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        throw Object.assign(
          new Error(`provider response exceeds the ${MAX_RESPONSE_BYTES}-byte cap`),
          { status: 502 },
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released/cancelled */ }
  }
  return Buffer.concat(chunks);
}

/**
 * Read one header value from a fetch Response's headers, tolerating both a real
 * `Headers`/`Map` (has `.get`) and a plain object (test doubles). Case-insensitive.
 */
function getHeaderValue(h, name) {
  if (!h) return '';
  if (typeof h.get === 'function') return h.get(name) || '';
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower) return v || '';
  }
  return '';
}

/**
 * Is this response content-type textual (safe to utf8-decode + attempt JSON)?
 * Textual → utf8/JSON passthrough (today's behavior). Non-textual → binary,
 * base64-encoded by the caller. An ABSENT/empty content-type is treated as
 * textual so the existing `{status_code, headers, body}` shape is preserved for
 * every response that was decoded before this change.
 */
function isTextualContentType(contentType) {
  const t = String(contentType || '').toLowerCase();
  if (!t) return true; // no content-type → default to textual (preserve prior behavior)
  const mime = t.split(';', 1)[0].trim();
  if (!mime) return true;
  if (mime.startsWith('text/')) return true;              // text/*
  if (mime === 'application/json') return true;
  if (mime.endsWith('+json')) return true;                // *+json (e.g. application/ld+json)
  if (mime === 'application/xml' || mime.endsWith('+xml')) return true; // xml + *+xml (e.g. image/svg+xml)
  if (mime === 'application/javascript' || mime === 'application/ecmascript') return true;
  if (mime === 'application/csv') return true;             // text/csv already covered by text/*
  if (mime === 'application/x-ndjson' || mime === 'application/ndjson') return true;
  if (mime === 'application/x-www-form-urlencoded') return true;
  if (mime === 'application/graphql') return true;
  return false;
}

/**
 * Send one assembled request and normalize the response into the server-parity
 * shape `{ status_code, headers, body }`. Raw passthrough — the provider body is
 * never transformed. The body is read with a streaming cap (see readCappedBytes):
 * a response over MAX_RESPONSE_BYTES throws (status 502) rather than being
 * buffered whole or silently truncated.
 *
 * Body decoding is content-type driven so binary responses survive intact:
 *   - TEXTUAL content-type (application/json, text/*, xml, *+json, csv, js, …)
 *     or an absent content-type → utf8-decode, then attempt JSON.parse; on
 *     failure keep the raw string. This preserves the exact prior behavior and
 *     the `{ status_code, headers, body }` shape (NO body_encoding field) for
 *     every current text/JSON caller.
 *   - BINARY content-type (everything else — PDFs, images, octet-stream, …) →
 *     base64-encode the raw bytes and add a `body_encoding: 'base64'`
 *     discriminator so the caller can round-trip losslessly. utf8-decoding these
 *     would replace every non-utf8 byte with U+FFFD, corrupting the body.
 */
/**
 * Normalize a fetch Response into the server-parity `{ status_code, headers,
 * body }` shape, reading the body with the streaming byte cap and choosing the
 * decode from the content-type (textual → utf8/JSON; binary → base64 +
 * body_encoding). Extracted so the normal send path and the Bug3 download branch
 * share ONE response path (same cap, same content-type branching) — no drift.
 */
async function normalizeResponse(res) {
  const buf = await readCappedBytes(res);
  const headers = headersToObject(res.headers);
  const contentType = getHeaderValue(res.headers, 'content-type');

  if (isTextualContentType(contentType)) {
    const text = buf.toString('utf8');
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status_code: res.status, headers, body };
  }

  // Binary passthrough — base64 so the bytes round-trip losslessly.
  return { status_code: res.status, headers, body: buf.toString('base64'), body_encoding: 'base64' };
}

export async function sendDirect(assembled, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(assembled.url, {
    method: assembled.method,
    headers: assembled.headers,
    body: assembled.body !== undefined ? JSON.stringify(assembled.body) : undefined,
  });
  return normalizeResponse(res);
}

// ---------------------------------------------------------------------------
//  Bug3 — generic, SSRF-safe download branch
// ---------------------------------------------------------------------------
//
// Drive file download (and similar) needs to GET raw bytes from a provider URI
// (`.../files/{id}?alt=media`, or a `downloadUri` returned by a prior call). No
// action template can fetch a caller-supplied URI, and a free-URI fetch was
// deliberately disallowed (SSRF + credential exfiltration). This branch adds one
// generic, provider-scoped exception: a caller may pass `params._download = {
// url }`, and the URL is fetched with the connection credential ONLY when its
// host is proven to belong to the SAME provider as the invoked action/connection.

/**
 * Extract the literal lowercase hostname from a single action `url_template`,
 * substituting the connection-owned url_placeholders VERBATIM first (exactly
 * like assembleRequest's pass 1 — so a "{base_url}/…" template resolves to its
 * real host). Returns null when the template is absent, or when its authority
 * STILL contains an unresolved "{…}" placeholder after substitution (a CALLER
 * placeholder such as "{tenant}.provider.example" — we must never trust a caller
 * value to define the allowlist), or when the authority is unparseable.
 */
function templateHost(template, uph) {
  if (typeof template !== 'string' || !template) return null;
  const resolved = template.replace(/\{([^}]+)\}/g, (m, key) => (hasVal(uph[key]) ? String(uph[key]) : m));
  const schemeM = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/]*)/.exec(resolved);
  if (!schemeM || !schemeM[2] || schemeM[2].includes('{') || schemeM[2].includes('}')) return null;
  try { return new URL(`${schemeM[1]}${schemeM[2]}`).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { return null; }
}

/**
 * Collect the EXACT-host allowlist for a Bug3 download, from
 * operator/provider-controlled (never caller-supplied) sources only:
 *   - the hostname of EVERY entry in the local action `catalog`'s url_template
 *     (the full provider surface this connection is scoped to), plus the invoked
 *     `actionDef`'s own host, each resolved via templateHost (connection
 *     url_placeholders substituted verbatim; templates whose authority is still
 *     a caller "{…}" placeholder are skipped), and
 *   - the hostname of the connection's `url_placeholders.base_url` (self-hosted
 *     connectors whose base_url IS the provider host).
 * De-duplicated, lowercase, trailing dot stripped.
 *
 * SECURITY: this is an EXACT-host allowlist — the download host must equal a
 * member. There is deliberately NO registrable-domain / sibling-subdomain
 * admission: without a Public Suffix List that heuristic cannot tell a real
 * registrable domain from a multi-label public suffix or a tenant-per-subdomain
 * SaaS, so it would admit e.g. attacker.atlassian.net under acme.atlassian.net
 * and exfiltrate the connection token. If a provider's genuine download host is
 * not among its own catalog hosts, failing closed (403) is the correct default;
 * a per-connection operator allowlist is a possible future opt-in, not a hole
 * opened by default.
 */
function deriveTrustedHosts(catalog, actionDef, urlPlaceholders) {
  const uph = (urlPlaceholders && typeof urlPlaceholders === 'object') ? urlPlaceholders : {};
  const hosts = new Set();
  const add = (h) => { if (h) hosts.add(h); };
  if (typeof uph.base_url === 'string' && uph.base_url) {
    try { add(new URL(uph.base_url).hostname.toLowerCase().replace(/\.$/, '')); } catch { /* unparseable → ignore */ }
  }
  add(templateHost(actionDef && actionDef.url_template, uph));
  if (Array.isArray(catalog)) {
    for (const entry of catalog) add(templateHost(entry && entry.url_template, uph));
  }
  return [...hosts];
}

/**
 * Execute a Bug3 download. SSRF-guards the caller URL against this invoke's
 * EXACT-host provider allowlist (deriveTrustedHosts), attaches the connection
 * auth (via the SAME applyAuthToRequest path as normal assembly) ONLY once the
 * host passes, GETs the bytes, and normalizes them through the SAME response
 * path sendDirect uses (streaming cap + content-type branching → base64 for
 * binary, parsed text/JSON otherwise). Throws BEFORE any network call when the
 * target is invalid, non-https, or off the provider allowlist — so a rejected
 * target emits NO request.
 */
async function invokeDownload({ catalog, actionDef, download, cred, fetchImpl, audit }) {
  if (download === null || typeof download !== 'object' || Array.isArray(download)
      || typeof download.url !== 'string' || !download.url) {
    throw Object.assign(new Error('_download must be an object of shape { url: "<https provider uri>" }'), { status: 400 });
  }
  let parsed;
  try { parsed = new URL(download.url); }
  catch { throw Object.assign(new Error(`_download.url is not a valid absolute URL: ${download.url}`), { status: 400 }); }
  if (parsed.protocol !== 'https:') {
    throw Object.assign(new Error(`_download.url must be https (refused non-https target "${parsed.protocol}//${parsed.host}")`), { status: 400 });
  }
  const trusted = deriveTrustedHosts(catalog, actionDef, cred && cred.url_placeholders);
  if (trusted.length === 0) {
    throw Object.assign(
      new Error('cannot determine the provider host(s) for this connection/catalog from a trusted source — a download target cannot be validated, so it is refused'),
      { status: 422 },
    );
  }
  const dlHost = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!trusted.includes(dlHost)) {
    throw Object.assign(
      new Error(`_download.url host "${dlHost}" is not a known host of this connection's provider (allowed: ${trusted.join(', ')}) — refused to prevent SSRF / credential exfiltration`),
      { status: 403 },
    );
  }
  // Host passed the allowlist → NOW attach the connection credential (same
  // scheme/injection as assembleRequest). The token never travels with a URL
  // that failed the check above.
  const headers = {};
  const url = applyAuthToRequest(
    parsed.toString(),
    headers,
    cred && cred.access_token,
    cred && cred.token_type,
    cred && cred.auth_injection,
  );
  // Audit the origin+path only (never the query — an auth_injection=query
  // provider would otherwise carry the token there).
  audit(`[conn.direct] ↓ GET ${parsed.origin}${parsed.pathname} (download)`);

  // REDIRECT SAFETY: fetch with redirect:'manual' so the runtime does NOT
  // auto-follow a 3xx. A followed redirect would carry the connection token to a
  // Location that has NOT been validated against the allowlist above (an open
  // redirect on the provider → SSRF + credential exfiltration to an arbitrary
  // host). On a 3xx we return the redirect response AS-IS (status_code + the
  // Location header, no body / no body_encoding) without reading or following
  // it, so the token never rides onward. A caller that trusts the Location can
  // re-invoke _download with it (re-validated against the allowlist).
  const res = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* best-effort */ }
    return { status_code: res.status, headers: headersToObject(res.headers) };
  }
  return normalizeResponse(res);
}

/**
 * Full direct-mode invoke: resolve → validate → (proactive OAuth refresh) →
 * assemble → send → (reactive-401 OAuth refresh once) → return.
 *
 * @param {object} args
 *   - orgId, connection ({id, applicationId, slug}), actionSlug, params
 *   - catalog: the action array (from the local catalog cache)
 *   - credential: the cached credential record (with access_token, expires_at,…)
 * @param {object} deps
 *   - fetchImpl        (default global fetch)
 *   - acquire(orgId, connectionId) → fresh credential record (re-acquire/refresh)
 *   - saveCache(connectionId, cred) → persist the refreshed credential
 *   - now()            (default Date.now) — for expiry math / tests
 *   - skewMs, audit, log, warn
 */
export async function invokeDirect(
  { orgId, connection, actionSlug, params = {}, catalog, credential },
  deps = {},
) {
  const {
    fetchImpl = fetch,
    acquire,
    saveCache = () => {},
    now = Date.now,
    skewMs = DEFAULT_EXPIRY_SKEW_MS,
    audit = defaultAudit,
    log = () => {},
    warn = () => {},
  } = deps;

  const actionDef = resolveActionDef(catalog, actionSlug);
  if (!actionDef) {
    throw Object.assign(new Error(`unknown action "${actionSlug}" for app (not in local catalog)`), { status: 404 });
  }

  // Bug3 — SSRF-safe download branch. A reserved `params._download = { url }`
  // diverts to a raw byte GET of a caller-supplied provider URI (the ONLY path
  // that may fetch a caller URL), gated to the same provider as this action/
  // connection. It intentionally skips input_schema validation (the action's
  // body schema does not describe a download) and does NOT run token refresh —
  // it uses the current cached credential. When `_download` is absent, none of
  // this runs and the normal action-template flow below is entirely unaffected.
  if (params && params._download != null) {
    return invokeDownload({ catalog, actionDef, download: params._download, cred: credential, fetchImpl, audit });
  }

  const v = validateParams(params, actionDef.input_schema);
  if (!v.ok) {
    throw Object.assign(new Error(`params failed input_schema validation: ${v.errors.join('; ')}`), { status: 400 });
  }

  let cred = credential;
  const connId = connection.id;

  // Proactive refresh: refreshable (OAuth) tokens only, and only when they carry
  // an `expires_at` that is at/near expiry. api_key (token_type "api_key") is
  // never touched. A refresh failure here is non-fatal — proceed with the current
  // token and let the reactive-401 backstop try.
  if (acquire && isTokenRefreshable(cred) && isTokenNearExpiry(cred, now(), skewMs)) {
    try {
      const fresh = await acquire(orgId, connId);
      if (fresh && fresh.access_token) { saveCache(connId, fresh); cred = fresh; }
      log(`[conn.direct] refreshed near-expiry token conn=${connId}`);
    } catch (e) {
      warn(`[conn.direct] proactive refresh failed conn=${connId}: ${e.message}`);
    }
  }

  let assembled = assembleRequest(
    actionDef,
    params,
    cred && cred.access_token,
    cred && cred.url_placeholders,
    cred && cred.token_type,
    cred && cred.auth_injection,
  );
  auditDirectCall(assembled.method, actionDef.url_template, params, audit);
  let result = await sendDirect(assembled, { fetchImpl });

  // Reactive refresh backstop (refreshable/OAuth only): a provider 401 → refresh
  // ONCE and retry. This covers no-expiry OAuth (GitHub) and any token whose
  // proactive refresh was skipped/stale. An api_key is NOT refreshed here — its
  // 401 is surfaced as-is. A second 401 is likewise surfaced (no loop).
  if (result.status_code === 401 && acquire && isTokenRefreshable(cred)) {
    log(`[conn.direct] provider 401 conn=${connId}; reactive refresh + retry once`);
    const fresh = await acquire(orgId, connId); // if refresh itself throws, surface it
    if (fresh && fresh.access_token) {
      saveCache(connId, fresh);
      cred = fresh;
      assembled = assembleRequest(
        actionDef,
        params,
        cred.access_token,
        cred.url_placeholders,
        cred.token_type,
        cred.auth_injection,
      );
      auditDirectCall(assembled.method, actionDef.url_template, params, audit);
      result = await sendDirect(assembled, { fetchImpl });
    }
  }

  return result;
}
