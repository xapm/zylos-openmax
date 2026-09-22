/**
 * Durable record of a choice card this agent is waiting on an answer to.
 *
 * A card asks a question in a conversation and the answer arrives, minutes or
 * days later, as a separate `interaction_receipt` message. The receipt names
 * the card it answers — and nothing else: it cannot say what the card was FOR.
 * So the question's meaning has to be written down when it is asked, or the
 * answer arrives decodable but meaningless.
 *
 * It lives on disk rather than in memory because every way this waiting ends
 * destroys memory: the model's session turns over, the service restarts, and
 * for the upgrade question specifically, the very act being authorized
 * restarts the process. In-memory state would die at exactly the moment it is
 * needed. Same reasoning, and the same shape, as connect-result-queue.js.
 *
 * ⚠️ `RUNTIME_DIR` sits under the component directory that `zylos upgrade`
 * replaces. Whether a record survives its own upgrade is UNVERIFIED — treat a
 * missing record after an upgrade as possible, not as corruption.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';

export const PENDING_QUESTIONS_PATH = path.join(RUNTIME_DIR, 'pending-questions.json');

/** Anything older than this is not answerable — see `isExpired`. */
export const PENDING_QUESTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Bound the file. Questions are rare; a runaway writer is the only way to hit this. */
export const PENDING_QUESTIONS_MAX = 50;

function readAll(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    // Missing or corrupt: an unanswerable question is better than a crash on
    // every inbound receipt.
    return [];
  }
}

function writeAll(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(records, null, 2));
}

/**
 * Record a question. `cardMessageId` is the id the receipt will name, and
 * `actionIds` are the server's option ids in the order they were sent — the
 * only way to turn an answered action id back into which option it was.
 *
 * `askedAt` is passed in rather than read from the clock so the caller owns
 * the timestamp and the function stays testable.
 */
export function recordPendingQuestion(record, { file = PENDING_QUESTIONS_PATH } = {}) {
  const { kind, cardMessageId, conversationId, actionIds, askedAt } = record;
  if (!kind || !cardMessageId || !conversationId || !askedAt) {
    throw new Error('pending question: kind, cardMessageId, conversationId and askedAt are required');
  }
  if (!Array.isArray(actionIds) || actionIds.length === 0) {
    throw new Error('pending question: actionIds is required — without it an answer cannot be decoded');
  }
  const records = readAll(file)
    .filter((r) => String(r.cardMessageId) !== String(cardMessageId));
  records.push({ ...record, cardMessageId: String(cardMessageId) });
  writeAll(file, records.slice(-PENDING_QUESTIONS_MAX));
  return record;
}

/** The question a receipt answers, or null when this agent never asked it. */
export function findPendingQuestion(cardMessageId, { file = PENDING_QUESTIONS_PATH } = {}) {
  if (!cardMessageId) return null;
  const want = String(cardMessageId);
  return readAll(file).find((r) => String(r.cardMessageId) === want) || null;
}

/**
 * Whether the answer arrived too late to act on. The caller supplies `now`,
 * again so the clock is the caller's.
 *
 * 🔴 An expired question must not be executed. The upgrade case is why: a card
 * asking "upgrade to v2?" answered three weeks later names a version that is
 * no longer the one on offer, and acting on it upgrades to something nobody
 * was asked about.
 */
export function isExpired(record, now, { ttlMs = PENDING_QUESTION_TTL_MS } = {}) {
  if (!record?.askedAt) return true;
  const asked = Date.parse(record.askedAt);
  if (Number.isNaN(asked)) return true;
  return now - asked > ttlMs;
}

/**
 * Whether this member's click counts. The interaction protocol has no
 * authorization of its own — anyone in the conversation can press the button —
 * so the question records who it was asked of, and the answer is checked
 * against that. Missing either side is a refusal, never a pass.
 */
export function isAnswerAuthorized(record, actorMemberId) {
  if (!record?.askedOf || !actorMemberId) return false;
  return String(record.askedOf) === String(actorMemberId);
}

/** Drop a question once it has been acted on, or when it expired unanswered. */
export function clearPendingQuestion(cardMessageId, { file = PENDING_QUESTIONS_PATH } = {}) {
  const want = String(cardMessageId);
  const records = readAll(file);
  const kept = records.filter((r) => String(r.cardMessageId) !== want);
  if (kept.length !== records.length) writeAll(file, kept);
  return records.length - kept.length;
}

/** Every question still on file, newest last. Used by the CLI to show state. */
export function listPendingQuestions({ file = PENDING_QUESTIONS_PATH } = {}) {
  return readAll(file);
}
