import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Org-scoping of the cws-connect verbs (connector-403 fix).
//
// Every cws-connect route is org-scoped: cws-core requires an org-scoped JWT and
// 403s ("org membership required") on an identity-only token. On a MULTI-org
// agent with no {org} and no COCO_ORG_ID, the default-org resolver returns '' —
// a bare get()/post() would then go out identity-only and hit that 403. Each
// verb must instead resolve the org via requireOrgId(), which FAILS FAST with an
// actionable 400 BEFORE any network call; and when {org} IS given it must pass
// through to the org-scoped endpoint. conn.js guards main() behind an is-main
// check, so these are exercised via subprocess (execFile).
//
// (This lives in its own file rather than conn.test.js so it does not collide
// with the multi-connection-disambiguation PR, which adds conn.test.js
// independently; both files coexist and both run under `node --test`.)

const cliPath = fileURLToPath(new URL('./conn.js', import.meta.url));

function setupMultiOrgHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-multiorg-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  const connDir = path.join(compDir, 'runtime/connect');
  fs.mkdirSync(connDir, { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    orgs: {
      'org-1': { enabled: true, org_id: 'org-1', self: { member_id: 'm-1' } },
      'org-2': { enabled: true, org_id: 'org-2', self: { member_id: 'm-2' } },
    },
  }));
  return home;
}

// Forces COCO_ORG_ID='' so the multi-org "no default org" path is exercised
// deterministically regardless of the test runner's own environment.
// COCO_AUTH_TOKEN short-circuits the JWT exchange; the default COCO_API_URL
// points at an unroutable port so any stray network call would fail fast with a
// DIFFERENT error the assertions would catch.
function runConnMultiOrg(home, command, params, apiUrl = 'http://127.0.0.1:1') {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, command, JSON.stringify(params)], {
      env: {
        ...process.env,
        HOME: home,
        COCO_API_URL: apiUrl,
        COCO_AUTH_TOKEN: 'test-token',
        COCO_ORG_ID: '',               // no default org → resolveDefaultOrgId() === ''
        COCO_RPC_LOG: '0',
      },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

for (const c of [
  { command: 'conn.list', params: { conversationId: 'conv-1' } },
  { command: 'conn.status', params: { connectionId: 'c1' } },
  { command: 'conn.acquire', params: { connectionId: 'c1' } },
  { command: 'conn.actions', params: { connectionId: 'c1' } },
  // conn.execute / conn.proxy are direct-only tombstones now (proxy deprecated/
  // removed) — they throw BEFORE any org resolution, so they are covered by a
  // dedicated test below rather than this org-scoping loop.
  { command: 'conn.app_actions', params: { applicationId: 'app-1' } },
  // conn.callback authenticates with the org token (endpoint is authed but not
  // org-scoped) — it still resolves the operating org, so it fails-fast too.
  { command: 'conn.callback', params: {} },
  // The three agent-facing entry points must fail-fast too (they previously
  // used bare resolveOrgId() and would go out identity-only / return a
  // misleading empty result). invoke needs app+action to reach the org check.
  { command: 'conn.catalog', params: { applicationId: 'app-1' } },
  { command: 'conn.invoke', params: { app: 'gmail', action: 'gmail-labels/list', conversationId: 'conv-1' } },
  { command: 'conn.index', params: {} },
  // Custom-connector management verbs must fail-fast too. Params are valid enough
  // to pass local validation so the requireOrgId() gate is what trips (UUIDs where
  // required). The multi-org home enables org-1 + org-2 with no default, so
  // {org} (also not set here) can't be resolved → 400.
  { command: 'conn.app_create', params: { slug: 'acme', display_name: 'Acme', provider_type: 'api_key' } },
  { command: 'conn.app_update', params: { applicationId: '11111111-1111-1111-1111-111111111111', display_name: 'X' } },
  { command: 'conn.actiondef_list', params: { applicationId: '11111111-1111-1111-1111-111111111111' } },
  { command: 'conn.actiondef_create', params: { applicationId: '11111111-1111-1111-1111-111111111111', name: 't/a', description: 'd', method: 'GET', url_template: '{base_url}/x' } },
  { command: 'conn.actiondef_update', params: { applicationId: '11111111-1111-1111-1111-111111111111', actionId: '22222222-2222-2222-2222-222222222222', method: 'GET' } },
  { command: 'conn.actiondef_delete', params: { applicationId: '11111111-1111-1111-1111-111111111111', actionId: '22222222-2222-2222-2222-222222222222' } },
  { command: 'conn.app_import', params: { application: { slug: 'acme', display_name: 'Acme', provider_type: 'api_key' }, actions: [] } },
]) {
  test(`org-scoping fail-fast: ${c.command} 多 org 且未给 {org} → 400（不静默走 identity-only）`, async () => {
    const home = setupMultiOrgHome();
    const { code, stderr } = await runConnMultiOrg(home, c.command, c.params);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400);
    assert.match(err.error, /cannot resolve org|multiple orgs/i);
  });
}

