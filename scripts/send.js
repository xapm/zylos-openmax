#!/usr/bin/env node

/**
 * C4 standard outbound interface — directly calls cws-core OpenAPI
 * `POST /api/v1/conversations/{conversation_id}/messages`.
 *
 * Usage:
 *   node scripts/send.js '<endpoint>' '<message>'
 *
 * Endpoint forms (per docs/DESIGN.md §3.4; encoded by C4):
 *   <conversationId>
 *   <conversationId>|reply:<messageId>
 *   <conversationId>|thread:<threadConvId>|parent:<parentMsgId>
 * The legacy `[COCO TYPE]/<conversationId>...` form is still accepted by
 * parseEndpoint for backward compatibility.
 *
 * Message body forms:
 *   plain text         → content=[{type:"text", body:<text>}]
 *   markdown-looking   → content=[{type:"markdown", body:<text>}]   (heuristic)
 *   [MEDIA:image]/path → upload via as.js → content=[{type:"image", body:<media_id>}]
 *   [MEDIA:file]/path  → upload via as.js → content=[{type:"file",  body:<media_id>}]
 *   [CARD]{...json...}  → POST .../interaction-requests (a choice card), and
 *                         record what was asked — see src/lib/card-message.js
 *
 * Long text is split into ≤3000-char chunks (paragraph → newline → hard) and
 * sent as sequential POSTs to the same conversation. Each chunk gets its own
 * client_msg_id so the server de-dupes them independently. `reply_to` is
 * applied only on the first chunk to avoid duplicate threading.
 *
 * cws-core SendMessageRequestBody (current schema, per
 * internal/transport/http/message.go:sendMessageRequest):
 *   { client_msg_id, type, content: MessageContentItem, parent_id?,
 *     thread_id?, ttl?, metadata? }
 *   type: enum UNSPECIFIED|TEXT|IMAGE|FILE|AUDIO|VIDEO|SYSTEM|AGENT_TEXT|
 *     AGENT_STRUCTURED|AGENT_CARD|AGENT_STREAM
 *   MessageContentItem: { content_type, body: object, attachments: [] }
 *
 * mentions (optional top-level field on the request, MentionInput[]:
 * {type:"member", member_id}) is resolved per chunk from `@name` tokens
 * against known conversation participants (src/lib/mention.js) — cws-comm
 * only stores mentions the client explicitly supplies, it never parses
 * them out of the text itself, so this step is required for an outbound
 * @-mention to actually wake its target.
 *
 * Auth: Bearer api_key (canonical store: config.agent.api_key) plus
 *       X-Workspace-Id header (handled by client.js).
 */

import fs from 'fs';
import path from 'path';
import { post, get, getForOrg, apiPath } from '../src/lib/client.js';
import { enabledOrgs } from '../src/lib/config.js';
import {
  parseEndpoint,
  looksLikeMarkdown,
  parseMediaPrefix,
  newClientMsgId,
  splitMessage,
} from '../src/lib/message.js';
import { uploadMedia } from '../src/cli/as.js';
import { parseCardMessage, sendCardMessage } from '../src/lib/card-message.js';
import {
  resolveMentions,
  buildMentions,
  needsRosterHydration,
  recordRoster,
  rosterFetchedRecently,
  markRosterFetched,
} from '../src/lib/mention.js';
import { lookupConvOrg, registerConvOrg } from '../src/lib/conv-org.js';
import { RUNTIME_DIR } from '../src/lib/session.js';

const TYPING_DIR = path.join(RUNTIME_DIR, 'typing');

function markTypingDone(messageId) {
  if (!messageId) return;
  const safe = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
  try {
    fs.mkdirSync(TYPING_DIR, { recursive: true });
    fs.writeFileSync(path.join(TYPING_DIR, `${safe}.done`), String(Date.now()));
  } catch {}
}

function usage() {
  console.error('Usage: node scripts/send.js <endpoint> <message>');
  console.error('');
  console.error('Endpoint format:');
  console.error('  <conversationId>');
  console.error('  <conversationId>|reply:<messageId>');
  console.error('  <conversationId>|thread:<threadId>|parent:<parentMsgId>');
  console.error('  (legacy [COCO TYPE]/<conversationId>... is still accepted)');
  console.error('');
  console.error('Message: plain text, markdown (auto-detected), [MEDIA:image|file]/abs/path,');
  console.error('         or [CARD]{"title":..,"summary":..,"text":..,"options":[..],"kind":..,"askedOf":..}');
}

/**
 * Pick the conversation_id the message actually targets. For a thread
 * endpoint, the thread is its own conversation so we send to it; for
 * DM/group, we send to the parent conversation. reply_to is the only
 * field cws-core's SendMessageRequestBody supports for in-context
 * replies (thread parent_message_id is not in the schema).
 */
