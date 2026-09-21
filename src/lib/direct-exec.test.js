import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveActionDef,
  validateParams,
  assembleRequest,
  canonicalAuthScheme,
  isTokenRefreshable,
  isTokenNearExpiry,
  chooseExecMode,
  resolveCredential,
  sendDirect,
  invokeDirect,
  MAX_RESPONSE_BYTES,
} from './direct-exec.js';

// Silence the audit sink for tests (it writes to stderr by default).
const quietAudit = () => {};

// A fetch double: returns a Response-like object with a status, JSON/text body,
// and Headers. Exposes `body` as a real web ReadableStream so sendDirect's
// streaming capped-read path is exercised (with a text() fallback). Records each
// call so assembly can be asserted end-to-end.
function fakeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    const bodyText = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    const bytes = new TextEncoder().encode(bodyText);
    return {
      status: r.status ?? 200,
      headers: new Map(Object.entries(r.headers || { 'content-type': 'application/json' })),
      body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      text: async () => bodyText,
    };
  };
  return { impl, calls };
}

const GMAIL_GET = {
  toolkit: 'gmail-messages',
  action: 'get',
  method: 'GET',
  url_template: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format={format}',
  input_schema: '',
};

const GMAIL_SEND = {
  toolkit: 'gmail-messages',
  action: 'send',
  method: 'POST',
  url_template: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
  headers_template: { 'X-Trace': 'req-{traceId}' },
  input_schema: { type: 'object', properties: { raw: { type: 'string' } }, required: ['raw'] },
};

// ---------------------------------------------------------------------------
//  O1 — resolution + assembly from url_template + params
// ---------------------------------------------------------------------------

test('O1 resolveActionDef: matches "toolkit/action", falls back to bare action', () => {
  const cat = [GMAIL_GET, GMAIL_SEND];
  assert.equal(resolveActionDef(cat, 'gmail-messages/get'), GMAIL_GET);
  assert.equal(resolveActionDef(cat, 'send'), GMAIL_SEND);
  assert.equal(resolveActionDef(cat, 'nope/missing'), null);
});

test('O1 assembleRequest: fills path + query placeholders, injects Bearer, no body on GET', () => {
  const req = assembleRequest(GMAIL_GET, { id: 'abc123', format: 'full' }, 'TOK');
  assert.equal(req.method, 'GET');
  assert.equal(req.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123?format=full');
  assert.equal(req.headers.Authorization, 'Bearer TOK');
  assert.equal(req.body, undefined);
});

test('O1 assembleRequest: an omitted optional QUERY placeholder drops the whole pair (no literal {token})', () => {
  const req = assembleRequest(GMAIL_GET, { id: 'abc123' }, 'TOK'); // no format
  assert.equal(req.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123');
  assert.ok(!req.url.includes('{'), 'no unfilled placeholder may reach the URL');
});

test('O1 assembleRequest: a missing required PATH placeholder throws 400', () => {
  assert.throws(
    () => assembleRequest(GMAIL_GET, { format: 'full' }, 'TOK'),
    (e) => e.status === 400 && /path param "id"/.test(e.message),
  );
});

test('O1 assembleRequest: remaining params become the JSON body (write method) + templated header', () => {
  const req = assembleRequest(GMAIL_SEND, { raw: 'BASE64', traceId: 'xyz' }, 'TOK');
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(req.headers['X-Trace'], 'req-xyz'); // header template filled + param consumed
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.deepEqual(req.body, { raw: 'BASE64' }); // traceId consumed by header, not in body
});

test('O1 assembleRequest: url_template missing → 422 (catalog too old for direct)', () => {
  assert.throws(
    () => assembleRequest({ toolkit: 't', action: 'a', method: 'GET' }, {}, 'TOK'),
    (e) => e.status === 422,
  );
});

const JENKINS_JOBS = {
  toolkit: 'jenkins',
  action: 'jobs',
  method: 'GET',
  url_template: '{base_url}/api/json?tree={tree}',
  input_schema: '',
};

test('O1 assembleRequest: a connection-owned {base_url} is filled VERBATIM from url_placeholders', () => {
  const req = assembleRequest(JENKINS_JOBS, { tree: 'jobs' }, 'TOK', { base_url: 'https://jenkins.example.com' });
  // base_url substituted literally as the prefix (NOT percent-encoded); the
  // genuine query param {tree} IS encoded.
  assert.equal(req.url, 'https://jenkins.example.com/api/json?tree=jobs');
  assert.equal(req.headers.Authorization, 'Bearer TOK');
});

test('O1 assembleRequest: {base_url} present in neither params nor url_placeholders → 422, no literal on the wire', () => {
  const req = () => assembleRequest(JENKINS_JOBS, { tree: 'jobs' }, 'TOK', {});
  assert.throws(req, (e) => e.status === 422 && /base_url/.test(e.message));
  // And nothing with a literal "{base_url}" could ever be produced:
  try { req(); } catch (e) { assert.ok(!String(e.url || '').includes('{base_url}')); }
});

test('O1 assembleRequest: params win over url_placeholders on a name clash', () => {
  const def = { toolkit: 't', action: 'a', method: 'GET', url_template: 'https://host/{id}', input_schema: '' };
  const req = assembleRequest(def, { id: 'from-param' }, 'T', { id: 'from-conn' });
  assert.equal(req.url, 'https://host/from-param');
});

test('O1 assembleRequest: url_placeholders can fill an optional QUERY placeholder too', () => {
  const def = { toolkit: 't', action: 'a', method: 'GET', url_template: 'https://host/x?region={region}', input_schema: '' };
  const req = assembleRequest(def, {}, 'T', { region: 'eu-west' });
  assert.equal(req.url, 'https://host/x?region=eu-west');
});

test('O1 assembleRequest: a headers_template Authorization can NOT override the injected token', () => {
  const def = { ...GMAIL_GET, headers_template: { Authorization: 'Bearer EVIL' } };
  const req = assembleRequest(def, { id: 'x' }, 'GOOD');
  assert.equal(req.headers.Authorization, 'Bearer GOOD');
});

test('O1 sendDirect: passthrough result shape {status_code, headers, body}, JSON parsed', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { messages: [{ id: '1' }] } });
  const out = await sendDirect(assembleRequest(GMAIL_GET, { id: '1' }, 'TOK'), { fetchImpl: impl });
  assert.equal(out.status_code, 200);
  assert.deepEqual(out.body, { messages: [{ id: '1' }] });
  assert.equal(out.headers['content-type'], 'application/json');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer TOK');
});

