/**
 * Reply-target resolution for `interaction_receipt` messages.
 *
 * When someone answers a display card, cws-comm posts an INTERACTION_RECEIPT
 * into the read-only `interaction_center` system DM — NOT into the conversation
 * the card was posted to. So `msg.conversation_id` is that system DM, and the
 * conversation we must answer in is carried in the receipt body as
 * `content.body.origin.conversation_id` (a bare UUID, same format as
 * `msg.conversation_id`).
 *
 * Contract: cws-docs `interaction-receipt-contract.md`. It deliberately deviates
 * from `card-choice-interaction-refactor.md` §5.4/§5.5, which named the fields
 * `conversation_uri` / `message_uri` — the implementation carries bare ids with
 * no scheme prefix.
 *
 * ⚠️ No real receipt has been observed: cws-comm is still implementing the type,
 * so every shape here comes from the contract document, not from the wire.
 * That is why resolution is defensive throughout — anything unrecognized falls
 * back to the message's own conversation instead of dropping the message.
 */

import { isSystemSender } from './system-message.js';

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0 ? v : (typeof v === 'number' ? String(v) : '');
}

/**
 * Whether a message is an interaction receipt. Reads both the top-level `type`
 * (real-time WS frames) and the nested `message.type` (get-message detail
 * envelope), mirroring isSystemSender.
 */
export function isInteractionReceipt(msg) {
  if (!msg) return false;
  const t = String(msg.type || msg.message?.type || '').toUpperCase();
  return t === 'INTERACTION_RECEIPT';
}

/**
 * `{ conversationId, messageId }` of the card a receipt answers, or null when
 * the message is not a receipt or carries no usable origin. `messageId` is
 * optional — a receipt whose origin names only the conversation is still enough
 * to answer in the right place.
 */
export function receiptOrigin(msg) {
  if (!isInteractionReceipt(msg)) return null;
  const body = msg.content?.body || msg.message?.content?.body;
  const origin = body?.origin;
  if (!origin || typeof origin !== 'object') return null;
  const conversationId = nonEmptyString(origin.conversation_id);
  if (!conversationId) return null;
  const messageId = nonEmptyString(origin.message_id);
  return { conversationId, messageId: messageId || undefined };
}

/**
 * The conversation an inbound message must be answered in — `conversation_id`
 * for everything except a well-formed receipt, which redirects to its origin.
 *
 * 🔴 The redirect is gated on `sender_type=SYSTEM` even though cws-comm asserts
 * receipts are system-sent: without that gate, anyone able to post a message
 * could name an arbitrary `origin.conversation_id` and have us answer into a
 * conversation they picked. The gate costs nothing — a receipt from a
 * non-system sender is not a receipt.
 */
export function resolveReplyConversationId(msg) {
  const own = msg?.conversation_id;
  if (!isSystemSender(msg)) return own;
  return receiptOrigin(msg)?.conversationId || own;
}
