import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-upgrade-test-'));
const runtimeDir = path.join(tmpDir, 'zylos/components/openmax/runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
const MARKER_PATH = path.join(runtimeDir, 'upgrade-marker.json');
const FAILED_VERSION_PATH = path.join(runtimeDir, 'upgrade-failed-version');

const originalHome = process.env.HOME;
process.env.HOME = tmpDir;
const mod = await import(`./auto-upgrade.js?test=${process.pid}`);
process.env.HOME = originalHome;

const {
  readAndClearMarker,
  resolveAutoUpgradeSchedule,
  formatUpgradeNotification,
  getFailedVersion,
  clearFailedVersion,
  recordFailedVersion,
  classifyUpgraderState,
  startUpgraderApp,
  resolveReleasesUrl,
  fetchLatestRelease,
  shouldAttachToken,
  parseTrustHosts,
  GRACE_START_MS,
  STALE_RUNNING_THRESHOLD_MS,
} = mod;

function writeMarker(data) {
  fs.writeFileSync(MARKER_PATH, JSON.stringify(data, null, 2));
}

afterEach(() => {
  try { fs.unlinkSync(MARKER_PATH); } catch {}
  try { fs.unlinkSync(FAILED_VERSION_PATH); } catch {}
});

describe('resolveAutoUpgradeSchedule', () => {
  it('defaults scheduled auto-upgrade to disabled', () => {
    assert.deepEqual(resolveAutoUpgradeSchedule(undefined), { enabled: false });
    assert.deepEqual(resolveAutoUpgradeSchedule({}), { enabled: false });
  });

  it('requires explicit enabled=true', () => {
    assert.deepEqual(resolveAutoUpgradeSchedule({ enabled: false }), { enabled: false });
    assert.deepEqual(resolveAutoUpgradeSchedule({ enabled: 'true' }), { enabled: false });
  });

  it('does not run a check on process start when enabled', () => {
    assert.deepEqual(resolveAutoUpgradeSchedule({ enabled: true }), {
      enabled: true,
      intervalHours: 24,
      intervalMs: 24 * 3600_000,
      delay: 0,
      runOnStart: false,
    });
  });

  it('keeps intervalHours configurable for explicit opt-in', () => {
    assert.deepEqual(resolveAutoUpgradeSchedule({ enabled: true, intervalHours: 6 }), {
      enabled: true,
      intervalHours: 6,
      intervalMs: 6 * 3600_000,
      delay: 0,
      runOnStart: false,
    });
  });
});

describe('readAndClearMarker race-condition fix', () => {
  it('skips running markers (leaves file intact for executor)', () => {
    writeMarker({ status: 'running', from: '2.4.3', to: '2.5.0', ts: Date.now() });
    const result = readAndClearMarker();
    assert.equal(result, null, 'should return null for running markers');
    assert.ok(fs.existsSync(MARKER_PATH), 'marker file should still exist');
  });

  it('consumes completed markers', () => {
    writeMarker({ status: 'completed', completed: true, from: '2.4.3', to: '2.5.0' });
    const result = readAndClearMarker();
    assert.equal(result.status, 'completed');
    assert.equal(result.completed, true);
    assert.ok(!fs.existsSync(MARKER_PATH), 'marker file should be deleted');
  });

  it('consumes failed markers', () => {
    writeMarker({ status: 'failed', completed: false, error: 'timeout', from: '2.4.3', to: '2.5.0' });
    const result = readAndClearMarker();
    assert.equal(result.status, 'failed');
    assert.equal(result.completed, false);
    assert.ok(!fs.existsSync(MARKER_PATH), 'marker file should be deleted');
  });

  it('returns null when no marker exists', () => {
    const result = readAndClearMarker();
    assert.equal(result, null);
  });
});

describe('failed version cooldown', () => {
  it('getFailedVersion returns null when no record exists', () => {
    assert.equal(getFailedVersion(), null);
  });

  it('recordFailedVersion writes and getFailedVersion reads it back', () => {
    recordFailedVersion('2.5.0');
    assert.equal(getFailedVersion(), '2.5.0');
  });

  it('clearFailedVersion removes the record', () => {
    recordFailedVersion('2.5.0');
    clearFailedVersion();
    assert.equal(getFailedVersion(), null);
  });

  it('clearFailedVersion is safe when no record exists', () => {
    assert.doesNotThrow(() => clearFailedVersion());
  });

  it('recordFailedVersion overwrites a previous record', () => {
    recordFailedVersion('2.5.0');
    recordFailedVersion('2.6.0');
    assert.equal(getFailedVersion(), '2.6.0');
  });
});

describe('formatUpgradeNotification', () => {
  it('formats success notification', () => {
    const text = formatUpgradeNotification({ completed: true, from: '2.4.3', to: '2.5.0', url: 'https://example.com' });
    assert.ok(text.includes('upgraded'));
    assert.ok(text.includes('2.4.3'));
    assert.ok(text.includes('2.5.0'));
  });

  it('formats failure notification with error', () => {
    const text = formatUpgradeNotification({ completed: false, error: 'timeout', from: '2.4.3', to: '2.5.0' });
    assert.ok(text.includes('failed'));
    assert.ok(text.includes('timeout'));
  });

  it('does not claim a rollback that did not happen', () => {
    const text = formatUpgradeNotification({ completed: false, error: 'boom', from: '2.4.3', to: '2.5.0' });
    assert.ok(!text.includes('Rolled back'), 'must not hardcode a rollback claim');
  });

  it('uses the executor-provided detail line when present', () => {
    const text = formatUpgradeNotification({
      completed: false, error: 'crash-loop', from: '2.4.3', to: '2.5.0',
      detail: 'rolled back to v2.4.3 and the service is running again.',
    });
    assert.ok(text.includes('rolled back to v2.4.3'));
  });
});

describe('classifyUpgraderState (pre-flight decision logic)', () => {
  const NOW = 100 * 60 * 1000; // arbitrary fixed clock

  it('no entry + no marker → proceed', () => {
    assert.equal(classifyUpgraderState(null, null, NOW).action, 'proceed');
  });

  it('no entry + terminal marker → proceed', () => {
    assert.equal(classifyUpgraderState(null, { status: 'completed' }, NOW).action, 'proceed');
    assert.equal(classifyUpgraderState(null, { status: 'failed' }, NOW).action, 'proceed');
  });

  it('no entry + fresh running marker (within grace) → wait (upgrader may be starting)', () => {
    const marker = { status: 'running', ts: NOW - (GRACE_START_MS - 1000) };
    assert.equal(classifyUpgraderState(null, marker, NOW).action, 'wait');
  });

  it('no entry + running marker past grace → mark-interrupted (F1: stuck marker must not linger)', () => {
    const marker = { status: 'running', ts: NOW - (GRACE_START_MS + 1000) };
    assert.equal(classifyUpgraderState(null, marker, NOW).action, 'mark-interrupted');
  });

  it('online entry + fresh running marker → wait (in flight)', () => {
    const marker = { status: 'running', ts: NOW - 60 * 1000 };
    assert.equal(classifyUpgraderState('online', marker, NOW).action, 'wait');
  });

  it('online entry + stale running marker → wait, never a delete (F5: no killing live upgraders)', () => {
    const marker = { status: 'running', ts: NOW - (STALE_RUNNING_THRESHOLD_MS + 1000) };
    const res = classifyUpgraderState('online', marker, NOW);
    assert.equal(res.action, 'wait');
    assert.ok(res.reason.includes('stale running marker'));
  });

  it('online entry + terminal marker → wait (completion window, executor self-deletes)', () => {
    assert.equal(classifyUpgraderState('online', { status: 'completed' }, NOW).action, 'wait');
  });

  it('dead entry + running marker → cleanup-and-mark-interrupted', () => {
    const marker = { status: 'running', ts: NOW - 60 * 1000 };
    assert.equal(classifyUpgraderState('stopped', marker, NOW).action, 'cleanup-and-mark-interrupted');
    assert.equal(classifyUpgraderState('errored', marker, NOW).action, 'cleanup-and-mark-interrupted');
  });

  it('dead entry + terminal/absent marker → cleanup', () => {
    assert.equal(classifyUpgraderState('errored', null, NOW).action, 'cleanup');
    assert.equal(classifyUpgraderState('stopped', { status: 'failed' }, NOW).action, 'cleanup');
  });
});

describe('startUpgraderApp', () => {
  const noUpgrader = async (args) => {
    if (args[0] === 'jlist') return { stdout: '[]' };
    return { stdout: '' };
  };

  it('success: leaves a running marker and returns true', async () => {
    const ok = await startUpgraderApp('2.5.1', '2.6.0', 'notes', 'https://x', { pm2Exec: noUpgrader });
    assert.equal(ok, true);
    const m = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf-8'));
    assert.equal(m.status, 'running');
    assert.equal(m.from, '2.5.1');
    assert.equal(m.to, '2.6.0');
    assert.equal(typeof m.ts, 'number');
  });

  it('start failure: records a failed marker with ts + error instead of unlinking (F7)', async () => {
    const failingStart = async (args) => {
      if (args[0] === 'jlist') return { stdout: '[]' };
      if (args[0] === 'start') throw new Error('pm2 daemon unreachable');
      return { stdout: '' };
    };
    const before = Date.now();
    const ok = await startUpgraderApp('2.5.1', '2.6.0', '', '', { pm2Exec: failingStart });
    assert.equal(ok, false);
    const m = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf-8'));
    assert.equal(m.status, 'failed');
    assert.equal(m.completed, false);
    assert.ok(m.error.includes('pm2 daemon unreachable'));
    assert.ok(m.detail.includes('never started'));
    assert.ok(m.ts >= before, 'failed marker must carry a fresh ts (F9)');
  });

  it('points pm2 stdio logs at the runtime dir and clears stale ones (no ~/.pm2/logs accumulation)', async () => {
    const staleOut = path.join(runtimeDir, 'upgrader-out.log');
    const staleErr = path.join(runtimeDir, 'upgrader-err.log');
    fs.writeFileSync(staleOut, 'old output from a previous run\n');
    fs.writeFileSync(staleErr, 'old errors from a previous run\n');

    let startArgs = null;
    const capturing = async (args) => {
      if (args[0] === 'jlist') return { stdout: '[]' };
      if (args[0] === 'start') startArgs = args;
      return { stdout: '' };
    };
    const ok = await startUpgraderApp('2.5.1', '2.6.0', '', '', { pm2Exec: capturing });
    assert.equal(ok, true);

    const outIdx = startArgs.indexOf('--output');
    const errIdx = startArgs.indexOf('--error');
    assert.ok(outIdx !== -1 && errIdx !== -1, 'must pass --output/--error to pm2 start');
    assert.equal(startArgs[outIdx + 1], staleOut);
    assert.equal(startArgs[errIdx + 1], staleErr);

    assert.ok(!fs.existsSync(staleOut), 'stale out log must be removed before a fresh run');
    assert.ok(!fs.existsSync(staleErr), 'stale err log must be removed before a fresh run');
  });

  it('refuses to start while an upgrader is online (never touches it)', async () => {
    const calls = [];
    const onlineUpgrader = async (args) => {
      calls.push(args[0]);
      if (args[0] === 'jlist') {
        return { stdout: JSON.stringify([{ name: 'zylos-openmax-upgrader', pm2_env: { status: 'online' } }]) };
      }
      return { stdout: '' };
    };
    const ok = await startUpgraderApp('2.5.1', '2.6.0', '', '', { pm2Exec: onlineUpgrader });
    assert.equal(ok, false);
    assert.ok(!calls.includes('delete'), 'must not delete an online upgrader');
    assert.ok(!calls.includes('start'), 'must not start a second upgrader');
    assert.ok(!fs.existsSync(MARKER_PATH), 'must not overwrite the marker');
  });
});

// Issue #146: self-upgrade discovery base must be configurable (CN / behind-GFW
// agents cannot reach api.github.com) while the default stays unchanged.
describe('release discovery base resolution (issue #146)', () => {
  const DISCOVERY_ENVS = [
    'OPENMAX_RELEASES_URL',
    'GITHUB_API_BASE',
    'ZYLOS_UPSTREAM_CONFIG',
    'ZYLOS_UPSTREAM_TRUST_HOSTS',
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ];
  const DEFAULT_URL = 'https://api.github.com/repos/zylos-ai/zylos-openmax/releases/latest';
  let savedEnv;

  beforeEach(() => {
    savedEnv = {};
    for (const k of DISCOVERY_ENVS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of DISCOVERY_ENVS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  // Build a mock fetch that answers per-URL and records every call.
  function makeFetch(routes) {
    const calls = [];
    const fetchFn = async (url, options) => {
      calls.push({ url, options });
      const route = routes[url];
      if (!route) throw new Error(`unexpected fetch: ${url}`);
      return {
        ok: route.ok !== false,
        status: route.status || 200,
        statusText: route.statusText || 'OK',
        json: async () => {
          if (route.throwOnJson) throw new SyntaxError('Unexpected token in JSON');
          return route.body;
        },
      };
    };
    fetchFn.calls = calls;
    return fetchFn;
  }

  describe('resolveReleasesUrl precedence', () => {
    it('defaults to api.github.com when no env is set', async () => {
      const url = await resolveReleasesUrl({ fetchFn: makeFetch({}) });
      assert.equal(url, DEFAULT_URL);
    });

    it('uses OPENMAX_RELEASES_URL verbatim (full-URL escape hatch)', async () => {
      process.env.OPENMAX_RELEASES_URL = 'https://mirror.example/custom/releases/latest';
      const url = await resolveReleasesUrl({ fetchFn: makeFetch({}) });
      assert.equal(url, 'https://mirror.example/custom/releases/latest');
    });

    it('builds from GITHUB_API_BASE and normalizes a trailing slash', async () => {
      process.env.GITHUB_API_BASE = 'https://ghproxy.example/gh-api/';
      const url = await resolveReleasesUrl({ fetchFn: makeFetch({}) });
      assert.equal(url, 'https://ghproxy.example/gh-api/repos/zylos-ai/zylos-openmax/releases/latest');
    });

    it('builds from GITHUB_API_BASE with no trailing slash', async () => {
      process.env.GITHUB_API_BASE = 'https://ghproxy.example';
      const url = await resolveReleasesUrl({ fetchFn: makeFetch({}) });
      assert.equal(url, 'https://ghproxy.example/repos/zylos-ai/zylos-openmax/releases/latest');
    });

    it('derives providers.github.apiBase from a trusted ZYLOS_UPSTREAM_CONFIG', async () => {
      const configUrl = 'https://ghmirror.icoco.site/upstreams.json';
      process.env.ZYLOS_UPSTREAM_CONFIG = configUrl;
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'ghmirror.icoco.site';
      const fetchFn = makeFetch({
        [configUrl]: { body: { providers: { github: { apiBase: 'https://ghmirror.icoco.site/gh-api/' } } } },
      });
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, 'https://ghmirror.icoco.site/gh-api/repos/zylos-ai/zylos-openmax/releases/latest');
      assert.equal(fetchFn.calls.length, 1, 'derive path fetches upstreams.json once');
      assert.equal(fetchFn.calls[0].url, configUrl);
    });

    it('OPENMAX_RELEASES_URL wins over GITHUB_API_BASE and ZYLOS_UPSTREAM_CONFIG', async () => {
      process.env.OPENMAX_RELEASES_URL = 'https://verbatim.example/releases/latest';
      process.env.GITHUB_API_BASE = 'https://base.example';
      process.env.ZYLOS_UPSTREAM_CONFIG = 'https://ghmirror.icoco.site/upstreams.json';
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'ghmirror.icoco.site';
      const fetchFn = makeFetch({});
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, 'https://verbatim.example/releases/latest');
      assert.equal(fetchFn.calls.length, 0, 'escape hatch must not fetch upstreams.json');
    });

    it('GITHUB_API_BASE wins over ZYLOS_UPSTREAM_CONFIG', async () => {
      process.env.GITHUB_API_BASE = 'https://base.example';
      process.env.ZYLOS_UPSTREAM_CONFIG = 'https://ghmirror.icoco.site/upstreams.json';
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'ghmirror.icoco.site';
      const fetchFn = makeFetch({});
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, 'https://base.example/repos/zylos-ai/zylos-openmax/releases/latest');
      assert.equal(fetchFn.calls.length, 0);
    });
  });

  describe('resolveReleasesUrl graceful fallback (never throws)', () => {
    const configUrl = 'https://ghmirror.icoco.site/upstreams.json';

    it('falls back to default when upstreams.json fetch is not ok', async () => {
      process.env.ZYLOS_UPSTREAM_CONFIG = configUrl;
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'ghmirror.icoco.site';
      const fetchFn = makeFetch({ [configUrl]: { ok: false, status: 503, statusText: 'Service Unavailable' } });
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, DEFAULT_URL);
    });

    it('falls back to default when upstreams.json is malformed (json throws)', async () => {
      process.env.ZYLOS_UPSTREAM_CONFIG = configUrl;
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'ghmirror.icoco.site';
      const fetchFn = makeFetch({ [configUrl]: { throwOnJson: true } });
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, DEFAULT_URL);
    });

    it('falls back to default when providers.github.apiBase is missing', async () => {
      process.env.ZYLOS_UPSTREAM_CONFIG = configUrl;
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'ghmirror.icoco.site';
      const fetchFn = makeFetch({ [configUrl]: { body: { providers: { github: {} } } } });
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, DEFAULT_URL);
    });

    it('falls back to default when the upstream fetch rejects (unreachable)', async () => {
      process.env.ZYLOS_UPSTREAM_CONFIG = configUrl;
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'ghmirror.icoco.site';
      const fetchFn = async () => { throw new Error('ECONNREFUSED'); };
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, DEFAULT_URL);
    });

    it('does not fetch and falls back when the config host is not trusted', async () => {
      process.env.ZYLOS_UPSTREAM_CONFIG = 'https://evil.example/upstreams.json';
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'ghmirror.icoco.site';
      const fetchFn = makeFetch({});
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, DEFAULT_URL);
      assert.equal(fetchFn.calls.length, 0, 'must not fetch upstreams.json from an untrusted host');
    });

    it('falls back when the derived apiBase host is not trusted (env poisoning guard)', async () => {
      process.env.ZYLOS_UPSTREAM_CONFIG = configUrl;
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'ghmirror.icoco.site';
      const fetchFn = makeFetch({
        [configUrl]: { body: { providers: { github: { apiBase: 'https://evil.example/gh-api/' } } } },
      });
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, DEFAULT_URL);
    });

    it('falls back when ZYLOS_UPSTREAM_CONFIG is set but no trust list exists', async () => {
      process.env.ZYLOS_UPSTREAM_CONFIG = configUrl;
      // No ZYLOS_UPSTREAM_TRUST_HOSTS: nothing can be vouched for → default.
      const fetchFn = makeFetch({});
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, DEFAULT_URL);
      assert.equal(fetchFn.calls.length, 0);
    });
  });

  describe('fetchLatestRelease', () => {
    it('GETs the default URL and parses the release (no env set)', async () => {
      const fetchFn = makeFetch({
        [DEFAULT_URL]: { body: { tag_name: 'v2.20.0', name: 'v2.20.0', body: 'notes', html_url: 'https://gh/rel' } },
      });
      const rel = await fetchLatestRelease({ fetchFn });
      assert.equal(fetchFn.calls.length, 1);
      assert.equal(fetchFn.calls[0].url, DEFAULT_URL);
      assert.equal(rel.tag, '2.20.0');
      assert.equal(rel.name, 'v2.20.0');
      assert.equal(rel.url, 'https://gh/rel');
    });

    it('attaches the GITHUB_TOKEN bearer header to the release GET', async () => {
      process.env.GITHUB_TOKEN = 'secret-token';
      const fetchFn = makeFetch({ [DEFAULT_URL]: { body: { tag_name: 'v2.20.0' } } });
      await fetchLatestRelease({ fetchFn });
      assert.equal(fetchFn.calls[0].options.headers.Authorization, 'Bearer secret-token');
    });

    it('honors GH_TOKEN when GITHUB_TOKEN is absent', async () => {
      process.env.GH_TOKEN = 'gh-token';
      const fetchFn = makeFetch({ [DEFAULT_URL]: { body: { tag_name: 'v2.20.0' } } });
      await fetchLatestRelease({ fetchFn });
      assert.equal(fetchFn.calls[0].options.headers.Authorization, 'Bearer gh-token');
    });

    it('GETs the mirror URL derived from a trusted ZYLOS_UPSTREAM_CONFIG', async () => {
      const configUrl = 'https://ghmirror.icoco.site/upstreams.json';
      const mirrorRelease = 'https://ghmirror.icoco.site/gh-api/repos/zylos-ai/zylos-openmax/releases/latest';
      process.env.ZYLOS_UPSTREAM_CONFIG = configUrl;
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'ghmirror.icoco.site';
      const fetchFn = makeFetch({
        [configUrl]: { body: { providers: { github: { apiBase: 'https://ghmirror.icoco.site/gh-api/' } } } },
        [mirrorRelease]: { body: { tag_name: 'v2.20.0' } },
      });
      const rel = await fetchLatestRelease({ fetchFn });
      assert.equal(rel.tag, '2.20.0');
      const urls = fetchFn.calls.map((c) => c.url);
      assert.deepEqual(urls, [configUrl, mirrorRelease]);
    });

    it('throws on a non-ok release response (kept non-fatal by the caller)', async () => {
      const fetchFn = makeFetch({ [DEFAULT_URL]: { ok: false, status: 404, statusText: 'Not Found' } });
      await assert.rejects(() => fetchLatestRelease({ fetchFn }), /GitHub API 404/);
    });
  });
});

