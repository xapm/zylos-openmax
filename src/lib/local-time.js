/**
 * Render an instant in the agent's configured timezone.
 *
 * Every timestamp this process handles arrives as UTC — the server sends
 * `settled_at` as ISO-8601 with a `Z`, and `new Date().toISOString()` produces
 * the same. Printed as-is, a receipt says `12:30` for something that happened
 * at 20:30 where the person reading it lives, and the reader either does the
 * arithmetic or, more often, misreads the answer as hours older than it is.
 *
 * 🔴 This is for DISPLAY only. The machine-readable copies stay UTC and stay
 * ISO: `<interaction-receipt settled-at="…"/>`, the `askedAt` written into
 * pending-questions.json, and anything compared against `Date.now()`. A local
 * rendering is ambiguous the moment it leaves the machine that made it (no
 * offset survives a `2026-09-24 20:30` string), so the two must not be swapped
 * for each other — which is why every call site here keeps the raw value
 * alongside rather than replacing it.
 *
 * 🔴 The zone is the AGENT's configured one, not the machine's. They happen to
 * match on this box, which is exactly why the difference has to be written down
 * rather than discovered later: a zylos agent is provisioned with a timezone
 * that lands in `~/zylos/.env` as `TZ=`, while the host it runs on is usually
 * UTC. Reading the host zone would be right here and silently wrong on the next
 * deployment — and the failure would look like nothing, just times that are
 * some hours off.
 *
 * So the order is: `TZ` in the process environment (pm2 injects the configured
 * value, so this is the configured zone, not the host's), then the `TZ=` line
 * of the agent's own `.env`, and only then whatever `Intl` defaults to. The
 * middle step is what makes a CLI run outside pm2 — where nothing exported
 * `TZ` — still print the agent's time instead of the machine's.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/** The agent's zylos directory, resolved exactly as agent-readiness.js does. */
function zylosDir() {
  return process.env.ZYLOS_DIR || path.join(process.env.HOME || os.homedir(), 'zylos');
}

/**
 * The agent's configured zone, or '' when nothing configures one (callers then
 * let `Intl` pick, which is the host zone — the last resort, never the first).
 *
 * The `.env` read is deliberately not cached: this is called a handful of times
 * per process, and a stale zone after someone edits the file would be another
 * quiet wrongness of exactly the kind this module exists to remove.
 */
export function agentTimeZone() {
  const fromEnv = (process.env.TZ || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(path.join(zylosDir(), '.env'), 'utf8');
    // Last assignment wins, matching how a shell would source the file.
    let found = '';
    for (const line of raw.split('\n')) {
      const m = /^\s*(?:export\s+)?TZ\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[1].trim().replace(/^["']|["']$/g, '').split('#')[0].trim();
      if (value) found = value;
    }
    return found;
  } catch {
    // No .env, unreadable, or no HOME: fall through to the Intl default.
    return '';
  }
}

/**
 * `2026-09-24 20:30:12 (+08:00)`, or null when the input is not a time.
 *
 * The offset is part of the output on purpose: without it the string is a wall
 * clock with no zone, and a reader who is not on this machine cannot tell which
 * one it is. Returning null (rather than throwing or echoing the input) lets a
 * caller decide between the local form and the raw one.
 */
export function formatLocalTime(value, { timeZone = agentTimeZone() } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      timeZoneName: 'longOffset',
    }).formatToParts(date);
    const at = (type) => parts.find((p) => p.type === type)?.value || '';
    const offset = at('timeZoneName').replace(/^GMT/, '') || '+00:00';
    const hour = at('hour') === '24' ? '00' : at('hour');
    return `${at('year')}-${at('month')}-${at('day')} ${hour}:${at('minute')}:${at('second')} (${offset})`;
  } catch {
    // An invalid TZ name makes Intl throw. A wrong-looking clock is worse than
    // no clock, so fall back to the caller's raw value by saying nothing.
    return null;
  }
}
