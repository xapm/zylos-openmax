/**
 * Auto-upgrade — periodically check GitHub for new releases and upgrade openmax
 * via a dedicated, on-demand PM2 app (the "upgrader").
 *
 * Flow:
 *   1. Timer fires (first check after intervalMs, then every intervalMs).
 *   2. Fetch latest GitHub release tag via REST API.
 *   3. Compare against current package.json version (semver).
 *   4. If newer: write a 'running' marker, start the executor as its OWN PM2
 *      app (`zylos-openmax-upgrader`) via `pm2 start`, and only notify owners
 *      once the start succeeded (a failed start writes a failed marker and
 *      notifies of the failure instead).
 *   5. Because a pm2-started process is parented to the PM2 daemon (a sibling of
 *      zylos-openmax, not a descendant), the `pm2 stop zylos-openmax` inside
 *      `zylos upgrade openmax` can never kill it — no "suicide" mid-upgrade.
 *      The executor snapshots the current version, verifies the new version,
 *      rolls back to the snapshot on failure, writes a terminal marker, ensures
 *      the service is running, and removes its own PM2 entry. PM2 acts as its
 *      watchdog: the upgrader runs with autorestart capped at max_restarts, so
 *      an executor that dies unexpectedly (OOM, kill) is relaunched within
 *      seconds; the relaunch detects the foreign pid claim in the marker and
 *      recovers (restore + restart openmax) instead of re-running the upgrade.
 *      This matters because the detection timer below lives INSIDE openmax —
 *      if openmax is left stopped, no future check cycle can ever rescue it.
 *   6. On the next startup / check, notifyUpgradeComplete reads the terminal
 *      marker and DMs owners. A leftover upgrader entry found on a later check
 *      is treated as a zombie: cleaned up and (if its marker was still
 *      'running') recorded as a failed version so it is never retried into a
 *      loop. An upgrader that is still ONLINE is never killed from here.
 *
 * Config (all optional, in config.json top level):
 *   autoUpgrade.enabled        — boolean, default false
 *   autoUpgrade.intervalHours  — number,  default 24
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const HOME = process.env.HOME || '/tmp';
const RUNTIME_DIR = path.join(HOME, 'zylos/components/openmax/runtime');
const MARKER_PATH = path.join(RUNTIME_DIR, 'upgrade-marker.json');
const SEND_SCRIPT = path.resolve(new URL('../../scripts/send.js', import.meta.url).pathname);
const EXECUTOR_SCRIPT = path.resolve(new URL('../../scripts/upgrade-executor.cjs', import.meta.url).pathname);
const FAILED_VERSION_PATH = path.join(RUNTIME_DIR, 'upgrade-failed-version');
const GITHUB_REPO = 'zylos-ai/zylos-openmax';
export const INITIAL_DELAY_MS = 60 * 1000;
export const DEFAULT_INTERVAL_HOURS = 24;

export function resolveAutoUpgradeSchedule(settings = {}) {
  if (settings?.enabled !== true) {
    return { enabled: false };
  }

  const intervalHours = Number(settings.intervalHours) || DEFAULT_INTERVAL_HOURS;
  return {
    enabled: true,
    intervalHours,
    intervalMs: intervalHours * 3600_000,
    delay: 0,
    runOnStart: false,
  };
}

// PM2 app name for the on-demand upgrade executor. It is started as its own PM2
// app (a sibling of zylos-openmax under the PM2 daemon) so that the
// `pm2 stop zylos-openmax` inside `zylos upgrade openmax` can never kill it.
const PM2_UPGRADER = 'zylos-openmax-upgrader';

// PM2-captured stdout/stderr of the upgrader app. Pointed into the runtime dir
// via --output/--error (the ~/.pm2/logs defaults would accumulate forever) and
// removed on every cleanup path here; the executor also removes them when it
// finishes. A watchdog relaunch keeps them until terminal cleanup so crash
// forensics survive.
const UPGRADER_OUT_LOG = path.join(RUNTIME_DIR, 'upgrader-out.log');
const UPGRADER_ERR_LOG = path.join(RUNTIME_DIR, 'upgrader-err.log');

export const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;

// Grace period after a 'running' marker is written during which the upgrader
// pm2 entry may legitimately not be visible yet (pm2 start still in flight on
// a slow box). Only after this do we treat marker-without-entry as interrupted.
export const GRACE_START_MS = 2 * 60 * 1000;

const log  = (...a) => console.log('[auto-upgrade]', ...a);
const warn = (...a) => console.warn('[auto-upgrade]', ...a);

function readPkgVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    );
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function compareSemver(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

// Default GitHub REST base. Kept as a constant so the default resolution below
// produces the exact same URL the hardcoded path used before issue #146.
const DEFAULT_API_BASE = 'https://api.github.com';

// Build `<base>/repos/<repo>/releases/latest`, tolerating a trailing slash (or
// several) on the base so both `https://host` and `https://host/gh-api/` join
// cleanly.
function releasesLatestUrl(base) {
  return `${base.replace(/\/+$/, '')}/repos/${GITHUB_REPO}/releases/latest`;
}

// A single ZYLOS_UPSTREAM_TRUST_HOSTS entry is an exact `host[:port]` token:
// DNS labels (alnum + internal hyphens) joined by dots, with an optional
// numeric port. No scheme, path, userinfo, or whitespace — anything else is
// malformed and must not be treated as a valid authorization.
function isValidHostToken(tok) {
  if (!tok || tok.length > 263) return false; // 253 host + ':' + up to 5 port
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/.test(tok);
}

// Parse ZYLOS_UPSTREAM_TRUST_HOSTS into a lowercase Set of exact `host[:port]`
// tokens. STRICTLY comma-separated: whitespace is NOT a separator, so a token
// that contains whitespace is malformed and rejected (a fat-fingered
// space-separated list can never silently authorize a host). Empty items (a
// stray/trailing comma) are skipped; malformed items are rejected with a
// warning rather than treated as valid. This is the same trust convention
// catalog/runtime uses when injecting the mirror config for self-upgrade.
export function parseTrustHosts() {
  const set = new Set();
  for (const raw of (process.env.ZYLOS_UPSTREAM_TRUST_HOSTS || '').split(',')) {
    const tok = raw.trim().toLowerCase();
    if (!tok) continue; // skip empty items (e.g. a stray or trailing comma)
    if (!isValidHostToken(tok)) {
      warn(`ignoring malformed ZYLOS_UPSTREAM_TRUST_HOSTS entry: ${JSON.stringify(raw)}`);
      continue;
    }
    set.add(tok);
  }
  return set;
}

// Shared URL-safety gate applied to any resolved URL before it is used or given
// a token: must be https, must not embed credentials (user:pass@), must not
// carry a fragment. Returns the parsed URL, or null when unsafe/malformed.
function safeHttpsUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.hash) return null;
  return u;
}

// True only when urlStr parses, is https, and its FULL host (including port) is
// present in `trusted`. Requiring https and matching URL.host (not hostname)
// means an entry `mirror.example` does NOT authorize `mirror.example:4444` and
// never authorizes an http:// origin.
function isTrustedHost(urlStr, trusted) {
  const u = safeHttpsUrl(urlStr);
  return u ? trusted.has(u.host.toLowerCase()) : false;
}

// Validate a *base* URL (GITHUB_API_BASE / providers.github.apiBase) and build
// the releases-latest URL from it. A base must be a clean https origin+path
// prefix: no credentials, no fragment, and no query (we append a path, so a
// base query would yield a malformed target). Returns the built URL string, or
// null when the base is malformed/unsafe (the caller then falls through).
function buildValidatedReleasesUrl(base) {
  const u = safeHttpsUrl(base);
  if (!u || u.search) return null;
  return releasesLatestUrl(base);
}

// Token-attachment boundary. Attach GITHUB_TOKEN/GH_TOKEN ONLY when the resolved
// target is (a) official GitHub (api.github.com) or (b) an explicitly
// authorized https exact host[:port] in ZYLOS_UPSTREAM_TRUST_HOSTS. Never for
// an http:// URL, a URL with embedded credentials, or an unauthorized host/port.
export function shouldAttachToken(urlStr) {
  const u = safeHttpsUrl(urlStr);
  if (!u) return false;
  const host = u.host.toLowerCase();
  if (host === 'api.github.com') return true;
  return parseTrustHosts().has(host);
}

/**
 * Issue #146 — derive the REST base from the catalog-injected upstreams.json.
 *
 * upstreams.json shape: { schemaVersion, revision, providers: { github: {
 * apiBase, rawBase, downloadBase } } }, where apiBase is a GENERIC
 * api.github.com mirror (e.g. "https://ghmirror.icoco.site/gh-api/"). NOTE:
 * upstreams.json carries NO per-component version/tag, so we only read
 * providers.github.apiBase and still call `/repos/.../releases/latest` against
 * it. Fails soft (returns null) on any error, missing apiBase, or an untrusted
 * host so discovery is never made more fragile than the hardcoded path was.
 */
