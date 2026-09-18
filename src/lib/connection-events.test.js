import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleConnectionEvent, acquireCredential, isEventForMe, sendOwnerReauthDm, buildConnectionAuthorizedNotice } from './connection-events.js';
import { readIndex, indexPathForOrg, upsertConnection } from './connect-store.js';

// Regression coverage for the 2026-08-04 security fix: cws-core no longer
// accepts a client-supplied agent_member_id, and its
// list-connect-available-connections route moved from
// /connect/agents/{agent_member_id}/connections to /connect/agents/me/connections.
// These tests assert on the ACTUAL calls made — the exact regression a prior
// review round flagged as missing (P2/P3 findings on PR #105 / cws-connect !67).

function tmpDirs() {
  return {
    connectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'connect-idx-')),
    credentialsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'connect-cred-')),
    catalogDir: fs.mkdtempSync(path.join(os.tmpdir(), 'connect-cat-')),
  };
}

function recordingHttp() {
  const calls = [];
  return {
    calls,
    get: async (orgId, urlPath) => { calls.push({ method: 'GET', orgId, path: urlPath }); return { connections: [] }; },
    post: async (orgId, urlPath) => { calls.push({ method: 'POST', orgId, path: urlPath }); return { credential_mode: 'direct', access_token: 'tok' }; },
  };
}

const baseOrgConfig = { slug: 'acme', org_id: 'org-1', self: { member_id: 'agent-self-1' } };

test('acquireCredential: never sends agent_member_id (query param removed by the 2026-08-04 fix)', async () => {
  const calls = [];
  const post = async (orgId, urlPath) => { calls.push({ orgId, path: urlPath }); return {}; };
  await acquireCredential('org-1', 'conn-1', { post });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/v1/connect/connections/conn-1/credential');
  assert.ok(!calls[0].path.includes('agent_member_id'), `path leaked agent_member_id: ${calls[0].path}`);
});

test('isEventForMe: no agent filter → for everyone; matching/mismatching agent_member_id', () => {
  assert.equal(isEventForMe({}, 'agent-1'), true);
  assert.equal(isEventForMe({ agent_member_id: 'agent-1' }, 'agent-1'), true);
  assert.equal(isEventForMe({ agent_member_id: 'agent-2' }, 'agent-1'), false);
  assert.equal(isEventForMe({ agent_member_ids: ['agent-1', 'agent-3'] }, 'agent-1'), true);
  assert.equal(isEventForMe({ agent_member_ids: ['agent-3'] }, 'agent-1'), false);
});

test('connection.authorized (direct mode): acquires credential + warms identity/catalog via the NEW endpoints only', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { calls, get, post } = recordingHttp();

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-1', provider: 'github', credential_mode: 'direct',
  } } };

  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir });

  const paths = calls.map((c) => c.path);
  // The credential acquire must hit the bare path — no agent_member_id query param.
  assert.ok(paths.includes('/api/v1/connect/connections/conn-1/credential'), `missing credential acquire call: ${JSON.stringify(paths)}`);
  // The identity/catalog warm must hit the NEW self-derived path, never the
  // old /connect/agents/{id}/connections shape.
  assert.ok(paths.includes('/api/v1/connect/agents/me/connections'), `missing warm-list call: ${JSON.stringify(paths)}`);
  for (const p of paths) {
    assert.ok(!p.includes('agent_member_id'), `a call leaked agent_member_id: ${p}`);
    assert.ok(!/\/connect\/agents\/[^/]+\/connections/.test(p) || p === '/api/v1/connect/agents/me/connections',
      `a call used the OLD agent-scoped path shape: ${p}`);
  }

  assert.ok(fs.existsSync(path.join(credentialsDir, 'conn-1.json')), 'direct credential was not cached locally');
});

