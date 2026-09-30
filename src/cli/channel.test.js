import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChannelConfirmationMessage,
  classifyChannelStart,
  waitForChannelConfirmation,
  buildChannelQRMessage,
  channelStatusMessage,
  channelStartResultWithoutQR,
  isRetryableChannelPollError,
  planChannelConnect,
  pollChannelUntilTerminal,
} from './channel.js';

const CONV = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

test('confirmation cards contain display scope, not QR material or model-selected target', () => {
  for (const channel of ['feishu', 'lark', 'dingtalk', 'wecom']) {
    const card = buildChannelConfirmationMessage(channel, CONV, '2099-01-01T00:00:00Z');
    assert.equal(card.content.body.schema, 'openmax.channel-confirm.v1');
    assert.equal(card.content.body.channel_type, channel);
    assert.deepEqual(card.content.body, card.metadata.openmax_channel_confirmation);
    assert.equal('agent_member_id' in card.content.body, false);
    assert.equal('qr_ref' in card.content.body, false);
    assert.equal('session_handle' in card.content.body, false);
  }
  assert.throws(() => buildChannelConfirmationMessage('wechat', CONV, '2099-01-01'), /invalid/);
  assert.throws(() => buildChannelConfirmationMessage('feishu', 'forged', '2099-01-01'), /invalid/);
});

test('confirmation waits through preparing and starting, then returns approved QR to watcher', async () => {
  let now = 0;
  const ready = { status: 'awaiting_user_scan', qr_ref: 'https://example.test', session_handle: 'confirmed' };
  const states = [{ status: 'awaiting_user_confirmation' }, { status: 'starting' }, ready];
  assert.equal(await waitForChannelConfirmation({ deadlineMs: 10_000, now: () => now,
    sleep: async ms => { now += ms; }, poll: async () => states.shift() }), ready);
});

test('confirmation expires without treating silence as consent and never retries forbidden', async () => {
  let now = 0;
  await assert.rejects(waitForChannelConfirmation({ deadlineMs: 6000, now: () => now,
    sleep: async ms => { now += ms; }, poll: async () => ({ status: 'awaiting_user_confirmation' }) }), { status: 410 });
  let calls = 0;
  await assert.rejects(waitForChannelConfirmation({ deadlineMs: 6000, now: () => 0,
    sleep: async () => {}, poll: async () => { calls++; throw Object.assign(new Error('forbidden'), { status: 403 }); } }), { status: 403 });
  assert.equal(calls, 1);
});

test('confirmation retries temporary errors but surfaces failed start', async () => {
  let now = 0;
  let calls = 0;
  assert.deepEqual(await waitForChannelConfirmation({ deadlineMs: 6000, now: () => now,
    sleep: async ms => { now += ms; }, poll: async () => {
      if (++calls === 1) throw Object.assign(new Error('busy'), { status: 503 });
      return { status: 'already_connected' };
    } }), { status: 'already_connected' });
  await assert.rejects(waitForChannelConfirmation({ deadlineMs: 6000, now: () => 0,
    sleep: async () => {}, poll: async () => ({ status: 'error' }) }), /confirmation failed/);
});

test('planChannelConnect builds self-scoped requests for every platform authorization channel', () => {
  for (const channelType of ['feishu', 'lark', 'dingtalk', 'wecom']) {
    const plan = planChannelConnect({
      channelType,
      conversationId: CONV,
      sourceMessageId: 'msg-123',
      agentMemberId: 'must-not-be-forwarded',
    });
    assert.deepEqual(plan.body, {
      channel_type: channelType,
      conversation_id: CONV,
      source_message_id: 'msg-123',
    });
    assert.equal('agent_member_id' in plan.body, false);
  }
});

test('planChannelConnect rejects unsupported channels and missing trusted context', () => {
  assert.throws(() => planChannelConnect({ channelType: 'wechat', conversationId: CONV, sourceMessageId: 'm' }), /must be one of/);
  assert.throws(() => planChannelConnect({ channelType: 'feishu', conversationId: 'fake', sourceMessageId: 'm' }), /must be a UUID/);
  assert.throws(() => planChannelConnect({ channelType: 'feishu', conversationId: CONV }), /sourceMessageId is required/);
});

