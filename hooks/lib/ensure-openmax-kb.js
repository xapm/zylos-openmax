/**
 * ensure-openmax-kb.js — auto-install / upgrade the openmax-kb companion component.
 *
 * Invoked at the end of openmax's post-install (on install) and post-upgrade
 * (on upgrade) hooks so every agent that has openmax also gets the product
 * knowledge base by default. Idempotent, non-fatal, time-bounded.
 *
 * Behavior (Plan B — version compare):
 *   DEPLOY_REGION=cn        → skip (GitHub unreachable; cn content source is out of scope)
 *   installed  >= KB_PIN    → skip (also probes for an empty shell)
 *   installed  <  KB_PIN    → `zylos upgrade openmax-kb --yes`
 *   not installed           → `zylos add openmaxai/zylos-openmax-kb@<pin> --yes`
 *
 * Failure is non-fatal (warns, never throws) so a kb hiccup never blocks the
 * openmax install/upgrade. The nested zylos call is bounded by a 30s timeout +
 * SIGKILL so a hung git clone cannot stall the upgrade or hold the component lock.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export const KB_REPO    = 'openmaxai/zylos-openmax-kb';
export const KB_PIN     = '0.1.0';
export const KB_NAME    = 'openmax-kb';
export const TIMEOUT_MS = 30000;

// zylos CLI is a sibling of node (the hook is launched via spawnSync(process.execPath));
// it lives with node in the npm-global bin, NOT under ~/zylos/bin. Fall back to bare name.
export function zylosBin() {
  const sib = path.join(path.dirname(process.execPath), 'zylos');
  return fs.existsSync(sib) ? sib : 'zylos';
}

// Minimal semver compare: a<b → -1, a==b → 0, a>b → 1.
// Note: does not handle prerelease ('0.2.0-beta.1' 3rd part → NaN → treated as 0); kb ships no prerelease.
export function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Nested zylos call: bounded (30s + SIGKILL) and self-contained stdio.
// Explicit ['ignore','pipe','pipe'] keeps BOTH stdout and stderr in our own buffer;
// execFileSync would otherwise forward stderr to the parent (→ floods the outer 1MB pipe).
export function runZylos(args) {
  execFileSync(zylosBin(), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Read the locally-recorded kb version (no network). components.json is a dict
// keyed by component name; entries carry `version` (no `name` field).
export function installedKbVersion() {
  try {
    const reg = path.join(process.env.HOME, 'zylos/.zylos/components.json');
    const installed = JSON.parse(fs.readFileSync(reg, 'utf8'));
    return Object.prototype.hasOwnProperty.call(installed, KB_NAME)
      ? (installed[KB_NAME].version || '0.0.0')
      : null;
  } catch (e) {
    console.warn(`[openmax] components.json read failed, treating ${KB_NAME} as not installed: ${e.message}`);
    return null;
  }
}

// Empty-shell probe: kb clones content into DATA_DIR/repo. Check repo/.git — NOT
// DATA_DIR itself (which always holds a config.json written before the clone).
// Pure local readdir: bounded, no network, cannot hang.
export function probeCloned() {
  const repoDir = path.join(process.env.HOME, 'zylos/components/openmax-kb/repo');
  try {
    return fs.existsSync(path.join(repoDir, '.git')) && fs.readdirSync(repoDir).length > 1;
  } catch {
    return false;
  }
}

/**
 * Ensure openmax-kb is present at >= KB_PIN. Production hooks call ensureOpenmaxKb().
 * The optional deps object exists only so unit tests can inject fakes.
 */
export function ensureOpenmaxKb(deps = {}) {
  const {
    env = process.env,
    log = console.log,
    warn = console.warn,
    error = console.error,
    readVersion = installedKbVersion,
    probe = probeCloned,
    run = runZylos,
  } = deps;

  // region short-circuit: cn cannot reach GitHub → would only produce an empty shell.
  if ((env.DEPLOY_REGION || '').toLowerCase() === 'cn') {
    log(`[openmax] DEPLOY_REGION=cn — skip ${KB_NAME} (content source handled separately)`);
    return;
  }

  const cur = readVersion();

  // Already at or above pin → skip. Still probe once: an empty shell would otherwise
  // never be re-checked (every later run also skips here).
  if (cur && cmpVer(cur, KB_PIN) >= 0) {
    if (probe()) log(`[openmax] ${KB_NAME}@${cur} >= pin ${KB_PIN} — skip`);
    else warn(`[openmax] ⚠ ${KB_NAME}@${cur} registered but repo/.git missing — empty shell (non-fatal, needs attention)`);
    return;
  }

  let failed = false;
  try {
    if (!cur) {
      log(`[openmax] installing ${KB_REPO}@${KB_PIN} …`);
      run(['add', `${KB_REPO}@${KB_PIN}`, '--yes']);
    } else {
      // zylos upgrade has no exact-version flag; it converges to the latest kb release.
      log(`[openmax] upgrading ${KB_NAME}: ${cur} → >=${KB_PIN} …`);
      run(['upgrade', KB_NAME, '--yes']);
    }
  } catch (e) {
    failed = true;
    // On the timeout path, stderr lands on e.stderr (NOT e.message) — surface it so a
    // hung clone-vs-npm is diagnosable.
    const extra = e.stderr ? ' | stderr: ' + String(e.stderr).slice(-500) : '';
    error(`[openmax] ⚠ ${KB_NAME} ${cur ? 'upgrade' : 'install'} failed (non-fatal, openmax not blocked): ${e.message}${extra}`);
  } finally {
    if (!probe()) {
      // Distinguish a sticky empty shell (registered but no content — needs attention)
      // from a plain not-installed failure (e.g. add died before writing the registry —
      // self-heals: next run has cur=null and retries the install).
      const now = readVersion();
      if (now) warn(`[openmax] ⚠ ${KB_NAME}@${now} registered but repo/.git missing — empty shell (non-fatal, needs attention)`);
      else warn(`[openmax] ⚠ ${KB_NAME} not installed (${cur ? 'upgrade' : 'install'} did not complete; will retry on next run)`);
    } else if (failed) {
      // Command failed but a prior clone is still present. Do not blame kb release cadence;
      // report the real registered version honestly.
      const now = readVersion();
      warn(`[openmax] ⚠ ${KB_NAME} ${cur ? 'upgrade' : 'install'} failed (see error above); current registered version ${now || 'none'}`);
    } else {
      const now = readVersion();
      if (now && cmpVer(now, KB_PIN) >= 0) log(`[openmax] ✓ ${KB_NAME}@${now}`);
      else warn(`[openmax] ⚠ ${KB_NAME}@${now || '?'} still < pin ${KB_PIN} — kb latest release may lag KB_PIN (publish kb release before bumping KB_PIN)`);
    }
  }
}