async function deriveBaseFromUpstreams(configUrl, fetchFn) {
  const trusted = parseTrustHosts();
  // Env-poisoning guard: never even fetch the config from a host that is not in
  // the trust list. With no trust list we cannot vouch for any host, so we skip
  // the derive path entirely and fall back to the default.
  if (!isTrustedHost(configUrl, trusted)) {
    warn(`ZYLOS_UPSTREAM_CONFIG host not in ZYLOS_UPSTREAM_TRUST_HOSTS — ignoring, using default base`);
    return null;
  }
  try {
    const res = await fetchFn(configUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`upstreams.json HTTP ${res.status}`);
    const data = await res.json();
    const apiBase = data?.providers?.github?.apiBase;
    if (!apiBase || typeof apiBase !== 'string') {
      warn('upstreams.json has no providers.github.apiBase — using default base');
      return null;
    }
    // The derived host must also be trusted — the config could be legitimate
    // but point apiBase at an arbitrary (malicious) host.
    if (!isTrustedHost(apiBase, trusted)) {
      warn(`derived providers.github.apiBase host not in ZYLOS_UPSTREAM_TRUST_HOSTS — using default base`);
      return null;
    }
    return apiBase;
  } catch (e) {
    warn(`could not derive base from ZYLOS_UPSTREAM_CONFIG: ${e.message} — using default base`);
    return null;
  }
}