// Issue #146 review hardening — P1 (token authorization boundary) and P2
// (a malformed high-priority override must fail SOFT, falling through to the
// next source, never hard-failing discovery or returning an unvalidated URL).
describe('discovery trust/URL hardening (review P1/P2)', () => {
  const ENVS = [
    'OPENMAX_RELEASES_URL',
    'GITHUB_API_BASE',
    'ZYLOS_UPSTREAM_CONFIG',
    'ZYLOS_UPSTREAM_TRUST_HOSTS',
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ];
  const DEFAULT_URL = 'https://api.github.com/repos/zylos-ai/zylos-openmax/releases/latest';
  let savedEnv;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENVS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENVS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  function makeFetch(routes) {
    const calls = [];
    const fetchFn = async (url, options) => {
      calls.push({ url, options });
      const route = routes[url];
      if (!route) throw new Error(`unexpected fetch: ${url}`);
      return {
        ok: route.ok !== false,
        status: route.status || 200,
        statusText: route.statusText || 'OK',
        json: async () => route.body,
      };
    };
    fetchFn.calls = calls;
    return fetchFn;
  }

  describe('P1 — parseTrustHosts is strict comma-separated', () => {
    it('(c) does NOT accept whitespace-separated items (no silent authorization)', () => {
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'mirror.example other.example';
      const set = parseTrustHosts();
      assert.ok(!set.has('mirror.example'), 'a whitespace-separated token must not be trusted');
      assert.ok(!set.has('other.example'));
      assert.equal(set.size, 0, 'a single space-containing token is malformed → nothing trusted');
    });

    it('(c) skips empty items and keeps only valid comma-separated host[:port] tokens', () => {
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'mirror.example,, ,other.example:8443,';
      const set = parseTrustHosts();
      assert.deepEqual([...set].sort(), ['mirror.example', 'other.example:8443']);
      assert.ok(!set.has(''), 'empty items must never enter the set');
    });
  });

  describe('P1 — shouldAttachToken authorization boundary', () => {
    it('attaches to official api.github.com', () => {
      assert.equal(shouldAttachToken(DEFAULT_URL), true);
    });

    it('(a) never attaches to an http:// mirror, even a trusted host', () => {
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'mirror.example';
      assert.equal(shouldAttachToken('http://mirror.example/gh-api/x'), false);
    });

    it('(b) attaches to a trusted https host but NOT to a port-mismatched one', () => {
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'mirror.example';
      assert.equal(shouldAttachToken('https://mirror.example/gh-api/x'), true, 'exact host is trusted');
      assert.equal(shouldAttachToken('https://mirror.example:4444/gh-api/x'), false, 'a port must not match a bare-host entry');
    });

    it('(d) never attaches to a URL carrying embedded credentials', () => {
      assert.equal(shouldAttachToken('https://user:pass@api.github.com/x'), false);
    });

    it('does not attach to an untrusted https host', () => {
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'mirror.example';
      assert.equal(shouldAttachToken('https://evil.example/x'), false);
    });
  });

  describe('P1 — fetchLatestRelease end-to-end token boundary', () => {
    it('(e) an http OPENMAX_RELEASES_URL is never fetched (falls through) and gets no token', async () => {
      const httpMirror = 'http://mirror.example/gh-api/repos/zylos-ai/zylos-openmax/releases/latest';
      process.env.OPENMAX_RELEASES_URL = httpMirror;
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'mirror.example';
      process.env.GITHUB_TOKEN = 'secret-token';
      const fetchFn = makeFetch({ [DEFAULT_URL]: { body: { tag_name: 'v2.20.0' } } });
      const rel = await fetchLatestRelease({ fetchFn });
      assert.equal(rel.tag, '2.20.0');
      const urls = fetchFn.calls.map((c) => c.url);
      assert.ok(!urls.includes(httpMirror), 'the http mirror must never be contacted');
      assert.deepEqual(urls, [DEFAULT_URL], 'discovery fell through to the default');
      assert.equal(fetchFn.calls[0].options.headers.Authorization, 'Bearer secret-token',
        'the default (official) target still carries the token — invariant preserved');
    });

    it('attaches the token to a trusted https mirror derived from upstreams (positive control)', async () => {
      const configUrl = 'https://ghmirror.icoco.site/upstreams.json';
      const mirrorRelease = 'https://ghmirror.icoco.site/gh-api/repos/zylos-ai/zylos-openmax/releases/latest';
      process.env.ZYLOS_UPSTREAM_CONFIG = configUrl;
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'ghmirror.icoco.site';
      process.env.GITHUB_TOKEN = 'secret-token';
      const fetchFn = makeFetch({
        [configUrl]: { body: { providers: { github: { apiBase: 'https://ghmirror.icoco.site/gh-api/' } } } },
        [mirrorRelease]: { body: { tag_name: 'v2.20.0' } },
      });
      await fetchLatestRelease({ fetchFn });
      const mirrorCall = fetchFn.calls.find((c) => c.url === mirrorRelease);
      assert.ok(mirrorCall, 'the trusted mirror was contacted');
      assert.equal(mirrorCall.options.headers.Authorization, 'Bearer secret-token');
    });

    it('does NOT attach the token to an untrusted GITHUB_API_BASE mirror', async () => {
      const mirror = 'https://ghproxy.example/repos/zylos-ai/zylos-openmax/releases/latest';
      process.env.GITHUB_API_BASE = 'https://ghproxy.example';
      process.env.GITHUB_TOKEN = 'secret-token';
      const fetchFn = makeFetch({ [mirror]: { body: { tag_name: 'v2.20.0' } } });
      await fetchLatestRelease({ fetchFn });
      assert.equal(fetchFn.calls[0].url, mirror);
      assert.equal(fetchFn.calls[0].options.headers.Authorization, undefined,
        'a mirror not in the trust list must not receive the token');
    });
  });

  describe('P2 — malformed high-priority override fails soft (falls through)', () => {
    it('(f) malformed OPENMAX_RELEASES_URL falls through to GITHUB_API_BASE', async () => {
      process.env.OPENMAX_RELEASES_URL = 'not a url';
      process.env.GITHUB_API_BASE = 'https://base.example';
      const fetchFn = makeFetch({});
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, 'https://base.example/repos/zylos-ai/zylos-openmax/releases/latest');
    });

    it('(g) malformed GITHUB_API_BASE falls through to a trusted upstream', async () => {
      const configUrl = 'https://ghmirror.icoco.site/upstreams.json';
      process.env.GITHUB_API_BASE = '://bad';
      process.env.ZYLOS_UPSTREAM_CONFIG = configUrl;
      process.env.ZYLOS_UPSTREAM_TRUST_HOSTS = 'ghmirror.icoco.site';
      const fetchFn = makeFetch({
        [configUrl]: { body: { providers: { github: { apiBase: 'https://ghmirror.icoco.site/gh-api/' } } } },
      });
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, 'https://ghmirror.icoco.site/gh-api/repos/zylos-ai/zylos-openmax/releases/latest');
      assert.equal(fetchFn.calls.length, 1);
      assert.equal(fetchFn.calls[0].url, configUrl);
    });

    it('OPENMAX_RELEASES_URL with embedded credentials falls through, not used verbatim', async () => {
      process.env.OPENMAX_RELEASES_URL = 'https://user:pass@mirror.example/releases/latest';
      process.env.GITHUB_API_BASE = 'https://base.example';
      const fetchFn = makeFetch({});
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, 'https://base.example/repos/zylos-ai/zylos-openmax/releases/latest');
    });

    it('all overrides malformed → falls through to the default (discovery never hard-fails)', async () => {
      process.env.OPENMAX_RELEASES_URL = 'http://insecure.example/releases/latest';
      process.env.GITHUB_API_BASE = '://bad';
      const fetchFn = makeFetch({});
      const url = await resolveReleasesUrl({ fetchFn });
      assert.equal(url, DEFAULT_URL);
    });

    it('keeps the default-URL byte-identity when no env is set', async () => {
      const url = await resolveReleasesUrl({ fetchFn: makeFetch({}) });
      assert.equal(url, DEFAULT_URL);
    });
  });
});
