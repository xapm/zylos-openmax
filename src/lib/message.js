/**
 * Message format helpers per DESIGN.md §3.4 and §3.5.
 *
 * Endpoint format (C4 routing key / `reply via` target):
 *   <conversationId>
 *   <conversationId>|reply:<messageId>
 *   <conversationId>|thread:<threadConvId>|parent:<parentMsgId>
 *
 * The conversation type ([OPENMAX DM]/[OPENMAX GROUP]/[OPENMAX THREAD]) is NOT part of
 * the target: send.js routes purely off the conversation id plus the
 * reply/thread/parent suffixes, so the type prefix was dead weight in the
 * `reply via` string the agent has to copy. `parseEndpoint` still accepts the
 * legacy `[OPENMAX TYPE]/<id>...` (or older `[COCO TYPE]/`) form for backward compatibility (in-flight
 * messages, older callers), but `formatEndpoint` now emits the minimal form.
 *
 * Inbound C4 text format (tag on its own line; the attributed utterance lives
 * inside <current-message> for parity with other C4 channels):
 *   [OPENMAX DM]
 *   <openmax-instruction>...</openmax-instruction>
 *   <current-message>
 *   <name> said: <content>
 *   </current-message>
 *
 *   [OPENMAX GROUP:<group>]
 *   <group-context>...</group-context>
 *   <current-message>
 *   <name> said: <content>
 *   </current-message>
 *   (with optional `---- file: <path>` or `---- image: <path>` suffix)
 */

import { randomUUID } from 'crypto';
import { extractWorkReferences, formatWorkReferenceContext } from './work-reference.js';

const TYPE_TAG = { dm: '[OPENMAX DM]', group: '[OPENMAX GROUP]', thread: '[OPENMAX THREAD]' };
const VALID_TYPES = new Set(['dm', 'group', 'thread']);

/**
 * Generate a client-side idempotency key for SendMessageRequest.client_msg_id.
 * The server de-dupes identical client_msg_id within 5 minutes (api-design.md §5.1).
 */
export function newClientMsgId() {
  return `c_${randomUUID()}`;
}

/**
 * Parse a C4 endpoint string into structured fields.
 *
 * Accepts two forms:
 *   - minimal (current):  `<conversationId>[|reply:..][|thread:..][|parent:..]`
 *   - legacy:             `[OPENMAX TYPE]/<conversationId>[|...]` (or older `[COCO TYPE]/`) (prefix stripped)
 *
 * The leading conversation id is whatever precedes the first `|`. The type
 * prefix, if present, is informational only — routing is driven entirely by
 * the conversation id and the reply/thread/parent suffixes.
 *
 * @param {string} endpoint
 * @returns {{type:string, conversationId:string, replyTo?:string,
 *            threadConversationId?:string, parentMessageId?:string}}
 */
export function parseEndpoint(endpoint) {
  let rest = (endpoint || '').trim();

  // Strip a legacy `[OPENMAX TYPE]/` (or older `[COCO TYPE]/`) prefix if present
  // (back-compat; prefix is informational only, routing is by conversation id).
  let typeHint = null;
  const legacy = /^\[(?:OPENMAX|COCO) (DM|GROUP|THREAD)\]\/(.*)$/.exec(rest);
  if (legacy) { typeHint = legacy[1].toLowerCase(); rest = legacy[2]; }

  const segments = rest.split('|');
  const conversationId = (segments.shift() || '').trim();
  if (!conversationId) throw new Error(`invalid endpoint: ${endpoint}`);

  const result = { conversationId };
  for (const part of segments.filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === 'reply')  result.replyTo = v;
    else if (k === 'thread') result.threadConversationId = v;
    else if (k === 'parent') result.parentMessageId = v;
  }
  // `type` is retained for callers that inspect it, but is not used for
  // routing. Prefer the legacy hint; otherwise infer from the suffixes.
  result.type = typeHint || (result.threadConversationId ? 'thread' : 'dm');
  return result;
}

/**
 * Build a C4 endpoint string (the `reply via` target) from structured fields.
 *
 * Emits the minimal form — conversation id plus reply/thread/parent suffixes.
 * The conversation type is intentionally omitted (see parseEndpoint): it was
 * never consulted by the send path. `ep.type` is accepted but ignored.
 *
 * @param {{type?:string, conversationId:string, replyTo?:string,
 *          threadConversationId?:string, parentMessageId?:string}} ep
 */