/**
 * Issue #146 — resolve the releases-latest URL for self-upgrade discovery.
 *
 * CN / behind-the-GFW agents cannot reach api.github.com, so the previously
 * hardcoded GET timed out (15s) and self-upgrade never advanced to the install
 * step (`zylos upgrade openmax`, which already goes through the ghmirror and
 * works). This makes the REST base configurable while keeping the default
 * (non-CN) behavior byte-for-byte identical.
 *
 * Precedence (highest → lowest):
 *   1. OPENMAX_RELEASES_URL  — a full releases-latest URL, used verbatim
 *                              (zero-dependency escape hatch; no extra fetch).
 *   2. GITHUB_API_BASE       — a base URL; append repos/<repo>/releases/latest.
 *   3. ZYLOS_UPSTREAM_CONFIG — points at an upstreams.json (injected & trusted
 *                              by catalog, same channel zylos-core uses); read
 *                              providers.github.apiBase as the base. Gated by
 *                              ZYLOS_UPSTREAM_TRUST_HOSTS.
 *   4. Default               — https://api.github.com (unchanged).
 *
 * Every layer fails soft: a missing/untrusted/malformed value falls through to
 * the next, so discovery failure can never crash the upgrade timer.
 */
export async function resolveReleasesUrl(deps = {}) {
  const fetchFn = deps.fetchFn || fetch;

  // 1. Full-URL escape hatch (highest priority). Strictly validated: a
  //    malformed / non-https / credential-bearing value FAILS SOFT and falls
  //    through to the next source. A single typo here must never permanently
  //    cut off the valid lower-priority sources or return an unvalidated URL.
  const explicitUrl = process.env.OPENMAX_RELEASES_URL;
  if (explicitUrl) {
    if (safeHttpsUrl(explicitUrl)) {
      log(`discovery base: OPENMAX_RELEASES_URL override → ${explicitUrl}`);
      return explicitUrl;
    }
    warn(`OPENMAX_RELEASES_URL is not a safe https URL (${explicitUrl}) — ignoring, trying next source`);
  }

  // 2. Base-URL escape hatch (also strictly validated; fails soft).
  const explicitBase = process.env.GITHUB_API_BASE;
  if (explicitBase) {
    const url = buildValidatedReleasesUrl(explicitBase);
    if (url) {
      log(`discovery base: GITHUB_API_BASE override → ${url}`);
      return url;
    }
    warn(`GITHUB_API_BASE is not a safe https base (${explicitBase}) — ignoring, trying next source`);
  }

  // 3. Derive from the catalog-injected upstreams.json (CN main path).
  const upstreamConfig = process.env.ZYLOS_UPSTREAM_CONFIG;
  if (upstreamConfig) {
    const derivedBase = await deriveBaseFromUpstreams(upstreamConfig, fetchFn);
    if (derivedBase) {
      const url = buildValidatedReleasesUrl(derivedBase);
      if (url) {
        log(`discovery base: derived from ZYLOS_UPSTREAM_CONFIG → ${url}`);
        return url;
      }
      warn(`derived providers.github.apiBase is not a safe https base (${derivedBase}) — using default base`);
    }
    // else fall through to the default below.
  }

  // 4. Default — unchanged for GKE / non-CN deployments.
  const url = releasesLatestUrl(DEFAULT_API_BASE);
  log(`discovery base: default api.github.com → ${url}`);
  return url;
}

