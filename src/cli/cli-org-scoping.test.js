import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo-wide CLI org-scoping (auto-task #13). Mirrors conn.org-scoping.test.js
// (PR#127) for the remaining CLI surface: as / comm / tm / kb / core.
//
// Every ORG-OWNED route is org-scoped: the backend resolves the org from the JWT
// principal and 403s ("org membership required") on an identity-only token. On
// a MULTI-org agent with no {org} and no COCO_ORG_ID the default-org resolver
// returns '' — a bare get()/post() would then go out identity-only and hit that
// 403. Each org-owned command must instead FAIL FAST with an actionable 400
// BEFORE any network call; and when {org} IS given it must carry THAT org's
// exchanged JWT. The identity/bootstrap commands (core.me / org_list /
// org_switch / invitation_accept) must NOT fail fast — they stay identity-scoped.
//
// The CLIs run main() on import, so they are exercised via subprocess (execFile).

const cli = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));

function writeConfig(home, orgs, extra = {}) {
  const compDir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(compDir, 'runtime/connect'), { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({ ...extra, orgs }));
  return home;
}

function setupMultiOrgHome(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-multiorg-'));
  return writeConfig(home, {
    'org-1': { enabled: true, org_id: 'org-1', org_name: 'Alpha', self: { member_id: 'm-1' } },
    'org-2': { enabled: true, org_id: 'org-2', org_name: 'Beta', self: { member_id: 'm-2' } },
  }, extra);
}

function setupSingleOrgHome(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-singleorg-'));
  return writeConfig(home, {
    'org-1': { enabled: true, org_id: 'org-1', org_name: 'Alpha', self: { member_id: 'm-1' } },
  }, extra);
}

// COCO_ORG_ID='' forces the multi-org "no default org" path deterministically.
// COCO_AUTH_TOKEN short-circuits the JWT exchange; the unroutable COCO_API_URL
// means any stray network call fails with a DIFFERENT error the assertions catch.
function run(home, cliName, command, params, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli(cliName), command, JSON.stringify(params)], {
      env: {
        ...process.env,
        HOME: home,
        COCO_API_URL: 'http://127.0.0.1:1',
        COCO_AUTH_TOKEN: 'test-token',
        COCO_ORG_ID: '',
        COCO_RPC_LOG: '0',
        ...env,
      },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

// ---- (1) Org-owned commands fail fast (400) on multi-org with no {org} -------

for (const c of [
  { cli: 'tm.js',   command: 'project.list',              params: {} },
  { cli: 'tm.js',   command: 'issue.list',                params: {} },
  { cli: 'tm.js',   command: 'task.get',                  params: { id: 't1' } },
  { cli: 'kb.js',   command: 'kb.list',                   params: {} },
  { cli: 'kb.js',   command: 'kb.get',                    params: { kbId: 'k1' } },
  { cli: 'kb.js',   command: 'kb.search',                 params: { query: 'x' } },
  { cli: 'comm.js', command: 'comm.list_conversations',   params: {} },
  { cli: 'comm.js', command: 'comm.send',                 params: { conversationId: 'c1', content: 'hi' } },
  { cli: 'comm.js', command: 'comm.member_list',          params: { conversationId: 'c1' } },
  { cli: 'as.js',   command: 'as.url',                    params: { uri: 'artifact://x' } },
  { cli: 'as.js',   command: 'as.resolve',                params: { uris: ['artifact://x'] } },
  { cli: 'core.js', command: 'core.member_list',          params: {} },
  { cli: 'core.js', command: 'core.project_members',      params: { projectId: 'p1' } },
  { cli: 'core.js', command: 'core.invitation_list',      params: {} },
  // The 4 previously-AMBIGUOUS commands, decided org-scoped:
  { cli: 'core.js', command: 'core.platform_agent_create', params: { displayName: 'A' } },
  { cli: 'core.js', command: 'core.platform_agent_delete', params: { memberId: 'm9' } },
  { cli: 'core.js', command: 'core.org_get',              params: {} },
  { cli: 'core.js', command: 'core.role_list',            params: {} },
]) {
  test(`fail-fast: ${c.cli} ${c.command} — multi-org & no {org} → 400`, async () => {
    const home = setupMultiOrgHome();
    const { code, stderr } = await run(home, c.cli, c.command, c.params);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400, `expected 400, got: ${stderr}`);
    assert.match(err.error, /cannot resolve org|multiple orgs|multiple enabled/i);
  });
}

