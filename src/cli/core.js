#!/usr/bin/env node

/**
 * Core CLI — read-mostly directory queries against the core service
 * (paths and params per the core service's live OpenAPI spec).
 *
 * Usage:
 *   node src/cli/core.js <command> '<json-params>'
 *   node src/cli/core.js core.me            '{}'
 *   node src/cli/core.js core.member_list   '{"kind":"agent","limit":50}'
 *
 * Status:
 *   ✅  available in the core service today
 *   ⏳  not exposed by the core service yet (call will 404); kept here so the
 *      surface is ready when core adds the endpoint
 */

import { get, post, patch, apiPath, frontendUrl, getForOrg, postForOrg, delForOrg } from '../lib/client.js';
import { enabledOrgs, updateConfig, resolveDefaultOrgId } from '../lib/config.js';
import { resolveAgentBaseUrl } from '../lib/agent-domain.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

// Org resolution for the ORG-OWNED commands (mirrors conn.js PR#127). The backend
// resolves the org from the JWT principal and 403s ("org membership required")
// on an identity-only token for these routes. A bare get()/post() would silently
// fall through to resolveDefaultOrgId(), which returns '' when >1 org is enabled
// and no org is given — producing that opaque 403. The org-scoped helpers below
// FAIL FAST with an actionable 400 instead. Single-org / COCO_ORG_ID unchanged.
//
// NOTE: this is used ONLY by the org-owned commands (oget/opost/odel). The
// identity / bootstrap commands (self_rename, org_list, org_create,
// org_switch, invitation_accept, agent_domain) DELIBERATELY keep the bare
// get/post/patch — they are identity-scoped by definition and must NOT be forced
// org (doing so would break cross-org / bootstrap flows). For org_get the {orgId}
// path param doubles as the operating org, so reading a specific org uses that
// org's own JWT.
// core.me preserves the bootstrap path unless an explicit org is supplied;
// then its member identity must be resolved using that org's JWT.
function resolveOrgId() {
  return params.org || params.orgId || params.org_id || resolveDefaultOrgId();
}
function requireOrgId() {
  const orgId = resolveOrgId();
  if (!orgId) {
    throw Object.assign(
      new Error('cannot resolve org: multiple orgs enabled and no org given — pass {"org":"<org_id>"} or set COCO_ORG_ID'),
      { status: 400 },
    );
  }
  return orgId;
}
const oget  = (path, query) => getForOrg(requireOrgId(), path, query);
const opost = (path, body)  => postForOrg(requireOrgId(), path, body);
const odel  = (path)        => delForOrg(requireOrgId(), path);

