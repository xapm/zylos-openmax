/**
 * #148 identity-rebind orchestration, extracted from comm-bridge.js so the two
 * crash-safety-critical decisions are exercised by unit tests through the SAME
 * code the production path runs — not a hand-rolled copy of the ordering:
 *
 *   1. commitIdentityRebind — the durable WRITE ORDER of the onOpen rebind.
 *   2. seedSessionFromLedger — the startOrgWs adopt-ledger `!rebindPending` guard.
 *
 * Both take their side-effecting collaborators (saveOrgSession, the ledger) as
 * parameters so a test can inject spies / fault injectors and drive the real
 * ordering + guard. Behavior is equivalent to the previous inline code.
 */

/**
 * Seed the session cursor from the ledger's durable watermark when the session
 * file was lost or empty — so a warm agent whose session.json vanished resumes
 * on the normal catch-up path instead of replaying its whole inbox from zero.
 *
 * BUT never while an identity rebind is pending (#148/#151): the ledger still
 * holds the OLD identity's (high) watermark, so adopting it here would seed the
 * session cursor to the stale value; onOpen re-seeds from /sync/status instead.
 *
 * Returns true iff it seeded.
 */
export function seedSessionFromLedger({
  orgSlug, sessionRef, ledgerAcked, identityRebindPending, saveOrgSession, log,
}) {
  if (!sessionRef.sync_seq && ledgerAcked > 0 && !identityRebindPending) {
    sessionRef.sync_seq = ledgerAcked;
    saveOrgSession(orgSlug, { sync_seq: ledgerAcked });
    log?.(`[${orgSlug}] seeded sync_seq from ledger acked_seq=${ledgerAcked} (session cursor was empty)`);
    return true;
  }
  return false;
}

/**
 * Commit an identity rebind with a CRASH-SAFE durable write order (#148/#151):
 * persist the session cursor to `anchor` FIRST, then commit the ledger rebind —
 * which adopts the new member_id and thereby CLEARS the mismatch — LAST.
 *
 * The mismatch-clearing write MUST be the final durable step. If the process
 * dies between the two writes, the ledger still carries the OLD member_id, so
 * the mismatch is re-detected on restart and the rebind retries; and the session
 * cursor already holds the low `anchor` (not the old high value), so the
 * startOrgWs setAckedSeq reseed can't push the watermark back up. The reverse
 * order would leave a new-identity ledger reseeded to the stale high cursor with
 * no rebind path — the silent re-shadow #151 P1 flags.
 */
export function commitIdentityRebind({
  orgSlug, sessionRef, inboxLedger, memberId, anchor, saveOrgSession,
}) {
  sessionRef.sync_seq = anchor;
  saveOrgSession(orgSlug, { sync_seq: anchor });   // write #1: session cursor -> anchor
  inboxLedger.rebindIdentity(memberId, anchor);    // write #2: commit new member_id (LAST)
}
