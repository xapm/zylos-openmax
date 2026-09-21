import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));

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
        if (error) { reject(new Error(`comm.js failed: ${stderr || stdout}`)); return; }
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
        if (!error) { reject(new Error(`comm.js unexpectedly succeeded: ${stdout}`)); return; }
        resolve(JSON.parse(stderr));
      },
    );
  });
}

test('member_list → GET .../members (full list, no pagination params) + documented auth', async () => {
  // cws-core ListMembers takes only conversation_id; the CLI must not send
  // cursor/limit (they would be silently ignored — fake pagination).
  const request = await captureRequest('comm.member_list', { conversationId: 'cv-1', limit: 50 });
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/api/v1/conversations/cv-1/members');
  assert.equal(request.authorization, 'Bearer cli-contract-token');
});

test('member_add (single) → POST .../members {member_id}', async () => {
  const request = await captureRequest('comm.member_add', { conversationId: 'cv-1', memberId: 'm-1' });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/conversations/cv-1/members');
  assert.deepEqual(request.body, { member_id: 'm-1' });
});

test('member_add (single, with role) forwards role', async () => {
  const request = await captureRequest('comm.member_add', { conversationId: 'cv-1', memberId: 'm-1', role: 'ADMIN' });
  assert.deepEqual(request.body, { member_id: 'm-1', role: 'ADMIN' });
});

test('member_add (batch) → POST .../members:batch-add {member_ids, role}', async () => {
  const request = await captureRequest('comm.member_add', {
    conversationId: 'cv-1', memberIds: ['m-1', 'm-2'], role: 'MEMBER',
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/conversations/cv-1/members:batch-add');
  assert.deepEqual(request.body, { member_ids: ['m-1', 'm-2'], role: 'MEMBER' });
});

test('member_remove → DELETE .../members/{member_id}', async () => {
  const request = await captureRequest('comm.member_remove', { conversationId: 'cv-1', memberId: 'm-1' });
  assert.equal(request.method, 'DELETE');
  assert.equal(request.url, '/api/v1/conversations/cv-1/members/m-1');
  assert.equal(request.body, undefined);
});

test('member_remove_batch → POST .../members:batch-remove {member_ids}', async () => {
  const request = await captureRequest('comm.member_remove_batch', {
    conversationId: 'cv-1', memberIds: ['m-1', 'm-2'],
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/conversations/cv-1/members:batch-remove');
  assert.deepEqual(request.body, { member_ids: ['m-1', 'm-2'] });
});

test('leave → POST .../leave, omits new_owner_id unless given', async () => {
  const plain = await captureRequest('comm.leave', { conversationId: 'cv-1' });
  assert.equal(plain.method, 'POST');
  assert.equal(plain.url, '/api/v1/conversations/cv-1/leave');
  assert.deepEqual(plain.body, {});

  const withOwner = await captureRequest('comm.leave', { conversationId: 'cv-1', newOwnerId: 'h-9' });
  assert.deepEqual(withOwner.body, { new_owner_id: 'h-9' });
});

test('validation: member_add with neither id, remove without id, batch with empty', async () => {
  assert.match((await captureFailure('comm.member_add', { conversationId: 'cv-1' })).error, /memberId/);
  assert.match((await captureFailure('comm.member_remove', { conversationId: 'cv-1' })).error, /memberId required/);
  assert.match((await captureFailure('comm.member_remove_batch', { conversationId: 'cv-1', memberIds: [] })).error, /non-empty/);
});

test('send_card → POST .../interaction-requests with an interaction_type=choice body', async () => {
  const request = await captureRequest('comm.send_card', {
    conversationId: 'cv-card-1',
    title: 'Confirm',
    summary: 'Continue the deploy?',
    options: ['Yes', 'No'],
  });

  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/conversations/cv-card-1/interaction-requests');
  assert.equal(request.body.interaction_type, 'choice');
  assert.equal(request.body.choice.title, 'Confirm');
  assert.deepEqual(request.body.choice.options, [{ label: 'Yes' }, { label: 'No' }]);
  // The card body is cws-comm's to build: nothing here names a schema, a mode,
  // an operation or an option id.
  assert.equal(request.body.choice.schema, undefined);
  assert.equal(request.body.type, undefined);
});

test('send_card refuses an option id rather than dropping it', async () => {
  // The server generates the ids and returns them as action_ids. A dropped id
  // would leave the caller matching the answer against one the server never saw.
  const failure = await captureFailure('comm.send_card', {
    conversationId: 'cv-card-3',
    title: 't',
    summary: 's',
    options: [{ label: 'Yes', id: 'yes' }],
  });
  assert.match(failure.error, /^options\[0\]\.id: /);
  assert.equal(failure.status, undefined, 'no HTTP round trip happened');
});

test('send_card refuses replyTo and mentions — the endpoint has no field for them', async () => {
  for (const extra of [{ replyTo: 'msg-parent' }, { mentions: ['member-9'] }]) {
    const failure = await captureFailure('comm.send_card', {
      conversationId: 'cv-card-2', title: 't', summary: 's', options: ['Yes'], ...extra,
    });
    assert.match(failure.error, /is not supported by interaction-requests/);
    assert.equal(failure.status, undefined, 'no HTTP round trip happened');
  }
});

test('send_card refuses a card with no options', async () => {
  const failure = await captureFailure('comm.send_card', {
    conversationId: 'cv-card-4', title: 't', summary: 's',
  });
  assert.match(failure.error, /^options: /);
  assert.equal(failure.status, undefined, 'no HTTP round trip happened');
});