test('connection.authorized (proxy / composio): no LOCAL credential acquire or cache (server-side execute), and the handler stays robust (does not crash)', async () => {
  // Proxy / composio connections hold NO local token — their credential lives
  // server-side and `acquire` is rejected — so the handler correctly SKIPS the
  // local credential acquire+cache (that is the right behavior, not an anomaly:
  // the connection is still invokable via conn.invoke, executed server-side). The
  // handler must also never crash — it skips + logs, and the rest of the
  // best-effort path (identity/catalog warm) still runs. The await resolving
  // (never rejecting) below is itself the robustness assertion.
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { calls, get, post } = recordingHttp();

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-2', provider: 'notion', credential_mode: 'proxy',
  } } };

  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir });

  const paths = calls.map((c) => c.path);
  assert.ok(!paths.some((p) => p.includes('/credential')), `a non-direct connection must never acquire a credential: ${JSON.stringify(paths)}`);
  assert.ok(paths.includes('/api/v1/connect/agents/me/connections'), `missing warm-list call: ${JSON.stringify(paths)}`);
  assert.ok(!fs.existsSync(path.join(credentialsDir, 'conn-2.json')), 'a non-direct connection must not cache a local credential file');
});

test('connection.credential_updated: re-acquires via the bare path when a cached credential already exists', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.writeFileSync(path.join(credentialsDir, 'conn-3.json'), JSON.stringify({ credential_mode: 'direct', access_token: 'old' }));

  const calls = [];
  const post = async (orgId, urlPath) => { calls.push({ orgId, path: urlPath }); return { credential_mode: 'direct', access_token: 'new' }; };
  const get = async () => { throw new Error('credential_updated must not call GET'); };

  const frame = { payload: { event: 'connection.credential_updated', data: { connection_id: 'conn-3', provider: 'github' } } };
  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/v1/connect/connections/conn-3/credential');
  assert.ok(!calls[0].path.includes('agent_member_id'));
});

test('handleConnectionEvent: ignores events not addressed to this agent', async () => {
  const { get, post } = recordingHttp();
  const calls = [];
  const guardedGet = async (...a) => { calls.push(a); return get(...a); };
  const guardedPost = async (...a) => { calls.push(a); return post(...a); };

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-4', provider: 'github', credential_mode: 'direct', agent_member_id: 'someone-else',
  } } };
  await handleConnectionEvent(baseOrgConfig, frame, { get: guardedGet, post: guardedPost });
  assert.equal(calls.length, 0, 'an event addressed to a different agent must trigger no HTTP calls at all');
});

test('connection.authorized: notifies the agent session (so it learns it can act via conn.* without running conn.list)', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { get, post } = recordingHttp();
  const notes = [];
  const notify = (info) => notes.push(info);

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-9', provider: 'gmail', credential_mode: 'direct',
  } } };
  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir, notify });

  assert.equal(notes.length, 1, 'authorize must notify the agent exactly once');
  assert.equal(notes[0].connectionId, 'conn-9');
  assert.equal(notes[0].provider, 'gmail');
  assert.equal(notes[0].mode, 'direct');
});

test('connection.authorized (proxy / composio): notifies the agent and the non-direct mode reaches the notifier (so the notice builder can present it usable-via-server-execute)', async () => {
  // A proxy/composio connection is surfaced to the agent via the authorize notice
  // as USABLE (server-side execute) — that branching happens in
  // buildConnectionAuthorizedNotice (asserted below). Here we assert the mode
  // reaches the notifier so it can branch correctly.
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { get, post } = recordingHttp();
  const notes = [];
  const notify = (info) => notes.push(info);

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-9p', provider: 'gmail', credential_mode: 'proxy',
  } } };
  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir, notify });

  assert.equal(notes.length, 1, 'authorize must notify the agent exactly once, even for a legacy proxy connection');
  assert.equal(notes[0].connectionId, 'conn-9p');
  assert.equal(notes[0].mode, 'proxy', 'the non-direct mode must reach the notifier so the notice can flag it unsupported');
});

// -----------------------------------------------------------------------------
// Authorized-notice text: the agent-facing contract must match conn.invoke's
// routing — BOTH a direct connection (local egress) and a proxy/composio
// connection (server-side execute) are presented as ready to use via conn.invoke;
// only a genuinely unknown/legacy non-direct, non-proxy mode must NOT be presented
// as usable and must NOT hint conn.invoke (the runtime rejects it).
// -----------------------------------------------------------------------------
const noticeOrg = { slug: 'acme' };

