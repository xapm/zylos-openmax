import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChoiceRequest, InteractionRequestError } from './interaction-request.js';

const base = {
  conversationId: 'c1',
  title: 'Upgrade?',
  summary: '3 components can be upgraded',
  text: 'dashboard 0.5.4 and lark 0.3.11 both have newer releases.',
};

test('builds the choice shape the endpoint declares', () => {
  const body = buildChoiceRequest({ ...base, text: 'Upgrade all three?', options: ['Yes', 'No'] });
  assert.equal(body.interaction_type, 'choice');
  assert.equal(body.choice.title, 'Upgrade?');
  assert.equal(body.choice.summary, '3 components can be upgraded');
  assert.deepEqual(body.choice.blocks, [{ type: 'text', text: 'Upgrade all three?' }]);
  assert.deepEqual(body.choice.options, [{ label: 'Yes' }, { label: 'No' }]);
});

test('🔴 the body is never derived from summary, because the client shows both', () => {
  // Defaulting the body to the summary rendered the same sentence twice in the
  // card — once beside the title, once as the body.
  const { text, ...noBody } = base;
  assert.throws(
    () => buildChoiceRequest({ ...noBody, options: ['Yes'] }),
    (e) => e instanceof InteractionRequestError && e.field === 'text',
  );
  const withText = buildChoiceRequest({ ...base, text: 'body says something else', options: ['Yes'] });
  assert.deepEqual(withText.choice.blocks, [{ type: 'text', text: 'body says something else' }]);
  assert.notEqual(withText.choice.blocks[0].text, withText.choice.summary);
});

test('explicit blocks win over text', () => {
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

test('a key is always sent, and an identical one only comes from the caller', () => {
  // The generated key de-dupes a retry of the same request object. Two calls
  // are two keys, so re-running after a lost response posts a second card —
  // surviving that is the caller's job, by keeping and resending its own id.
  const a = buildChoiceRequest({ ...base, options: ['Y'] });
  const b = buildChoiceRequest({ ...base, options: ['Y'] });
  assert.match(a.client_msg_id, /^c_/);
  assert.notEqual(a.client_msg_id, b.client_msg_id);
  const k1 = buildChoiceRequest({ ...base, options: ['Y'], clientMsgId: 'k1' });
  const k2 = buildChoiceRequest({ ...base, options: ['Y'], clientMsgId: 'k1' });
  assert.equal(k1.client_msg_id, 'k1');
  assert.equal(k2.client_msg_id, 'k1');
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

test('🔴 kind and fallbackText are refused, not ignored', () => {
  // Both were arguments of the old card verb. Ignoring an unknown key is the
  // same silent drop replyTo and mentions are refused for.
  for (const field of ['kind', 'fallbackText']) {
    assert.throws(
      () => buildChoiceRequest({ ...base, options: ['Y'], [field]: 'x' }),
      (e) => e instanceof InteractionRequestError && e.field === field,
      field,
    );
  }
});

test('🔴 a question-level argument named like a card field must not reach the builder', () => {
  // `comm.ask_card` takes its own `kind` (what the question is for) while the
  // old card API used `kind` for something else, and the builder refuses it.
  // Passing the verb's arguments straight through made that verb throw on its
  // own required argument — every call, before any request went out.
  assert.throws(
    () => buildChoiceRequest({ ...base, options: ['Y'], kind: 'component-upgrade' }),
    (e) => e instanceof InteractionRequestError && e.field === 'kind',
  );
  const { kind, askedOf, meta, ...cardParams } = {
    ...base, options: ['Y'], kind: 'component-upgrade', askedOf: 'm1', meta: { v: 1 },
  };
  const body = buildChoiceRequest(cardParams);
  assert.equal(body.interaction_type, 'choice');
  assert.equal('kind' in body.choice, false);
  assert.equal('askedOf' in body.choice, false);
  assert.equal('meta' in body.choice, false);
});
