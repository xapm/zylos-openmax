/**
 * Decide whether a structured message yielded no usable text (this module only
 * decides; emitting the log line is the caller's job).
 *
 * 🔴 The defect this guards: the multi-arm fallback on `content.body.text`
 * returns the same thing for "a structured type we cannot read" and for "a
 * genuinely empty message" — an empty string, forwarded as if it were text.
 * The two are indistinguishable in the log, and nothing downstream has a reason
 * to suspect anything, because the caller still gets a plausible-looking
 * result. A `cws.card.v1` message has no `text` key anywhere in its body, so
 * every arm comes back empty; that is the concrete case this exists for.
 *
 * Three conditions, not "text came back empty":
 *   1. `msg.content` is an object (the server sent a structured body)
 *   2. the extracted text is empty
 *   3. the message carries no other legitimate content channel
 * Condition 1 keeps genuinely empty messages out — the group-history caller
 * runs for every message, so a one-condition predicate would flood the log.
 * Condition 3 keeps caption-less image and file messages out: same shape as a
 * card in the first two conditions, yet nothing is wrong with them.
 *
 * ⚠️ Observability only. Reading the projection reported below would change
 * what gets forwarded, and is deliberately left out.
 *
 * Deciding and emitting are split because importing `comm-bridge.js` starts
 * background tasks, putting it out of reach of a test.
 */
export function describeEmptyStructuredText(msg, text) {
  if (text) return null;
  const content = msg?.content;
  if (!content || typeof content !== 'object') return null;
  if (hasMediaChannel(msg, content)) return null;
  const body = (content.body && typeof content.body === 'object') ? content.body : {};
  return {
    contentType: String(content.content_type ?? ''),
    // Answers "why was it empty": for a card the key list has no `text` in it.
    bodyKeys: Object.keys(body),
    // A card carries a plain-text projection of itself in `blocks[*].fallback_text`,
    // one level below body, where no arm reaches it. Reported as a flag, not as
    // its content: whoever reads the log needs to know an answer exists, and can
    // fetch the message for the rest.
    hasBlockFallback: hasBlockFallback(body),
  };
}

/**
 * Whether this message carries content through a non-text channel. The channel
 * list is copied from `messageHasUsableContent` in `inbound-content.js`; change
 * that one and this one must change with it.
 */
function hasMediaChannel(msg, content) {
  if (Array.isArray(content.attachments) && content.attachments.length > 0) return true;
  if (content.media_id || content.filename) return true;
  if (Array.isArray(msg?.attachments) && msg.attachments.length > 0) return true;
  return false;
}

/** Whether any `blocks[*]` carries a non-blank `fallback_text`. */
function hasBlockFallback(body) {
  const blocks = Array.isArray(body.blocks) ? body.blocks : [];
  return blocks.some((b) => b && typeof b === 'object'
    && typeof b.fallback_text === 'string' && b.fallback_text.trim() !== '');
}
