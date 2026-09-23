import test from 'node:test';
import assert from 'node:assert/strict';
import { composeWorkerEnvironment, createComposeConsumer as createConsumer, runComposeWorker, validateComposeRequest, validateComposeResult } from './automation-compose.js';

const createComposeConsumer = options => createConsumer({ authorize: async () => true, ...options });

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

test('worker environment excludes parent sessions, messaging credentials and injected node options', () => {
  assert.deepEqual(composeWorkerEnvironment({ PATH: '/bin', HOME: '/test', ANTHROPIC_API_KEY: 'model-auth',
    CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_MESSAGING_TOKEN: 'secret', COCO_API_KEY: 'secret',
    NODE_OPTIONS: '--require arbitrary.js', OPENMAX_ORG_ID: 'org' }),
  { PATH: '/bin', HOME: '/test', ANTHROPIC_API_KEY: 'model-auth', OPENMAX_COMPOSE_ISOLATED: '1' });
});

test('cached result never crosses a changed request binding on retry', async () => {
  for (const mutate of [r => { r.form_revision = 'v2'; }, r => { r.content = 'New goal'; },
    r => { r.session.user_id = 'u2'; }, r => { r.session.conversation_id = 'c2'; }]) {
    let r = request(), runs = 0, submits = 0, submitted;
    const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {},
      get: async route => route.includes('/pending') ? [r] : r,
      post: async (route, body) => {
        if (!route.endsWith('/result')) return;
        if (++submits === 1) throw new Error('network');
        submitted = body.result;
      },
      run: async () => ({ kind: 'proposal', draft: { generation: ++runs } }),
    });
    await consumer.tick(); r = structuredClone(r); mutate(r); await consumer.tick();
    assert.equal(runs, 2); assert.equal(submits, 2);
    assert.equal(submitted.draft.generation, 2);
  }
});

test('request cancellation and completed requests never receive a submission', async () => {
  for (const status of ['cancelled', 'completed']) {
    const r = request(); let runs = 0, submits = 0;
    const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {},
      get: async route => route.includes('/pending') ? [r] : { ...r, status },
      post: async route => { if (route.endsWith('/result')) submits++; },
      run: async () => { runs++; return { kind: 'clarification', message: 'When?' }; },
    });
    await consumer.tick(); assert.equal(runs, 1); assert.equal(submits, 0);
  }
});

test('every immutable binding is rechecked after inference', async () => {
  for (const mutate of [r => { r.form_revision = 'v2'; }, r => { r.content = 'Changed'; },
    r => { r.session.user_id = 'u2'; }, r => { r.session.conversation_id = 'c2'; },
    r => { r.request_id = 'r2'; }, r => { r.session.session_id = 's2'; }]) {
    const r = request(), latest = structuredClone(r); mutate(latest); let submits = 0;
    const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {},
      get: async route => route.includes('/pending') ? [r] : latest,
      post: async route => { if (route.endsWith('/result')) submits++; },
      run: async () => ({ kind: 'clarification', message: 'When?' }),
    });
    await consumer.tick(); assert.equal(submits, 0);
  }
});

test('cached proposal is replaced by an isolated error after policy revocation', async () => {
  const r = request(); let allowed = true, runs = 0, submits = 0, submitted;
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {},
    authorize: async () => allowed, get: async route => route.includes('/pending') ? [r] : r,
    post: async (route, body) => {
      if (!route.endsWith('/result')) return;
      if (++submits === 1) throw new Error('network');
      submitted = body.result;
    },
    run: async () => { runs++; return { kind: 'proposal', draft: { title: 'Draft' } }; },
  });
  await consumer.tick(); allowed = false; await consumer.tick();
  assert.equal(runs, 1); assert.equal(submits, 2);
  assert.equal(submitted.kind, 'error');
});

