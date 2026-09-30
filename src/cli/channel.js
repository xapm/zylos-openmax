#!/usr/bin/env node

/**
 * Conversation-channel connection tool.
 *
 * This is deliberately separate from conn.js: conn.* authorizes third-party
 * accounts the Agent can operate, while channel.connect attaches an IM ingress
 * (Feishu, Lark, DingTalk, or WeCom) to the Agent itself.
 *
 * Usage:
 *   node src/cli/channel.js channel.connect '{"channelType":"feishu","conversationId":"...","sourceMessageId":"..."}'
 *
 * The QR and session handle are consumed inside this process and never printed
 * to stdout (which is model-visible). For a typed request the tool publishes a
 * generic structured confirmation card first; only after explicit human
 * approval does a detached, bounded poller publish the QR and terminal result
 * in the same conversation. When the source is a verified owner/admin click on
 * the Agent's own channel card, Core treats that click as the approval and the
 * poller publishes the QR directly, with no confirmation card.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { apiPath, postForOrg } from '../lib/client.js';
import { resolveDefaultOrgId } from '../lib/config.js';
import { RUNTIME_DIR } from '../lib/session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SEND_SCRIPT = path.join(ROOT, 'scripts/send.js');
const TOOL_SCRIPT = fileURLToPath(import.meta.url);
const STATE_DIR = path.join(RUNTIME_DIR, 'channel-connect');
const POLL_INTERVAL_MS = 3000;
const MAX_QR_SESSION_SEC = 5 * 60;
// cws-connect marks a Binding that remains pending for 15 minutes as error;
// its sweep runs once per minute. Seventeen minutes leaves one full sweep
// interval plus scheduling margin, while keeping this detached watcher bounded.
const MAX_BINDING_WAIT_SEC = 17 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORM_CHANNELS = Object.freeze({
  feishu: { displayName: '飞书' },
  lark: { displayName: 'Lark' },
  dingtalk: { displayName: '钉钉' },
  wecom: { displayName: '企业微信' },
});

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function planChannelConnect(input = {}) {
  const channelType = String(input.channelType || input.channel_type || '').trim().toLowerCase();
  const conversationId = String(input.conversationId || input.conversation_id || '').trim();
  const sourceMessageId = String(input.sourceMessageId || input.source_message_id || '').trim();
  if (!PLATFORM_CHANNELS[channelType]) {
    throw bad(`channelType must be one of: ${Object.keys(PLATFORM_CHANNELS).join(', ')}`);
  }
  if (!UUID_RE.test(conversationId)) throw bad('conversationId must be a UUID from <message-context>');
  if (!sourceMessageId) throw bad('sourceMessageId is required from <message-context>');
  return {
    channelType,
    conversationId,
    sourceMessageId,
    body: {
      channel_type: channelType,
      conversation_id: conversationId,
      source_message_id: sourceMessageId,
    },
  };
}

export function buildChannelQRMessage(channelType, qrRef, expiresAt) {
  const channel = PLATFORM_CHANNELS[channelType];
  if (!channel) throw bad(`unsupported channel type: ${channelType}`);
  if (typeof qrRef !== 'string' || !qrRef.trim()) {
    throw new Error('channel connection service returned no QR reference');
  }
  const display = {
    schema: 'openmax.channel-qr.v1',
    channel_type: channelType,
    qr_ref: qrRef.trim(),
    expires_at: expiresAt,
  };
  return {
    client_msg_id: randomUUID(),
    type: 'AGENT_STRUCTURED',
    content: {
      content_type: 'channel_qr',
      body: display,
      attachments: [],
    },
    // cws-comm deliberately trims structured bodies from the list hot path.
    // Keep the small display projection in metadata so chat history can render
    // the QR card without issuing one GetMessage request per card.
    metadata: { openmax_channel_qr: display },
    fallback_text: `${channel.displayName}授权二维码（请尽快扫码）`,
  };
}

export function buildChannelConfirmationMessage(channelType, confirmationId, expiresAt) {
  const channel = PLATFORM_CHANNELS[channelType];
  if (!channel || !UUID_RE.test(confirmationId) || !Number.isFinite(Date.parse(expiresAt))) {
    throw bad('invalid channel confirmation');
  }
  const display = {
    schema: 'openmax.channel-confirm.v1',
    channel_type: channelType,
    confirmation_id: confirmationId,
    expires_at: expiresAt,
  };
  return {
    client_msg_id: randomUUID(),
    type: 'AGENT_STRUCTURED',
    content: { content_type: 'channel_confirmation', body: display, attachments: [] },
    metadata: { openmax_channel_confirmation: display },
    fallback_text: `请在 OpenMAX 聊天中确认连接${channel.displayName}，确认后才会生成授权二维码。`,
  };
}

/**
 * What a Start result asks the tool to do next.
 * - needs_confirmation: a typed request; send the confirmation card and wait.
 * - card_confirmed: Core accepted a verified card click as the consent and has
 *   already started the provider session; the watcher reads the QR from the
 *   confirmation endpoint. `starting` means a concurrent call for the same
 *   card answer is still starting it.
 */
