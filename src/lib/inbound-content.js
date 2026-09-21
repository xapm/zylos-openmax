/**
 * Inbound-content resolution for the comm-bridge message handler.
 *
 * Problem this solves
 * -------------------
 * A cws-comm WS "message" frame carries only metadata (id / conversation_id /
 * sender_id), NOT the message body. The body is fetched separately via
 * GET /conversations/{conv}/messages/{id}. When that GET fails (or returns a
 * payload with no usable body), the old code merged `{ ...notification }` with
 * an empty/`null` detail and forwarded a metadata-only, EMPTY message to the
 * agent. The real text only showed up later — out of order — via the next
 * /sync catch-up. That is the bug.
 *
 * Behavior implemented here (owner-approved spec)
 * ----------------------------------------------
 *  1. Retry the content fetch once (configurable) — a transient GET failure is
 *     the common case, and a single re-GET usually succeeds.
 *  2. If content still can't be resolved (detail null / no usable body after
 *     all attempts), return a `skip-empty` decision so the caller can:
 *       - NOT forward an empty message,
 *       - NOT advance read-state / the /sync cursor for it (so it stays
 *         "unconsumed" and is re-pulled by the next /sync catch-up in order),
 *       - on the realtime WS path only, force a WS reconnect (which triggers
 *         the existing reconnect → /sync catch-up auto-fetch).
 *  3. Reconnect-storm guard: a frame that arrived via the /sync catch-up replay
 *     (`notification._via === 'sync'`) must NOT force another disconnect
 *     mid-sweep (that would abort/loop the catch-up). It still retries, still
 *     skips the empty forward, and still leaves the cursor un-advanced — the
 *     existing exponential reconnect backoff + un-advanced cursor is the safety
 *     net there. So `forceReconnect` is true ONLY for the realtime path.
 */

import { formatReceiptForModel } from './interaction-receipt.js';

/**
 * Determine whether a (merged notification+detail) message has a usable body.
 *
 * "Usable" mirrors how the forward path reads a message today: text in
 * `content.body.text` / a string `message.content` / a string `content`, OR
 * any media/attachment reference. A media-only message (image/file with no
 * caption) is legitimately usable — do NOT treat it as empty. Only "no text
 * AND no media/attachments" counts as empty.
 */
export function messageHasUsableContent(msg) {
  if (!msg || typeof msg !== 'object') return false;

  // An interaction receipt is usable as soon as it carries an answer, even with
  // no text. The contract requires the text, but a producer that omits it would
  // otherwise park the whole org's inbox behind one un-advanced cursor — and the
  // forward path renders a receipt from its structured fields regardless.
  if (formatReceiptForModel(msg)) return true;

  const structured = (msg.content && typeof msg.content === 'object') ? msg.content : {};

  const text =
       structured.body?.text
    || (typeof msg.message?.content === 'string' ? msg.message.content : '')
    || (typeof msg.content === 'string' ? msg.content : '')
    || msg.content_text
    || '';
  if (typeof text === 'string' && text.trim() !== '') return true;

  // Structured attachments (current cws-core schema).
  if (Array.isArray(structured.attachments) && structured.attachments.length > 0) return true;
  // Legacy flat media fields.
  if (structured.media_id || structured.filename) return true;
  // Top-level attachments (some API / envelope shapes).
  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) return true;

  return false;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch a message's content with a retry, and decide what the caller should do.
 *
 * @param {object}   args
 * @param {Function} args.getDetail   async () => detail|null — already bound to
 *                                     the org/conversation/message id. Called
 *                                     once, then up to `retries` more times.
 * @param {object}   args.notification the WS frame (metadata). Merged with the
 *                                     fetched detail to judge usable content and
 *                                     read `_via` for the realtime-vs-sync split.
 * @param {number}   [args.retries=1]  extra attempts AFTER the first (total =
 *                                     1 + retries).
 * @param {number}   [args.delayMs=400] delay between attempts.
 * @param {Function} [args.sleep]      injectable sleep (tests).
 *
 * @returns {Promise<object>} one of:
 *   { status: 'ok', detail, attempts }
 *   { status: 'skip-empty', detail, attempts, via, forceReconnect }  // POISON: GET ok, body empty
 *   { status: 'error', attempts, via, forceReconnect, error }        // TRANSIENT: GET threw
 *
 * IMPORTANT: `getDetail` MUST THROW on a fetch/HTTP error (so a transient
 * failure is classified 'error', halted, and re-pulled in order) and return the
 * — possibly empty — body on a successful response (an empty body is the only
 * 'skip-empty' / skip-eligible case). A `getDetail` that swallows errors to a
 * null return collapses the two and can cause a transient failure to be skipped
 * and PERMANENTLY dropped.
 */
export async function resolveInboundContent({
  getDetail,
  notification,
  retries = 1,
  delayMs = 400,
  sleep = defaultSleep,
}) {
  const maxAttempts = 1 + Math.max(0, Number(retries) || 0);
  let detail = null;
  let attempts = 0;
  // Discriminate the TWO failure modes, because they must be handled
  // oppositely (see the status doc above):
  //   • the fetch THREW (HTTP/network error, 5xx/429/404-replication-lag) —
  //     TRANSIENT. `getDetail` must throw for this; do NOT skip such a message.
  //   • the fetch SUCCEEDED but the body is empty/unusable — POISON (e.g. a
  //     message persisted with an empty body). Only this is skip-eligible.
  // We classify on the TERMINAL attempt and bias toward "transient" (halt +
  // re-pull) whenever the last attempt threw, because wrongly skipping drops a
  // real message permanently, while wrongly halting only delays it.
  let lastAttemptThrew = false;
  let lastError = null;

  while (attempts < maxAttempts) {
    if (attempts > 0 && delayMs > 0) await sleep(delayMs);
    attempts += 1;
    try {
      detail = await getDetail();
      lastAttemptThrew = false;
    } catch (err) {
      detail = null;
      lastAttemptThrew = true;
      lastError = err;
      continue; // transient — retry if attempts remain, else fall through to 'error'
    }
    if (messageHasUsableContent({ ...notification, ...(detail || {}) })) {
      return { status: 'ok', detail, attempts };
    }
  }

  const isSync = notification?._via === 'sync';

  if (lastAttemptThrew) {
    // TRANSIENT fetch error. The caller must preserve PR#76 ordering: leave the
    // cursor un-advanced and halt the sweep so this seq is re-pulled in order on
    // the next reconnect. It must NOT count toward the empty-body give-up budget
    // and must NOT be skipped — otherwise a brief GET outage would permanently
    // drop a legitimate message. Realtime still forces a reconnect.
    return {
      status: 'error',
      attempts,
      via: isSync ? 'sync' : 'realtime',
      forceReconnect: !isSync,
      error: lastError?.message,
    };
  }

  // POISON: the GET succeeded but yielded no usable body. This is the only
  // skip-eligible case (bounded give-up in the caller).
  return {
    status: 'skip-empty',
    detail,
    attempts,
    via: isSync ? 'sync' : 'realtime',
    // Only the realtime path forces a reconnect. On the sync replay path the
    // existing backoff + un-advanced cursor is the safety net; re-terminating
    // mid-sweep would abort/loop the catch-up.
    forceReconnect: !isSync,
  };
}
