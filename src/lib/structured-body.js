/**
 * Text extraction for structured message bodies that carry no `content.body.text`.
 *
 * Problem this solves
 * -------------------
 * The bridge's two content paths (`messageHasUsableContent` and the forward-path
 * `text` chain, plus the history mapper) read text out of `content.body.text`,
 * a string `message.content`, a string `content`, or `content_text`. A card body
 * has **none** of those: its top-level keys are exactly
 * `actions, blocks, kind, mode, schema, summary, title`, and the prose lives in
 * `blocks[].text`. So every arm misses, `messageHasUsableContent` returns false,
 * and the message is treated as an empty body.
 *
 * That is not a cosmetic miss. An empty body does not just drop the one message:
 * the /sync cursor is NOT advanced, so **the whole backlog behind it stalls**
 * until the fetch gives up after `MAX_CONTENT_FETCH_ATTEMPTS` consecutive
 * failures, at which point the alarm says `possible data loss` and the cursor
 * skips past it. The failure counter is persisted, so it survives restarts.
 *
 * Why a formatter and not one more `||` arm
 * -----------------------------------------
 * Same shape, and same fix, as `formatReceiptForModel` in `interaction-receipt.js`:
 * a body whose meaning lives in structured fields needs rendering, not a field
 * lookup. This module is the card-shaped half of that pattern.
 *
 * Why there is also a type-agnostic last resort
 * ---------------------------------------------
 * `card` is not the only content type in this hole — `channel_qr` and
 * `channel_confirmation` have the same body shape (schema-only, no `text`), and
 * the code has **no type-aware branch at all**, so the set is open-ended: any
 * future structured type lands here too. Every one of them is sent with a
 * message-level `fallback_text`, which is exactly what that field is for. So
 * after the card renderer comes a plain `message.fallback_text` arm, and a type
 * this file has never heard of still arrives as something rather than stalling
 * the org's inbox.
 *
 * ⚠️ This module makes a card **readable**. It does not make it **answerable** —
 * nothing here wires up replying to a received card's options. The `[options]`
 * line exists so the agent can see the question was a choice, not so it can
 * settle one.
 */

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : '';
}

/**
 * Collapse anything that could own a line boundary, same reason as the receipt
 * formatter: this rendering is line-oriented and every one of these values is
 * written by whoever sent the card. A title carrying a newline could otherwise
 * forge an `[options]` line that says whatever it likes.
 */
function oneLine(v) {
  return nonEmptyString(v).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
}

/** The card body, whichever envelope this message arrived in. */
function cardBody(msg) {
  const direct = msg?.content?.body;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  const nested = msg?.message?.content?.body;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested;
  return null;
}

/**
 * One block's prose. `text` is the rendered form and `fallback_text` the
 * plain-text projection the sender supplied for clients that cannot render the
 * block — for a text model the latter is the better of the two when they differ,
 * but only `text` is guaranteed present, so prefer `text` and fall back.
 *
 * A `fields` block carries no prose of its own; its `items` are the readable
 * part and its `fallback_text` is the sender's own flattening of them.
 */
function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  const own = nonEmptyString(block.text) || nonEmptyString(block.fallback_text);
  if (own) return own.trim();
  if (Array.isArray(block.items)) {
    return block.items
      .map((item) => {
        if (typeof item === 'string') return oneLine(item);
        if (!item || typeof item !== 'object') return '';
        const label = oneLine(item.label ?? item.name);
        const value = oneLine(item.value ?? item.meta);
        return label && value ? `${label}: ${value}` : label || value;
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Render a structured body as text, or return `null` when this message is not
 * one (so callers can use it as one arm of an `||` chain, exactly like
 * `formatReceiptForModel`).
 */
export function formatStructuredForModel(msg) {
  if (!msg || typeof msg !== 'object') return null;

  const body = cardBody(msg);
  if (body && Array.isArray(body.blocks)) {
    const lines = [];
    const title = oneLine(body.title);
    const summary = oneLine(body.summary);
    if (title) lines.push(`【${title}】`);
    if (summary && summary !== title) lines.push(summary);

    const prose = body.blocks.map(blockText).filter(Boolean);
    if (prose.length) {
      if (lines.length) lines.push('');
      lines.push(prose.join('\n\n'));
    }

    const actions = Array.isArray(body.actions) ? body.actions : [];
    const labels = actions.map((a) => oneLine(a?.label)).filter(Boolean);
    if (labels.length) {
      lines.push('');
      lines.push(`[options] ${labels.join(' / ')}`);
    }

    const out = lines.join('\n').trim();
    if (out) return out;
  }

  // Type-agnostic last resort — see the module header.
  const fallback = nonEmptyString(msg?.message?.fallback_text) || nonEmptyString(msg?.fallback_text);
  return fallback ? fallback.trim() : null;
}