export function classifyChannelStart(result) {
  const status = String(result?.status || '').trim().toLowerCase();
  if (!UUID_RE.test(result?.confirmation_id || '') || !Number.isFinite(Date.parse(result?.expires_at))) {
    throw new Error('channel connection service returned no human confirmation request; update Core and OpenMAX together');
  }
  if (status === 'awaiting_user_confirmation') return 'needs_confirmation';
  if (status === 'awaiting_user_scan' || status === 'starting') return 'card_confirmed';
  throw new Error('channel connection service returned no human confirmation request; update Core and OpenMAX together');
}

export async function waitForChannelConfirmation({ deadlineMs, poll, sleep, now = Date.now }) {
  while (now() < deadlineMs) {
    try {
      const result = await poll();
      if (['awaiting_user_scan', 'already_connected', 'connection_in_progress'].includes(result?.status)) return result;
      if (!['awaiting_user_confirmation', 'starting'].includes(result?.status)) throw bad('channel confirmation failed');
    } catch (error) {
      if (!isRetryableChannelPollError(error)) throw error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw Object.assign(new Error('channel confirmation expired'), { status: 410 });
}

function requireOrgId(input) {
  const orgId = input.org || input.orgId || input.org_id || resolveDefaultOrgId();
  if (!orgId) throw bad('cannot resolve org; pass org from <org-context>');
  return orgId;
}

function ensurePrivateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(STATE_DIR, 0o700); } catch {}
}

function writePrivate(filePath, data, encoding) {
  fs.writeFileSync(filePath, data, { encoding, mode: 0o600, flag: 'wx' });
}

