import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentLaunchCwd,
  isMcpConnection,
  mcpServerName,
  transportFlag,
  buildAuthHeader,
  buildHeaderArgs,
  upsertMcpServer,
  removeMcpServer,
} from './mcp-config.js';

// A recording execFile double: captures every ['claude', [args], opts] call and
// returns a resolved stub (the CLI prints nothing we consume). Matches the
// promisified execFile shape used across the repo (channel-connector.js etc).
function recordingExec() {
  const calls = [];
  const execFile = async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: '' }; };
  return { calls, execFile };
}

// Pull the `add` call's argv (the second `claude` call — the first is the
// remove-then-add cleanup).
function addCall(calls) {
  return calls.find((c) => c.args[0] === 'mcp' && c.args[1] === 'add');
}
function removeCall(calls) {
  return calls.find((c) => c.args[0] === 'mcp' && c.args[1] === 'remove');
}

// --- agentLaunchCwd ---------------------------------------------------------

test('agentLaunchCwd 优先 ZYLOS_DIR，否则回退 ~/zylos（不是 process.cwd）', () => {
  const savedZ = process.env.ZYLOS_DIR;
  const savedH = process.env.HOME;
  try {
    process.env.ZYLOS_DIR = '/some/agent/dir';
    assert.equal(agentLaunchCwd(), '/some/agent/dir');
    delete process.env.ZYLOS_DIR;
    process.env.HOME = '/home/tester';
    assert.equal(agentLaunchCwd(), '/home/tester/zylos');
  } finally {
    if (savedZ === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = savedZ;
    process.env.HOME = savedH;
  }
});

// --- isMcpConnection --------------------------------------------------------

test('isMcpConnection 识别 connector_kind 与 connectorKind 两种写法', () => {
  assert.equal(isMcpConnection({ connector_kind: 'mcp' }), true);   // acquire response
  assert.equal(isMcpConnection({ connectorKind: 'mcp' }), true);    // index entry
  assert.equal(isMcpConnection({ connector_kind: 'http' }), false);
  assert.equal(isMcpConnection({}), false);
  assert.equal(isMcpConnection(null), false);
  assert.equal(isMcpConnection(undefined), false);
});

// --- mcpServerName ----------------------------------------------------------

test('mcpServerName 内嵌 connection_id 防同 app 撞名', () => {
  const a = mcpServerName('linear', 'conn-1');
  const b = mcpServerName('linear', 'conn-2');
  assert.equal(a, 'openmax-linear-conn-1');
  assert.notEqual(a, b, '同一 app 的两条连接必须得到不同的 server 名');
});

test('mcpServerName 清洗非法字符、缺 slug 回退 mcp', () => {
  assert.equal(mcpServerName('My App!', 'abc'), 'openmax-My-App--abc');
  assert.equal(mcpServerName(null, 'abc'), 'openmax-mcp-abc');
  assert.equal(mcpServerName('', 'abc'), 'openmax-mcp-abc');
});

// --- transportFlag ----------------------------------------------------------

test('transportFlag: remote_http→http, sse→sse, 未知/stdio→http', () => {
  assert.equal(transportFlag('remote_http'), 'http');
  assert.equal(transportFlag('http'), 'http');
  assert.equal(transportFlag(''), 'http');
  assert.equal(transportFlag('sse'), 'sse');
  assert.equal(transportFlag('stdio'), 'http');
  assert.equal(transportFlag(undefined), 'http');
});

// --- buildAuthHeader --------------------------------------------------------

test('buildAuthHeader: 遵循 auth_injection 自定义头（非硬编 Bearer），展开 {token}', () => {
  const h = buildAuthHeader({
    accessToken: 'shpat_xxx',
    tokenType: 'api_key',
    authInjection: { location: 'header', name: 'X-Shopify-Access-Token', value_template: '{token}' },
  });
  assert.deepEqual(h, { name: 'X-Shopify-Access-Token', value: 'shpat_xxx' });
});

test('buildAuthHeader: value_template 带方案前缀（如 SSWS {token}）原样拼', () => {
  const h = buildAuthHeader({
    accessToken: 'T', tokenType: 'api_key',
    authInjection: { location: 'header', name: 'Authorization', value_template: 'SSWS {token}' },
  });
  assert.deepEqual(h, { name: 'Authorization', value: 'SSWS T' });
});

test('buildAuthHeader: query 型注入不返回头（调用方改拼到 URL）', () => {
  const h = buildAuthHeader({
    accessToken: 'T', authInjection: { location: 'query', name: 'access_token', value_template: '{token}' },
  });
  assert.equal(h, null);
});

test('buildAuthHeader: 无 auth_injection + 有 token → 默认 Authorization（scheme 由 token_type 决定，非硬编 Bearer）', () => {
  assert.deepEqual(
    buildAuthHeader({ accessToken: 'T', tokenType: 'bearer' }),
    { name: 'Authorization', value: 'Bearer T' },
  );
  // token_type=api_key 规范化为 Bearer（复用 direct-exec canonicalAuthScheme）
  assert.deepEqual(
    buildAuthHeader({ accessToken: 'T', tokenType: 'api_key' }),
    { name: 'Authorization', value: 'Bearer T' },
  );
  // 非常规 scheme 原样透传
  assert.deepEqual(
    buildAuthHeader({ accessToken: 'T', tokenType: 'Token' }),
    { name: 'Authorization', value: 'Token T' },
  );
});

test('buildAuthHeader: auth_type=none / 无 token → 不注入任何头', () => {
  assert.equal(buildAuthHeader({}), null);
  assert.equal(buildAuthHeader({ accessToken: '' }), null);
});

// --- buildHeaderArgs --------------------------------------------------------

test('buildHeaderArgs: 非密 headers_template 与 auth 头合并，同名头 auth 胜（大小写不敏感）', () => {
  const args = buildHeaderArgs(
    { headers_template: { 'X-Tenant': 'acme', 'x-api-key': 'SHOULD-LOSE' } },
    { name: 'X-API-Key', value: 'WINS' },
  );
  // -H flags come in pairs
  const flags = args.filter((_, i) => i % 2 === 0);
  const vals = args.filter((_, i) => i % 2 === 1);
  assert.ok(flags.every((f) => f === '-H'));
  assert.ok(vals.includes('X-Tenant: acme'), 'non-secret template header preserved');
  assert.ok(vals.includes('X-API-Key: WINS'), 'auth header injected under its own name');
  assert.ok(!vals.some((v) => v.includes('SHOULD-LOSE')), 'same-name template header dropped (auth wins)');
});

test('buildHeaderArgs: headers_template 可为 JSON 字符串（容错），无 auth 头时也可', () => {
  const args = buildHeaderArgs({ headers_template: '{"X-Env":"prod"}' }, null);
  assert.deepEqual(args, ['-H', 'X-Env: prod']);
});

test('buildHeaderArgs: 空 headers_template + 无 auth → 空数组', () => {
  assert.deepEqual(buildHeaderArgs({}, null), []);
  assert.deepEqual(buildHeaderArgs(null, null), []);
});

// --- upsertMcpServer --------------------------------------------------------

test('upsertMcpServer: 组装 claude mcp add -s local -t http，先 remove 再 add，注入 execFile+cwd', async () => {
  const { calls, execFile } = recordingExec();
  const res = await upsertMcpServer(
    { id: 'conn-1', slug: 'linear' },
    {
      connector_kind: 'mcp',
      access_token: 'tok-123',
      token_type: 'bearer',
      mcp_server: { transport: 'remote_http', server_url: 'https://mcp.linear.app/rpc' },
    },
    { execFile, cwd: '/home/agent/zylos' },
  );
  assert.deepEqual(res, { ok: true, name: 'openmax-linear-conn-1' });

  // remove precedes add (clean refresh)
  assert.equal(calls[0].args[1], 'remove');
  assert.equal(calls[1].args[1], 'add');

  const add = addCall(calls);
  assert.deepEqual(
    add.args,
    ['mcp', 'add', '-s', 'local', '-t', 'http', 'openmax-linear-conn-1', 'https://mcp.linear.app/rpc',
      '-H', 'Authorization: Bearer tok-123'],
  );
  // cwd forced to the agent launch dir (NOT the service cwd)
  assert.equal(add.opts.cwd, '/home/agent/zylos');
  assert.equal(removeCall(calls).opts.cwd, '/home/agent/zylos');
});

test('upsertMcpServer: 含密钥自定义头走 auth_injection（绝不硬编 Bearer）', async () => {
  const { calls, execFile } = recordingExec();
  await upsertMcpServer(
    { id: 'c9', slug: 'shopify' },
    {
      connector_kind: 'mcp',
      access_token: 'shpat_secret',
      token_type: 'api_key',
      auth_injection: { location: 'header', name: 'X-Shopify-Access-Token', value_template: '{token}' },
      mcp_server: { transport: 'remote_http', server_url: 'https://x.myshopify.com/mcp' },
    },
    { execFile, cwd: '/w' },
  );
  const add = addCall(calls);
  assert.ok(add.args.includes('-H'));
  assert.ok(add.args.includes('X-Shopify-Access-Token: shpat_secret'), `custom auth header expected: ${JSON.stringify(add.args)}`);
  assert.ok(!add.args.some((a) => /Authorization: Bearer/.test(a)), 'must NOT fall back to a hardcoded Bearer header');
});

test('upsertMcpServer: query 型 auth_injection 拼进 URL（头不表达）', async () => {
  const { calls, execFile } = recordingExec();
  await upsertMcpServer(
    { id: 'cq', slug: 'demo' },
    {
      connector_kind: 'mcp',
      access_token: 'qtok',
      auth_injection: { location: 'query', name: 'access_token', value_template: '{token}' },
      mcp_server: { transport: 'remote_http', server_url: 'https://demo.example/mcp' },
    },
    { execFile, cwd: '/w' },
  );
  const add = addCall(calls);
  const url = add.args[7];
  assert.equal(url, 'https://demo.example/mcp?access_token=qtok');
  assert.ok(!add.args.includes('-H'), 'query auth must not also produce a header');
});

test('upsertMcpServer: 非密 headers_template 一并下发', async () => {
  const { calls, execFile } = recordingExec();
  await upsertMcpServer(
    { id: 'ch', slug: 'demo' },
    {
      connector_kind: 'mcp',
      access_token: 'T',
      token_type: 'bearer',
      mcp_server: { transport: 'remote_http', server_url: 'https://d/mcp', headers_template: { 'X-Tenant': 'acme' } },
    },
    { execFile, cwd: '/w' },
  );
  const add = addCall(calls);
  assert.ok(add.args.includes('X-Tenant: acme'));
  assert.ok(add.args.includes('Authorization: Bearer T'));
});

test('upsertMcpServer: 无 mcp_server.server_url → {ok:false}，不调用 CLI', async () => {
  const { calls, execFile } = recordingExec();
  const res = await upsertMcpServer({ id: 'c1', slug: 'x' }, { connector_kind: 'mcp' }, { execFile, cwd: '/w' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-mcp-server');
  assert.equal(calls.length, 0, 'no CLI invocation when there is no server config');
});

test('upsertMcpServer: best-effort — add 抛错不外抛，返回 {ok:false}', async () => {
  let n = 0;
  const execFile = async (file, args) => {
    n += 1;
    if (args[1] === 'add') throw new Error('claude add failed');
    return { stdout: '' }; // remove succeeds
  };
  const res = await upsertMcpServer(
    { id: 'c1', slug: 'x' },
    { connector_kind: 'mcp', access_token: 'T', mcp_server: { transport: 'remote_http', server_url: 'https://x/mcp' } },
    { execFile, cwd: '/w' },
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /add failed/);
});

// --- removeMcpServer --------------------------------------------------------

test('removeMcpServer: 组装 claude mcp remove -s local <name>，注入 execFile+cwd', async () => {
  const { calls, execFile } = recordingExec();
  const res = await removeMcpServer({ id: 'conn-7', slug: 'linear' }, { execFile, cwd: '/home/agent/zylos' });
  assert.deepEqual(res, { ok: true, name: 'openmax-linear-conn-7' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['mcp', 'remove', '-s', 'local', 'openmax-linear-conn-7']);
  assert.equal(calls[0].opts.cwd, '/home/agent/zylos');
});

test('removeMcpServer: best-effort — 抛错（如 server 不存在）不外抛', async () => {
  const execFile = async () => { throw new Error('No such server'); };
  const res = await removeMcpServer({ id: 'c1', slug: 'x' }, { execFile, cwd: '/w' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /No such server/);
});

// --- P1-1: token must never leak via the exec FAILURE path -------------------

test('P1-1 upsertMcpServer: 失败(带 exit code)绝不把 token 漏进 reason/日志（仅 exit code）', async () => {
  const TOKEN = 'super-secret-tok-abc123';
  const warns = [];
  // Mirror a real promisified execFile rejection: .message/.cmd carry the FULL
  // argv (incl. -H "Authorization: Bearer <token>"), .stderr may carry it too.
  const execFile = async (file, args) => {
    if (args[1] === 'add') {
      const e = new Error(`Command failed: claude ${args.join(' ')}`);
      e.code = 1;
      e.cmd = `claude ${args.join(' ')}`;
      e.stderr = `handshake failed ${TOKEN}`;
      throw e;
    }
    return { stdout: '' }; // remove succeeds
  };
  const res = await upsertMcpServer(
    { id: 'c1', slug: 'linear' },
    { connector_kind: 'mcp', access_token: TOKEN, token_type: 'bearer',
      mcp_server: { transport: 'remote_http', server_url: 'https://mcp/rpc' } },
    { execFile, cwd: '/w', warn: (m) => warns.push(m) },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'claude mcp add failed (exit 1)', 'reason must be exit-code-only');
  assert.ok(!res.reason.includes(TOKEN), `reason leaked the token: ${res.reason}`);
  assert.ok(warns.length > 0 && warns.every((l) => !l.includes(TOKEN)), 'warn log leaked the token');
});

test('P1-1 upsertMcpServer: 失败(无 exit code)回退到脱敏消息，token 被 *** 替换', async () => {
  const TOKEN = 'tok-xyz-77';
  const execFile = async (file, args) => {
    if (args[1] === 'add') throw new Error(`spawn error: claude ${args.join(' ')}`); // no .code
    return { stdout: '' };
  };
  const res = await upsertMcpServer(
    { id: 'c1', slug: 'linear' },
    { connector_kind: 'mcp', access_token: TOKEN,
      mcp_server: { transport: 'remote_http', server_url: 'https://mcp/rpc' } },
    { execFile, cwd: '/w' },
  );
  assert.equal(res.ok, false);
  assert.ok(!res.reason.includes(TOKEN), `reason leaked the token: ${res.reason}`);
  assert.ok(res.reason.includes('***'), `expected redaction marker in: ${res.reason}`);
});

test('P1-1 upsertMcpServer: query 型 auth 失败也不漏 URL 里的 token', async () => {
  const TOKEN = 'qtok-9';
  const execFile = async (file, args) => {
    if (args[1] === 'add') throw new Error(`failed running: claude ${args.join(' ')}`); // no .code → fallback
    return { stdout: '' };
  };
  const res = await upsertMcpServer(
    { id: 'cq', slug: 'demo' },
    { connector_kind: 'mcp', access_token: TOKEN,
      auth_injection: { location: 'query', name: 'access_token', value_template: '{token}' },
      mcp_server: { transport: 'remote_http', server_url: 'https://demo/mcp' } },
    { execFile, cwd: '/w' },
  );
  assert.equal(res.ok, false);
  assert.ok(!res.reason.includes(TOKEN), `reason leaked the query token: ${res.reason}`);
});

test('P1-R2 upsertMcpServer: query 型 auth 无 exit code 回退时，raw 与 URL 编码后的 token 都不泄露', async () => {
  // zylos0t R2 repro: a token with URL-special chars, query-location auth, and a
  // non-exec error (no .code) → the fallback returns the redacted e.message. The
  // URL carries encodeURIComponent(token), so BOTH forms must be scrubbed.
  const TOKEN = 'tok/a+b=';
  const ENCODED = encodeURIComponent(TOKEN); // "tok%2Fa%2Bb%3D"
  const warns = [];
  const execFile = async (file, args) => {
    if (args[1] === 'add') throw new Error(`failed running: claude ${args.join(' ')}`); // no .code → fallback
    return { stdout: '' };
  };
  const res = await upsertMcpServer(
    { id: 'cq', slug: 'demo' },
    { connector_kind: 'mcp', access_token: TOKEN,
      auth_injection: { location: 'query', name: 'access_token', value_template: '{token}' },
      mcp_server: { transport: 'remote_http', server_url: 'https://demo/mcp' } },
    { execFile, cwd: '/w', warn: (m) => warns.push(m) },
  );
  assert.equal(res.ok, false);
  // Neither the raw token nor its URL-encoded form may appear in the reason…
  assert.ok(!res.reason.includes(TOKEN), `reason leaked the raw token: ${res.reason}`);
  assert.ok(!res.reason.includes(ENCODED), `reason leaked the URL-encoded token: ${res.reason}`);
  // …nor in the warn log.
  assert.ok(warns.length > 0, 'expected a warn log');
  assert.ok(warns.every((l) => !l.includes(TOKEN) && !l.includes(ENCODED)), `warn log leaked the token: ${warns.join(' | ')}`);
});
