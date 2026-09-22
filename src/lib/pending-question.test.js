import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearPendingQuestion,
  findPendingQuestion,
  isAnswerAuthorized,
  isExpired,
  listPendingQuestions,
  PENDING_QUESTION_TTL_MS,
  recordPendingQuestion,
} from './pending-question.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pq-')), 'pending-questions.json');
}

const upgrade = (over = {}) => ({
  kind: 'component-upgrade',
  cardMessageId: '7421',
  conversationId: 'dm-1',
  actionIds: ['act_a', 'act_b'],
  askedOf: 'owner-1',
  askedAt: '2026-09-22T00:00:00Z',
  component: 'openmax',
  fromVersion: '2.20.0',
  toVersion: '2.21.0',
  ...over,
});

test('a recorded question is found by the id the receipt will name', () => {
  const file = tmpFile();
  recordPendingQuestion(upgrade(), { file });
  const found = findPendingQuestion('7421', { file });
  assert.equal(found.toVersion, '2.21.0');
  assert.deepEqual(found.actionIds, ['act_a', 'act_b']);
  assert.equal(findPendingQuestion('9999', { file }), null);
});

test('the id matches whether it arrives as a string or a number', () => {
  const file = tmpFile();
  recordPendingQuestion(upgrade({ cardMessageId: 7421 }), { file });
  assert.ok(findPendingQuestion('7421', { file }));
  assert.ok(findPendingQuestion(7421, { file }));
});

test('🔴 a question without action ids is refused, not stored', () => {
  // Storing it would leave an answer that cannot be turned back into an option.
  const file = tmpFile();
  assert.throws(() => recordPendingQuestion(upgrade({ actionIds: [] }), { file }));
  assert.throws(() => recordPendingQuestion(upgrade({ actionIds: undefined }), { file }));
  assert.equal(listPendingQuestions({ file }).length, 0);
});

test('re-asking about the same card replaces the record rather than duplicating it', () => {
  const file = tmpFile();
  recordPendingQuestion(upgrade(), { file });
  recordPendingQuestion(upgrade({ toVersion: '2.22.0' }), { file });
  const all = listPendingQuestions({ file });
  assert.equal(all.length, 1);
  assert.equal(all[0].toVersion, '2.22.0');
});

test('🔴 an answer from anyone but the person asked is not authorized', () => {
  // The interaction protocol has no authorization of its own: anyone in the
  // conversation can press the button.
  const rec = upgrade();
  assert.equal(isAnswerAuthorized(rec, 'owner-1'), true);
  assert.equal(isAnswerAuthorized(rec, 'someone-else'), false);
  assert.equal(isAnswerAuthorized(rec, ''), false);
  assert.equal(isAnswerAuthorized(rec, undefined), false);
  assert.equal(isAnswerAuthorized({ ...rec, askedOf: undefined }, 'owner-1'), false);
});

test('🔴 a late answer is expired, and a missing or unparseable time counts as expired', () => {
  // Acting on a three-week-old "upgrade to v2?" upgrades to a version nobody
  // was asked about.
  const asked = Date.parse('2026-09-22T00:00:00Z');
  const rec = upgrade();
  assert.equal(isExpired(rec, asked + 1000), false);
  assert.equal(isExpired(rec, asked + PENDING_QUESTION_TTL_MS - 1), false);
  assert.equal(isExpired(rec, asked + PENDING_QUESTION_TTL_MS + 1), true);
  assert.equal(isExpired({ ...rec, askedAt: undefined }, asked), true);
  assert.equal(isExpired({ ...rec, askedAt: 'not a date' }, asked), true);
  assert.equal(isExpired(null, asked), true);
});

test('clearing removes only the answered question', () => {
  const file = tmpFile();
  recordPendingQuestion(upgrade(), { file });
  recordPendingQuestion(upgrade({ cardMessageId: '7422' }), { file });
  assert.equal(clearPendingQuestion('7421', { file }), 1);
  assert.equal(listPendingQuestions({ file }).length, 1);
  assert.equal(clearPendingQuestion('7421', { file }), 0);
});

test('a missing or corrupt file yields no question instead of throwing', () => {
  // Every inbound receipt reads this file; a parse error must not become a
  // crash on the message path.
  const file = tmpFile();
  assert.equal(findPendingQuestion('7421', { file }), null);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.equal(findPendingQuestion('7421', { file }), null);
  assert.deepEqual(listPendingQuestions({ file }), []);
  fs.writeFileSync(file, '{"not":"an array"}');
  assert.deepEqual(listPendingQuestions({ file }), []);
});