test('O1 sendDirect: non-JSON body is passed through raw (not transformed)', async () => {
  const { impl } = fakeFetch({ status: 200, body: 'plain text', headers: { 'content-type': 'text/plain' } });
  const out = await sendDirect(assembleRequest(GMAIL_GET, { id: '1' }, 'T'), { fetchImpl: impl });
  assert.equal(out.body, 'plain text');
});

test('P2-B sendDirect: an over-cap response ERRORS via streaming read, stopping early (never fully buffered)', async () => {
  const chunkSize = 1024 * 1024;       // 1 MiB per chunk
  const chunk = new Uint8Array(chunkSize);
  const maxChunks = 20;                // 20 MiB available; cap is 10 MiB
  let pulled = 0;
  const impl = async () => ({
    status: 200,
    headers: new Map([['content-type', 'application/octet-stream']]),
    body: new ReadableStream({
      pull(controller) {
        if (pulled >= maxChunks) { controller.close(); return; }
        pulled += 1;
        controller.enqueue(chunk);
      },
    }),
    text: async () => { throw new Error('text() must not be used when a readable stream is available'); },
  });
  await assert.rejects(
    () => sendDirect({ url: 'https://x/y', method: 'GET', headers: {} }, { fetchImpl: impl }),
    (e) => e.status === 502 && /cap/.test(e.message),
  );
  // The stream must be cancelled near the cap — NOT drained fully into memory.
  // (A small read-ahead margin is allowed for the stream's internal buffering.)
  assert.ok(pulled < maxChunks, `stream must stop early at the cap (pulled ${pulled}/${maxChunks} chunks)`);
  assert.ok(pulled <= Math.ceil(MAX_RESPONSE_BYTES / chunkSize) + 3, `must stop near the cap, not drain the whole body (pulled ${pulled})`);
});

test('O1 sendDirect: an under-cap streamed body parses to JSON (streaming path)', async () => {
  const { impl } = fakeFetch({ status: 200, body: { hello: 'world' } });
  const out = await sendDirect(assembleRequest(GMAIL_GET, { id: '1' }, 'T'), { fetchImpl: impl });
  assert.deepEqual(out.body, { hello: 'world' });
});

test('O1 validateParams: enforces required + declared types, lenient on unknowns', () => {
  assert.equal(validateParams({ raw: 'x' }, GMAIL_SEND.input_schema).ok, true);
  assert.equal(validateParams({}, GMAIL_SEND.input_schema).ok, false); // missing required raw
  assert.equal(validateParams({ raw: 123 }, GMAIL_SEND.input_schema).ok, false); // wrong type
  assert.equal(validateParams({ raw: 'x', extra: 1 }, GMAIL_SEND.input_schema).ok, true); // unknown ok
  assert.equal(validateParams({ anything: 1 }, '').ok, true); // empty schema → no validation
});

// ---------------------------------------------------------------------------
//  Generic token injection — canonicalAuthScheme(token_type) + auth_injection
//  descriptor. Mirrors cws-connect's canonicalAuthScheme EXACTLY.
// ---------------------------------------------------------------------------