export function formatEndpoint(ep) {
  if (!ep?.conversationId) throw new Error('formatEndpoint: conversationId required');
  let s = `${ep.conversationId}`;
  if (ep.replyTo)              s += `|reply:${ep.replyTo}`;
  if (ep.threadConversationId) s += `|thread:${ep.threadConversationId}`;
  if (ep.parentMessageId)      s += `|parent:${ep.parentMessageId}`;
  return s;
}

/**
 * Neutralize the structural-breakout vector in user-supplied strings before
 * embedding them in the XML-tagged context blocks emitted by formatInboundForC4.
 *
 * The consumer is an LLM reading raw text, NOT an XML parser. The only real
 * threat is a sender planting a literal `</current-message>` (or any other
 * closing tag) to break out of the framing the model relies on — that requires
 * the `<` / `>` characters, so those are all we neutralize.
 *
 * We deliberately do NOT escape `&`, `"`, `'`: turning a user's natural
 * ampersands, quotes, and apostrophes into `&amp;` / `&quot;` / `&apos;` only
 * litters the text the model reads (e.g. `she said "hi"` → `she said &quot;hi&quot;`)
 * without preventing any breakout. Keeping prose verbatim gives the model a
 * cleaner, more faithful view of what the user actually wrote.
 */
function escapeXml(s) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format a single context-line entry: `[name]: text`. Both fields go through
 * escapeXml. Accepts the shape returned by fetchRecentMessages
 * ({senderName, content}) as well as generic {user_name|sender_id, text|content}.
 */
/**
 * Attribute-safe rendering. escapeXml deliberately leaves `"` alone — harmless
 * in element text, but inside a quoted attribute a `"` ends the value and the
 * rest becomes attributes of our own element. Line breaks would do the same to
 * the one-element-per-line framing. Attributes carry ids, kinds and timestamps,
 * so dropping these characters costs nothing and removes the breakout.
 */
function attrValue(v) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[<>"\r\n\u2028\u2029]/g, '').trim();
}

function formatContextLine(m) {
  const name = escapeXml(
       m.senderName
    || m.sender_display_name
    || m.user_name
    || m.sender_id
    || 'unknown',
  );
  const text = escapeXml(m.content ?? m.text ?? m.content_text ?? '');
  return `[${name}]: ${text}`;
}

/**
 * Build the C4-bridge inbound text for a single incoming message.
 *
 * Output framing mirrors zylos-feishu `src/index.js formatMessage`:
 *   - tag includes the group name for group / thread messages
 *     (`[OPENMAX GROUP:Engineering]`)
 *   - context blocks are XML-tagged so the LLM can cleanly separate history
 *     from the current message
 *   - thread context, replying-to, and smart-mode hint blocks are emitted
 *     when the relevant opts are present
 *   - all user-supplied strings go through escapeXml
 *
 * @param {object} conv     - { type:'dm'|'group'|'thread', id?, name? }
 * @param {object} sender   - { displayName }
 * @param {object} current  - { content:string, messageId?:string,
 *                              type?:'text'|'image'|'file', mediaLocalPath?:string }
 * @param {Array}  [recent] - recent group messages used for `<group-context>`
 * @param {object} [opts]   - { groupName, quotedContent, threadContext,
 *                              threadRootId, smartHint, receipt }
 * @returns {string}
 */
