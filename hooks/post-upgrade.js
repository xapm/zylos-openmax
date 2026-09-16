#!/usr/bin/env node

/**
 * Post-upgrade hook for zylos-openmax.
 *
 * Handles the v0.3 → v0.4 (multi-org) schema migration:
 *   - top-level `workspace_id`                  → DROPPED
 *   - top-level `org_id`                        → orgs.default.org_id
 *   - top-level `device_id` / `app_version`     → agent.*
 *   - top-level `client_id` (any location)      → DROPPED (dead field)
 *   - top-level `comm.*`                        → server.* (subset)
 *       comm.core_url   → server.bff_url
 *       comm.ws_url     → server.ws_url
 *       comm.reconnect_max_delay / heartbeat_interval → server.*
 *       comm.platform                           → DROPPED (dead field)
 *       comm.kb_url / comm.as_url               → DROPPED (cws-core is the
 *                                                  gateway; agent does not
 *                                                  talk to kb/as directly)
 *   - top-level `agent.identity_id` / `api_key` — preserved (still global)
 *   - new top-level `orgs.<slug>`               — wraps the legacy single-org
 *                                                 settings into `orgs.default`
 *
 * After migration the operator must:
 *   1. Verify `orgs.<slug>.self.member_id` (was not in v0.3 schema — set
 *      to the agent's member_id within this org, or run a /me probe).
 *   2. Configure `orgs.<slug>.access` (dmPolicy / groupPolicy / groups{}).
 *
 * The hook is idempotent: re-running on an already-migrated config is a no-op.
 */

import fs from 'fs';
import path from 'path';
import { ensureOpenmaxKb } from './lib/ensure-openmax-kb.js';

const HOME = process.env.HOME;
const CONFIG_PATH = path.join(HOME, 'zylos/components/openmax/config.json');

let raw = '';
try {
  raw = fs.readFileSync(CONFIG_PATH, 'utf8');
} catch (e) {
  console.error(`[post-upgrade] failed to read ${CONFIG_PATH}: ${e.message}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(raw);
} catch (e) {
  console.error(`[post-upgrade] config.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

const legacyKeysSeen = [];

// ── server.* ────────────────────────────────────────────────────────────────
if (!config.server) config.server = {};
if (config.comm) {
  const m = config.comm;
  const map = {
    bff_url: m.core_url || m.api_url,
    ws_url:  m.ws_url,
    reconnect_max_delay: m.reconnect_max_delay,
    heartbeat_interval:  m.heartbeat_interval,
    // m.platform intentionally not migrated — `server.platform` was never
    // read by runtime code; it's a dead field.
  };
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined && config.server[k] === undefined) config.server[k] = v;
  }
  if (m.kb_url !== undefined || m.as_url !== undefined) {
    legacyKeysSeen.push('comm.kb_url / comm.as_url (dropped — cws-core is the gateway)');
  }
  if (m.platform !== undefined) {
    legacyKeysSeen.push('comm.platform (dropped — never read by runtime)');
  }
  legacyKeysSeen.push('comm.* → server.* (kb/as dropped)');
  delete config.comm;
}

// Strip server.platform if a previous migration carried it over — it's dead.
if (config.server && config.server.platform !== undefined) {
  delete config.server.platform;
  legacyKeysSeen.push('server.platform (dropped — never read by runtime)');
}

// Existing v0.4-shape configs that already migrated but kept server.kb_url /
// server.as_url around: drop them now since they're unused.
if (config.server) {
  let strippedKb = false;
  if (config.server.kb_url !== undefined) { delete config.server.kb_url; strippedKb = true; }
  if (config.server.as_url !== undefined) { delete config.server.as_url; strippedKb = true; }
  if (strippedKb) legacyKeysSeen.push('server.kb_url / server.as_url (dropped — unused)');
}

// ── agent.{device_id, app_version} ──────────────────────────────────────────
// Hoist legacy top-level fields under `agent.*` (where the runtime now reads).
// `client_id` used to be hoisted too; the field is dead and is stripped below.
if (!config.agent) config.agent = {};
for (const k of ['device_id', 'app_version']) {
  if (config[k] !== undefined) {
    if (config.agent[k] === undefined) config.agent[k] = config[k];
    legacyKeysSeen.push(k);
    delete config[k];
  }
}
// Top-level client_id (very old): drop.
if (config.client_id !== undefined) {
  delete config.client_id;
  legacyKeysSeen.push('client_id (top-level dropped — never read by runtime)');
}
// agent.client_id (any prior version): drop.
if (config.agent.client_id !== undefined) {
  delete config.agent.client_id;
  legacyKeysSeen.push('agent.client_id (dropped — never read by runtime)');
}

