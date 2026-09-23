import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposeConsumer, runComposeWorker, validateComposeRequest, validateComposeResult } from './automation-compose.js';

const config = () => ({ enabled: true, command: process.execPath, args: [] });
const request = () => ({
  session: { session_id: 's1', conversation_id: 'c1', org_id: 'o1', user_id: 'u1', agent_id: 'a1', status: 'active', expires_at_ms: Date.now() + 600000, schema_version: 1 },
  request_id: 'r1', form_revision: 'revision', schema_version: 1,
  content: 'Draft only', status: 'pending',
});

test('binding rejects wrong org, agent, expired session and malformed identifiers', () => {
  for (const change of [
    { org_id: 'o2' }, { agent_id: 'a2' }, { expires_at_ms: 0 },
    { session_id: '../s' }, { status: 'cancelled' },
  ]) {
    const r = request(); Object.assign(r.session, change);
    assert.throws(() => validateComposeRequest(r, 'o1', 'a1'));
  }
});

test('worker result excludes fabricated routing fields and rejects invalid business results', () => {
  assert.deepEqual(validateComposeResult({ kind: 'clarification', message: 'When?', session_id: 'evil' }), { kind: 'clarification', message: 'When?' });
  assert.throws(() => validateComposeResult({ kind: 'proposal', draft: [] }));
  assert.throws(() => validateComposeResult({ kind: 'error', message: '' }));
});

test('isolated subprocess receives content only and parses JSON without shell interpolation', async () => {
  const result = await runComposeWorker({ ...config(), args: ['-e', `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const v=JSON.parse(s);if(Object.keys(v).join(',')!=='schema_version,content')process.exit(2);console.log(JSON.stringify({kind:'clarification',message:v.content}))})`] }, 'literal $(echo secret)');
  assert.equal(result.message, 'literal $(echo secret)');
});

test('worker timeout and malformed output fail closed', async () => {
  await assert.rejects(runComposeWorker({ ...config(), timeout_ms: 1000, args: ['-e', 'setInterval(()=>{},1000)'] }, 'draft'), /timed out/);
  await assert.rejects(runComposeWorker({ ...config(), args: ['-e', 'console.log("not JSON")'] }, 'draft'), /invalid JSON/);
});

test('submit retries reuse inference and bind server fields rather than model echo', async () => {
  const r = request(); let runs = 0, submits = 0; const calls = [];
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {},
    get: async route => ({ data: route.includes('/pending') ? [r] : r }),
    post: async (route, body) => { calls.push({ route, body }); if (route.endsWith('/result') && ++submits === 1) throw new Error('network'); },
    run: async () => { runs++; return { kind: 'proposal', draft: { title: 'Test' }, request_id: 'fake' }; },
  });
  await consumer.tick(); await consumer.tick();
  assert.equal(runs, 1); assert.equal(submits, 2);
  const body = calls.find(c => c.route.endsWith('/result')).body;
  assert.deepEqual(body, { conversation_id: 'c1', form_revision: 'revision', schema_version: 1, result: { kind: 'proposal', draft: { title: 'Test' } } });
  assert.ok(calls.every(c => c.route.startsWith('/automation-compose/')));
});

test('cancel during inference never submits and polls cannot overlap', async () => {
  const r = request(); let release, runs = 0, submits = 0;
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {},
    get: async route => route.includes('/pending') ? [r] : { ...r, session: { ...r.session, status: 'cancelled' } },
    post: async route => { if (route.endsWith('/result')) submits++; },
    run: async () => { runs++; await new Promise(resolve => { release = resolve; }); return { kind: 'clarification', message: 'When?' }; },
  });
  const first = consumer.tick();
  await new Promise(resolve => setImmediate(resolve));
  await consumer.tick(); release(); await first;
  assert.equal(runs, 1); assert.equal(submits, 0);
});

test('disabled worker neither advertises capability nor reads queue', async () => {
  let calls = 0;
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config: () => ({ enabled: false }), get: async () => { calls++; }, post: async () => { calls++; } });
  await consumer.tick(); assert.equal(calls, 0);
});

test('cross-agent queue item is rejected without inference or send', async () => {
  let runs = 0, submits = 0; const r = request(); r.session.agent_id = 'a2';
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {},
    get: async () => [r], post: async route => { if (route.endsWith('/result')) submits++; },
    run: async () => { runs++; },
  });
  await consumer.tick(); assert.equal(runs, 0); assert.equal(submits, 0);
});

test('failed readiness never registers capability or reads pending requests', async () => {
  let calls = 0;
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config,
    probe: async () => { throw new Error('not authenticated'); },
    get: async () => { calls++; }, post: async () => { calls++; },
  });
  await consumer.tick(); await consumer.tick(); assert.equal(calls, 0);
});

test('DM policy denial returns isolated error without model execution', async () => {
  let runs = 0; const results = []; const r = request();
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {}, authorize: async () => false,
    get: async route => route.includes('/pending') ? [r] : r,
    post: async (route, body) => { if (route.endsWith('/result')) results.push(body.result); },
    run: async () => { runs++; },
  });
  await consumer.tick(); assert.equal(runs, 0); assert.equal(results[0].kind, 'error');
});

test('one invalid queue item does not block another valid session', async () => {
  const valid = request(), bad = request(); bad.session.org_id = 'wrong'; let runs = 0;
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {},
    get: async route => route.includes('/pending') ? [bad, valid] : valid,
    post: async () => {}, run: async () => { runs++; return { kind: 'clarification', message: 'When?' }; },
  });
  await consumer.tick(); assert.equal(runs, 1);
});

test('server rejected proposal becomes retryable isolated error', async () => {
  const r = request(), results = [];
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {},
    get: async route => route.includes('/pending') ? [r] : r,
    post: async (route, body) => {
      if (!route.endsWith('/result')) return;
      results.push(body.result.kind);
      if (body.result.kind === 'proposal') throw Object.assign(new Error('invalid resource'), { status: 400 });
    },
    run: async () => ({ kind: 'proposal', draft: { invalid: true } }),
  });
  await consumer.tick(); assert.deepEqual(results, ['proposal', 'error']);
});