export async function fetchLatestRelease(deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  // Issue #146: base is resolved (env / mirror / default) instead of hardcoded.
  const url = await resolveReleasesUrl(deps);
  const headers = { Accept: 'application/vnd.github.v3+json' };
  // Token authorization boundary: attach the GitHub token ONLY to official
  // GitHub or an explicitly-authorized https host in the trust list — never to
  // an http URL, a URL with embedded credentials, or an unauthorized host/port.
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (ghToken && shouldAttachToken(url)) headers.Authorization = `Bearer ${ghToken}`;
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  const data = await res.json();
  return {
    tag: (data.tag_name || '').replace(/^v/, ''),
    name: data.name || data.tag_name || '',
    body: data.body || '',
    url: data.html_url || '',
  };
}

// Atomic write (tmp + rename) so no reader — this service after a restart, or
// the executor — can ever observe a half-written JSON marker.
function writeMarker(data) {
  fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
  const tmp = `${MARKER_PATH}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, MARKER_PATH);
  } catch (e) {
    warn(`failed to write marker: ${e.message}`);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function recordFailedVersion(version) {
  fs.mkdirSync(path.dirname(FAILED_VERSION_PATH), { recursive: true });
  fs.writeFileSync(FAILED_VERSION_PATH, version);
}

export function getFailedVersion() {
  try {
    return fs.readFileSync(FAILED_VERSION_PATH, 'utf-8').trim();
  } catch {
    return null;
  }
}

export function clearFailedVersion() {
  try { fs.unlinkSync(FAILED_VERSION_PATH); } catch {}
}

export function readAndClearMarker() {
  try {
    const raw = fs.readFileSync(MARKER_PATH, 'utf-8');
    const data = JSON.parse(raw);
    // Don't consume 'running' markers — the executor owns them and will write
    // the terminal result. zylos upgrade restarts this service mid-upgrade, so
    // startup must not treat 'running' as terminal.
    if (data.status === 'running') return null;
    fs.unlinkSync(MARKER_PATH);
    return data;
  } catch {
    return null;
  }
}

/** Read the marker without consuming it. Returns null if absent/unreadable. */
function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(MARKER_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function sendMessage(conversationId, text) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SEND_SCRIPT, conversationId, text], { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
  });
}

export function formatUpgradeNotification(marker) {
  const lines = [];

  if (marker.completed) {
    lines.push(`OpenMax upgraded: v${marker.from} → v${marker.to}`);
    // e.g. "verification was resumed after an executor interruption"
    if (marker.detail) lines.push(marker.detail);
  } else if (marker.error) {
    lines.push(`OpenMax upgrade failed: v${marker.from} → v${marker.to}`);
    // Only state what actually happened. The executor records the true outcome
    // in marker.detail (rolled back / left on new version / never started).
    if (marker.detail) {
      lines.push(marker.detail);
    } else {
      lines.push('Automatic recovery was attempted — check upgrade-executor.log for details.');
    }
    const errSummary = marker.error.split('\n').filter(l => l.trim()).slice(0, 5).join('\n');
    if (errSummary) lines.push('', `Error: ${errSummary}`);
  } else if (marker.status === 'running') {
    lines.push(`OpenMax upgrading: v${marker.from} → v${marker.to}`);
    lines.push('Running zylos upgrade in background...');
  } else {
    lines.push(`OpenMax update available: v${marker.from} → v${marker.to}`);
    lines.push('', 'Run `zylos upgrade openmax --yes --mode overwrite` to upgrade.');
  }

  if (marker.notes && !marker.error) {
    const summary = marker.notes.split('\n').filter(l => l.trim()).slice(0, 8).join('\n');
    if (summary) lines.push('', summary);
  }
  if (marker.url) lines.push('', marker.url);
  return lines.join('\n');
}

/**
 * On startup, read the marker left by the detached upgrade executor
 * and notify owners of the outcome.
 */
export async function notifyUpgradeComplete(enabledOrgConfigs, postForOrgFn, apiPathFn) {
  const marker = readAndClearMarker();
  if (!marker) return;

  if (marker.status === 'running') {
    // readAndClearMarker now skips 'running' markers, so this is
    // unreachable. Defensive: if somehow reached, don't treat as failed.
    return;
  }

  const label = marker.completed ? 'completed' : 'failed';
  log(`upgrade ${label}: v${marker.from} → v${marker.to}, notifying owners...`);
  const text = formatUpgradeNotification(marker);

  for (const [slug, orgConfig] of enabledOrgConfigs) {
    const ownerMemberId = orgConfig.owner?.member_id;
    if (!ownerMemberId) {
      warn(`[${slug}] no owner member_id, skipping notification`);
      continue;
    }
    try {
      const res = await postForOrgFn(orgConfig.org_id,
        apiPathFn('/conversations/dm'), { peer_member_id: ownerMemberId });
      const convId = res?.conversation?.id;
      if (!convId) {
        warn(`[${slug}] could not resolve owner DM conversation`);
        continue;
      }
      await sendMessage(convId, text);
      log(`[${slug}] owner notified in conversation ${convId}`);
    } catch (e) {
      warn(`[${slug}] notification failed: ${e.message}`);
    }
  }

  if (marker.completed) {
    clearFailedVersion();
  } else {
    recordFailedVersion(marker.to);
  }
}

async function notifyOwners(text, enabledOrgConfigs, postForOrgFn, apiPathFn) {
  for (const [slug, orgConfig] of enabledOrgConfigs) {
    const ownerMemberId = orgConfig.owner?.member_id;
    if (!ownerMemberId) continue;
    try {
      const res = await postForOrgFn(orgConfig.org_id,
        apiPathFn('/conversations/dm'), { peer_member_id: ownerMemberId });
      const convId = res?.conversation?.id;
      if (!convId) continue;
      await sendMessage(convId, text);
      log(`[${slug}] owner notified of upgrade`);
    } catch (e) {
      warn(`[${slug}] notification failed: ${e.message}`);
    }
  }
}

/**
 * Async pm2 invocation (promisified execFile). Everything in this module runs
 * on the comm-bridge event loop, so pm2 calls must never block it — a hung pm2
 * daemon would otherwise freeze websocket heartbeats for the timeout duration.
 */
function pm2Exec(args, timeoutMs) {
  return execFileAsync('pm2', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Return the PM2 process record for the upgrader app, or null if it is not
 * currently registered (or pm2 is unreachable).
 */
async function getUpgraderProc(runPm2 = pm2Exec) {
  try {
    const { stdout } = await runPm2(['jlist'], 10000);
    const procs = JSON.parse(stdout.toString());
    return procs.find(p => p.name === PM2_UPGRADER) || null;
  } catch {
    return null;
  }
}

/**
 * Remove a leftover upgrader PM2 entry. The upgrader deletes itself when it
 * finishes, but if it dies before doing so a stopped/errored entry can linger
 * (with capped autorestart it ends 'errored' after max_restarts). Clearing it
 * keeps `pm2 list` clean and frees the name for the next real upgrade.
 */
async function deleteUpgraderEntry(runPm2 = pm2Exec) {
  try {
    await runPm2(['delete', PM2_UPGRADER], 15000);
    log(`removed leftover upgrader pm2 entry (${PM2_UPGRADER})`);
  } catch {
    // Not registered / already gone — nothing to do.
  }
  removeUpgraderLogs();
}

/** Remove the upgrader's pm2-captured log files so they never accumulate. */
function removeUpgraderLogs() {
  for (const f of [UPGRADER_OUT_LOG, UPGRADER_ERR_LOG]) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
}

/**
 * Surface the tail of the dead upgrader's stderr in our own log before the
 * cleanup below deletes it — for the watchdog-exhausted case where no
 * executor instance survived to capture it.
 */
function logLeftoverUpgraderErrTail(maxBytes = 2048) {
  try {
    const st = fs.statSync(UPGRADER_ERR_LOG);
    if (!st.size) return;
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(UPGRADER_ERR_LOG, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    warn(`tail of dead upgrader's stderr:\n${buf.toString('utf-8')}`);
  } catch {}
}

