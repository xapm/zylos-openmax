import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point RUNTIME_DIR (session.js / inbox-ledger.js) at a throwaway HOME before
// importing anything that reads it. These tests drive the REAL production
// orchestration functions (commitIdentityRebind / seedSessionFromLedger) against
// the REAL ledger + session stores, so a regression in the write order or the
// adopt-ledger guard actually fails here (the previous hand-rolled tests didn't).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zom-rebind-'));
process.env.HOME = tmpHome;
const RUNTIME_DIR = path.join(tmpHome, 'zylos/components/openmax/runtime');

const { createInboxLedger } = await import('./inbox-ledger.js');
const { loadOrgSession, saveOrgSession } = await import('./session.js');
const { commitIdentityRebind, seedSessionFromLedger } = await import('./inbox-rebind.js');

const noop = () => {};
function seedLedgerFile(slug, data) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNTIME_DIR, `inbox-${slug}.json`), JSON.stringify(data));
}

// Reproduce the startOrgWs post-load seeding on a (re)boot for the given org +
// current identity, driving the SAME production helpers comm-bridge uses:
//   - load the persisted session cursor,
//   - build the ledger (which DETECTS an identity change on load),
//   - apply `if (syncSeq > 0) setAckedSeq(syncSeq)` (comm-bridge :2263),
//   - run seedSessionFromLedger (the adopt-ledger guard).
// Returns { ledger, sessionRef, rebindPending }.
function bootOrg(slug, memberId) {
  const session = loadOrgSession(slug) || {};
  const syncSeq = session.sync_seq ?? session.last_seq ?? 0;
  const sessionRef = { sync_seq: syncSeq };
  const ledger = createInboxLedger(slug, { log: noop, memberId });
  const rebindPending = !!ledger.getIdentityChange();
  if (syncSeq > 0) ledger.setAckedSeq(syncSeq);
  seedSessionFromLedger({
    orgSlug: slug,
    sessionRef,
    ledgerAcked: ledger.getAckedSeq(),
    identityRebindPending: rebindPending,
    saveOrgSession,
    log: noop,
  });
  return { ledger, sessionRef, rebindPending };
}

// -----------------------------------------------------------------------------
// commitIdentityRebind — crash-safe durable write order (#148/#151 P1)
// -----------------------------------------------------------------------------

test('commitIdentityRebind: crash before the 2nd durable write leaves a retriable mismatch, no shadow', () => {
  const slug = 'rebind-crash';
  // Pre-migration steady state: old identity + high watermark in BOTH stores.
  seedLedgerFile(slug, { member_id: 'old', acked_seq: 2313, received: [2313] });
  saveOrgSession(slug, { sync_seq: 2313 });

  const anchor = 5;   // the new identity's server last_delivered_seq
  const ledger = createInboxLedger(slug, { log: noop, memberId: 'new' });
  assert.ok(ledger.getIdentityChange(), 'mismatch detected pre-rebind');

  // Order-agnostic crash injector: wrap both durable-write collaborators with a
  // shared counter; the SECOND write throws BEFORE its side effect. Whichever
  // write commitIdentityRebind performs first survives; the second does not —
  // exactly a process death between the two durable writes.
  let writes = 0;
  const crashOnSecond = (fn) => (...args) => {
    writes += 1;
    if (writes === 2) throw new Error('simulated crash before 2nd durable write');
    return fn(...args);
  };
  const wrappedSave = crashOnSecond((s, p) => saveOrgSession(s, p));
  const ledgerProxy = { rebindIdentity: crashOnSecond((id, a) => ledger.rebindIdentity(id, a)) };

  assert.throws(
    () => commitIdentityRebind({
      orgSlug: slug,
      sessionRef: { sync_seq: 2313 },
      inboxLedger: ledgerProxy,
      memberId: 'new',
      anchor,
      saveOrgSession: wrappedSave,
    }),
    /simulated crash/,
  );

  // Restart, driving the real boot seeding. With the crash-safe order the
  // member_id commit is the write that DIDN'T happen, so the mismatch survives
  // and the (still-high) watermark is never lowered to a value that would shadow.
  const { ledger: rebooted, rebindPending } = bootOrg(slug, 'new');
  assert.deepEqual(rebooted.getIdentityChange(), { previousMemberId: 'old', currentMemberId: 'new' },
    'crash before the member_id commit leaves a retriable mismatch');
  assert.equal(rebindPending, true, 'the reboot still sees a pending rebind');
  assert.equal(rebooted.getAckedSeq(), 2313, 'the old watermark was not lowered/lost — no silent shadow gap');

  // The retry now completes cleanly (both writes succeed).
  const sessionRef = { sync_seq: rebooted.getAckedSeq() };
  commitIdentityRebind({
    orgSlug: slug, sessionRef, inboxLedger: rebooted, memberId: 'new', anchor, saveOrgSession,
  });
  assert.equal(rebooted.getIdentityChange(), null, 'retry resolves the mismatch');
  assert.equal(rebooted.getAckedSeq(), 5, 'watermark reseeded to the anchor — new inbound no longer shadowed');
  assert.equal(rebooted.record(6), true, 'a new-identity pending seq is delivered');
});

