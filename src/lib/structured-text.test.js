import assert from 'node:assert/strict';
import test from 'node:test';

import { describeEmptyStructuredText } from './structured-text.js';

const cardMsg = {
  id: 'm1',
  type: 'CARD',
  content: {
    content_type: 'card',
    body: { schema: 'cws.card.v1', kind: 'agent.prompt', mode: 'display', title: 'T' },
  },
};

test('matches: structured body but no text — exactly the shape a card leaves behind', () => {
  const d = describeEmptyStructuredText(cardMsg, '');
  assert.ok(d, 'should match');
  assert.equal(d.contentType, 'card');
  // 🔴 The diagnostic has to identify WHICH kind this was; reporting only
  // "it was empty" is the same as reporting nothing.
  assert.ok(d.bodyKeys.includes('schema'), 'body_keys must show what the body actually holds');
  assert.ok(!d.bodyKeys.includes('text'), 'the arms come back empty precisely because there is no text key');
});

test('no match: genuinely empty message (content is not an object)', () => {
  // Without this condition the group-history caller would fire on every message.
  assert.equal(describeEmptyStructuredText({ id: 'm2', content: '' }, ''), null);
  assert.equal(describeEmptyStructuredText({ id: 'm3', content: null }, ''), null);
  assert.equal(describeEmptyStructuredText({ id: 'm4' }, ''), null);
});

test('no match: structured and the text came through', () => {
  const ok = { id: 'm5', type: 'TEXT', content: { body: { text: 'hello' } } };
  assert.equal(describeEmptyStructuredText(ok, 'hello'), null);
});

test('both base conditions are load-bearing — split apart so the predicate cannot decay into one', () => {
  // Only "no text" (content is not an object) => silent
  assert.equal(describeEmptyStructuredText({ content: 'plain' }, ''), null);
  // Only "content is an object" (text was extracted) => silent
  assert.equal(describeEmptyStructuredText({ content: { body: { text: 'x' } } }, 'x'), null);
  // Both => fires
  assert.ok(describeEmptyStructuredText({ content: { body: {} } }, ''));
});

test('a non-object body does not throw, and is reported as an empty body', () => {
  const d = describeEmptyStructuredText({ id: 'm6', content: { body: 'oops' } }, '');
  assert.ok(d);
  assert.deepEqual(d.bodyKeys, []);
});

test('🔴 the card carries a projection no arm can reach — the signal must surface it', () => {
  // Shape produced by buildDisplayCard: the projection sits in
  // blocks[0].fallback_text, one level BELOW body.
  const card = {
    id: 'm7',
    type: 'CARD',
    content: {
      content_type: 'card',
      body: {
        schema: 'cws.card.v1',
        kind: 'agent.prompt',
        mode: 'display',
        title: 'Continue?',
        blocks: [{ type: 'text', text: 'Continue?', fallback_text: 'Continue?' }],
      },
    },
  };
  const d = describeEmptyStructuredText(card, '');
  assert.ok(d);
  assert.equal(d.hasBlockFallback, true);
  // The point of this case: the empty string is NOT the card withholding a
  // human-readable form.
  assert.ok(!d.bodyKeys.includes('text'), 'no text key at body level — that is why every arm is empty');
});

test('reports an absent projection honestly instead of inventing one', () => {
  const d = describeEmptyStructuredText(
    { id: 'm8', content: { body: { schema: 'x', blocks: [{ type: 'text', text: 'a' }] } } },
    '',
  );
  assert.ok(d);
  assert.equal(d.hasBlockFallback, false);
});

test('a whitespace-only projection does not count as one', () => {
  const blank = describeEmptyStructuredText(
    { content: { body: { blocks: [{ fallback_text: '   ' }] } } }, '');
  assert.equal(blank.hasBlockFallback, false);
  const real = describeEmptyStructuredText(
    { content: { body: { blocks: [{ fallback_text: '   ' }, { fallback_text: 'the real sentence' }] } } }, '');
  assert.equal(real.hasBlockFallback, true);
});

// 🔴 A shape that exists in live traffic: a file message with no caption —
// object `content`, no `text` in the body, identical to a card in the first two
// conditions, and yet perfectly healthy (its content is in the attachments).
// Not excluding it means alarming on healthy traffic.
const captionlessFileMsg = {
  id: 'm-file',
  type: 'FILE',
  content: {
    content_type: 'file',
    body: { file_name: 'deploy-receipt.md' },
    attachments: [{ artifact_id: 'a1', file_name: 'deploy-receipt.md' }],
  },
};

test('no match: caption-less file message — it has another legitimate content channel', () => {
  assert.equal(describeEmptyStructuredText(captionlessFileMsg, ''), null);
});

test('each of the three media channels must block on its own — split apart so the list cannot decay', () => {
  const base = { id: 'm-x', type: 'FILE', content: { content_type: 'file', body: {} } };
  // content.attachments
  assert.equal(describeEmptyStructuredText(
    { ...base, content: { ...base.content, attachments: [{ artifact_id: 'a' }] } }, ''), null);
  // legacy flat media fields
  assert.equal(describeEmptyStructuredText(
    { ...base, content: { ...base.content, media_id: 'mid' } }, ''), null);
  assert.equal(describeEmptyStructuredText(
    { ...base, content: { ...base.content, filename: 'f.png' } }, ''), null);
  // envelope-level attachments
  assert.equal(describeEmptyStructuredText(
    { ...base, attachments: [{ artifact_id: 'a' }] }, ''), null);
  // Reverse direction: with no channel at all it MUST still match, otherwise
  // this condition would swallow cards as well.
  assert.ok(describeEmptyStructuredText(base, ''), 'must still match when no media channel is present');
});

test('🔴 a card has no attachments — the media condition must not swallow it', () => {
  assert.ok(describeEmptyStructuredText(cardMsg, ''), 'a card has no media channel and must still match');
  assert.equal(describeEmptyStructuredText({ ...cardMsg, content: { ...cardMsg.content, attachments: [] } }, '')
    ?.contentType, 'card', 'an empty array is not a channel');
});
