import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point RUNTIME_DIR (session.js: path.join(process.env.HOME, 'zylos/components/openmax/runtime'))
// at a throwaway HOME so the ledger's persisted file never touches a real
// component data dir. Must be set before importing the module under test.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zom-ledger-'));
process.env.HOME = tmpHome;
const RUNTIME_DIR = path.join(tmpHome, 'zylos/components/openmax/runtime');
const { createInboxLedger } = await import('./inbox-ledger.js');
const { createDeduper } = await import('./ws.js');
const { MAX_CONTENT_FETCH_ATTEMPTS } = await import('./content-fetch-giveup.js');

const noop = () => {};
function seedLedgerFile(slug, data) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNTIME_DIR, `inbox-${slug}.json`), JSON.stringify(data));
}

test('resetReceived clears a prepare-phase-tainted dedupe set so the backlog re-dispatches (#79)', () => {
  // A comm-bridge started during the runtime prepare phase recorded inbox_seq 2
  // (the activation DM) but never delivered it — persisted as received=[2] with
  // acked_seq=0. On the real first boot the ledger loads that taint.
  seedLedgerFile('taint', { acked_seq: 0, received: [2] });
  const ledger = createInboxLedger('taint', { log: noop });

  // Before the fix: the replay would call record(2) and be deduped away.
  assert.equal(ledger.record(2), false, 'seq 2 is deduped by the tainted "received" set');

  // The first-boot path clears the taint; now the replay dispatches it.
  ledger.resetReceived();
  assert.equal(ledger.record(2), true, 'after resetReceived the activation DM re-dispatches');
});

test('resetReceived preserves the durable acked watermark', () => {
  seedLedgerFile('watermark', { acked_seq: 5, received: [7] });
  const ledger = createInboxLedger('watermark', { log: noop });

  assert.equal(ledger.getAckedSeq(), 5);
  ledger.resetReceived();
  assert.equal(ledger.getAckedSeq(), 5, 'acked_seq is untouched by resetReceived');
  // Anything at/below the watermark is still considered delivered (deduped)...
  assert.equal(ledger.record(5), false, 'seq <= acked_seq stays deduped');
  // ...while a fresh higher seq is accepted again (the received set was cleared).
  assert.equal(ledger.record(7), true, 'previously-seen higher seq is re-accepted after reset');
});

test('resetReceived on an empty ledger is a no-op', () => {
  const ledger = createInboxLedger('empty', { log: noop });
  assert.doesNotThrow(() => ledger.resetReceived());
  assert.equal(ledger.getAckedSeq(), 0);
});

test('first-boot recovery clears BOTH persisted taint layers (dedup.json + inbox ledger) — #79 P1', () => {
  // A comm-bridge started during the runtime prepare phase persisted the
  // activation DM into BOTH dedupe layers but never delivered it: the message-id
  // deduper (dedup.json) and the inbox-seq ledger (inbox-*.json). On the real
  // first boot the replay must clear both, or the message-id layer (checked
  // first, before the ledger) silently suppresses the backlog again.
  const dedupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zom-both-'));
  const dedupPath = path.join(dedupDir, 'dedup.json');
  fs.writeFileSync(dedupPath, JSON.stringify({ 'msg-activation': 1 }));
  seedLedgerFile('both', { acked_seq: 0, received: [7] });

  const dedupe = createDeduper({ persistPath: dedupPath });
  const ledger = createInboxLedger('both', { log: noop });

  // Before recovery: either layer alone would suppress the replay.
  assert.equal(dedupe('msg-activation'), true, 'id-dedupe suppresses (tainted dedup.json)');
  assert.equal(ledger.record(7), false, 'seq-ledger suppresses (tainted inbox ledger)');

  // First-boot recovery: forget the id + clear the ledger received set.
  dedupe.forget('msg-activation');
  ledger.resetReceived();

  // After recovery: the activation DM re-dispatches through both layers.
  assert.equal(dedupe('msg-activation'), false, 'id-dedupe now admits the activation DM');
  assert.equal(ledger.record(7), true, 'seq-ledger now admits the activation DM');
});

