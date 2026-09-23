#!/usr/bin/env node

/**
 * Communication bridge — PM2 service entry point.
 *
 * Multi-org architecture:
 *   1. Reads `config.orgs.*` (enabled entries only).
 *   2. Opens ONE WebSocket per enabled org. Each connection is independent:
 *      its own urlProvider (per-org ws-ticket), its own message handler bound
 *      to that org's identity and access policy, its own reconnect lifecycle.
 *   3. Inbound `message` frames go through per-org `shouldHandleMessage`
 *      (lark-style dmPolicy / groupPolicy / per-group config / owner) before
 *      being forwarded to C4.
 *   4. A single org going terminal (4002/4005/4006) only stops that org's
 *      WS; other orgs keep running. The process exits only if every enabled
 *      org has gone terminal.
 *
 * Conversation type lookup: when an inbound message arrives, the frame
 * carries conversation_id but not the conversation type. We fetch the
 * conversation via REST once and cache it for the dedup TTL window.
 */

import path from 'path';
import { execFile } from 'child_process';

import { loadConfig, watchConfig, enabledOrgs, bindOwner, setOwner, updateOwnerName, setSelfDisplayName, updateConfig } from './lib/config.js';
import { registerConvOrg } from './lib/conv-org.js';
import { createComposeConsumer } from './lib/automation-compose.js';
import { createSelfNameHydrator } from './lib/self-name-hydration.js';
import { WsClient, createDeduper } from './lib/ws.js';
import { resolveInboundContent } from './lib/inbound-content.js';
import { formatInboundForC4, formatEndpoint, newClientMsgId } from './lib/message.js';
import { isSystemSender, systemEventPriority } from './lib/system-message.js';
import { isSiblingAgentSender } from './lib/dm-access.js';
import { recordParticipants } from './lib/mention.js';
import { getMediaUrl, downloadMedia } from './cli/as.js';
import { getForOrg, postForOrg, putForOrg, delForOrg, apiPath, getForOrgWithHeaders } from './lib/client.js';
import { createChannelInstaller, isChannelEvent } from './lib/channel-connector.js';
import { logSystemFrame } from './lib/system-events.js';
import { createConnectResultQueue, CONNECT_RESULT_RESEND_INTERVAL_MS } from './lib/connect-result-queue.js';
import { createOnlineReporter } from './lib/online-report.js';
import { createDefaultReadinessGate, createGatedOnlineReporter, readinessReport } from './lib/agent-readiness.js';
import { createReadinessTrigger } from './lib/readiness-trigger.js';
import { getAccessToken, getWsTicket, invalidate as invalidateToken } from './lib/token.js';
import fs from 'fs';
import { loadOrgSession, saveOrgSession, RUNTIME_DIR } from './lib/session.js';
import { handleConnectionEventSerialized, sendOwnerReauthDm, buildConnectionAuthorizedNotice } from './lib/connection-events.js';
import { createInboxLedger } from './lib/inbox-ledger.js';
import { seedSessionFromLedger, commitIdentityRebind } from './lib/inbox-rebind.js';
import { deliverWithInSweepRetry } from './lib/sync-head-retry.js';
import { logAndRecord, getHistory, ensureReplay, setLimits } from './lib/group-history.js';
import { checkForUpdates, notifyUpgradeComplete, resolveAutoUpgradeSchedule } from './lib/auto-upgrade.js';
import { createMetricsReporter } from './lib/metrics-reporter.js';
import { createChannelLivenessReporter } from './lib/channel-liveness-reporter.js';
import TaskRegistry from './lib/task-registry.js';
import { startLogRotation } from './lib/log-rotate.js';
import { isOrgLLMSuspended, OVERDUE_NOTICE, shouldSendOverdueNotice } from './lib/billing-status.js';
import {
  AGENT_DIAGNOSTICS_CONFIG_EVENT,
  AGENT_DIAGNOSTICS_EVENT,
  applyDiagnosticsConfig,
  createDiagnosticsHandler,
} from './lib/diagnostics.js';
import { isSelfMentioned } from './lib/self-mention.js';

const LOG_PREFIX = '[comm-bridge]';
const CHANNEL = 'openmax';

// Hardcoded message defaults (aligned with zylos-lark). `config.message.*`
// may override either; if absent, these apply. Operator-edited config.json
// files don't need to mention `message` at all.
const DEFAULT_CONTEXT_MESSAGES = 5;
const DEFAULT_CONTEXT_MAX_MESSAGES = 15;
// (DEFAULT_DEDUP_TTL_MS removed — deduper is count-based, ttlMs was dead code)
const DEFAULT_DEDUP_MAX_ENTRIES = 3000;
// Inbound content-fetch retry. A WS "message" frame carries only metadata; the
// body is fetched via GET /messages/{id}. On a transient GET failure we retry
// once before giving up (and skipping the empty forward). Overridable via
// `config.message.{content_fetch_retries,content_fetch_retry_delay_ms}`.
const DEFAULT_CONTENT_FETCH_RETRIES = 1;        // extra attempts after the first
const DEFAULT_CONTENT_FETCH_RETRY_DELAY_MS = 400;
// In-sweep retry of a content-fetch-failing catch-up head (see sync-head-retry.js).
// Drives the durable give-up counter to its threshold within a SINGLE /sync
// sweep so a permanently-unfetchable head is skipped even on a stable connection
// that never reconnects (the catch-up wedge). The attempt cap is a safety net;
// it comfortably exceeds the give-up threshold (MAX_CONTENT_FETCH_ATTEMPTS=5 in
// content-fetch-giveup.js), so the normal path ends on giveUp, not the cap.
const DEFAULT_SYNC_HEAD_RETRY_DELAY_MS = 400;
const SYNC_HEAD_MAX_INSWEEP_ATTEMPTS = 10;
// Whole-sweep backstop: total in-sweep RE-attempts (attempts beyond each event's
// first) budgeted across one /sync sweep. One permanently-bad head costs
// (give-up threshold − 1) = 4 retries before it is skipped; a budget of 20 lets
// several distinct bad heads be skipped in a single sweep while bounding the
// worst-case added latency (~budget × backoff). Once exhausted, later transient
// failures in the same sweep halt (deferred to the next reconnect) instead of
// retrying in-sweep — so a pathological backlog of many bad heads can't drag one
// catch-up sweep out indefinitely while holding the _syncInFlight guard.
const SYNC_SWEEP_MAX_RETRY_BUDGET = 20;

// #148 identity-rebind: bounded deadline for the GET /api/v1/sync/status probe
// used to re-seed the watermark after a member_id change. On timeout/error the
// rebind is NOT performed (logged, retried next reconnect — owner decision: no
// blind degrade), so this must never hang the onOpen recovery path.
const DEFAULT_SYNC_STATUS_TIMEOUT_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hardcoded WS operational defaults. `config.server.{reconnect_max_delay,
// heartbeat_interval}` may override either; if absent, these apply.
const DEFAULT_WS_RECONNECT_MAX_MS = 30 * 1000;    // 30_000
const DEFAULT_WS_HEARTBEAT_MS     = 30 * 1000;    // 30_000
// Client-initiated WS ping cadence. Must stay comfortably below the ws.js
// frame-watchdog window (heartbeatIntervalMs*2 + 5s = 65s at defaults) so the
// watchdog never starves when server pings don't reach us. Overridable via
// `config.server.ws_ping_interval_seconds` (seconds).
const DEFAULT_WS_PING_INTERVAL_MS = 20 * 1000;    // 20_000
// Stall supervisor. A dial stuck in CONNECTING is not "disconnected" — no close
// arrives, so the reconnect path is never entered — hence a phase-based check
// rather than a liveness one. The threshold must sit above ws.js's own dial
// deadline so this only ever catches what that missed.
const WS_STALL_CHECK_INTERVAL_MS = 30 * 1000;
const WS_STALL_THRESHOLD_MS      = 90 * 1000;

const tasks = new TaskRegistry();

const handleAgentDiagnostics = createDiagnosticsHandler({
  isEnabled: () => config.diagnostics?.enabled === true,
  postForOrg,
  apiPath,
  log,
  warn,
});

const C4_RECEIVE = path.join(
  process.env.HOME || '',
  'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js',
);
const C4_CONTROL = path.join(
  process.env.HOME || '',
  'zylos/.claude/skills/comm-bridge/scripts/c4-control.js',
);

function log(...a)  { console.log(LOG_PREFIX, ...a); }
function warn(...a) { console.warn(LOG_PREFIX, ...a); }

let config = loadConfig();
setLimits(
  config.message?.context_messages ?? DEFAULT_CONTEXT_MESSAGES,
  config.message?.context_max_messages ?? DEFAULT_CONTEXT_MAX_MESSAGES,
);
// Persist the deduper's seen-id window to disk (runtime/dedup.json) so a
// restart/reconnect catch-up re-pull is deduped by message_id. Retention is
// count-based: keep the most recent `maxEntries` ids (default 3000, covering
// 1.5× SYNC_MAX_EVENTS). Overridable via `config.message.dedup_max_entries`.
const DEDUP_PATH = path.join(RUNTIME_DIR, 'dedup.json');
const dedupe = createDeduper({
  persistPath: DEDUP_PATH,
  maxEntries: config.message?.dedup_max_entries ?? DEFAULT_DEDUP_MAX_ENTRIES,
});

// org_id → cached Conversation row (response_mode no longer used for filter
// but other fields like `type` are still useful)
const conversationCache = new Map();

// `${orgId}:${memberId}` → resolved display name. Member display names are
// stable for the life of the process; caching avoids a /members/{id} lookup
// per inbound message (and per context line) for the same sender.
const memberNameCache = new Map();

// message_id → { text, ts }. TTL slightly over 2 min (the recall window).
const MSG_TEXT_TTL_MS = 130_000;
const recentMsgTextCache = new Map();

function cacheMessageText(messageId, text) {
  if (!messageId || !text) return;
  recentMsgTextCache.set(messageId, { text, ts: Date.now() });
  // Lazy eviction: prune expired entries when cache grows past 500
  if (recentMsgTextCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of recentMsgTextCache) {
      if (now - v.ts > MSG_TEXT_TTL_MS) recentMsgTextCache.delete(k);
    }
  }
}

function getCachedMessageText(messageId) {
  const entry = recentMsgTextCache.get(messageId);
  if (!entry) return '';
  if (Date.now() - entry.ts > MSG_TEXT_TTL_MS) {
    recentMsgTextCache.delete(messageId);
    return '';
  }
  return entry.text;
}

// =============================================================================
// REST helpers
// =============================================================================

/**
 * Resolve a member's display name from cws-core, cached per process.
 * Returns null when the member can't be resolved (caller falls back to the id).
 */
async function fetchMemberName(orgId, memberId) {
  if (!memberId) return null;
  const key = `${orgId}:${memberId}`;
  if (memberNameCache.has(key)) return memberNameCache.get(key);
  try {
    const m = await getForOrg(orgId, apiPath(`/members/${memberId}`));
    const name = m?.display_name || m?.username || null;
    if (name) memberNameCache.set(key, name);
    return name;
  } catch (e) {
    warn(`fetchMemberName ${memberId} failed:`, e.message);
    return null;
  }
}

// `${orgId}:${memberId}` → { ownerId, ts }. A member's owner_member_id can
// change via cws-core transfer-owner, so — unlike display names — this is cached
// with a short TTL and refreshed on expiry. Empty owner ("") is cached too, to
// avoid re-hitting cws-core for senders that legitimately have no owner.
const MEMBER_OWNER_TTL_MS = 300_000;
const memberOwnerCache = new Map();

// fetchMemberOwner reads a member's owner_member_id from cws-core, the
// authoritative source for ownership. Used by the DM sibling-agent exemption:
// the inbound frame carries sender_type/sender_id (cws-comm sets them from the
// authenticated principal, so they're trustworthy) but NOT the sender's owner,
// so we resolve it here — the same member lookup syncOwnerFromCore already uses.
// Returns "" on miss/error so callers treat "owner unknown" as "not a sibling"
// (fail-closed).
async function fetchMemberOwner(orgId, memberId) {
  if (!memberId) return '';
  const key = `${orgId}:${memberId}`;
  const hit = memberOwnerCache.get(key);
  if (hit && Date.now() - hit.ts < MEMBER_OWNER_TTL_MS) return hit.ownerId;
  try {
    const m = await getForOrg(orgId, apiPath(`/members/${memberId}`));
    const ownerId = m?.owner_member_id || '';
    memberOwnerCache.set(key, { ownerId, ts: Date.now() });
    return ownerId;
  } catch (e) {
    warn(`fetchMemberOwner ${memberId} failed:`, e.message);
    return '';
  }
}

async function fetchConversation(orgId, conversationId) {
  if (conversationCache.has(conversationId)) return conversationCache.get(conversationId);
  try {
    const conv = await getForOrg(orgId, apiPath(`/conversations/${conversationId}`));
    conversationCache.set(conversationId, conv);
    return conv;
  } catch (e) {
    warn(`fetchConversation ${conversationId} failed:`, e.message);
    return null;
  }
}

async function fetchRecentMessages(orgId, conversationId, beforeSeq, limit) {
  try {
    const r = await getForOrg(orgId, apiPath(`/conversations/${conversationId}/messages`), {
      before_seq: beforeSeq,
      limit:      limit || 10,
    });
    return Array.isArray(r) ? r : (r?.data || r?.messages || r?.items || []);
  } catch (e) {
    warn('fetchRecentMessages failed:', e.message);
    return [];
  }
}

async function fetchMessageDetail(orgId, conversationId, messageId) {
  try {
    return await getForOrg(orgId, apiPath(`/conversations/${conversationId}/messages/${messageId}`));
  } catch (e) {
    warn(`fetchMessageDetail conv=${conversationId} msg=${messageId} failed:`, e.message);
    return null;
  }
}

/**
 * Send a brief refusal back to the sender when shouldHandleMessage drops a
 * message with a userNotice set. Posted as a reply (parent_id = original) so
 * the sender sees it in-thread on clients that render reply chains. Errors
 * are logged and swallowed — we never want a reject-notice failure to mask
 * the underlying drop decision.
 */
async function sendRejectNotice(orgConfig, msg, text) {
  try {
    await postForOrg(
      orgConfig.org_id,
      apiPath(`/conversations/${msg.conversation_id}/messages`),
      {
        client_msg_id: newClientMsgId(),
        type:          'AGENT_TEXT',
        content: {
          content_type: 'text',
          body:         { text },
          attachments:  [],
        },
        // cws-core's sendMessageRequest expects parent_id as a string. The
        // notification frame may carry numeric `id` (e.g. real-time WS) or a
        // string `id` (e.g. sync catch-up); normalize to avoid HTTP 422
        // "expected string, location body.parent_id".
        parent_id: String(msg.id),
      },
    );
  } catch (e) {
    warn(`[${orgConfig.slug}] reject notice for msg=${msg.id} failed: ${e.message}`);
  }
}

function forwardToC4(endpoint, body, priority) {
  // c4-receive.js only accepts named flags (--channel / --endpoint / --content
  // / --json / --priority); the old positional invocation form
  // `node c4-receive.js <channel> <endpoint> <body>` now rejects with
  // "Unexpected argument: <channel>". execFile passes the array as argv
  // directly, so no shell-escape is needed for content.
  const args = ['--channel', CHANNEL, '--endpoint', endpoint, '--json'];
  // System events map urgent/high/normal → 1/2/3 so urgent platform messages
  // (e.g. approval unblock) jump ahead of normal chat. Omit for normal/chat so
  // c4-receive applies its default (3). See lib/system-message.js.
  if (Number.isInteger(priority) && priority >= 1 && priority <= 3) {
    args.push('--priority', String(priority));
  }
  args.push('--content', body);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [C4_RECEIVE, ...args],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      },
    );
  });
}