test('default readiness branch runs a real isolated child before advertisement', async () => {
  const worker = { ...config(), args: ['-e', `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{if(!JSON.parse(s).content.startsWith('Readiness check only'))process.exit(2);else console.log(JSON.stringify({kind:'clarification',message:'Ready'}))})`] };
  let registered = 0, reads = 0, probes = 0;
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config: () => worker,
    get: async () => { reads++; return []; }, post: async () => { registered++; },
    run: async (...args) => { probes++; return runComposeWorker(...args); },
  });
  await consumer.tick(); await consumer.tick();
  assert.equal(registered, 1); assert.equal(reads, 2); assert.equal(probes, 1);
});

test('worker preserves UTF-8 characters split across stdout chunks', async () => {
  const expected = '\u4e2d\u6587';
  const script = `const b=Buffer.from(JSON.stringify({kind:'clarification',message:'\\u4e2d\\u6587'}));const i=b.indexOf(Buffer.from('\\u4e2d'))+1;process.stdout.write(b.subarray(0,i));setTimeout(()=>process.stdout.write(b.subarray(i)),30);`;
  const result = await runComposeWorker({ ...config(), args: ['-e', script] }, 'Draft');
  assert.equal(result.message, expected);
});

test('valid request business error does not reclassify a ready worker or charge another probe', async () => {
  const r = request(); let probes = 0, calls = 0;
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config,
    get: async route => route.includes('/pending') ? [r] : r, post: async () => {},
    run: async (_config, content) => {
      if (content.startsWith('Readiness check only')) { probes++; return { kind: 'clarification', message: 'Ready' }; }
      calls++; return { kind: 'error', message: 'Please provide a valid schedule.' };
    },
  });
  await consumer.tick(); await consumer.tick();
  assert.equal(probes, 1); assert.equal(calls, 2);
});

test('broken worker stops renewal and queue processing until backed-off readiness recovers', async () => {
  for (const invalidResult of [false, true]) {
    let clock = 0, probes = 0, registrations = 0, reads = 0, runs = 0, healthy = true;
    const r = request(); const results = [];
    const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, now: () => clock,
      probe: async () => { probes++; if (!healthy) throw new Error('worker unavailable'); },
      get: async route => { if (route.includes('/pending')) { reads++; return [r, { ...r, request_id: 'r2' }]; } return r; },
      post: async (route, body) => { if (route.endsWith('/register')) registrations++; else results.push(body.result); },
      run: async () => { runs++; healthy = false; if (invalidResult) return {}; throw new Error('worker crashed'); },
    });
    await consumer.tick();
    assert.equal(probes, 1); assert.equal(registrations, 1); assert.equal(runs, 1);
    assert.equal(results[0].kind, 'error');
    for (let i = 1; i <= 10; i++) { clock = i * 5000; await consumer.tick(); }
    assert.equal(probes, 1); assert.equal(registrations, 1); assert.equal(reads, 1);
    clock = 60000; await consumer.tick();
    assert.equal(probes, 2); assert.equal(registrations, 1); assert.equal(reads, 1);
    clock = 119999; await consumer.tick(); assert.equal(probes, 2);
    healthy = true; clock = 120000; await consumer.tick();
    assert.equal(probes, 3); assert.equal(registrations, 2); assert.equal(reads, 2);
  }
});

test('invalid queue input and authorization exceptions preserve worker readiness', async () => {
  const invalid = request(); invalid.session.org_id = 'wrong'; let probes = 0, registrations = 0, clock = 1;
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, now: () => clock,
    probe: async () => { probes++; }, get: async () => [invalid, request()],
    authorize: async () => { throw new Error('policy unavailable'); },
    post: async () => { registrations++; }, run: async () => { assert.fail('invalid requests must not invoke worker'); },
  });
  await consumer.tick(); clock += 60000; await consumer.tick();
  assert.equal(probes, 1); assert.equal(registrations, 2);
});