test('buildConnectionAuthorizedNotice (direct): presents the connection as ready to use via conn.invoke', () => {
  const text = buildConnectionAuthorizedNotice(noticeOrg, {
    connectionId: 'conn-d', provider: 'github', actionCount: 12, mode: 'direct',
  });
  assert.ok(text.includes('You can use it now'), `direct notice must say it is usable now: ${text}`);
  assert.ok(text.includes('conn.invoke'), `direct notice must hint conn.invoke: ${text}`);
  assert.ok(text.includes('your own egress'), `direct notice must describe the direct self-egress model: ${text}`);
  assert.ok(text.includes('github'), 'direct notice must name the app');
  assert.ok(text.includes('conn-d'), 'direct notice must carry the connection_id');
  // A direct notice must never carry the deprecated/proxy language.
  assert.ok(!/deprecated|not usable|NOT usable|recreated|re-authorized as a direct/i.test(text),
    `direct notice must not carry deprecated/unsupported language: ${text}`);
});

test('buildConnectionAuthorizedNotice (proxy): presents the connection as USABLE via conn.invoke, executed server-side (no local token)', () => {
  const text = buildConnectionAuthorizedNotice(noticeOrg, {
    connectionId: 'conn-p', provider: 'notion', mode: 'proxy',
  });
  // Presented as ready-to-use, hinting conn.invoke — same usable contract as direct.
  assert.ok(text.includes('You can use it now'), `proxy notice must say it is usable now: ${text}`);
  assert.ok(text.includes('conn.invoke'), `proxy notice must hint conn.invoke: ${text}`);
  // The distinguishing detail: it runs server-side (no local token/egress).
  assert.ok(/server-side/i.test(text), `proxy notice must say the action runs server-side: ${text}`);
  assert.ok(/no local token/i.test(text), `proxy notice must say no local token is needed: ${text}`);
  assert.ok(text.includes('notion'), 'proxy notice must name the app');
  assert.ok(text.includes('conn-p'), 'proxy notice must carry the connection_id');
  // Must NOT carry the not-usable / recreate language, nor the direct-only egress phrasing.
  assert.ok(!/not usable|recreated|re-authorized/i.test(text), `proxy notice must not carry not-usable/recreate language: ${text}`);
  assert.ok(!text.includes('your own egress'), `proxy notice must not claim local egress: ${text}`);
});

test('buildConnectionAuthorizedNotice: credential_source is IGNORED — proxy wording only, never "Composio"', () => {
  // credentialSource is no longer part of the taxonomy. Even if a caller passes a
  // stray credentialSource, the notice keys purely on mode==='proxy' and must
  // carry the generic proxy/server-side wording — never provider-specific
  // "Composio" language.
  const text = buildConnectionAuthorizedNotice(noticeOrg, {
    connectionId: 'conn-c', provider: 'gmail', mode: 'proxy', credentialSource: 'composio',
  });
  assert.ok(text.includes('You can use it now'), `proxy notice must say it is usable now: ${text}`);
  assert.ok(text.includes('conn.invoke'), `proxy notice must hint conn.invoke: ${text}`);
  assert.ok(/server-side/i.test(text), `proxy notice must say the action runs server-side: ${text}`);
  assert.ok(!/Composio/i.test(text), `notice must NOT name Composio (genericized to proxy): ${text}`);
  assert.ok(!/not usable|recreated|re-authorized/i.test(text), `proxy notice must not carry not-usable/recreate language: ${text}`);
});

test('buildConnectionAuthorizedNotice (unknown/legacy mode): NOT presented as usable — recreate guidance', () => {
  const text = buildConnectionAuthorizedNotice(noticeOrg, {
    connectionId: 'conn-u', provider: 'slack', mode: '?',
  });
  assert.ok(!text.includes('You can use it now'), `unknown-mode notice must not present the connection as usable: ${text}`);
  assert.ok(/not usable/i.test(text), `unknown-mode notice must fall to the not-usable branch: ${text}`);
  assert.ok(/recreated|re-authorized/i.test(text), `unknown-mode notice must give recreate/re-authorize guidance: ${text}`);
});

test('the authorize notify hook is authorize-only — revoked / disconnected / credential_updated / reauth_needed do NOT fire it', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { get, post } = recordingHttp();
  const notes = [];
  const notify = (info) => notes.push(info);
  // reauth_needed has its OWN hook (notifyReauth); passing one here proves it is
  // never mistaken for the authorize hook.
  const reauthNotes = [];
  const notifyReauth = (info) => reauthNotes.push(info);

  for (const event of [
    'connection.revoked', 'connection.disconnected',
    'connection.credential_updated', 'connection.reauth_needed',
  ]) {
    const frame = { payload: { event, data: { connection_id: 'conn-x', provider: 'gmail' } } };
    await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir, notify, notifyReauth });
  }
  assert.equal(notes.length, 0, 'only connection.authorized should fire the authorize notify hook');
});