// =============================================================================
// Receive acknowledgement — react to an inbound message on receipt, remove on
// reply or timeout. Mirrors zylos-lark's typing-indicator pattern.
// =============================================================================
//
// cws-comm allows agent principals to add reactions as of PRD v2.5 (cws-comm
// MR !398; the prior human-only hard reject was removed). The reaction
// registry is deliberately kept at 8 keys — ⏳ (hourglass) is NOT registered —
// so the "received / processing" acknowledgement uses the closest registered
// code, `eyes` (👀). Overridable via config.message.receive_reaction_code
// (must be one of the registry keys: thumbs_up/smile/heart/tada/eyes/joy/
// fire/white_check_mark). Set to "" to disable. Fire-and-forget: a failed
// reaction must never delay or block delivering the message to the agent.
const DEFAULT_RECEIVE_REACTION = 'eyes';
const REACTION_TIMEOUT_MS = 120_000;

// messageId → { orgId, convId, code, timer }
const activeReactions = new Map();

function reactOnReceive(orgConfig, msg) {
  const code = config.message?.receive_reaction_code ?? DEFAULT_RECEIVE_REACTION;
  if (!code || !msg?.id) return;
  postForOrg(orgConfig.org_id, apiPath(`/messages/${msg.id}/reactions`), { reaction_code: code })
    .then(() => {
      log(`[${orgConfig.slug}] reacted '${code}' on msg=${msg.id}`);
      const timer = setTimeout(() => removeReaction(msg.id, 'timeout'), REACTION_TIMEOUT_MS);
      timer.unref();
      activeReactions.set(msg.id, { orgId: orgConfig.org_id, convId: msg.conversation_id, code, timer });
    })
    .catch(e => warn(`[${orgConfig.slug}] react-on-receive failed msg=${msg.id}: ${e.message}`));
}

function removeReaction(messageId, reason) {
  const state = activeReactions.get(messageId);
  if (!state) return;
  clearTimeout(state.timer);
  activeReactions.delete(messageId);
  delForOrg(state.orgId, apiPath(`/messages/${messageId}/reactions/${state.code}`))
    .then(() => log(`reaction removed msg=${messageId} (${reason})`))
    .catch(e => {
      warn(`reaction remove failed msg=${messageId}: ${e.message}, retrying...`);
      setTimeout(() => {
        delForOrg(state.orgId, apiPath(`/messages/${messageId}/reactions/${state.code}`))
          .catch(e2 => warn(`reaction remove retry failed msg=${messageId}: ${e2.message}`));
      }, 1000);
    });
}

// Typing-done marker directory: send.js writes `{id}.done` here after a
// successful reply; the poller below picks it up and calls removeReaction.
// The id can be a messageId (explicit reply-to) or a conversationId.
const TYPING_DIR = path.join(RUNTIME_DIR, 'typing');
fs.mkdirSync(TYPING_DIR, { recursive: true });
try { for (const f of fs.readdirSync(TYPING_DIR)) fs.unlinkSync(path.join(TYPING_DIR, f)); } catch {}

const TYPING_POLL_MS = 2000;
const TYPING_STALE_MS = 60_000;

function findReactionByConv(convId) {
  for (const [msgId, state] of activeReactions) {
    if (state.convId === convId) return msgId;
  }
  return null;
}

function pollTypingDone() {
  let files;
  try { files = fs.readdirSync(TYPING_DIR); } catch { return; }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.done')) continue;
    const fp = path.join(TYPING_DIR, f);
    const id = f.slice(0, -5); // strip .done
    try {
      const ts = parseInt(fs.readFileSync(fp, 'utf8').trim(), 10) || 0;
      if (now - ts > TYPING_STALE_MS) {
        fs.unlinkSync(fp);
        continue;
      }
    } catch { /* file vanished between readdir and read — ignore */ }
    try { fs.unlinkSync(fp); } catch {}
    // Match by messageId first, then by conversationId
    if (activeReactions.has(id)) {
      removeReaction(id, 'reply');
    } else {
      const msgId = findReactionByConv(id);
      if (msgId) removeReaction(msgId, 'reply');
    }
  }
}
tasks.register('typing-poll', pollTypingDone, TYPING_POLL_MS);
tasks.start('typing-poll');

// Export path for send.js to import.
export { TYPING_DIR };

// =============================================================================
// Mark conversation as read — advance the agent's read cursor
// =============================================================================
//
// POST /api/v1/conversations/{id}/read — tells cws-comm that the agent has
// consumed messages up to the current point. Without this, the agent's read
// cursor stays at 0 and cws-fe shows perpetual "unread" badges.
// Fire-and-forget (like reactOnReceive): a failed mark-read must never block
// message delivery or outbound sends.

function markRead(orgConfig, conversationId, seq) {
  if (!conversationId || !seq) return;
  postForOrg(orgConfig.org_id, apiPath(`/conversations/${conversationId}/read`), { read_until_seq: seq })
    .then(() => log(`[${orgConfig.slug}] marked read conv=${conversationId} seq=${seq}`))
    .catch(e => warn(`[${orgConfig.slug}] mark-read failed conv=${conversationId}: ${e.message}`));
}

// =============================================================================
// Policy filter — lark-style, applied per inbound message
// =============================================================================

function extractMentions(msg) {
  const raw =
       msg.mentions
    || msg.mention_user_ids
    || msg.content?.mention_user_ids
    || msg.message?.mentions
    || [];
  // Normalize to a list of ID strings. cws-comm shape is {entity_id, ...};
  // raw string IDs and {id} variants are supported as fallbacks.
  return raw.map(m =>
    typeof m === 'string'
      ? m
      : String(m?.entity_id || m?.mentioned_id || m?.id || '')
  ).filter(Boolean);
}

// Detect @<selfName> in the message text body. See src/lib/self-mention.js —
// extracted so the @-boundary logic is unit-testable (issue #85).

// User-facing notice strings shown when a message is rejected. Mirrors the
// English copy in zylos-feishu/src/index.js — group rejections only fire when
// the sender actually @-mentioned us, so a non-@-ed group message that hits a
// policy gate stays silent (no userNotice set). DM rejections always notify.
function noticeDmNotAllowed(ownerName) {
  if (ownerName) return `Sorry, I'm not available for private messages. Please contact ${ownerName} to grant you access.`;
  return "Sorry, I'm not available for private messages. Please ask my owner to grant you access.";
}
const NOTICE_GROUP_DISABLED =
  "Sorry, group chat is currently disabled.";
const NOTICE_GROUP_NOT_ALLOWED =
  "Sorry, I'm not available in this group.";
const NOTICE_GROUP_SENDER_NOT_ALLOWED =
  "Sorry, you don't have permission to interact with me in this group.";

/**
 * Apply DM / group access policy for a specific org. Returns:
 *   { handle: true, reason }   — message passes, agent should respond
 *   { handle: false, reason }  — message dropped (logged with reason)
 *   { handle: true, bindOwnerHint: {memberId, displayName} }
 *                              — pass + caller should auto-bind owner
 *
 * When a drop should be surfaced back to the sender as a polite refusal, the
 * decision additionally carries a `userNotice` string (mirrors
 * zylos-feishu replyToMessage / sendMessage rejection paths). Caller posts it
 * via the cws-core messages API; sync-replay frames are expected to skip the
 * notice to avoid spamming old conversations after a bug fix.
 */
async function shouldHandleMessage(msg, conv, orgConfig) {
  const selfMemberId = orgConfig.self?.member_id;

  // Skip self-echo: agent's own messages within this org.
  if (msg.sender_id && selfMemberId && msg.sender_id === selfMemberId) {
    return { handle: false, reason: 'self-echo' };
  }

  // System Member (调度中心 等平台播报源) is a trusted, write-only identity —
  // let it through unconditionally, bypassing dmPolicy / owner-binding /
  // groupPolicy, which only exist to filter human/agent senders. Without this
  // branch a system DM hits dmPolicy=owner and gets dropped (现象 2「agent 离开」),
  // and a first-DM from 调度中心 would auto-bind it as the owner, dropping the
  // human's later DMs. handle:true with no userNotice also guarantees we never
  // post a reject notice back to a system DM (现象 5). See zylos #58 /
  // v0.7-event-delivery-design.md §6.3.
  if (isSystemSender(msg)) {
    return { handle: true, reason: 'system-sender' };
  }

  const convType = (conv?.type || '').toLowerCase() || (msg.thread_id ? 'thread' : 'dm');
  const access = orgConfig.access || {};
  const senderId = msg.sender_id;
  const senderName = msg.sender_display_name || msg.sender?.display_name || '';

  if (convType === 'dm') {
    const policy = access.dmPolicy || 'owner';
    // Owner is always allowed in DM, regardless of policy (mirrors the group
    // branch's owner @-mention exemption below). Without this, dmPolicy=allowlist
    // silently drops the bound owner's DMs unless their member_id was also
    // manually added to dmAllowFrom — the bug recorded as KB "CWS Issue 汇总" #34.
    const dmOwnerMemberId = orgConfig.owner?.member_id;
    if (dmOwnerMemberId && String(senderId) === String(dmOwnerMemberId)) {
      if (!orgConfig.owner.name && senderName) {
        orgConfig.owner.name = senderName;
        updateOwnerName(orgConfig.slug, senderName);
      }
      return { handle: true, reason: 'dm:owner-exempt' };
    }
    if (policy === 'open') return { handle: true, reason: 'dm:open' };
    // Sibling-agent exemption: agents under the same owner may DM each other by
    // default, regardless of dmPolicy. Checked here (before allowlist/owner
    // gates, after the cheap open short-circuit) so the cws-core owner lookup
    // only fires for AGENT senders that would otherwise be filtered. sender_type
    // and senderId on the frame are trustworthy (cws-comm sets them from the
    // authenticated principal); the frame just doesn't carry the sender's owner,
    // so we resolve it from cws-core — the same member lookup syncOwnerFromCore
    // already uses for ownership.
    const selfOwnerId = orgConfig.owner?.member_id;
    const senderType = String(msg.sender_type || msg.message?.sender_type || '').toUpperCase();
    if (selfOwnerId && senderType === 'AGENT') {
      const senderOwnerId = await fetchMemberOwner(orgConfig.org_id, senderId);
      if (isSiblingAgentSender({ senderType, senderOwnerId, selfOwnerId })) {
        return { handle: true, reason: 'dm:sibling-agent' };
      }
    }
    if (policy === 'allowlist') {
      const list = (access.dmAllowFrom || []).map(String);
      if (list.includes(String(senderId))) return { handle: true, reason: 'dm:allowlist' };
      const ownerName = orgConfig.owner?.name;
      return {
        handle: false,
        reason: `dm:allowlist (sender ${senderId} not listed)`,
        userNotice: noticeDmNotAllowed(ownerName),
      };
    }
    // policy === 'owner' — bound state is derived from owner.member_id
    const owner = orgConfig.owner || {};
    if (!owner.member_id) {
      // First DM ever for this org → auto-bind sender as owner and accept.
      return {
        handle: true,
        reason: 'dm:owner (auto-bind)',
        bindOwnerHint: { memberId: senderId, displayName: senderName },
      };
    }
    // A bound owner is already accepted by the owner-exempt check above; any
    // other sender under owner-policy is rejected.
    return {
      handle: false,
      reason: `dm:owner (sender ${senderId} != bound owner ${owner.member_id})`,
      userNotice: noticeDmNotAllowed(owner.name),
    };
  }

  // group / thread — compute mentioned/owner once up front so all gates and
  // their userNotice decisions share the same view.
  const policy = access.groupPolicy || 'allowlist';
  const convId = msg.conversation_id;
  const groupCfg = (access.groups || {})[convId];

  // Mention detection has two paths: structured mentions[] from cws-comm, and
  // a text-based "@<selfName>" fallback for messages where the server returns
  // the raw text without a structured mentions array.
  // Mention detection is by stable member ID only — the message's structured
  // mentions[] (member UUIDs) is the authoritative and only mention source
  // (cws-comm does not parse @names from text). See src/lib/self-mention.js.
  // This is what stops "@luna.coco" from waking a bare "luna" (issue #85 /
  // cws-comm #329); @all/@all_agents are handled for free via id expansion.
  const mentions = extractMentions(msg).map(String);
  const mentioned = isSelfMentioned({ mentionIds: mentions, selfMemberId });
  const ownerMemberId = orgConfig.owner?.member_id;
  const senderIsOwner = !!ownerMemberId && String(senderId) === String(ownerMemberId);

  if (policy === 'disabled') {
    return {
      handle: false,
      reason: 'group:disabled',
      userNotice: mentioned ? NOTICE_GROUP_DISABLED : undefined,
    };
  }

  // Owner @-mention bypasses the allowlist gate (mirrors zylos-feishu 1242).
  if (policy === 'allowlist' && !groupCfg && !(senderIsOwner && mentioned)) {
    return {
      handle: false,
      reason: `group:allowlist (${convId} not in groups{})`,
      userNotice: mentioned ? NOTICE_GROUP_NOT_ALLOWED : undefined,
    };
  }

  // mode: per-group `mode` if present, else default to 'mention'
  const mode = groupCfg?.mode || 'mention';
  if (mode === 'mention' && !mentioned) {
    // No userNotice — this is normal background traffic, replying would spam.
    return { handle: false, reason: 'group:mention (not @-ed)' };
  }
  // mode === 'smart' bypasses the mention requirement

  // allowFrom: ['*'] / [] = all members allowed; otherwise restrict.
  // Owner is exempt from per-group allowFrom — matches zylos-feishu.
  const allowFrom = groupCfg?.allowFrom;
  if (allowFrom && allowFrom.length > 0 && !allowFrom.includes('*') && !senderIsOwner) {
    if (!allowFrom.map(String).includes(String(senderId))) {
      return {
        handle: false,
        reason: `group:allowFrom (sender ${senderId} not allowed in ${convId})`,
        userNotice: mentioned ? NOTICE_GROUP_SENDER_NOT_ALLOWED : undefined,
      };
    }
  }

  const ownerTag = (!groupCfg && senderIsOwner && mentioned) ? ' [owner-mention-bypass]' : '';
  return {
    handle: true,
    reason: `group:${policy}/${mode}${ownerTag}`,
    mode,
    mentioned,
    groupCfg,
  };
}

// =============================================================================
// Per-org inbound message handler
// =============================================================================

