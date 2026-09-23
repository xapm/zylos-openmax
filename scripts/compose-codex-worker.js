#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 1024 * 1024) process.exit(1);
}
const request = JSON.parse(input);
if (request.schema_version !== 1 || typeof request.content !== 'string') process.exit(1);
const output = path.join(process.cwd(), 'result.json');
const disabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent',
  'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'view_image',
  'memories', 'skill_search', 'skill_mcp_dependency_install', 'code_mode', 'code_mode_host',
  'goals', 'remote_plugin'];
const args = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
  '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', output,
  '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
  '-c', 'developer_instructions="Draft automation configuration only. Do not perform actions. Return only the requested JSON business result. Never include routing identifiers."',
  ...disabled.flatMap(feature => ['--disable', feature]), '-'];
const child = spawn('codex', args, { shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
child.stderr.resume();
child.stdin.end(request.content);
child.on('error', () => process.exit(1));
child.on('exit', code => {
  if (code !== 0) process.exit(1);
  try { process.stdout.write(fs.readFileSync(output, 'utf8')); } catch { process.exit(1); }
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