test('GA canonicalAuthScheme: mirrors cws-connect (bearer/api_key/empty→Bearer, basic→Basic, else verbatim)', () => {
  assert.equal(canonicalAuthScheme(''), 'Bearer');
  assert.equal(canonicalAuthScheme(undefined), 'Bearer');
  assert.equal(canonicalAuthScheme(null), 'Bearer');
  assert.equal(canonicalAuthScheme('bearer'), 'Bearer');
  assert.equal(canonicalAuthScheme('Bearer'), 'Bearer');
  assert.equal(canonicalAuthScheme('BEARER'), 'Bearer');
  assert.equal(canonicalAuthScheme('api_key'), 'Bearer');
  assert.equal(canonicalAuthScheme('API_KEY'), 'Bearer');
  assert.equal(canonicalAuthScheme('basic'), 'Basic');
  assert.equal(canonicalAuthScheme('BASIC'), 'Basic');
  assert.equal(canonicalAuthScheme('Token'), 'Token'); // verbatim
  assert.equal(canonicalAuthScheme('SSWS'), 'SSWS');   // verbatim
});

test('GA assembleRequest: token_type "bearer" → Authorization: Bearer <t>', () => {
  const req = assembleRequest(GMAIL_GET, { id: 'x' }, 'TOK', {}, 'bearer');
  assert.equal(req.headers.Authorization, 'Bearer TOK');
});

test('GA assembleRequest: token_type "api_key" → Authorization: Bearer <t>', () => {
  const req = assembleRequest(GMAIL_GET, { id: 'x' }, 'TOK', {}, 'api_key');
  assert.equal(req.headers.Authorization, 'Bearer TOK');
});

test('GA assembleRequest: token_type "basic" → Authorization: Basic <t>', () => {
  const req = assembleRequest(GMAIL_GET, { id: 'x' }, 'TOK', {}, 'basic');
  assert.equal(req.headers.Authorization, 'Basic TOK');
});

test('GA assembleRequest: token_type "Token" → Authorization: Token <t> (verbatim scheme)', () => {
  const req = assembleRequest(GMAIL_GET, { id: 'x' }, 'TOK', {}, 'Token');
  assert.equal(req.headers.Authorization, 'Token TOK');
});

test('GA assembleRequest: token_type any-case bearer (BEARER/bearer) → Authorization: Bearer <t>', () => {
  assert.equal(assembleRequest(GMAIL_GET, { id: 'x' }, 'TOK', {}, 'BEARER').headers.Authorization, 'Bearer TOK');
  assert.equal(assembleRequest(GMAIL_GET, { id: 'x' }, 'TOK', {}, 'bearer').headers.Authorization, 'Bearer TOK');
});

test('GA assembleRequest: token_type "" / undefined → Authorization: Bearer <t>', () => {
  assert.equal(assembleRequest(GMAIL_GET, { id: 'x' }, 'TOK', {}, '').headers.Authorization, 'Bearer TOK');
  assert.equal(assembleRequest(GMAIL_GET, { id: 'x' }, 'TOK', {}, undefined).headers.Authorization, 'Bearer TOK');
  assert.equal(assembleRequest(GMAIL_GET, { id: 'x' }, 'TOK').headers.Authorization, 'Bearer TOK'); // default arg
});

test('GA assembleRequest: auth_injection {header, X-API-Key, "{token}"} → X-API-Key header, NO Authorization', () => {
  const req = assembleRequest(GMAIL_GET, { id: 'x' }, 'TOK', {}, 'api_key', { location: 'header', name: 'X-API-Key', value_template: '{token}' });
  assert.equal(req.headers['X-API-Key'], 'TOK');
  assert.equal(req.headers.Authorization, undefined, 'descriptor path must not emit an Authorization header');
});

test('GA assembleRequest: auth_injection {query, api_key, "{token}"} → URL carries api_key=<t>, no Authorization', () => {
  const req = assembleRequest(GMAIL_GET, { id: 'x', format: 'full' }, 'TOK', {}, 'api_key', { location: 'query', name: 'api_key', value_template: '{token}' });
  assert.ok(req.url.includes('api_key=TOK'), `URL should carry api_key=TOK: ${req.url}`);
  assert.equal(req.headers.Authorization, undefined, 'query-injection path must not emit an Authorization header');
});

test('GA assembleRequest: auth_injection {query,...} appends onto an existing query string', () => {
  // GMAIL_GET already has ?format={format}; the query descriptor must append with &.
  const req = assembleRequest(GMAIL_GET, { id: 'x', format: 'full' }, 'TOK', {}, 'api_key', { location: 'query', name: 'api_key', value_template: '{token}' });
  assert.ok(req.url.includes('format=full'), 'the templated query param survives');
  assert.ok(/[?&]api_key=TOK/.test(req.url), 'injected query pair is present with a proper separator');
});

test('GA assembleRequest: auth_injection {header, Authorization, "SSWS {token}"} → Authorization: SSWS <t>', () => {
  const req = assembleRequest(GMAIL_GET, { id: 'x' }, 'TOK', {}, 'bearer', { location: 'header', name: 'Authorization', value_template: 'SSWS {token}' });
  assert.equal(req.headers.Authorization, 'SSWS TOK');
});