/** Normalize a scalar-or-array param into an array (drops null/undefined). */
const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Rename the agent itself (self-service display name change).
 *
 * Two sides are kept in sync:
 *   1. the core service — `PATCH /api/v1/me {display_name}`. display_name is an
 *      identity-level attribute (managed by the core service's Identities, per D15),
 *      so a single /me PATCH updates how the agent appears in EVERY org it
 *      has joined. We deliberately do NOT use the admin-only
 *      `PATCH /api/v1/members/{id}` here — the agent runs as an org-member,
 *      not an org-admin, so that route would 403.
 *   2. local config — mirror the new name into `orgs.<slug>.self.name` for
 *      every enabled org so the runtime's notion of its own name stays
 *      consistent with the core service.
 *
 * Prints only the new name + which orgs were synced. No tokens/secrets are
 * ever emitted (the RPC logger logs body+url only, never auth headers).
 */
async function selfRename(newName) {
  const name = typeof newName === 'string' ? newName.trim() : '';
  if (!name) {
    const err = new Error('self_rename requires a non-empty {name}');
    err.status = 400;
    throw err;
  }

  const updated = await patch(apiPath('/me'), { display_name: name });

  const orgs = enabledOrgs();
  if (orgs.length) {
    updateConfig((cfg) => {
      for (const { slug } of orgs) {
        const org = cfg.orgs?.[slug];
        if (!org) continue;
        org.self = { ...(org.self || {}), name };
      }
    });
  }

  return {
    display_name: updated?.display_name ?? name,
    identity_id:  updated?.identity_id,
    orgs_synced:  orgs.map((o) => o.slug),
  };
}

/**
 * Thin CLI wrapper over resolveAgentBaseUrl() (src/lib/agent-domain.js).
 * Resolves the agent's OWN public base URL for webhook-channel URL building:
 *   1. core service bound domain → base_url = "https://" + full_domain
 *   2. AGENT_PUBLIC_BASE_URL env fallback — ONLY when core answers 404
 *      (agent has no bound domain)
 *
 * On a resolved URL it returns the payload (main() prints it, exit 0). When
 * neither tier yields a URL it prints the `{ok:false,error}` shape and exits 1
 * — signalling failure like every other core.js command, but preserving the
 * structured result the resolver returns to library callers. Non-404 core
 * errors and malformed 200 responses (missing identity_id / full_domain)
 * throw from the resolver: per CLI conventions the message goes to stderr
 * with exit code 1 — never silently masked as an env fallback.
 */
async function agentDomainCommand() {
  const result = await resolveAgentBaseUrl();
  if (!result.ok) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  return result;
}

const COMMANDS = {
  // ✅ Current user / workspace identity
  'core.me': () => (params.org || params.orgId || params.org_id)
    ? oget(apiPath('/me')) : get(apiPath('/me')),

  // ✅ Self public base URL — resolve THIS agent's publicly-reachable base URL
  // for webhook-channel URL construction (WhatsApp Business / LINE / Teams).
  // Two-tier: (1) core service GET /platform-agents/{identity_id}/domain →
  // {ok,source:"core",full_domain,label,root_suffix,base_url}; (2) ONLY on a
  // core 404 fall back to AGENT_PUBLIC_BASE_URL → {ok,source:"env",base_url};
  // neither → {ok:false,error} + exit 1. Non-404 errors and malformed 200s
  // (no identity_id / full_domain) fail loudly (stderr, exit 1) instead of
  // falling back to env. See src/lib/agent-domain.js.
  'core.agent_domain': () => agentDomainCommand(),

  // ✅ Rename self (display name). Updates the core service identity via PATCH /me
  // (works for org-member agents — no admin needed) AND mirrors the new
  // name into local config's per-org `self.name`. See selfRename() above.
  'core.self_rename': () => selfRename(params.name || params.displayName || params.display_name),

  // ✅ Members directory.
  // The backend uses PageParams (envelope.go) — `page` + `page_size`, NOT cursor/limit.
  // Legacy callers passing `limit` continue to work via the alias.
  'core.member_list': () => oget(apiPath('/members'), {
    kind:      params.kind || params.type,
    status:    params.status,
    search:    params.search || params.q,
    page:      params.page,
    page_size: params.pageSize ?? params.limit,
    order_by:  params.orderBy,
  }),
  'core.member_get': () => oget(apiPath(`/members/${params.memberId}`)),

  // ✅ Project member list
  'core.project_members': () => oget(apiPath(`/projects/${params.projectId}/members`)),

  // ✅ Agent capability profiles — the backend BFF aggregation a Lead reads to
  // pick a candidate agent for dispatch. A scope is REQUIRED: pass projectId
  // (resolved to the project's agents via cws-work) and/or memberIds
  // (repeatable agent member IDs). `include:["capabilities"]` (or the
  // `capabilities:true` shorthand) loads skills (agent self-reported) + tags
  // (human-declared); omit for the lightweight view. online_status is always
  // enriched. Open-ended org-wide capability search is intentionally NOT here.
  'core.agent_profiles': () => oget(apiPath('/agent-profiles'), {
    project_id: params.projectId || params.project_id,
    member_id:  toArray(params.memberIds ?? params.memberId ?? params.member_id),
    include:    params.capabilities
      ? Array.from(new Set([...toArray(params.include), 'capabilities']))
      : toArray(params.include),
  }),

  // ✅ Platform agents — manage agent member lifecycle.
  // POST /api/v1/platform-agents      body {display_name, ...}
  // DELETE /api/v1/platform-agents/{member_id}
  'core.platform_agent_create': () => opost(apiPath('/platform-agents'), {
    display_name: params.displayName || params.name,
    description:  params.description,
    metadata:     params.metadata,
  }),
  'core.platform_agent_delete': () => odel(apiPath(`/platform-agents/${params.memberId}`)),

  // ✅ Onboarding session — the org's onboarding lifecycle record. A Lead
  // agent woken by the welcome DM reads this to locate the onboarding
  // structure: `core_issue_id` is the guided-conversation Issue to drive
  // (read it + its blueprint via tm.js), `project_id` the onboarding project.
  // 404 = this org never started onboarding.
  'core.onboarding_session': () => oget(apiPath('/onboarding/session')),

  // ✅ Onboarding funnel event report. Caller must be the in-flight session's
  // lead agent. Self-reportable types: d1_activation (user replied ≥1 round
  // in the core-issue icebreaker), d3_im_connected (third-party IM linked).
  // Duplicates are absorbed server-side (idempotent 200, recorded=false) —
  // safe to fire without checking first. d7_first_delivery is server-observed
  // on issue accept and cannot be self-reported.
  'core.onboarding_event': () => opost(apiPath('/onboarding/events'), {
    event_type:  params.eventType || params.event_type,
    occurred_at: params.occurredAt || params.occurred_at,
    meta:        params.meta,
  }),

  // ✅ Projects list. Defaults to active projects: resolving a project by name
  // (e.g. picking where to register an Issue) must not match ARCHIVED ones — a
  // human refers to a live project, and archived duplicates would make the match
  // ambiguous. Pass status:"archived" explicitly to list archived projects.
  // The backend uses PageParams — `page` + `page_size`, NOT cursor/limit.
  'core.project_list': () => oget(apiPath('/projects'), {
    status:    params.status ?? 'active',
    page:      params.page,
    page_size: params.pageSize ?? params.limit,
    order_by:  params.orderBy,
  }),

  // ✅ Organizations.
  'core.org_list':   () => get(apiPath('/organizations'), {
    order_by: params.orderBy,
  }),
  'core.org_get':    () => oget(apiPath(`/organizations/${params.orgId}`)),
  // POST /api/v1/organizations  — create a new org and become its owner.
  // Server requires {name, slug, display_name}: display_name is the
  // caller's display name *within the new org* (the caller is auto-added
  // as org-owner member, and that membership row needs a display_name).
  // Response includes a fresh `access_token` already scoped to the new
  // org's `member_id`, so callers can immediately act in the new context
  // without a separate `org_switch`.
  'core.org_create': () => post(apiPath('/organizations'), {
    name: params.name,
    slug: params.slug,
    display_name: params.displayName || params.display_name,
  }),
  // POST /api/v1/organizations/{org_id}/switch  — swap principal's active org.
  // Server requires a body to be present (empty `{}` is fine; any
  // additional property is rejected as `unexpected property` 422 — the
  // request schema is closed). Returns a fresh `access_token` scoped to
  // the target org (used by callers that need to act under the new org
  // context immediately).
  'core.org_switch': () => post(apiPath(`/organizations/${params.orgId}/switch`), {}),

  // ✅ Roles
  'core.role_list': () => oget(apiPath('/roles'), { scope: params.scope }),

  // ✅ Invitations
  // POST /api/v1/invitations — body {email?, display_name, role_id, message?}
  //   org_id is resolved server-side from the caller's JWT — do NOT send it.
  //   `display_name` (the invitee's org-level member name) is REQUIRED: naming
  //   happens at create-time — the name is stored on the invitation and becomes
  //   members.display_name on accept. Server rejects a blank display_name with
  //   400. Accept either camel or snake.
  'core.invitation_create': () => opost(apiPath('/invitations'), {
    email:        params.email,
    display_name: params.displayName ?? params.display_name,
    role_id:      params.roleId,
    message:      params.message,
  }),
  // GET /api/v1/invitations — query {status?, page?, page_size?, order_by?}
  //   org_id is resolved server-side from the caller's JWT — do NOT send it.
  //   The backend uses PageParams — `page` + `page_size`, NOT cursor/limit.
  'core.invitation_list': () => oget(apiPath('/invitations'), {
    status:    params.status,
    page:      params.page,
    page_size: params.pageSize ?? params.limit,
    order_by:  params.orderBy,
  }),
  // POST /api/v1/invitations/{invitation_id}/accept
  // Body is just `{token}`: the invitee display name now comes from the
  // invitation (set at create time), so accept no longer takes display_name —
  // sending it would be schema-invalid.
  'core.invitation_accept': () => post(apiPath(`/invitations/${params.invitationId}/accept`), {
    token: params.token,
  }),
  // DELETE /api/v1/invitations/{invitation_id}
  'core.invitation_revoke': () => odel(apiPath(`/invitations/${params.invitationId}`)),

  // Local helper — build a browser-navigable frontend URL. Not an API call.
  // Uses server.frontend_base_path (default /cws) + bff_url origin.
  'core.frontend_url': () => {
    const p = params.path || params.p || '';
    if (!p) throw Object.assign(new Error('path is required'), { status: 400 });
    return { url: frontendUrl(p) };
  },
};

function printUsage() {
  console.log(`Core CLI — directory queries on cws-core (contract-v5)

Usage: node src/cli/core.js <command> '<json-params>'

Identity
  core.me                  {}
  core.self_rename         {name}    # change own display_name (cws-core /me + local config self.name)
  core.agent_domain        {}        # resolve own public base_url for webhook channels
                           # (1) cws-core bound domain → base_url=https://<full_domain>
                           # (2) AGENT_PUBLIC_BASE_URL env, ONLY on core 404 (no bound domain)
                           # neither → {ok:false} exit 1; other errors/malformed 200 → stderr exit 1

Members (humans + agents in one directory)
  core.member_list         {kind?, status?, search?, page?, pageSize?, orderBy?}
                           # kind: human|agent|all (legacy alias: type)
                           # search legacy alias: q;  pageSize legacy alias: limit
  core.member_get          {memberId}
  core.project_members     {projectId}
  core.agent_profiles      {projectId?, memberIds?, include?, capabilities?}
                           # agent 能力画像聚合（派发前选候选）。scope 必填：projectId 和/或 memberIds(可数组)
                           # capabilities:true 或 include:["capabilities"] → 含 skills(自报)+tags(人工标注)；不带则轻量视图

Platform agents (lifecycle)
  core.platform_agent_create  {displayName, description?, metadata?}
  core.platform_agent_delete  {memberId}

Projects (directory view — workflow ops live in tm.js)
  core.project_list        {status?, page?, pageSize?, orderBy?}    # default status=active (pass status:"archived" for archived); pageSize legacy alias: limit

Onboarding (Lead agent — see SKILL.md "Onboarding Lead" section)
  core.onboarding_session  {}                                  # org 的 onboarding 会话；core_issue_id=核心对话 Issue，404=从未开始
  core.onboarding_event    {eventType, occurredAt?, meta?}     # 漏斗埋点上报（d1_activation|d3_im_connected）；重复上报幂等，放心发

Organizations
  core.org_list            {orderBy?}
  core.org_get             {orgId}
  core.org_create          {name, slug, displayName}  # creates org + auto-becomes org-owner; returns access_token scoped to new org
  core.org_switch          {orgId}      # principal's active org swap — returns new access_token scoped to target org

Roles
  core.role_list           {scope?}

Invitations
  core.invitation_create   {roleId, displayName, email?, message?}   # displayName REQUIRED (invitee's org member name); accepts display_name
  core.invitation_list     {status?, page?, pageSize?, orderBy?}    # pageSize legacy alias: limit
  core.invitation_accept   {invitationId, token}                    # no display_name — name comes from the invitation
  core.invitation_revoke   {invitationId}

Helpers
  core.frontend_url        {path}   # build browser-navigable URL: bff_url + frontend_base_path + path
                           # e.g. {path:"/knowledge?kb=xxx&node=yyy"} → https://<bff-host>/cws/knowledge?...

Environment:
  COCO_API_URL       cws-core base URL (default: http://127.0.0.1:8080)
  COCO_API_PREFIX    Path prefix override (default: /api/v1)
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
  try {
    const result = await handler();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    const fieldErrors = err.body?.error?.errors;
    if (Array.isArray(fieldErrors) && fieldErrors.length > 0) payload.errors = fieldErrors;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