function makeOrgMessageHandler(orgConfig, sessionRef, inboxLedger, wsRef) {
  return async function handleIncomingMessage(payload) {
    const notification = payload?.payload || payload;
    const notifId = notification?.id;
    const notifConv = notification?.conversation_id;
    const notifSender = notification?.sender_id;
    log(`[ws] [${orgConfig.slug}] message frame: id=${notifId || '<missing>'} conv=${notifConv || '<missing>'} sender=${notifSender || '?'}`);
    if (!notifId || !notifConv) return;
    // First-boot replay: a comm-bridge started transiently during the runtime
    // prepare phase can persist a message id to the deduper (runtime/dedup.json)
    // and then fail to deliver it to an agent session (none exists yet) — the
    // C4 forward failure below only warns, it does not forget the id. That
    // stale mark would make the first-boot /sync replay skip the message as a
    // "duplicate", so a fresh agent would still never receive its onboarding /
    // activation DM (#79). On a genuine first boot nothing has been delivered,
    // so forget any such mark before the duplicate check. This is the id-level
    // counterpart to inboxLedger.resetReceived() on the same path.
    if (notification._firstBoot) dedupe.forget?.(notifId);
    if (dedupe(notifId)) {
      log(`[ws] [${orgConfig.slug}] msg=${notifId} duplicate, skipping`);
      return;
    }

    // Resolve the message body. The WS "message" frame carries only metadata
    // (id/conv/sender) — the body comes from GET /messages/{id}. Retry the
    // fetch once so a transient GET failure doesn't degrade to an EMPTY message
    // being forwarded to the agent (the historical bug: the real text only
    // arrived later, out of order, via the next /sync catch-up).
    const contentResult = await resolveInboundContent({
      // NB: this thunk THROWS on a fetch/HTTP error (getForOrg rejects on
      // non-2xx / network failure) — deliberately NOT fetchMessageDetail, which
      // swallows errors to a null return. resolveInboundContent needs the throw
      // to classify a TRANSIENT fetch failure ('error') distinctly from a
      // successful GET that yields an empty body ('skip-empty' / poison); only
      // the latter is skip-eligible. Collapsing both to null would let a brief
      // GET outage skip and permanently drop a legitimate message.
      getDetail: () => getForOrg(orgConfig.org_id, apiPath(`/conversations/${notification.conversation_id}/messages/${notification.id}`)),
      notification,
      retries: config.message?.content_fetch_retries ?? DEFAULT_CONTENT_FETCH_RETRIES,
      delayMs: config.message?.content_fetch_retry_delay_ms ?? DEFAULT_CONTENT_FETCH_RETRY_DELAY_MS,
    });

    if (contentResult.status !== 'ok') {
      // Content couldn't be resolved. Do NOT forward an empty message. Forget the
      // dedupe entry recorded above so a later re-pull isn't suppressed as a
      // duplicate. There are TWO distinct failure modes and they are handled
      // OPPOSITELY — conflating them is how a transient blip permanently drops a
      // real message (the PR#76 ordering contract):
      //
      //   • status 'error' = TRANSIENT fetch failure (GET threw: 5xx/429/network/
      //     404-replication-lag). Keep PR#76 ordering: do NOT advance the /sync
      //     cursor, do NOT count it toward the give-up budget, do NOT skip it —
      //     halt the sweep so it is re-pulled in seq order on the next reconnect
      //     (realtime still forces a reconnect). A valid message whose body just
      //     wasn't fetchable this instant must never be skipped.
      //
      //   • status 'skip-empty' = POISON: the GET SUCCEEDED but the body is
      //     empty/unusable (e.g. a message persisted with an empty body). Only
      //     this counts toward a DURABLE, bounded per-seq give-up counter
      //     (persisted in the inbox-ledger so it survives the connect→restart→
      //     reconnect legs of the wedge). Below the cap: halt-order like above
      //     (and in-sweep retry drives the counter up). At the cap: give up —
      //     advance the ledger watermark past it (gap-detector stops
      //     re-triggering /sync on it) and tell the sweep to skip+advance
      //     instead of halting; alarm-log the (possible, bounded) data loss.
      //
      // Only the /sync catch-up path carries an inbox seq at fetch-fail time; a
      // realtime failure has no seq so it is never counted/skipped here — after
      // its forced reconnect it re-appears on the /sync path WITH a seq.
      dedupe.forget?.(notifId);

      const isTransient = contentResult.status === 'error';

      // Only POISON (empty body) is eligible for the give-up counter + skip.
      const failSeq = (!isTransient && notification._via === 'sync' && typeof notification.seq === 'number')
        ? notification.seq
        : null;
      const failure = (inboxLedger && failSeq != null)
        ? inboxLedger.recordContentFetchFailure(failSeq)
        : null;

      if (failure?.giveUp) {
        inboxLedger.skip(failSeq);
        warn(`[${orgConfig.slug}] ALARM gave up on msg=${notifId} conv=${notifConv} seq=${failSeq} after ${failure.failures} consecutive EMPTY-BODY fetch(es) — SKIPPING it (possible data loss) and advancing past it so the rest of the backlog is delivered`);
        return { contentFetchFailed: true, giveUp: true };
      }

      if (isTransient) {
        // Transient: do not skip, do not count. Halt + re-pull in order.
        warn(`[${orgConfig.slug}] msg=${notifId} conv=${notifConv} content fetch ERRORED after ${contentResult.attempts} attempt(s) (${contentResult.error || 'fetch error'}) — TRANSIENT: not counted toward give-up, cursor not advanced, will re-pull in order` +
          (contentResult.forceReconnect
            ? '; forcing WS reconnect to trigger /sync catch-up'
            : ' (sync-replay path — NOT re-terminating; relying on backoff + un-advanced cursor)'));
        if (contentResult.forceReconnect) {
          try { wsRef?.client?.forceReconnect('content-fetch-transient-error'); } catch {}
        }
        // `transient: true` tells the in-sweep retry loop NOT to retry-to-give-up
        // (that would compress reconnect-spaced retries into a burst); the sweep
        // halts and re-pulls in order.
        return { contentFetchFailed: true, transient: true };
      }

      // POISON below the give-up cap.
      warn(`[${orgConfig.slug}] msg=${notifId} conv=${notifConv} EMPTY body after ${contentResult.attempts} attempt(s)` +
        (failure ? ` (${failure.failures}/${failure.max} consecutive)` : '') +
        ` — forwarding skipped, cursor not advanced` +
        (contentResult.forceReconnect
          ? '; forcing WS reconnect to trigger /sync catch-up'
          : ' (sync-replay path — NOT re-terminating; relying on backoff + un-advanced cursor)'));
      if (contentResult.forceReconnect) {
        try { wsRef?.client?.forceReconnect('empty-message-content-fetch-failed'); } catch {}
      }
      // Signal the /sync sweep (which awaits this handler) to leave its cursor
      // BEFORE this event. The realtime dispatcher ignores the return value.
      return { contentFetchFailed: true };
    }

    const detail = contentResult.detail;
    const msg = { ...notification, ...(detail || {}) };
    cacheMessageText(notification.id, msg.content?.body?.text);

    // Inbox-seq ledger: record the inbox_seq for continuous-ack tracking.
    // Sources (in priority order):
    //   1. Sync catch-up events: notification.seq IS the inbox seq (from /sync)
    //   2. GetMessage response: detail.inbox_seq (when cws-comm deploys it)
    // When absent (WS realtime before server deploys inbox_seq), silently
    // skip — existing sync logic still works as fallback.
    const inboxSeq = (notification._via === 'sync' && typeof notification.seq === 'number')
      ? notification.seq
      : (detail?.inbox_seq ?? detail?.message?.inbox_seq ?? null);
    if (inboxLedger && inboxSeq != null) {
      // Successful processing resets this seq's consecutive content-fetch-failure
      // counter, so only truly-consecutive failures count toward the give-up cap.
      inboxLedger.clearContentFetchFailure(inboxSeq);
      if (!inboxLedger.record(inboxSeq)) {
        log(`[ws] [${orgConfig.slug}] msg=${notifId} inbox_seq=${inboxSeq} already recorded, skipping`);
        return;
      }
    }

    // get-message envelope nests scalar message fields under `message`; for
    // real-time WS frames the notification already carries sender_id/seq/type
    // at the top level, but sync catch-up frames don't. Hoist them so
    // downstream consumers (shouldHandleMessage, msgType detection) see a
    // uniform shape regardless of arrival path.
    if (!msg.sender_id   && msg.message?.sender_id)   msg.sender_id   = msg.message.sender_id;
    if (msg.seq == null  && msg.message?.seq != null) msg.seq         = msg.message.seq;
    if (!msg.type        && msg.message?.type)        msg.type        = msg.message.type;
    if (!msg.thread_id   && msg.message?.thread_id)   msg.thread_id   = msg.message.thread_id;
    if (!msg.parent_message_id && msg.message?.parent_message_id) {
      msg.parent_message_id = msg.message.parent_message_id;
    }

    const conv = await fetchConversation(orgConfig.org_id, msg.conversation_id);
    if (conv) conv.id = conv.id || msg.conversation_id;

    // Record every group message to local history (memory + file) BEFORE the
    // policy filter, mirroring zylos-telegram's logAndRecord pattern. This
    // ensures context is available even for messages the bot doesn't handle.
    const earlyConvType = (conv?.type || '').toLowerCase() || (msg.thread_id ? 'thread' : 'dm');
    if (earlyConvType !== 'dm') {
      const structured = (msg.content && typeof msg.content === 'object') ? msg.content : {};
      const entryText = structured.body?.text
        || (typeof msg.message?.content === 'string' ? msg.message.content : '')
        || (typeof msg.content === 'string' ? msg.content : '')
        || '';
      const msgType = (msg.type || msg.message?.type || '').toLowerCase();
      const atts = Array.isArray(structured.attachments) ? structured.attachments : [];
      const isImg = msgType === 'image' || msgType === 'agent_card';
      let histText = entryText;
      if ((isImg || atts.length > 0) && atts.length > 0) {
        const kind = isImg ? 'image' : 'file';
        const labels = atts.map(a => `[${kind}: ${a.artifact_id || '?'} | ${a.file_name || 'unknown'}]`);
        histText = labels.join(' ') + (entryText ? ' ' + entryText : '');
      } else if (isImg) {
        histText = '[image]' + (entryText ? ' ' + entryText : '');
      }
      ensureReplay(msg.conversation_id);
      const historySenderName = msg.sender_display_name
        || msg.sender?.display_name
        || (await fetchMemberName(orgConfig.org_id, msg.sender_id))
        || msg.sender_id;
      logAndRecord(msg.conversation_id, {
        timestamp: new Date().toISOString(),
        message_id: msg.id,
        sender_id: msg.sender_id,
        sender_name: historySenderName,
        text: histText,
        seq: msg.seq != null ? Number(msg.seq) : null,
        parent_id: msg.parent_message_id || msg.message?.parent_id || null,
        type: msgType || 'text',
      });
    }

    const decision = await shouldHandleMessage(msg, conv || {}, orgConfig);
    if (!decision.handle) {
      log(`drop [${orgConfig.slug}] msg=${msg.id}: ${decision.reason}`);
      // Send a polite refusal only when it actually helps the sender. Two
      // skips:
      //   - sync-replay frames re-process historic messages; a notice for
      //     each would spam stale apologies after a bug fix.
      //   - other agents (sender_type=AGENT) can DM us in normal workflows
      //     (e.g. cws-comm agent-to-agent). They don't read English copy
      //     and could auto-respond, producing reject-notice ping-pong.
      const senderType = String(msg.sender_type || msg.message?.sender_type || '').toUpperCase();
      const isSyncReplay = notification._via === 'sync';
      const isAgentSender = senderType === 'AGENT';
      if (decision.userNotice && !isSyncReplay && !isAgentSender) {
        sendRejectNotice(orgConfig, msg, decision.userNotice).catch(() => {});
      }
      return;
    }

    // Credit-arrears gate. An org whose LLM is suspended for non-payment (欠费)
    // stays online and keeps receiving frames — arrears does NOT drop the WS;
    // only the LLM call is blocked at the gateway. Forwarding anyway would wake
    // the runtime and, because billing is metered post-hoc, dig the org deeper
    // into arrears. So — after shouldHandleMessage decided to HANDLE this real
    // user message, and BEFORE forwardToC4 — consult plan-state; if suspended,
    // notify the sender via the same reply path a policy drop uses and skip the
    // forward. Mirrors the drop path: no notice on sync-replay historic frames
    // (stale spam) or to agent senders (avoids reject-notice ping-pong).
    // isOrgLLMSuspended is fail-open (returns false on any billing-query error),
    // so a plan-state hiccup can never black-hole a user's messages.
    if (await isOrgLLMSuspended(orgConfig)) {
      log(`overdue [${orgConfig.slug}] msg=${msg.id}: org LLM suspended for arrears, not forwarding`);
      const senderType = String(msg.sender_type || msg.message?.sender_type || '').toUpperCase();
      const isSyncReplay = notification._via === 'sync';
      const isAgentSender = senderType === 'AGENT';
      // Always skip forwarding. Send the notice at most once per throttle
      // window per (org + conversation); within the window silently skip the
      // send but still drop the message (no forward, no reaction, no markRead).
      if (!isSyncReplay && !isAgentSender && shouldSendOverdueNotice(orgConfig.org_id, msg.conversation_id)) {
        sendRejectNotice(orgConfig, msg, OVERDUE_NOTICE).catch(() => {});
      }
      return;
    }

    // Feature 1 (chat-features): acknowledge receipt by reacting to the inbound
    // message immediately (fire-and-forget, only for messages we actually
    // handle). See reactOnReceive — ⏳ is not registry-supported, so 👀 is used.
    reactOnReceive(orgConfig, msg);

    if (decision.bindOwnerHint) {
      // Fallback binding only: shouldHandleMessage emits bindOwnerHint solely
      // when no owner is bound, and the WS open-time syncOwnerFromCore has
      // already authoritatively applied any owner cws-core knows about. So we
      // only reach here when core ALSO has no owner — first-DM auto-bind then
      // takes over locally (bindOwner no-ops if a binding sneaked in meanwhile).
      const { memberId, displayName } = decision.bindOwnerHint;
      log(`bind owner (fallback, core had none) [${orgConfig.slug}] member_id=${memberId} name="${displayName}"`);
      bindOwner(orgConfig.slug, memberId, displayName);
      // Mutate the captured orgConfig so subsequent decisions see the new owner.
      orgConfig.owner = { member_id: memberId, name: displayName || '' };
    }

    let recent = [];
    const convType = (conv?.type || '').toLowerCase() || (msg.thread_id ? 'thread' : 'dm');
    if (convType !== 'dm') {
      const baseLimit = config.message?.context_messages ?? DEFAULT_CONTEXT_MESSAGES;
      const maxLimit = config.message?.context_max_messages ?? DEFAULT_CONTEXT_MAX_MESSAGES;

      // Context source priority: memory → file replay → API fallback.
      // logAndRecord (above) already ensured replay + recorded this message.
      // If local has data but fewer than baseLimit, fall back to API for a
      // fuller window (e.g. right after deployment when history is thin).
      let localCtx = getHistory(msg.conversation_id, msg.id, baseLimit);
      let ctx;
      let source;
      if (localCtx && localCtx.length >= baseLimit) {
        source = 'local';
        ctx = localCtx;
      } else {
        source = localCtx && localCtx.length > 0 ? 'api+local' : 'api';
        const apiMsgs = await fetchRecentMessages(
          orgConfig.org_id,
          msg.conversation_id,
          msg.seq,
          baseLimit,
        );
        ctx = apiMsgs;
      }

      // Dynamic expansion: if context or the current message reference parent
      // messages (replies) not in the window, expand to capture the reply chain.
      if (source === 'local') {
        const ctxByMsgId = new Set(ctx.map(e => e.message_id));
        const missingParentIds = new Set();
        const curParentId = msg.parent_message_id || msg.message?.parent_id;
        if (curParentId && !ctxByMsgId.has(curParentId)) missingParentIds.add(curParentId);
        for (const e of ctx) {
          if (e.parent_id && !ctxByMsgId.has(e.parent_id)) missingParentIds.add(e.parent_id);
        }
        if (missingParentIds.size > 0 && ctx.length < maxLimit) {
          const expanded = getHistory(msg.conversation_id, msg.id, maxLimit);
          if (expanded && expanded.length > ctx.length) {
            ctx = expanded;
            log(`context expanded (local): ${baseLimit} → ${ctx.length} msgs (${missingParentIds.size} missing parent(s))`);
          }
        }
        // Convert local entries to the {senderName, content} format.
        // Resolve sender names for entries stored with raw IDs (cold-start
        // replay or entries recorded before this fix).
        const ctxSorted = [...ctx].sort((a, b) => (a.seq || 0) - (b.seq || 0));
        recent = await Promise.all(ctxSorted.map(async e => {
          let name = e.sender_name;
          if (!name || name === e.sender_id) {
            name = (await fetchMemberName(orgConfig.org_id, e.sender_id)) || e.sender_id;
          }
          return { senderName: name, senderId: e.sender_id, content: e.text };
        }));
      } else {
        // API path: ctx is an array of API message objects
        const ctxById = new Map(ctx.map(m => [m.id, m]));
        const missingParentIds = new Set();
        const curParentId = msg.parent_message_id || msg.message?.parent_id;
        if (curParentId && !ctxById.has(curParentId)) missingParentIds.add(curParentId);
        for (const m of ctx) {
          const pid = m.parent_id || m.parent_message_id;
          if (pid && !ctxById.has(pid)) missingParentIds.add(pid);
        }
        if (missingParentIds.size > 0 && ctx.length < maxLimit) {
          const expandCount = Math.min(maxLimit, baseLimit * 3) - ctx.length;
          if (expandCount > 0) {
            const oldestSeq = ctx.reduce((min, m) => Math.min(min, Number(m.seq) || Infinity), Infinity);
            if (oldestSeq < Infinity) {
              const extra = await fetchRecentMessages(
                orgConfig.org_id,
                msg.conversation_id,
                oldestSeq,
                expandCount,
              );
              for (const m of extra) {
                if (!ctxById.has(m.id)) {
                  ctxById.set(m.id, m);
                  ctx.push(m);
                }
              }
              log(`context expanded (api): ${baseLimit} → ${ctx.length} msgs (${missingParentIds.size} missing parent(s))`);
            }
          }
        }

        const ctxAsc = [...ctx].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
        recent = await Promise.all(ctxAsc.map(async m => {
          const senderName = m.sender_display_name
                   || m.senderName
                   || (await fetchMemberName(orgConfig.org_id, m.sender_id))
                   || m.sender_id;
          const mStructured = (m.content && typeof m.content === 'object') ? m.content : {};
          const text = mStructured.body?.text
                   || (typeof m.content === 'string' ? m.content : '')
                   || m.content_text
                   || '';
          const mType = (m.type || m.message?.type || '').toLowerCase();
          const mAttachments = Array.isArray(mStructured.attachments) ? mStructured.attachments
                             : Array.isArray(m.attachments) ? m.attachments : [];
          const mIsImage = mType === 'image' || mType === 'agent_card';
          const mIsFile = !mIsImage && (mType === 'file' || mAttachments.length > 0);
          let content = text;
          if ((mIsImage || mIsFile) && mAttachments.length > 0) {
            const kind = mIsImage ? 'image' : 'file';
            const labels = mAttachments.map(a => `[${kind}: ${a.artifact_id} | ${a.file_name || 'unknown'}]`);
            content = labels.join(' ') + (text ? ' ' + text : '');
          } else if (mIsImage) {
            content = '[image]' + (text ? ' ' + text : '');
          }
          return { senderName, senderId: m.sender_id, content };
        }));
      }
      log(`context [${orgConfig.slug}] conv=${msg.conversation_id} source=${source} count=${recent.length}`);
    }

    // After `msg = { ...notification, ...detail }`, where detail is the
    // get-message response unwrapped from D8 envelope:
    //   msg.message  → { id, content: <string>, type, sender_id, seq, ... }
    //   msg.content  → { content_type, body: { text, ... }, attachments: [] }
    // Older bridge code assumed msg.content was a flat object with `.text`
    // and `.media_id`, which silently produced empty content under the
    // current cws-core schema.
    const structured = (msg.content && typeof msg.content === 'object') ? msg.content : {};
    const text =
        structured.body?.text
     || (typeof msg.message?.content === 'string' ? msg.message.content : '')
     || (typeof msg.content === 'string' ? msg.content : '')
     || '';

    const allAttachments = Array.isArray(structured.attachments) ? structured.attachments : [];
    // Legacy fallback: if no structured attachments, synthesize one from flat fields.
    if (!allAttachments.length && (structured.media_id || structured.filename)) {
      allAttachments.push({ artifact_id: structured.media_id, file_name: structured.filename });
    }
    const shouldDownload = allAttachments.length > 0 && (convType === 'dm' || decision.mentioned || decision.mode === 'smart');
    const mediaItems = [];
    for (const att of allAttachments) {
      const attId = att.artifact_id;
      if (!attId) continue;
      const attFileName = att.file_name;
      const item = { id: attId, fileName: attFileName };
      if (shouldDownload) {
        try {
          const { url } = await getMediaUrl(attId, orgConfig.org_id);
          if (url) {
            const ext = attFileName ? path.extname(attFileName) : '';
            const saveName = attId + ext;
            item.localPath = await downloadMedia(url, saveName);
          }
        } catch (e) {
          warn('media fetch failed:', attId, e.message);
        }
      }
      mediaItems.push(item);
    }

    // Prefer an inline display name from the message; otherwise resolve the
    // sender member via cws-core (cached). Fall back to the raw id only when
    // no name is available — keeps the C4 envelope legible (issue #2).
    const senderName = msg.sender_display_name
                    || msg.sender?.display_name
                    || (await fetchMemberName(orgConfig.org_id, msg.sender_id))
                    || msg.sender_id;
    const msgType = (msg.type || msg.message?.type || '').toLowerCase();
    const endpoint = formatEndpoint({
      type: convType,
      conversationId: msg.conversation_id,
      threadConversationId: msg.thread_id || undefined,
      parentMessageId: msg.thread_id ? msg.parent_message_id : undefined,
    });
    // smartHint mirrors zylos-feishu: only emitted when the group is in smart
    // mode AND the bot was NOT @-mentioned. When the bot was directly @-ed we
    // want a direct reply, not a "should I respond?" deliberation.
    const smartHint = decision.mode === 'smart' && !decision.mentioned;
    const groupName = decision.groupCfg?.name || conv?.name;

    // Record the display name + member_id seen in this conversation (sender +
    // group context) so an outbound `@name` can both be canonicalized to the
    // exact name cws-fe matches on AND resolved to a real `mentions` entry
    // (see src/lib/mention.js — cws-comm never derives mentions from text,
    // only the sending client does). Best-effort; never blocks message handling.
    recordParticipants(msg.conversation_id, [
      { name: senderName, memberId: msg.sender_id },
      ...recent.map((m) => ({ name: m.senderName, memberId: m.senderId })),
    ]);

    // Quoted/reply: cws-comm marks a reply with parent_id (the WS notification
    // frame omits it, so it comes from the get-message detail merged into msg).
    // Fetch the quoted message and surface it as <replying-to>. Threads take
    // precedence (threadContext), so skip for threads.
    let quotedContent;
    const quotedMsgId = msg.parent_id || msg.message?.parent_id || msg.parent_message_id;
    if (quotedMsgId && convType !== 'thread') {
      const q = await fetchMessageDetail(orgConfig.org_id, msg.conversation_id, quotedMsgId);
      if (q) {
        const qStructured = (q.content && typeof q.content === 'object') ? q.content : {};
        let qText =
             qStructured.body?.text
          || (typeof q.message?.content === 'string' ? q.message.content : '')
          || q.message?.fallback_text
          || '';
        // Quoted media: a quoted image/file with no caption yields empty text,
        // which would drop the whole quote. Label it ([image]/[file: name]) and
        // download the referenced attachment, appending `---- <kind>: <path>` so
        // the agent can actually READ the quoted media (not just know it exists).
        const qType = (q.message?.type || '').toLowerCase();
        const qIsImage = qType === 'image' || qType === 'agent_card';
        const qAllAtts = Array.isArray(qStructured.attachments) ? qStructured.attachments : [];
        if (!qAllAtts.length && qStructured.media_id) {
          qAllAtts.push({ artifact_id: qStructured.media_id, file_name: qStructured.filename });
        }
        const qKind = qIsImage ? 'image' : 'file';
        if (!qText && (qIsImage || qAllAtts.length > 0)) {
          qText = qAllAtts.map(a => `[${qKind}${a?.file_name ? ': ' + a.file_name : ''}]`).join(' ') || `[${qKind}]`;
        }
        for (const qAtt of qAllAtts) {
          const qMediaId = qAtt?.artifact_id;
          if (!qMediaId) continue;
          try {
            const { url } = await getMediaUrl(qMediaId, orgConfig.org_id);
            if (url) {
              const qOrigName = qAtt?.file_name;
              const qExt = qOrigName ? path.extname(qOrigName) : '';
              const qSaveName = qMediaId + qExt;
              const qPath = await downloadMedia(url, qSaveName);
              if (qPath) {
                qText += ` ---- ${qKind}: ${qPath}`;
                if (qOrigName) qText += ` name="${qOrigName}"`;
              }
            }
          } catch (e) {
            warn('quoted media fetch failed:', qMediaId, e.message);
          }
        }
        const qSenderId = q.message?.sender_id;
        const qSender =
             q.message?.sender_display_name
          || (await fetchMemberName(orgConfig.org_id, qSenderId))
          || qSenderId;
        if (qText) quotedContent = { sender: qSender, text: qText };
      }
    }

    const isImage = msgType === 'image' || msgType === 'agent_card';
    const isFile = !isImage && mediaItems.length > 0;
    let displayContent = text;
    if (isImage || isFile) {
      const kind = isImage ? 'image' : 'file';
      const labels = mediaItems.map(it => `[${kind}${it.fileName ? ': ' + it.fileName : ''}]`);
      displayContent = labels.join(' ') + (text ? ' ' + text : '');
    }

    const body = formatInboundForC4(
      { type: convType, id: msg.conversation_id, name: groupName },
      { displayName: senderName },
      {
        content: displayContent,
        messageId: msg.id,
        type: isImage ? 'image' : (isFile ? 'file' : 'text'),
        mediaItems,
      },
      recent,
      { groupName, smartHint, quotedContent, orgId: orgConfig.org_id, orgName: orgConfig.org_name },
    );

    try {
      registerConvOrg(msg.conversation_id, orgConfig.org_id);
      await forwardToC4(endpoint, body, systemEventPriority(msg));
      log(`fwd [${orgConfig.slug}] ${convType} ${msg.conversation_id} msg=${msg.id} seq=${msg.seq}`);
      markRead(orgConfig, msg.conversation_id, msg.seq);
    } catch (e) {
      warn('c4-receive failed:', e.message);
    }
  };
}