test('connection.reauth_needed: clears the credential cache, flags the connection needs_reauth (kept indexed), and fires the reauth notify hook', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { get, post } = recordingHttp();
  // Pre-seed a cached (now-stale) credential so we can assert it gets cleared.
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.writeFileSync(path.join(credentialsDir, 'conn-r.json'), JSON.stringify({ credential_mode: 'direct', access_token: 'stale' }));

  const notes = [];
  const reauthNotes = [];
  const notify = (info) => notes.push(info);
  const notifyReauth = (info) => reauthNotes.push(info);

  const frame = { payload: { event: 'connection.reauth_needed', data: {
    connection_id: 'conn-r', provider: 'github', application_id: 'app-1', trigger: 'provider_401',
  } } };
  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir, notify, notifyReauth });

  // 1) the stale local credential must be gone (stop calling the dead connection)
  assert.ok(!fs.existsSync(path.join(credentialsDir, 'conn-r.json')), 'reauth_needed must clear the cached credential');
  // 2) the connection stays INDEXED, flagged needs_reauth (not removed)
  const idx = readIndex(indexPathForOrg('org-1', connectDir));
  assert.ok(idx.connections['conn-r'], 'reauth_needed must keep the connection indexed');
  assert.equal(idx.connections['conn-r'].status, 'needs_reauth', 'connection must be flagged needs_reauth');
  // 3) the reauth notify hook fires exactly once; the authorize hook never does
  assert.equal(reauthNotes.length, 1, 'reauth_needed must fire the reauth notify hook once');
  assert.equal(reauthNotes[0].connectionId, 'conn-r');
  assert.equal(reauthNotes[0].provider, 'github');
  assert.equal(reauthNotes[0].trigger, 'provider_401');
  assert.equal(notes.length, 0, 'reauth_needed must not fire the authorize notify hook');
});

test('connection.reauth_needed notify is best-effort: a throwing reauth hook never breaks the handler', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { get, post } = recordingHttp();
  const notifyReauth = () => { throw new Error('boom'); };
  const frame = { payload: { event: 'connection.reauth_needed', data: { connection_id: 'conn-r2', provider: 'github' } } };
  // Must resolve, not reject, despite the reauth hook throwing.
  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir, notifyReauth });
  const idx = readIndex(indexPathForOrg('org-1', connectDir));
  assert.equal(idx.connections['conn-r2'].status, 'needs_reauth', 'flag must still be set even when notify throws');
});

test('sendOwnerReauthDm: opens the owner DM then posts a reauth message (create_dm → send)', async () => {
  const calls = [];
  const post = async (orgId, urlPath, body) => {
    calls.push({ orgId, path: urlPath, body });
    if (urlPath.endsWith('/conversations/dm')) return { id: 'cv-owner-1' };
    return { id: 'msg-1' };
  };
  const orgConfig = { slug: 'acme', org_id: 'org-1', owner: { member_id: 'owner-9' } };

  const r = await sendOwnerReauthDm(orgConfig, { connectionId: 'conn-r', provider: 'github' }, { post });

  assert.equal(r.sent, true);
  assert.equal(r.conversationId, 'cv-owner-1');
  assert.equal(calls.length, 2, 'must make exactly two calls: create_dm then send');
  // 1) create the owner DM with peer_member_id (no org_id/caller — JWT-derived)
  assert.equal(calls[0].path, '/api/v1/conversations/dm');
  assert.equal(calls[0].body.peer_member_id, 'owner-9');
  // 2) send the message into the resolved conversation
  assert.equal(calls[1].path, '/api/v1/conversations/cv-owner-1/messages');
  assert.ok(calls[1].body.content.body.text.includes('github'), 'message must name the app');
  assert.ok(calls[1].body.content.body.text.includes('重新授权'), 'message must prompt re-authorization');
});

test('sendOwnerReauthDm: no owner bound → no DM sent, no HTTP calls', async () => {
  const calls = [];
  const post = async (...a) => { calls.push(a); return {}; };
  const r = await sendOwnerReauthDm({ slug: 'acme', org_id: 'org-1', owner: {} }, { connectionId: 'conn-r' }, { post });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no-owner');
  assert.equal(calls.length, 0, 'no owner → must not touch the network');
});

