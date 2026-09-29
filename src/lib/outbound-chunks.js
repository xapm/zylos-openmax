/**
 * Split an outbound text message into chunks and decide which structured
 * mentions travel on each one (workspace-backlog#350).
 *
 * Mentions are resolved ONCE, against the whole text, BEFORE splitting, and
 * every chunk carries the full set. Resolving per chunk (the old behavior)
 * left every chunk after the one containing `@name` with no mentions — and in
 * a group whose receiving agent runs in the default `mention` mode, that chunk
 * is dropped as background traffic without any notice to anyone. This mirrors
 * the lark skill's sendText, which assembles mentions before splitMessage for
 * the same reason.
 *
 * Consequence: a broadcast sentinel (`@所有人` / `@所有Agent`) anywhere in the
 * text now applies to every chunk, and every chunk carries a mention of each
 * mentioned member.
 */

import { splitMessage } from './message.js';
import { buildMentions } from './mention.js';

// cws-comm rejects the whole send when mentions exceeds this
// (maxMentionsPerMessage in internal/app/message_service.go).
export const MAX_MENTIONS_PER_MESSAGE = 200;

/**
 * @param {string} text
 * @param {string} conversationId
 * @param {number} [maxLen] forwarded to splitMessage
 * @returns {{ text: string, mentions: object[] | undefined }[]}
 *   `mentions` is undefined (not []) when nothing resolves — same contract as
 *   buildMentions.
 */
export function planOutboundChunks(text, conversationId, maxLen) {
  let mentions = buildMentions(text, conversationId);
  if (mentions && mentions.length > MAX_MENTIONS_PER_MESSAGE) {
    // Broadcast sentinels come first in buildMentions' output, so they survive.
    console.warn(`[send] ${mentions.length} mentions exceed the cws-comm limit of ${MAX_MENTIONS_PER_MESSAGE}; dropping the rest`);
    mentions = mentions.slice(0, MAX_MENTIONS_PER_MESSAGE);
  }
  return splitMessage(text, maxLen).map((chunk) => ({ text: chunk, mentions }));
}