/**
 * Pure decision function for the pre-flight guard (exported for tests).
 *
 * @param {string|null} procStatus - pm2 status of the upgrader entry, or null
 *   if the entry does not exist.
 * @param {object|null} marker - current marker contents, or null.
 * @param {number} now - clock, injectable for tests.
 * @returns {{action: string, reason: string}} one of:
 *   'proceed'                       — no upgrade in flight, safe to check
 *   'wait'                          — treat as in flight, skip this cycle
 *   'mark-interrupted'              — no entry but a stale running marker:
 *                                     convert to failed (notifies + cooldown)
 *   'cleanup'                       — dead entry, terminal/absent marker:
 *                                     delete the entry
 *   'cleanup-and-mark-interrupted'  — dead entry + running marker: both
 */
export function classifyUpgraderState(procStatus, marker, now = Date.now()) {
  const markerRunning = marker != null && marker.status === 'running';
  const age = markerRunning ? now - (marker.ts || 0) : Infinity;

  if (!procStatus) {
    if (!markerRunning) return { action: 'proceed', reason: 'no upgrader entry, no running marker' };
    if (age < GRACE_START_MS) return { action: 'wait', reason: 'running marker is fresh; upgrader may still be starting' };
    // The upgrader vanished without writing a terminal result (pm2 daemon
    // restart / pm2 kill / manual delete). Without this branch the stuck
    // 'running' marker would linger forever and the version would be silently
    // retried with no owner notification.
    return { action: 'mark-interrupted', reason: `running marker is ${age}ms old but the upgrader entry is gone` };
  }

  if (procStatus === 'online') {
    // NEVER kill an online upgrader from here — a pm2 delete would treekill a
    // live `zylos upgrade` mid-flight and could leave the skill dir half
    // written. Its own timeouts bound how long it can stay online.
    if (markerRunning && age < STALE_RUNNING_THRESHOLD_MS) {
      return { action: 'wait', reason: 'upgrade in flight' };
    }
    if (markerRunning) return { action: 'wait', reason: 'upgrader online with stale running marker (unusually long run)' };
    return { action: 'wait', reason: 'upgrader online in its completion window' };
  }

  // stopped / errored / stopping — a dead entry.
  return markerRunning
    ? { action: 'cleanup-and-mark-interrupted', reason: `dead upgrader entry (${procStatus}) with a running marker` }
    : { action: 'cleanup', reason: `dead upgrader entry (${procStatus})` };
}