function resolveTargetConversation(ep) {
  return ep.threadConversationId || ep.conversationId;
}

// Bound on the best-effort roster GET. Native fetch has no default deadline, so
// a members endpoint that accepts the connection and then never answers would
// hang this promise forever — and a try/catch can't rescue a promise that never
// rejects, so the whole send would wedge (not "fall back to no mention"). A
// short deadline turns that hang into a normal rejection we can swallow. Kept
// generous enough that a merely-slow-but-healthy backend still resolves the
// mention; the negative cache below stops a bad endpoint from costing it twice.
const ROSTER_HYDRATION_TIMEOUT_MS = 2000;

/**
 * Fill the mention registry from the conversation roster, but only when the
 * text actually mentions somebody we can't already resolve.
 *
 * Best-effort throughout: a roster fetch that fails, times out, or hangs must
 * never block the send. The worst case is the pre-existing behaviour — an
 * @name that resolves to no mention — not a dropped message.
 *
 * The conversation is stamped as "fetched" BEFORE the request, and skipped for
 * ROSTER_FETCH_TTL_MS afterwards, so a persistently-unresolvable @token (or an
 * unresponsive endpoint) can't re-issue this GET on every message.
 */
async function hydrateRosterIfNeeded(text, convId) {
  if (!convId || rosterFetchedRecently(convId)) return;
  if (!needsRosterHydration(text, convId)) return;
  markRosterFetched(convId);
  try {
    const res = await get(apiPath(`/conversations/${convId}/members`), undefined, {
      timeoutMs: ROSTER_HYDRATION_TIMEOUT_MS,
    });
    const members = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
    recordRoster(convId, members);
  } catch {
    /* best-effort: fall back to whatever the registry already knew */
  }
}

async function sendText(ep, text) {
  const convId = resolveTargetConversation(ep);
  // The registry only knows participants observed speaking here, so an @name
  // aimed at someone who has never spoken would silently resolve to nothing —
  // and this reply path has no parameter slot for passing mentions explicitly,
  // so the auto-resolution below is the only mention mechanism it has. When the
  // text mentions somebody we can't resolve, fetch the roster once and record
  // it, then let the normal resolution run against the now-complete registry.
  await hydrateRosterIfNeeded(text, convId);
  // If an @token still can't be resolved after hydration, the target isn't in
  // the roster (misspelled, or not a member): the mention will silently produce
  // nothing. Surface that on stderr so a dead @ is diagnosable instead of
  // invisible — never blocks the send.
  if (needsRosterHydration(text, convId)) {
    console.warn(`[send] unresolvable @mention in conversation ${convId}; sending without a structured mention`);
  }
  // Canonicalize @mentions to the exact participant display_name so cws-fe's
  // participant-name matcher highlights them (cws-fe issue #6 covers the
  // AGENT_TEXT render side). No-op when no known participant matches.
  text = resolveMentions(text, convId);
  const chunks = splitMessage(text);
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const contentType = looksLikeMarkdown(chunk) ? 'markdown' : 'text';
    // Resolve this chunk's own `@name` tokens to a structured mentions[]
    // entry (cws-core MentionInput[]) against known conversation
    // participants. Without this, agent-sent @-mentions never wake their
    // target: cws-comm only stores mentions it's explicitly given, it does
    // not parse them out of the text itself (see src/lib/mention.js).
    const mentions = buildMentions(chunk, convId);
    // cws-core SendMessageRequest body (current schema):
    //   { client_msg_id, type, content: {content_type, body, attachments}, parent_id?, mentions? }
    // type is the message-level enum (AGENT_TEXT for agent outbound text /
    // markdown); content.content_type is the body serialization
    // ('text' | 'markdown' | ...). attachments is required (may be empty).
    const body = {
      client_msg_id: newClientMsgId(),
      type:          'AGENT_TEXT',
      content: {
        content_type: contentType,
        body:         { text: chunk },
        attachments:  [],
      },
      // parent_id only on the first chunk to avoid duplicate threading
      ...(i === 0 && ep.replyTo ? { parent_id: ep.replyTo } : {}),
      ...(mentions ? { mentions } : {}),
    };
    // eslint-disable-next-line no-await-in-loop
    const res = await post(apiPath(`/conversations/${convId}/messages`), body);
    results.push(res?.id || res?.message_id || null);
  }
  return { ok: true, chunks: chunks.length, message_ids: results };
}

