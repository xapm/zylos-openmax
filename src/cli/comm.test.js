import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));

/**
 * Run a command against a local stub server and return the request it sent.
 *
 * `allowFailure` keeps the captured request when the CLI exits non-zero AFTER
 * sending it. It exists for `comm.ask_card`, which posts and then requires
 * `message_id` / `action_ids` back before recording the question — the stub
 * answers every route with `{}`, so the verb always fails on that check. What
 * this harness can prove about it is exactly what we need: the request went out
 * and carried what it should. Letting it succeed would also make the test write
 * a real pending-question record into the component's runtime directory.
 */
async function captureRequest(command, params, { allowFailure = false } = {}) {
  let resolveRequest;
  let sawRequest = false;
  const requestPromise = new Promise((resolve) => { resolveRequest = resolve; });
  const server = createServer((req, res) => {
    sawRequest = true;
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
        if (error && !allowFailure) { reject(new Error(`comm.js failed: ${stderr || stdout}`)); return; }
        // Under allowFailure, a CLI that exits BEFORE sending leaves the request
        // promise pending forever — the test would hang to the runner's timeout
        // and fail the whole file instead of naming what went wrong. Turn that
        // into an immediate, readable failure.
        if (error && !sawRequest) {
          reject(new Error(`comm.js exited without sending a request: ${stderr || stdout}`));
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
    text: 'The deploy is staged and waiting.',
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
    text: 'body',
    options: [{ label: 'Yes', id: 'yes' }],
  });
  assert.match(failure.error, /^options\[0\]\.id: /);
  assert.equal(failure.status, undefined, 'no HTTP round trip happened');
});

test('send_card refuses replyTo and mentions — the endpoint has no field for them', async () => {
  for (const extra of [{ replyTo: 'msg-parent' }, { mentions: ['member-9'] }]) {
    const failure = await captureFailure('comm.send_card', {
      conversationId: 'cv-card-2', title: 't', summary: 's', text: 'body', options: ['Yes'], ...extra,
    });
    assert.match(failure.error, /is not supported by interaction-requests/);
    assert.equal(failure.status, undefined, 'no HTTP round trip happened');
  }
});

test('🔴 send_card refuses a top-level `fields` instead of posting a card without it', async () => {
  // The real failure this guards: an upgrade card passed one row per component
  // as top-level `fields`. The card posted successfully carrying only the prose
  // body, the reader never saw the versions, and no error was raised anywhere.
  const failure = await captureFailure('comm.send_card', {
    conversationId: 'cv-card-5',
    title: '确认升级', summary: 'openmax · 自动检查', text: '确认升级以下组件?',
    options: ['升级', '先不升'],
    fields: [{ label: 'core', value: '0.7.1 → 0.8.1' }],
  });
  assert.match(failure.error, /^fields: /);
  assert.match(failure.error, /blocks/, 'the error has to say where fields belongs');
  assert.equal(failure.status, undefined, 'no HTTP round trip happened');
});

test('🔴 a fields block inside `blocks` reaches the wire as sent', async () => {
  // Refusing the misplaced key only helps if the destination the error names
  // actually works end to end.
  const blocks = [
    { type: 'text', text: '确认升级以下组件?' },
    { type: 'fields', items: [{ label: 'core', value: '0.7.1 → 0.8.1' }] },
  ];
  const request = await captureRequest('comm.send_card', {
    conversationId: 'cv-card-6', title: '确认升级', summary: 'openmax · 自动检查',
    blocks, options: ['升级', '先不升'],
  });
  assert.deepEqual(request.body.choice.blocks, blocks);
});

test('🔴 ask_card is not broken by the whitelist: kind/askedOf/meta still work', async () => {
  // send_card and ask_card have DIFFERENT legitimate arguments, and the builder
  // refuses ask_card's three. This is the cell that catches a whitelist applied
  // without ask_card stripping them first — it would throw on the verb's own
  // required argument, on every call, before any request went out.
  const request = await captureRequest('comm.ask_card', {
    conversationId: 'cv-card-7', title: '要升级吗', summary: 'openmax · 自动检查',
    text: 'openmax 2.20.0 → 2.21.0。', options: [{ label: '升级', style: 'primary' }, '先不升'],
    kind: 'component-upgrade', askedOf: 'm-owner', meta: { component: 'openmax' },
  }, { allowFailure: true });
  assert.equal(request.url, '/api/v1/conversations/cv-card-7/interaction-requests');
  assert.equal(request.body.interaction_type, 'choice');
  // The question's own arguments describe the question, not the card.
  for (const key of ['kind', 'askedOf', 'meta']) assert.equal(key in request.body.choice, false, key);
});

test('send_card refuses a card with no options', async () => {
  const failure = await captureFailure('comm.send_card', {
    conversationId: 'cv-card-4', title: 't', summary: 's', text: 'body',
  });
  assert.match(failure.error, /^options: /);
  assert.equal(failure.status, undefined, 'no HTTP round trip happened');
});