test('GA assembleRequest: a descriptor header wins over a headers_template header of the same name', () => {
  const def = { ...GMAIL_GET, headers_template: { 'X-API-Key': 'template-value' } };
  const req = assembleRequest(def, { id: 'x' }, 'TOK', {}, 'api_key', { location: 'header', name: 'X-API-Key', value_template: '{token}' });
  assert.equal(req.headers['X-API-Key'], 'TOK', 'descriptor wins over the template');
});

test('GA assembleRequest: descriptor header wins over a DIFFERENT-CASE template header (no duplicate key)', () => {
  // Template uses lowercase `x-api-key`; descriptor injects `X-API-Key`. The old code
  // left BOTH keys, which Node/fetch merges into one comma-joined value ("template-value, TOK")
  // — an invalid credential header. The injected value must be the sole survivor.
  const def = { ...GMAIL_GET, headers_template: { 'x-api-key': 'template-value' } };
  const req = assembleRequest(def, { id: 'x' }, 'TOK', {}, 'api_key', { location: 'header', name: 'X-API-Key', value_template: '{token}' });
  const apiKeyKeys = Object.keys(req.headers).filter((k) => k.toLowerCase() === 'x-api-key');
  assert.deepEqual(apiKeyKeys, ['X-API-Key'], 'exactly one x-api-key header, in the descriptor casing');
  assert.equal(req.headers['X-API-Key'], 'TOK', 'value is the injected token, not the template value');
  assert.equal(req.headers['x-api-key'], undefined, 'the lowercase template key was removed');
});

test('GA invokeDirect: credential token_type flows into the Authorization scheme on the wire', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { ok: true } });
  await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'basic', access_token: 'BLOB' },
    },
    { fetchImpl: impl, audit: quietAudit },
  );
  assert.equal(calls[0].opts.headers.Authorization, 'Basic BLOB');
});

test('GA invokeDirect: a credential auth_injection descriptor flows through to the wire', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { ok: true } });
  await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'api_key', access_token: 'KEY', auth_injection: { location: 'header', name: 'X-API-Key', value_template: '{token}' } },
    },
    { fetchImpl: impl, audit: quietAudit },
  );
  assert.equal(calls[0].opts.headers['X-API-Key'], 'KEY');
  assert.equal(calls[0].opts.headers.Authorization, undefined);
});

// ---------------------------------------------------------------------------
//  P2-A — audit must never leak a secret through the logged URL
// ---------------------------------------------------------------------------

test('P2-A audit: a secret in a url_template query placeholder never reaches the log', async () => {
  const SECRET_ACTION = {
    toolkit: 'svc', action: 'get', method: 'GET',
    // A secret carried in the query string — the exact leak P2-A describes.
    url_template: 'https://api.example.com/v1/thing?api_key={api_key}&id={id}',
    input_schema: '',
  };
  const { impl, calls } = fakeFetch({ status: 200, body: { ok: true } });
  const lines = [];
  await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'svc/get',
      params: { api_key: 'SUPERSECRETVALUE', id: '42' }, catalog: [SECRET_ACTION],
      credential: { credential_mode: 'direct', token_type: 'bearer', access_token: 'T' },
    },
    { fetchImpl: impl, audit: (l) => lines.push(l) },
  );
  const joined = lines.join('\n');
  assert.ok(lines.length >= 1, 'a direct call must produce an audit line');
  assert.ok(!joined.includes('SUPERSECRETVALUE'), `audit line leaked the secret: ${joined}`);
  assert.ok(joined.includes('{api_key}'), 'audit should log the UN-expanded url_template (placeholder literal)');
  // Sanity: the secret WAS expanded onto the real wire (just not into the log).
  assert.ok(calls[0].url.includes('SUPERSECRETVALUE'), 'the actual request URL still carries the real secret');
});

// ---------------------------------------------------------------------------
//  O2 — mode split
// ---------------------------------------------------------------------------

test('O2 chooseExecMode: direct only when a cached credential is credential_mode=direct', () => {
  assert.equal(chooseExecMode({ credential_mode: 'direct', access_token: 't' }), 'direct');
  assert.equal(chooseExecMode({ credential_mode: 'proxy' }), 'proxy');
  assert.equal(chooseExecMode(null), 'proxy'); // no local cred file → proxy path
  assert.equal(chooseExecMode(undefined), 'proxy');
});

test('O2 resolveCredential: a present direct cache is used as-is (no acquire)', async () => {
  let acquires = 0;
  const cached = { credential_mode: 'direct', access_token: 'T' };
  const res = await resolveCredential(
    { orgId: 'o', connectionId: 'c', cached },
    { acquire: async () => { acquires++; return {}; } },
  );
  assert.equal(acquires, 0);
  assert.equal(res.mode, 'direct');
  assert.equal(res.credential, cached);
});

