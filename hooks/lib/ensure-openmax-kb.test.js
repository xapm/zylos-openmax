import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureOpenmaxKb, cmpVer, KB_PIN, KB_NAME, KB_REPO } from './ensure-openmax-kb.js';

// Build an injectable deps harness that records logs and zylos invocations.
function harness({ region = '', version = null, cloned = true, runImpl } = {}) {
  const logs = [], warns = [], errors = [], runs = [];
  const deps = {
    env: { DEPLOY_REGION: region },
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    readVersion: () => version,
    probe: () => cloned,
    run: (args) => { runs.push(args); if (runImpl) runImpl(args); },
  };
  return { deps, logs, warns, errors, runs, all: () => [...logs, ...warns, ...errors].join('\n') };
}

test('cmpVer boundaries', () => {
  assert.equal(cmpVer('0.1.0', '0.1.0'), 0);
  assert.equal(cmpVer('0.1.0', '0.2.0'), -1);
  assert.equal(cmpVer('1.0.0', '0.9.9'), 1);
  assert.equal(cmpVer('0.2.0', '0.1.9'), 1);
  assert.equal(cmpVer('0.10.0', '0.9.0'), 1); // numeric, not lexical
});

test('DEPLOY_REGION=cn short-circuits (no zylos call)', () => {
  const h = harness({ region: 'cn', version: null });
  ensureOpenmaxKb(h.deps);
  assert.equal(h.runs.length, 0);
  assert.match(h.logs.join('\n'), /DEPLOY_REGION=cn — skip/);
});

test('installed >= pin AND cloned → skip, no run', () => {
  const h = harness({ version: '0.1.0', cloned: true });
  ensureOpenmaxKb(h.deps);
  assert.equal(h.runs.length, 0);
  assert.match(h.logs.join('\n'), new RegExp(`${KB_NAME}@0\\.1\\.0 >= pin ${KB_PIN} — skip`));
});

test('N2-1: installed >= pin BUT repo missing → warn empty shell, no run (skip path is probed too)', () => {
  const h = harness({ version: '0.2.0', cloned: false });
  ensureOpenmaxKb(h.deps);
  assert.equal(h.runs.length, 0, 'must not call zylos on skip path');
  assert.match(h.warns.join('\n'), /registered but repo\/\.git missing — empty shell/);
});

test('installed < pin → upgrade once', () => {
  const h = harness({ version: '0.0.9', cloned: true });
  ensureOpenmaxKb(h.deps);
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.runs[0], ['upgrade', KB_NAME, '--yes']);
});

test('not installed → add @pin once', () => {
  const h = harness({ version: null, cloned: true });
  ensureOpenmaxKb(h.deps);
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.runs[0], ['add', `${KB_REPO}@${KB_PIN}`, '--yes']);
});

test('zylos throws → non-fatal (does not throw), logs error', () => {
  const h = harness({ version: null, cloned: false, runImpl: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => ensureOpenmaxKb(h.deps));
  assert.match(h.errors.join('\n'), /install failed \(non-fatal/);
});

test('timeout-style error surfaces e.stderr (N1-1)', () => {
  const h = harness({
    version: null, cloned: false,
    runImpl: () => { const e = new Error('spawnSync zylos ETIMEDOUT'); e.stderr = 'CHILD-STDERR-BEFORE-HANG'; throw e; },
  });
  ensureOpenmaxKb(h.deps);
  assert.match(h.errors.join('\n'), /ETIMEDOUT/);
  assert.match(h.errors.join('\n'), /stderr: .*CHILD-STDERR-BEFORE-HANG/);
});

test('N4-1: upgrade fails but old clone present → attribute to failure, not release lag', () => {
  const h = harness({ version: '0.0.9', cloned: true, runImpl: () => { throw new Error('nope'); } });
  ensureOpenmaxKb(h.deps);
  const w = h.warns.join('\n');
  assert.match(w, /upgrade failed \(see error above\); current registered version 0\.0\.9/);
  assert.doesNotMatch(w, /may lag KB_PIN/, 'must not blame kb release cadence on a failed upgrade');
});

test('add succeeds → probe true, version now >= pin → ✓', () => {
  // readVersion is called again in finally; simulate registry now showing the pin.
  let calls = 0;
  const deps = {
    env: {}, log: [], warn: [], error: [],
  };
  const logs = [], warns = [], errors = [], runs = [];
  ensureOpenmaxKb({
    env: {},
    log: (m) => logs.push(m), warn: (m) => warns.push(m), error: (m) => errors.push(m),
    readVersion: () => (calls++ === 0 ? null : KB_PIN), // absent first, pin after add
    probe: () => true,
    run: (args) => runs.push(args),
  });
  assert.deepEqual(runs[0], ['add', `${KB_REPO}@${KB_PIN}`, '--yes']);
  assert.match(logs.join('\n'), new RegExp(`✓ ${KB_NAME}@${KB_PIN.replace(/\./g, '\\.')}`));
  assert.equal(warns.length, 0);
});

test('finally: install failed before registry (cur=null, no clone) → "not installed, will retry" (self-heals, not "needs attention")', () => {
  const h = harness({ version: null, cloned: false });
  ensureOpenmaxKb(h.deps);
  const w = h.warns.join('\n');
  assert.match(w, /not installed \(install did not complete; will retry on next run\)/);
  assert.doesNotMatch(w, /needs attention/, 'a not-installed failure self-heals; must not be flagged for attention');
  assert.doesNotMatch(w, /registered but/, 'must not claim registered when cur=null');
});

test('finally: upgrade path but repo missing (cur set, no clone) → registered empty-shell needs attention', () => {
  const h = harness({ version: '0.0.9', cloned: false });
  ensureOpenmaxKb(h.deps);
  assert.match(h.warns.join('\n'), /openmax-kb@0\.0\.9 registered but repo\/\.git missing — empty shell.*needs attention/);
});