// -----------------------------------------------------------------------------
// Route A MCP sink: an MCP connection (connector_kind="mcp", direct mode) is
// materialized into a local Claude Code MCP server via the injected command
// runner (mcpExecFile). The Acquire response is authoritative for connector_kind
// + mcp_server; teardown events (revoke/disconnect/reauth), which do NOT carry
// connector_kind, recognize MCP from the additively-threaded index entry.
// -----------------------------------------------------------------------------

// A recording MCP command runner (injected as mcpExecFile). Mirrors the
// promisified execFile shape; captures every `claude mcp ...` argv.
function recordingMcpExec() {
  const calls = [];
  return {
    calls,
    exec: async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: '' }; },
    // The unified install path is `claude mcp add-json <name> <json>`.
    addArgs: () => calls.find((c) => c.args[0] === 'mcp' && c.args[1] === 'add-json')?.args,
    removeArgs: () => calls.find((c) => c.args[0] === 'mcp' && c.args[1] === 'remove')?.args,
    // Parse the JSON payload of the add-json call (last argv element).
    addJson: () => {
      const a = calls.find((c) => c.args[0] === 'mcp' && c.args[1] === 'add-json')?.args;
      return a ? JSON.parse(a[a.length - 1]) : null;
    },
  };
}

// An acquire (post) double that returns an MCP direct-mode credential.
function mcpHttp() {
  const calls = [];
  return {
    calls,
    get: async (orgId, urlPath) => { calls.push({ method: 'GET', path: urlPath }); return { connections: [] }; },
    post: async (orgId, urlPath) => {
      calls.push({ method: 'POST', path: urlPath });
      return {
        credential_mode: 'direct',
        connector_kind: 'mcp',
        access_token: 'mcp-tok',
        token_type: 'bearer',
        mcp_server: { transport: 'remote_http', server_url: 'https://mcp.linear.app/rpc' },
      };
    },
  };
}

test('connection.authorized (MCP): acquires + materializes a local MCP server via the injected runner', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { get, post } = mcpHttp();
  const mcp = recordingMcpExec();

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-mcp-1', provider: 'linear', credential_mode: 'direct', connector_kind: 'mcp',
  } } };
  await handleConnectionEvent(baseOrgConfig, frame, {
    get, post, connectDir, credentialsDir, catalogDir, mcpExecFile: mcp.exec, mcpCwd: '/home/agent/zylos',
  });

  const add = mcp.addArgs();
  assert.ok(add, `MCP sink must run 'claude mcp add-json': ${JSON.stringify(mcp.calls.map((c) => c.args))}`);
  assert.deepEqual(add.slice(0, 5), ['mcp', 'add-json', '-s', 'local', 'openmax-linear-conn-mcp-1']);
  assert.deepEqual(mcp.addJson(), {
    type: 'http', url: 'https://mcp.linear.app/rpc', headers: { Authorization: 'Bearer mcp-tok' },
  });
  // cwd forced to the agent launch dir (not the comm-bridge service cwd)
  assert.equal(mcp.calls.find((c) => c.args[1] === 'add-json').opts.cwd, '/home/agent/zylos');
});

test('connection.authorized (non-MCP direct): must NOT materialize any MCP server', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { get, post } = recordingHttp(); // returns credential_mode:direct, no connector_kind
  const mcp = recordingMcpExec();

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-http-1', provider: 'github', credential_mode: 'direct',
  } } };
  await handleConnectionEvent(baseOrgConfig, frame, {
    get, post, connectDir, credentialsDir, catalogDir, mcpExecFile: mcp.exec,
  });
  assert.equal(mcp.calls.length, 0, 'a plain HTTP direct connection must never touch the MCP sink');
});