// Refinement 2: a direct connection with NO local cache must re-acquire (not
// fall through to proxy), save the credential, then run direct.
test('O2 resolveCredential: direct connection + no cache file → acquire + save, then direct', async () => {
  let acquires = 0;
  const saved = [];
  const res = await resolveCredential(
    { orgId: 'org-1', connectionId: 'conn-1', cached: null },
    {
      acquire: async (oid, cid) => { acquires++; assert.deepEqual([oid, cid], ['org-1', 'conn-1']); return { credential_mode: 'direct', access_token: 'FRESH', expires_at: 123 }; },
      saveCache: (cid, cred) => saved.push([cid, cred.access_token]),
    },
  );
  assert.equal(acquires, 1, 'a cache miss must trigger exactly one acquire');
  assert.deepEqual(saved, [['conn-1', 'FRESH']], 're-acquired direct credential is cached locally');
  assert.equal(res.mode, 'direct');
  assert.equal(res.credential.access_token, 'FRESH');
});

test('O2 resolveCredential: proxy connection + no cache → acquire discovers proxy, caches nothing, routes proxy', async () => {
  const saved = [];
  const res = await resolveCredential(
    { orgId: 'o', connectionId: 'c', cached: null },
    { acquire: async () => ({ credential_mode: 'proxy', proxy_ref: 'ref' }), saveCache: (cid, cred) => saved.push([cid, cred]) },
  );
  assert.equal(res.mode, 'proxy');
  assert.equal(res.credential, null, 'a proxy connection caches no local credential');
  assert.equal(saved.length, 0);
});

test('O2 resolveCredential: an acquire failure propagates (never a silent proxy downgrade)', async () => {
  await assert.rejects(
    () => resolveCredential(
      { orgId: 'o', connectionId: 'c', cached: null },
      { acquire: async () => { throw Object.assign(new Error('acquire boom'), { status: 502 }); } },
    ),
    /acquire boom/,
  );
});

// ---------------------------------------------------------------------------
//  O4 — token lifecycle: token_type gates refreshability, expires_at gates
//  proactive refresh; reactive-401-once for refreshable (OAuth) tokens.
// ---------------------------------------------------------------------------

test('O4 isTokenRefreshable: only a normalized "api_key" is non-refreshable; any casing of bearer / other → OAuth', () => {
  // api_key (fixed value) — normalized exact match, incl. surrounding space / case
  assert.equal(isTokenRefreshable({ token_type: 'api_key' }), false);
  assert.equal(isTokenRefreshable({ token_type: ' API_KEY ' }), false);
  // OAuth — both casings of bearer, never matched by a fragile "bearer" test
  assert.equal(isTokenRefreshable({ token_type: 'Bearer' }), true);
  assert.equal(isTokenRefreshable({ token_type: 'bearer' }), true);
  // anything unexpected, or a missing token_type, defaults to refreshable OAuth (GitHub)
  assert.equal(isTokenRefreshable({ token_type: 'something-else' }), true);
  assert.equal(isTokenRefreshable({}), true);
  assert.equal(isTokenRefreshable(null), false);
});

test('O4 isTokenNearExpiry: near/expired vs comfortable vs no-expiry', () => {
  const now = 1_000_000_000_000;
  assert.equal(isTokenNearExpiry({ expires_at: now + 5_000 }, now, 60_000), true); // within skew
  assert.equal(isTokenNearExpiry({ expires_at: now + 3_600_000 }, now, 60_000), false); // 1h out
  assert.equal(isTokenNearExpiry({}, now, 60_000), false); // no expiry → not proactive
  // epoch-seconds form is normalized to ms
  assert.equal(isTokenNearExpiry({ expires_at: Math.floor((now + 5_000) / 1000) }, now, 60_000), true);
});

test('O4 invokeDirect: near-expiry OAuth token → proactive refresh BEFORE the send', async () => {
  const now = 2_000_000_000_000;
  const { impl, calls } = fakeFetch({ status: 200, body: { ok: true } });
  const acquired = [];
  const saved = [];
  const out = await invokeDirect(
    {
      orgId: 'org-1',
      connection: { id: 'conn-1', applicationId: 'app-1', slug: 'gmail' },
      actionSlug: 'gmail-messages/get',
      params: { id: 'm1' },
      catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'Bearer', access_token: 'OLD', expires_at: now + 1_000 },
    },
    {
      fetchImpl: impl,
      now: () => now,
      acquire: async (oid, cid) => { acquired.push([oid, cid]); return { credential_mode: 'direct', token_type: 'Bearer', access_token: 'NEW', expires_at: now + 3_600_000 }; },
      saveCache: (cid, cred) => saved.push([cid, cred.access_token]),
      audit: quietAudit,
    },
  );
  assert.deepEqual(acquired, [['org-1', 'conn-1']], 'should refresh exactly once, before sending');
  assert.deepEqual(saved, [['conn-1', 'NEW']], 'refreshed token must be re-saved locally');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer NEW', 'send must use the refreshed token');
  assert.equal(out.status_code, 200);
});

