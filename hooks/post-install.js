#!/usr/bin/env node

/**
 * Post-install hook for zylos-openmax.
 *
 * Two modes, picked by whether stdin is a TTY:
 *
 *   1. Interactive (TTY): prompt operator for endpoints, then agent identity
 *      (BYO or auto-register), then one or more org_ids in a loop.
 *      - Agent identity step asks three fields (identity_id / api_key /
 *        member_id). All three non-empty → use them verbatim (skip
 *        registration). Any blank → auto-register via POST /auth/register/agent
 *        (body: {}). The BYO member_id, when provided, is applied to the
 *        first org_id entered in the loop; subsequent orgs auto-fill from
 *        JWT claims at runtime.
 *      - Access policy is not asked. It defaults to dmPolicy=owner /
 *        groupPolicy=allowlist and is edited in config.json afterwards.
 *
 *   2. Non-interactive (no TTY): env-driven bootstrap. Same logic, driven
 *      by env vars.
 *
 *      Non-interactive contract maps 1:1 to cws-agent-manager-sdk-go's
 *      AgentInitialization.CoCoWorkspaceChannelAuth proto — one prepare run
 *      binds exactly one (agent, org) pair. Runtimes that need multi-org
 *      run prepare once per org_id (the hook is idempotent: an existing
 *      api_key short-circuits the identity step, an existing org_id block
 *      short-circuits that org's seed).
 *
 *      Required:
 *        - COCO_BFF_URL              proto server.bff_url
 *      Optional — endpoints:
 *        - COCO_WS_URL               proto server.ws_url (derived from BFF if omitted)
 *      Optional — org:
 *        - COCO_ORG_ID               proto org_id
 *        - COCO_ORG_NAME             proto org_name (display-only)
 *        - COCO_OWNER_MEMBER_ID      proto owner.member_id (pre-binds dmPolicy=owner)
 *        - COCO_OWNER_NAME           proto owner.name (display-only)
 *        - COCO_MEMBER_ID            proto self.member_id (also BYO 3-tuple)
 *        - COCO_SELF_NAME            proto self.name
 *      Optional — BYO agent identity (3-tuple, all-or-none; partial set
 *      falls back to auto-register via POST /auth/register/agent):
 *        - COCO_IDENTITY_ID          NOT in proto — required to bootstrap
 *                                    config.agent.identity_id without a fresh register
 *        - COCO_API_KEY              proto api_key
 *        - COCO_MEMBER_ID            proto self.member_id
 *
 * Registration failure (any mode) is a HARD FAILURE — the hook exits with
 * code 1 and does NOT write config.json. The operator must re-run after
 * fixing connectivity or auth.
 *
 * api_key lives **in config.json** (`agent.api_key`). There is no .env
 * file involved anywhere in this codebase — neither read nor written.
 *
 * Idempotency: if config.agent.api_key is already set, the registration
 * call is skipped. Re-running prepare in any mode is safe.
 *
 * 🚧 TEMP: every fetch carries Cloudflare Access service-token headers via
 * cf-access.js. Delete that import + spread before the first production
 * release.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { ensureOpenmaxKb } from './lib/ensure-openmax-kb.js';

const HOME = process.env.HOME;
const DATA_DIR    = path.join(HOME, 'zylos/components/openmax');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// CF-Access headers for install-time calls (e.g. /auth/register/agent). Read
// straight from env — config.json doesn't exist yet when we register, and the
// runtime cfAccessHeaders() (which reads config.json) would see nothing. The
// same values are persisted into config.cf_access below for runtime use.
function cfAccessHeaders() {
  const headers = {};
  const id     = process.env.COCO_CF_ACCESS_CLIENT_ID || '';
  const secret = process.env.COCO_CF_ACCESS_CLIENT_SECRET || '';
  if (id)     headers['CF-Access-Client-Id']     = id;
  if (secret) headers['CF-Access-Client-Secret'] = secret;
  return headers;
}

const isInteractive = process.stdin.isTTY === true;

// Path selection — gated on COCO_API_KEY (borrowing the env-var keys from
// scripts/init-openmax.sh):
//   - COCO_API_KEY present → take EVERYTHING from env and write config, no
//     prompts (even on a TTY). The non-interactive block below already reads
//     all values from env.
//   - COCO_API_KEY absent  → keep the previous behavior unchanged: interactive
//     prompts when a TTY is available, otherwise the non-interactive env +
//     auto-register bootstrap (same as before).
const hasEnvApiKey = !!(process.env.COCO_API_KEY || '').trim();
const useEnvPath   = hasEnvApiKey || !isInteractive;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

console.log('[install] zylos-openmax');

for (const d of ['logs', 'media', 'runtime', 'runtime/tokens']) {
  fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
}
console.log('[install] data dirs ready under', DATA_DIR);

// Load existing config (or seed from defaults)
let config;
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (err) {
    console.warn(`[install] existing config.json is invalid (${err.message}); re-seeding from defaults`);
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
} else {
  config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

if (!config.agent) config.agent = {};
if (!config.agent.device_id) {
  config.agent.device_id = crypto.randomUUID();
  console.log('[install] generated agent.device_id', config.agent.device_id);
}
if (!config.orgs) config.orgs = {};

// CF-Access service token: persist from env into config.cf_access so the
// runtime (src/lib/cf-access.js) reads it from config.json. Never hardcoded.
if (!config.cf_access) config.cf_access = { client_id: '', client_secret: '' };
if (process.env.COCO_CF_ACCESS_CLIENT_ID)     config.cf_access.client_id     = process.env.COCO_CF_ACCESS_CLIENT_ID;
if (process.env.COCO_CF_ACCESS_CLIENT_SECRET) config.cf_access.client_secret = process.env.COCO_CF_ACCESS_CLIENT_SECRET;
if (config.cf_access.client_id || config.cf_access.client_secret) {
  console.log('[install] cf_access seeded from env (client_id' + (config.cf_access.client_secret ? ' + client_secret' : '') + ')');
}

async function registerAgent(coreUrl) {
  const url = `${coreUrl.replace(/\/$/, '')}/auth/register/agent`;
  console.log(`[install] POST ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...cfAccessHeaders(),
    },
    body: JSON.stringify({}),     // empty body — cws-core requires no fields
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.detail || data.error || data.message)) || text;
    throw new Error(`registration failed (${res.status}): ${msg}`);
  }
  // D8 envelope: { data: { identity_id, api_key }, request_id, server_time }
  const d = (data && typeof data === 'object' && data.data) ? data.data : data;
  if (!d?.identity_id || !d?.api_key) {
    throw new Error('registration returned no identity_id/api_key');
  }
  return d;
}

function seedOrg(orgId, opts = {}) {
  if (!orgId) return;
  for (const existing of Object.values(config.orgs)) {
    if (existing?.org_id === orgId) {
      console.log(`[install] org ${orgId} already in config — skipping`);
      return;
    }
  }
  const {
    memberId      = '',
    orgName       = '',
    ownerMemberId = '',
    ownerName     = '',
    selfName      = '',
  } = opts;
  const slug = orgId;
  // Field-for-field aligned with cws-agent-manager-sdk-go's
  // CoCoWorkspaceChannelAuth proto (server.{bff_url,ws_url} are in `server`,
  // api_key in agent.api_key, org_id + org_name + owner.{member_id,name} +
  // self.{member_id,name} here). Empty values are runtime-default-safe:
  // self.member_id auto-fills from JWT claims on first WS open; owner auto-
  // binds on first DM under dmPolicy=owner; display names default to ''.
  config.orgs[slug] = {
    enabled:  true,
    org_id:   orgId,
    org_name: orgName,
    owner:    { member_id: ownerMemberId, name: ownerName },
    self:     { member_id: memberId,      name: selfName },
    access: {
      dmPolicy:    'owner',
      groupPolicy: 'allowlist',
      groups:      {},
    },
  };
  const seeded = [];
  if (orgName)       seeded.push(`org_name=${orgName}`);
  if (memberId)      seeded.push(`self.member_id=${memberId}`);
  if (selfName)      seeded.push(`self.name=${selfName}`);
  if (ownerMemberId) seeded.push(`owner.member_id=${ownerMemberId}`);
  if (ownerName)     seeded.push(`owner.name=${ownerName}`);
  const extras = seeded.length ? `, ${seeded.join(', ')}` : '';
  console.log(`[install] org "${slug}" seeded (org_id=${orgId}${extras})`);
}

function deriveWsUrl(bffUrl) {
  return bffUrl.replace(/^http/, 'ws') + '/ws';
}

if (!useEnvPath) {
  console.log('');
  console.log('========================================');
  console.log('  OpenMax — initial setup');
  console.log('========================================');

  // Step 1: endpoints
  const defaultBff = config.server?.bff_url || 'http://127.0.0.1:8080';
  const bffInput = await ask(`  cws-core REST URL (bff_url) [${defaultBff}]: `);
  const bffUrl = (bffInput || defaultBff).replace(/\/$/, '');

  // Default ws_url to the value derived from the (possibly just-updated)
  // bff_url, NOT to whatever is in config.server.ws_url. That way an old
  // install's seeded `ws://127.0.0.1:8080/ws` doesn't silently survive when
  // bff_url changes to a real cws-core URL. Operator can still override
  // explicitly if cws-comm is on a different host than cws-core.
  const defaultWs = deriveWsUrl(bffUrl);
  const wsInput = await ask(`  cws-comm WebSocket URL (ws_url) [${defaultWs}]: `);
  const wsUrl = wsInput || defaultWs;

  if (!config.server) config.server = {};
  config.server.bff_url = bffUrl;
  config.server.ws_url  = wsUrl;
  console.log(`[install] endpoints set: bff_url=${bffUrl}  ws_url=${wsUrl}`);

  // Step 2: agent identity
  // ─────────────────────────
  // Two paths:
  //   A. Bring-your-own (BYO): operator already created this agent elsewhere
  //      (e.g. via POST /api/v1/platform-agents from the admin UI), and has
  //      identity_id + api_key + member_id on hand. Paste all three — we skip
  //      registration and use them verbatim. member_id will be applied to the
  //      first org_id entered in Step 3 (single-org assumption — the BYO
  //      member_id is by definition tied to one specific org).
  //   B. Auto-register: leave any of the three blank, and we POST
  //      /auth/register/agent to mint a fresh identity. member_id then
  //      auto-fills from JWT claims when the runtime first connects.
  //
  // Idempotency: existing config.agent.api_key short-circuits the entire
  // step — re-running install never destroys an already-bootstrapped agent.
  let pendingMemberId = '';
  if (config.agent.api_key) {
    console.log('[install] agent.api_key already in config — skipping agent identity step');
  } else {
    console.log('');
    console.log('  Agent identity:');
    console.log('  (paste all three to bring an existing agent; leave any blank to auto-register)');
    const userIdentity = await ask('    identity_id [auto-register if blank]: ');
    const userApiKey   = await ask('    api_key     [auto-register if blank]: ');
    const userMember   = await ask('    member_id   [auto-register if blank]: ');

    const allProvided = userIdentity && userApiKey && userMember;
    if (allProvided) {
      config.agent.identity_id = userIdentity;
      config.agent.api_key     = userApiKey;
      pendingMemberId          = userMember;
      console.log(`[install] using pre-provisioned agent: identity_id=${userIdentity}`);
      console.log(`[install] member_id=${userMember} will be applied to the first org_id below`);
    } else {
      if (userIdentity || userApiKey || userMember) {
        console.log('[install] not all three fields provided — falling back to auto-register');
      }
      console.log('[install] registering agent against cws-core (POST /auth/register/agent)');
      let reg;
      try {
        reg = await registerAgent(bffUrl);
      } catch (err) {
        console.error('[install] ✗ registration failed:', err.message);
        console.error('[install] aborting — config.json NOT written. Fix bff_url / network and re-run.');
        process.exit(1);
      }
      config.agent.identity_id = reg.identity_id;
      config.agent.api_key     = reg.api_key;
      console.log(`[install] ✓ registered: identity_id=${reg.identity_id}`);
      console.log('[install] api_key written to config.json (shown only once by server)');
    }
  }

  // Step 3: multi-org loop
  console.log('');
  console.log('  Org IDs (paste UUID, blank line to finish):');
  let added = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const orgId = await ask(`    org_id [${added === 0 ? 'optional — blank to skip' : 'blank to finish'}]: `);
    if (!orgId) break;
    // Apply the BYO member_id to the first org only; subsequent orgs auto-fill
    // their member_id from JWT claims at runtime.
    const memberId = (added === 0) ? pendingMemberId : '';
    seedOrg(orgId, { memberId });
    if (added === 0 && pendingMemberId) pendingMemberId = '';
    added += 1;
  }
  if (added === 0) {
    if (pendingMemberId) {
      console.log('[install] WARN: member_id was provided but no org_id was entered — member_id discarded');
    }
    console.log('[install] no orgs configured — service will start but stay idle until you add an org block to config.json and restart');
  } else {
    console.log(`[install] ${added} org(s) configured`);
    console.log('[install] member_id and access policy auto-fill at runtime for orgs without one');
    console.log('[install] (edit config.json to refine dmPolicy / groupPolicy later)');
  }
} else {
  // Non-interactive bootstrap. Maps 1:1 to cws-agent-manager-sdk-go's
  // proto AgentInitialization.CoCoWorkspaceChannelAuth — one prepare run
  // binds exactly one (agent, org) pair. Operators that need a single
  // runtime to serve multiple orgs run the hook once per org_id (the
  // hook is idempotent: existing config.agent.api_key and existing
  // org_id blocks short-circuit).
  const envBff      = (process.env.COCO_BFF_URL || '').replace(/\/$/, '');
  const envWs       = process.env.COCO_WS_URL      || '';
  const envOrgId    = process.env.COCO_ORG_ID      || '';
  const envIdentity = process.env.COCO_IDENTITY_ID || '';
  const envApiKey   = process.env.COCO_API_KEY     || '';
  const envMember   = process.env.COCO_MEMBER_ID   || '';
  // Channel-auth-aligned org metadata (matches proto field shape):
  const envOrgName     = process.env.COCO_ORG_NAME        || '';
  const envOwnerMember = process.env.COCO_OWNER_MEMBER_ID || '';
  const envOwnerName   = process.env.COCO_OWNER_NAME      || '';
  const envSelfName    = process.env.COCO_SELF_NAME       || '';

  if (!envBff) {
    console.error('[install] non-interactive mode: COCO_BFF_URL is required');
    process.exit(1);
  }

  if (!config.server) config.server = {};
  config.server.bff_url = envBff;
  config.server.ws_url  = envWs || deriveWsUrl(envBff);
  console.log(`[install] endpoints set: bff_url=${config.server.bff_url}  ws_url=${config.server.ws_url}`);

  let pendingMemberId = '';
  if (config.agent.api_key) {
    console.log('[install] agent.api_key already in config — skipping agent identity step (idempotent)');
  } else if (envIdentity && envApiKey && envMember) {
    // BYO path via env: all three present.
    config.agent.identity_id = envIdentity;
    config.agent.api_key     = envApiKey;
    pendingMemberId          = envMember;
    console.log(`[install] using pre-provisioned agent from env: identity_id=${envIdentity}`);
  } else {
    if (envIdentity || envApiKey || envMember) {
      console.log('[install] partial BYO env (COCO_IDENTITY_ID/API_KEY/MEMBER_ID) — falling back to auto-register');
    }
    console.log('[install] registering agent against cws-core (POST /auth/register/agent)');
    let reg;
    try {
      reg = await registerAgent(envBff);
    } catch (err) {
      console.error('[install] ✗ registration failed:', err.message);
      process.exit(1);
    }
    config.agent.identity_id = reg.identity_id;
    config.agent.api_key     = reg.api_key;
    console.log(`[install] ✓ registered: identity_id=${reg.identity_id}`);
  }

  if (envOrgId) {
    seedOrg(envOrgId, {
      memberId:      pendingMemberId,
      orgName:       envOrgName,
      ownerMemberId: envOwnerMember,
      ownerName:     envOwnerName,
      selfName:      envSelfName,
    });
    if (pendingMemberId) pendingMemberId = '';
  } else {
    const orphans = [
      pendingMemberId && 'COCO_MEMBER_ID',
      envOrgName      && 'COCO_ORG_NAME',
      envOwnerMember  && 'COCO_OWNER_MEMBER_ID',
      envOwnerName    && 'COCO_OWNER_NAME',
      envSelfName     && 'COCO_SELF_NAME',
    ].filter(Boolean);
    if (orphans.length) {
      console.log(`[install] WARN: ${orphans.join(', ')} provided but COCO_ORG_ID was empty — discarded`);
    }
    console.log('[install] no COCO_ORG_ID provided — service will idle until orgs are configured');
  }
}

// ── org_name resolution from API ────────────────────────────────────────────
// Fetch real org names from cws-core for any newly seeded org. Ensures
// org_name matches the server's canonical name regardless of what
// COCO_ORG_NAME was (or wasn't) set to. Best-effort: failures are logged
// but never block the install.

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
      if (!tokenRes.ok) continue;
      const jwt = (await tokenRes.json())?.data?.access_token;
      if (!jwt) continue;

      const orgRes = await fetch(`${bffUrl}/api/v1/organizations/${org.org_id}`, {
        headers: { Authorization: `Bearer ${jwt}`, ...cfH },
      });
      if (!orgRes.ok) continue;
      const realName = (await orgRes.json())?.data?.name;
      if (realName && realName !== org.org_name) {
        console.log(`[install] org_name for ${org.org_id}: "${org.org_name || '(empty)'}" → "${realName}" (from API)`);
        org.org_name = realName;
      }
    } catch (e) {
      console.log(`[install] org_name fetch for ${org.org_id}: ${e.message} (skipped)`);
    }
  }
}

// config.json holds agent.api_key (long-lived root credential) — lock it
// down from the first write, not just on later updateConfig() calls.
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
console.log('[install] config.json written (0600)');

console.log('[install] complete');

// Auto-install the openmax-kb companion (idempotent, non-fatal, time-bounded).
// Placed before the interactive "Next steps" so those lines don't print above kb output.
ensureOpenmaxKb();

if (isInteractive) {
  console.log('');
  console.log('Next steps:');
  console.log('  - Start the service:  pm2 start ecosystem.config.cjs');
  console.log('  - Watch the bootstrap: pm2 logs zylos-openmax --lines 50');
}