/** Convert a stuck 'running' marker into a terminal failed one (with ts). */
function markInterrupted(marker, error, detail) {
  writeMarker({
    ...marker,
    status: 'failed',
    completed: false,
    error,
    detail,
    ts: Date.now(),
  });
}

/**
 * Pre-flight guard against concurrent / stuck upgrades.
 *
 * @returns {Promise<boolean>} true if an upgrade should be treated as in
 *   progress (caller skips this cycle), false if it is safe to proceed. Side
 *   effects: clears dead upgrader entries, converts orphaned 'running' markers
 *   to failed (the subsequent notifyUpgradeComplete then DMs the owner and
 *   records the failed version), and warns—once—about an unusually long run.
 */
async function upgradeInProgress(enabledOrgConfigs, postForOrgFn, apiPathFn) {
  try {
    const proc = await getUpgraderProc();
    const marker = readMarker();
    const { action, reason } = classifyUpgraderState(proc?.pm2_env?.status ?? null, marker);

    switch (action) {
      case 'proceed':
        return false;

      case 'wait':
        log(`upgrader busy (${reason}) — skipping this cycle`);
        if (reason.includes('stale running marker') && marker && !marker.anomalyNotified) {
          // Online but past the stale threshold: don't kill it (see classify),
          // but tell the owner once so a genuinely hung upgrade is not silent.
          writeMarker({ ...marker, anomalyNotified: true });
          await notifyOwners(
            `OpenMax upgrade to v${marker.to} is taking unusually long. The upgrader is still running and will not be interrupted — check upgrade-executor.log if this persists.`,
            enabledOrgConfigs, postForOrgFn, apiPathFn,
          );
        }
        return true;

      case 'mark-interrupted':
        warn(`${reason} — marking the upgrade as failed`);
        markInterrupted(
          marker,
          'Upgrade was interrupted: the upgrader process disappeared without reporting a result (possibly a PM2 daemon restart).',
          'The upgrader vanished mid-run; openmax kept running. The target version was recorded as failed so it will not be retried.',
        );
        return false;

      case 'cleanup-and-mark-interrupted':
        warn(`${reason} — marking the upgrade as failed and removing the entry`);
        logLeftoverUpgraderErrTail();
        markInterrupted(
          marker,
          'Upgrade was interrupted: the upgrader died without reporting a result.',
          'The upgrader died mid-run; openmax kept running. The target version was recorded as failed so it will not be retried.',
        );
        await deleteUpgraderEntry();
        return false;

      case 'cleanup':
        warn(`${reason} — removing the entry`);
        await deleteUpgraderEntry();
        return false;

      default:
        return false;
    }
  } catch (e) {
    warn(`upgrade pre-flight check failed: ${e.message}`);
    // Fail open (proceed) — a broken pm2 will surface again at start time.
    return false;
  }
}

