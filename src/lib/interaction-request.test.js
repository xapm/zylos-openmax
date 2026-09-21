import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChoiceRequest, InteractionRequestError } from './interaction-request.js';

const base = { conversationId: 'c1', title: 'Upgrade?', summary: '3 components can be upgraded' };

test('builds the choice shape the endpoint declares', () => {
  const body = buildChoiceRequest({ ...base, text: 'Upgrade all three?', options: ['Yes', 'No'] });
  assert.equal(body.interaction_type, 'choice');
  assert.equal(body.choice.title, 'Upgrade?');
  assert.equal(body.choice.summary, '3 components can be upgraded');
  assert.deepEqual(body.choice.blocks, [{ type: 'text', text: 'Upgrade all three?' }]);
  assert.deepEqual(body.choice.options, [{ label: 'Yes' }, { label: 'No' }]);
});

test('text defaults to summary, and explicit blocks win over it', () => {
  const derived = buildChoiceRequest({ ...base, options: ['Yes'] });
  assert.deepEqual(derived.choice.blocks, [{ type: 'text', text: base.summary }]);
  const explicit = buildChoiceRequest({
    ...base,
    text: 'ignored when blocks are given',
    blocks: [{ type: 'markdown', text: '- a\n- b' }, { type: 'divider' }],
    options: ['Yes'],
  });
  assert.equal(explicit.choice.blocks.length, 2);
  assert.equal(explicit.choice.blocks[0].type, 'markdown');
});

test('🔴 an option id is refused, not dropped', () => {
  // Silently dropping it would leave the caller matching the answer against an
  // id the server never saw.
  assert.throws(
    () => buildChoiceRequest({ ...base, options: [{ label: 'Yes', id: 'yes' }] }),
    (e) => e instanceof InteractionRequestError && e.field === 'options[0].id',
  );
});

test('option accepts a bare string, `label`, or the old `text` alias', () => {
  const body = buildChoiceRequest({
    ...base,
    options: ['A', { label: 'B', style: 'primary' }, { text: 'C' }],
  });
  assert.deepEqual(body.choice.options, [
    { label: 'A' }, { label: 'B', style: 'primary' }, { label: 'C' },
  ]);
});

test('🔴 a card with no options is refused — that shape no longer exists', () => {
  for (const options of [undefined, []]) {
    assert.throws(
      () => buildChoiceRequest({ ...base, options }),
      (e) => e instanceof InteractionRequestError && e.field === 'options',
    );
  }
});

test('🔴 replyTo and mentions are refused rather than silently lost', () => {
  // The endpoint has no field for either; a reply-to that vanishes looks
  // exactly like one that was never asked for.
  assert.throws(
    () => buildChoiceRequest({ ...base, options: ['Yes'], replyTo: '123' }),
    (e) => e.field === 'replyTo',
  );
  assert.throws(
    () => buildChoiceRequest({ ...base, options: ['Yes'], mentions: [{ member_id: 'm' }] }),
    (e) => e.field === 'mentions',
  );
});

test('title and summary are both required', () => {
  assert.throws(() => buildChoiceRequest({ summary: 's', options: ['Y'] }), (e) => e.field === 'title');
  assert.throws(() => buildChoiceRequest({ title: 't', options: ['Y'] }), (e) => e.field === 'summary');
});

test('confirm is passed through when given, and validated when malformed', () => {
  const body = buildChoiceRequest({ ...base, options: ['Yes'], confirm: { text: 'Sure?', label: 'Do it' } });
  assert.deepEqual(body.choice.confirm, { text: 'Sure?', label: 'Do it' });
  assert.throws(() => buildChoiceRequest({ ...base, options: ['Y'], confirm: {} }), (e) => e.field === 'confirm.text');
});

test('client_msg_id is only present when supplied', () => {
  assert.equal('client_msg_id' in buildChoiceRequest({ ...base, options: ['Y'] }), false);
  assert.equal(buildChoiceRequest({ ...base, options: ['Y'], clientMsgId: 'k1' }).client_msg_id, 'k1');
});

test('🔴 no local length or count caps — cws-comm holds those rules', () => {
  // A local cap tighter than the server's would make a range the server accepts
  // unreachable, with an error blaming the caller. Six options and a very long
  // label must reach the wire; the server decides.
  const body = buildChoiceRequest({
    ...base,
    options: ['a', 'b', 'c', 'd', 'e', 'f'.repeat(200)],
  });
  assert.equal(body.choice.options.length, 6);
  assert.equal(body.choice.options[5].label.length, 200);
});