test('channelStatusMessage uses provider-specific names', () => {
  assert.match(channelStatusMessage('dingtalk', 'connected'), /钉钉连接成功.*现在可以收发消息/);
  assert.match(channelStatusMessage('wecom', 'expired'), /企业微信授权二维码已过期/);
  assert.match(channelStatusMessage('lark', 'cancelled'), /Lark授权已取消/);
  assert.match(channelStatusMessage('dingtalk', 'timeout'), /钉钉扫码已完成.*组件连接超时/);
  assert.match(channelStatusMessage('feishu', 'error'), /飞书渠道连接失败/);
});

test('channelStartResultWithoutQR suppresses redundant QR sessions', () => {
  assert.deepEqual(channelStartResultWithoutQR('lark', { status: 'already_connected' }), {
    status: 'already_connected',
    channel_type: 'lark',
    qr_sent_to_conversation: false,
    message: 'Lark已连接，无需重复扫码。',
  });
  assert.deepEqual(channelStartResultWithoutQR('feishu', { status: 'connection_in_progress' }), {
    status: 'connection_in_progress',
    channel_type: 'feishu',
    qr_sent_to_conversation: false,
    message: '飞书正在连接中，无需重复扫码，请稍候。',
  });
  assert.equal(channelStartResultWithoutQR('dingtalk', { status: 'awaiting_user_scan' }), null);
});

test('buildChannelQRMessage emits one generic structured card for every platform', () => {
  for (const channelType of ['feishu', 'lark', 'dingtalk', 'wecom']) {
    const message = buildChannelQRMessage(channelType, 'https://example.test/authorize', '2026-09-03T12:00:00.000Z');
    assert.equal(message.type, 'AGENT_STRUCTURED');
    assert.equal(message.content.content_type, 'channel_qr');
    assert.deepEqual(message.content.body, {
      schema: 'openmax.channel-qr.v1',
      channel_type: channelType,
      qr_ref: 'https://example.test/authorize',
      expires_at: '2026-09-03T12:00:00.000Z',
    });
    assert.deepEqual(message.metadata.openmax_channel_qr, message.content.body);
  }
  assert.throws(() => buildChannelQRMessage('feishu', '', new Date().toISOString()), /no QR reference/);
});

test('pollChannelUntilTerminal retries transient 503 without replacing the QR session', async () => {
  let clock = 0;
  let calls = 0;
  const statuses = [
    Object.assign(new Error('temporary upstream failure'), { status: 503 }),
    { status: 'pending' },
    { status: 'connected', binding: { status: 'connected' } },
  ];
  const terminal = await pollChannelUntilTerminal({
    scanDeadlineMs: 20_000,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    pollAuthorization: async () => {
      const value = statuses[calls++];
      if (value instanceof Error) throw value;
      return value;
    },
    pollBinding: async () => {
      throw new Error('binding status must not be read when authorization returns connected');
    },
  });
  assert.equal(terminal, 'connected');
  assert.equal(calls, 3);
});

test('pollChannelUntilTerminal switches to Binding status after QR authorization', async () => {
  let clock = 0;
  let authorizationCalls = 0;
  let bindingCalls = 0;
  const bindingStatuses = [
    { status: 'pending', binding: { status: 'pending' } },
    { status: 'connected', binding: { status: 'connected' } },
  ];
  const terminal = await pollChannelUntilTerminal({
    scanDeadlineMs: 20_000,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    pollAuthorization: async () => {
      authorizationCalls += 1;
      return { status: 'connected', binding: { status: 'pending' } };
    },
    pollBinding: async () => bindingStatuses[bindingCalls++],
  });
  assert.equal(terminal, 'connected');
  assert.equal(authorizationCalls, 1);
  assert.equal(bindingCalls, 2);
});

test('pollChannelUntilTerminal fails when the dispatched Binding fails or never completes', async () => {
  for (const result of [
    { status: 'connected' },
    { status: 'connected', binding: { status: 'error' } },
    { status: 'connected', binding: { status: 'disconnected' } },
  ]) {
    const terminal = await pollChannelUntilTerminal({
      scanDeadlineMs: 20_000,
      now: () => 0,
      sleep: async () => {},
      pollAuthorization: async () => result,
      pollBinding: async () => {
        throw new Error('binding status must not be read for an invalid authorization result');
      },
    });
    assert.equal(terminal, 'error');
  }

  const bindingFailure = await pollChannelUntilTerminal({
    scanDeadlineMs: 20_000,
    now: () => 0,
    sleep: async () => {},
    pollAuthorization: async () => ({ status: 'connected', binding: { status: 'pending' } }),
    pollBinding: async () => ({ status: 'error', binding: { status: 'error' } }),
  });
  assert.equal(bindingFailure, 'error');
});