// =============================================================================
// Per-org WS frame dispatch
// =============================================================================

const _frameTypeCounts = Object.create(null);
const WS_METRIC_INTERVAL_MS = 5 * 60 * 1000;
function recordFrameType(slug, type) {
  const k = `${slug}/${type || '(missing-type)'}`;
  _frameTypeCounts[k] = (_frameTypeCounts[k] || 0) + 1;
}

function dumpFrameMetrics() {
  const entries = Object.entries(_frameTypeCounts);
  if (entries.length === 0) {
    log('ws frame metric: no frames received in this window');
    return;
  }
  entries.sort((a, b) => b[1] - a[1]);
  log(`ws frame metric (cumulative since boot): ${entries.map(([k, n]) => `${k}=${n}`).join(' ')}`);
}


// =============================================================================
// Policy config events — agent.config.* → update config.json + memory
// =============================================================================

const VALID_DM_POLICIES = new Set(['open', 'allowlist', 'owner']);
const VALID_GROUP_SCOPES = new Set(['open', 'allowlist', 'disabled']);
const VALID_GROUP_MODES = new Set(['smart', 'mention', 'silent']);

function handleConfigUpdate(orgConfig, frame) {
  const { event, data } = frame.payload || {};
  if (!data) return;

  if (data.agent_member_id && data.agent_member_id !== orgConfig.self?.member_id) {
    log(`[${orgConfig.slug}] config event ${event} not for us (target=${data.agent_member_id}), skip`);
    return;
  }

  const slug = orgConfig.slug;

  switch (event) {
    case AGENT_DIAGNOSTICS_CONFIG_EVENT: {
      const result = applyDiagnosticsConfig(data, {
        agentMemberId: orgConfig.self?.member_id,
        update: updateConfig,
      });
      if (!result.applied) {
        warn(`[${slug}] diagnostics_changed rejected: ${result.reason}`);
        return;
      }
      // updateConfig refreshes its module cache, but diagnostics command
      // admission closes over this live variable. Assign synchronously instead
      // of relying on fs.watch after the atomic config-file rename.
      config = result.config;
      log(`[${slug}] config updated: diagnostics.enabled → ${result.enabled} (by ${data.changed_by || '?'})`);
      return;
    }

    case 'agent.config.dm_policy_changed': {
      const { policy } = data;
      if (!VALID_DM_POLICIES.has(policy)) {
        warn(`[${slug}] dm_policy_changed: invalid policy "${policy}"`);
        return;
      }
      updateConfig(cfg => {
        const org = cfg.orgs?.[slug];
        if (!org) return;
        org.access = org.access || {};
        org.access.dmPolicy = policy;
      });
      log(`[${slug}] config updated: dmPolicy → ${policy} (by ${data.changed_by || '?'})`);
      break;
    }

    case 'agent.config.dm_allowlist_changed': {
      const { action, member_ids } = data;
      if (!Array.isArray(member_ids) || !member_ids.length) {
        warn(`[${slug}] dm_allowlist_changed: missing or empty member_ids`);
        return;
      }
      updateConfig(cfg => {
        const org = cfg.orgs?.[slug];
        if (!org) return;
        org.access = org.access || {};
        org.access.dmAllowFrom = org.access.dmAllowFrom || [];
        if (action === 'add') {
          const existing = new Set(org.access.dmAllowFrom);
          for (const id of member_ids) if (!existing.has(id)) org.access.dmAllowFrom.push(id);
        } else if (action === 'remove') {
          const toRemove = new Set(member_ids);
          org.access.dmAllowFrom = org.access.dmAllowFrom.filter(id => !toRemove.has(id));
        } else if (action === 'set') {
          org.access.dmAllowFrom = [...member_ids];
        } else {
          warn(`[${slug}] dm_allowlist_changed: unknown action "${action}"`);
          return;
        }
      });
      log(`[${slug}] config updated: dmAllowFrom ${action} ${member_ids.length} member(s) (by ${data.changed_by || '?'})`);
      break;
    }

    case 'agent.config.group_mode_changed': {
      const { mode, conversation_id: convId } = data;
      if (!VALID_GROUP_MODES.has(mode)) {
        warn(`[${slug}] group_mode_changed: invalid mode "${mode}"`);
        return;
      }
      if (!convId) {
        warn(`[${slug}] group_mode_changed: missing conversation_id`);
        return;
      }
      updateConfig(cfg => {
        const org = cfg.orgs?.[slug];
        if (!org) return;
        org.access = org.access || {};
        org.access.groups = org.access.groups || {};
        if (mode === 'silent') {
          delete org.access.groups[convId];
        } else {
          org.access.groups[convId] = org.access.groups[convId] || { allowFrom: ['*'] };
          org.access.groups[convId].mode = mode;
        }
      });
      log(`[${slug}] config updated: group ${convId} mode → ${mode} (by ${data.changed_by || '?'})`);
      break;
    }

    case 'agent.config.group_allowfrom_changed': {
      const { allow_from, conversation_id: convId } = data;
      if (!convId) {
        warn(`[${slug}] group_allowfrom_changed: missing conversation_id`);
        return;
      }
      if (!Array.isArray(allow_from)) {
        warn(`[${slug}] group_allowfrom_changed: allow_from is not an array`);
        return;
      }
      updateConfig(cfg => {
        const org = cfg.orgs?.[slug];
        if (!org) return;
        org.access = org.access || {};
        org.access.groups = org.access.groups || {};
        if (!org.access.groups[convId]) {
          org.access.groups[convId] = { mode: 'mention', allowFrom: allow_from };
        } else {
          org.access.groups[convId].allowFrom = [...allow_from];
        }
      });
      log(`[${slug}] config updated: group ${convId} allowFrom → ${JSON.stringify(allow_from)} (by ${data.changed_by || '?'})`);
      break;
    }

    case 'agent.config.group_scope_changed': {
      const { scope } = data;
      if (!VALID_GROUP_SCOPES.has(scope)) {
        warn(`[${slug}] group_scope_changed: invalid scope "${scope}"`);
        return;
      }
      updateConfig(cfg => {
        const org = cfg.orgs?.[slug];
        if (!org) return;
        org.access = org.access || {};
        org.access.groupPolicy = scope;
      });
      log(`[${slug}] config updated: groupPolicy → ${scope} (by ${data.changed_by || '?'})`);
      break;
    }

    case 'agent.config.group_allowlist_changed': {
      const { action, conversation_ids: convIds } = data;
      if (!Array.isArray(convIds)) {
        warn(`[${slug}] group_allowlist_changed: conversation_ids is not an array`);
        return;
      }
      if (!['add', 'remove', 'set'].includes(action)) {
        warn(`[${slug}] group_allowlist_changed: unknown action "${action}"`);
        return;
      }
      updateConfig(cfg => {
        const org = cfg.orgs?.[slug];
        if (!org) return;
        org.access = org.access || {};
        org.access.groups = org.access.groups || {};
        if (action === 'add') {
          for (const id of convIds) {
            if (!org.access.groups[id]) {
              org.access.groups[id] = { mode: 'mention', allowFrom: ['*'] };
            }
          }
        } else if (action === 'remove') {
          for (const id of convIds) {
            delete org.access.groups[id];
          }
        } else if (action === 'set') {
          const old = org.access.groups;
          org.access.groups = {};
          for (const id of convIds) {
            org.access.groups[id] = old[id] || { mode: 'mention', allowFrom: ['*'] };
          }
        }
      });
      log(`[${slug}] config updated: group_allowlist ${action} ${convIds.length} conversation(s) (by ${data.changed_by || '?'})`);
      break;
    }

    case 'agent.config.owner_changed': {
      const { old_owner_member_id: oldOwner, new_owner_member_id: newOwner, changed_by, reason } = data;
      log(`[${slug}] owner_changed event: ${oldOwner || '(none)'} → ${newOwner || '(none)'} by=${changed_by || '?'} reason=${reason || '?'}`);
      if (oldOwner) memberOwnerCache.delete(`${orgConfig.org_id}:${oldOwner}`);
      if (newOwner) memberOwnerCache.delete(`${orgConfig.org_id}:${newOwner}`);
      syncOwnerFromCore(orgConfig).catch(e =>
        warn(`[${slug}] owner_changed sync failed: ${e.message}`));
      return; // skip the access-sync epilogue — owner is not an access field
    }

    default:
      warn(`[${slug}] unknown config event: ${event}`);
      return;
  }

  // updateConfig() persists to disk and updates currentConfig, but
  // shouldHandleMessage reads from activeOrgConfigs — a separate Map of
  // live references captured at boot. The watchConfig file watcher is
  // supposed to bridge the two, but fs.watch breaks after the first
  // atomic rename (inode change). Sync the live reference directly so
  // policy changes take effect immediately without a service restart.
  const live = activeOrgConfigs.get(slug);
  if (live) {
    const updated = loadConfig().orgs?.[slug];
    if (updated?.access) live.access = updated.access;
  }

  // Immediately report the updated policy back to cws-comm so the server
  // reflects the change without waiting for the 5-minute periodic sync.
  const syncTarget = live || orgConfig;
  syncConfigToComm(syncTarget).catch(e =>
    warn(`[${slug}] immediate config sync to comm failed: ${e.message}`));
}