// ---------------------------------------------------------------------------
// Bounded content-fetch give-up (catch-up-wedge fix; follow-on to #79)
// ---------------------------------------------------------------------------

test('recordContentFetchFailure counts up and reports give-up at the cap', () => {
  const ledger = createInboxLedger('giveup-count', { log: noop });
  let r;
  for (let i = 0; i < MAX_CONTENT_FETCH_ATTEMPTS; i++) r = ledger.recordContentFetchFailure(1);
  assert.equal(r.failures, MAX_CONTENT_FETCH_ATTEMPTS);
  assert.equal(r.giveUp, true, 'gives up at the cap');
  // The failure BEFORE the cap must not give up.
  const ledger2 = createInboxLedger('giveup-count-2', { log: noop });
  for (let i = 0; i < MAX_CONTENT_FETCH_ATTEMPTS - 1; i++) r = ledger2.recordContentFetchFailure(1);
  assert.equal(r.giveUp, false, 'does not give up below the cap');
});

test('recordContentFetchFailure is a no-op at/behind the watermark', () => {
  seedLedgerFile('giveup-behind', { acked_seq: 5 });
  const ledger = createInboxLedger('giveup-behind', { log: noop });
  assert.equal(ledger.recordContentFetchFailure(5), null, 'seq == acked_seq is ignored');
  assert.equal(ledger.recordContentFetchFailure(3), null, 'seq < acked_seq is ignored');
  assert.equal(ledger.recordContentFetchFailure(0), null, 'non-positive seq is ignored');
});

test('the durable failure count SURVIVES a reload (cross-restart persistence)', () => {
  const slug = 'giveup-persist';
  const ledgerA = createInboxLedger(slug, { log: noop });
  // Two failures accumulate, then the process "restarts" (stop flushes to disk).
  ledgerA.recordContentFetchFailure(1);
  ledgerA.recordContentFetchFailure(1);
  assert.equal(ledgerA.getContentFetchFailureCount(1), 2);
  ledgerA.stop();

  // A fresh ledger loads the persisted file — the count continues, it does not
  // reset. Without this, an "empty head + repeated reconnect/restart" loop would
  // never reach the cap and the sweep would wedge forever.
  const ledgerB = createInboxLedger(slug, { log: noop });
  assert.equal(ledgerB.getContentFetchFailureCount(1), 2, 'count persisted across reload');
  // Continue accumulating toward the cap across the reload boundary.
  let r;
  for (let i = 2; i < MAX_CONTENT_FETCH_ATTEMPTS; i++) r = ledgerB.recordContentFetchFailure(1);
  assert.equal(r.failures, MAX_CONTENT_FETCH_ATTEMPTS);
  assert.equal(r.giveUp, true, 'reaches give-up after reload continues the count');
});

test('clearContentFetchFailure resets the counter (only consecutive failures count)', () => {
  const ledger = createInboxLedger('giveup-clear', { log: noop });
  ledger.recordContentFetchFailure(1);
  ledger.recordContentFetchFailure(1);
  assert.equal(ledger.getContentFetchFailureCount(1), 2);
  ledger.clearContentFetchFailure(1);
  assert.equal(ledger.getContentFetchFailureCount(1), 0, 'a successful fetch resets the count');
});

test('skip advances the watermark past an unfetchable head and clears its counter', () => {
  // received=[3,5,7] with acked_seq=0: the sweep is wedged waiting for seq 1/2.
  seedLedgerFile('giveup-skip', { acked_seq: 0, received: [3, 5, 7] });
  const ledger = createInboxLedger('giveup-skip', { log: noop });
  ledger.recordContentFetchFailure(1);
  assert.equal(ledger.getAckedSeq(), 0, 'still wedged before skip');

  ledger.skip(1);
  assert.equal(ledger.getAckedSeq(), 1, 'watermark advanced past the skipped head');
  assert.equal(ledger.getContentFetchFailureCount(1), 0, 'skipped seq counter cleared');

  // Once the gap behind it fills, the watermark runs on contiguously.
  ledger.record(2);
  assert.equal(ledger.getAckedSeq(), 3, 'watermark advances 2→3 once seq 2 arrives');
});