test('O4 invokeDirect: a comfortable OAuth token is NOT refreshed', async () => {
  const now = 2_000_000_000_000;
  const { impl } = fakeFetch({ status: 200, body: {} });
  let acquires = 0;
  await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'Bearer', access_token: 'T', expires_at: now + 3_600_000 },
    },
    { fetchImpl: impl, now: () => now, acquire: async () => { acquires++; return {}; }, audit: quietAudit },
  );
  assert.equal(acquires, 0);
});

test('O4 invokeDirect: provider 401 on OAuth → reactive refresh ONCE, retry, succeed', async () => {
  const { impl, calls } = fakeFetch([
    { status: 401, body: { error: 'expired' } },
    { status: 200, body: { ok: true } },
  ]);
  let acquires = 0;
  const out = await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'Bearer', access_token: 'OLD' },
    },
    {
      fetchImpl: impl,
      acquire: async () => { acquires++; return { credential_mode: 'direct', token_type: 'Bearer', access_token: 'NEW' }; },
      audit: quietAudit,
    },
  );
  assert.equal(acquires, 1, 'reactive refresh must happen exactly once');
  assert.equal(calls.length, 2, 'one retry after refresh');
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer NEW');
  assert.equal(out.status_code, 200);
});

test('O4 invokeDirect: still 401 after the single reactive refresh → surfaced, no loop', async () => {
  const { impl, calls } = fakeFetch([
    { status: 401, body: { error: 'e1' } },
    { status: 401, body: { error: 'e2' } },
  ]);
  let acquires = 0;
  const out = await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'Bearer', access_token: 'OLD' },
    },
    { fetchImpl: impl, acquire: async () => { acquires++; return { access_token: 'NEW', token_type: 'Bearer', credential_mode: 'direct' }; }, audit: quietAudit },
  );
  assert.equal(acquires, 1, 'must NOT refresh more than once (no loop)');
  assert.equal(calls.length, 2, 'exactly the original + one retry');
  assert.equal(out.status_code, 401, 'the second 401 is surfaced to the caller');
});

test('O4 invokeDirect: no-expiry OAuth (GitHub-style) → NO proactive refresh on a normal call', async () => {
  const { impl } = fakeFetch({ status: 200, body: {} });
  let acquires = 0;
  await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'bearer', access_token: 'TOK' }, // no expires_at
    },
    { fetchImpl: impl, acquire: async () => { acquires++; return {}; }, audit: quietAudit },
  );
  assert.equal(acquires, 0, 'a token with no expires_at is never proactively refreshed');
});

test('O4 invokeDirect: no-expiry OAuth + provider 401 → reactive refresh ONCE (backstop)', async () => {
  const { impl, calls } = fakeFetch([
    { status: 401, body: { error: 'expired' } },
    { status: 200, body: { ok: true } },
  ]);
  let acquires = 0;
  const out = await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'bearer', access_token: 'OLD' }, // no expires_at (GitHub-style)
    },
    {
      fetchImpl: impl,
      acquire: async () => { acquires++; return { credential_mode: 'direct', token_type: 'bearer', access_token: 'NEW' }; },
      audit: quietAudit,
    },
  );
  assert.equal(acquires, 1, 'the reactive-401 backstop refreshes a no-expiry OAuth token once');
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer NEW');
  assert.equal(out.status_code, 200);
});

test('O4 invokeDirect: api_key (token_type "api_key") → NEVER refreshed, 401 surfaced', async () => {
  const { impl, calls } = fakeFetch({ status: 401, body: { error: 'bad key' } });
  let acquires = 0;
  const out = await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'api_key', access_token: 'KEY' },
    },
    { fetchImpl: impl, acquire: async () => { acquires++; return {}; }, audit: quietAudit },
  );
  assert.equal(acquires, 0, 'api_key has no refresh flow — neither proactive nor reactive');
  assert.equal(calls.length, 1, 'no retry for an api_key 401');
  assert.equal(out.status_code, 401, 'the api_key 401 is surfaced to the user');
});

test('O4 invokeDirect: api_key with a near-expiry expires_at is still NOT proactively refreshed', async () => {
  const now = 2_000_000_000_000;
  const { impl } = fakeFetch({ status: 200, body: {} });
  let acquires = 0;
  await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'api_key', access_token: 'KEY', expires_at: now + 1_000 },
    },
    { fetchImpl: impl, now: () => now, acquire: async () => { acquires++; return {}; }, audit: quietAudit },
  );
  assert.equal(acquires, 0, 'token_type gates refreshability even when expires_at says "near"');
});