export function formatInboundForC4(conv, sender, current, recent = [], opts = {}) {
  const rawType = (conv?.type || '').toLowerCase();
  const type = VALID_TYPES.has(rawType) ? rawType : 'dm';
  const { groupName, quotedContent, threadContext, threadRootId, smartHint, orgId, orgName, receipt } = opts;

  const name = sender?.displayName || sender?.display_name || sender?.id || 'unknown';
  const safeName = escapeXml(name);
  const safeContent = escapeXml(current?.content ?? '');

  const baseTag = TYPE_TAG[type];
  // baseTag is like "[OPENMAX GROUP]" — inject ":<name>" before the closing "]".
  const tag = (type === 'group' || type === 'thread')
    ? `${baseTag.slice(0, -1)}:${escapeXml(groupName || conv?.name || 'unknown')}]`
    : baseTag;

  // Tag on its own line; the `<name> said: ...` attribution now lives inside
  // the <current-message> block (semantic parity with other C4 channels).
  //
  // Org header. The org NAME is UNTRUSTED display data; the org_id is the
  // AUTHORITATIVE routing key. Keep them apart so a malicious name can't forge
  // a competing id (see SKILL.md hard rule):
  //   - display text carries the NAME ONLY, escapeXml'd AND with CR/LF
  //     neutralized so it cannot break out of its line;
  //   - the org_id is emitted as a dedicated self-closing <org-context>
  //     element on its own line. Because escapeXml turns the name's `<`/`>`
  //     into entities, the untrusted name CANNOT produce a second/competing
  //     <org-context .../> element.
  // When org_id is absent, no <org-context> element is emitted and the display
  // falls back to name-or-id as before.
  const displayLabel = orgName
    ? escapeXml(orgName).replace(/[\r\n]/g, ' ')
    : (orgId ? escapeXml(orgId) : '');
  const orgSuffix = displayLabel ? ` (org: ${displayLabel})` : '';
  let header = `${tag}${orgSuffix}\n`;
  if (orgId) {
    header += `<org-context org-id="${escapeXml(orgId)}"/>\n`;
  }
  // Tool calls that cause external side effects must be tied back to the
  // exact inbound human request. Keep the server-issued ids in a structural
  // element outside <current-message>; user text cannot forge this because
  // angle brackets in the message body are escaped below.
  if (conv?.id && current?.messageId) {
    header += `<message-context conversation-id="${escapeXml(conv.id)}" source-message-id="${escapeXml(current.messageId)}"/>\n`;
  }
  // An interaction receipt's answer and actor decide whether an irreversible
  // action runs, so they are emitted as a structural element rather than left
  // in the message text. Anyone can type text that reads like a receipt; nobody
  // can type this element, because `<` and `>` in content are escaped below.
  if (receipt) {
    const attrs = [
      `selected-action-ids="${attrValue(receipt.selectedActionIds.join(','))}"`,
      `selected-count="${attrValue(receipt.selectedCount)}"`,
    ];
    if (receipt.actorMemberId) attrs.push(`actor-member-id="${attrValue(receipt.actorMemberId)}"`);
    if (receipt.actorKind) attrs.push(`actor-kind="${attrValue(receipt.actorKind)}"`);
    if (receipt.cardConversationId) attrs.push(`card-conversation-id="${attrValue(receipt.cardConversationId)}"`);
    if (receipt.cardMessageId) attrs.push(`card-message-id="${attrValue(receipt.cardMessageId)}"`);
    if (receipt.settledAt) attrs.push(`settled-at="${attrValue(receipt.settledAt)}"`);
    header += `<interaction-receipt ${attrs.join(' ')}/>\n`;
  }
  const parts = [header];

  // Skill discovery is advisory in the runtime: a model can occasionally
  // answer an inbound message without invoking the listed skill, especially
  // immediately after a session restart. Put the fixed channel instruction in
  // every OpenMax envelope so loading the skill is part of the message contract
  // rather than a best-effort inference from the skill listing.
  parts.push(
`<openmax-instruction>
Before handling the current message, invoke the openmax skill and follow it. For a new task, complete New-Issue Intake before doing the work.
</openmax-instruction>

`,
  );

  if (threadContext && threadContext.length > 0) {
    const lines = threadContext.map(m => {
      const line = formatContextLine(m);
      const id = m.message_id || m.id;
      if (threadRootId && id && String(id) === String(threadRootId)) {
        return `<thread-root>\n${line}\n</thread-root>`;
      }
      return line;
    });
    parts.push(`<thread-context>\n${lines.join('\n')}\n</thread-context>\n\n`);
  } else if (type !== 'dm' && recent && recent.length > 0) {
    const lines = recent.map(formatContextLine);
    parts.push(`<group-context>\n${lines.join('\n')}\n</group-context>\n\n`);
  }

  if (quotedContent && !(threadContext && threadContext.length > 0)) {
    const qsender = escapeXml(quotedContent.sender || quotedContent.senderName || 'unknown');
    const qtext   = escapeXml(quotedContent.text   || quotedContent.content    || '');
    parts.push(`<replying-to>\n[${qsender}]: ${qtext}\n</replying-to>\n\n`);
  }

  if (smartHint) {
    parts.push(
`<smart-mode>
Decide whether to respond. Do NOT reply if: the message is unrelated to you,
just casual chat, or doesn't need your input. Only reply when:
1) someone asks a question you can help with,
2) discussing technical topics you know well,
3) someone clearly needs assistance.
When uncertain, prefer NOT to reply. Reply with exactly [SKIP] to stay silent.
</smart-mode>\n\n`,
    );
  }

  const workReferenceContext = formatWorkReferenceContext(
    extractWorkReferences(current?.content ?? ''),
  );
  if (workReferenceContext) {
    parts.push(`${workReferenceContext}\n\n`);
  }

  parts.push(`<current-message>\n${safeName} said: ${safeContent}\n</current-message>`);

  let line = parts.join('');
  const kind = current.type === 'image' ? 'image' : 'file';
  if (Array.isArray(current?.mediaItems) && current.mediaItems.length > 0) {
    for (const item of current.mediaItems) {
      if (item.localPath) {
        line += ` ---- ${kind}: ${escapeXml(item.localPath)}`;
        if (item.fileName) line += ` name="${escapeXml(item.fileName)}"`;
      } else if (item.id) {
        line += ` ---- artifact_id: ${escapeXml(item.id)}`;
        if (item.fileName) line += ` name="${escapeXml(item.fileName)}"`;
      }
    }
  } else if (current?.mediaLocalPath) {
    line += ` ---- ${kind}: ${escapeXml(current.mediaLocalPath)}`;
    if (current.mediaFileName) line += ` name="${escapeXml(current.mediaFileName)}"`;
  } else if (current?.mediaId) {
    line += ` ---- artifact_id: ${escapeXml(current.mediaId)}`;
    if (current.mediaFileName) line += ` name="${escapeXml(current.mediaFileName)}"`;
  }
  return line;
}