test('a skipped head is CONSUMED, not a permanent hole: no re-gap / re-retry on it (review nit)', () => {
  // Reviewer nit-2: after skip(seq), the seq must be treated as consumed so the
  // gap-detector never re-triggers /sync on it and a late duplicate can't revive
  // the wedge. received=[2,3] with acked_seq=0 is wedged on the seq-1 head.
  const gapCalls = [];
  seedLedgerFile('giveup-skip-consumed', { acked_seq: 0, received: [2, 3] });
  const ledger = createInboxLedger('giveup-skip-consumed', {
    log: noop,
    onGapSync: (sinceSeq) => gapCalls.push(sinceSeq),
  });

  ledger.skip(1);
  // skip(1) fills the hole → watermark runs contiguously over the already-received 2,3.
  assert.equal(ledger.getAckedSeq(), 3, 'watermark advanced past skipped seq 1 and on over 2,3');
  assert.equal(ledger.getContentFetchFailureCount(1), 0, 'skipped seq counter cleared');

  // A late re-pull of seq 1 (now < watermark) is ignored — not re-dispatched,
  // not re-counted, no new gap.
  assert.equal(ledger.record(1), false, 'skipped seq 1 stays consumed (record ignored)');
  assert.equal(ledger.recordContentFetchFailure(1), null, 'no counter re-armed for a consumed seq');
  assert.deepEqual(gapCalls, [], 'no gap re-triggered on the skipped head');
});

test('advancing the watermark prunes stale failure counters', () => {
  const ledger = createInboxLedger('giveup-prune', { log: noop });
  ledger.recordContentFetchFailure(1); // counter for seq 1
  // seq 1 later arrives successfully and the watermark advances over it.
  ledger.record(1);
  assert.equal(ledger.getAckedSeq(), 1);
  assert.equal(ledger.getContentFetchFailureCount(1), 0, 'consumed seq counter pruned');
});

test('reload drops failure counters for seqs already at/behind the watermark', () => {
  seedLedgerFile('giveup-load-prune', { acked_seq: 5, fetch_failures: { '3': 2, '7': 1 } });
  const ledger = createInboxLedger('giveup-load-prune', { log: noop });
  assert.equal(ledger.getContentFetchFailureCount(3), 0, 'stale (<=acked) counter dropped on load');
  assert.equal(ledger.getContentFetchFailureCount(7), 1, 'live (>acked) counter kept on load');
});

// ---------------------------------------------------------------------------
// Identity binding + watermark-inversion alarm (#148)
// ---------------------------------------------------------------------------

test('identity change is DETECTED on load but the ledger is NOT reset until rebind (#148)', () => {
  // A migrated agent: the persisted ledger belongs to member "old" with a high
  // watermark, but self.member_id is now "new" (whose server inbox restarted at
  // 1). Owner decision: do NOT reset on load — keep the stale watermark in force
  // (so the inversion alarm fires) until /sync/status can reseed deterministically.
  seedLedgerFile('id-change', { member_id: 'old', acked_seq: 2313, received: [2313], fetch_failures: { '2400': 3 } });
  const warnings = [];
  const ledger = createInboxLedger('id-change', { log: noop, warn: (m) => warnings.push(m), memberId: 'new' });

  assert.deepEqual(ledger.getIdentityChange(), { previousMemberId: 'old', currentMemberId: 'new' });
  assert.equal(ledger.getAckedSeq(), 2313, 'watermark unchanged on load — no blind reset');
  assert.equal(ledger.getContentFetchFailureCount(2400), 3, 'failure counters unchanged on load');
  assert.equal(ledger.record(2), false, 'new low seqs still shadowed by the stale watermark pre-rebind');
  assert.ok(
    warnings.some((m) => /identity change detected old→new/.test(m)),
    'a detection WARN was emitted',
  );
});