// Direct-only: the removed proxy verbs must fail with an explicit "unsupported /
// deprecated" error (status 400) and never make a network call — even in a
// multi-org home with no {org}. The unroutable COCO_API_URL means any stray
// proxy/execute HTTP call would surface a DIFFERENT (connection) error, so a
// clean deprecated message proves no network happened.
for (const c of [
  { command: 'conn.execute', params: { connectionId: 'c1', action: 'toolkit/act' } },
  { command: 'conn.proxy', params: { connectionId: 'c1', url: 'https://example.test' } },
]) {
  test(`direct-only tombstone: ${c.command} → 400 unsupported（proxy 已废弃，无网络调用）`, async () => {
    const home = setupMultiOrgHome();
    const { code, stderr } = await runConnMultiOrg(home, c.command, c.params);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400);
    assert.match(err.error, /unsupported|deprecated|removed/i);
    assert.match(err.error, /conn\.invoke/); // points to the direct replacement
  });
}

test('org-scoping: 给 {org} → 直通到 org-scoped 端点（conn.status 命中本地 server）', async () => {
  const home = setupMultiOrgHome();
  const server = createServer((req, res) => {
    if (req.url.includes('/connect/connections/c1')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'c1', status: 'active' }, request_id: 'r1' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stdout } = await runConnMultiOrg(home, 'conn.status', { connectionId: 'c1', org: 'org-2' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.id, 'c1');
    assert.equal(out.status, 'active');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// Stronger assertion (per reviewer): prove the ACTUAL Authorization token the
// /connect call carries is the requested org's exchanged JWT — WITHOUT the
// COCO_AUTH_TOKEN override, which would otherwise mask a wrong-org token
// selection. The harness mints a per-org token at /auth/agent/token and records
// the bearer the subsequent /connect call presents.

function setupMultiOrgHomeWithKey() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-realtok-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(compDir, 'runtime/connect'), { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    agent: { api_key: 'cwsk_test' },
    orgs: {
      'org-1': { enabled: true, org_id: 'org-1', self: { member_id: 'm-1' } },
      'org-2': { enabled: true, org_id: 'org-2', self: { member_id: 'm-2' } },
    },
  }));
  return home;
}

// Runs the CLI WITHOUT COCO_AUTH_TOKEN so the real token-exchange path runs.
function runConnRealToken(home, command, params, apiUrl) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, command, JSON.stringify(params)], {
      env: {
        ...process.env,
        HOME: home,
        COCO_API_URL: apiUrl,
        COCO_ORG_ID: '',
        COCO_AUTH_TOKEN: '',   // do NOT short-circuit — exercise the real exchange
        COCO_USER_TOKEN: '',
        COCO_API_KEY: '',      // force the config.agent.api_key path
        COCO_RPC_LOG: '0',
      },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

// Mints `tok-<org_id>` at /auth/agent/token and captures the bearer that the
// /connect call presents. Far-future expiry so getAccessToken uses it as-is.
function makeTokenHarness() {
  const seen = { auth: null };
  const server = createServer((req, res) => {
    if (req.url.includes('/auth/agent/token')) {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let orgId = '';
        try { orgId = JSON.parse(body || '{}').org_id || ''; } catch {}
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: `tok-${orgId || 'identity'}`,
          access_token_expires_at: 9999999999000,
          refresh_token: `r-${orgId || 'identity'}`,
          refresh_token_expires_at: 9999999999000,
        }));
      });
      return;
    }
    if (req.url.includes('/connect/connections/c1')) {
      seen.auth = req.headers.authorization || null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'c1', status: 'active' }, request_id: 'r1' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  return { server, seen };
}

test('org-scoping (no COCO_AUTH_TOKEN): conn.status {org} carries THAT org\'s exchanged JWT, not identity-only', async () => {
  const home = setupMultiOrgHomeWithKey();
  const { server, seen } = makeTokenHarness();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const a = await runConnRealToken(home, 'conn.status', { connectionId: 'c1', org: 'org-2' }, `http://127.0.0.1:${port}`);
    assert.equal(a.code, 0, `expected success, got stderr: ${a.stderr}`);
    // The bearer on the /connect call must be the org-2-scoped token minted for
    // org_id=org-2 — NOT 'Bearer tok-identity' (what a bare/identity-only path
    // would send) and NOT some other org's token.
    assert.equal(seen.auth, 'Bearer tok-org-2');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
