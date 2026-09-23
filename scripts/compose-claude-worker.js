#!/usr/bin/env node
import { spawn } from 'node:child_process';

// A fresh tool-less inference process, never the ongoing agent/DM session.
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 1024 * 1024) process.exit(1);
}
const request = JSON.parse(input);
if (request.schema_version !== 1 || typeof request.content !== 'string') process.exit(1);
const child = spawn('claude', [
  '--print', '--safe-mode', '--no-session-persistence', '--tools', '',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--disable-slash-commands', '--output-format', 'text',
  '--system-prompt', 'Draft automation configuration only. Do not perform actions. Return only the JSON business result required by the supplied drafting instructions. Never include routing identifiers.',
], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.resume();
child.stdin.end(request.content);
child.on('error', () => process.exit(1));
child.on('exit', code => process.exit(code || 0));
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
