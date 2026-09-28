import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageHasUsableContent, resolveInboundContent } from './inbound-content.js';

// ---------------------------------------------------------------------------
// messageHasUsableContent — "usable" mirrors the forward path's extraction.
// ---------------------------------------------------------------------------

test('messageHasUsableContent: text in content.body.text is usable', () => {
  assert.equal(messageHasUsableContent({ content: { body: { text: 'hi' } } }), true);
});

test('messageHasUsableContent: string message.content is usable', () => {
  assert.equal(messageHasUsableContent({ message: { content: 'hello' } }), true);
});

test('messageHasUsableContent: media-only (attachments, no text) is usable', () => {
  assert.equal(
    messageHasUsableContent({ content: { body: { text: '' }, attachments: [{ artifact_id: 'a1' }] } }),
    true,
  );
});

test('messageHasUsableContent: legacy flat media_id is usable', () => {
  assert.equal(messageHasUsableContent({ content: { media_id: 'm1' } }), true);
});

test('messageHasUsableContent: null / metadata-only frame is NOT usable', () => {
  assert.equal(messageHasUsableContent(null), false);
  assert.equal(messageHasUsableContent({ id: '1', conversation_id: 'c', sender_id: 's' }), false);
});

test('messageHasUsableContent: whitespace-only text is NOT usable', () => {
  assert.equal(messageHasUsableContent({ content: { body: { text: '   ' } } }), false);
});

// ---------------------------------------------------------------------------
// resolveInboundContent — retry-once + realtime-vs-sync decision.
// ---------------------------------------------------------------------------

const noSleep = async () => {};
const realtimeFrame = { id: 'm1', conversation_id: 'c1', sender_id: 's1' };
const syncFrame = { id: 'm1', conversation_id: 'c1', seq: 42, _via: 'sync' };

test('(a) fetch fails once then succeeds on retry → status ok, forwarded normally', async () => {
  let calls = 0;
  const getDetail = async () => {
    calls += 1;
    if (calls === 1) return null;                     // first attempt fails
    return { content: { body: { text: 'the real body' } } }; // retry succeeds
  };
  const r = await resolveInboundContent({ getDetail, notification: realtimeFrame, sleep: noSleep });
  assert.equal(calls, 2, 'exactly one retry (total 2 GETs)');
  assert.equal(r.status, 'ok');
  assert.equal(r.attempts, 2);
  assert.equal(r.detail.content.body.text, 'the real body');
});

test('first attempt succeeds → no retry issued', async () => {
  let calls = 0;
  const getDetail = async () => { calls += 1; return { content: { body: { text: 'ok' } } }; };
  const r = await resolveInboundContent({ getDetail, notification: realtimeFrame, sleep: noSleep });
  assert.equal(calls, 1);
  assert.equal(r.status, 'ok');
  assert.equal(r.attempts, 1);
});

test('(b) fetch fails both times on a REALTIME frame → skip-empty + forceReconnect', async () => {
  let calls = 0;
  const getDetail = async () => { calls += 1; return null; };
  const r = await resolveInboundContent({ getDetail, notification: realtimeFrame, sleep: noSleep });
  assert.equal(calls, 2, 'first attempt + one retry');
  assert.equal(r.status, 'skip-empty', 'not forwarded');
  assert.equal(r.via, 'realtime');
  assert.equal(r.forceReconnect, true, 'realtime path forces a WS reconnect');
});

test('(c) fetch fails both times on a SYNC-replay frame → skip-empty, NO forceReconnect', async () => {
  let calls = 0;
  const getDetail = async () => { calls += 1; return { content: { body: { text: '' } } }; };
  const r = await resolveInboundContent({ getDetail, notification: syncFrame, sleep: noSleep });
  assert.equal(calls, 2);
  assert.equal(r.status, 'skip-empty', 'not forwarded');
  assert.equal(r.via, 'sync');
  assert.equal(r.forceReconnect, false, 'sync path must NOT re-terminate the WS mid-sweep');
});

test('retries=0 disables the retry (single attempt only)', async () => {
  let calls = 0;
  const getDetail = async () => { calls += 1; return null; };
  const r = await resolveInboundContent({ getDetail, notification: realtimeFrame, retries: 0, sleep: noSleep });
  assert.equal(calls, 1);
  assert.equal(r.status, 'skip-empty');
});

test('a media-only detail on retry counts as usable (not over-narrowed to text)', async () => {
  let calls = 0;
  const getDetail = async () => {
    calls += 1;
    if (calls === 1) return null;
    return { content: { body: { text: '' }, attachments: [{ artifact_id: 'img1' }] } };
  };
  const r = await resolveInboundContent({ getDetail, notification: realtimeFrame, sleep: noSleep });
  assert.equal(r.status, 'ok');
  assert.equal(r.attempts, 2);
});

test('delay is applied between attempts via injected sleep', async () => {
  const delays = [];
  const sleep = async (ms) => { delays.push(ms); };
  const getDetail = async () => null;
  await resolveInboundContent({ getDetail, notification: realtimeFrame, delayMs: 350, sleep });
  assert.deepEqual(delays, [350], 'one delay, before the single retry');
});

// ---------------------------------------------------------------------------
// TRANSIENT (getDetail THROWS) vs POISON (getDetail returns empty) — the
// distinction that stops a brief GET outage from permanently dropping a message.
// ---------------------------------------------------------------------------

