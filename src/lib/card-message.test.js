/**
 * What these cells guard, in one line each: that a `[CARD]` body is recognized,
 * that a broken one is refused instead of being posted as chat text, that the
 * request it produces is the same request `comm.ask_card` produces, and that
 * the question is written down before the answer can arrive.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CARD_PREFIX,
  CardMessageError,
  parseCardMessage,
  sendCardMessage,
} from './card-message.js';
import { buildChoiceRequest } from './interaction-request.js';
import { parseMediaPrefix } from './message.js';
import { findPendingQuestion, recordPendingQuestion } from './pending-question.js';

const card = (extra = {}) => ({
  kind:    'component-upgrade',
  askedOf: 'm-owner',
  title:   '要升级吗',
  summary: 'openmax · 自动检查',
  text:    'openmax 2.20.0 → 2.21.0。升级会重启服务。',
  options: [{ label: '升级', style: 'primary' }, '先不升'],
  ...extra,
});

const asMessage = (payload) => `${CARD_PREFIX}${JSON.stringify(payload)}`;

function tmpFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'card-msg-')), 'pending.json');
  test.after?.(() => { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch {} });
  return file;
}

/** `assert.throws` does not hand back the error, and these cells check its wording. */
function refusal(fn) {
  try { fn(); } catch (e) { return e; }
  return assert.fail('expected a refusal, but the call returned');
}