/**
 * Start the upgrade executor as its own PM2 app.
 *
 * The upgrader runs with autorestart capped at --max-restarts 3: PM2 acts as
 * its watchdog, so an executor that dies unexpectedly (OOM, manual kill) —
 * possibly with openmax stopped — is relaunched within seconds and recovers
 * via its interrupted-run path. This must not rely on our own check timer,
 * which lives inside openmax and stops ticking the moment openmax is stopped.
 * Relaunches after a terminal marker are cheap no-ops that exit immediately,
 * so max_restarts turns the entry 'errored' at worst; it is never persisted
 * (`pm2 save` is never run) and the executor deletes its own entry when done.
 *
 * @returns {Promise<boolean>} whether the executor was started.
 */
export async function startUpgraderApp(fromVersion, toVersion, notes, releaseUrl, deps = {}) {
  const runPm2 = deps.pm2Exec || pm2Exec;

  // Never touch an online upgrader (upgradeInProgress already screens for
  // this; re-check to close the race with a run that started in between).
  const existing = await getUpgraderProc(runPm2);
  if (existing?.pm2_env?.status === 'online') {
    warn('an upgrader is unexpectedly online at start time — skipping this cycle');
    return false;
  }
  if (existing) await deleteUpgraderEntry(runPm2);

  // Fresh pm2 log files for this run (previous runs' files were removed on
  // cleanup, but be defensive — never let them accumulate across runs).
  removeUpgraderLogs();

  // The marker must exist before pm2 start: the executor reads it on boot.
  writeMarker({
    from: fromVersion,
    to: toVersion,
    notes: notes || '',
    url: releaseUrl || '',
    status: 'running',
    completed: false,
    ts: Date.now(),
  });

  try {
    await runPm2([
      'start', EXECUTOR_SCRIPT,
      '--name', PM2_UPGRADER,
      '--max-restarts', '3',
      '--restart-delay', '2000',
      '--interpreter', 'node',
      // Keep pm2-captured stdio out of ~/.pm2/logs (which is never rotated
      // for on-demand apps) — point it at the runtime dir where our cleanup
      // paths remove it.
      '--output', UPGRADER_OUT_LOG,
      '--error', UPGRADER_ERR_LOG,
      '--', MARKER_PATH,
    ], 30000);
    log(`started upgrade executor as pm2 app ${PM2_UPGRADER}`);
    return true;
  } catch (e) {
    warn(`failed to start upgrader pm2 app: ${e.stderr?.toString() || e.message}`);
    // Record the failure instead of just unlinking the marker: the caller
    // flushes this through notifyUpgradeComplete, which DMs the owner and
    // records the failed version — no silent "upgrading..." spam every cycle.
    writeMarker({
      from: fromVersion,
      to: toVersion,
      notes: notes || '',
      url: releaseUrl || '',
      status: 'failed',
      completed: false,
      error: `Could not start the upgrader pm2 app: ${e.message}`,
      detail: 'The upgrade never started — the running service was not touched.',
      ts: Date.now(),
    });
    await deleteUpgraderEntry(runPm2);
    return false;
  }
}