// ── orgs.default from legacy top-level org_id ───────────────────────────────
if (!config.orgs) config.orgs = {};
if (config.org_id) {
  if (!config.orgs.default) {
    config.orgs.default = {
      enabled: true,
      org_id: config.org_id,
      org_name: '',
      self:  { member_id: '', name: 'Zylos' },   // ← operator must fill in member_id
      owner: { member_id: '', name: '' },        // empty member_id = unbound
      access: {
        dmPolicy:    'owner',
        dmAllowFrom: [],
        groupPolicy: 'allowlist',
        groups:      {},
      },
    };
  }
  legacyKeysSeen.push('org_id');
  delete config.org_id;
}

// ── per-org schema: flat member_id/display_name → self.{member_id,name},
//                   owner.bound flag → derived from owner.member_id ─────────
//
// Earlier v0.4 configs (pre-self refactor) stored the agent's per-org
// identity flat on the org block and tracked owner-binding via a separate
// `bound` boolean. The current schema groups identity under `self` and
// derives bound state from `owner.member_id` being non-empty.
for (const [slug, org] of Object.entries(config.orgs)) {
  if (!org || typeof org !== 'object') continue;
  let touched = false;

  // member_id + display_name → self.{member_id, name}
  if (org.member_id !== undefined || org.display_name !== undefined) {
    const memberId = org.member_id || org.self?.member_id || '';
    const name     = org.display_name || org.self?.name || 'Zylos';
    org.self = { member_id: memberId, name };
    delete org.member_id;
    delete org.display_name;
    touched = true;
  } else if (!org.self) {
    org.self = { member_id: '', name: 'Zylos' };
    touched = true;
  }

  // owner.bound → strip (state now derived from owner.member_id)
  if (org.owner && org.owner.bound !== undefined) {
    delete org.owner.bound;
    touched = true;
  }
  if (!org.owner) {
    org.owner = { member_id: '', name: '' };
    touched = true;
  }

  if (touched) legacyKeysSeen.push(`orgs.${slug}: member_id/display_name → self.*, owner.bound dropped`);
}

// ── orgs key normalisation: old-style slug → full org_id ────────────────────
//
// Earlier versions used human-readable slugs as keys (e.g. "org-019ea63a",
// "coco-test2", "default"). The canonical key is now the full org_id UUID.
// Rename any entry whose key does not match its own org_id.
{
  const renames = [];
  for (const [slug, org] of Object.entries(config.orgs)) {
    if (!org || typeof org !== 'object' || !org.org_id) continue;
    if (slug !== org.org_id) renames.push([slug, org.org_id]);
  }
  for (const [oldKey, newKey] of renames) {
    if (config.orgs[newKey]) {
      legacyKeysSeen.push(`orgs.${oldKey}: skipped rename → ${newKey} (key already exists)`);
      continue;
    }
    config.orgs[newKey] = config.orgs[oldKey];
    delete config.orgs[oldKey];
    legacyKeysSeen.push(`orgs.${oldKey} → orgs.${newKey} (key normalised to full org_id)`);
  }
}

// ── server.frontend_base_path: /cws → /workspace ───────────────────────────
if (config.server?.frontend_base_path === '/cws') {
  config.server.frontend_base_path = '/workspace';
  legacyKeysSeen.push('server.frontend_base_path: "/cws" → "/workspace"');
}

// ── drop workspace_id entirely ──────────────────────────────────────────────
if (config.workspace_id !== undefined) {
  legacyKeysSeen.push('workspace_id (dropped — no replacement)');
  delete config.workspace_id;
}

// ── agent.id (legacy alias for identity_id) → identity_id ──────────────────
if (config.agent.id && !config.agent.identity_id) {
  config.agent.identity_id = config.agent.id;
  legacyKeysSeen.push('agent.id → agent.identity_id');
}
if (config.agent.id !== undefined) {
  delete config.agent.id;
}
// agent.participant_id was vestigial; drop if empty.
if (config.agent.participant_id === '' || config.agent.participant_id === undefined) {
  delete config.agent.participant_id;
}

// ── org_name resolution from API ────────────────────────────────────────────
//
// Fetch real org names from cws-core for every enabled org. Overwrites any
// stale or concatenated org_name with the server's canonical name. Best-effort:
// network failures are logged but never block the upgrade.