test('rebindIdentity resets, reseeds to the server anchor, and adopts the new member_id (#148)', () => {
  seedLedgerFile('id-rebind', { member_id: 'old', acked_seq: 2313, received: [2313], fetch_failures: { '2400': 3 } });
  const ledger = createInboxLedger('id-rebind', { log: noop, memberId: 'new' });
  assert.ok(ledger.getIdentityChange(), 'change detected');

  // Server reports the new identity's last_delivered_seq=5 — reseed to it.
  ledger.rebindIdentity('new', 5);
  assert.equal(ledger.getIdentityChange(), null, 'flag cleared after a successful rebind');
  assert.equal(ledger.getAckedSeq(), 5, 'watermark reseeded to the server anchor');
  assert.equal(ledger.getContentFetchFailureCount(2400), 0, 'stale failure counters dropped by the rebind');
  assert.equal(ledger.record(6), true, 'a pending seq above the anchor is accepted');   // advances 5→6
  assert.equal(ledger.record(5), false, 'the seq at the anchor is deduped');

  // The new member_id is persisted, so a reload sees no further change; the
  // watermark carried is 6 (record(6) advanced it past the reseed anchor).
  ledger.stop();
  const reloaded = createInboxLedger('id-rebind', { log: noop, memberId: 'new' });
  assert.equal(reloaded.getIdentityChange(), null, 'new member_id persisted → no re-detection');
  assert.equal(reloaded.getAckedSeq(), 6, 'reseed + subsequent delivery persisted across reload');
});

test('rebindIdentity accepts a legitimate anchor of 0 (#148)', () => {
  seedLedgerFile('id-rebind-0', { member_id: 'old', acked_seq: 2313 });
  const ledger = createInboxLedger('id-rebind-0', { log: noop, memberId: 'new' });
  ledger.rebindIdentity('new', 0);
  assert.equal(ledger.getAckedSeq(), 0, 'anchor 0 fully resets the watermark');
  assert.equal(ledger.record(1), true, 'the new inbox replays from seq 1');
});

test('deferred reseed: without a rebind the old member_id + watermark persist so the change re-detects (#148)', () => {
  // Models the /sync/status-unavailable path: comm-bridge does NOT call
  // rebindIdentity, so the ledger must keep the OLD identity on disk and the old
  // watermark, so the pending change survives a restart and is retried.
  const slug = 'id-defer';
  seedLedgerFile(slug, { member_id: 'old', acked_seq: 2313, received: [2313] });
  const a = createInboxLedger(slug, { log: noop, memberId: 'new' });
  assert.ok(a.getIdentityChange(), 'change detected');
  a.stop();   // persists — must NOT adopt "new"

  const b = createInboxLedger(slug, { log: noop, memberId: 'new' });
  assert.deepEqual(b.getIdentityChange(), { previousMemberId: 'old', currentMemberId: 'new' },
    're-detected after restart because the new member_id was NOT adopted');
  assert.equal(b.getAckedSeq(), 2313, 'watermark still the old one — never blindly reset');

  // Now /sync/status is reachable → rebind succeeds and adopts the new identity.
  b.rebindIdentity('new', 4);
  b.stop();
  const c = createInboxLedger(slug, { log: noop, memberId: 'new' });
  assert.equal(c.getIdentityChange(), null, 'after a successful rebind the change is resolved');
  assert.equal(c.getAckedSeq(), 4, 'the reseeded watermark is what persists');
});

test('same identity preserves the watermark; no change (#148)', () => {
  seedLedgerFile('id-same', { member_id: 'm1', acked_seq: 42, received: [45] });
  const ledger = createInboxLedger('id-same', { log: noop, memberId: 'm1' });
  assert.equal(ledger.getIdentityChange(), null, 'no identity change reported');
  assert.equal(ledger.getAckedSeq(), 42, 'watermark preserved for the same identity');
  assert.equal(ledger.record(10), false, 'seq below the preserved watermark still deduped');
});