// =============================================================================
// System events — message recall / edit → inject a notice to the agent
// =============================================================================
//
// cws-comm delivers non-create message lifecycle events (recalled / edited /
// deleted / reaction) as `system` frames — see cws-comm
// internal/transport/ws/gateway_consumer.go buildWSFrame(): "message.created"
// becomes a `message` frame, every other event becomes a `system` frame whose
// payload is { event, conversation_id, data }, where `data` is the raw event
// JSON (message_id, edited_by / deleted_by, new content, ...). We surface
// recall and edit to the agent as a synthetic inbound notice so it knows a
// prior message changed; reactions / read-state / other system events are
// logged and ignored (unchanged behavior).

// Event-name strings are cws-comm's authoritative domain event constants
// (cws-comm internal/domain/message_events.go, *.EventName()):
//   "message.recalled" / "message.deleted" -> recall
//   "message.updated"                       -> edit  (NB: cws-comm names edit
//                                              "updated", not "edited")
// Ignored (return null): message.created / .read / .delivered /
//   .reaction.added / .reaction.removed / .mention.created.
// Exact match keeps us in lock-step with the contract; the substring fallback
// only guards against a future rename (e.g. a "message.edited" alias).
function classifySystemEvent(eventName) {
  const e = String(eventName || '').toLowerCase();
  if (e === 'message.recalled' || e === 'message.deleted') return 'recall';
  if (e === 'message.updated') return 'edit';
  if (e.startsWith('agent.config.')) return 'config_update';
  if (e === AGENT_DIAGNOSTICS_EVENT) return 'diagnostics';
  if (e.startsWith('connection.')) return 'connection';
  if (isChannelEvent(e)) return 'channel';
  // Defensive fallback for naming drift — does not match reaction/read/etc.
  if (e.includes('recall') || e.includes('delete')) return 'recall';
  if (e.includes('edit') || e.includes('updat')) return 'edit';
  return null;
}

async function handleSystemEvent(orgConfig, frame) {
  const payload = frame.payload || {};
  const kind = classifySystemEvent(payload.event);
  if (!kind) {
    // Benign INFO: an event kind we don't act on. The dispatcher already logged
    // the single line for this frame via logSystemFrame() (one "unhandled
    // system event: …" line for unknowns, nothing for benign no-ops), so we do
    // NOT log again here — doing so double-logged every unknown event. See task
    // #44 log hygiene.
    return;
  }

  if (kind === 'config_update') {
    handleConfigUpdate(orgConfig, frame);
    return;
  }

  if (kind === 'diagnostics') {
    await handleAgentDiagnostics(orgConfig, frame);
    return;
  }

  if (kind === 'connection') {
    handleConnectionEventForOrg(orgConfig, frame).catch(e =>
      warn(`[${orgConfig.slug}] handleConnectionEvent: ${e.message}`));
    return;
  }

  if (kind === 'channel') {
    // Fire-and-forget, best-effort install/uninstall of an IM channel component
    // (cws-connect → cws-comm → openmax). handleChannelCommand never throws.
    handleChannelCommand(orgConfig, frame).catch(e =>
      warn(`[${orgConfig.slug}] handleChannelCommand: ${e.message}`));
    return;
  }

  const data = payload.data || {};
  const conversationId = payload.conversation_id || data.conversation_id;
  if (!conversationId) {
    warn(`[${orgConfig.slug}] system ${payload.event}: missing conversation_id, skip`);
    return;
  }
  const messageId = data.message_id || data.id || data.msg_id || '';

  // Dedup so a reconnect/catch-up replay of the same lifecycle event does not
  // re-inject the notice. Keyed distinctly from message-create ids.
  const dedupKey = `sys:${kind}:${conversationId}:${messageId || payload.event}`;
  if (dedupe(dedupKey)) {
    log(`[${orgConfig.slug}] system ${kind} dedup msg=${messageId}`);
    return;
  }

  const orgId = orgConfig.org_id;
  const actorId = data.recalled_by || data.edited_by || data.sender_id || '';

  // Resolve conversation type and apply the same policy check as regular
  // messages. Without this, edit/recall events from groups not in the
  // allowlist would bypass shouldHandleMessage and reach the agent.
  const conv = await fetchConversation(orgId, conversationId);
  const convType = (conv?.type || '').toLowerCase() || 'dm';
  const syntheticMsg = {
    conversation_id: conversationId,
    sender_id: actorId,
    sender_type: data.sender_type || 'HUMAN',
  };
  const decision = await shouldHandleMessage(syntheticMsg, conv || {}, orgConfig);
  if (!decision.handle) {
    log(`drop [${orgConfig.slug}] system ${kind} msg=${messageId}: ${decision.reason}`);
    return;
  }

  const actorName = (await fetchMemberName(orgId, actorId)) || actorId || '对方';

  let notice;
  if (kind === 'recall') {
    let originalText = messageId ? getCachedMessageText(messageId) : '';
    if (!originalText && messageId) {
      const detail = await fetchMessageDetail(orgId, conversationId, messageId);
      originalText = detail?.content?.body?.text || '';
    }
    notice = originalText
      ? `[Message Recalled] Do not act on it. (Original: ${originalText})`
      : `[Message Recalled] A message was recalled. Do not act on it.`;
  } else {
    let newText = '';
    if (messageId) {
      const detail = await fetchMessageDetail(orgId, conversationId, messageId);
      newText = detail?.content?.body?.text || '';
    }
    if (!newText) {
      newText = (typeof data?.content?.body?.text === 'string' && data.content.body.text)
        || (typeof data.new_content === 'string' && data.new_content)
        || (typeof data.text === 'string' && data.text)
        || '';
    }
    notice = newText
      ? `[Message Edited] ${newText}`
      : `[Message Edited] A message was edited. Use the latest content.`;
  }

  const convName = conv?.name || conv?.display_name || '';
  const endpoint = formatEndpoint({ type: convType, conversationId });
  const body = formatInboundForC4(
    { type: convType, id: conversationId, name: convName },
    { displayName: actorName },
    { content: notice, type: 'text' },
    [],
    { orgId: orgConfig.org_id, orgName: orgConfig.org_name },
  );
  try {
    registerConvOrg(conversationId, orgConfig.org_id);
    await forwardToC4(endpoint, body);
    log(`[${orgConfig.slug}] system ${kind} notice -> agent conv=${conversationId} msg=${messageId}`);
  } catch (e) {
    warn(`[${orgConfig.slug}] system ${kind} notice failed: ${e.message}`);
  }
}

// =============================================================================
// Connection events — cws-connect credential lifecycle
// =============================================================================
// Logic lives in ./lib/connection-events.js (this file has side-effecting
// top-level startup code that makes it unsafe to import in a test); wire this
// module's log/warn in as the only override, production HTTP/storage defaults
// otherwise.

// SERIALIZED per (org + connection_id): the system-frame dispatch fires this
// fire-and-forget, so two events for the SAME connection (e.g. an in-flight
// credential_updated refresh and a following revoke) must not overlap and
// resurrect a torn-down MCP server. handleConnectionEventSerialized chains them in
// arrival order per key; different connections/orgs still run in parallel.
function handleConnectionEventForOrg(orgConfig, frame) {
  return handleConnectionEventSerialized(orgConfig, frame, {
    log, warn,
    notify: (info) => notifyConnectionAuthorized(orgConfig, info),
    notifyReauth: (info) => notifyReauthNeeded(orgConfig, info),
  });
}

// A connection needs re-authorization (its credential expired / was revoked
// upstream) → DM the owner (a real DM, not a session control inject) so a human
// can go re-authorize it in the connect UI. The DM send itself lives in
// connection-events.js (postForOrg-injectable, unit tested); this wraps it with
// production defaults + logging. Best-effort — never throws into the event
// handler (the handler already flagged the connection needs_reauth locally, so
// conn.invoke surfaces an actionable hint even if this DM fails).
async function notifyReauthNeeded(orgConfig, info = {}) {
  const ownerId = orgConfig.owner?.member_id;
  if (!ownerId) {
    warn(`[${orgConfig.slug}] reauth_needed: no owner bound — cannot DM (conn=${info.connectionId || '?'})`);
    return;
  }
  try {
    const r = await sendOwnerReauthDm(orgConfig, info);
    if (r.sent) log(`[${orgConfig.slug}] reauth owner DM sent conn=${info.connectionId || '?'} conv=${r.conversationId}`);
    else warn(`[${orgConfig.slug}] reauth owner DM not sent (${r.reason}) conn=${info.connectionId || '?'}`);
  } catch (e) {
    warn(`[${orgConfig.slug}] reauth owner DM failed conn=${info.connectionId || '?'}: ${e.message}`);
  }
}

// A connection was authorized to this agent → tell the bot session so it can act
// via conn.* immediately, instead of only discovering the connection if it happens
// to run conn.list. Session-level control inject (no conversation context), mirroring
// notifyOwnerChanged. Best-effort; never throws into the event handler.
function notifyConnectionAuthorized(orgConfig, info = {}) {
  const content = buildConnectionAuthorizedNotice(orgConfig, info);
  execFile(
    process.execPath,
    [C4_CONTROL, 'enqueue', '--content', content, '--priority', '2', '--no-ack-suffix'],
    { timeout: 10000 },
    (err, _stdout, stderr) => {
      if (err) warn(`[${orgConfig.slug}] failed to enqueue connection-authorized control: ${stderr || err.message}`);
      else log(`[${orgConfig.slug}] connection-authorized control enqueued conn=${info.connectionId || '?'}`);
    },
  );
}

// =============================================================================
// Channel connector — cws-connect IM channel install/uninstall (Phase 1: feishu)
// =============================================================================
//
// Same command shape as connection events: cws-connect dispatches a `channel.*`
// system frame over cws-comm; we pull the bind credentials from cws-core and
// install/start the mapped zylos IM component. Best-effort; never throws.
// (Full flow, deps, and DEFERRED follow-ups documented in channel-connector.js.)
// Report the terminal connect/disconnect outcome back to cws-connect through
// the cws-core BFF passthrough. request_id is echoed so cws-connect can match it
// against the in-flight command (its authorization + idempotency check);
// binding_id addresses the row. Shared by the live report and the resend task so
// a queued result is delivered on exactly the same path it originally took.
// Bounded: native fetch has no deadline, and this call sits both inside the
// connector's retry loop and inside the interval-driven resend, so a connection
// that is accepted and never answered would stall the one and pile up runs of
// the other. 20s is well beyond a healthy round-trip; exceeding it is a failure
// worth retrying, which both callers already know how to do.
const CONNECT_RESULT_POST_TIMEOUT_MS = 20_000;

const postConnectResult = (r) => postForOrg(
  r.orgId,
  apiPath(`/connect/channel-bindings/${r.bindingId}/result`),
  { status: r.status, detail: r.detail || '', request_id: r.requestId || '' },
  { timeoutMs: CONNECT_RESULT_POST_TIMEOUT_MS },
);

// Results the connector could not deliver even after its own retries. The
// binding stays 'pending' until one lands, so the queue is on disk: a crash or
// restart must not turn a connected channel into a permanent spinner.
const connectResultQueue = createConnectResultQueue({
  sendResult: postConnectResult,
  log,
  warn,
});

const handleChannelCommand = createChannelInstaller({
  getForOrgWithHeaders,
  apiPath,
  dedupe,
  persistUndeliveredResult: async (r) => { connectResultQueue.queue(r); },
  reportResult: postConnectResult,
  // Relay a QR-login code (wechat/whatsapp) to the binding so the frontend can
  // render it while the card is in the connecting state. Same auth model as
  // /result (agent principal at cws-core + request_id one-shot at cws-connect).
  reportQR: async (r) => {
    await postForOrg(
      r.orgId,
      apiPath(`/connect/channel-bindings/${r.bindingId}/qr`),
      { qr_png_base64: r.qrPngBase64, request_id: r.requestId || '' },
    );
  },
  log,
  warn,
});

