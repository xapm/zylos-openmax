/**
 * `[CARD]{…}` — asking a choice card through the same outbound entry as text.
 *
 * Every inbound message hands the agent one reply command (`c4-send`), and
 * until now that command could only carry text: a card had to be asked with a
 * different verb entirely. Two entries for "answer this person" is the ground
 * a wrong choice grows in — the agent reaches for the one it was just told to
 * use and types the options into a sentence. One entry removes the choice.
 *
 * It also puts cards in the audit log for free. `c4-send` writes the outbound
 * body to its conversation table BEFORE spawning this script, so a card asked
 * this way leaves a row exactly like a text reply does; a card asked by the
 * other verb never touches that table, and the history Memory Sync reads from
 * it has no idea the interaction happened.
 *
 * 🔴 The payload is INLINE JSON, not a path to a file holding it. The audit row
 * stores the body verbatim, so inline means the row is self-contained — the
 * question is still readable from it months later. A path would store a
 * pointer, and the existing `[MEDIA:…]` rows are what that turns into: every
 * one of them names a file that is long gone, so the row proves a send
 * happened and can never again say what was sent. A card carries the question
 * a human was asked and answered; it is the last thing that should decay into
 * a dangling pointer.
 *
 * Layering: parsing, validation and the record live here because `scripts/`
 * has no test surface at all. `scripts/send.js` keeps only the three-way
 * dispatch.
 */

import { post, apiPath } from './client.js';
import { buildChoiceRequest } from './interaction-request.js';
import { recordPendingQuestion } from './pending-question.js';

export const CARD_PREFIX = '[CARD]';

export class CardMessageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CardMessageError';
  }
}

/**
 * Keys the card builder accepts but this entry point cannot honour: the
 * endpoint and the conversation-to-org map already decide where the card goes.
 *
 * They are refused rather than ignored. A caller who writes a `conversationId`
 * into the payload believes they chose the target; silently sending to the
 * endpoint's conversation instead would be right by luck and wrong without a
 * word whenever the two differ.
 *
 * This is a deny-list of exactly the keys `buildChoiceRequest`'s whitelist
 * permits and this path does not use — deliberately NOT a second copy of the
 * card-field list, which would be a second ruling point and would drift from
 * the first one.
 */
const ENDPOINT_OWNED_KEYS = ['conversationId', 'org', 'orgSlug', 'orgId', 'org_id'];

/**
 * Recognize and validate a `[CARD]` message.
 *
 * @returns {null|{kind:string, askedOf:string, meta:*, card:object}}
 *   null when the message is not a card — plain text and `[MEDIA:…]` both land
 *   here and must come back null.
 * @throws {CardMessageError} when it IS a card and is malformed. Throwing is
 *   the whole point: the alternative to an error is posting the raw JSON into
 *   the conversation as a chat message, which is both unreadable to the person
 *   and indistinguishable — to the agent — from having asked them something.
 */
export function parseCardMessage(message) {
  const text = typeof message === 'string' ? message : '';
  // trimStart, not a bare prefix test: a leading space is otherwise the
  // difference between asking a question and dumping JSON into the chat, and
  // nothing downstream would report it.
  const body = text.trimStart();
  if (!body.startsWith(CARD_PREFIX)) return null;

  const raw = body.slice(CARD_PREFIX.length).trim();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new CardMessageError(`[CARD] payload is not valid JSON: ${e.message}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CardMessageError('[CARD] payload must be a JSON object');
  }

  // `kind` and `askedOf` are required for the same reason `comm.ask_card`
  // requires them: the receipt that comes back names the card and nothing
  // else. Without `kind` the answer cannot say what it answered; without
  // `askedOf` there is nobody to check the clicker against, and the protocol
  // has no authorization of its own.
  const { kind, askedOf, meta, ...card } = payload;
  if (!kind || !askedOf) {
    throw new CardMessageError(
      '[CARD] requires `kind` and `askedOf` — a receipt names only the card, so an answer with neither is decodable but meaningless',
    );
  }

  for (const key of ENDPOINT_OWNED_KEYS) {
    if (key in card) {
      throw new CardMessageError(
        `[CARD] payload must not set \`${key}\`: the endpoint passed to send.js decides the target conversation and its org`,
      );
    }
  }

  // Everything left is a card field, and `buildChoiceRequest` is the single
  // judge of those — including its whitelist, which is what stops a key the
  // endpoint has no place for from being dropped in silence.
  return { kind, askedOf, meta, card };
}

/**
 * Post the card and write down what was asked, in that order.
 *
 * Same two steps, same order and the same failure wording as
 * `comm.ask_card`: both produce one interaction-request and one pending
 * record, so the two entries are interchangeable for the answering side.
 *
 * 🔴 The returned `action_ids` reach the caller because `scripts/send.js` ends
 * with `console.log(JSON.stringify(result))` — the CLI's stdout IS the return
 * channel for every send. Treat that as a contract of this path, not a
 * convenience of that line: an answer is decoded by matching an action id, and
 * a caller that never sees the ids has no way back to the option. Anything
 * that stops printing this result breaks card answers, silently.
 */
export async function sendCardMessage(conversationId, parsed, deps = {}) {
  const postFn = deps.post || post;
  const record = deps.recordQuestion || recordPendingQuestion;
  const nowIso = deps.now ? deps.now() : new Date().toISOString();

  const request = buildChoiceRequest(parsed.card);
  const res = await postFn(apiPath(`/conversations/${conversationId}/interaction-requests`), request);

  const actionIds = res?.action_ids || res?.data?.action_ids;
  const messageId = res?.message_id || res?.data?.message_id;
  if (!Array.isArray(actionIds) || !actionIds.length || !messageId) {
    // The card is already posted. Say that, so the reader does not retry an
    // ask the person is already looking at.
    throw new CardMessageError(
      `[CARD] card was SENT but the response carried no ${messageId ? 'action_ids' : 'message_id'}, so the answer will not be decodable: ${JSON.stringify(res)}`,
    );
  }

  record({
    kind:           parsed.kind,
    askedOf:        parsed.askedOf,
    conversationId,
    cardMessageId:  messageId,
    actionIds,
    askedAt:        nowIso,
    title:          parsed.card?.title,
    meta:           parsed.meta,
  }, deps.recordOptions);

  return { ok: true, card: true, message_id: messageId, action_ids: actionIds, recorded: true };
}