test('O1/O4 invokeDirect: a self-hosted connector resolves {base_url} from the credential url_placeholders', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { jobs: [] } });
  const out = await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'jenkins/jobs',
      params: { tree: 'jobs' }, catalog: [JENKINS_JOBS],
      credential: { credential_mode: 'direct', token_type: 'api_key', access_token: 'KEY', url_placeholders: { base_url: 'https://jenkins.example.com' } },
    },
    { fetchImpl: impl, audit: quietAudit },
  );
  assert.equal(calls[0].url, 'https://jenkins.example.com/api/json?tree=jobs', 'base_url must come from the credential and be substituted verbatim');
  assert.equal(out.status_code, 200);
});

test('O1/O4 invokeDirect: a direct connection with no url_placeholders for {base_url} → 422, never sends', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => invokeDirect(
      {
        orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'jenkins/jobs',
        params: { tree: 'jobs' }, catalog: [JENKINS_JOBS],
        credential: { credential_mode: 'direct', token_type: 'api_key', access_token: 'KEY' }, // no url_placeholders
      },
      { fetchImpl: impl, audit: quietAudit },
    ),
    (e) => e.status === 422 && /base_url/.test(e.message),
  );
  assert.equal(calls.length, 0, 'no request may be sent with an unresolved {base_url}');
});

test('O4 invokeDirect: unknown action → 404 before any send', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => invokeDirect(
      { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'nope/missing', params: {}, catalog: [GMAIL_GET], credential: { credential_mode: 'direct', access_token: 'T' } },
      { fetchImpl: impl, audit: quietAudit },
    ),
    (e) => e.status === 404,
  );
  assert.equal(calls.length, 0, 'no HTTP call for an unresolved action');
});

test('O4 invokeDirect: params failing input_schema → 400 before any send', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => invokeDirect(
      { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/send', params: {}, catalog: [GMAIL_SEND], credential: { credential_mode: 'direct', access_token: 'T' } },
      { fetchImpl: impl, audit: quietAudit },
    ),
    (e) => e.status === 400,
  );
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
//  Bug 4 — binary-safe response passthrough (base64 + body_encoding), with
//  text/JSON responses unchanged.
// ---------------------------------------------------------------------------

// A fetch double that streams RAW bytes (a Buffer/Uint8Array) verbatim, so a
// non-utf8 binary body reaches sendDirect exactly as the provider sent it.
function fakeBinaryFetch({ status = 200, bytes, contentType }) {
  const chunk = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const headers = new Map();
  if (contentType !== undefined) headers.set('content-type', contentType);
  const impl = async () => ({
    status,
    headers,
    body: new ReadableStream({ start(c) { c.enqueue(chunk); c.close(); } }),
    text: async () => { throw new Error('text() must not be used for a binary body'); },
  });
  return { impl };
}

test('Bug4 sendDirect: a binary (non-utf8) body round-trips losslessly via base64 + body_encoding', async () => {
  // "%PDF-1.4\n" followed by bytes that are INVALID as utf8 (0xFF, 0xFE, 0x00, 0x80).
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n', 'ascii'), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28])]);
  const { impl } = fakeBinaryFetch({ status: 200, bytes: pdf, contentType: 'application/pdf' });
  const out = await sendDirect({ url: 'https://x/y', method: 'GET', headers: {} }, { fetchImpl: impl });
  assert.equal(out.status_code, 200);
  assert.equal(out.body_encoding, 'base64', 'a binary body must be flagged as base64');
  // Lossless round-trip: decoding the base64 reproduces the ORIGINAL bytes exactly.
  const decoded = Buffer.from(out.body, 'base64');
  assert.ok(decoded.equals(pdf), 'base64 body must decode back to the exact original bytes');
  // Mutation-sanity: the OLD .toString('utf8') path would have corrupted these
  // bytes into U+FFFD — so a utf8 decode of the original CANNOT reproduce them.
  const viaUtf8 = Buffer.from(pdf.toString('utf8'), 'utf8');
  assert.ok(!viaUtf8.equals(pdf), 'guard: utf8 decoding is lossy for this body (old behavior would corrupt it)');
});

test('Bug4 sendDirect: octet-stream (unknown binary) is base64-encoded, not utf8-decoded', async () => {
  const raw = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x81]);
  const { impl } = fakeBinaryFetch({ status: 200, bytes: raw, contentType: 'application/octet-stream' });
  const out = await sendDirect({ url: 'https://x/y', method: 'GET', headers: {} }, { fetchImpl: impl });
  assert.equal(out.body_encoding, 'base64');
  assert.ok(Buffer.from(out.body, 'base64').equals(raw), 'octet-stream bytes must round-trip losslessly');
});