function makeOrgFrameDispatcher(orgConfig, onMessage) {
  return function onFrame(frame) {
    const type = frame.type;
    recordFrameType(orgConfig.slug, type);
    switch (type) {
      case 'message':
        onMessage(frame).catch(e => warn(`[${orgConfig.slug}] handleIncomingMessage:`, e.message));
        break;
      case 'message_ack':
        log(`[${orgConfig.slug}] message_ack seq=${frame.payload?.seq} msg=${frame.payload?.message_id}`);
        break;
      case 'system':
        // Single stdout line per system frame: nothing for high-frequency
        // benign no-ops (reactions / read receipts / mention notices), one
        // `system event=…` for known events, one `unhandled system event: …`
        // for unknowns. handleSystemEvent no longer logs the unhandled case.
        // See task #44 log hygiene.
        logSystemFrame(log, orgConfig.slug, frame, classifySystemEvent);
        handleSystemEvent(orgConfig, frame).catch(e => warn(`[${orgConfig.slug}] handleSystemEvent:`, e.message));
        break;
      case 'error':
        warn(`[${orgConfig.slug}] server error frame:`, JSON.stringify(frame.payload || {}));
        break;
      case 'typing':
      case 'presence':
      case 'read_receipt':
      case 'read_state_update':
      // Delivery-watermark frame ({conversation_id, ack_until_seq}). cws-comm
      // pushes one per message in busy conversations; we don't surface delivery
      // state, so ignore it like the other non-surfaced state frames rather
      // than logging per-frame (which would just trade the old "unknown frame
      // type" warn-flood for a normal-log-flood). It stays discoverable via the
      // periodic frame-type metric (recordFrameType, above). (#78)
      case 'delivery_state_update':
        break;
      default:
        warn(`[${orgConfig.slug}] unknown frame type:`, type);
    }
  };
}

// =============================================================================
// Disconnect catch-up — pull missed events via POST /api/v1/sync
// =============================================================================

// Cap a single catch-up sweep to avoid pulling unbounded backlog after a
// very long outage. If there are more than this many events to catch up,
// the rest will be pulled on the next reconnect (or the operator can
// manually invoke `comm.sync` from the CLI).
const SYNC_PAGE_SIZE  = 100;
const SYNC_MAX_EVENTS = 2000;

// Per-org guard so a concurrent reconnect doesn't trigger overlapping syncs.
const _syncInFlight = new Set();

async function syncMissedEvents(orgConfig, sessionRef, onMessage, { fromStart = false } = {}) {
  // Normally a no-op on the first-ever connect (nothing to catch up). With
  // `fromStart`, replay the whole inbox from seq 0 and DISPATCH each event —
  // the first-boot path uses this to deliver a freshly provisioned agent's
  // backlog (owner welcome + activation DM) instead of discarding it (#79).
  if (!fromStart && !sessionRef.sync_seq) return;
  if (_syncInFlight.has(orgConfig.slug)) {
    log(`[${orgConfig.slug}] sync already in flight, skipping`);
    return;
  }
  _syncInFlight.add(orgConfig.slug);
  try {
    // A `fromStart` replay normally begins at 0 (genuine first boot, where
    // sync_seq is 0 anyway). The #148 identity rebind reuses this taint-clearing
    // replay but pre-seeds sessionRef.sync_seq to the new identity's server
    // anchor, so honor that anchor as the start position when present.
    const startSeq = fromStart ? (sessionRef.sync_seq || 0) : sessionRef.sync_seq;
    let sinceSeq = startSeq;
    let totalSynced = 0;
    let hasMore = true;
    let haltedOnEmpty = false;
    // Whole-sweep in-sweep-retry budget (see SYNC_SWEEP_MAX_RETRY_BUDGET). Shared
    // across every event in this sweep so a run of bad heads can't stack unbounded.
    let retryBudget = SYNC_SWEEP_MAX_RETRY_BUDGET;

    while (hasMore && totalSynced < SYNC_MAX_EVENTS) {
      const res = await postForOrg(orgConfig.org_id, apiPath('/sync'), {
        since_seq: sinceSeq,
        device_id: config.agent?.device_id || '',
        limit:     SYNC_PAGE_SIZE,
      });
      const events = Array.isArray(res?.events) ? res.events : [];
      hasMore = res?.has_more === true;
      if (events.length === 0) break;

      for (const ev of events) {
        if (!ev?.message_id || !ev.conversation_id) continue;
        // Dispatch this event, RE-ATTEMPTING it in-sweep on a transient
        // content-fetch failure. A `fromStart` sweep only runs on (re)connect;
        // on a STABLE connection with sync_seq stuck at 0 no further sweep fires
        // (the in-connection gap-detector takes the non-fromStart path, which
        // returns early while sync_seq is 0). Without in-sweep retry a single
        // sweep would halt on a permanently-unfetchable HEAD at failure #1 and
        // wait forever for a reconnect that never comes — starving the whole
        // backlog behind it (the catch-up wedge; #79 follow-on). Re-attempting
        // here drives the DURABLE give-up counter to its threshold within one
        // sweep, so the head is skipped and the backlog flows, independent of
        // reconnects. Bounded by SYNC_HEAD_MAX_INSWEEP_ATTEMPTS as a safety net
        // for the case where the counter cannot advance (see sync-head-retry.js).
        // Cap this event's in-sweep attempts by BOTH the per-head cap and the
        // remaining whole-sweep retry budget, so a run of bad heads can't stack
        // unbounded. `budget + 1` because the budget counts RE-attempts (extras
        // beyond the first); once the budget is spent, maxAttempts collapses to 1
        // (no in-sweep retry) and a transient failure halts, deferring to the
        // next reconnect.
        const perHeadMax = Math.max(1, Math.min(SYNC_HEAD_MAX_INSWEEP_ATTEMPTS, retryBudget + 1));
        const { result: res2, attempts } = await deliverWithInSweepRetry(
          () => onMessage({
            id:              String(ev.message_id),
            conversation_id: ev.conversation_id,
            seq:             ev.seq,
            _via:            'sync',
            // First-boot replay: tell the handler to clear any stale dedupe mark
            // for this id before its duplicate check (see the handler). A
            // prepare-phase bridge may have persisted the id to dedup.json
            // without ever delivering it; on a genuine first boot nothing was
            // delivered, so the replay must not be suppressed as a "duplicate".
            ...(fromStart ? { _firstBoot: true } : {}),
          }),
          {
            maxAttempts: perHeadMax,
            sleep: () => sleep(config.message?.content_fetch_giveup_retry_delay_ms
              ?? DEFAULT_SYNC_HEAD_RETRY_DELAY_MS),
          },
        );
        retryBudget -= Math.max(0, attempts - 1); // spend the re-attempts made
        // Content fetch failed for this event. Two cases:
        //   • Gave up (durable give-up threshold reached): the handler already
        //     alarm-logged and advanced the inbox-ledger watermark past this
        //     seq. SKIP it — advance the sweep cursor and continue — so a
        //     permanently-unfetchable head can't wedge the sweep and starve the
        //     backlog behind it forever (catch-up-wedge fix; follow-on to #79).
        //   • Still transient after the in-sweep bound (only reachable when the
        //     counter couldn't advance): leave the cursor BEFORE it (do NOT
        //     advance sinceSeq) and halt the sweep so the next reconnect re-pulls
        //     it in order. We do NOT force a WS disconnect here — that is the
        //     realtime path's job; on the sync-replay path the exponential
        //     reconnect backoff + this un-advanced cursor is the safety net.
        if (res2?.contentFetchFailed) {
          if (res2.giveUp) {
            log(`[${orgConfig.slug}] sync: giving up on msg=${ev.message_id} seq=${ev.seq} after repeated content-fetch failures — skipping and advancing cursor past it`);
            if (typeof ev.seq === 'number' && ev.seq > sinceSeq) sinceSeq = ev.seq;
            continue;
          }
          // Reached here for a TRANSIENT fetch error (res2.transient — never
          // skipped, preserves ordering) or an empty body still below the
          // give-up cap after the in-sweep retry budget was spent. Either way,
          // halt and leave the cursor BEFORE this seq so the next reconnect
          // re-pulls it in order.
          log(`[${orgConfig.slug}] sync: ${res2.transient ? 'transient fetch error' : 'empty body (below give-up cap)'} for msg=${ev.message_id} seq=${ev.seq} — halting sweep, cursor stays at ${sinceSeq}`);
          haltedOnEmpty = true;
          break;
        }
        if (typeof ev.seq === 'number' && ev.seq > sinceSeq) sinceSeq = ev.seq;
      }
      totalSynced += events.length;
      if (haltedOnEmpty) break;
    }

    // Persist the sync cursor (inbox seq) so the next reconnect resumes here.
    if (sinceSeq > startSeq) {
      sessionRef.sync_seq = sinceSeq;
      saveOrgSession(orgConfig.slug, { sync_seq: sinceSeq });
    }

    if (totalSynced > 0) {
      log(`[${orgConfig.slug}] sync caught up ${totalSynced} event(s) since seq=${startSeq}, new sync_seq=${sinceSeq}` +
          (hasMore && totalSynced >= SYNC_MAX_EVENTS ? ` (hit per-sweep cap, more on next reconnect)` : ''));
    }
    // Ack the highest processed seq to cws-comm (best-effort).
    if (sinceSeq > 0) ackSync(orgConfig, sinceSeq);
  } catch (err) {
    warn(`[${orgConfig.slug}] sync failed: ${err.message} — will retry on next reconnect`);
  } finally {
    _syncInFlight.delete(orgConfig.slug);
  }
}

// =============================================================================
// First-connect inbox replay
// =============================================================================
// On first-ever connect (sync_seq=0) the inbox of a freshly provisioned agent
// holds exactly the messages it must act on — the owner welcome DM and the
// scheduler/onboarding activation DM the platform sends at creation time.
//
// The old behavior seeked to the END of the inbox and DISCARDED that backlog,
// so a fresh agent silently never received its activation and sat idle (#79 /
// cws-fe #175 — greeting shows, onboarding guidance never arrives). We now
// replay the inbox from the start and dispatch each message instead; see the
// onOpen first-connect branch, which calls `syncMissedEvents(..., {fromStart})`.

// =============================================================================
// AckSync — tell cws-comm how far we've consumed (best-effort)
// =============================================================================

// =============================================================================
// Server inbox watermark — GET /api/v1/sync/status (cws-core BFF passthrough of
// cws-comm GetInboxStatus; principal-scoped — Legs A+B of #148)
// =============================================================================
//
// Used ONLY on an identity rebind (#148): after self.member_id changes the local
// watermark refers to the OLD identity's inbox, so we re-seed it from the NEW
// identity's real server position. We seed to `last_delivered_seq` (NOT
// `max_seq`): everything above it that is still pending is then delivered by the
// replay; seeding to max_seq would silently drop that pending window — the very
// inbound loss #148 is about.
//
// Returns { anchor, maxSeq } on SUCCESS (anchor = last_delivered_seq, which may
// be a legitimate 0), or null on FAILURE — endpoint not yet deployed (Leg A+B
// int cutover is held), network error, timeout, or an unusable payload. The
// caller MUST distinguish the two: on null it does NOT reset, reseed, or replay
// (per owner decision — no blind degrade); it logs and retries on a later
// reconnect. Bounded timeout so it never hangs the onOpen recovery path.
async function resolveInboxStatus(orgConfig) {
  try {
    const status = await getForOrg(
      orgConfig.org_id,
      apiPath('/sync/status'),
      undefined,
      { timeoutMs: config.server?.sync_status_timeout_ms ?? DEFAULT_SYNC_STATUS_TIMEOUT_MS },
    );
    const lastDelivered = Number(status?.last_delivered_seq);
    const maxSeq = Number(status?.max_seq);
    if (!Number.isFinite(lastDelivered)) {
      warn(`[${orgConfig.slug}] sync/status returned no usable last_delivered_seq — treating as unavailable`);
      return null;
    }
    log(`[${orgConfig.slug}] sync/status: max_seq=${Number.isFinite(maxSeq) ? maxSeq : '?'} ` +
        `last_delivered_seq=${lastDelivered}`);
    return { anchor: Math.max(0, lastDelivered), maxSeq: Number.isFinite(maxSeq) ? maxSeq : null };
  } catch (err) {
    warn(`[${orgConfig.slug}] sync/status request failed (${err.status || ''} ${err.message})`);
    return null;
  }
}

async function ackSync(orgConfig, seq) {
  try {
    await postForOrg(orgConfig.org_id, apiPath('/sync/ack'), {
      device_id:   config.agent?.device_id || '',
      seq,
      platform:    'agent',
      app_version: config.agent?.app_version || '',
    });
    log(`[${orgConfig.slug}] ack sync_seq=${seq}`);
  } catch (err) {
    warn(`[${orgConfig.slug}] ackSync failed: ${err.message}`);
  }
}

// =============================================================================
// Owner sync — cws-core is the authoritative source of an agent's owner
// =============================================================================
//
// An agent's owner can be reassigned server-side via cws-core
// (POST /api/v1/platform-agents/{member_id}/transfer-owner). cws-core holds the
// authoritative `owner_member_id`; this plugin's `orgs.<slug>.owner` block is a
// local cache. On every WS (re)connect we pull our own member record and, when
// core reports a different owner, update both the live in-memory orgConfig and
// config.json — no restart needed.
//
// Pull-based by design: we never let a pushed WS payload mutate ownership (a
// forged frame must not be able to hand the bot to an attacker). The
// authoritative read is an authenticated GET against core.
//
// Sync triggers: (1) every WS (re)connect, (2) every OWNER_SYNC_INTERVAL_MS
// while the process is alive (covers long-lived connections). CLI
// `comm.sync_owner` provides a manual trigger.
//
// The first-DM auto-bind (bindOwner) is only a fallback for when core has NO
// owner recorded — if core reports an owner here it always wins, and when core
// reports none we leave the local binding untouched so auto-bind still works.

