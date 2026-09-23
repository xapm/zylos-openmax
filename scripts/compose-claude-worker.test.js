import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./compose-claude-worker.js', import.meta.url));

async function runWorker(t, source, { pauseOutput = false, signalOnReady, delayWrites = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'compose-worker-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (source !== null) {
    await writeFile(join(dir, 'claude'), `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  }
  const args = [worker];
  if (delayWrites) {
    const preload = join(dir, 'delay-stdout.mjs');
    await writeFile(preload, `const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => { setTimeout(() => write(...args), 200); return false; };`);
    args.unshift('--import', preload);
  }
  const child = spawn(process.execPath, args, {
    env: { ...process.env, PATH: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  let signalled = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (signalOnReady && !signalled && stdout.includes('ready')) {
      signalled = true;
      child.kill(signalOnReady);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  if (pauseOutput) {
    child.stdout.pause();
    const timer = setTimeout(() => child.stdout.resume(), 150);
    t.after(() => clearTimeout(timer));
  }
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ schema_version: 1, content: 'Draft only' }));
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return result;
}

// Transfer coverage only; the delayed-write test below guards premature exit.
test('compose worker transfers 512 KiB JSON under stdout backpressure', { timeout: 10000 }, async t => {
  const size = 512 * 1024;
  const result = await runWorker(t, `process.stdin.resume(); process.stdout.write(JSON.stringify({kind:'clarification',message:'x'.repeat(${size})}));`, { pauseOutput: true });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout), { kind: 'clarification', message: 'x'.repeat(size) });
  assert.equal(result.stderr, '');
});

test('compose worker waits for pending stdout writes after child closes', { timeout: 10000 }, async t => {
  const expected = { kind: 'clarification', message: 'Pending output must survive child close' };
  const result = await runWorker(t, `process.stdin.resume(); process.stdout.write(${JSON.stringify(JSON.stringify(expected))});`, { delayWrites: true });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, JSON.stringify(expected));
});

test('compose worker fails cleanly when claude cannot spawn', { timeout: 10000 }, async t => {
  const result = await runWorker(t, null);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('compose worker preserves nonzero child status without leaking stderr', { timeout: 10000 }, async t => {
  const result = await runWorker(t, `process.stdin.resume(); process.stderr.write('private diagnostic'); process.exitCode=23;`);
  assert.equal(result.code, 23);
  assert.equal(result.stderr, '');
});

test('compose worker treats a signalled child as failure', { timeout: 10000 }, async t => {
  const result = await runWorker(t, `process.kill(process.pid,'SIGTERM');`);
  assert.equal(result.code, 143);
});

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`compose worker forwards ${signal} and retains interrupted status`, { timeout: 10000 }, async t => {
    const result = await runWorker(t, `process.stdin.resume(); process.on('${signal}',()=>process.exit(0)); process.stdout.write('ready'); setInterval(()=>{},1000);`, { signalOnReady: signal });
    assert.equal(result.code, code);
    assert.equal(result.signal, null);
  });
}