function sendToConversation(orgId, conversationId, message) {
  const result = spawnSync(process.execPath, [SEND_SCRIPT, conversationId, message], {
    env: { ...process.env, COCO_ORG_ID: orgId, COCO_RPC_LOG: '0' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'send failed').trim();
    throw new Error(`failed to send channel status to conversation: ${detail}`);
  }
}

function safeUnlink(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

function statePathForToken(token) {
  if (!UUID_RE.test(token)) throw bad('invalid watcher token');
  return path.join(STATE_DIR, `${token}.json`);
}

export function channelStatusMessage(channelType, terminal) {
  const channel = PLATFORM_CHANNELS[channelType];
  if (!channel) throw bad(`unsupported channel type in watcher state: ${channelType}`);
  if (terminal === 'connected') {
    return `✅ ${channel.displayName}连接成功，现在可以收发消息。`;
  }
  if (terminal === 'expired') {
    return `${channel.displayName}授权二维码已过期。需要时在聊天里重新说“连接${channel.displayName}”即可。`;
  }
  if (terminal === 'cancelled') {
    return `${channel.displayName}授权已取消。需要时可以在聊天里重新发起。`;
  }
  if (terminal === 'timeout') {
    return `${channel.displayName}扫码已完成，但组件连接超时。请稍后重新发起；如果仍失败再查看服务日志。`;
  }
  return `${channel.displayName}渠道连接失败，请在聊天里重新发起；如果仍失败再查看服务日志。`;
}

export function channelStartResultWithoutQR(channelType, result) {
  const channel = PLATFORM_CHANNELS[channelType];
  if (!channel) throw bad(`unsupported channel type: ${channelType}`);
  const status = String(result?.status || '').trim().toLowerCase();
  if (status === 'already_connected') {
    return {
      status,
      channel_type: channelType,
      qr_sent_to_conversation: false,
      message: `${channel.displayName}已连接，无需重复扫码。`,
    };
  }
  if (status === 'connection_in_progress') {
    return {
      status,
      channel_type: channelType,
      qr_sent_to_conversation: false,
      message: `${channel.displayName}正在连接中，无需重复扫码，请稍候。`,
    };
  }
  return null;
}

export function isRetryableChannelPollError(error) {
  const status = Number(error?.status);
  if (!Number.isFinite(status)) return true;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function bindingStatus(result) {
  return String(result?.binding?.status || result?.status || '').trim().toLowerCase();
}

function bindingStatusFromAuthorization(result) {
  return String(result?.binding?.status || '').trim().toLowerCase();
}

/**
 * Poll the provider only until QR authorization completes, then switch to the
 * read-only Binding status endpoint. The QR's TTL must never cap the runtime
 * install/config/restart phase.
 */
export async function pollChannelUntilTerminal({
  scanDeadlineMs,
  bindingWaitMs = MAX_BINDING_WAIT_SEC * 1000,
  pollAuthorization,
  pollBinding,
  sleep,
  now = Date.now,
}) {
  let authorizationCompleted = false;
  while (now() < scanDeadlineMs) {
    try {
      const result = await pollAuthorization();
      const status = String(result?.status || 'error').toLowerCase();
      if (status === 'pending') {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (status === 'connected') {
        const statusAfterAuthorization = bindingStatusFromAuthorization(result);
        if (statusAfterAuthorization === 'connected') return 'connected';
        if (statusAfterAuthorization === 'pending') {
          authorizationCompleted = true;
          break;
        }
        return 'error';
      }
      if (['expired', 'cancelled', 'error'].includes(status)) return status;
      return 'error';
    } catch (error) {
      if (!isRetryableChannelPollError(error)) return 'error';
      if (now() >= scanDeadlineMs) break;
      await sleep(POLL_INTERVAL_MS);
    }
  }
  if (!authorizationCompleted) return 'expired';

  const bindingDeadlineMs = now() + bindingWaitMs;
  while (now() < bindingDeadlineMs) {
    try {
      const status = bindingStatus(await pollBinding());
      if (status === 'connected') return 'connected';
      if (status === 'pending') {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      return 'error';
    } catch (error) {
      if (!isRetryableChannelPollError(error)) return 'error';
      if (now() >= bindingDeadlineMs) break;
      await sleep(POLL_INTERVAL_MS);
    }
  }

  // Close the race at the deadline: a connect-result may have landed after
  // the last regular read. Never report timeout without one final status read.
  try {
    const status = bindingStatus(await pollBinding());
    if (status === 'connected') return 'connected';
    if (status !== 'pending') return 'error';
  } catch (error) {
    if (!isRetryableChannelPollError(error)) return 'error';
  }
  return 'timeout';
}

async function connect(input) {
  const plan = planChannelConnect(input);
  const orgId = requireOrgId(input);
  const result = await postForOrg(
    orgId,
    apiPath('/agent-tools/channel-connections'),
    plan.body,
    { timeoutMs: 30_000, quietOnSuccess: true },
  );
  const noQRResult = channelStartResultWithoutQR(plan.channelType, result);
  if (noQRResult) return noQRResult;
  const startKind = classifyChannelStart(result);

  ensurePrivateDir();
  const token = randomUUID();
  const statePath = statePathForToken(token);
  writePrivate(statePath, JSON.stringify({
    orgId,
    channelType: plan.channelType,
    conversationId: plan.conversationId,
    confirmationId: result.confirmation_id,
    // One additional minute lets an accepted click finish its bounded Start
    // request. Core still enforces the exact five-minute human-click deadline.
    confirmationDeadlineMs: Math.min(Date.parse(result.expires_at), Date.now() + MAX_QR_SESSION_SEC * 1000) + 60_000,
  }), 'utf8');

  // A verified owner/admin click on the Agent's own channel card was already
  // the consent (Core confirmed it as the clicker), so there is no
  // confirmation card to send: the watcher goes straight to the QR.
  if (startKind === 'needs_confirmation') {
    try {
      await postForOrg(
        orgId,
        apiPath(`/conversations/${plan.conversationId}/messages`),
        buildChannelConfirmationMessage(plan.channelType, result.confirmation_id, result.expires_at),
        { timeoutMs: 30_000, quietOnSuccess: true },
      );
    } catch (error) {
      safeUnlink(statePath);
      throw error;
    }
  }

  const child = spawn(process.execPath, [TOOL_SCRIPT, 'channel._watch', JSON.stringify({ token })], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, COCO_RPC_LOG: '0' },
  });
  child.unref();

  // stdout is read by the Agent. Deliberately exclude qr_png_base64,
  // session_handle, auth_url, and local file paths.
  if (startKind === 'card_confirmed') {
    return {
      status: 'awaiting_user_scan',
      channel_type: plan.channelType,
      qr_sent_to_conversation: true,
      confirmation_sent_to_conversation: false,
      message: `${PLATFORM_CHANNELS[plan.channelType].displayName}授权二维码马上发到聊天里，请用手机扫码。`,
    };
  }
  return {
    status: 'awaiting_user_confirmation',
    channel_type: plan.channelType,
    qr_sent_to_conversation: false,
    confirmation_sent_to_conversation: true,
    message: '请在聊天卡片中点击确认连接，之后才会生成二维码。',
  };
}

async function watch(input) {
  const statePath = statePathForToken(String(input.token || ''));
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { status: 'watcher_state_missing' };
  }

  let terminal = 'error';
  let scanStarted = false;
  try {
    // Legacy state files have no confirmation ID and are never grandfathered
    // into the mutating provider poll endpoint.
    if (!UUID_RE.test(state.confirmationId || '')) throw bad('human confirmation required');
    const result = await waitForChannelConfirmation({
      deadlineMs: state.confirmationDeadlineMs,
      poll: () => postForOrg(state.orgId, apiPath('/agent-tools/channel-connections/confirmation'), {
        confirmation_id: state.confirmationId,
        channel_type: state.channelType,
        conversation_id: state.conversationId,
      }, { timeoutMs: 30_000, quietOnSuccess: true }),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    });
    const noQR = channelStartResultWithoutQR(state.channelType, result);
    if (noQR) {
      sendToConversation(state.orgId, state.conversationId, noQR.message);
      terminal = 'no_qr';
      return { status: result.status };
    }
    const scanDeadlineMs = Date.parse(result.expires_at);
    if (!result.qr_ref || !result.session_handle || !Number.isFinite(scanDeadlineMs) || scanDeadlineMs <= Date.now()) throw bad('invalid confirmed QR session');
    await postForOrg(state.orgId, apiPath(`/conversations/${state.conversationId}/messages`),
      buildChannelQRMessage(state.channelType, result.qr_ref, result.expires_at),
      { timeoutMs: 30_000, quietOnSuccess: true });
    scanStarted = true;
    terminal = await pollChannelUntilTerminal({
      scanDeadlineMs,
      pollAuthorization: () => postForOrg(
          state.orgId,
          apiPath('/agent-tools/channel-connections/poll'),
          {
            channel_type: state.channelType,
            session_handle: result.session_handle,
            confirmation_id: state.confirmationId,
          },
          { timeoutMs: 30_000, quietOnSuccess: true },
        ),
      pollBinding: () => postForOrg(
          state.orgId,
          apiPath('/agent-tools/channel-connections/status'),
          { channel_type: state.channelType },
          { timeoutMs: 30_000, quietOnSuccess: true },
        ),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    });
  } catch (error) {
    terminal = Number(error?.status) === 410 && !scanStarted ? 'confirmation_expired' : 'error';
  } finally {
    try {
      if (terminal !== 'no_qr') {
        const text = terminal === 'confirmation_expired'
          ? `${PLATFORM_CHANNELS[state.channelType]?.displayName || ''}连接确认已过期，尚未完成扫码连接。需要时请重新发起。`
          : channelStatusMessage(state.channelType, terminal);
        sendToConversation(state.orgId, state.conversationId, text);
      }
    } catch {}
    safeUnlink(statePath);
  }
  return { status: terminal };
}

const commands = {
  'channel.connect': connect,
  'channel._watch': watch,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  let input = {};
  try {
    input = rest.length ? JSON.parse(rest.join(' ')) : {};
    const handler = commands[command];
    if (!handler) throw bad(`unknown command: ${command || '(missing)'}`);
    const result = await handler(input);
    console.log(JSON.stringify(result));
  } catch (error) {
    const out = { error: error.message || String(error) };
    if (error.status) out.status = error.status;
    console.error(JSON.stringify(out));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === TOOL_SCRIPT) {
  main();
}