// Returns an explicit readiness result: `{ nameReady: true }` only after the
// authoritative self-member record was actually read from cws-core (and any
// display_name it carried was applied to config + the live orgConfig before
// returning). "member_id not available yet" and "fetch failed" report
// `nameReady: false` with a reason — the startup hydration barrier
// (self-name-hydration.js) relies on this distinction; it must not mistake a
// skipped/failed sync for success. Periodic/event callers ignore the result.
async function syncOwnerFromCore(orgConfig) {
  const selfMemberId = orgConfig.self?.member_id;
  if (!selfMemberId) {
    // member_id is written back by the token exchange; if it's not there yet
    // we simply skip this round and try again on the next reconnect.
    return { nameReady: false, reason: 'self.member_id not available yet (token exchange write-back pending)' };
  }
  let member;
  try {
    member = await getForOrg(orgConfig.org_id, apiPath(`/members/${selfMemberId}`));
  } catch (err) {
    warn(`[${orgConfig.slug}] owner-sync: fetch self member failed: ${err.message} — keeping local owner`);
    return { nameReady: false, reason: `fetch self member failed: ${err.message}` };
  }

  // Cache our own authoritative display_name (per-org) so inbound @-mention
  // detection matches the exact name cws-fe shows, instead of a hand-configured
  // `self.name` that silently drifts (wrong case / suffix / stale → dropped @).
  // Piggybacks on this existing self-member read — no extra API call; a restart
  // or the next owner-sync refreshes it (no dedicated polling added).
  const coreDisplayName = member?.display_name || '';
  if (coreDisplayName && coreDisplayName !== orgConfig.self?.display_name) {
    setSelfDisplayName(orgConfig.slug, coreDisplayName);
    orgConfig.self = { ...(orgConfig.self || {}), display_name: coreDisplayName };
    const liveSelf = activeOrgConfigs.get(orgConfig.slug);
    if (liveSelf && liveSelf !== orgConfig) {
      liveSelf.self = { ...(liveSelf.self || {}), display_name: coreDisplayName };
    }
    log(`[${orgConfig.slug}] self display_name synced from core: ${coreDisplayName}`);
  }

  const coreOwnerId = member?.owner_member_id || '';
  // Core has no authoritative owner → leave the local binding as-is so the
  // first-DM auto-bind fallback keeps working. We never clear a local owner here.
  if (!coreOwnerId) return { nameReady: true };

  const localOwnerId = orgConfig.owner?.member_id || '';
  if (coreOwnerId === localOwnerId) return { nameReady: true }; // already in sync

  let ownerName = '';
  try { ownerName = (await fetchMemberName(orgConfig.org_id, coreOwnerId)) || ''; }
  catch { /* display name is cosmetic */ }

  // Persist to config.json and update the live captured orgConfig in place so
  // the message handler's owner gate sees the new owner without a restart.
  setOwner(orgConfig.slug, coreOwnerId, ownerName);
  orgConfig.owner = { member_id: coreOwnerId, name: ownerName };
  const live = activeOrgConfigs.get(orgConfig.slug);
  if (live && live !== orgConfig) live.owner = { member_id: coreOwnerId, name: ownerName };
  log(`[${orgConfig.slug}] owner synced from core: ${localOwnerId || '(none)'} → ${coreOwnerId}${ownerName ? ` (${ownerName})` : ''}`);

  // Notify the bot session so it can update memory/references.md with the new
  // owner — config.json is updated but the AI context won't see it until told.
  notifyOwnerChanged(orgConfig.slug, coreOwnerId, ownerName, localOwnerId);
  return { nameReady: true };
}

function notifyOwnerChanged(orgSlug, newOwnerId, newOwnerName, previousOwnerId) {
  const payload = JSON.stringify({
    type: 'owner-changed',
    org: orgSlug,
    owner: { member_id: newOwnerId, name: newOwnerName },
    previous_owner_member_id: previousOwnerId || null,
  });
  const content = `[OWNER-CHANGED] ${payload}`;
  execFile(
    process.execPath,
    [C4_CONTROL, 'enqueue', '--content', content, '--priority', '2', '--no-ack-suffix'],
    { timeout: 10000 },
    (err, _stdout, stderr) => {
      if (err) warn(`[${orgSlug}] failed to enqueue owner-changed control: ${stderr || err.message}`);
      else log(`[${orgSlug}] owner-changed control enqueued`);
    },
  );
}

// =============================================================================
// Agent online self-report — onboarding trigger signal (cws-core C1)
// =============================================================================
// Logic and rationale live in lib/online-report.js (extracted for unit
// testing). Called from WS onOpen and from periodicSync — Set-guarded and
// idempotent, so both call sites are safe; a failed report never affects
// messaging.

const reportAgentOnline = createOnlineReporter({ loadConfig, postForOrg, apiPath, log, warn });

// Readiness gate in front of the trigger. The report is what makes cws-core
// begin onboarding, so firing it the instant the socket opens starts the whole
// server-side sequence against an agent that may still be booting — the first
// real reply then arrives minutes after the server thinks onboarding began.
// Hold the trigger until the runtime agent is actually able to act; rationale,
// the exact readiness definition, and the fail-open cap live in
// lib/agent-readiness.js.
const readinessGate = createDefaultReadinessGate({
  options: () => loadConfig().agent?.readiness_gate || {},
});

const reportAgentOnlineWhenReady = createGatedOnlineReporter({
  reportAgentOnline,
  gate: readinessGate,
  isDisabled: () => loadConfig().agent?.readiness_gate?.enabled === false,
  // Once this org has reported (or 404'd), skip the gate entirely — later
  // reconnects must not pay the readiness wait for a no-op.
  isAlreadyReported: (slug) => reportAgentOnline.isDone(slug),
  log,
  warn,
});

// =============================================================================
// Config sync to cws-comm — push local policy config on every WS (re)connect
// =============================================================================
// The reverse direction of agent.config.* WS events. When the agent connects,
// it pushes its local DM policy + group mode config to cws-comm so the server
// has the authoritative state (e.g. after an offline config.json edit or a
// fresh install with pre-populated config). Errors are swallowed — config sync
// is best-effort and must never tear down the connection.

async function syncConfigToComm(orgConfig) {
  const selfMemberId = orgConfig.self?.member_id;
  if (!selfMemberId) return;

  const access = orgConfig.access || {};

  const groups = [];
  const groupAllowlist = [];
  if (access.groups) {
    for (const [convId, gcfg] of Object.entries(access.groups)) {
      groupAllowlist.push(convId);
      groups.push({
        conversation_id: convId,
        mode: gcfg.mode || 'mention',
        allow_from: gcfg.allowFrom || ['*'],
      });
    }
  }

  const payload = {
    dm_policy: access.dmPolicy || 'owner',
    dm_allowlist: access.dmAllowFrom || [],
    group_scope: access.groupPolicy || 'allowlist',
    group_allowlist: groupAllowlist,
    groups,
  };

  try {
    await putForOrg(orgConfig.org_id, apiPath(`/agents/${selfMemberId}/reported-policy`), payload);
    log(`[${orgConfig.slug}] policy reported: dmPolicy=${payload.dm_policy}, groupScope=${payload.group_scope}, groups=${groups.length}`);
  } catch (err) {
    if (err.status === 404) {
      warn(`[${orgConfig.slug}] reported-policy endpoint not available (404), skipping`);
    } else {
      throw err;
    }
  }
}

// Periodic sync — owner from core + local policy to comm, every 5 min.
const PERIODIC_SYNC_INTERVAL_MS = 5 * 60 * 1000;

function periodicSync() {
  for (const [slug, orgConfig] of activeOrgConfigs) {
    syncOwnerFromCore(orgConfig).catch(e =>
      warn(`[${slug}] periodic owner-sync failed: ${e.message}`));
    syncConfigToComm(orgConfig).catch(e =>
      warn(`[${slug}] periodic config-sync failed: ${e.message}`));
    // Onboarding online-report: heals transient failures on a stable WS
    // connection (otherwise the next attempt waits for a reconnect).
    // Set-guarded and idempotent — no-op once one report has succeeded.
    // Goes through the readiness gate too, so a report deferred at onOpen is
    // not smuggled out early by the periodic tick.
    reportAgentOnlineWhenReady(orgConfig).catch(e =>
      warn(`[${slug}] periodic online-report failed: ${e.message}`));
  }
}

// Metrics reporting — read from zylos-dashboard, push to cws-core, every 60s.
const METRICS_REPORT_INTERVAL_MS = (config.metricsReport?.intervalSeconds || 60) * 1000;
const METRICS_REPORT_INITIAL_DELAY_MS = 15_000;

// Channel-liveness reporting — enumerate the 13 IM channels' pm2 status, push
// to cws-core, on the same ~60s cadence as runtime-metrics. Offset the first
// tick from metrics so the two don't spawn pm2 / hit the dashboard at once.
const CHANNEL_LIVENESS_INTERVAL_MS = (config.channelLiveness?.intervalSeconds || 60) * 1000;
const CHANNEL_LIVENESS_INITIAL_DELAY_MS = 20_000;

// =============================================================================
// WS pool — one connection per enabled org
// =============================================================================

const wsClients = [];
const composeConsumers = [];
const inboxLedgers = [];
let liveOrgCount = 0;

// Live per-org config snapshots. `makeOrgMessageHandler` captures the
// orgConfig at boot, so shouldHandleMessage / sendRejectNotice all read
// through this same object. Hot-reload mutates it in place (see the
// watchConfig callback at the bottom) so policy edits like adding a group to
// `access.groups` take effect without a service restart.
const activeOrgConfigs = new Map(); // slug → orgConfig (mutable)

// Readiness barrier for the authoritative self display_name (see
// lib/self-name-hydration.js for the full design). Each attempt mints the org
// JWT (token.exchange writes self.member_id back on fresh installs), backfills
// member_id into the captured orgConfig, then runs syncOwnerFromCore — which
// reports `nameReady` explicitly, so a skipped/failed sync can NOT be mistaken
// for success. Called from two structural barrier points:
//   1. bootstrapOrgToken — awaited (Promise.allSettled) before the startOrgWs
//      loop, so the WsClient isn't even created until hydration resolves;
//   2. the WsClient urlProvider — awaited by ws.js BEFORE the socket object
//      exists, so on every (re)connect neither live frames nor the onOpen
//      replay can be dispatched until the retry attempt resolves.
// Success is sticky per org for the process lifetime; bounded fail-open after
// retries (cached last-known display_name, else a loud warning) so a core
// outage at boot degrades to pre-existing behavior instead of keeping the org
// offline forever.
const hydrateSelfName = createSelfNameHydrator({
  acquireToken: async (orgConfig) => { await getAccessToken(orgConfig.org_id); },
  syncSelf: (orgConfig) => syncOwnerFromCore(orgConfig),
  loadConfig,
  log,
  warn,
});

async function bootstrapOrgToken(orgConfig) {
  // Mint the JWT and hydrate the authoritative self display_name BEFORE the
  // WS connects — awaited in the pre-connect phase, so the first inbound
  // message/replay matches against the real display_name, not a stale/empty
  // self.name. Without this, a fresh start/upgrade with no cached display_name
  // would drop @-messages for up to one periodic-sync interval
  // (owner-config-sync has no runOnStart). Never throws — the urlProvider
  // barrier retries on every (re)connect until an authoritative sync succeeds.
  log(`[bootstrap] org=${orgConfig.slug} (${orgConfig.org_id}) acquiring JWT + hydrating self display_name…`);
  const res = await hydrateSelfName(orgConfig);
  log(`[bootstrap] org=${orgConfig.slug} self-name readiness: ready=${res.ready} source=${res.source}${res.displayName ? ` ("${res.displayName}")` : ''}`);
}

