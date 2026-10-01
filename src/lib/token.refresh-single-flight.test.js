import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, beforeEach, after } from 'node:test';

// Hermetic: token.js derives TOKEN_DIR from HOME at import time, and resolves
// api_key / core URL from env before config.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-token-sf-'));
process.env.HOME = TMP_HOME;
process.env.COCO_API_KEY = 'cwsk_test';
process.env.COCO_API_URL = 'http://127.0.0.1:65535';
process.env.COCO_RPC_LOG = '0';

const TOKEN_DIR = path.join(TMP_HOME, 'zylos/components/openmax/runtime/tokens');
const ORG = 'org-sf';
const TOKEN_FILE = path.join(TOKEN_DIR, `${ORG}.json`);

// Two independent module instances == two processes (e.g. two detached
// channel-connect watchers): separate in-memory caches, one shared token file.
const procA = await import('./token.js?proc=a');
const procB = await import('./token.js?proc=b');

const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;

/**
 * Fake cws-core /auth/refresh with the real rotation semantics
 * (internal/app/auth/service.go rotateRefreshToken): every refresh rotates
 * the refresh_token; presenting an already-used one is reuse and revokes the
 * whole family. Exchange is counted so a fallback re-exchange is visible.
 */
function installFakeCore() {
  const server = { refreshCalls: 0, exchangeCalls: 0, reuse: 0, used: new Set(), revoked: false, gen: 0 };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    // Yield so concurrent callers genuinely interleave around the HTTP call.
    await new Promise((r) => setTimeout(r, 20));
    let status = 200;
    let payload;
    if (url.endsWith('/auth/refresh')) {
      server.refreshCalls += 1;
      if (server.revoked || server.used.has(body.refresh_token)) {
        server.reuse += 1;
        server.revoked = true;
        status = 401;
        payload = { error: { title: 'Unauthorized', detail: 'refresh token reuse' } };
      } else {
        server.used.add(body.refresh_token);
        server.gen += 1;
        payload = {
          access_token: `access-${server.gen}`,
          access_token_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          refresh_token: `refresh-${server.gen}`,
          refresh_token_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        };
      }
    } else if (url.endsWith('/auth/agent/token')) {
      server.exchangeCalls += 1;
      payload = {
        access_token: 'access-exchanged',
        access_token_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        refresh_token: 'refresh-exchanged',
        refresh_token_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      };
    } else {
      throw new Error(`unexpected fetch ${url}`);
    }
    return { ok: status < 400, status, text: async () => JSON.stringify(payload) };
  };
  return server;
}

/** Seed the shared token file with a pair whose access_token is about to expire. */
function seedExpiringPair() {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({
    access_token: 'access-0',
    access_token_expires_at: Date.now() + 10_000, // inside the 60s refresh margin
    refresh_token: 'refresh-0',
    refresh_token_expires_at: Date.now() + 86_400_000,
  }));
}

/**
 * Put the same pair into both processes' in-memory caches, then let it slide
 * into the refresh margin — the state two long-running channel watchers are in
 * when their shared access token nears expiry. No HTTP happens here.
 */
async function warmBothThenExpire() {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({
    access_token: 'access-0',
    access_token_expires_at: Date.now() + 60_000 + 150,
    refresh_token: 'refresh-0',
    refresh_token_expires_at: Date.now() + 86_400_000,
  }));
  globalThis.fetch = async () => { throw new Error('warm-up must not hit the network'); };
  assert.equal(await procA.getAccessToken(ORG), 'access-0');
  assert.equal(await procB.getAccessToken(ORG), 'access-0');
  await new Promise((r) => setTimeout(r, 250));
}

beforeEach(() => {
  procA.invalidate();
  procB.invalidate();
  fs.rmSync(TOKEN_DIR, { recursive: true, force: true });
  console.log = () => {};
  console.warn = () => {};
});

after(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.warn = realWarn;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

test('two concurrent refreshes in one process share one /auth/refresh call', async () => {
  seedExpiringPair();
  const server = installFakeCore();
  const [t1, t2] = await Promise.all([procA.refresh(ORG), procA.refresh(ORG)]);
  assert.equal(server.refreshCalls, 1);
  assert.equal(t1, 'access-1');
  assert.equal(t2, 'access-1');
});

test('two processes refreshing concurrently: one /auth/refresh, no reuse, both end with the new token', async () => {
  await warmBothThenExpire();
  const server = installFakeCore();
  const [tA, tB] = await Promise.all([procA.getAccessToken(ORG), procB.getAccessToken(ORG)]);
  assert.equal(server.refreshCalls, 1, 'exactly one refresh reaches the server');
  assert.equal(server.reuse, 0, 'no refresh-token reuse (family stays alive)');
  assert.equal(server.exchangeCalls, 0, 'no fallback re-exchange');
  assert.equal(tA, 'access-1');
  assert.equal(tB, 'access-1');
  const disk = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
  assert.equal(disk.refresh_token, 'refresh-1');
  assert.equal(fs.existsSync(`${TOKEN_FILE}.lock`), false, 'lock released');
});

test('a process with a stale in-memory pair adopts the rotated pair instead of reusing its refresh_token', async () => {
  await warmBothThenExpire();
  const server = installFakeCore();
  // Process A refreshes first and persists the rotated pair.
  assert.equal(await procA.getAccessToken(ORG), 'access-1');
  // Process B still holds refresh-0 in memory; without re-reading the shared
  // file it would send refresh-0 again — reuse, which revokes the family.
  assert.equal(await procB.getAccessToken(ORG), 'access-1');
  assert.equal(server.refreshCalls, 1);
  assert.equal(server.reuse, 0);
  assert.equal(server.exchangeCalls, 0);
});

test('a stale lock left by a crashed holder is broken', async () => {
  seedExpiringPair();
  const lock = `${TOKEN_FILE}.lock`;
  fs.writeFileSync(lock, 'dead-holder');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const server = installFakeCore();
  assert.equal(await procA.refresh(ORG), 'access-1');
  assert.equal(server.refreshCalls, 1);
  assert.equal(fs.existsSync(lock), false);
});
