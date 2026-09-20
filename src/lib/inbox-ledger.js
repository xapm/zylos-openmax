/**
 * Inbox-seq ledger — per-org persistent tracking of received inbox sequences.
 *
 * Maintains a continuous-ack watermark (acked_seq) and a set of received-but-
 * not-yet-contiguous sequences. A periodic timer advances the watermark,
 * triggers ackSync, and detects gaps that need /sync backfill.
 *
 * File: runtime/inbox-{orgSlug}.json
 * Schema: { member_id?: string, acked_seq: number, received: number[], fetch_failures: { [seq]: number } }
 *
 * Identity binding (#148)
 * -----------------------
 * The server's inbox_seq is bound to MEMBER identity: after an agent migration
 * / re-onboarding that changes self.member_id, cws-comm allocates a brand-new
 * inbox whose seq restarts from 1. This ledger persists the member_id it was
 * built for; on load, a mismatch against the current member_id means the old
 * high watermark would dedup every (low) new-inbox seq as a "duplicate" and
 * silently kill all inbound.
 *
 * On load we only DETECT the mismatch (getIdentityChange()) — we do NOT reset,
 * and we keep the OLD member_id on disk. The reset+reseed is deliberately
 * deferred to comm-bridge's onOpen and performed via rebindIdentity() ONLY after
 * the new identity's server watermark has been fetched from GET /api/v1/sync/
 * status. If that fetch fails the ledger is left untouched (stale watermark still
 * in force, inversion alarm still firing) and the change is retried on a later
 * reconnect — we never blindly reset to 0.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';
import { recordFailure, clearFailure, failureCount } from './content-fetch-giveup.js';

const TICK_INTERVAL_MS = 5_000;
const GAP_TIMEOUT_MS = 10_000;
const RECEIVED_CAP = 5000;
const PERSIST_DEBOUNCE_MS = 1_000;

// Watermark-inversion alarm (#148). A sustained run of inbox_seqs that fall FAR
// below the continuous-ack watermark is the migration signature: a stale high
// watermark (old identity) shadowing a new identity's seqs that restarted from
// 1. Below these thresholds the skip stays an info-level dedup; at/above them it
// escalates to a loud alarm (previously this failure produced ZERO signal).
const INVERSION_ALERT_MIN_COUNT = 20;   // consecutive below-watermark dedups
const INVERSION_ALERT_MIN_GAP   = 100;  // ackedSeq - inboxSeq must exceed this

export function createInboxLedger(orgSlug, { onAck, onGapSync, log, warn, memberId } = {}) {
  const filePath = path.join(RUNTIME_DIR, `inbox-${orgSlug}.json`);
  const warnFn = warn || log || (() => {});
  const currentMemberId = (memberId != null && memberId !== '') ? String(memberId) : null;

  let ackedSeq = 0;
  let lastAckedSeq = 0;
  // The member_id to persist. Defaults to the current identity, but if this run
  // was started without a member_id we preserve whatever the file already had
  // rather than clobbering it to null.
  let persistedMemberId = currentMemberId;
  // Set on load when the persisted member_id no longer matches the current one.
  let identityChange = null;   // { previousMemberId, currentMemberId }
  // Consecutive below-watermark dedups, for the inversion alarm above.
  let consecutiveInversions = 0;
  const received = new Set();
  // Durable per-seq consecutive content-fetch-failure counts ({ [seq]: n }).
  // Persisted alongside acked_seq so a permanently-unfetchable head keeps
  // accumulating failures ACROSS process restarts + reconnects (the wedge's
  // signature is repeated connect→restart→reconnect legs); an in-memory-only
  // counter would reset each restart and never reach the give-up threshold.
  let fetchFailures = {};
  let oldestGapTs = null;
  let persistTimer = null;
  let tickTimer = null;

  function pruneFetchFailures() {
    // A counter is only meaningful for a seq still ahead of the watermark;
    // once acked/skipped, drop it.
    for (const k of Object.keys(fetchFailures)) {
      if (Number(k) <= ackedSeq) delete fetchFailures[k];
    }
  }

  function load() {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      const storedMemberId = (data.member_id != null && data.member_id !== '')
        ? String(data.member_id) : null;
      // Identity rebind DETECTION only (#148): a changed member_id means a NEW
      // server inbox whose seqs restarted from 1. We deliberately do NOT reset
      // here — the stale watermark is kept in force so the connection keeps
      // operating (and the inversion alarm keeps firing) until onOpen fetches the
      // new identity's server watermark via /sync/status and reseeds
      // deterministically (rebindIdentity). The OLD member_id stays on disk until
      // that succeeds, so a crash/restart re-detects the change and retries.
      if (storedMemberId && currentMemberId && storedMemberId !== currentMemberId) {
        identityChange = { previousMemberId: storedMemberId, currentMemberId };
        persistedMemberId = storedMemberId;
        warnFn(`inbox-ledger: identity change detected ${storedMemberId}→${currentMemberId}; ` +
               `deferring reseed to /sync/status (watermark unchanged for now)`);
      } else if (!currentMemberId && storedMemberId) {
        // No current member_id supplied this run — keep the file's member_id so a
        // later run that DOES know its identity can still detect a change.
        persistedMemberId = storedMemberId;
      }
      if (typeof data.acked_seq === 'number' && data.acked_seq > 0) {
        ackedSeq = data.acked_seq;
      }
      if (Array.isArray(data.received)) {
        for (const s of data.received) {
          if (typeof s === 'number' && s > ackedSeq) received.add(s);
        }
      }
      if (data.fetch_failures && typeof data.fetch_failures === 'object') {
        for (const [k, v] of Object.entries(data.fetch_failures)) {
          if (Number.isInteger(v) && v > 0 && Number(k) > ackedSeq) fetchFailures[k] = v;
        }
      }
      log(`inbox-ledger loaded: acked_seq=${ackedSeq} pending=${received.size} fetch_failures=${Object.keys(fetchFailures).length}`);
    } catch {
      // No file or corrupt — start fresh; ackedSeq will be set from sync_seq.
    }
  }

  // Serialize the ledger. member_id is included only when known so a run
  // without an identity keeps the existing on-disk shape unchanged.
  function buildData(sortedReceived) {
    const data = { acked_seq: ackedSeq, received: sortedReceived, fetch_failures: fetchFailures };
    if (persistedMemberId) data.member_id = persistedMemberId;
    return data;
  }

  function persist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const sorted = [...received].sort((a, b) => a - b);
      const data = buildData(sorted);
      const tmp = `${filePath}.tmp.${process.pid}`;
      try {
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, filePath);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        log(`inbox-ledger persist failed: ${err.message}`);
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  function advanceWatermark() {
    let advanced = false;
    while (received.has(ackedSeq + 1)) {
      ackedSeq += 1;
      received.delete(ackedSeq);
      advanced = true;
    }
    if (advanced) {
      oldestGapTs = null;
      pruneFetchFailures();
    }
    return advanced;
  }

  /**
   * Record a received inbox_seq. Returns false if it was already known
   * (duplicate), true if it's new and should be processed.
   */
  function record(inboxSeq) {
    if (typeof inboxSeq !== 'number' || inboxSeq <= 0) return true;
    if (inboxSeq <= ackedSeq) {
      // Below the continuous-ack watermark. Usually a genuine duplicate, but a
      // SUSTAINED run of seqs far below the watermark is the #148 migration
      // signature (stale high watermark shadowing a new inbox that restarted at
      // 1). Escalate from a silent skip to a loud alarm with the manual-fix hint.
      consecutiveInversions += 1;
      const gap = ackedSeq - inboxSeq;
      if (consecutiveInversions >= INVERSION_ALERT_MIN_COUNT
          && gap > INVERSION_ALERT_MIN_GAP
          && consecutiveInversions % INVERSION_ALERT_MIN_COUNT === 0) {
        warnFn(
          `inbox-ledger: ALARM ${consecutiveInversions} consecutive inbox_seq(s) far below the ack ` +
          `watermark (latest seq=${inboxSeq} <= acked_seq=${ackedSeq}, gap=${gap}) — inbound is being ` +
          `silently deduped, likely a member_id change whose new server inbox restarted its seq. ` +
          `Fix: stop the service, back up runtime/, then set inbox-${orgSlug}.json acked_seq AND ` +
          `session.json ${orgSlug}.sync_seq to the server's last_delivered_seq from ` +
          `GET /api/v1/sync/status (do NOT seed above it — that silently drops the pending window; ` +
          `the pending messages then replay from last_delivered_seq), and restart.`,
        );
      }
      return false;
    }
    if (received.has(inboxSeq)) return false;
    consecutiveInversions = 0;
    received.add(inboxSeq);
    advanceWatermark();
    persist();
    return true;
  }

  function tick() {
    advanceWatermark();
    if (ackedSeq > lastAckedSeq) {
      lastAckedSeq = ackedSeq;
      persist();
      if (onAck) onAck(ackedSeq);
    }

    if (received.size > 0) {
      if (received.size > RECEIVED_CAP) {
        log(`inbox-ledger: received set overflow (${received.size}), triggering /sync`);
        received.clear();
        oldestGapTs = null;
        persist();
        if (onGapSync) onGapSync(ackedSeq);
        return;
      }
      if (!oldestGapTs) {
        oldestGapTs = Date.now();
      } else if (Date.now() - oldestGapTs > GAP_TIMEOUT_MS) {
        log(`inbox-ledger: gap persisted ${Math.round((Date.now() - oldestGapTs) / 1000)}s, triggering /sync from ${ackedSeq}`);
        oldestGapTs = Date.now();
        if (onGapSync) onGapSync(ackedSeq);
      }
    } else {
      oldestGapTs = null;
    }
  }

  function start() {
    if (tickTimer) return;
    tickTimer = setInterval(tick, TICK_INTERVAL_MS);
    if (tickTimer.unref) tickTimer.unref();
  }

  // Synchronous, immediate persist (no debounce). Used by stop() and by
  // rebindIdentity() so a crash right after a rebind still boots as the new
  // identity + reseeded watermark.
  function writeSync() {
    const sorted = [...received].sort((a, b) => a - b);
    const data = buildData(sorted);
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data));
    } catch {}
  }

  function stop() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    // Final synchronous persist
    writeSync();
  }

  /**
   * Drop the received-but-not-yet-contiguous set without touching the
   * continuous-ack watermark. Used by the first-boot replay path: a comm-bridge
   * started transiently during the runtime prepare phase can record inbox seqs
   * it never delivered to an agent session (no session exists yet), tainting the
   * dedupe set. On a genuine first boot nothing has been delivered, so those
   * stale "seen" marks must not suppress the replay-and-dispatch. acked_seq is
   * left untouched (it is the durable delivered watermark, seeded separately).
   */
  function resetReceived() {
    if (received.size === 0) return;
    received.clear();
    oldestGapTs = null;
    persist();
  }

  function setAckedSeq(seq) {
    if (typeof seq === 'number' && seq > ackedSeq) {
      ackedSeq = seq;
      lastAckedSeq = seq;
      // A deliberate watermark move (re-seed) invalidates any in-progress
      // inversion run — the shadow is gone once the watermark is corrected.
      consecutiveInversions = 0;
      for (const s of received) {
        if (s <= ackedSeq) received.delete(s);
      }
      pruneFetchFailures();
      persist();
    }
  }

  function getAckedSeq() { return ackedSeq; }

  /**
   * If load DETECTED that the persisted member_id no longer matches the current
   * identity (#148), returns { previousMemberId, currentMemberId }; otherwise
   * null. The ledger is NOT reset by detection — comm-bridge calls
   * rebindIdentity() to perform the reset+reseed once /sync/status is fetched.
   * Cleared by a successful rebindIdentity().
   */
  function getIdentityChange() { return identityChange; }

  /**
   * Perform the #148 identity rebind. Called ONLY after the new identity's
   * server watermark has been fetched (GET /sync/status) — never blindly. Drops
   * the old identity's watermark / received set / failure counters, seeds the
   * continuous-ack watermark to `anchorSeq` (the server's last_delivered_seq,
   * which may legitimately be 0), adopts + persists the new member_id, and clears
   * the identity-change flag. Persisted synchronously so a crash before the
   * replay finishes still boots as the new identity.
   */
  function rebindIdentity(newMemberId, anchorSeq) {
    const anchor = (typeof anchorSeq === 'number' && anchorSeq > 0) ? anchorSeq : 0;
    ackedSeq = anchor;
    lastAckedSeq = anchor;
    received.clear();
    fetchFailures = {};
    consecutiveInversions = 0;
    oldestGapTs = null;
    if (newMemberId != null && newMemberId !== '') persistedMemberId = String(newMemberId);
    identityChange = null;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    writeSync();
  }

  /**
   * Record one DURABLE, cross-restart content-fetch failure for `seq` and
   * report whether the caller should give up on it now. The count is persisted
   * in this ledger's file so it keeps accumulating across process restarts and
   * reconnects (the catch-up-wedge signature). Returns
   * { failures, giveUp, max } — see content-fetch-giveup.recordFailure. A no-op
   * (returns null) for seqs already at/behind the watermark.
   */
  function recordContentFetchFailure(seq) {
    if (typeof seq !== 'number' || seq <= 0 || seq <= ackedSeq) return null;
    const result = recordFailure(fetchFailures, seq);
    persist();
    return result;
  }

  /** Clear a seq's consecutive content-fetch-failure counter (on success). */
  function clearContentFetchFailure(seq) {
    if (clearFailure(fetchFailures, seq)) persist();
  }

  /** Current durable consecutive content-fetch-failure count for `seq`. */
  function getContentFetchFailureCount(seq) {
    return failureCount(fetchFailures, seq);
  }

  /**
   * Give-up path: mark `seq` as permanently consumed even though it was never
   * successfully processed (content unavailable after the give-up threshold).
   * Adds it to the received set, advances the watermark, and clears its failure
   * counter — so the gap-detector stops re-triggering /sync on this unfetchable
   * head forever and the backlog behind it can be delivered.
   */
  function skip(seq) {
    if (typeof seq !== 'number' || seq <= 0 || seq <= ackedSeq) return;
    received.add(seq);
    clearFailure(fetchFailures, seq);
    advanceWatermark();
    persist();
  }

  load();

  return {
    record, start, stop, setAckedSeq, getAckedSeq, getIdentityChange, rebindIdentity, resetReceived,
    recordContentFetchFailure, clearContentFetchFailure, getContentFetchFailureCount, skip,
  };
}