function startOrgWs(orgConfig, wsBaseUrl) {
  const compose = createComposeConsumer({
    orgId: orgConfig.org_id,
    agentId: orgConfig.self?.member_id,
    config: () => loadConfig().automation_compose,
    authorize: async request => {
      const userId = request.session.user_id;
      const access = orgConfig.access || {};
      return Boolean(userId && (userId === orgConfig.owner?.member_id
        || access.dmPolicy === 'open'
        || (access.dmPolicy === 'allowlist' && access.dmAllowFrom?.includes(userId))));
    },
    get: route => getForOrg(orgConfig.org_id, apiPath(route), undefined, { timeoutMs: 15000 }),
    post: (route, body) => postForOrg(orgConfig.org_id, apiPath(route), body, { timeoutMs: 15000 }),
    warn: message => warn(`[${orgConfig.slug}] ${message}`),
  });
  composeConsumers.push(compose);
  compose.start();
  const session = loadOrgSession(orgConfig.slug) || {};
  // Backward compat: migrate last_seq → sync_seq on first boot after upgrade.
  const syncSeq = session.sync_seq ?? session.last_seq ?? 0;
  const sessionRef = { sync_seq: syncSeq };
  if (sessionRef.sync_seq) {
    log(`[${orgConfig.slug}] warm-restart: sync_seq=${sessionRef.sync_seq}`);
  }

  // Inbox-seq ledger: continuous-ack watermark + gap detection.
  // The ledger's acked_seq is seeded from session.sync_seq so it starts at
  // the same position as the existing sync cursor. It is bound to self.member_id
  // so a migration/re-onboarding that changes the identity self-heals (#148).
  const inboxLedger = createInboxLedger(orgConfig.slug, {
    log: (...a) => log(`[${orgConfig.slug}]`, ...a),
    warn: (...a) => warn(`[${orgConfig.slug}]`, ...a),
    memberId: orgConfig.self?.member_id,
    onAck: (ackedSeq) => {
      // Sync the session cursor so reconnect /sync starts from the ledger's
      // watermark rather than the old sync_seq.
      sessionRef.sync_seq = ackedSeq;
      saveOrgSession(orgConfig.slug, { sync_seq: ackedSeq });
      ackSync(orgConfig, ackedSeq);
    },
    onGapSync: (sinceSeq) => {
      // Gap detected — run /sync to fill missing inbox entries.
      syncMissedEvents(orgConfig, sessionRef, onMessage);
    },
  });

  // #148 identity rebind — DETECTION only here. The ledger detected that its
  // persisted member_id no longer matches self.member_id, but it deliberately did
  // NOT reset: the stale watermark stays in force so the connection keeps
  // operating and the inversion alarm keeps firing. The actual reseed is done in
  // onOpen, and ONLY if GET /sync/status succeeds (owner decision: no blind
  // degrade). If status can't be reached we don't reset/replay — we log a loud
  // ERROR and retry on a later reconnect. So we do NOT touch the session cursor
  // here; the normal seeding below runs on the (still-old) watermark.
  const identityChange = inboxLedger.getIdentityChange();
  let identityRebindPending = !!identityChange;

  if (syncSeq > 0) inboxLedger.setAckedSeq(syncSeq);
  // If the durable ledger is ahead of the session cursor — the session file was
  // lost or reset but the inbox ledger (persisted separately) survived — adopt
  // the ledger's watermark as the sync cursor (keeps onOpen on the normal
  // catch-up path instead of replaying the whole inbox from zero). The
  // `!identityRebindPending` guard lives inside seedSessionFromLedger (#151 P1):
  // while a rebind is pending the ledger still holds the OLD high watermark, so
  // adopting it would seed the session cursor to the stale value.
  seedSessionFromLedger({
    orgSlug: orgConfig.slug,
    sessionRef,
    ledgerAcked: inboxLedger.getAckedSeq(),
    identityRebindPending,
    saveOrgSession,
    log,
  });
  inboxLedger.start();

  // Mutable holder so the message handler (created before the WsClient exists)
  // can force a reconnect on the live socket. Filled in right after the
  // WsClient is constructed below.
  const wsRef = { client: null };
  const onMessage = makeOrgMessageHandler(orgConfig, sessionRef, inboxLedger, wsRef);
  const onFrame = makeOrgFrameDispatcher(orgConfig, onMessage);

  const ws = new WsClient({
    urlProvider: async () => {
      // Readiness barrier, per-(re)connect leg: ws.js awaits urlProvider
      // before the WebSocket object is created, so no frame — live or onOpen
      // replay — can reach the mention gate until this resolves. No-op once an
      // authoritative sync has succeeded this process; until then each
      // reconnect retries one hydrate attempt (the WS backoff loop supplies
      // the retry cadence). Never throws: if hydration still fails but the
      // ticket below succeeds, we deliberately connect fail-open (loudly
      // logged) rather than keep the org offline — in practice a core outage
      // fails the ticket too, so the socket waits out the outage anyway.
      await hydrateSelfName(orgConfig, { maxAttempts: 1 });
      log(`[ticket] org=${orgConfig.slug} requesting ws-ticket`);
      const ticket = await getWsTicket(orgConfig.org_id);
      log(`[ticket] org=${orgConfig.slug} got ws-ticket, connecting…`);
      return `${wsBaseUrl}?ticket=${encodeURIComponent(ticket)}`;
    },
    deviceId:            config.agent?.device_id,
    clientVersion:       config.agent?.app_version,
    reconnectMaxMs:      config.server?.reconnect_max_delay ?? DEFAULT_WS_RECONNECT_MAX_MS,
    handshakeTimeoutMs:  config.server?.ws_handshake_timeout_ms ?? undefined,
    dialTimeoutMs:       config.server?.ws_dial_timeout_ms ?? undefined,
    heartbeatIntervalMs: config.server?.heartbeat_interval  ?? DEFAULT_WS_HEARTBEAT_MS,
    pingIntervalMs:      config.server?.ws_ping_interval_seconds != null
      ? config.server.ws_ping_interval_seconds * 1000
      : DEFAULT_WS_PING_INTERVAL_MS,

    onOpen: async () => {
      log(`[ws] org=${orgConfig.slug} open (org_id=${orgConfig.org_id})`);
      // Deliberately not awaited: the readiness gate can hold this for minutes
      // and must never delay the inbox replay below, which is what actually
      // delivers the onboarding messages once they exist.
      reportAgentOnlineWhenReady(orgConfig).catch(e =>
        warn(`[${orgConfig.slug}] online-report failed: ${e.message} — will retry on next reconnect`));
      if (identityRebindPending) {
        // #148 identity rebind. STRICT (owner decision): this depends ONLY on
        // /sync/status. On SUCCESS we reset+reseed the ledger to the new
        // identity's server watermark, adopt the new member_id, and replay the
        // pending window with dedupe-taint clearing (the #79 recovery machinery).
        // On FAILURE we do NOT reset, do NOT persist the new member_id, and do
        // NOT replay — we log a loud ERROR and keep the pending flag so a later
        // reconnect (or restart) retries once status is reachable. The stale
        // watermark stays in force (inbound stays shadowed, alarm keeps firing):
        // an explicit, logged "not yet self-healed" state, never a blind reset.
        const change = inboxLedger.getIdentityChange();
        const status = await resolveInboxStatus(orgConfig);
        if (status) {
          const anchor = status.anchor;   // last_delivered_seq (may legitimately be 0)
          // Crash-safe write order (#151 P1) lives in commitIdentityRebind:
          // session cursor persisted FIRST, the mismatch-clearing member_id
          // commit LAST — so a crash between the two leaves a retriable mismatch
          // and cannot re-shadow the new inbox with the stale high watermark.
          commitIdentityRebind({
            orgSlug: orgConfig.slug,
            sessionRef,
            inboxLedger,
            memberId: orgConfig.self?.member_id,
            anchor,
            saveOrgSession,
          });
          warn(`[${orgConfig.slug}] identity changed ${change?.previousMemberId}→${change?.currentMemberId}, ledger reset; ` +
               `reseeded from server last_delivered_seq=${anchor}, replaying pending inbox`);
          await syncMissedEvents(orgConfig, sessionRef, onMessage, { fromStart: true });
          if (sessionRef.sync_seq) inboxLedger.setAckedSeq(sessionRef.sync_seq);
          identityRebindPending = false;
          return;
        }
        console.error(LOG_PREFIX,
          `[${orgConfig.slug}] identity changed ${change?.previousMemberId}→${change?.currentMemberId}, ` +
          `/sync/status unavailable — cannot reseed; NOT degrading / NOT replaying; ` +
          `will self-heal on a later reconnect when status is reachable`);
        // Do NOT fall through to the normal catch-up: the old cursor/inbox is
        // frozen and the new inbox is shadowed. Live frames + the tick gap-
        // detector keep running; the pending flag survives for the next leg.
        return;
      }
      if (!sessionRef.sync_seq) {
        // First-ever connect: REPLAY the inbox from the start and dispatch each
        // message, rather than seeking to the end and discarding the backlog.
        // A freshly provisioned agent's inbox holds exactly the messages it must
        // act on (owner welcome + scheduler/onboarding activation DM); the old
        // seek-to-end dropped them and the agent sat idle (#79 / cws-fe #175).
        //
        // Clear any dedupe taint first: a comm-bridge started transiently during
        // the runtime prepare phase can record inbox seqs it never delivered to
        // an agent session (none exists yet). On a genuine first boot nothing has
        // been delivered, so the replay must not be suppressed by those marks.
        inboxLedger.resetReceived();
        await syncMissedEvents(orgConfig, sessionRef, onMessage, { fromStart: true });
        // Seed the ledger watermark to the replayed position.
        if (sessionRef.sync_seq) inboxLedger.setAckedSeq(sessionRef.sync_seq);
      } else {
        // Reconnect: catch up missed events since last sync_seq (which is now
        // kept fresh by the inbox ledger during online operation).
        syncMissedEvents(orgConfig, sessionRef, onMessage);
      }
    },

    onMessage: onFrame,

    onClose: (code, reason, willReconnect) => {
      log(`[${orgConfig.slug}] closed code=${code} reason="${reason || ''}" reconnect=${willReconnect}`);
      if (code === 4003) {
        // Session expired: drop the cached JWT/ticket so urlProvider mints a
        // fresh one on the next connect. Keep sync_seq so the post-reconnect
        // sync sweep can catch up from the right position.
        log(`[${orgConfig.slug}] session expired; invalidating token cache (sync_seq preserved)`);
        invalidateToken(orgConfig.org_id);
      }
    },

    onFatal: (code, reason) => {
      compose.stop();
      console.error(LOG_PREFIX, `[${orgConfig.slug}] FATAL close code=${code} reason="${reason || ''}" — stopping this org`);
      if (code === 4002) console.error(LOG_PREFIX, `[${orgConfig.slug}] → auth failed; check api_key / org_id`);
      if (code === 4005) console.error(LOG_PREFIX, `[${orgConfig.slug}] → workspace suspended`);
      if (code === 4006) console.error(LOG_PREFIX, `[${orgConfig.slug}] → duplicate connection`);
      liveOrgCount -= 1;
      if (liveOrgCount <= 0) {
        console.error(LOG_PREFIX, 'all orgs terminated — exiting');
        process.exit(1);
      }
    },
  });

  wsRef.client = ws;
  wsClients.push({ slug: orgConfig.slug, ws });
  inboxLedgers.push(inboxLedger);
  activeOrgConfigs.set(orgConfig.slug, orgConfig);
  liveOrgCount += 1;
  ws.start();
  log(`[${orgConfig.slug}] started (org=${orgConfig.org_id})`);
}

// =============================================================================
// Main
// =============================================================================

if (!config.enabled) {
  log('disabled in config, exiting');
  process.exit(0);
}

const wsUrl = process.env.COCO_WS_URL || config.server?.ws_url;
if (!wsUrl) {
  console.error(LOG_PREFIX, 'COCO_WS_URL / config.server.ws_url not set');
  process.exit(1);
}
const wsBaseUrl = wsUrl.replace(/\?.*$/, '');

if (!config.agent?.api_key) {
  warn('no config.agent.api_key — token exchange will fail for every org');
}

const orgs = enabledOrgs();
if (orgs.length === 0) {
  warn('no enabled orgs in config.orgs — add at least one org block and restart.');
  warn('See ~/zylos/components/openmax/config.json (post-install / post-upgrade printed the format).');
  // Stay alive so PM2 doesn't crash-loop the service; operator just needs to
  // edit config.json and restart.
  setInterval(() => {}, 1 << 30).unref?.();
} else {
  log(`booting WS pool: ${orgs.length} org(s) enabled`);
  // Pre-mint each org's JWT and hydrate the authoritative self display_name
  // in parallel, so member_id write-back AND @-mention name readiness land
  // before the WS handler hits the first message. Each WS still has its own
  // urlProvider retry loop (which re-runs the hydration barrier per connect),
  // so a failed bootstrap doesn't prevent startup.
  (async () => {
    await Promise.allSettled(orgs.map(bootstrapOrgToken));
    for (const orgConfig of orgs) {
      startOrgWs(orgConfig, wsBaseUrl);
    }
    notifyUpgradeComplete(activeOrgConfigs, postForOrg, apiPath).catch(e =>
      warn(`upgrade notification error: ${e.message}`));
    const upgradeSchedule = resolveAutoUpgradeSchedule(config?.autoUpgrade);
    if (upgradeSchedule.enabled) {
      const checkFn = () => checkForUpdates(activeOrgConfigs, postForOrg, apiPath);
      tasks.register('auto-upgrade', checkFn, upgradeSchedule.intervalMs, {
        delay: upgradeSchedule.delay,
        runOnStart: upgradeSchedule.runOnStart,
      });
      tasks.start('auto-upgrade');
      log(`auto-upgrade scheduled (on-demand pm2 upgrader): first check in ${Math.round(upgradeSchedule.intervalMs / 3600_000)}h, then every ${Math.round(upgradeSchedule.intervalMs / 3600_000)}h`);
    } else {
      log('auto-upgrade disabled in config');
    }
  })();
}

watchConfig((next) => {
  config = next;
  // Mutate captured per-org config objects in place so edits picked up by
  // watchConfig take effect without restarting the service: access policy
  // (`access.dmPolicy`, `access.groupPolicy`, `access.groups`,
  // `access.dmAllowFrom`) and `owner` (rebinding ownership). self / org_id /
  // api_key are still considered structural — adding or removing an org or
  // rotating the api_key still requires a service restart (logged below).
  let accessUpdates = 0;
  let ownerUpdates = 0;
  for (const [slug, live] of activeOrgConfigs) {
    const updated = next.orgs?.[slug];
    if (updated?.access) {
      live.access = updated.access;
      accessUpdates += 1;
    }
    // Owner edits (via `comm set-owner` / `comm sync-owner`, or the daemon's
    // own core owner-sync writing config.json) apply in place — no restart
    // needed to rebind ownership. org_id / api_key / self stay structural.
    if (updated?.owner && (updated.owner.member_id || '') !== (live.owner?.member_id || '')) {
      live.owner = { member_id: updated.owner.member_id || '', name: updated.owner.name || '' };
      ownerUpdates += 1;
    }
  }
  log(
    `config reloaded — applied access updates to ${accessUpdates} org(s), ` +
    `owner updates to ${ownerUpdates} org(s); ` +
    `WS settings apply on next reconnect; org_id/api_key/self changes require service restart`,
  );
});

let _isShuttingDown = false;
function shutdown(signal) {
  for (const consumer of composeConsumers) consumer.stop();
  if (_isShuttingDown) return;
  _isShuttingDown = true;
  log(`${signal}, shutting down...`);
  tasks.stopAll();
  // Remove all active processing-indicator reactions before exit.
  const removals = [];
  for (const [msgId, state] of activeReactions) {
    clearTimeout(state.timer);
    removals.push(
      delForOrg(state.orgId, apiPath(`/messages/${msgId}/reactions/${state.code}`)).catch(() => {}),
    );
  }
  activeReactions.clear();
  Promise.allSettled(removals).then(() => {
    for (const c of wsClients) { try { c.ws.stop(); } catch {} }
    for (const l of inboxLedgers) { try { l.stop(); } catch {} }
    log('shutdown complete');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Backstop for a connection phase that stops advancing. ws.js already retries
// every close and every ticket failure with unbounded backoff, so this exists
// only for the case none of that covers: an attempt that neither opens nor
// fails. Deliberately narrow — it asks the client to ensure an attempt is in
// flight and lets the client's own backoff decide timing, so a persistently
// broken environment cannot be turned into a connect storm from here.
function superviseWsStalls() {
  for (const { slug, ws } of wsClients) {
    if (!ws || ws.state === 'open') continue;
    // Respect a deliberate stop: a client that gave up must not be revived by
    // a timer, or we hot-loop against a server that already refused us.
    if (ws.stopped) continue;
    // Only orgs still enabled in the live config — a disabled or removed org
    // should stay down.
    if (!activeOrgConfigs.has(slug)) continue;
    const stalled = ws.stalledMs();
    if (stalled < WS_STALL_THRESHOLD_MS) continue;
    warn(`[${slug}] ws stuck in "${ws.state}" for ${Math.round(stalled / 1000)}s — asking for a fresh attempt`);
    ws.ensureConnecting('stall-watchdog');
  }
}

tasks.register('ws-stall-watchdog', superviseWsStalls, WS_STALL_CHECK_INTERVAL_MS, {
  delay: WS_STALL_CHECK_INTERVAL_MS,
});
// runOnStart so a result stranded by a crash/restart is delivered promptly
// rather than waiting out the first interval.
tasks.register('connect-result-resend', () => connectResultQueue.resend(),
  CONNECT_RESULT_RESEND_INTERVAL_MS, { runOnStart: true });
tasks.register('frame-metrics', dumpFrameMetrics, WS_METRIC_INTERVAL_MS);
tasks.register('owner-config-sync', periodicSync, PERIODIC_SYNC_INTERVAL_MS);
// Holder for the readiness-edge trigger; started with the periodic tasks below.
let metricsReadinessTrigger = null;
if (config.metricsReport?.enabled !== false) {
  const reportMetrics = createMetricsReporter(activeOrgConfigs, {
    log, warn,
    dashboardApiKey: config.metricsReport?.dashboardApiKey || '',
    // Same gate that holds the online-report, so the platform's chat gate and
    // our own onboarding trigger can never disagree about whether this agent
    // is ready. Disabling the gate omits the field rather than reporting a
    // made-up verdict.
    evaluateReadiness: () => (
      loadConfig().agent?.readiness_gate?.enabled === false
        ? null
        : readinessReport(readinessGate.evaluate())
    ),
  });
  tasks.register('metrics-report', reportMetrics, METRICS_REPORT_INTERVAL_MS, {
    delay: METRICS_REPORT_INITIAL_DELAY_MS,
  });

  // The platform decides whether this agent can be talked to from the reported
  // runtime state, but the tick above is 60s (plus a 15s initial delay) — long
  // enough that a provisioned agent stays greyed out in the UI for up to a
  // minute after it can actually work. Fire one extra report on the edges that
  // matter (see lib/readiness-trigger.js: busy↔idle flapping deliberately does
  // not qualify). Additive only — the periodic tick still heals any missed edge.
  if (config.metricsReport?.readinessTrigger?.enabled !== false) {
    metricsReadinessTrigger = createReadinessTrigger({
      evaluate: () => readinessGate.evaluate(),
      report: reportMetrics,
      options: () => loadConfig().metricsReport?.readinessTrigger || {},
      log, warn,
    });
  }
}
if (config.channelLiveness?.enabled !== false) {
  const reportChannelLiveness = createChannelLivenessReporter(activeOrgConfigs, {
    log, warn,
    // 404-backoff knobs (issue #72). Omitted → reporter defaults (disable on
    // the first 404, re-probe every 180 ticks ≈ 3h at the 60s cadence).
    ...(config.channelLiveness?.disable404Threshold != null
      ? { disable404Threshold: config.channelLiveness.disable404Threshold } : {}),
    ...(config.channelLiveness?.reprobeEveryTicks != null
      ? { reprobeEveryTicks: config.channelLiveness.reprobeEveryTicks } : {}),
  });
  tasks.register('channel-liveness', reportChannelLiveness, CHANNEL_LIVENESS_INTERVAL_MS, {
    delay: CHANNEL_LIVENESS_INITIAL_DELAY_MS,
  });
}
// Size-based daily log rotation (task #44). Registers + starts the 'log-rotate'
// task on the shared registry; runOnStart catches an already-oversized out.log
// at boot. No-ops gracefully when not running under PM2 (env paths absent).
startLogRotation(tasks);
tasks.start('ws-stall-watchdog');
tasks.start('connect-result-resend');
tasks.start('frame-metrics');
tasks.start('owner-config-sync');
if (config.metricsReport?.enabled !== false) tasks.start('metrics-report');
metricsReadinessTrigger?.start();
if (config.channelLiveness?.enabled !== false) tasks.start('channel-liveness');
