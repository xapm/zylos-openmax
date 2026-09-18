import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentLaunchCwd,
  isMcpConnection,
  mcpServerName,
  transportFlag,
  isStdioConfig,
  parseArgs,
  normalizeAuthInjection,
  resolveInjection,
  buildAuthHeader,
  buildMcpServerJson,
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

// The unified install path is `claude mcp add-json <name> <json>`; the first
// `claude` call is the remove-then-add cleanup.
function addCall(calls) {
  return calls.find((c) => c.args[0] === 'mcp' && c.args[1] === 'add-json');
}
function removeCall(calls) {
  return calls.find((c) => c.args[0] === 'mcp' && c.args[1] === 'remove');
}
// The JSON is the last argv element of an add-json call: parse it back.
function addJson(calls) {
  const add = addCall(calls);
  return add ? JSON.parse(add.args[add.args.length - 1]) : null;
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

test('transportFlag: remote_http→http, sse→sse, stdio→stdio, 未知→http', () => {
  assert.equal(transportFlag('remote_http'), 'http');
  assert.equal(transportFlag('http'), 'http');
  assert.equal(transportFlag(''), 'http');
  assert.equal(transportFlag('sse'), 'sse');
  assert.equal(transportFlag('stdio'), 'stdio');
  assert.equal(transportFlag('weird'), 'http');
  assert.equal(transportFlag(undefined), 'http');
});

// --- normalizeAuthInjection -------------------------------------------------

test('normalizeAuthInjection: 结构化对象 {location,name,value_template}', () => {
  assert.deepEqual(
    normalizeAuthInjection({ location: 'header', name: 'Authorization', value_template: 'SSWS {token}' }),
    { location: 'header', name: 'Authorization', valueTemplate: 'SSWS {token}' },
  );
  // 缺 value_template 默认 {token}；缺 location 默认 header
  assert.deepEqual(
    normalizeAuthInjection({ name: 'X-Api-Key' }),
    { location: 'header', name: 'X-Api-Key', valueTemplate: '{token}' },
  );
});

test('normalizeAuthInjection: 字符串绑定形式 env:KEY / header:Name(Scheme) / query:name', () => {
  assert.deepEqual(
    normalizeAuthInjection('env:GITHUB_PERSONAL_ACCESS_TOKEN'),
    { location: 'env', name: 'GITHUB_PERSONAL_ACCESS_TOKEN', valueTemplate: '{token}' },
  );
  assert.deepEqual(
    normalizeAuthInjection('header:Authorization(Bearer)'),
    { location: 'header', name: 'Authorization', valueTemplate: 'Bearer {token}' },
  );
  assert.deepEqual(
    normalizeAuthInjection('query:access_token'),
    { location: 'query', name: 'access_token', valueTemplate: '{token}' },
  );
  assert.equal(normalizeAuthInjection('nonsense'), null);
  assert.equal(normalizeAuthInjection(null), null);
});

// --- resolveInjection -------------------------------------------------------

test('resolveInjection: env 绑定 → {location:env,name,value}（展开 {token}）', () => {
  assert.deepEqual(
    resolveInjection({ accessToken: 'ghp_x', authInjection: 'env:GITHUB_TOKEN' }),
    { location: 'env', name: 'GITHUB_TOKEN', value: 'ghp_x' },
  );
});

test('resolveInjection: 无描述符 + 有 token → 默认 Authorization 头（scheme 由 token_type 决定）', () => {
  assert.deepEqual(
    resolveInjection({ accessToken: 'T', tokenType: 'bearer' }),
    { location: 'header', name: 'Authorization', value: 'Bearer T' },
  );
});

test('resolveInjection: 无 token 且无描述符 → null（auth_type none）', () => {
  assert.equal(resolveInjection({}), null);
  assert.equal(resolveInjection({ accessToken: '' }), null);
});

// --- buildAuthHeader (header-only view over resolveInjection) ---------------

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

test('buildAuthHeader: query / env 型注入不返回头（调用方改拼 URL / env）', () => {
  assert.equal(buildAuthHeader({ accessToken: 'T', authInjection: { location: 'query', name: 'access_token' } }), null);
  assert.equal(buildAuthHeader({ accessToken: 'T', authInjection: 'env:API_KEY' }), null);
});

test('buildAuthHeader: 无 auth_injection + 有 token → 默认 Authorization（scheme 由 token_type，非硬编 Bearer）', () => {
  assert.deepEqual(buildAuthHeader({ accessToken: 'T', tokenType: 'bearer' }), { name: 'Authorization', value: 'Bearer T' });
  // token_type=api_key 规范化为 Bearer（复用 direct-exec canonicalAuthScheme）
  assert.deepEqual(buildAuthHeader({ accessToken: 'T', tokenType: 'api_key' }), { name: 'Authorization', value: 'Bearer T' });
  // 非常规 scheme 原样透传
  assert.deepEqual(buildAuthHeader({ accessToken: 'T', tokenType: 'Token' }), { name: 'Authorization', value: 'Token T' });
});

test('buildAuthHeader: auth_type=none / 无 token → 不注入任何头', () => {
  assert.equal(buildAuthHeader({}), null);
  assert.equal(buildAuthHeader({ accessToken: '' }), null);
});

// --- buildMcpServerJson (the unified add-json payload) -----------------------

test('buildMcpServerJson (http): 从离散字段组装，token 合并进 headers（默认 Authorization）', () => {
  const json = buildMcpServerJson(
    { transport: 'remote_http', server_url: 'https://mcp.linear.app/rpc' },
    { accessToken: 'tok-123', tokenType: 'bearer' },
  );
  assert.deepEqual(json, { type: 'http', url: 'https://mcp.linear.app/rpc', headers: { Authorization: 'Bearer tok-123' } });
});

test('buildMcpServerJson (http): 非密 headers_template 与 auth 头合并，同名 auth 胜（大小写不敏感）', () => {
  const json = buildMcpServerJson(
    { transport: 'remote_http', server_url: 'https://d/mcp', headers_template: { 'X-Tenant': 'acme', authorization: 'SHOULD-LOSE' } },
    { accessToken: 'T', tokenType: 'bearer' },
  );
  assert.equal(json.headers['X-Tenant'], 'acme');
  assert.equal(json.headers.Authorization, 'Bearer T');
  assert.ok(!('authorization' in json.headers), '同名（小写）模板头应被 auth 覆盖删除');
});

test('buildMcpServerJson (http): query 型 auth 拼进 URL，不产生 headers', () => {
  const json = buildMcpServerJson(
    { transport: 'remote_http', server_url: 'https://demo.example/mcp' },
    { accessToken: 'qtok', authInjection: { location: 'query', name: 'access_token', value_template: '{token}' } },
  );
  assert.equal(json.url, 'https://demo.example/mcp?access_token=qtok');
  assert.ok(!('headers' in json), 'query 注入不应产生 headers');
});

test('buildMcpServerJson (stdio): 从离散字段组装 type/command/args，无 env 时不产生 env 键', () => {
  const json = buildMcpServerJson(
    { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
    {},
  );
  assert.deepEqual(json, { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] });
});

test('[Problem ①] buildMcpServerJson (stdio): token 经 env:KEY 绑定注入 env（此前缺失的关键修复）', () => {
  const json = buildMcpServerJson(
    { transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'], env: {} },
    { accessToken: 'ghp_secret', authInjection: 'env:GITHUB_PERSONAL_ACCESS_TOKEN' },
  );
  assert.equal(json.env.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_secret', 'stdio env 必须带上真实 token');
  // 结构化 env-location 绑定同样有效
  const json2 = buildMcpServerJson(
    { transport: 'stdio', command: 'x' },
    { accessToken: 'tok2', authInjection: { location: 'env', name: 'API_KEY', value_template: '{token}' } },
  );
  assert.equal(json2.env.API_KEY, 'tok2');
});

test('buildMcpServerJson (stdio): 非密 env（如小红书 env.phone）原样保留，不需 token', () => {
  const json = buildMcpServerJson(
    { transport: 'stdio', command: 'npx', args: ['xhs-mcp-server'], env: { phone: '13800000000' } },
    {},
  );
  assert.deepEqual(json.env, { phone: '13800000000' });
});

test('buildMcpServerJson: 优先使用 raw_config 模板，占位密钥被真实 token 覆盖，非密字段保留', () => {
  const json = buildMcpServerJson(
    { transport: 'stdio', command: 'SHOULD-NOT-USE' }, // discrete fields ignored when raw_config present
    {
      accessToken: 'ghp_real',
      authInjection: 'env:GITHUB_PERSONAL_ACCESS_TOKEN',
      rawConfig: { type: 'stdio', command: 'docker', args: ['run'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '<placeholder>', KEEP: 'me' } },
    },
  );
  assert.equal(json.command, 'docker', 'raw_config 优先于离散字段');
  assert.equal(json.env.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_real', '占位符应被真实 token 覆盖');
  assert.equal(json.env.KEEP, 'me', 'raw_config 的非密 env 应原样保留');
});

test('buildMcpServerJson: raw_config(http) 占位 Authorization 头被真实 token 覆盖，其余头保留', () => {
  const json = buildMcpServerJson(
    null,
    {
      accessToken: 'realtok', tokenType: 'bearer',
      rawConfig: { type: 'http', url: 'https://x/mcp', headers: { Authorization: '<token>', 'X-Tenant': 'acme' } },
    },
  );
  assert.equal(json.headers.Authorization, 'Bearer realtok');
  assert.equal(json.headers['X-Tenant'], 'acme');
});

test('buildMcpServerJson: raw_config 为 JSON 字符串也能解析', () => {
  const json = buildMcpServerJson(null, { rawConfig: '{"type":"stdio","command":"my-server","args":["--flag"]}' });
  assert.deepEqual(json, { type: 'stdio', command: 'my-server', args: ['--flag'] });
});

// --- upsertMcpServer (unified add-json) -------------------------------------

test('upsertMcpServer (http): 走 claude mcp add-json -s local <name> <json>，先 remove 再 add', async () => {
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

  // remove precedes add-json (clean refresh)
  assert.equal(calls[0].args[1], 'remove');
  assert.equal(calls[1].args[1], 'add-json');

  const add = addCall(calls);
  assert.deepEqual(add.args.slice(0, 5), ['mcp', 'add-json', '-s', 'local', 'openmax-linear-conn-1']);
  assert.deepEqual(addJson(calls), { type: 'http', url: 'https://mcp.linear.app/rpc', headers: { Authorization: 'Bearer tok-123' } });
  // cwd forced to the agent launch dir (NOT the service cwd)
  assert.equal(add.opts.cwd, '/home/agent/zylos');
  assert.equal(removeCall(calls).opts.cwd, '/home/agent/zylos');
  // add-json carries no -H flags (headers live inside the JSON)
  assert.ok(!add.args.includes('-H'));
});

test('upsertMcpServer (http): 含密钥自定义头走 auth_injection（绝不硬编 Bearer）', async () => {
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
  const json = addJson(calls);
  assert.equal(json.headers['X-Shopify-Access-Token'], 'shpat_secret');
  assert.ok(!('Authorization' in json.headers), 'must NOT fall back to a hardcoded Authorization header');
});

test('upsertMcpServer (http): query 型 auth 拼进 URL（头不表达）', async () => {
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
  const json = addJson(calls);
  assert.equal(json.url, 'https://demo.example/mcp?access_token=qtok');
  assert.ok(!('headers' in json));
});

test('[Problem ①] upsertMcpServer (stdio): token 注入 env 后再 add-json（github 不再空 env 启动）', async () => {
  const { calls, execFile } = recordingExec();
  const res = await upsertMcpServer(
    { id: 'conn-gh', slug: 'github' },
    {
      connector_kind: 'mcp',
      access_token: 'ghp_secret',
      auth_injection: 'env:GITHUB_PERSONAL_ACCESS_TOKEN',
      mcp_server: { transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'], env: {} },
    },
    { execFile, cwd: '/home/agent/zylos' },
  );
  assert.deepEqual(res, { ok: true, name: 'openmax-github-conn-gh' });
  assert.equal(calls[0].args[1], 'remove'); // remove precedes add-json
  const json = addJson(calls);
  assert.equal(json.type, 'stdio');
  assert.equal(json.command, 'docker');
  assert.equal(json.env.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_secret', 'stdio server 必须带 token 启动');
  const add = addCall(calls);
  assert.ok(!add.args.includes('-H') && !add.args.includes('-e'), 'add-json 不用 -H/-e 旗标，全在 JSON 内');
});

test('upsertMcpServer (stdio): 无 token 时 env 只含 raw_config 的非密字段（小红书 phone）', async () => {
  const { calls, execFile } = recordingExec();
  await upsertMcpServer(
    { id: 'conn-xhs', slug: 'xiaohongshu' },
    {
      connector_kind: 'mcp',
      raw_config: { type: 'stdio', command: 'npx', args: ['xhs-mcp-server'], env: { phone: '13800000000' } },
    },
    { execFile, cwd: '/w' },
  );
  const json = addJson(calls);
  assert.deepEqual(json.env, { phone: '13800000000' });
});

test('upsertMcpServer (stdio): args 为 JSON 字符串也能解析成数组', async () => {
  const { calls, execFile } = recordingExec();
  await upsertMcpServer(
    { id: 'conn-s2', slug: 'demo' },
    { connector_kind: 'mcp', mcp_server: { transport: 'stdio', command: 'my-server', args: '["--flag","v"]' } },
    { execFile, cwd: '/w' },
  );
  assert.deepEqual(addJson(calls).args, ['--flag', 'v']);
});

test('upsertMcpServer: 无 mcp_server 且无 raw_config → {ok:false}，不调用 CLI', async () => {
  const { calls, execFile } = recordingExec();
  const res = await upsertMcpServer({ id: 'c1', slug: 'x' }, { connector_kind: 'mcp' }, { execFile, cwd: '/w' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-mcp-server');
  assert.equal(calls.length, 0, 'no CLI invocation when there is no server config');
});

test('upsertMcpServer (stdio): 缺 command → 跳过并给出 reason，不调用 CLI', async () => {
  const { calls, execFile } = recordingExec();
  const res = await upsertMcpServer(
    { id: 'conn-s3', slug: 'demo' },
    { connector_kind: 'mcp', mcp_server: { transport: 'stdio', args: ['x'] } },
    { execFile, cwd: '/w' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-command');
  assert.equal(calls.length, 0, 'no CLI invocation when stdio config has no command');
});

test('upsertMcpServer (http): 缺 server_url → {ok:false} no-mcp-server，不调用 CLI', async () => {
  const { calls, execFile } = recordingExec();
  const res = await upsertMcpServer(
    { id: 'c1', slug: 'x' },
    { connector_kind: 'mcp', mcp_server: { transport: 'remote_http' } },
    { execFile, cwd: '/w' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-mcp-server');
  assert.equal(calls.length, 0);
});

test('upsertMcpServer: best-effort — add-json 抛错不外抛，返回 {ok:false}', async () => {
  const execFile = async (file, args) => {
    if (args[1] === 'add-json') throw new Error('claude add-json failed');
    return { stdout: '' }; // remove succeeds
  };
  const res = await upsertMcpServer(
    { id: 'c1', slug: 'x' },
    { connector_kind: 'mcp', access_token: 'T', mcp_server: { transport: 'remote_http', server_url: 'https://x/mcp' } },
    { execFile, cwd: '/w' },
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /add-json failed/);
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

test('removeMcpServer: 同样适用于 stdio 命名的 server（基于 name，与传输无关）', async () => {
  const { calls, execFile } = recordingExec();
  const res = await removeMcpServer({ id: 'conn-s1', slug: 'filesystem' }, { execFile, cwd: '/w' });
  assert.deepEqual(res, { ok: true, name: 'openmax-filesystem-conn-s1' });
  assert.deepEqual(calls[0].args, ['mcp', 'remove', '-s', 'local', 'openmax-filesystem-conn-s1']);
});

// --- isStdioConfig / parseArgs ----------------------------------------------

test('isStdioConfig: transport=stdio 或 有 command 无 server_url 判为 stdio', () => {
  assert.equal(isStdioConfig({ transport: 'stdio' }), true);
  assert.equal(isStdioConfig({ command: 'npx', args: ['x'] }), true); // command, no url
  assert.equal(isStdioConfig({ transport: 'remote_http', server_url: 'https://x/mcp' }), false);
  assert.equal(isStdioConfig({ command: 'npx', server_url: 'https://x/mcp' }), false); // url present → not stdio
  assert.equal(isStdioConfig(null), false);
});

test('parseArgs: 接受数组、JSON 字符串，其他→[]', () => {
  assert.deepEqual(parseArgs(['a', 'b']), ['a', 'b']);
  assert.deepEqual(parseArgs('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseArgs([1, 2]), ['1', '2']); // coerced to string
  assert.deepEqual(parseArgs(undefined), []);
  assert.deepEqual(parseArgs('not json'), []);
  assert.deepEqual(parseArgs({ a: 1 }), []);
});

// --- P1-1: token must never leak via the exec FAILURE path -------------------

test('P1-1 upsertMcpServer: 失败(带 exit code)绝不把 token 漏进 reason/日志（仅 exit code）', async () => {
  const TOKEN = 'super-secret-tok-abc123';
  const warns = [];
  // Mirror a real promisified execFile rejection: .message/.cmd carry the FULL
  // argv (incl. the JSON with the injected credential), .stderr may carry it too.
  const execFile = async (file, args) => {
    if (args[1] === 'add-json') {
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
  assert.equal(res.reason, 'claude mcp add-json failed (exit 1)', 'reason must be exit-code-only');
  assert.ok(!res.reason.includes(TOKEN), `reason leaked the token: ${res.reason}`);
  assert.ok(warns.length > 0 && warns.every((l) => !l.includes(TOKEN)), 'warn log leaked the token');
});

test('P1-1 upsertMcpServer: 失败(无 exit code)回退到脱敏消息，token 被 *** 替换', async () => {
  const TOKEN = 'tok-xyz-77';
  const execFile = async (file, args) => {
    if (args[1] === 'add-json') throw new Error(`spawn error: claude ${args.join(' ')}`); // no .code
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

test('[Problem ①] P1-1 upsertMcpServer (stdio): 失败(无 exit code)回退时，env 里的 token 也被脱敏', async () => {
  const TOKEN = 'ghp_env_secret_1';
  const execFile = async (file, args) => {
    if (args[1] === 'add-json') throw new Error(`spawn error: claude ${args.join(' ')}`); // no .code → fallback
    return { stdout: '' };
  };
  const res = await upsertMcpServer(
    { id: 'c-gh', slug: 'github' },
    { connector_kind: 'mcp', access_token: TOKEN, auth_injection: 'env:GITHUB_TOKEN',
      mcp_server: { transport: 'stdio', command: 'docker', args: ['run'] } },
    { execFile, cwd: '/w' },
  );
  assert.equal(res.ok, false);
  assert.ok(!res.reason.includes(TOKEN), `reason leaked the stdio env token: ${res.reason}`);
});

test('P1-R2 upsertMcpServer: query 型 auth 无 exit code 回退时，raw 与 URL 编码后的 token 都不泄露', async () => {
  const TOKEN = 'tok/a+b=';
  const ENCODED = encodeURIComponent(TOKEN); // "tok%2Fa%2Bb%3D"
  const warns = [];
  const execFile = async (file, args) => {
    if (args[1] === 'add-json') throw new Error(`failed running: claude ${args.join(' ')}`); // no .code → fallback
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
  assert.ok(!res.reason.includes(TOKEN), `reason leaked the raw token: ${res.reason}`);
  assert.ok(!res.reason.includes(ENCODED), `reason leaked the URL-encoded token: ${res.reason}`);
  assert.ok(warns.length > 0, 'expected a warn log');
  assert.ok(warns.every((l) => !l.includes(TOKEN) && !l.includes(ENCODED)), `warn log leaked the token: ${warns.join(' | ')}`);
});