test('getDetail THROWS on every attempt → status "error" (transient), NOT skip-empty', async () => {
  let calls = 0;
  const getDetail = async () => { calls += 1; throw new Error('503 upstream'); };
  const r = await resolveInboundContent({ getDetail, notification: syncFrame, sleep: noSleep });
  assert.equal(calls, 2, 'first attempt + one retry');
  assert.equal(r.status, 'error', 'a thrown fetch is transient, never poison');
  assert.equal(r.via, 'sync');
  assert.equal(r.forceReconnect, false, 'sync path must not re-terminate mid-sweep');
  assert.match(r.error, /503/);
});

test('getDetail THROWS on a REALTIME frame → error + forceReconnect', async () => {
  const getDetail = async () => { throw new Error('ECONNRESET'); };
  const r = await resolveInboundContent({ getDetail, notification: realtimeFrame, sleep: noSleep });
  assert.equal(r.status, 'error');
  assert.equal(r.forceReconnect, true);
});

test('transient throw then a successful body → status ok (recovered, not dropped)', async () => {
  let calls = 0;
  const getDetail = async () => {
    calls += 1;
    if (calls === 1) throw new Error('429 rate limited');
    return { content: { body: { text: 'the real body' } } };
  };
  const r = await resolveInboundContent({ getDetail, notification: syncFrame, sleep: noSleep });
  assert.equal(r.status, 'ok');
  assert.equal(r.attempts, 2);
});

test('empty body that never throws → status skip-empty (poison), the only skip-eligible case', async () => {
  const getDetail = async () => ({ content: { body: { text: '' } } });
  const r = await resolveInboundContent({ getDetail, notification: syncFrame, sleep: noSleep });
  assert.equal(r.status, 'skip-empty');
});

test('bias to transient: last attempt throws (after an empty) → error, not skip-empty', async () => {
  let calls = 0;
  const getDetail = async () => {
    calls += 1;
    if (calls === 1) return { content: { body: { text: '' } } }; // empty
    throw new Error('500'); // terminal attempt throws → treat as transient
  };
  const r = await resolveInboundContent({ getDetail, notification: syncFrame, sleep: noSleep });
  assert.equal(r.status, 'error', 'a terminal throw biases to transient (never wrongly skip)');
});

test('a receipt with an answer but no text is usable, not empty', () => {
  // The contract requires body.text, but a producer that omits it would
  // otherwise leave the cursor un-advanced and park the org's whole inbox.
  assert.equal(messageHasUsableContent({
    type: 'INTERACTION_RECEIPT',
    sender_type: 'SYSTEM',
    content: {
      content_type: 'interaction_receipt',
      body: { origin: { conversation_id: 'c1' }, selected_action_ids: ['opt_0'] },
    },
  }), true);
});

// ⚠️ Renamed: this used to be called "a text-less structured message that is not a
// receipt is still empty", which overstated what it pins. A card IS a text-less
// non-receipt structured message and is now usable — what makes THIS one empty is
// that its body has no readable projection at all: no `blocks`, no `fallback_text`.
test('a structured body with no readable projection at all is still empty', () => {
  assert.equal(messageHasUsableContent({
    type: 'AGENT_STRUCTURED',
    sender_type: 'AGENT',
    content: {
      content_type: 'json',
      body: { origin: { conversation_id: 'c1' }, selected_action_ids: ['opt_0'] },
    },
  }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Cards and the other schema-only bodies
//
// A card body's top-level keys are exactly `actions, blocks, kind, mode, schema,
// summary, title` — there is no `text`. Before these, `messageHasUsableContent`
// returned false for every card, which stalls the org's whole /sync backlog
// behind it (the cursor is not advanced) until the give-up alarm skips it with
// `possible data loss`.
// ─────────────────────────────────────────────────────────────────────────────

const cardMsg = (over = {}) => ({
  type: 'CARD',
  sender_type: 'AGENT',
  content: {
    content_type: 'card',
    body: {
      schema: 'cws.card.v1',
      kind: 'interaction.choice',
      mode: 'display',
      title: '要升级哪些组件?',
      summary: 'dashboard 0.5.4 -> 0.5.5',
      blocks: [{ type: 'text', text: '两个组件有新版本。' }],
      actions: [{ id: 'opt_1', kind: 'ui', operation: 'ui.quick_reply', label: '只升 dashboard' }],
      ...over,
    },
  },
});

test('a card body has usable content even though it has no body.text', () => {
  assert.equal(messageHasUsableContent(cardMsg()), true);
});

test('a card arriving in the nested get-message envelope is usable too', () => {
  // The detail path puts the body under `message.content.body`, and cws-comm
  // nulls `message.content` on that path — so this shape must be reached from
  // the nested side, not the top-level one.
  const { content } = cardMsg();
  assert.equal(messageHasUsableContent({ type: 'CARD', sender_type: 'AGENT', message: { content } }), true);
});

test('a schema-only body with no blocks is usable via its message-level fallback_text', () => {
  // channel_qr / channel_confirmation shape: no text, no blocks, no attachments.
  assert.equal(messageHasUsableContent({
    type: 'AGENT_STRUCTURED',
    sender_type: 'AGENT',
    content: { content_type: 'channel_qr', body: { schema: 'openmax.channel-qr.v1', channel_type: 'lark' } },
    message: { fallback_text: '扫码连接 lark' },
  }), true);
});

test('a card whose blocks carry no prose still survives on title alone', () => {
  assert.equal(messageHasUsableContent(cardMsg({ blocks: [{ type: 'divider' }] })), true);
});