async function sendMediaMessage(ep, kind, localPath, caption) {
  const convId = resolveTargetConversation(ep);
  const messageType = kind === 'image' ? 'IMAGE' : 'FILE';
  const contentType = kind === 'image' ? 'image' : 'file';
  // IM-mode finalize returns BOTH `mediaId` and `artifactId` as *distinct* UUIDs:
  //   - `mediaId`    : cws-comm-internal media reference (lives on the message)
  //   - `artifactId` : cws-as artifact id (the actual blob in storage)
  // The chat message's `attachments[].artifact_id` field must hold the
  // cws-as id so that any consumer (FE / agent) can `as.resolve` it to a
  // download URL. Using `mediaId` instead yields a "image loading…" forever
  // placeholder because cws-as has no record of that id. See group thread
  // 2026-06-04 22:24 HKT for the cross-agent investigation.
  // uploadMedia returns the resolved MIME under `mimeType`; older shapes used
  // `contentType`. Read `mimeType` first and fall back to `contentType` so the
  // attachment's content_type isn't dropped (issue #8) — otherwise the
  // outbound message ships an empty MIME and the FE can't render the image.
  const { mediaId, artifactId, fileName, mimeType, contentType: legacyContentType, sizeBytes } = await uploadMedia(localPath, {
    conversationId: convId,
    mediaType: contentType,
  });
  const mediaContentType = mimeType || legacyContentType || '';
  return post(apiPath(`/conversations/${convId}/messages`), {
    client_msg_id: newClientMsgId(),
    type:          messageType,
    content: {
      content_type: contentType,
      // cws-fe renders the file/image card and caption from content.body
      // ({file_name, text}); an empty body shows a blank bubble. Match the
      // shape the web client itself sends (chat/page.tsx) so attachments and
      // the caption render. Sending body:{} here was the blank-bubble bug.
      body:         { file_name: fileName || '', ...(caption ? { text: caption } : {}) },
      attachments: [{
        artifact_id:  artifactId || mediaId,    // prefer the cws-as artifact id; fall back to media id only for backward-compat
        file_name:    fileName || '',
        content_type: mediaContentType || '',
        size_bytes:   sizeBytes || 0,
      }],
    },
    ...(ep.replyTo ? { parent_id: ep.replyTo } : {}),
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) { usage(); process.exit(1); }

  const [endpoint, ...messageParts] = args;
  const message = messageParts.join(' ');

  // Smart-mode escape hatch: when formatInboundForC4 emits a <smart-mode>
  // block, the LLM may decide to stay silent by replying with the literal
  // string "[SKIP]". Treat that as a no-op so we don't actually post it.
  // Mirrors zylos-feishu/scripts/send.js:64.
  if (message.trim() === '[SKIP]') {
    console.log(JSON.stringify({ ok: true, skipped: true }));
    return;
  }

  let ep;
  try {
    ep = parseEndpoint(endpoint);
  } catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(1);
  }

  // Multi-org: resolve the conversation's org so downstream API calls use
  // the correct org-scoped JWT. Without this, resolveDefaultOrgId() returns
  // empty when 2+ orgs are enabled, producing an identity-only token → 401.
  if (!process.env.COCO_ORG_ID) {
    const convId = ep.threadConversationId || ep.conversationId;
    let orgId = lookupConvOrg(convId);

    // Fallback: outbound-first DMs have no map entry yet. Reverse-lookup by
    // trying each enabled org until one can access the conversation.
    if (!orgId) {
      for (const org of enabledOrgs()) {
        try {
          await getForOrg(org.org_id, apiPath(`/conversations/${convId}`));
          orgId = org.org_id;
          registerConvOrg(convId, orgId);
          break;
        } catch { /* 401/403/404 → try next org */ }
      }
    }

    if (orgId) process.env.COCO_ORG_ID = orgId;
  }

  try {
    // Three-way dispatch, and nothing more: what a `[CARD]` body means, and
    // what a malformed one costs, lives in src/lib/card-message.js, where
    // there is a test surface. A card that fails to parse throws out of here
    // into the catch below — it is NEVER downgraded to sendText, because
    // posting the raw JSON as chat looks, to this agent, exactly like having
    // asked the question.
    const card = parseCardMessage(message);
    const media = card ? null : parseMediaPrefix(message);
    let result;
    if (card) result = await sendCardMessage(resolveTargetConversation(ep), card);
    else if (media) result = await sendMediaMessage(ep, media.kind, media.localPath, media.caption);
    else result = await sendText(ep, message);
    markTypingDone(ep.replyTo || ep.conversationId);
    // Contract, not incidental output: this line is how `action_ids` get back
    // to the caller, and an answer cannot be decoded without them. See the
    // note on sendCardMessage.
    console.log(JSON.stringify(result));
  } catch (e) {
    const payload = { error: e.message };
    if (e.status) payload.status = e.status;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