test('member_id is persisted and detected (not reset) across a reload (#148)', () => {
  const slug = 'id-persist';
  const a = createInboxLedger(slug, { log: noop, memberId: 'first' });
  a.record(1);
  a.stop();
  // Same identity next boot: no change.
  const b = createInboxLedger(slug, { log: noop, memberId: 'first' });
  assert.equal(b.getIdentityChange(), null, 'persisted member_id matches → no change');
  assert.equal(b.getAckedSeq(), 1, 'watermark carried across reload');
  // A different identity next boot: change DETECTED, but watermark not reset yet.
  const c = createInboxLedger(slug, { log: noop, memberId: 'second' });
  assert.deepEqual(c.getIdentityChange(), { previousMemberId: 'first', currentMemberId: 'second' });
  assert.equal(c.getAckedSeq(), 1, 'detection only — watermark not reset until rebind');
});

test('a missing current member_id neither triggers a change nor clobbers the stored id (#148)', () => {
  const slug = 'id-missing';
  seedLedgerFile(slug, { member_id: 'keep', acked_seq: 7 });
  // Run with no memberId (e.g. identity not hydrated yet): must not false-trigger.
  const a = createInboxLedger(slug, { log: noop });
  assert.equal(a.getIdentityChange(), null, 'no change when current identity is unknown');
  assert.equal(a.getAckedSeq(), 7, 'watermark preserved');
  a.stop();
  // The stored member_id survives, so a later identity-aware run still detects a change.
  const b = createInboxLedger(slug, { log: noop, memberId: 'other' });
  assert.deepEqual(b.getIdentityChange(), { previousMemberId: 'keep', currentMemberId: 'other' });
});

test('inverted watermark escalates to an ALARM after sustained below-watermark seqs (#148)', () => {
  // Stale high watermark with no member_id recorded (pre-#148 ledger): the
  // migration signature is a run of far-below-watermark seqs. This is the alert
  // that was completely missing — inbound died with zero signal.
  seedLedgerFile('inversion', { acked_seq: 2313 });
  const warnings = [];
  const ledger = createInboxLedger('inversion', { log: noop, warn: (m) => warnings.push(m) });

  // 19 inversions: below the count threshold, still silent.
  for (let i = 1; i <= 19; i++) assert.equal(ledger.record(i), false);
  assert.equal(warnings.length, 0, 'no alarm below the consecutive-count threshold');

  // The 20th consecutive far-below-watermark seq escalates.
  assert.equal(ledger.record(20), false);
  assert.equal(warnings.length, 1, 'alarm fires at the threshold');
  assert.match(warnings[0], /ALARM/);
  assert.match(warnings[0], /silently deduped/);
  // The manual-fix hint must point at last_delivered_seq (the safe seed) and
  // must NOT suggest max_seq — seeding above last_delivered_seq silently drops
  // the pending window (#151 P1).
  assert.match(warnings[0], /last_delivered_seq/, 'alarm points at last_delivered_seq');
  assert.doesNotMatch(warnings[0], /max_seq/, 'alarm must NOT suggest max_seq');
});

test('inversion alarm does not fire when the gap is small (genuine recent duplicates) (#148)', () => {
  // acked_seq=50 and a burst of true duplicates just below it (gap <= 100) is
  // normal reconnect churn, not a migration — must stay silent.
  seedLedgerFile('inversion-smallgap', { acked_seq: 50 });
  const warnings = [];
  const ledger = createInboxLedger('inversion-smallgap', { log: noop, warn: (m) => warnings.push(m) });
  for (let i = 0; i < 40; i++) assert.equal(ledger.record(40 + (i % 10)), false); // seqs 40..49, gap <= 10
  assert.equal(warnings.length, 0, 'no alarm for small-gap duplicates');
});

test('a genuine new delivery resets the inversion run (#148)', () => {
  seedLedgerFile('inversion-reset', { acked_seq: 1000 });
  const warnings = [];
  const ledger = createInboxLedger('inversion-reset', { log: noop, warn: (m) => warnings.push(m) });
  for (let i = 1; i <= 19; i++) assert.equal(ledger.record(i), false); // 19 inversions
  assert.equal(ledger.record(1001), true, 'a real new seq is accepted and resets the run');
  for (let i = 20; i <= 38; i++) assert.equal(ledger.record(i), false); // 19 more, counter restarted
  assert.equal(warnings.length, 0, 'the intervening delivery reset the consecutive counter');
});
