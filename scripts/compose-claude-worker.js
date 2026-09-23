#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

// A fresh tool-less inference process, never the ongoing agent/DM session.
async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) {
      process.exitCode = 1;
      return;
    }
  }
  const request = JSON.parse(input);
  if (request.schema_version !== 1 || typeof request.content !== 'string') {
    process.exitCode = 1;
    return;
  }
  const child = spawn('claude', [
    '--print', '--safe-mode', '--no-session-persistence', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--output-format', 'text',
    '--system-prompt', 'Draft automation configuration only. Do not perform actions. Return only the JSON business result required by the supplied drafting instructions. Never include routing identifiers.',
  ], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let failed = false;
  let interruptedCode = 0;
  const interrupt = signal => {
    interruptedCode = 128 + constants.signals[signal];
    child.kill(signal);
  };
  const terminate = () => interrupt('SIGTERM');
  const interruptTerminal = () => interrupt('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interruptTerminal);
  child.on('error', () => { failed = true; });
  child.stdin.on('error', () => { failed = true; });
  child.stdout.on('error', () => { failed = true; child.kill('SIGTERM'); });
  const outputError = () => { failed = true; process.exitCode = 1; child.kill('SIGTERM'); };
  process.stdout.on('error', outputError);
  child.stdout.pipe(process.stdout);
  child.stderr.resume();
  child.stdin.end(request.content);
  child.on('close', (code, signal) => {
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', interruptTerminal);
    // close waits for child stdio; natural exit also drains the worker's stdout.
    const childCode = signal
      ? 128 + (constants.signals[signal] || 1)
      : Number.isInteger(code) && code >= 0 ? code : 1;
    process.exitCode = interruptedCode || childCode || (failed ? 1 : 0);
  });
}

main().catch(() => { process.exitCode = 1; });