test('Bug4 sendDirect: a JSON response is UNCHANGED (parsed, no body_encoding field)', async () => {
  const { impl } = fakeFetch({ status: 200, body: { messages: [{ id: '1' }] } });
  const out = await sendDirect(assembleRequest(GMAIL_GET, { id: '1' }, 'TOK'), { fetchImpl: impl });
  assert.deepEqual(out.body, { messages: [{ id: '1' }] });
  assert.ok(!('body_encoding' in out), 'text/JSON responses must NOT carry a body_encoding discriminator');
  assert.deepEqual(Object.keys(out).sort(), ['body', 'headers', 'status_code'], 'response shape unchanged for JSON');
});

test('Bug4 sendDirect: a text/plain response is UNCHANGED (raw string, no body_encoding)', async () => {
  const { impl } = fakeFetch({ status: 200, body: 'plain text', headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const out = await sendDirect(assembleRequest(GMAIL_GET, { id: '1' }, 'T'), { fetchImpl: impl });
  assert.equal(out.body, 'plain text');
  assert.ok(!('body_encoding' in out), 'text responses must NOT carry a body_encoding discriminator');
});

test('Bug4 sendDirect: an *+json content-type is treated as textual (parsed, no body_encoding)', async () => {
  const { impl } = fakeFetch({ status: 200, body: { '@context': 'x' }, headers: { 'content-type': 'application/ld+json' } });
  const out = await sendDirect(assembleRequest(GMAIL_GET, { id: '1' }, 'T'), { fetchImpl: impl });
  assert.deepEqual(out.body, { '@context': 'x' });
  assert.ok(!('body_encoding' in out));
});

test('Bug4 sendDirect: a body with NO content-type defaults to textual (prior shape preserved)', async () => {
  const raw = Buffer.from(JSON.stringify({ ok: true }), 'utf8');
  const { impl } = fakeBinaryFetch({ status: 200, bytes: raw, contentType: undefined });
  const out = await sendDirect({ url: 'https://x/y', method: 'GET', headers: {} }, { fetchImpl: impl });
  assert.deepEqual(out.body, { ok: true });
  assert.ok(!('body_encoding' in out), 'a missing content-type must not switch to base64');
});

// ---------------------------------------------------------------------------
//  Bug 1 — a path-param value containing "/" is path-safe encoded (keeps "/"),
//  while a QUERY value containing "/" is still fully percent-encoded.
// ---------------------------------------------------------------------------

const PEOPLE_GET = {
  toolkit: 'google-people', action: 'get', method: 'GET',
  url_template: 'https://people.googleapis.com/v1/{resourceName}?personFields={fields}',
  input_schema: '',
};

test('Bug1 assembleRequest: a path param with "/" stays "/" (people/me → /v1/people/me, NOT people%2Fme)', () => {
  const req = assembleRequest(PEOPLE_GET, { resourceName: 'people/me', fields: 'names' }, 'TOK');
  assert.ok(req.url.includes('/v1/people/me'), `path "/" must be preserved: ${req.url}`);
  assert.ok(!req.url.includes('people%2Fme'), 'the path separator must NOT be percent-encoded');
  assert.equal(req.url, 'https://people.googleapis.com/v1/people/me?personFields=names');
});

test('Bug1 assembleRequest: other unsafe chars in a path value ARE still escaped (only "/" preserved)', () => {
  const def = { toolkit: 't', action: 'a', method: 'GET', url_template: 'https://host/v1/{name}', input_schema: '' };
  const req = assembleRequest(def, { name: 'a b/c?d#e' }, 'T');
  // space→%20, ?→%3F, #→%23 all still escaped; only "/" survives.
  assert.equal(req.url, 'https://host/v1/a%20b/c%3Fd%23e');
});

test('Bug1 assembleRequest: a QUERY value containing "/" is STILL fully percent-encoded (query untouched)', () => {
  const req = assembleRequest(PEOPLE_GET, { resourceName: 'people/me', fields: 'names/primary' }, 'TOK');
  assert.ok(req.url.includes('personFields=names%2Fprimary'), `query "/" must be percent-encoded: ${req.url}`);
  assert.ok(!req.url.includes('personFields=names/primary'), 'query encoding must not preserve "/"');
});

test('Bug1 assembleRequest: a QUERY value with other special chars is still percent-encoded', () => {
  const def = { toolkit: 't', action: 'a', method: 'GET', url_template: 'https://host/x?q={q}', input_schema: '' };
  const req = assembleRequest(def, { q: 'a b&c=d/e' }, 'T');
  assert.equal(req.url, 'https://host/x?q=a%20b%26c%3Dd%2Fe');
});

test('Bug1 invokeDirect: a "/"-bearing path param reaches the wire un-encoded (end-to-end)', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { ok: true } });
  await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'google-people/get',
      params: { resourceName: 'people/me', fields: 'names' }, catalog: [PEOPLE_GET],
      credential: { credential_mode: 'direct', token_type: 'bearer', access_token: 'T' },
    },
    { fetchImpl: impl, audit: quietAudit },
  );
  assert.equal(calls[0].url, 'https://people.googleapis.com/v1/people/me?personFields=names');
});
