import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./compose-codex-worker.js', import.meta.url));

async function runWorker(t, source) {
  const dir = await mkdtemp(join(tmpdir(), 'compose-codex-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (source !== null) await writeFile(join(dir, 'codex'), `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  const child = spawn(process.execPath, [worker], { cwd: dir, env: { ...process.env, PATH: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ schema_version: 1, content: 'Draft only' }));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('codex worker passes isolated flags and content and drains output file', { timeout: 10000 }, async t => {
  const source = `const fs=require('node:fs'); const args=process.argv.slice(2);
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
if(input!=='Draft only'||!['--ephemeral','--ignore-user-config','--ignore-rules','read-only'].every(a=>args.includes(a)))process.exit(7);
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({kind:'proposal',draft:{text:'x'.repeat(224*1024)}}));
process.stderr.write('private model diagnostic');});`;
  const result = await runWorker(t, source);
  assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { kind: 'proposal', draft: { text: 'x'.repeat(224 * 1024) } });
});

for (const [name, source] of [
  ['missing executable', null],
  ['nonzero exit', 'process.stdin.resume();process.exitCode=7;'],
  ['SIGKILL', "process.kill(process.pid,'SIGKILL');"],
  ['SIGTERM', "process.kill(process.pid,'SIGTERM');"],
  ['missing output file', 'process.stdin.resume();'],
]) {
  test(`codex worker fails closed on ${name}`, { timeout: 10000 }, async t => {
    const result = await runWorker(t, source);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  });
}