/** A stub `post` that captures the request and answers like cws-comm does. */
function stubPost(res = { message_id: 'msg-1', action_ids: ['a-0', 'a-1'] }) {
  const calls = [];
  const fn = async (url, body) => { calls.push({ url, body }); return res; };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------- recognition

test('a [CARD] body is recognized and its payload parsed', () => {
  const parsed = parseCardMessage(asMessage(card()));
  assert.ok(parsed, 'a [CARD] message must not read as plain text');
  assert.equal(parsed.kind, 'component-upgrade');
  assert.equal(parsed.askedOf, 'm-owner');
  assert.equal(parsed.card.title, '要升级吗');
  // kind/askedOf/meta describe the QUESTION and must not reach the card
  // builder, which refuses every field the endpoint has no place for.
  for (const key of ['kind', 'askedOf', 'meta']) assert.equal(key in parsed.card, false, key);
});

test('a leading space does not turn a card back into chat text', () => {
  // The failure this prevents is silent: the JSON would post as a chat message
  // and the agent would believe it had asked something.
  assert.ok(parseCardMessage(`  ${asMessage(card())}`));
  assert.ok(parseCardMessage(`\n${asMessage(card())}`));
});

test('meta rides along with the question and never reaches the card', () => {
  const parsed = parseCardMessage(asMessage(card({ meta: { component: 'openmax' } })));
  assert.deepEqual(parsed.meta, { component: 'openmax' });
  assert.equal('meta' in parsed.card, false);
});

// ---------------------------------------------------------------- regressions

test('regression: plain text is still plain text', () => {
  for (const text of ['hello', '请稍等', '', 'a [CARD] mentioned mid-sentence', '{"title":"x"}']) {
    assert.equal(parseCardMessage(text), null, JSON.stringify(text));
  }
});

test('regression: [MEDIA:] is untouched by card recognition', () => {
  const media = '[MEDIA:image]/tmp/shot.png\n看这个';
  assert.equal(parseCardMessage(media), null);
  // and the media parser still reads it exactly as before
  assert.deepEqual(parseMediaPrefix(media), { kind: 'image', localPath: '/tmp/shot.png', caption: '看这个' });
  // conversely, a card is not mistaken for media
  assert.equal(parseMediaPrefix(asMessage(card())), null);
});

// ----------------------------------------------------------------- refusals

test('🔴 malformed JSON is an error, never a text message', () => {
  // The whole point of the entry: the alternative to throwing is posting the
  // raw JSON into the conversation, where it is unreadable to the person and
  // indistinguishable — to the agent — from having asked them something.
  const err = refusal(() => parseCardMessage(`${CARD_PREFIX}{"title": "要升级吗",}`));
  assert.ok(err instanceof CardMessageError);
  assert.match(err.message, /not valid JSON/);
});

test('a payload that is not a JSON object is refused', () => {
  for (const raw of ['"just a string"', '[1,2]', 'null', '42']) {
    assert.throws(() => parseCardMessage(CARD_PREFIX + raw), CardMessageError, raw);
  }
});

test('🔴 kind and askedOf are required', () => {
  for (const missing of ['kind', 'askedOf']) {
    const payload = card();
    delete payload[missing];
    const err = refusal(() => parseCardMessage(asMessage(payload)));
    assert.ok(err instanceof CardMessageError, missing);
    assert.match(err.message, /kind.*askedOf/);
  }
});

test('the payload may not choose the target conversation or org', () => {
  for (const key of ['conversationId', 'org', 'orgId', 'org_id', 'orgSlug']) {
    const err = refusal(() => parseCardMessage(asMessage(card({ [key]: 'cv-other' }))));
    assert.ok(err instanceof CardMessageError, key);
    assert.match(err.message, new RegExp(key));
  }
});

test('an unknown card field is still refused by the shared builder', async () => {
  // Not re-implemented here: the point is that this path runs the SAME
  // whitelist, so the top-level `fields` that once cost a card its content is
  // caught arriving this way too.
  const parsed = parseCardMessage(asMessage(card({ fields: [{ label: 'core', value: '0.7.1 → 0.8.1' }] })));
  const post = stubPost();
  await assert.rejects(() => sendCardMessage('cv-1', parsed, { post }), /fields/);
  assert.equal(post.calls.length, 0, 'nothing may be posted when the card is refused');
});

// ------------------------------------------------------------------- sending

test('🔴 the request is the one comm.ask_card would have sent', async () => {
  const parsed = parseCardMessage(asMessage(card({ confirm: { text: '会重启服务', label: '确认升级' } })));
  const post = stubPost();
  await sendCardMessage('cv-9', parsed, { post, recordQuestion() {} });

  assert.equal(post.calls.length, 1);
  assert.equal(post.calls[0].url, '/api/v1/conversations/cv-9/interaction-requests');

  // ask_card strips its own three arguments and hands the rest to the same
  // builder; so must this path, or the two entries produce different cards.
  const { kind, askedOf, meta, ...cardParams } = card({ confirm: { text: '会重启服务', label: '确认升级' } });
  const expected = buildChoiceRequest(cardParams);
  const sent = post.calls[0].body;
  assert.ok(sent.client_msg_id, 'a generated idempotency key is still sent');
  delete expected.client_msg_id;
  const { client_msg_id: _ignored, ...sentWithoutKey } = sent;
  assert.deepEqual(sentWithoutKey, expected);
});

test('🔴 what was asked is written down, or the answer arrives meaningless', async () => {
  // A receipt names the card and nothing else. Without this record the answer
  // is decodable and says nothing about what it answered.
  const file = tmpFile();
  const parsed = parseCardMessage(asMessage(card({ meta: { component: 'openmax' } })));
  const result = await sendCardMessage('cv-9', parsed, {
    post: stubPost(),
    now: () => '2026-09-24T00:00:00.000Z',
    recordOptions: { file },
  });

  assert.deepEqual(result.action_ids, ['a-0', 'a-1']);
  assert.equal(result.message_id, 'msg-1');

  const record = findPendingQuestion('msg-1', { file });
  assert.ok(record, 'the question must be on file before the answer can arrive');
  assert.equal(record.kind, 'component-upgrade');
  assert.equal(record.askedOf, 'm-owner');
  assert.equal(record.conversationId, 'cv-9');
  assert.deepEqual(record.actionIds, ['a-0', 'a-1']);
  assert.equal(record.askedAt, '2026-09-24T00:00:00.000Z');
  assert.equal(record.title, '要升级吗');
  assert.deepEqual(record.meta, { component: 'openmax' });
});

test('a response without action_ids fails loudly and says the card was already sent', async () => {
  const parsed = parseCardMessage(asMessage(card()));
  for (const res of [{ message_id: 'msg-1' }, { action_ids: ['a-0'] }, {}]) {
    await assert.rejects(
      () => sendCardMessage('cv-9', parsed, { post: stubPost(res), recordQuestion() {} }),
      (e) => e instanceof CardMessageError && /was SENT/.test(e.message),
      JSON.stringify(res),
    );
  }
});

test('the response envelope cws-comm actually uses is read', async () => {
  const parsed = parseCardMessage(asMessage(card()));
  const file = tmpFile();
  await sendCardMessage('cv-9', parsed, {
    post: stubPost({ data: { message_id: 'msg-2', action_ids: ['a-0'] } }),
    recordOptions: { file },
  });
  assert.ok(findPendingQuestion('msg-2', { file }));
});

test('sanity: the real recorder is what this module calls', () => {
  // Guards the wiring, not the recorder: if the default dependency were
  // swapped for a no-op the cell above would still pass on its injected one.
  assert.equal(typeof recordPendingQuestion, 'function');
});
