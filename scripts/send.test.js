import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The registry path is resolved from HOME at import time; the spawned send.js
// inherits the same HOME, so it reads the participants recorded here.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-send-test-'));
process.env.HOME = tmpHome;
const { recordParticipants } = await import('../src/lib/mention.js');

const SEND_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'send.js');
const LUNA_ID = '019f6a10-1af8-73ef-b9bb-08b28dcaa998';

function startCaptureServer() {
  const posts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.method === 'POST') posts.push({ url: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `m${posts.length}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, posts, port: server.address().port }));
  });
}

function runSend(port, endpoint, message) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SEND_JS, endpoint, message], {
      env: {
        ...process.env,
        HOME: tmpHome,
        COCO_API_URL: `http://127.0.0.1:${port}`,
        COCO_AUTH_TOKEN: 'test-token',
        COCO_ORG_ID: 'org-test',
        COCO_RPC_LOG: '0',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('send.js puts the whole-message mentions on every chunk it POSTs (#350)', async () => {
  const conv = 'conv-send-350';
  recordParticipants(conv, { name: 'luna.coco', memberId: LUNA_ID });
  const message = `@luna.coco please read\n\n${'a'.repeat(2500)}\n\n${'b'.repeat(2500)}`;

  const { server, posts, port } = await startCaptureServer();
  try {
    const { code, stderr } = await runSend(port, conv, message);
    assert.equal(code, 0, stderr);
  } finally {
    server.close();
  }

  const sends = posts.filter((p) => p.url === `/api/v1/conversations/${conv}/messages`);
  assert.ok(sends.length > 1, `expected a split message, got ${sends.length} POST(s)`);
  assert.equal(sends[1].body.content.body.text.includes('@luna.coco'), false);
  for (const { body } of sends) {
    assert.deepEqual(body.mentions, [{ type: 'member', member_id: LUNA_ID }]);
  }
});
