import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// mention.js resolves its registry path from process.env.HOME at import time.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-outbound-chunks-test-'));
process.env.HOME = tmpHome;
const { recordParticipants } = await import('./mention.js');
const { planOutboundChunks, MAX_MENTIONS_PER_MESSAGE } = await import('./outbound-chunks.js');

const LUNA_ID = '019f6a10-1af8-73ef-b9bb-08b28dcaa998';
const GAVIN_ID = '019f6587-ca6c-73fc-afe5-e1b8f9d6d345';

test('a mention in the first chunk is carried by every later chunk (#350)', () => {
  const conv = 'conv-350-first';
  recordParticipants(conv, { name: 'luna.coco', memberId: LUNA_ID });
  const text = `@luna.coco please read\n\n${'a'.repeat(80)}\n\n${'b'.repeat(80)}`;
  const chunks = planOutboundChunks(text, conv, 100);
  assert.ok(chunks.length > 1);
  for (const c of chunks.slice(1)) assert.equal(c.text.includes('@luna.coco'), false);
  for (const c of chunks) {
    assert.deepEqual(c.mentions, [{ type: 'member', member_id: LUNA_ID }]);
  }
});

test('mentions spread across chunks are unioned onto every chunk', () => {
  const conv = 'conv-350-union';
  recordParticipants(conv, { name: 'luna.coco', memberId: LUNA_ID });
  recordParticipants(conv, { name: 'gavin.yang', memberId: GAVIN_ID });
  const text = `@luna.coco first ${'a'.repeat(70)}\n\n@gavin.yang second ${'b'.repeat(70)}`;
  const chunks = planOutboundChunks(text, conv, 100);
  assert.equal(chunks.length, 2);
  for (const c of chunks) {
    assert.deepEqual(
      new Set(c.mentions.map((m) => m.member_id)),
      new Set([LUNA_ID, GAVIN_ID]),
    );
  }
});

test('a broadcast sentinel anywhere in the text applies to every chunk', () => {
  const chunks = planOutboundChunks(`@所有人 请查收\n\n${'a'.repeat(80)}`, 'conv-350-all', 50);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.deepEqual(c.mentions, [{ type: 'all' }]);
});

test('mentions stay undefined (not []) on every chunk when nothing resolves', () => {
  const chunks = planOutboundChunks(`no one here\n\n${'a'.repeat(80)}`, 'conv-350-none', 50);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.equal(c.mentions, undefined);
});

test('a short message is one chunk with its mentions, text unchanged', () => {
  const conv = 'conv-350-short';
  recordParticipants(conv, { name: 'luna.coco', memberId: LUNA_ID });
  assert.deepEqual(planOutboundChunks('@luna.coco hi', conv), [
    { text: '@luna.coco hi', mentions: [{ type: 'member', member_id: LUNA_ID }] },
  ]);
});

test('the mention set is capped at the cws-comm limit, broadcast sentinel kept', () => {
  const conv = 'conv-350-cap';
  const n = MAX_MENTIONS_PER_MESSAGE; // the registry itself keeps at most 200 names per conversation
  const names = [];
  for (let i = 0; i < n; i++) {
    const name = `member${String(i).padStart(3, '0')}`;
    names.push(name);
    recordParticipants(conv, { name, memberId: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}` });
  }
  const text = `@所有人 ${names.map((x) => `@${x}`).join(' ')}`;
  const [chunk] = planOutboundChunks(text, conv, 100000);
  assert.equal(chunk.mentions.length, MAX_MENTIONS_PER_MESSAGE);
  assert.deepEqual(chunk.mentions[0], { type: 'all' });
});