test('pollChannelUntilTerminal gives Binding its own bounded wait and final read', async () => {
  let clock = 0;
  let bindingCalls = 0;
  const timeout = await pollChannelUntilTerminal({
    scanDeadlineMs: 3_000,
    bindingWaitMs: 3_000,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    pollAuthorization: async () => ({ status: 'connected', binding: { status: 'pending' } }),
    pollBinding: async () => {
      bindingCalls += 1;
      return { status: 'pending', binding: { status: 'pending' } };
    },
  });
  assert.equal(timeout, 'timeout');
  assert.equal(bindingCalls, 2, 'one regular read plus one final read at the deadline');

  clock = 0;
  bindingCalls = 0;
  const connectedOnFinalRead = await pollChannelUntilTerminal({
    scanDeadlineMs: 3_000,
    bindingWaitMs: 3_000,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    pollAuthorization: async () => ({ status: 'connected', binding: { status: 'pending' } }),
    pollBinding: async () => {
      bindingCalls += 1;
      return bindingCalls === 1
        ? { status: 'pending', binding: { status: 'pending' } }
        : { status: 'connected', binding: { status: 'connected' } };
    },
  });
  assert.equal(connectedOnFinalRead, 'connected');
  assert.equal(bindingCalls, 2);
});

test('pollChannelUntilTerminal expires when the QR is never scanned', async () => {
  let clock = 0;
  const terminal = await pollChannelUntilTerminal({
    scanDeadlineMs: 3_000,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    pollAuthorization: async () => ({ status: 'pending' }),
    pollBinding: async () => {
      throw new Error('binding status must not be read before authorization');
    },
  });
  assert.equal(terminal, 'expired');
});

test('pollChannelUntilTerminal does not retry permanent request errors', async () => {
  let calls = 0;
  const terminal = await pollChannelUntilTerminal({
    scanDeadlineMs: 20_000,
    now: () => 0,
    sleep: async () => {},
    pollAuthorization: async () => {
      calls += 1;
      throw Object.assign(new Error('bad request'), { status: 400 });
    },
    pollBinding: async () => {
      throw new Error('binding status must not be read after a permanent authorization error');
    },
  });
  assert.equal(terminal, 'error');
  assert.equal(calls, 1);
});

test('retry classification is bounded to network and transient gateway failures', () => {
  assert.equal(isRetryableChannelPollError(new TypeError('fetch failed')), true);
  assert.equal(isRetryableChannelPollError({ status: 429 }), true);
  assert.equal(isRetryableChannelPollError({ status: 503 }), true);
  assert.equal(isRetryableChannelPollError({ status: 400 }), false);
  assert.equal(isRetryableChannelPollError({ status: 500 }), false);
});

test('a typed start waits for the confirmation card; a card-confirmed start goes straight to the QR watcher', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const expires = new Date(Date.now() + 60_000).toISOString();
  assert.equal(classifyChannelStart({ status: 'awaiting_user_confirmation', confirmation_id: id, expires_at: expires }), 'needs_confirmation');
  assert.equal(classifyChannelStart({ status: 'awaiting_user_scan', confirmation_id: id, expires_at: expires }), 'card_confirmed');
  assert.equal(classifyChannelStart({ status: 'starting', confirmation_id: id, expires_at: expires }), 'card_confirmed');
  // No confirmation record means no authority for the watcher's poll.
  assert.throws(() => classifyChannelStart({ status: 'awaiting_user_scan', expires_at: expires }), /no human confirmation request/);
  assert.throws(() => classifyChannelStart({ status: 'awaiting_user_scan', confirmation_id: id }), /no human confirmation request/);
  assert.throws(() => classifyChannelStart({ status: 'ready', confirmation_id: id, expires_at: expires }), /no human confirmation request/);
});