test('commitIdentityRebind: both writes complete → reboot is clean (no mismatch, reseeded watermark)', () => {
  const slug = 'rebind-ok';
  seedLedgerFile(slug, { member_id: 'old', acked_seq: 2313, received: [2313] });
  saveOrgSession(slug, { sync_seq: 2313 });

  const ledger = createInboxLedger(slug, { log: noop, memberId: 'new' });
  assert.ok(ledger.getIdentityChange());
  commitIdentityRebind({
    orgSlug: slug, sessionRef: { sync_seq: 2313 }, inboxLedger: ledger,
    memberId: 'new', anchor: 5, saveOrgSession,
  });
  assert.equal(loadOrgSession(slug).sync_seq, 5, 'session cursor persisted to the anchor');
  ledger.stop();

  const { ledger: rebooted } = bootOrg(slug, 'new');
  assert.equal(rebooted.getIdentityChange(), null, 'no mismatch after a completed rebind');
  assert.equal(rebooted.getAckedSeq(), 5, 'watermark stable at the reseeded anchor — no shadow');
  assert.equal(rebooted.record(6), true, 'new inbound flows');
});

// -----------------------------------------------------------------------------
// seedSessionFromLedger — the adopt-ledger `!identityRebindPending` guard
// -----------------------------------------------------------------------------

test('seedSessionFromLedger: does NOT adopt the stale ledger watermark while a rebind is pending', () => {
  const slug = 'seed-guard';
  // Ledger has the OLD identity + a high watermark; session file absent (empty
  // cursor). A migrated agent boots here with a pending rebind.
  seedLedgerFile(slug, { member_id: 'old', acked_seq: 2313 });
  const { sessionRef, rebindPending, ledger } = bootOrg(slug, 'new');

  assert.equal(rebindPending, true, 'rebind is pending on this boot');
  assert.ok(ledger.getIdentityChange());
  // The guard must have suppressed the adopt-ledger seeding: the session cursor
  // stays empty and nothing is written to session.json — so onOpen re-seeds from
  // /sync/status instead of inheriting the stale high watermark.
  assert.equal(sessionRef.sync_seq, 0, 'session cursor NOT seeded to the stale (old) watermark');
  assert.equal(loadOrgSession(slug), null, 'nothing persisted to session.json while a rebind is pending');
});

test('seedSessionFromLedger: DOES adopt the ledger watermark when the cursor is empty and no rebind is pending', () => {
  const slug = 'seed-adopt';
  // Same identity (no change) but the session file was lost — the warm-agent
  // recovery this guard must NOT break.
  seedLedgerFile(slug, { member_id: 'm1', acked_seq: 42 });
  const { sessionRef, rebindPending } = bootOrg(slug, 'm1');

  assert.equal(rebindPending, false, 'no rebind pending for the same identity');
  assert.equal(sessionRef.sync_seq, 42, 'ledger watermark adopted as the session cursor');
  assert.equal(loadOrgSession(slug).sync_seq, 42, 'persisted to session.json');
});