test('connection.credential_updated (MCP): re-acquires and refreshes the MCP server (new token)', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  // Pre-seed a cache file so the credential_updated direct-detector fires.
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.writeFileSync(path.join(credentialsDir, 'conn-mcp-2.json'), JSON.stringify({ credential_mode: 'direct', access_token: 'old' }));

  const post = async () => ({
    credential_mode: 'direct', connector_kind: 'mcp', access_token: 'mcp-tok-new', token_type: 'bearer',
    mcp_server: { transport: 'remote_http', server_url: 'https://mcp.linear.app/rpc' },
  });
  const get = async () => { throw new Error('credential_updated must not call GET'); };
  const mcp = recordingMcpExec();

  const frame = { payload: { event: 'connection.credential_updated', data: { connection_id: 'conn-mcp-2', provider: 'linear' } } };
  await handleConnectionEvent(baseOrgConfig, frame, {
    get, post, connectDir, credentialsDir, catalogDir, mcpExecFile: mcp.exec, mcpCwd: '/w',
  });

  const add = mcp.addArgs();
  assert.ok(add, 'credential_updated on an MCP connection must re-materialize the server');
  assert.equal(mcp.addJson().headers.Authorization, 'Bearer mcp-tok-new', `refreshed server must carry the new token: ${JSON.stringify(add)}`);
});

test('[Problem ①] connection.authorized (MCP stdio): injects the token into the add-json env (not an empty env)', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  // Acquire returns a stdio MCP connector with an env:<KEY> auth-injection binding.
  const post = async () => ({
    credential_mode: 'direct', connector_kind: 'mcp', access_token: 'ghp_live_token',
    auth_injection: 'env:GITHUB_PERSONAL_ACCESS_TOKEN',
    mcp_server: { transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'], env: {} },
  });
  const get = async () => ({ connections: [] });
  const mcp = recordingMcpExec();

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-gh-1', provider: 'github', credential_mode: 'direct', connector_kind: 'mcp',
  } } };
  await handleConnectionEvent(baseOrgConfig, frame, {
    get, post, connectDir, credentialsDir, catalogDir, mcpExecFile: mcp.exec, mcpCwd: '/w',
  });

  const json = mcp.addJson();
  assert.ok(json, 'stdio MCP connection must run add-json');
  assert.equal(json.type, 'stdio');
  assert.equal(json.command, 'docker');
  assert.equal(json.env.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_live_token',
    'the stdio server must launch WITH its token in env (Problem ①)');
});

for (const event of ['connection.revoked', 'connection.disconnected']) {
  test(`${event} (MCP): tears down the local MCP server (recognized from the index)`, async () => {
    const { connectDir, credentialsDir, catalogDir } = tmpDirs();
    // Pre-seed the index with an MCP connection (the teardown event does not carry
    // connector_kind — the index entry is the only local signal).
    const idxPath = indexPathForOrg('org-1', connectDir);
    upsertConnection({ connection_id: 'conn-mcp-3', application_slug: 'linear', connector_kind: 'mcp', credential_mode: 'direct', status: 'active' }, idxPath);
    const { get, post } = recordingHttp();
    const mcp = recordingMcpExec();

    const frame = { payload: { event, data: { connection_id: 'conn-mcp-3', provider: 'linear' } } };
    await handleConnectionEvent(baseOrgConfig, frame, {
      get, post, connectDir, credentialsDir, catalogDir, mcpExecFile: mcp.exec, mcpCwd: '/w',
    });

    assert.deepEqual(mcp.removeArgs(), ['mcp', 'remove', '-s', 'local', 'openmax-linear-conn-mcp-3']);
    // and the connection is dropped from the index as before
    assert.equal(readIndex(idxPath).connections['conn-mcp-3'], undefined);
  });
}

test('connection.revoked (non-MCP): must NOT call the MCP sink', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const idxPath = indexPathForOrg('org-1', connectDir);
  upsertConnection({ connection_id: 'conn-http-3', application_slug: 'github', connector_kind: 'http', credential_mode: 'direct', status: 'active' }, idxPath);
  const { get, post } = recordingHttp();
  const mcp = recordingMcpExec();

  const frame = { payload: { event: 'connection.revoked', data: { connection_id: 'conn-http-3', provider: 'github' } } };
  await handleConnectionEvent(baseOrgConfig, frame, {
    get, post, connectDir, credentialsDir, catalogDir, mcpExecFile: mcp.exec,
  });
  assert.equal(mcp.calls.length, 0, 'a non-MCP revoke must never touch the MCP sink');
});

