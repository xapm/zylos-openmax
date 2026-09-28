import assert from 'node:assert/strict';
import test from 'node:test';

import { formatLocalTime } from './local-time.js';

const UTC_NOON = '2026-09-24T12:30:00Z';

test('renders an instant in the given zone, with the offset attached', () => {
  assert.equal(formatLocalTime(UTC_NOON, { timeZone: 'Asia/Singapore' }), '2026-09-24 20:30:00 (+08:00)');
  assert.equal(formatLocalTime(UTC_NOON, { timeZone: 'UTC' }), '2026-09-24 12:30:00 (+00:00)');
});

test('🔴 the offset is never omitted, in any zone', () => {
  // Without it the output is a wall clock with no zone, which is exactly the
  // ambiguity this module exists to remove — a reader on another machine
  // cannot tell whether `20:30` is theirs.
  for (const timeZone of ['Asia/Singapore', 'UTC', 'America/New_York', 'Asia/Kolkata']) {
    assert.match(formatLocalTime(UTC_NOON, { timeZone }), /\([+-]\d{2}:\d{2}\)$/, timeZone);
  }
});

test('a zone that shifts the date renders the shifted date, not just the clock', () => {
  // 12:30Z is the previous day in New York — the bug this replaces printed the
  // UTC date beside a local-looking time.
  assert.equal(formatLocalTime('2026-09-24T02:30:00Z', { timeZone: 'America/New_York' }), '2026-09-23 22:30:00 (-04:00)');
});

test('midnight renders as 00, not 24', () => {
  assert.match(formatLocalTime('2026-09-24T16:00:00Z', { timeZone: 'Asia/Singapore' }), /^2026-09-25 00:00:00 /);
});

test('anything that is not a time returns null rather than a wrong-looking clock', () => {
  for (const bad of [undefined, null, '', 'not a time', NaN]) {
    assert.equal(formatLocalTime(bad), null, String(bad));
  }
  assert.equal(formatLocalTime(UTC_NOON, { timeZone: 'Mars/Olympus' }), null);
});



// --- the zone is the AGENT's, not the machine's -----------------------------
// These pin the part that cannot be observed on this box by accident: its host
// zone and its configured zone are the same, so a resolver that read the host
// would look correct here and be wrong on a UTC VM. Every case below therefore
// uses a zone that is neither.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { agentTimeZone } from './local-time.js';

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function zylosDirWith(envContents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-tz-'));
  if (envContents !== null) fs.writeFileSync(path.join(dir, '.env'), envContents);
  return dir;
}

test("🔴 with TZ unset, the zone comes from the agent's .env, not the host", () => {
  const dir = zylosDirWith('FOO=1\nTZ=Pacific/Kiritimati\n');
  withEnv({ TZ: undefined, ZYLOS_DIR: dir }, () => {
    assert.equal(agentTimeZone(), 'Pacific/Kiritimati');
    // +14 is a zone no host here would be in, so this also proves the value is
    // used and not merely returned.
    assert.match(formatLocalTime('2026-09-24T12:30:00Z'), /\(\+14:00\)$/);
  });
});

test('TZ in the environment wins over the file (pm2 injects the configured value)', () => {
  const dir = zylosDirWith('TZ=Pacific/Kiritimati\n');
  withEnv({ TZ: 'UTC', ZYLOS_DIR: dir }, () => {
    assert.equal(agentTimeZone(), 'UTC');
  });
});

test('the .env line is parsed the way a shell would read it', () => {
  const dir = zylosDirWith('export TZ = "Asia/Tokyo"   # set at provisioning\nTZ=Europe/Berlin\n');
  withEnv({ TZ: undefined, ZYLOS_DIR: dir }, () => {
    // Last assignment wins, quotes and trailing comment stripped.
    assert.equal(agentTimeZone(), 'Europe/Berlin');
  });
});

test('no .env, or no TZ line, resolves to empty so Intl picks the host zone', () => {
  withEnv({ TZ: undefined, ZYLOS_DIR: zylosDirWith(null) }, () => {
    assert.equal(agentTimeZone(), '');
  });
  withEnv({ TZ: undefined, ZYLOS_DIR: zylosDirWith('FOO=1\n') }, () => {
    assert.equal(agentTimeZone(), '');
  });
});