// ---- (2) Identity / bootstrap commands must NOT fail fast --------------------
// They stay identity-scoped: on multi-org with no {org} they attempt the network
// (and here hit the unroutable URL) rather than throwing the org-resolution 400.

for (const c of [
  { command: 'core.me',                params: {} },
  { command: 'core.org_list',          params: {} },
  { command: 'core.org_switch',        params: { orgId: 'org-1' } },
  { command: 'core.invitation_accept', params: { invitationId: 'i1', token: 'tok' } },
]) {
  test(`keep-identity: core.js ${c.command} — multi-org does NOT emit org-resolution 400`, async () => {
    const home = setupMultiOrgHome();
    const { stderr } = await run(home, 'core.js', c.command, c.params);
    // It may still error (unroutable network), but NOT with the org-resolution 400.
    if (stderr.trim()) {
      let err = {};
      try { err = JSON.parse(stderr); } catch { /* non-JSON stderr is fine */ }
      assert.doesNotMatch(String(err.error || ''), /cannot resolve org|multiple orgs enabled/i);
    }
  });
}

// ---- (3) {org} passthrough carries THAT org's exchanged JWT ------------------
// Without COCO_AUTH_TOKEN so the real token-exchange path runs. The harness
// mints tok-<org_id> at /auth/agent/token and records the bearer each call
// presents — proving the shadowed verbs route through the requested org.

function tokenHarness(match) {
  const seen = { auth: null, url: null };
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
    if (match(req.url)) {
      seen.auth = req.headers.authorization || null;
      seen.url = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(match.body ?? { data: { ok: true }, request_id: 'r1' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  return { server, seen };
}

function runRealToken(home, cliName, command, params, apiUrl) {
  return run(home, cliName, command, params, {
    COCO_API_URL: apiUrl,
    COCO_AUTH_TOKEN: '',
    COCO_USER_TOKEN: '',
    COCO_API_KEY: '',
  });
}

test('core.me with explicit org uses that org member token while bootstrap remains available', async () => {
  const home = setupMultiOrgHome({ agent: { api_key: 'cwsk_test' } });
  const { server, seen } = tokenHarness((u) => u.endsWith('/me'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const result = await runRealToken(home, 'core.js', 'core.me', { org: 'org-2' }, `http://127.0.0.1:${server.address().port}`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(seen.auth, 'Bearer tok-org-2');
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('org routing: tm.js project.list {org} carries THAT org\'s exchanged JWT', async () => {
  const home = setupMultiOrgHome({ agent: { api_key: 'cwsk_test' } });
  const { server, seen } = tokenHarness((u) => u.includes('/projects'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const r = await runRealToken(home, 'tm.js', 'project.list', { org: 'org-2' }, `http://127.0.0.1:${port}`);
    assert.equal(r.code, 0, `expected success, got stderr: ${r.stderr}`);
    assert.equal(seen.auth, 'Bearer tok-org-2');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---- (4) Bug A regression: getMediaUrl(idOrUri, orgId) threads the org -------
// Previously as.js getMediaUrl ran a BARE post('/artifacts/resolve'); the org_id
// comm-bridge passed landed in `opts` and was silently dropped → identity-only
// resolve → 403 on multi-org media. as.url {org} must now carry that org's JWT.

test('Bug A: as.js as.url {org} carries THAT org\'s JWT on /artifacts/resolve (not identity)', async () => {
  const home = setupMultiOrgHome({ agent: { api_key: 'cwsk_test' } });
  const matcher = (u) => u.includes('/artifacts/resolve');
  matcher.body = { resolved: { 'artifact://x': { download_url: 'https://dl.example/x', name: 'x' } }, failed: [] };
  const { server, seen } = tokenHarness(matcher);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const r = await runRealToken(home, 'as.js', 'as.url', { uri: 'artifact://x', org: 'org-2' }, `http://127.0.0.1:${port}`);
    assert.equal(r.code, 0, `expected success, got stderr: ${r.stderr}`);
    assert.equal(seen.auth, 'Bearer tok-org-2');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
