import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentLaunchCwd,
  detectClientType,
  isMcpConnection,
  mcpServerName,
  transportFlag,
  isStdioConfig,
  parseArgs,
  normalizeAuthInjection,
  resolveInjection,
  buildAuthHeader,
  buildMcpServerJson,
  buildServerSpec,
  unwrapMcpServersWrapper,
  WRAPPER_REJECTED,
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

// --- unwrapMcpServersWrapper + wrapper-form raw_config ----------------------

test('unwrapMcpServersWrapper: 取 {mcpServers:{单个}} 外层内部的那个 server', () => {
  const inner = { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer sk-INLINE' } };
  assert.deepEqual(unwrapMcpServersWrapper({ mcpServers: { github: inner } }), inner);
});

test('unwrapMcpServersWrapper: 已是 bare server 对象（无 mcpServers）原样返回', () => {
  const bare = { type: 'http', url: 'https://x/mcp', headers: {} };
  assert.equal(unwrapMcpServersWrapper(bare), bare);
});

test('unwrapMcpServersWrapper: 多个条目（sink 探针）拒绝解包，绝不取"第一个"（fail-closed）', () => {
  const expected = { type: 'http', url: 'https://a' };
  const attacker = { type: 'http', url: 'https://attacker' };
  // A real sink probe: name-sorting the "first" would pick `alpha` (the attacker)
  // and inject the live credential into it. Refuse instead of guessing.
  assert.equal(unwrapMcpServersWrapper({ mcpServers: { zeta: expected, alpha: attacker } }), WRAPPER_REJECTED);
});

test('unwrapMcpServersWrapper: 空/非对象条目/嵌套/混合外层 → fail-closed（WRAPPER_REJECTED）', () => {
  // null / non-object input is "no wrapper", returned unchanged (means: no raw_config)
  assert.equal(unwrapMcpServersWrapper(null), null);
  // empty mcpServers → reject (was: fall back to the original object)
  assert.equal(unwrapMcpServersWrapper({ mcpServers: {} }), WRAPPER_REJECTED);
  // non-object entry → reject
  assert.equal(unwrapMcpServersWrapper({ mcpServers: { x: 'not-an-object' } }), WRAPPER_REJECTED);
  // nested wrapper (inner entry itself carries mcpServers) → reject
  assert.equal(
    unwrapMcpServersWrapper({ mcpServers: { x: { mcpServers: { y: { type: 'http', url: 'https://x' } } } } }),
    WRAPPER_REJECTED,
  );
  // mixed bare+wrapper (extra top-level fields alongside mcpServers) → reject,
  // rather than silently dropping the outer fields
  assert.equal(
    unwrapMcpServersWrapper({ mcpServers: { x: { type: 'http', url: 'https://x' } }, type: 'http', url: 'https://outer' }),
    WRAPPER_REJECTED,
  );
});

test('buildMcpServerJson: raw_config 为 {mcpServers:{单个}} wrapper 时解包内部 server；inline 密钥无 auth_injection 时原样保留', () => {
  const json = buildMcpServerJson(
    null,
    {
      // 新模型：无 access_token / 无 auth_injection，密钥 inline 留在 headers
      rawConfig: { mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/sse', headers: { Authorization: 'Bearer sk-INLINE-KEEP' } } } },
    },
  );
  assert.equal(json.type, 'http');
  assert.equal(json.url, 'https://mcp.linear.app/sse');
  assert.equal(json.headers.Authorization, 'Bearer sk-INLINE-KEEP', 'inline 密钥应原样保留（不抽取、不遮蔽）');
  assert.equal(json.mcpServers, undefined, '外层 mcpServers 应被解包掉，不进 add-json 载荷');
});

test('buildMcpServerJson: wrapper 为 JSON 字符串形态也能解包', () => {
  const json = buildMcpServerJson(null, { rawConfig: '{"mcpServers":{"srv":{"type":"stdio","command":"my-server","args":["--flag"]}}}' });
  assert.deepEqual(json, { type: 'stdio', command: 'my-server', args: ['--flag'] });
});

test('buildMcpServerJson: 多条目/畸形 wrapper → 返回 null（fail-closed，不落到离散字段）', () => {
  const attacker = { type: 'http', url: 'https://attacker' };
  const expected = { type: 'http', url: 'https://a' };
  // Even with usable discrete mcp_server fields present, an ambiguous wrapper must
  // NOT be silently ignored in favor of them — it fails closed.
  const res = buildMcpServerJson(
    { transport: 'remote_http', server_url: 'https://discrete/mcp' },
    { rawConfig: { mcpServers: { zeta: expected, alpha: attacker } } },
  );
  assert.equal(res, null);
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
    { execFile, cwd: '/home/agent/zylos', clientType: 'claude' },
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
    { execFile, cwd: '/w', clientType: 'claude' },
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
    { execFile, cwd: '/w', clientType: 'claude' },
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
    { execFile, cwd: '/home/agent/zylos', clientType: 'claude' },
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
    { execFile, cwd: '/w', clientType: 'claude' },
  );
  const json = addJson(calls);
  assert.deepEqual(json.env, { phone: '13800000000' });
});

test('upsertMcpServer (stdio): args 为 JSON 字符串也能解析成数组', async () => {
  const { calls, execFile } = recordingExec();
  await upsertMcpServer(
    { id: 'conn-s2', slug: 'demo' },
    { connector_kind: 'mcp', mcp_server: { transport: 'stdio', command: 'my-server', args: '["--flag","v"]' } },
    { execFile, cwd: '/w', clientType: 'claude' },
  );
  assert.deepEqual(addJson(calls).args, ['--flag', 'v']);
});

test('upsertMcpServer: 无 mcp_server 且无 raw_config → {ok:false}，不调用 CLI', async () => {
  const { calls, execFile } = recordingExec();
  const res = await upsertMcpServer({ id: 'c1', slug: 'x' }, { connector_kind: 'mcp' }, { execFile, cwd: '/w', clientType: 'claude' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-mcp-server');
  assert.equal(calls.length, 0, 'no CLI invocation when there is no server config');
});

test('upsertMcpServer: 歧义 mcpServers wrapper（sink 探针）→ {ok:false} 且零 CLI 调用（不注入密钥）', async () => {
  const { calls, execFile } = recordingExec();
  const res = await upsertMcpServer(
    { id: 'c-sink', slug: 'linear' },
    {
      connector_kind: 'mcp',
      access_token: 'LIVE-CREDENTIAL',
      token_type: 'bearer',
      // The probe: two entries — name-sorting the "first" would install `alpha`
      // (the attacker) and inject the live credential into it.
      raw_config: {
        mcpServers: {
          zeta: { type: 'http', url: 'https://expected/mcp' },
          alpha: { type: 'http', url: 'https://attacker/mcp' },
        },
      },
    },
    { execFile, cwd: '/w', clientType: 'claude' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'ambiguous-wrapper');
  assert.equal(calls.length, 0, 'ambiguous wrapper must trigger ZERO claude mcp calls (no remove, no add)');
});

test('upsertMcpServer (stdio): 缺 command → 跳过并给出 reason，不调用 CLI', async () => {
  const { calls, execFile } = recordingExec();
  const res = await upsertMcpServer(
    { id: 'conn-s3', slug: 'demo' },
    { connector_kind: 'mcp', mcp_server: { transport: 'stdio', args: ['x'] } },
    { execFile, cwd: '/w', clientType: 'claude' },
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
    { execFile, cwd: '/w', clientType: 'claude' },
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
    { execFile, cwd: '/w', clientType: 'claude' },
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /add-json failed/);
});

// --- removeMcpServer --------------------------------------------------------

test('removeMcpServer: 组装 claude mcp remove -s local <name>，注入 execFile+cwd', async () => {
  const { calls, execFile } = recordingExec();
  const res = await removeMcpServer({ id: 'conn-7', slug: 'linear' }, { execFile, cwd: '/home/agent/zylos', clientType: 'claude' });
  assert.deepEqual(res, { ok: true, name: 'openmax-linear-conn-7' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['mcp', 'remove', '-s', 'local', 'openmax-linear-conn-7']);
  assert.equal(calls[0].opts.cwd, '/home/agent/zylos');
});

test('removeMcpServer: best-effort — 抛错（如 server 不存在）不外抛', async () => {
  const execFile = async () => { throw new Error('No such server'); };
  const res = await removeMcpServer({ id: 'c1', slug: 'x' }, { execFile, cwd: '/w', clientType: 'claude' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /No such server/);
});

test('removeMcpServer: 同样适用于 stdio 命名的 server（基于 name，与传输无关）', async () => {
  const { calls, execFile } = recordingExec();
  const res = await removeMcpServer({ id: 'conn-s1', slug: 'filesystem' }, { execFile, cwd: '/w', clientType: 'claude' });
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
    { execFile, cwd: '/w', clientType: 'claude', warn: (m) => warns.push(m) },
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
    { execFile, cwd: '/w', clientType: 'claude' },
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
    { execFile, cwd: '/w', clientType: 'claude' },
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
    { execFile, cwd: '/w', clientType: 'claude', warn: (m) => warns.push(m) },
  );
  assert.equal(res.ok, false);
  assert.ok(!res.reason.includes(TOKEN), `reason leaked the raw token: ${res.reason}`);
  assert.ok(!res.reason.includes(ENCODED), `reason leaked the URL-encoded token: ${res.reason}`);
  assert.ok(warns.length > 0, 'expected a warn log');
  assert.ok(warns.every((l) => !l.includes(TOKEN) && !l.includes(ENCODED)), `warn log leaked the token: ${warns.join(' | ')}`);
});

// --- #112: client-type detection + adapter dispatch (claude / codex) ---------

// Find a codex `mcp add` call (codex uses `add`, not `add-json`).
function codexAddCall(calls) {
  return calls.find((c) => c.file === 'codex' && c.args[0] === 'mcp' && c.args[1] === 'add');
}

// --- detectClientType precedence: env > config.json > default claude ---------

test('detectClientType: ZYLOS_RUNTIME env 优先级最高（压过 config.json）', () => {
  const readFileSync = () => JSON.stringify({ runtime: 'claude' }); // config says claude
  assert.equal(detectClientType({ env: { ZYLOS_RUNTIME: 'codex' }, readFileSync, zylosDir: '/z' }), 'codex');
  // 大小写/空白规范化
  assert.equal(detectClientType({ env: { ZYLOS_RUNTIME: '  CODEX ' }, readFileSync, zylosDir: '/z' }), 'codex');
});

test('detectClientType: 无 env 时读取 config.json 的 .runtime', () => {
  const readFileSync = (p) => {
    assert.match(String(p), /\/z\/\.zylos\/config\.json$/, 'reads <zylosDir>/.zylos/config.json');
    return JSON.stringify({ runtime: 'codex' });
  };
  assert.equal(detectClientType({ env: {}, readFileSync, zylosDir: '/z' }), 'codex');
});

test('detectClientType: config.json 缺失/不可读 → 回退 claude', () => {
  const readFileSync = () => { throw new Error('ENOENT'); };
  assert.equal(detectClientType({ env: {}, readFileSync, zylosDir: '/z' }), 'claude');
});

test('detectClientType: 未知 runtime（env 或 config）→ 回退 claude', () => {
  // unknown env value falls through to config, which is also unknown → default claude
  assert.equal(
    detectClientType({ env: { ZYLOS_RUNTIME: 'gemini' }, readFileSync: () => JSON.stringify({ runtime: 'weird' }), zylosDir: '/z' }),
    'claude',
  );
  // empty/missing everywhere → claude
  assert.equal(detectClientType({ env: {}, readFileSync: () => JSON.stringify({}), zylosDir: '/z' }), 'claude');
});

// --- neutral-spec extraction equivalence: claude adapter output unchanged ----

test('buildServerSpec: claudeJson 与 buildMcpServerJson 逐字节一致（重构不改 claude 输出）', () => {
  const mcp = { transport: 'remote_http', server_url: 'https://mcp.linear.app/rpc' };
  const opts = { accessToken: 'tok-123', tokenType: 'bearer' };
  const spec = buildServerSpec('openmax-linear-conn-1', mcp, opts);
  assert.deepEqual(spec.claudeJson, buildMcpServerJson(mcp, opts));
  // neutral view populated for the http case
  assert.equal(spec.transport, 'http');
  assert.equal(spec.url, 'https://mcp.linear.app/rpc');
  assert.deepEqual(spec.auth, { location: 'header', name: 'Authorization', value: 'Bearer tok-123' });
});

test('buildServerSpec: 歧义 wrapper → null（沿用 buildMcpServerJson 的 fail-closed）', () => {
  const res = buildServerSpec('n', null, {
    rawConfig: { mcpServers: { zeta: { type: 'http', url: 'https://a' }, alpha: { type: 'http', url: 'https://b' } } },
  });
  assert.equal(res, null);
});

// --- runtime=claude (default): regression guard against current behavior ------

test('upsertMcpServer (claude 显式): 命令与既有 claude 行为逐字节一致', async () => {
  const { calls, execFile } = recordingExec();
  const res = await upsertMcpServer(
    { id: 'conn-1', slug: 'linear' },
    { connector_kind: 'mcp', access_token: 'tok-123', token_type: 'bearer',
      mcp_server: { transport: 'remote_http', server_url: 'https://mcp.linear.app/rpc' } },
    { execFile, cwd: '/home/agent/zylos', clientType: 'claude' },
  );
  assert.deepEqual(res, { ok: true, name: 'openmax-linear-conn-1' });
  assert.equal(calls[0].file, 'claude');
  assert.deepEqual(calls[0].args, ['mcp', 'remove', '-s', 'local', 'openmax-linear-conn-1']);
  assert.equal(calls[1].file, 'claude');
  assert.deepEqual(calls[1].args.slice(0, 5), ['mcp', 'add-json', '-s', 'local', 'openmax-linear-conn-1']);
  assert.deepEqual(JSON.parse(calls[1].args[5]), { type: 'http', url: 'https://mcp.linear.app/rpc', headers: { Authorization: 'Bearer tok-123' } });
});

// --- runtime=codex + stdio ---------------------------------------------------

test('upsertMcpServer (codex, stdio): 生成 codex mcp add <name> --env K=V ... -- cmd args...', async () => {
  const { calls, execFile } = recordingExec();
  const res = await upsertMcpServer(
    { id: 'conn-gh', slug: 'github' },
    { connector_kind: 'mcp', access_token: 'ghp_secret', auth_injection: 'env:GITHUB_PERSONAL_ACCESS_TOKEN',
      mcp_server: { transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'], env: {} } },
    { execFile, cwd: '/home/agent/zylos', clientType: 'codex' },
  );
  assert.deepEqual(res, { ok: true, name: 'openmax-github-conn-gh' });
  // remove precedes add (clean refresh), both go to the codex CLI
  assert.equal(calls[0].file, 'codex');
  assert.deepEqual(calls[0].args, ['mcp', 'remove', 'openmax-github-conn-gh']);
  const add = codexAddCall(calls);
  assert.ok(add, 'expected a codex mcp add call');
  assert.deepEqual(add.args, [
    'mcp', 'add', 'openmax-github-conn-gh',
    '--env', 'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_secret',
    '--', 'docker', 'run', '-i', '--rm', 'ghcr.io/github/github-mcp-server',
  ]);
  // never uses claude's add-json flags
  assert.ok(!add.args.includes('add-json') && !add.args.includes('-s'));
});

test('upsertMcpServer (codex, stdio): 无 token 时非密 env 仍以 --env 传（小红书 phone）', async () => {
  const { calls, execFile } = recordingExec();
  await upsertMcpServer(
    { id: 'conn-xhs', slug: 'xiaohongshu' },
    { connector_kind: 'mcp', raw_config: { type: 'stdio', command: 'npx', args: ['xhs-mcp-server'], env: { phone: '13800000000' } } },
    { execFile, cwd: '/w', clientType: 'codex' },
  );
  const add = codexAddCall(calls);
  assert.deepEqual(add.args, ['mcp', 'add', 'openmax-xiaohongshu-conn-xhs', '--env', 'phone=13800000000', '--', 'npx', 'xhs-mcp-server']);
});

// --- runtime=codex + http ----------------------------------------------------

test('upsertMcpServer (codex, http+header/bearer): FAIL-LOUD — {ok:false} 且零 CLI 调用（不写坏配置、不拆已有 server）', async () => {
  const { calls, execFile } = recordingExec();
  const warns = [];
  const res = await upsertMcpServer(
    { id: 'conn-1', slug: 'linear' },
    { connector_kind: 'mcp', access_token: 'tok-123', token_type: 'bearer',
      mcp_server: { transport: 'remote_http', server_url: 'https://mcp.linear.app/rpc' } },
    { execFile, cwd: '/w', clientType: 'codex', warn: (m) => warns.push(m) },
  );
  // codex cannot persist a header/bearer credential for call-time use → refuse,
  // registering nothing, BEFORE any CLI call (crucially: no `codex mcp remove`
  // that would tear down an existing working server).
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'codex-http-header-auth-unsupported');
  assert.equal(calls.length, 0, 'ZERO CLI calls — no remove, no add');
  assert.ok(warns.length > 0, 'must warn about the unsupported path');
  assert.ok(warns.every((l) => !l.includes('tok-123')), 'warn log leaked the token');
});

test('upsertMcpServer (codex, http): query 型 token 随 URL，不产生 --bearer-token-env-var', async () => {
  const { calls, execFile } = recordingExec();
  await upsertMcpServer(
    { id: 'cq', slug: 'demo' },
    { connector_kind: 'mcp', access_token: 'qtok',
      auth_injection: { location: 'query', name: 'access_token', value_template: '{token}' },
      mcp_server: { transport: 'remote_http', server_url: 'https://demo.example/mcp' } },
    { execFile, cwd: '/w', clientType: 'codex' },
  );
  const add = codexAddCall(calls);
  assert.deepEqual(add.args, ['mcp', 'add', 'openmax-demo-cq', '--url', 'https://demo.example/mcp?access_token=qtok']);
  assert.ok(!add.args.includes('--bearer-token-env-var'));
});

// --- runtime=codex remove ----------------------------------------------------

test('removeMcpServer (codex): 生成 codex mcp remove <name>', async () => {
  const { calls, execFile } = recordingExec();
  const res = await removeMcpServer({ id: 'conn-7', slug: 'linear' }, { execFile, cwd: '/w', clientType: 'codex' });
  assert.deepEqual(res, { ok: true, name: 'openmax-linear-conn-7' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'codex');
  assert.deepEqual(calls[0].args, ['mcp', 'remove', 'openmax-linear-conn-7']);
});

test('upsertMcpServer (codex): best-effort — add 抛错(exit code)返回 codex 前缀 reason，token 不泄露', async () => {
  const TOKEN = 'ghp_codex_secret';
  const warns = [];
  const execFile = async (file, args) => {
    if (args[1] === 'add') { const e = new Error(`Command failed: codex ${args.join(' ')}`); e.code = 2; throw e; }
    return { stdout: '' };
  };
  const res = await upsertMcpServer(
    { id: 'c1', slug: 'github' },
    { connector_kind: 'mcp', access_token: TOKEN, auth_injection: 'env:GITHUB_TOKEN',
      mcp_server: { transport: 'stdio', command: 'docker', args: ['run'] } },
    { execFile, cwd: '/w', clientType: 'codex', warn: (m) => warns.push(m) },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'codex mcp add failed (exit 2)');
  assert.ok(warns.every((l) => !l.includes(TOKEN)), 'warn log leaked the token');
});

// --- idempotency: repeat upsert doesn't duplicate ----------------------------

test('upsertMcpServer: 重复 upsert 每次都先 remove 再 add（幂等，不产生重复 server）', async () => {
  const { calls, execFile } = recordingExec();
  const args = [
    { id: 'conn-1', slug: 'linear' },
    { connector_kind: 'mcp', access_token: 'tok', token_type: 'bearer',
      mcp_server: { transport: 'remote_http', server_url: 'https://mcp.linear.app/rpc' } },
    { execFile, cwd: '/w', clientType: 'claude' },
  ];
  await upsertMcpServer(...args);
  await upsertMcpServer(...args);
  // each upsert = exactly one remove + one add-json, same name → no duplicate entry
  const removes = calls.filter((c) => c.args[1] === 'remove');
  const adds = calls.filter((c) => c.args[1] === 'add-json');
  assert.equal(removes.length, 2);
  assert.equal(adds.length, 2);
  assert.ok(removes.every((c) => c.args.includes('openmax-linear-conn-1')));
  assert.ok(adds.every((c) => c.args.includes('openmax-linear-conn-1')));
});

test('upsertMcpServer (codex): 幂等 — 每次 upsert 先 codex remove 再 codex add', async () => {
  const { calls, execFile } = recordingExec();
  const args = [
    { id: 'conn-gh', slug: 'github' },
    { connector_kind: 'mcp', access_token: 'ghp', auth_injection: 'env:GH',
      mcp_server: { transport: 'stdio', command: 'docker', args: ['run'] } },
    { execFile, cwd: '/w', clientType: 'codex' },
  ];
  await upsertMcpServer(...args);
  await upsertMcpServer(...args);
  assert.equal(calls.filter((c) => c.file === 'codex' && c.args[1] === 'remove').length, 2);
  assert.equal(calls.filter((c) => c.file === 'codex' && c.args[1] === 'add').length, 2);
});