test('connection.reauth_needed (MCP): removes the MCP server but keeps the connection indexed (needs_reauth)', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const idxPath = indexPathForOrg('org-1', connectDir);
  upsertConnection({ connection_id: 'conn-mcp-4', application_slug: 'linear', connector_kind: 'mcp', credential_mode: 'direct', status: 'active' }, idxPath);
  const { get, post } = recordingHttp();
  const mcp = recordingMcpExec();

  const frame = { payload: { event: 'connection.reauth_needed', data: { connection_id: 'conn-mcp-4', provider: 'linear', trigger: 'provider_401' } } };
  await handleConnectionEvent(baseOrgConfig, frame, {
    get, post, connectDir, credentialsDir, catalogDir, mcpExecFile: mcp.exec, mcpCwd: '/w',
  });

  assert.deepEqual(mcp.removeArgs(), ['mcp', 'remove', '-s', 'local', 'openmax-linear-conn-mcp-4']);
  // still indexed, flagged needs_reauth (connectorKind preserved additively)
  const entry = readIndex(idxPath).connections['conn-mcp-4'];
  assert.equal(entry.status, 'needs_reauth');
  assert.equal(entry.connectorKind, 'mcp');
});

test('P1-2 (regression): sparse authorize + list refresh WITHOUT connector_kind — the Acquire connector_kind:mcp is persisted, so a later revoke removes the server', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const idxPath = indexPathForOrg('org-1', connectDir);

  // Acquire (post) is authoritative: connector_kind mcp + a structured mcp_server.
  const post = async () => ({
    credential_mode: 'direct', connector_kind: 'mcp', access_token: 'mcp-tok', token_type: 'bearer',
    mcp_server: { transport: 'remote_http', server_url: 'https://mcp.linear.app/rpc' },
  });
  // The agent-connections list refresh returns the connection but WITHOUT
  // connector_kind (the exact gap zylos0t flagged): warmIdentityAndCatalog
  // rebuilds the index from it wholesale, leaving connectorKind null unless the
  // Acquire value is re-persisted afterward. The actions endpoint returns [].
  const get = async (orgId, urlPath) => {
    if (urlPath.endsWith('/connections')) {
      return { connections: [{ id: 'conn-mcp-6', application_id: 'app-1', application_slug: 'linear', credential_mode: 'direct', status: 'active' }] };
    }
    return []; // actions
  };
  const mcp = recordingMcpExec();

  // authorize event carries NO connector_kind either.
  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-mcp-6', provider: 'linear', credential_mode: 'direct',
  } } };
  await handleConnectionEvent(baseOrgConfig, frame, {
    get, post, connectDir, credentialsDir, catalogDir, mcpExecFile: mcp.exec, mcpCwd: '/w',
  });

  // (a) despite neither the event nor the list carrying it, the index entry ends
  // up connectorKind:'mcp' (persisted from the authoritative Acquire response).
  assert.equal(readIndex(idxPath).connections['conn-mcp-6'].connectorKind, 'mcp',
    'Acquire-derived connector_kind must be persisted into the index post-refresh');
  assert.ok(mcp.addArgs(), 'authorize must have materialized the MCP server');

  // (b) a subsequent revoke reads ONLY the index, recognizes it as MCP, and
  // removes the local server — the orphaned-server bug is gone.
  const mcp2 = recordingMcpExec();
  const rframe = { payload: { event: 'connection.revoked', data: { connection_id: 'conn-mcp-6', provider: 'linear' } } };
  await handleConnectionEvent(baseOrgConfig, rframe, {
    get, post, connectDir, credentialsDir, catalogDir, mcpExecFile: mcp2.exec, mcpCwd: '/w',
  });
  assert.deepEqual(mcp2.removeArgs(), ['mcp', 'remove', '-s', 'local', 'openmax-linear-conn-mcp-6']);
});

test('MCP sink is best-effort: a throwing command runner never breaks the handler (authorize still caches the credential)', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { get, post } = mcpHttp();
  const mcpExecFile = async () => { throw new Error('claude CLI missing'); };

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-mcp-5', provider: 'linear', credential_mode: 'direct', connector_kind: 'mcp',
  } } };
  // Must resolve, not reject, despite the runner throwing.
  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir, mcpExecFile });
  // The credential path is unaffected — the direct credential is still cached.
  assert.ok(fs.existsSync(path.join(credentialsDir, 'conn-mcp-5.json')), 'a sink failure must not break credential caching');
});

test('connection.authorized notify is best-effort: a throwing notify never breaks the handler', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { get, post } = recordingHttp();
  const notify = () => { throw new Error('boom'); };

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-10', provider: 'gmail', credential_mode: 'proxy',
  } } };
  // Must resolve, not reject, despite the notify throwing.
  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir, notify });
});