export async function checkForUpdates(enabledOrgConfigs, postForOrgFn, apiPathFn) {
  // Guard against concurrent upgrades and clear any zombie upgrader left behind
  // by a crashed previous run (which also converts a stuck marker to failed).
  if (await upgradeInProgress(enabledOrgConfigs, postForOrgFn, apiPathFn)) {
    log('upgrade in progress, skipping check');
    return;
  }

  // The executor may have written a terminal marker after the post-restart
  // startup already ran notifyUpgradeComplete. Pick it up here.
  await notifyUpgradeComplete(enabledOrgConfigs, postForOrgFn, apiPathFn);

  const current = readPkgVersion();
  log(`checking for updates (current: v${current})...`);
  try {
    const latest = await fetchLatestRelease();
    if (!latest.tag) {
      warn('no release tag found');
      return;
    }
    if (compareSemver(current, latest.tag) >= 0) {
      log(`up to date (latest: v${latest.tag})`);
      return;
    }

    const failedVersion = getFailedVersion();
    if (failedVersion && failedVersion === latest.tag) {
      log(`v${latest.tag} was already attempted and failed — skipping until a newer release`);
      return;
    }
    clearFailedVersion();

    log(`new version available: v${current} → v${latest.tag}, starting upgrade...`);

    const started = await startUpgraderApp(current, latest.tag, latest.body, latest.url);
    if (started) {
      // Only announce "upgrading..." once the upgrader is actually running.
      const notifyText = formatUpgradeNotification({
        from: current, to: latest.tag, notes: latest.body, url: latest.url, status: 'running',
      });
      await notifyOwners(notifyText, enabledOrgConfigs, postForOrgFn, apiPathFn);
    } else {
      // startUpgraderApp left a terminal failed marker — flush it now so the
      // owner hears about the failure and the version enters cooldown.
      await notifyUpgradeComplete(enabledOrgConfigs, postForOrgFn, apiPathFn);
    }
  } catch (e) {
    warn(`check failed: ${e.message}`);
  }
}
