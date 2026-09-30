import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cliPath = fileURLToPath(new URL('./tm.js', import.meta.url));

const readableProposal = {
  request_id: '01000000-0000-4000-8000-000000000001', source_kind: 'timer', operation: 'create',
  configuration: { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' }, schedule_kind: 'cron', cron_expr: '0 9 * * *', timezone: 'Asia/Singapore' },
};
const cardProof = {
  authorization_proposal_message_id: '1790220732844',
  authorization_card_interaction_id: '01000000-0000-4000-8000-000000000002',
};

test('replacement proposal preserves immutable replacement identity on explicit retry', async () => {
  const proposal = { ...readableProposal, replaces_proposal_message_id: cardProof.authorization_proposal_message_id };
  for (let retry = 0; retry < 2; retry++) {
    const request = await captureRequest('automation.authorization_propose', { org: 'org-automation', ...proposal });
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.body, proposal);
  }
});

test('authorization status returns authoritative data without issuing a mutation', async () => {
  const requests = [];
  let status = 'pending_confirmation';
  const response = () => ({ proposal_message_id: cardProof.authorization_proposal_message_id,
    authorization_kind: 'card', status,
    ...(status === 'confirmed' ? { card_interaction_id: cardProof.authorization_card_interaction_id } : {}) });
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: response(), request_id: 'server-request', server_time: '2026-09-30T00:00:00Z' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (status of ['pending_confirmation', 'confirmed', 'modifying', 'cancelled', 'expired', 'superseded']) {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'automation.authorization_status', JSON.stringify({
        org: 'org-automation', proposal_message_id: cardProof.authorization_proposal_message_id,
      })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
      assert.ifError(result.error);
      assert.deepEqual(JSON.parse(result.stdout), response());
    }
    assert.deepEqual(requests, Array.from({ length: 6 }, () => ({ method: 'GET',
      url: `/api/v1/automation-authorizations/proposals/${cardProof.authorization_proposal_message_id}` })));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('status and replacement identifiers reject malformed input before HTTP', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const value of ['', null, 123, '01', '../other', '1'.repeat(129)]) {
      for (const [command, params] of [
        ['automation.authorization_status', { proposal_message_id: value }],
        ['automation.authorization_propose', { ...readableProposal, replaces_proposal_message_id: value }],
      ]) {
        const result = await new Promise(resolve => execFile(process.execPath, [cliPath, command, JSON.stringify({ org: 'org-automation', ...params })], {
          env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
        }, (error, stdout, stderr) => resolve({ error, stderr })));
        assert.ok(result.error);
        assert.match(result.stderr, /canonical decimal/);
      }
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
test('readable proposal forwards stable request identity and canonical configuration to server only', async () => {
  const request = await captureRequest('automation.authorization_propose', { org: 'org-automation', ...readableProposal });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/automation-authorizations/proposals');
  assert.deepEqual(request.body, readableProposal);
  const replay = await captureRequest('automation.authorization_propose', { org: 'org-automation', ...readableProposal });
  assert.deepEqual(replay.body, request.body);
});

test('readable proposal rejects invalid request identity or missing timer timezone before HTTP', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const cases = [
      ...[undefined, '', 'invalid', '00000000-0000-0000-0000-000000000000'].map(request_id => [{ ...readableProposal, request_id }, /request_id must be a UUID/]),
      ...[undefined, null, '', '   '].map(timezone => [{ ...readableProposal, configuration: { ...readableProposal.configuration, timezone } }, /explicit timezone/]),
    ];
    for (const [proposal, errorMessage] of cases) {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'automation.authorization_propose', JSON.stringify({
        org: 'org-automation', ...proposal,
      })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stderr })));
      assert.ok(result.error);
      assert.match(result.stderr, errorMessage);
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('successful readable proposal returns the server receipt without a second message send', async () => {
  const requests = [];
  const response = { data: {
    proposal_message_id: '1790220732844', conversation_id: 'owner-agent-dm',
    proposal_text: 'Daily report at 09:00 Asia/Singapore.',
  }, request_id: 'server-request', server_time: '2026-09-29T00:00:00Z' };
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'automation.authorization_propose', JSON.stringify({
      org: 'org-automation', ...readableProposal,
    })], {
      env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    assert.ifError(result.error);
    assert.deepEqual(JSON.parse(result.stdout), response.data);
    assert.deepEqual(requests, [{ method: 'POST', url: '/api/v1/automation-authorizations/proposals' }]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('authorization preview forwards final configuration and update scope', async () => {
  const configuration = { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' }, cron_expr: '0 9 * * *' };
  const request = await captureRequest('automation.authorization_preview', {
    org: 'org-automation', source_kind: 'timer', operation: 'update', target_binding_id: 'binding-1', expected_version: 3, configuration,
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/automation-authorizations/preview');
  assert.deepEqual(request.body, { source_kind: 'timer', operation: 'update', target_binding_id: 'binding-1', expected_version: 3, configuration });
});

for (const [kind, prefix, path] of [['timer', 'event-binding', 'event-bindings'], ['webhook', 'webhook', 'webhooks']]) {
  for (const operation of ['create', 'update']) {
    test(`${kind} ${operation} forwards exclusive card proof without lifecycle claims`, async () => {
      const configuration = { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' } };
      const request = await captureRequest(`${prefix}.${operation}`, { org: 'org-automation', id: 'binding-1', expected_version: 3,
        source_kind: kind, configuration, ...cardProof, status: 'created', authorization_kind: 'card' });
      assert.equal(request.method, operation === 'create' ? 'POST' : 'PUT');
      assert.equal(request.url, `/api/v1/${path}${operation === 'create' ? '' : '/binding-1'}`);
      assert.deepEqual(request.body, { ...configuration, ...cardProof, ...(operation === 'update' ? { expected_version: 3 } : {}) });
    });
    test(`${kind} ${operation} forwards proof and full replacement version`, async () => {
      const configuration = { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' } };
      const proof = { authorization_proposal_message_id: '1790220732844', authorization_confirmation_message_id: '1790220732845' };
      const request = await captureRequest(`${prefix}.${operation}`, { org: 'org-automation', id: 'binding-1', expected_version: 3, source_kind: kind, configuration, ...proof });
      assert.equal(request.method, operation === 'create' ? 'POST' : 'PUT');
      assert.equal(request.url, `/api/v1/${path}${operation === 'create' ? '' : '/binding-1'}`);
      assert.deepEqual(request.body, { ...configuration, ...proof, ...(operation === 'update' ? { expected_version: 3 } : {}) });
    });
  }
  test(`${kind} mutations reject missing update proof and partial proof before HTTP`, async () => {
    let requests = 0;
    const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const proof = { authorization_proposal_message_id: '1790220732844', authorization_confirmation_message_id: '1790220732845' };
      const cases = [['update', {}]];
      for (const operation of ['create', 'update']) {
        cases.push([operation, { authorization_proposal_message_id: proof.authorization_proposal_message_id }]);
        cases.push([operation, { authorization_confirmation_message_id: proof.authorization_confirmation_message_id }]);
        for (const field of Object.keys(proof)) cases.push([operation, { ...proof, [field]: ' ' }]);
        cases.push([operation, { ...proof, ...cardProof }]);
        cases.push([operation, { authorization_card_interaction_id: cardProof.authorization_card_interaction_id }]);
        for (const invalid of ['', null, 1, '1790220732845', '00000000-0000-0000-0000-000000000000']) {
          cases.push([operation, { ...cardProof, authorization_card_interaction_id: invalid }]);
        }
      }
      for (const [operation, authorization] of cases) {
        const result = await new Promise(resolve => execFile(process.execPath, [cliPath, `${prefix}.${operation}`, JSON.stringify({
          org: 'org-automation', id: 'binding-1', expected_version: 3, source_kind: kind,
          configuration: { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' } },
          ...authorization,
        })], {
          env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
        }, (error, stdout, stderr) => resolve({ error, stderr })));
        assert.ok(result.error, `${prefix}.${operation} must reject ${JSON.stringify(authorization)}`);
        assert.match(result.stderr, /requires both authorization|canonical decimal|canonical nonzero UUID/);
      }
      assert.equal(requests, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('ordinary delivery preserves the empty-body acceptance workflow', async () => {
  const request = await captureRequest('issue.deliver', { org: 'org-automation', id: 'issue-1' });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/issues/issue-1/deliver');
  assert.equal(request.body, undefined);
});

const authorizationProof = { authorization_proposal_message_id: '1790220732844', authorization_confirmation_message_id: '1790220732845' };
for (const [command, params, retry] of [
  ['automation.authorization_propose', readableProposal, false],
  ...['event-binding', 'webhook'].flatMap(prefix => {
    const source_kind = prefix === 'event-binding' ? 'timer' : 'webhook';
    const configuration = { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' } };
    return [
      [`${prefix}.create`, { source_kind, configuration, ...authorizationProof }, false],
      [`${prefix}.update`, { source_kind, configuration, expected_version: 3, ...authorizationProof }, false],
      [`${prefix}.create`, { source_kind, configuration, ...cardProof }, false],
      [`${prefix}.update`, { source_kind, configuration, expected_version: 3, ...cardProof }, false],
      [`${prefix}.create`, { leadMemberId: 'agent', ownerMemberId: 'human', projectId: 'project', title: 'Legacy task' }, false],
    ];
  }),
  ['issue.deliver', { summary: 'Recorded result', outcome: 'success', idempotencyKey: 'delivery-1' }, false],
  ['issue.create_revision', { description: 'Correct result', originMessageId: '1790220732845', idempotencyKey: 'revision-1' }, false],
  ['issue.deliver', {}, true],
]) {
  test(`${command} ${params.title ? 'legacy create' : params.summary ? 'structured result' : retry ? 'ordinary' : 'automation'} ${retry ? 'retains' : 'disables'} 401 replay`, async () => {
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(requests === 1 ? 401 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(requests === 1 ? { error: { detail: 'Original unauthorized response' } } : { ok: true }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, command, JSON.stringify({ org: 'org-automation', id: 'binding-1', ...params })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
      if (retry) {
        assert.ifError(result.error);
      } else {
        assert.ok(result.error);
        assert.match(result.stderr, /Original unauthorized response/);
        assert.match(result.stderr, /401/);
      }
      assert.equal(requests, retry ? 2 : 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}

for (const [command, params] of [
  ['automation.authorization_propose', readableProposal],
  ['issue.deliver', { summary: 'Recorded result', outcome: 'success', idempotencyKey: 'delivery-1' }],
  ['issue.create_revision', { description: 'Correct result', originMessageId: 'human-1', idempotencyKey: 'revision-1' }],
]) {
  test(`${command} preserves ambiguous write failure without automatic replay or fallback`, async () => {
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { detail: 'write outcome unknown' } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, command, JSON.stringify({ org: 'org-automation', id: 'issue-1', ...params })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stderr })));
      assert.ok(result.error);
      assert.match(result.stderr, /write outcome unknown/);
      assert.equal(requests, 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}

for (const outcome of ['success', 'partial', 'failed']) {
  test(`structured delivery forwards ${outcome} without caller-defined lifecycle or sender`, async () => {
    const request = await captureRequest('issue.deliver', {
      org: 'org-automation', id: 'issue-1', summary: 'Result summary', outcome,
      idempotencyKey: 'delivery-1', artifacts: [{ title: 'Report', url: 'https://example.com/report', injected: true }],
      automation_policy: 'silent', source: 'text_card_proxy', conversationId: 'wrong-dm', leadAgentId: 'wrong-agent',
    });
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/v1/issues/issue-1/deliver');
    assert.deepEqual(request.body, {
      summary: 'Result summary', outcome, idempotency_key: 'delivery-1',
      artifacts: [{ title: 'Report', url: 'https://example.com/report' }],
    });
  });
}

test('linked revision submits the human-message reference but no inherited policy claims', async () => {
  const request = await captureRequest('issue.create_revision', {
    org: 'org-automation', id: 'issue-1', description: 'Correct this report',
    originMessageId: '1789717014187', idempotencyKey: 'revision-1',
    automationPolicy: 'silent', ownerMemberId: 'spoofed-owner', leadAgentId: 'spoofed-agent',
  });
  assert.equal(request.url, '/api/v1/issues/issue-1/revisions');
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.body, {
    description: 'Correct this report', origin_message_id: '1789717014187', idempotency_key: 'revision-1',
  });
});

test('incomplete or malformed automation result and revision fail before HTTP', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [command, params] of [
      ['issue.deliver', { summary: 'Missing outcome/key' }],
      ['issue.deliver', { summary: ' ', outcome: 'success', idempotencyKey: 'd1' }],
      ['issue.deliver', { summary: { text: 'Wrong type' }, outcome: 'success', idempotencyKey: 'd1' }],
      ['issue.deliver', { summary: 'Invalid outcome', outcome: 'accepted', idempotencyKey: 'd1' }],
      ['issue.deliver', { summary: 'Invalid artifact', outcome: 'success', idempotencyKey: 'd1', artifacts: [{}] }],
      ['issue.create_revision', { description: 'Missing human message/key' }],
      ['issue.create_revision', { description: 'Correction', originMessageId: ' ', idempotencyKey: 'r1' }],
      ['issue.create_revision', { description: 'Correction', originMessageId: 1789717014187, idempotencyKey: 'r1' }],
    ]) {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, command, JSON.stringify({ org: 'org-automation', id: 'issue-1', ...params })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stderr })));
      assert.ok(result.error);
      assert.match(result.stderr, /requires|outcome must|artifacts must/);
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('wrong route and unsupported fields fail before HTTP submission', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const params of [
      { source_kind: 'timer', configuration: { schedule_kind: 'cron', cron_expr: '0 9 * * 1', timezone: 'UTC' } },
      { source_kind: 'webhook', configuration: { schedule_kind: 'cron' } },
      { source_kind: 'webhook', configuration: { spec: { title: 'Task', unsupported: true } } },
    ]) {
      const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'webhook.create', JSON.stringify({ org: 'org-automation', ...params })], {
        env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`, COCO_AUTH_TOKEN: 'test', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000,
      }, (error, stdout, stderr) => resolve({ error, stderr })));
      assert.ok(result.error);
      assert.match(result.stderr, /source_kind must be webhook|unsupported/);
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

for (const schedule of [
  { schedule_kind: 'cron', cron_expr: '0 9 * * 1', timezone: 'Asia/Singapore' },
  { schedule_kind: 'once', run_at: '2030-01-01T01:00:00Z', timezone: 'America/New_York' },
  { schedule_kind: 'interval', interval_seconds: 90, anchor_at: '2030-01-01T01:00:00Z', timezone: 'UTC' },
]) {
  test(`automation create preserves ${schedule.schedule_kind} form configuration`, async () => {
    const configuration = {
      lead_member_id: 'agent', owner_member_id: 'human',
      spec: { project_id: 'project', title: 'Review', description: 'Inputs and output destination' },
      ...schedule,
    };
    const request = await captureRequest('event-binding.create', {
      org: 'org-automation', source_kind: 'timer', request_id: 'not-an-idempotency-key', configuration,
    });
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/v1/event-bindings');
    assert.deepEqual(request.body, configuration);
  });
}

test('legacy cron creation remains compatible', async () => {
  const request = await captureRequest('event-binding.create', {
    org: 'org-automation', cronExpr: '0 9 * * 1', leadMemberId: 'agent',
    ownerMemberId: 'human', projectId: 'project', title: 'Legacy',
  });
  assert.deepEqual(request.body, {
    cron_expr: '0 9 * * 1', lead_member_id: 'agent', owner_member_id: 'human',
    spec: { project_id: 'project', title: 'Legacy' },
  });
});

test('webhook create preserves filter without forwarding envelope fields', async () => {
  const configuration = {
    lead_member_id: 'agent', owner_member_id: 'human',
    spec: { project_id: 'project', title: 'Incoming', description: '' },
    event_filter: 'payload.type == "ready"',
  };
  const request = await captureRequest('webhook.create', {
    org: 'org-automation', configuration, source_kind: 'webhook',
  });
  assert.equal(request.url, '/api/v1/webhooks');
  assert.deepEqual(request.body, configuration);
  const read = await captureRequest('webhook.get', { org: 'org-automation', id: 'binding' });
  assert.equal(read.method, 'GET');
  assert.equal(read.url, '/api/v1/webhooks/binding');
});

test('ambiguous webhook server failure does not retry creation', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { detail: 'write outcome unknown' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise(resolve => execFile(process.execPath, [cliPath, 'webhook.create', JSON.stringify({
      org: 'org-automation', source_kind: 'webhook', configuration: {
        lead_member_id: 'agent', owner_member_id: 'human',
        spec: { project_id: 'project', title: 'Incoming' }, event_filter: '',
      },
    })], { env: { ...process.env, COCO_API_URL: `http://127.0.0.1:${server.address().port}`,
      COCO_AUTH_TOKEN: 'contract-token', COCO_USER_TOKEN: '', COCO_RPC_LOG: '0' }, timeout: 5000 },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    assert.ok(result.error);
    assert.match(result.stderr, /write outcome unknown/);
    assert.equal(requests, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

async function captureRequest(command, params) {
  let resolveRequest;
  const requestPromise = new Promise((resolve) => { resolveRequest = resolve; });
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      resolveRequest({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: rawBody ? JSON.parse(rawBody) : undefined,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: {}, request_id: 'test-request' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const processPromise = new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, command, JSON.stringify(params)],
      {
        env: {
          ...process.env,
          COCO_API_URL: `http://127.0.0.1:${port}`,
          COCO_API_PREFIX: '/api/v1',
          COCO_AUTH_TOKEN: 'cli-contract-token',
          COCO_USER_TOKEN: '',
          COCO_RPC_LOG: '0',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`tm.js failed: ${stderr || stdout}`));
          return;
        }
        resolve();
      },
    );
  });

  try {
    const [request] = await Promise.all([requestPromise, processPromise]);
    return request;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function captureFailure(command, params) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, command, JSON.stringify(params)],
      { env: { ...process.env, COCO_RPC_LOG: '0' } },
      (error, stdout, stderr) => {
        if (!error) {
          reject(new Error(`tm.js unexpectedly succeeded: ${stdout}`));
          return;
        }
        resolve(JSON.parse(stderr));
      },
    );
  });
}

test('project.create forwards atomic project fields and documented auth token', async () => {
  const request = await captureRequest('project.create', {
    name: 'Semantic alignment',
    leadMemberId: 'lead-1',
    knowledgeBaseId: 'kb-1',
    memberIds: ['member-1', 'member-2'],
    isDefault: true,
  });

  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/projects');
  assert.equal(request.authorization, 'Bearer cli-contract-token');
  assert.deepEqual(request.body, {
    name: 'Semantic alignment',
    lead_member_id: 'lead-1',
    knowledge_base_id: 'kb-1',
    member_ids: ['member-1', 'member-2'],
    is_default: true,
  });
});

test('project and organization issue searches forward query', async () => {
  const projectRequest = await captureRequest('project.list', { query: 'alpha' });
  const issueRequest = await captureRequest('issue.list', { query: 'beta' });

  assert.equal(projectRequest.url, '/api/v1/projects?query=alpha');
  assert.equal(issueRequest.url, '/api/v1/issues?query=beta');
});

test('issue.create preserves backlog presence and requires owner and lead', async () => {
  const backlogRequest = await captureRequest('issue.create', {
    projectId: 'project-1',
    title: 'Record discovered issue',
    leadAgentId: 'agent-1',
    ownerMemberId: 'human-1',
  });
  assert.equal(Object.hasOwn(backlogRequest.body, 'backlog'), false);

  const immediateRequest = await captureRequest('issue.create', {
    projectId: 'project-1',
    title: 'Start immediately',
    leadAgentId: 'agent-1',
    ownerMemberId: 'human-1',
    backlog: false,
  });
  assert.equal(immediateRequest.body.backlog, false);

  const failure = await captureFailure('issue.create', {
    projectId: 'project-1',
    title: 'Missing ownership',
  });
  assert.match(failure.error, /leadAgentId, ownerMemberId/);
});

test('issue.accept_delivered defaults to the Lead text-card proxy source', async () => {
  const proxyRequest = await captureRequest('issue.accept_delivered', {
    id: 'issue-1',
  });
  assert.equal(proxyRequest.method, 'POST');
  assert.equal(proxyRequest.url, '/api/v1/issues/issue-1/accept-delivered');
  assert.deepEqual(proxyRequest.body, { source: 'text_card_proxy' });

  const explicitRequest = await captureRequest('issue.accept_delivered', {
    id: 'issue-1',
    source: 'explicit',
  });
  assert.deepEqual(explicitRequest.body, { source: 'explicit' });
});

test('comment.list uses cursor pagination', async () => {
  const request = await captureRequest('comment.list', {
    workType: 'task',
    workId: 'task-1',
    cursor: 'cursor-1',
    limit: 25,
    orderBy: 'created_at desc',
  });

  const url = new URL(request.url, 'http://localhost');
  assert.equal(url.searchParams.get('work_type'), 'task');
  assert.equal(url.searchParams.get('work_id'), 'task-1');
  assert.equal(url.searchParams.get('cursor'), 'cursor-1');
  assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(url.searchParams.get('order_by'), 'created_at desc');
  assert.equal(url.searchParams.has('page'), false);
  assert.equal(url.searchParams.has('page_size'), false);
});

test('project member commands match BFF paths and bodies', async () => {
  const addRequest = await captureRequest('project.member_add', {
    id: 'project-1',
    memberId: 'member-1',
  });
  const removeRequest = await captureRequest('project.member_remove', {
    id: 'project-1',
    memberId: 'member-1',
  });

  assert.equal(addRequest.method, 'POST');
  assert.equal(addRequest.url, '/api/v1/projects/project-1/members');
  assert.deepEqual(addRequest.body, { member_id: 'member-1', role: 'member' });
  assert.equal(removeRequest.method, 'DELETE');
  assert.equal(removeRequest.url, '/api/v1/projects/project-1/members/member-1');
});