test('queue aliases mutated during inference cannot rewrite trusted lookup routes or reply bindings', async () => {
  for (const mutate of [r => { r.session.session_id = 's2'; }, r => { r.request_id = 'r2'; },
    r => { r.session.conversation_id = 'c2'; }, r => { r.form_revision = 'changed'; }]) {
    const queued = request(), trusted = structuredClone(queued), lookups = [], replies = [];
    const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {},
      get: async route => { if (route.includes('/pending')) return [queued]; lookups.push(route); return trusted; },
      post: async (route, body) => { if (route.endsWith('/result')) replies.push({ route, body }); },
      run: async () => { mutate(queued); return { kind: 'clarification', message: 'When?' }; },
    });
    await consumer.tick();
    assert.deepEqual(lookups, ['/automation-compose/sessions/s1/requests/r1']);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].route, '/automation-compose/sessions/s1/requests/r1/result');
    assert.equal(replies[0].body.conversation_id, 'c1');
    assert.equal(replies[0].body.form_revision, 'revision');
  }
});

test('missing authorization and every non-boolean approval deny inference', async () => {
  for (const authorize of [undefined, async () => ({}), async () => [], async () => 'false', async () => 1]) {
    const r = request(); let runs = 0; const results = [];
    const consumer = createConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {}, authorize,
      get: async route => route.includes('/pending') ? [r] : r,
      post: async (route, body) => { if (route.endsWith('/result')) results.push(body.result); },
      run: async () => { runs++; return { kind: 'proposal', draft: {} }; },
    });
    await consumer.tick(); assert.equal(runs, 0); assert.equal(results.length, 1); assert.equal(results[0].kind, 'error');
  }
});

test('same queue and detail object mutated during inference never submits', async () => {
  for (const mutate of [r => { r.session.conversation_id = 'c-ATTACK'; }, r => { r.form_revision = 'rev-ATTACK'; }]) {
    const r = request(); let submits = 0;
    const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {},
      get: async route => route.includes('/pending') ? [r] : r,
      post: async route => { if (route.endsWith('/result')) submits++; },
      run: async () => { mutate(r); return { kind: 'proposal', draft: {} }; },
    });
    await consumer.tick(); assert.equal(submits, 0);
  }
});

test('unacknowledged result survives temporary absence from the first queue page', async () => {
  const r = request(); let page = [r], runs = 0, submits = 0;
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, probe: async () => {},
    get: async route => route.includes('/pending') ? page : r,
    post: async route => { if (route.endsWith('/result') && ++submits === 1) throw new Error('network'); },
    run: async () => { runs++; return { kind: 'proposal', draft: {} }; },
  });
  await consumer.tick(); page = []; await consumer.tick(); page = [r]; await consumer.tick();
  assert.equal(runs, 1); assert.equal(submits, 2);
});

test('retry cache expires after ten minutes even if the session remains active', async () => {
  const r = request(); r.session.expires_at_ms = 2000000; let clock = 1, runs = 0;
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: 'a1', config, now: () => clock, probe: async () => {},
    get: async route => route.includes('/pending') ? [r] : r,
    post: async route => { if (route.endsWith('/result')) throw new Error('network'); },
    run: async () => { runs++; return { kind: 'proposal', draft: {} }; },
  });
  await consumer.tick(); clock = 600000; await consumer.tick(); assert.equal(runs, 1);
  clock = 600001; await consumer.tick(); assert.equal(runs, 2);
});

test('late identity hydration resumes polling and identity change during inference blocks submission', async () => {
  let identity, runs = 0, submissions = 0, reads = 0; const r = request();
  const consumer = createComposeConsumer({ orgId: 'o1', agentId: () => identity, config, probe: async () => {},
    get: async route => { reads++; return route.includes('/pending') ? [r] : r; },
    post: async route => { if (route.endsWith('/result')) submissions++; },
    run: async () => { runs++; identity = 'a2'; return { kind: 'proposal', draft: {} }; },
  });
  await consumer.tick(); assert.equal(reads, 0);
  identity = 'a1'; await consumer.tick(); assert.equal(runs, 1); assert.equal(submissions, 0);
});