if (config.agent?.api_key && config.server?.bff_url) {
  const bffUrl = config.server.bff_url.replace(/\/$/, '');
  const apiKey = config.agent.api_key;
  const cfH = {};
  if (config.cf_access?.client_id) {
    cfH['CF-Access-Client-Id'] = config.cf_access.client_id;
    cfH['CF-Access-Client-Secret'] = config.cf_access.client_secret;
  }

  for (const [key, org] of Object.entries(config.orgs)) {
    if (!org?.org_id) continue;
    try {
      const tokenRes = await fetch(`${bffUrl}/auth/agent/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...cfH },
        body: JSON.stringify({ org_id: org.org_id }),
      });
      if (!tokenRes.ok) { console.log(`[post-upgrade] token exchange for ${org.org_id}: HTTP ${tokenRes.status}, skip`); continue; }
      const jwt = (await tokenRes.json())?.data?.access_token;
      if (!jwt) continue;

      const orgRes = await fetch(`${bffUrl}/api/v1/organizations/${org.org_id}`, {
        headers: { Authorization: `Bearer ${jwt}`, ...cfH },
      });
      if (!orgRes.ok) continue;
      const realName = (await orgRes.json())?.data?.name;
      if (realName && realName !== org.org_name) {
        const old = org.org_name || '(empty)';
        org.org_name = realName;
        legacyKeysSeen.push(`orgs.${key}.org_name: "${old}" → "${realName}" (from API)`);
      }
    } catch (e) {
      console.log(`[post-upgrade] org_name fetch for ${org.org_id}: ${e.message}`);
    }
  }
}

// ── write back if anything changed ──────────────────────────────────────────
if (legacyKeysSeen.length > 0) {
  const tmp = `${CONFIG_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);

  console.log('[post-upgrade] config.json migrated to multi-org schema (v0.4).');
  console.log('  Legacy fields migrated:');
  for (const k of legacyKeysSeen) console.log(`    - ${k}`);
  console.log('');
  console.log('  ⚠ ACTION REQUIRED — edit ' + CONFIG_PATH);
  console.log('    1. orgs.<slug>.self.member_id — set to this agent\'s member id within each org');
  console.log('       (look it up via cws-core /me, or call POST /orgs/{org_id}/members/me).');
  console.log('    2. orgs.<slug>.access — configure the policy:');
  console.log('       - dmPolicy: "open" | "allowlist" | "owner"');
  console.log('       - dmAllowFrom: [] (used when dmPolicy=allowlist)');
  console.log('       - groupPolicy: "open" | "allowlist" | "disabled"');
  console.log('       - groups: { "<conv-uuid>": { name, mode: "mention"|"smart", allowFrom: ["*"] } }');
  console.log('    3. To add MORE orgs, copy `orgs.default` to `orgs.<slug>`, fill in org_id and');
  console.log('       self.member_id for that org. Each enabled org gets its own WebSocket connection.');
  console.log('    4. orgs.<slug>.owner — set on first DM under dmPolicy=owner (auto-bind);');
  console.log('       empty owner.member_id == unbound.');
  console.log('');
  console.log('  Service must be restarted after editing:  pm2 restart zylos-openmax');
} else {
  console.log('[post-upgrade] config.json already on multi-org schema — nothing to migrate.');
}

// ── security remediation: lock down sensitive files on every upgrade ───────
// Runs unconditionally (not just when the schema migration above rewrites
// config.json) so already-deployed bots get fixed permissions the moment
// they upgrade, without waiting on a config edit or a token refresh cycle.
// config.json (agent.api_key), runtime/tokens/*.json (access/refresh_token),
// and runtime/group-logs/*.log were all found world-readable (0644) at
// default umask — see 2026-07-30 token-log-leak finding.
{
  const RUNTIME_DIR = path.join(HOME, 'zylos/components/openmax/runtime');
  const TOKEN_DIR = path.join(RUNTIME_DIR, 'tokens');
  const GROUP_LOGS_DIR = path.join(RUNTIME_DIR, 'group-logs');

  function hardenFile(p) {
    try { fs.chmodSync(p, 0o600); } catch {}
  }
  function hardenDir(dir) {
    try {
      fs.chmodSync(dir, 0o700);
      for (const name of fs.readdirSync(dir)) hardenFile(path.join(dir, name));
    } catch { /* dir may not exist yet — nothing to harden */ }
  }

  hardenFile(CONFIG_PATH);
  hardenDir(TOKEN_DIR);
  hardenDir(GROUP_LOGS_DIR);
  console.log('[post-upgrade] permissions hardened: config.json (0600), runtime/tokens/ + runtime/group-logs/ (0700 dir / 0600 files).');
}

// Ensure the openmax-kb companion is present at >= pin (idempotent, non-fatal,
// time-bounded). On upgrade this also back-fills kb onto already-deployed agents.
ensureOpenmaxKb();