/**
 * Heuristic markdown auto-detection for outbound messages.
 * Matches presence of headings, emphasis, code fences, lists, or links.
 */
export function looksLikeMarkdown(text) {
  if (typeof text !== 'string' || !text) return false;
  return /(^|\n)(#{1,6}\s|[*_-]{1,3}\s|```|\|\s|>\s|\d+\.\s)/.test(text) ||
         /\[[^\]]+\]\([^)]+\)/.test(text) ||
         /\*\*\S/.test(text) ||
         /`[^`]+`/.test(text);
}

/**
 * MEDIA prefix detection for outbound messages.
 * Matches `[MEDIA:image]/path/to/file` or `[MEDIA:file]/path/to/doc.pdf`.
 */
export function parseMediaPrefix(message) {
  // First line after the tag is the file path (may contain spaces); anything
  // after the first newline is an optional caption that travels with the media
  // message (cws-fe puts it in content.body.text). Path-only messages (no
  // newline) keep working unchanged.
  const m = /^\[MEDIA:(image|file)\]([^\n]*)(?:\n([\s\S]*))?$/.exec(message || '');
  if (!m) return null;
  const caption = m[3] != null ? m[3].trim() : '';
  return { kind: m[1], localPath: m[2].trim(), caption: caption || undefined };
}

/**
 * Split a long message into chunks that fit within maxLen characters.
 * Tries to break at paragraph (double-newline) boundaries first, then
 * single-newline boundaries, then hard-cuts as a last resort.
 */
export function splitMessage(text, maxLen = 3000) {
  if (!text || text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let cut = -1;

    // prefer paragraph break
    cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut > maxLen * 0.4) { chunks.push(remaining.slice(0, cut).trimEnd()); remaining = remaining.slice(cut).trimStart(); continue; }

    // fallback: single newline
    cut = remaining.lastIndexOf('\n', maxLen);
    if (cut > maxLen * 0.4) { chunks.push(remaining.slice(0, cut).trimEnd()); remaining = remaining.slice(cut + 1).trimStart(); continue; }

    // last resort: hard cut at maxLen
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}
