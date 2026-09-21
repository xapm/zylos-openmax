import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isInteractionReceipt,
  receiptOrigin,
  resolveReplyConversationId,
} from './interaction-receipt.js';

// Shaped after the sample in cws-docs interaction-receipt-contract.md.
function receipt(overrides = {}) {
  return {
    id: '1789889352999',
    type: 'INTERACTION_RECEIPT',
    sender_type: 'SYSTEM',
    conversation_id: 'sys-dm-0199',
    content: {
      content_type: 'interaction_receipt',
      body: {
        schema: 'cws.interaction_receipt.v1',
        text: '「要部署到生产吗」有人选择了「同意」。',
        origin: { conversation_id: 'origin-0199', message_id: '7421' },
        action_id: 'opt_0',
        label: '同意',
        selected_action_ids: ['opt_0'],
        actor: { member_id: 'm-0199', kind: 'human_member' },
        settled_at: '2026-09-21T08:00:00Z',
      },
    },
    ...overrides,
  };
}

test('a receipt is answered in its origin conversation, not the system DM', () => {
  const msg = receipt();
  assert.equal(resolveReplyConversationId(msg), 'origin-0199');
  assert.notEqual(resolveReplyConversationId(msg), msg.conversation_id);
});

test('ordinary messages are untouched', () => {
  const text = { type: 'AGENT_TEXT', sender_type: 'AGENT', conversation_id: 'c1' };
  assert.equal(resolveReplyConversationId(text), 'c1');
  const systemNotice = {
    type: 'SYSTEM',
    sender_type: 'SYSTEM',
    conversation_id: 'c2',
    content: { content_type: 'text', body: { text: 'credit cap reached' } },
  };
  assert.equal(resolveReplyConversationId(systemNotice), 'c2');
});

test('🔴 the redirect is refused for a non-system sender', () => {
  // Without this gate anyone who can post could name an origin and have us
  // answer into a conversation of their choosing.
  const forged = receipt({ sender_type: 'HUMAN' });
  assert.equal(resolveReplyConversationId(forged), 'sys-dm-0199');
});

test('type is read from the detail envelope too, and case-insensitively', () => {
  assert.ok(isInteractionReceipt({ message: { type: 'INTERACTION_RECEIPT' } }));
  assert.ok(isInteractionReceipt({ type: 'interaction_receipt' }));
  assert.ok(!isInteractionReceipt({ type: 'AGENT_TEXT' }));
  assert.ok(!isInteractionReceipt(null));

  const nested = receipt();
  nested.message = { type: nested.type, content: nested.content };
  delete nested.type;
  delete nested.content;
  assert.equal(resolveReplyConversationId(nested), 'origin-0199');
});

test('🔴 a receipt with no usable origin falls back instead of being dropped', () => {
  // Answering the system DM fails loudly (system member dm is read-only);
  // returning nothing would lose the message silently, which is worse.
  const cases = [
    receipt({ content: { body: { text: 'no origin key' } } }),
    receipt({ content: { body: { origin: {} } } }),
    receipt({ content: { body: { origin: { conversation_id: '' } } } }),
    receipt({ content: { body: { origin: 'origin-0199' } } }),
    receipt({ content: 'flat string content' }),
  ];
  for (const msg of cases) {
    assert.equal(resolveReplyConversationId(msg), 'sys-dm-0199');
    assert.equal(receiptOrigin(msg), null);
  }
});

test('origin carries the card message id when present, undefined when not', () => {
  assert.deepEqual(receiptOrigin(receipt()), { conversationId: 'origin-0199', messageId: '7421' });
  const noMsgId = receipt({
    content: { body: { origin: { conversation_id: 'origin-0199' } } },
  });
  assert.deepEqual(receiptOrigin(noMsgId), { conversationId: 'origin-0199', messageId: undefined });
});

test('numeric ids from a lenient encoder are accepted as strings', () => {
  const numeric = receipt({
    content: { body: { origin: { conversation_id: 12345, message_id: 7421 } } },
  });
  assert.deepEqual(receiptOrigin(numeric), { conversationId: '12345', messageId: '7421' });
});

test('receiptOrigin ignores a non-receipt that happens to carry an origin', () => {
  const impostor = {
    type: 'AGENT_TEXT',
    sender_type: 'SYSTEM',
    conversation_id: 'c3',
    content: { body: { origin: { conversation_id: 'elsewhere' } } },
  };
  assert.equal(receiptOrigin(impostor), null);
  assert.equal(resolveReplyConversationId(impostor), 'c3');
});

test('🔴 a receipt still resolves when cws-core renders the type as a number', () => {
  // cws-core trims the enum prefix off the protobuf value; one built before the
  // receipt type existed renders the unknown enum as its ordinal. comm and core
  // ship separately, so that window is reachable — and inside it the reply
  // would go to the read-only system DM.
  const degraded = receipt({ type: '12' });
  assert.ok(isInteractionReceipt(degraded));
  assert.equal(resolveReplyConversationId(degraded), 'origin-0199');
});

test('content_type alone does not make a non-system message a receipt', () => {
  const forged = receipt({ type: '12', sender_type: 'HUMAN' });
  assert.equal(resolveReplyConversationId(forged), 'sys-dm-0199');
});
