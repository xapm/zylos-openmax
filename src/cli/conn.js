#!/usr/bin/env node

/**
 * Connection CLI — cws-connect operations via cws-core BFF.
 *
 * Usage:
 *   node src/cli/conn.js <command> '<json-params>'
 *   node src/cli/conn.js conn.list     '{}'
 *   node src/cli/conn.js conn.acquire  '{"connectionId":"..."}'
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { apiPath, getForOrg, postForOrg, patchForOrg, delForOrg } from '../lib/client.js';
import { loadConfig, enabledOrgs, resolveDefaultOrgId } from '../lib/config.js';
import { listCachedCredentials, clearCachedCredentials, readCredentialCache, saveCredentialCache } from '../lib/credential-cache.js';
import {
  readIndex, replaceIndexFromList, findConnectionByApp, findActiveConnectionsByApp, indexPathForOrg,
  readCatalog, writeCatalog, invalidateCatalog, CATALOG_TTL_MS,
  personalConnectorBlockedInConversation,
} from '../lib/connect-store.js';
import { acquireCredential } from '../lib/connection-events.js';
import { invokeDirect, resolveCredential } from '../lib/direct-exec.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

// Operating org for the capability-cache verbs: explicit {org} wins, else the
// default/single enabled org. The index is org-scoped, so every lookup + the
// execute call must run against the same org's file, token, and member.
function resolveOrgId() {
  return params.org || params.orgId || params.org_id || resolveDefaultOrgId();
}

// Resolve the operating org and FAIL FAST when it can't be determined. Every
// cws-connect route below is org-scoped: cws-core requires an org-scoped JWT
// and 403s ("org membership required") on an identity-only token. A bare
// get()/post() would silently fall through to resolveDefaultOrgId(), which
// returns '' when >1 org is enabled and neither {org} nor COCO_ORG_ID is set —
// producing exactly that opaque 403. Throwing here turns "no org resolved" into
// an actionable 400 instead. Single-org / COCO_ORG_ID deployments resolve as
// before and never hit this.
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

// Security note: this agent's own member_id for an org — the ONLY identity
// the conn.* commands below use for the cws-connect agent_member_id calls.
// There is deliberately no client-supplied override (e.g. params.agentMemberId)
// here: accepting one would let a caller impersonate a different agent's
// identity against cws-connect (a confused-deputy/IDOR risk). cws-core is
// moving to derive this server-side from the authenticated principal too, so
// even if a caller sent an override it would be ignored there as well.
function resolveSelfMemberId(orgId = resolveDefaultOrgId()) {
  const cfg = loadConfig();
  for (const [, org] of Object.entries(cfg.orgs || {})) {
    if (org.org_id === orgId && org.self?.member_id) return org.self.member_id;
  }
  const first = Object.values(cfg.orgs || {})[0];
  return first?.self?.member_id || '';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

// ============================================================================
//  Custom-connector management (applications + action-defs)
// ============================================================================
//
// These verbs onboard/manage CUSTOM connector applications and their DB-backed
// HTTP action definitions against the cws-core BFF (/connect/applications*).
// They are org-scoped exactly like the rest of conn.js: the handler resolves the
// operating org via requireOrgId() and routes through the *ForOrg helpers so a
// multi-org agent never calls the backend with an identity-only token.
//
// The request PLAN for each verb is a pure function (planApp* / planActionDef*)
// that validates required params locally (throws {status:400}) and returns
// { method, path, body } WITHOUT touching the network — so path-building, the
// method, and the request body are unit-testable in isolation. The COMMANDS
// handlers below just wire the plan to the matching *ForOrg helper.
//
// SECURITY: a set of fields is NEVER forwarded to cws-core in the request body —
// they are all server-decided, so we build bodies with a strict ALLOWLIST (`pick`)
// rather than spreading the caller's params, and any field outside the allowlist
// (or any unknown key) cannot leak through even if supplied:
//   - `org_id`             — derived from the authenticated principal (still honored
//                            as an OPERATING-org selector via resolveOrgId — that
//                            picks which org's JWT to use, never written to a body).
//   - `oauth_callback_url` — injected by cws-core on create/update, returned read-only.
//   - `credential_source`  — server-FORCED to `custom` for these CLI-created connectors.
//   - `visibility`         — server-FORCED to `org`.
//   - `credential_mode`    — server-FORCED to `direct` (proxy is deprecated/removed).
// The last three were removed from the cws-core custom-connector create/update
// request schema (strict huma): sending ANY of them now returns HTTP 422. So the
// CLI planner drops them exactly the way it already drops `org_id`/`oauth_callback_url`.
// This mirrors conn.js's existing "no client-supplied identity override" posture.

// Application create body — the custom-connector superset (§1.2). `org_id`,
// `oauth_callback_url`, `credential_source`, `visibility`, and `credential_mode`
// are intentionally absent from this allowlist: cws-core forces
// custom/org/direct server-side and REJECTS (422) any of them in the body.
const APP_CREATE_FIELDS = [
  'slug', 'display_name', 'description', 'provider_type',
  'icon_url', 'category', 'tags',
  'api_key_location', 'api_key_header_name',
  'oauth_authorize_url', 'oauth_token_url', 'oauth_client_id', 'oauth_client_secret',
  'oauth_scopes_default', 'oauth_pkce', 'oauth_token_auth_method', 'oauth_token_body_format',
  'default_ttl_seconds',
];
// Application update body — pointer/optional fields (§1.2). `slug` and
// `provider_type` are immutable server-side, so they are NOT accepted here.
// `credential_source` / `visibility` / `credential_mode` are likewise NOT
// accepted: they are server-forced (custom/org/direct) and REJECTED (422) if
// sent — same treatment as the always-forbidden `org_id` / `oauth_callback_url`.
const APP_UPDATE_FIELDS = [
  'display_name', 'description',
  'icon_url', 'category', 'tags', 'is_enabled',
  'api_key_location', 'api_key_header_name',
  'oauth_authorize_url', 'oauth_token_url', 'oauth_client_id', 'oauth_client_secret',
  'oauth_scopes_default', 'oauth_pkce', 'oauth_token_auth_method', 'oauth_token_body_format',
  'default_ttl_seconds',
];
const ACTIONDEF_CREATE_FIELDS = ['name', 'method', 'url_template', 'description', 'headers', 'encoding', 'input_schema'];
const ACTIONDEF_UPDATE_FIELDS = ['method', 'url_template', 'description', 'headers', 'encoding', 'input_schema'];

function bad(message) { return Object.assign(new Error(message), { status: 400 }); }

// Tombstone error for the removed legacy verbs (conn.proxy / conn.execute). They
// are gone; conn.invoke is the single entry point and auto-routes by
// credential_mode — direct (local egress) AND proxy/Composio (server-side
// execute) are both invokable through it.
function proxyDeprecatedError(verb) {
  return bad(`unsupported: ${verb} is removed — use conn.invoke {app|connectionId, action, params} instead, which supports both direct (local egress) and proxy/Composio (server-side execute) connections.`);
}

// Copy only the allowlisted keys that are actually present (skip `undefined`).
// Absent keys stay absent so cws-core applies its own defaults; `null` passes
// through so an update can explicitly clear a field.
function pick(src, allowed) {
  const out = {};
  for (const k of allowed) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

// OAuth secret semantics: a BLANK (empty/whitespace-only) `oauth_client_secret`
// means "leave the stored secret unchanged" — it must NEVER be forwarded, so an
// update that omits or blanks the secret can never CLEAR a previously-stored one.
// A NON-empty secret IS forwarded (to set/rotate it). This mirrors the cws-fe
// form, which only sends the secret when the user actually typed a new value.
// Note this is deliberately asymmetric with `oauth_scopes_default`: an explicit
// empty array (`[]`) there is preserved and CLEARS the default scopes — only the
// secret has the write-only "blank = keep" behavior.
function dropBlankClientSecret(body) {
  if (typeof body.oauth_client_secret === 'string' && body.oauth_client_secret.trim() === '') {
    delete body.oauth_client_secret;
  }
  return body;
}

// An action-def's stored `headers` are applied by cws-connect on the DB-backed
// custom-action execution path AFTER the per-connection credential is injected,
// and (unlike discovery) that path does NOT strip them — so a stored
// `Authorization` header would override the connection's own auth. Reject any
// caller-supplied Authorization key locally (case-insensitive) so the CLI never
// authors a row that violates the "provider auth comes from the connection, not
// from action headers" contract. Lives in the pure planner so every path
// (create / update / app_import) is covered and can't bypass it.
function assertNoAuthorizationHeader(headers) {
  if (!headers || typeof headers !== 'object') return;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'authorization') {
      throw bad('headers.Authorization is forbidden — the connection credential is injected at call time');
    }
  }
}

function requireAppId(p) {
  const applicationId = p.applicationId || p.application_id;
  if (!applicationId) throw bad('applicationId is required');
  if (!isUuid(applicationId)) throw bad('applicationId must be a UUID');
  return applicationId;
}

function requireActionId(p) {
  const actionId = p.actionId || p.action_id;
  if (!actionId) throw bad('actionId is required');
  if (!isUuid(actionId)) throw bad('actionId must be a UUID');
  return actionId;
}

// POST /connect/applications — create a custom connector application.
// `slug` is OPTIONAL: cws-core generates one from display_name when omitted
// (#31, end-to-end deployed). An explicit slug is still honored — it stays in the
// allowlist and is forwarded as-is — but the CLI no longer force-requires it.
export function planAppCreate(p) {
  if (!p.display_name) throw bad('display_name is required');
  if (!p.provider_type) throw bad('provider_type is required (oauth2 | api_key)');
  const body = dropBlankClientSecret(pick(p, APP_CREATE_FIELDS));
  return { method: 'POST', path: apiPath('/connect/applications'), body };
}

// PATCH /connect/applications/{id} — update the caller's own custom connector.
// Carries the full OAuth field set (oauth_client_id / oauth_client_secret /
// oauth_scopes_default / authorize+token URLs, all in APP_UPDATE_FIELDS). A blank
// secret is dropped BEFORE the "no updatable fields" check, so an update whose
// ONLY field is a blank secret is correctly rejected as empty rather than sent.
export function planAppUpdate(p) {
  const applicationId = requireAppId(p);
  const body = dropBlankClientSecret(pick(p, APP_UPDATE_FIELDS));
  if (Object.keys(body).length === 0) throw bad('no updatable fields provided');
  return { method: 'PATCH', path: apiPath(`/connect/applications/${applicationId}`), body };
}

// GET /connect/applications/{id}/action-defs — list the app's HTTP action defs.
export function planActionDefList(p) {
  const applicationId = requireAppId(p);
  return { method: 'GET', path: apiPath(`/connect/applications/${applicationId}/action-defs`) };
}

// POST /connect/applications/{id}/action-defs — create one HTTP action def.
export function planActionDefCreate(p) {
  const applicationId = requireAppId(p);
  if (!p.name) throw bad('name is required (format: toolkit-slug/action-name)');
  if (!p.method) throw bad('method is required (GET|POST|PUT|PATCH|DELETE)');
  if (!p.url_template) throw bad('url_template is required');
  // description is REQUIRED and non-empty on create/import (#31, cws-core now
  // stores it end-to-end). Reject a missing/blank one locally before any network.
  if (p.description == null || String(p.description).trim() === '') {
    throw bad('description is required (non-empty)');
  }
  assertNoAuthorizationHeader(p.headers);
  return {
    method: 'POST',
    path: apiPath(`/connect/applications/${applicationId}/action-defs`),
    body: pick(p, ACTIONDEF_CREATE_FIELDS),
  };
}

// PATCH /connect/applications/{id}/action-defs/{action_id} — partial update.
export function planActionDefUpdate(p) {
  const applicationId = requireAppId(p);
  const actionId = requireActionId(p);
  assertNoAuthorizationHeader(p.headers);
  const body = pick(p, ACTIONDEF_UPDATE_FIELDS);
  if (Object.keys(body).length === 0) throw bad('no updatable fields provided');
  return {
    method: 'PATCH',
    path: apiPath(`/connect/applications/${applicationId}/action-defs/${actionId}`),
    body,
  };
}

// DELETE /connect/applications/{id}/action-defs/{action_id}.
export function planActionDefDelete(p) {
  const applicationId = requireAppId(p);
  const actionId = requireActionId(p);
  return {
    method: 'DELETE',
    path: apiPath(`/connect/applications/${applicationId}/action-defs/${actionId}`),
  };
}

// Bulk import: create the application, then create each action-def in order,
// collecting a per-action success/failure report so a partial import surfaces
// exactly which actions landed. Pure/injectable (deps: createApp,
// createActionDef) so the loop + partial-failure reporting are unit-testable
// without network or config. The app body and every action body run through the
// same allowlist planners, so `org_id`/`oauth_callback_url` can never leak in.
export async function runAppImport(params, { createApp, createActionDef }) {
  const application = params.application;
  if (!application || typeof application !== 'object' || Array.isArray(application)) {
    throw bad('application object is required');
  }
  const actions = Array.isArray(params.actions) ? params.actions : [];
  // Validate the app body up-front (throws 400) BEFORE any network call.
  const { body: appBody } = planAppCreate(application);
  const app = await createApp(appBody);
  const applicationId = app?.id || app?.application_id;
  if (!applicationId) {
    throw Object.assign(new Error('application create did not return an id'), { status: 502 });
  }
  const results = [];
  let created = 0;
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i] || {};
    const name = a.name ?? null;
    try {
      const { body } = planActionDefCreate({ applicationId, ...a });
      const def = await createActionDef(applicationId, body);
      created += 1;
      results.push({ index: i, name, ok: true, id: def?.id ?? null });
    } catch (err) {
      results.push({ index: i, name, ok: false, error: err.message, status: err.status });
    }
  }
  return {
    application: app,
    applicationId,
    actions_total: actions.length,
    actions_created: created,
    actions_failed: actions.length - created,
    results,
  };
}

// The app_actions / actions endpoints return the catalog either as a bare array
// or wrapped as { actions: [...] } depending on the BFF envelope — normalize.
function actionsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.actions)) return result.actions;
  return [];
}

// Fetch this agent's connections for an org from cws-core and rewrite that org's
// index file (org-scoped: uses the org's JWT and its own index path). The
// endpoint is always "your own" connections now (cws-core derives the caller
// from the authenticated principal, no id in the path) — agentId is accepted
// for call-site compatibility but no longer used to build the URL.
async function refreshIndex(orgId, agentId) {
  const idxPath = indexPathForOrg(orgId);
  const list = await getForOrg(orgId, apiPath('/connect/agents/me/connections'));
  replaceIndexFromList(Array.isArray(list) ? list : (list?.connections || []), idxPath);
  return readIndex(idxPath);
}

// Resolve an application (slug or applicationId) → its connection entry within an
// org, reading that org's index first. Refreshes from conn.list once when the
// app is missing OR the cached entry lacks an applicationId — the latter happens
// in the window after a connection.authorized event (which may carry only a slug)
// before any conn.list has filled the applicationId. Without that refresh,
// conn.catalog {app} would 400 on a slug-only entry.
async function resolveConnectionForApp(app, orgId, agentId) {
  const idxPath = indexPathForOrg(orgId);
  let entry = findConnectionByApp(app, idxPath);
  if (!entry || !entry.applicationId) {
    await refreshIndex(orgId, agentId);
    entry = findConnectionByApp(app, idxPath);
  }
  return entry;
}

// Format a connection createdAt (ISO string or epoch ms) as YYYY-MM-DD, or with
// second precision when `time` is set. Returns null when missing/unparseable.
function fmtCreated(ts, { time = false } = {}) {
  if (ts == null || ts === '') return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return time ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(0, 10);
}

// Establish a DETERMINISTIC candidate order that is invariant to the server's
// incidental return order. Sort key: created_at ASCENDING, tie-broken by the
// connection id (lexicographic). The id is used ONLY as a tiebreak here and must
// never leak into a label. Applied at the single point candidates are assembled
// (buildNeedsSelection) so that labels[i] and candidates[i] always derive from
// the SAME ordered list — otherwise (the P2 bug) two nameless connections in
// reversed input order swapped "Gmail (1)"/"Gmail (2)", so the label the user
// just picked could point to a DIFFERENT account on retry. Missing/unparseable
// createdAt sorts last (deterministically) and still tiebreaks by id.
function sortCandidatesDeterministically(entries) {
  const timeOf = (e) => {
    if (e.createdAt == null || e.createdAt === '') return Infinity;
    const t = new Date(e.createdAt).getTime();
    return Number.isNaN(t) ? Infinity : t;
  };
  return (entries || []).slice().sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== tb) return ta - tb;
    const ia = String(a.id ?? '');
    const ib = String(b.id ?? '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

// Build a guaranteed-NON-EMPTY and guaranteed-UNIQUE human LABEL per candidate,
// so the agent can refer to same-app connections unambiguously WITHOUT ever
// exposing the raw connection_id (design §3/§5 empty-name fallback). Precedence:
//   1. display_name when non-empty;
//   2. else "<app name> · <created date>" (app name + creation time);
// then collisions (duplicate/empty display_name, same-day creations) are broken
// with finer created-time precision and, as a LAST resort, a positional ordinal
// "(1)/(2)". A raw connection_id is NEVER used as a label.
export function buildCandidateLabels(entries) {
  const list = entries || [];
  const base = list.map((e) => {
    const dn = (e.displayName || '').trim();
    if (dn) return dn;
    const appName = (`${e.name || e.slug || 'connection'}`).trim() || 'connection';
    const d = fmtCreated(e.createdAt);
    return d ? `${appName} · ${d}` : appName;
  });
  // Disambiguate each group of colliding base labels.
  const groups = new Map();
  base.forEach((l, i) => {
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(i);
  });
  const labels = base.slice();
  for (const [l, idxs] of groups) {
    if (idxs.length < 2) continue;
    const times = idxs.map((i) => fmtCreated(list[i].createdAt, { time: true }));
    const distinctTimes = times.every(Boolean) && new Set(times).size === idxs.length;
    idxs.forEach((i, n) => {
      labels[i] = distinctTimes
        ? `${l} · ${fmtCreated(list[i].createdAt, { time: true })}`
        : `${l} (${n + 1})`;
    });
  }
  // Belt-and-suspenders: enforce non-emptiness + global uniqueness.
  const used = new Set();
  return labels.map((l, i) => {
    let label = (l && l.trim()) ? l : `connection (${i + 1})`;
    if (used.has(label)) {
      let k = 2;
      while (used.has(`${label} (${k})`)) k += 1;
      label = `${label} (${k})`;
    }
    used.add(label);
    return label;
  });
}

// Build the `needs_selection` result for the >1-active-connections case. This is
// a NORMAL return value (printed to stdout, exit 0) — NOT an error — so the
// agent can act on it. i18n contract: `agent_instruction` is LANGUAGE-NEUTRAL
// English guidance telling the agent to localize its question into the USER'S
// language; it deliberately contains NO ready-made zh/en user-facing sentence.
// Each candidate carries a guaranteed-non-empty, unique `label` (built from
// display_name with a created-time fallback) — the agent refers to connections
// by label; the raw connection_id is never shown to the user, only echoed back
// on retry via `connectionId`. `display_name` still passes through as-is.
export function buildNeedsSelection(app, action, candidates) {
  // Sort into a deterministic order BEFORE computing labels AND before building
  // candidates[], so both the label ordinal fallback and the candidate position
  // are invariant to the input (server return) order. This is the single
  // assembly point, so labels[i] and candidates[i] cannot diverge.
  const list = sortCandidatesDeterministically(candidates);
  const labels = buildCandidateLabels(list);
  return {
    needs_selection: true,
    reason: 'multiple_connections',
    app,
    agent_instruction:
      "Multiple connections match this app. Ask the user which one to use, phrasing your "
      + "question in the USER'S language (they may write Chinese or English). Refer to each "
      + "connection by its label, never the connection_id. Then retry with the chosen connectionId.",
    candidates: list.map((e, i) => ({
      connection_id: e.id,
      label: labels[i],
      display_name: e.displayName ?? null,
      status: e.status,
    })),
    retry_hint: `conn.invoke {"connectionId":"<chosen>","action":"${action}","params":{...}}`,
  };
}

// Count-aware resolution of a conn.invoke target. Returns either { entry } (use
// it directly; entry may be null → caller 404s) or { needsSelection } (return
// it verbatim). Pure/injectable (deps: findActives, findAny, readEntryById,
// refresh) so the 0/1/>1 branching and the connectionId bypass are unit-testable
// without network or config. Branching:
//   - connectionId given → SKIP app-resolution, use that connection (refresh
//     once if it is unknown or lacks an applicationId).
//   - 0 active → refresh once (already done if the sole candidate lacked an
//     applicationId); still 0 → fall back to any (non-active, e.g. needs_reauth)
//     entry so its actionable hint surfaces, else null → 404.
//   - exactly 1 active → use it.
//   - >1 active → needs_selection (never silently pick the first).
export async function resolveInvokeEntry(
  { app, connectionId, action },
  { findActives, findAny, readEntryById, refresh },
) {
  if (connectionId) {
    let entry = readEntryById(connectionId);
    if (!entry || !entry.applicationId) {
      await refresh();
      entry = readEntryById(connectionId);
    }
    // Even if still unknown locally, honor the explicit id — cws-core re-checks
    // the connection-agent boundary server-side. applicationId stays null (the
    // direct path guards on it and errors with an actionable hint).
    return { entry: entry || { id: connectionId, status: 'active', applicationId: null, slug: null, name: null, displayName: null } };
  }

  let actives = findActives(app);
  // Refresh once when nothing matches, OR the sole candidate lacks an
  // applicationId (slug-only event before any conn.list) — mirrors the old
  // resolveConnectionForApp trigger, now count-aware (a refresh may also reveal
  // a second active, correctly routing to needs_selection).
  if (actives.length === 0 || (actives.length === 1 && !actives[0].applicationId)) {
    await refresh();
    actives = findActives(app);
  }
  if (actives.length > 1) return { needsSelection: buildNeedsSelection(app, action, actives) };
  if (actives.length === 1) return { entry: actives[0] };
  return { entry: findAny(app) || null };
}

// Return an application's action catalog, reading the cache first and filling it
// via conn.app_actions (org-scoped token) on a miss / TTL-expiry / explicit
// refresh. The catalog file is global (keyed by applicationId) since an app's
// capabilities are the same across orgs.
// `persist` (default true) gates the on-disk catalog. For a composio (proxy)
// connector we must NEVER persist a full action catalog — its action space is
// huge and it executes server-side — so the composio path passes persist:false,
// which BOTH skips the cache read (never serves a stale/absent composio catalog)
// AND skips writeCatalog (fetch-through, no disk footprint).
async function getCatalog(orgId, applicationId, { refresh = false, ttlMs = CATALOG_TTL_MS, persist = true } = {}) {
  if (!refresh && persist) {
    const cached = readCatalog(applicationId, { ttlMs });
    if (cached) return { ...cached, source: 'cache' };
  }
  const actions = actionsOf(await getForOrg(orgId, apiPath(`/connect/applications/${applicationId}/actions`)));
  if (!persist) {
    return { applicationId, fetchedAt: Date.now(), actions, source: 'fetch' };
  }
  const rec = writeCatalog(applicationId, actions);
  return { ...rec, source: 'fetch' };
}

// A connection is a proxy connector when its credential_mode is "proxy" — it
// holds no local token and executes SERVER-SIDE (see conn.invoke). This is the
// single source of truth for the direct/proxy split; credential_source is no
// longer consulted.
function isProxyEntry(entry) {
  return !!entry && entry.credentialMode === 'proxy';
}

// Is an index entry's connector taxonomy KNOWN? A legacy entry that predates
// credentialMode has it null — we cannot tell proxy from direct, so the caller
// must refresh before trusting a "not proxy" read.
function taxonomyKnown(entry) {
  return !!entry && entry.credentialMode != null;
}

// Heuristic: does an execute error look like a stale/unknown-action or
// input-schema mismatch (vs. an auth/network failure)? Used to decide whether a
// one-shot catalog refresh could help.
function looksLikeActionOrSchemaError(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  if (err.status === 400) {
    return /action|schema|param|unknown|not found|invalid|required/i.test(err.message || '');
  }
  return false;
}

const COMMANDS = {
  // List connections available to this agent.
  // Always uses the agent's own member_id (resolveSelfMemberId) — no
  // client-supplied override; see the security note above resolveSelfMemberId.
  'conn.list': () => {
    const orgId = requireOrgId();
    const agentId = resolveSelfMemberId(orgId);
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return getForOrg(orgId, apiPath('/connect/agents/me/connections'));
  },

  // Acquire a credential for a connection. This verb is DIRECT-only: it returns
  // credential_mode:'direct' + access_token for local egress. A proxy/Composio
  // connection has no local token to hand out (its acquire is rejected
  // server-side), so conn.acquire does not apply to it — but such connections
  // ARE invokable via conn.invoke, which routes proxy/Composio to server-side
  // execute (no local token needed).
  'conn.acquire': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const orgId = requireOrgId();
    if (!resolveSelfMemberId(orgId)) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return postForOrg(orgId, apiPath(`/connect/connections/${connId}/credential`));
  },

  // conn.proxy — REMOVED. The old free-form client-driven proxy verb is gone;
  // server-side execution is now reached only through conn.invoke's proxy route
  // (which auto-selects it by credential_mode). Kept as an explicit tombstone so
  // an old caller gets an actionable error pointing at conn.invoke instead of a
  // silent failure — there is NO client-driven proxy HTTP path left in this module.
  'conn.proxy': () => { throw proxyDeprecatedError('conn.proxy'); },

  // Discover the named actions available for a connection (action discovery).
  // Returns [{toolkit, action, method, description, params, input_schema}];
  // pair with conn.invoke to run one by "toolkit-slug/action-name". cws-core
  // scopes discovery to the caller's own connection-agent authorization
  // boundary (derived server-side).
  //
  // Composio note: this per-connection GET is a READ-ONLY discovery call — it
  // never persists a full action catalog (no writeCatalog), so it is already safe
  // for composio (proxy) connectors, which must not carry a full on-disk catalog.
  // FLAG: cws-core added two-stage composio discovery (action search → single-
  // action describe, + application-actions pagination, MR!579), but the
  // openmax-facing route names are NOT yet visible from this repo, so we cannot
  // wire the search→describe flow without guessing paths. Until those routes are
  // confirmed, discovery stays the single per-connection call below.
  'conn.actions': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const orgId = requireOrgId();
    if (!resolveSelfMemberId(orgId)) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return getForOrg(orgId, apiPath(`/connect/connections/${connId}/actions`));
  },

  // conn.execute — REMOVED. This used to be a standalone verb that POSTed to the
  // server-side execute endpoint. That endpoint is still used — but now only via
  // conn.invoke's proxy/Composio route (POST /connect/connections/{id}/actions/
  // execute), selected automatically by credential_mode. Kept as an explicit
  // tombstone pointing at conn.invoke; no standalone execute verb remains here.
  'conn.execute': () => { throw proxyDeprecatedError('conn.execute'); },

  // Get connection details (status, owner, scopes, etc.).
  'conn.status': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const orgId = requireOrgId();
    return getForOrg(orgId, apiPath(`/connect/connections/${connId}`));
  },

  // Discover the app-keyed action catalog for an application — the full set of
  // actions the app exposes, each with its input_schema, WITHOUT needing an
  // existing connection. Returns [{toolkit, action, method, description,
  // params, input_schema}]. Unlike conn.actions (connection-scoped and gated
  // on the connection-agent authorization boundary), this is capability
  // metadata readable by any org member — use it to see what an app can do
  // before a connection exists, or to build a per-application capability cache.
  // Resolved strictly by applicationId (the BFF route keys on the path id; it
  // does not accept a slug override, so URL identity always matches the result).
  'conn.app_actions': () => {
    const appId = params.applicationId || params.application_id;
    if (!appId) throw Object.assign(new Error('applicationId is required'), { status: 400 });
    const orgId = requireOrgId();
    return getForOrg(orgId, apiPath(`/connect/applications/${appId}/actions`));
  },

  // Return the platform's OAuth callback URL — the redirect URI to register in
  // your provider's OAuth app BEFORE creating a connector. cws-core forces the
  // callback URL server-side, so a user needs this value up-front. The endpoint
  // is authed (bearer) but NOT org-scoped; we call it via getForOrg so the org's
  // JWT authenticates the request (the org scoping is harmless — the route
  // ignores it). The D8 envelope is unwrapped by the client, so this resolves to
  // the inner `{ callback_url }` object, which we return as-is (matching how the
  // sibling read verbs echo their unwrapped data).
  'conn.callback': () => {
    return getForOrg(requireOrgId(), apiPath('/connect/oauth-callback-url'));
  },

  // List the caller's org custom connector applications — the way to enumerate
  // applicationIds WITHOUT an existing connection (contrast conn.list, which is
  // connection-scoped). Org-scoped exactly like the sibling read verbs: the org
  // is derived server-side from the authenticated principal (requireOrgId only
  // selects which org's JWT to use — org_id is NEVER sent as a client param).
  // Optional {category} is appended as a query filter. The D8 envelope's `data`
  // is an ARRAY of application items (same item shape conn.app_create/app_get
  // return); the client unwraps it, so this resolves to that array as-is.
  'conn.app_list': () => {
    let path = apiPath('/connect/applications');
    if (params.category !== undefined && params.category !== null && params.category !== '') {
      path += `?category=${encodeURIComponent(params.category)}`;
    }
    return getForOrg(requireOrgId(), path);
  },

  // --- Custom-connector management: applications ----------------------------
  // Each verb validates its params locally (pure planner, throws 400), then
  // resolves the operating org and routes through the org-scoped helper. Param
  // validation runs BEFORE requireOrgId(), matching conn.acquire/conn.app_actions.

  // Create a custom connector application. org_id/oauth_callback_url are never
  // forwarded (server-derived/injected) — the planner's allowlist drops them.
  'conn.app_create': () => {
    const { path, body } = planAppCreate(params);
    const orgId = requireOrgId();
    return postForOrg(orgId, path, body);
  },

  // Update the caller's own custom connector application (ownership-gated
  // server-side; slug/provider_type are immutable and not accepted).
  'conn.app_update': () => {
    const { path, body } = planAppUpdate(params);
    const orgId = requireOrgId();
    return patchForOrg(orgId, path, body);
  },

  // --- Custom-connector management: action definitions ----------------------
  // DB-backed HTTP action definitions (distinct from the resolved capability
  // catalog conn.app_actions returns). See references/conn-operations.md for the
  // method set, url_template placeholders, encoding values, input_schema, and the
  // forbidden Authorization header.

  'conn.actiondef_list': () => {
    const { path } = planActionDefList(params);
    const orgId = requireOrgId();
    return getForOrg(orgId, path);
  },

  'conn.actiondef_create': () => {
    const { path, body } = planActionDefCreate(params);
    const orgId = requireOrgId();
    return postForOrg(orgId, path, body);
  },

  'conn.actiondef_update': () => {
    const { path, body } = planActionDefUpdate(params);
    const orgId = requireOrgId();
    return patchForOrg(orgId, path, body);
  },

  'conn.actiondef_delete': () => {
    const { path } = planActionDefDelete(params);
    const orgId = requireOrgId();
    return delForOrg(orgId, path);
  },

  // Bulk onboard a custom connector from an import JSON: create the application,
  // then loop-create each action-def, reporting per-action success/failure so a
  // partial import is visible. Mirrors the cws-fe "actions JSON import" flow.
  'conn.app_import': () => {
    if (!params.application || typeof params.application !== 'object' || Array.isArray(params.application)) {
      throw Object.assign(new Error('application object is required'), { status: 400 });
    }
    const orgId = requireOrgId();
    return runAppImport(params, {
      createApp: (body) => postForOrg(orgId, apiPath('/connect/applications'), body),
      createActionDef: (appId, body) => postForOrg(orgId, apiPath(`/connect/applications/${appId}/action-defs`), body),
    });
  },

  // Cache-aware, app-keyed action catalog. Reads runtime/connect/action-catalog/
  // first and fills it from conn.app_actions on a miss / TTL-expiry / {refresh}.
  // Accepts either {applicationId} directly, or {app} (slug or id) resolved via
  // the local connections index. Returns { applicationId, actions, fetchedAt,
  // source }.
  'conn.catalog': async () => {
    const orgId = requireOrgId();
    const agentId = resolveSelfMemberId(orgId);
    const idxPath = indexPathForOrg(orgId);
    let appId = params.applicationId || params.application_id;
    let entry = null;
    if (!appId && params.app) {
      entry = await resolveConnectionForApp(params.app, orgId, agentId);
      appId = entry?.applicationId || (isUuid(params.app) ? params.app : null);
    }
    if (!appId) throw Object.assign(new Error('applicationId (or a resolvable app) is required'), { status: 400 });
    // Decide whether to persist a full on-disk catalog. We must NEVER persist for
    // a proxy connector — so we persist ONLY when CONFIDENT the app is direct (its
    // taxonomy is known and not proxy). A LEGACY index entry that predates
    // credentialMode has UNKNOWN taxonomy: scanning it would (wrongly) look
    // non-proxy, so refresh once from conn.list (which now returns the taxonomy)
    // and re-decide. If STILL unknown after the refresh, stay conservative and do
    // NOT persist — a legacy entry could be proxy.
    // Decision inputs: the resolved entry when we have one, else the index entries
    // sharing this applicationId.
    const decide = () => {
      if (entry) return { proxy: isProxyEntry(entry), known: taxonomyKnown(entry) };
      const forApp = Object.values(readIndex(idxPath).connections || {}).filter((e) => e.applicationId === appId);
      return { proxy: forApp.some(isProxyEntry), known: forApp.some(taxonomyKnown) };
    };
    let { proxy, known } = decide();
    if (!proxy && !known && agentId) {
      await refreshIndex(orgId, agentId);
      if (entry) { const re = readIndex(idxPath).connections[entry.id]; if (re) entry = re; }
      ({ proxy, known } = decide());
    }
    // Persist only when confidently direct; proxy OR still-unknown → skip.
    return getCatalog(orgId, appId, { refresh: !!params.refresh, persist: known && !proxy });
  },

  // One-call app-keyed execute: resolve the connection for an application from
  // the local index (refreshing from conn.list on a miss), then run the named
  // action. This is the cache-aware entry meant for agents — it removes the
  // per-call discovery round-trip. Routed by the connector taxonomy recorded in
  // the index (credential_mode):
  //   - direct → LOCAL EGRESS: assemble the request from the local catalog's
  //     url_template + params, inject the locally-cached token (refreshing it on
  //     near-expiry / a provider 401), and call the provider from THIS host.
  //     Returns the provider passthrough { status_code, headers, body }.
  //   - proxy (e.g. composio) → SERVER-SIDE execute: the connection holds no
  //     local token and its acquire is rejected server-side, so we POST the
  //     action to cws-core's proxy execute endpoint, which resolves the action,
  //     injects the credential, and calls the provider. Returns the server
  //     passthrough { status_code, body } (no locally-observed response headers).
  //   - an unexpected mode → an explicit "unsupported" error (never a guess).
  // On an action/schema-shaped failure (direct path) it invalidates the cached
  // catalog once so the next conn.catalog is fresh, then resurfaces the error.
  'conn.invoke': async () => {
    // An explicit connectionId (alias connection_id) SKIPS app-resolution and
    // targets that connection directly — the one-command retry after a
    // needs_selection prompt (the user picked, we re-invoke by id). When absent,
    // resolution is app-driven and count-aware (0/1/>1).
    const explicitConnId = params.connectionId || params.connection_id;
    const app = params.app || params.applicationId || params.application_id || params.slug;
    if (!explicitConnId && !app) throw Object.assign(new Error('app (slug or applicationId) is required unless connectionId is given'), { status: 400 });
    if (!params.action) throw Object.assign(new Error('action is required (format: toolkit-slug/action-name)'), { status: 400 });
    const orgId = requireOrgId();
    const agentId = resolveSelfMemberId(orgId);
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });

    const idxPath = indexPathForOrg(orgId);
    // `let` — the credential_mode refresh below may re-read a fuller entry.
    const { entry: resolvedEntry, needsSelection } = await resolveInvokeEntry(
      { app, connectionId: explicitConnId, action: params.action },
      {
        findActives: (a) => findActiveConnectionsByApp(a, idxPath),
        findAny: (a) => findConnectionByApp(a, idxPath),
        readEntryById: (id) => readIndex(idxPath).connections[id] || null,
        refresh: () => refreshIndex(orgId, agentId),
      },
    );
    // >1 active for the app: return the candidate list (normal result, exit 0)
    // so the agent asks the user which one — never silently pick the first.
    if (needsSelection) return needsSelection;
    if (!resolvedEntry) throw Object.assign(new Error(`no connection found for app "${app}" (org ${orgId}, agent ${agentId})`), { status: 404 });
    // Mutable — the credential_mode legacy refresh below may re-read a fuller entry.
    let entry = resolvedEntry;

    // Prefer the caller's app for messages; when they invoked by connectionId
    // (no app), fall back to the resolved slug/id so hints stay meaningful.
    const appLabel = app || entry.slug || entry.id;

    // Reject ANY non-active connection BEFORE credential resolution — for BOTH
    // the app-resolved path (a 0-active fallback may surface a blocked entry) and
    // the explicit connectionId path (app-resolution bypassed). cws-connect list
    // responses can mark a connection needs_reauth / error / expired / revoked;
    // proceeding to acquire a credential for one of these fails opaquely, or worse
    // calls the provider with a dead token. needs_reauth (incl. the normalized
    // status:"error"+needs_reauth from toEntry) gets the specific re-authorize
    // hint; any other blocked status gets a generic actionable error. A reauth_needed
    // event also clears the cached credential (see connection-events.js), so an
    // acquire could not help until a human re-authorizes anyway.
    if (entry.status && entry.status !== 'active') {
      if (entry.status === 'needs_reauth') {
        throw Object.assign(
          new Error(`connection for app "${appLabel}" needs re-authorization — its credential expired or was revoked. 请到连接页点「重新授权」，完成后重试。`),
          { status: 409 },
        );
      }
      throw Object.assign(
        new Error(`connection for app "${appLabel}" is not usable (status: ${entry.status}) — it may be expired, revoked, or in an error state. Re-authorize it on the connection page, then retry.`),
        { status: 409 },
      );
    }

    // A personal-scope connector is the caller's PRIVATE credential and
    // must never execute in a group/thread conversation — only in a direct
    // message. The conversation TYPE is read from the server (the source of
    // truth) for the caller-supplied conversation_id; we deliberately do NOT
    // trust an agent-supplied "is this a group" flag. org-scope connectors are
    // shared/admin-authorized and are unaffected by this gate.
    const invokeConvId = params.conversationId || params.conversation_id || null;
    if (invokeConvId && entry.ownerScope !== 'org') {
      // A sparse WS event may have left ownerScope null; refresh once so a stale
      // index cannot mask a personal connector (mirrors the credential_mode
      // self-heal below). org entries short-circuit above and never reach here.
      if (entry.ownerScope == null) {
        await refreshIndex(orgId, agentId);
        const refreshed = readIndex(idxPath).connections[entry.id];
        if (refreshed) entry = refreshed;
      }
      if (entry.ownerScope === 'personal') {
        let convType = null;
        try {
          const conv = await getForOrg(orgId, apiPath(`/conversations/${invokeConvId}`));
          convType = conv?.type || null;
        } catch {
          // Fail closed: if the conversation type cannot be confirmed as a DM we
          // treat it as non-DM and refuse — this gate guards a real cross-user boundary.
          convType = null;
        }
        if (personalConnectorBlockedInConversation(entry.ownerScope, convType)) {
          throw Object.assign(
            new Error(`connector for app "${appLabel}" is a personal connector and cannot be used in a group conversation — personal connectors only work in your direct messages.`),
            { status: 403 },
          );
        }
      }
    }

    // Route by the connector taxonomy recorded in the index (credential_mode).
    let mode = entry.credentialMode;
    if (!mode) {
      // Stale / not-yet-refreshed entry: conn.list now returns credential_mode, so
      // refresh once and re-read — this self-heals a stale-but-valid entry. We
      // deliberately do NOT use `acquire` to detect the mode — a proxy acquire is
      // REJECTED server-side (ErrComposioNotAcquirable), so it cannot be a detector.
      // If the field is STILL absent after the refresh, the connection is a true
      // orphan (unresolvable app + no mode) and is treated as UNSUPPORTED below —
      // we never guess 'direct'.
      await refreshIndex(orgId, agentId);
      const refreshed = readIndex(idxPath).connections[entry.id];
      if (refreshed) entry = refreshed;
      mode = entry.credentialMode;
    }

    if (mode === 'proxy') {
      // Proxy (e.g. composio): no local token, no local catalog. Execute the
      // action SERVER-SIDE via cws-core's proxy execute endpoint (op
      // execute-connect-action) — cws-connect resolves the action, injects the
      // credential, and calls the provider. We never touch the credential cache
      // or getCatalog on this path. Result is the server passthrough
      // { status_code, body } (analogous to the direct path's { status_code,
      // headers, body }, minus locally-observed response headers).
      return await postForOrg(
        orgId,
        apiPath(`/connect/connections/${entry.id}/actions/execute`),
        { action: params.action, params: params.params || {} },
      );
    }

    if (mode === 'direct') {
      // Decide the path from the local credential cache, re-acquiring on a miss so
      // a direct connection with no cache file (authorized offline / runtime wiped
      // / conn.clear_cache) is not wrongly downgraded (cws-connect rejects a direct
      // connection on the proxy path with ErrDirectNotProxyable/422). See
      // resolveCredential.
      const { credential, mode: credMode } = await resolveCredential(
        { orgId, connectionId: entry.id, cached: readCredentialCache(entry.id) },
        {
          acquire: (oid, connId) => acquireCredential(oid, connId),
          saveCache: (connId, fresh) => saveCredentialCache(connId, fresh, entry.slug),
        },
      );
      if (credMode === 'direct') {
        if (!entry.applicationId) {
          throw Object.assign(new Error(`cannot run direct action for app "${appLabel}": applicationId unresolved (run conn.index {refresh:true})`), { status: 400 });
        }
        try {
          // The local catalog now carries per-action url_template/headers_template;
          // direct execution assembles the request from it (never a free-form URL).
          const catalogRec = await getCatalog(orgId, entry.applicationId, {});
          return await invokeDirect(
            { orgId, connection: entry, actionSlug: params.action, params: params.params || {}, catalog: catalogRec.actions, credential },
            {
              acquire: (oid, connId) => acquireCredential(oid, connId),
              saveCache: (connId, fresh) => saveCredentialCache(connId, fresh, entry.slug),
            },
          );
        } catch (err) {
          // Drop the cached catalog on an action/schema mismatch OR a 422 (a catalog
          // predating url_template — direct assembly can't proceed) so the agent's
          // next conn.catalog refetches. Re-thrown as-is (no auto-retry).
          if ((looksLikeActionOrSchemaError(err) || err.status === 422) && entry.applicationId) invalidateCatalog(entry.applicationId);
          throw err;
        }
      }
      // The index said direct but the acquired credential is not direct — an
      // inconsistent connection state. Fall through to the unsupported throw
      // rather than execute with a token we do not hold.
    }

    // Genuinely unexpected credential_mode (neither 'proxy' nor a direct-
    // acquirable connection). Surface an explicit, actionable error — we never
    // guess an execution path.
    throw Object.assign(
      new Error(`unsupported: connection ${entry.id} has an unexpected credential_mode (${mode}) — expected 'direct' (local egress) or 'proxy' (server-side execute).`),
      { status: 400 },
    );
  },

  // Show the local connections index for an org (observability). {refresh}
  // rebuilds it from conn.list first; {org} selects the org (default otherwise).
  'conn.index': async () => {
    const orgId = requireOrgId();
    if (params.refresh) {
      const agentId = resolveSelfMemberId(orgId);
      if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
      await refreshIndex(orgId, agentId);
    }
    const index = readIndex(indexPathForOrg(orgId));
    const connections = Object.values(index.connections);
    return { org_id: orgId, count: connections.length, connections };
  },

  // List locally cached credentials (metadata only; shared cache module).
  'conn.cached': () => {
    const entries = listCachedCredentials();
    return { count: entries.length, credentials: entries };
  },

  // Clear cached credentials (all or specific connection).
  'conn.clear_cache': () => {
    const connId = params.connectionId || params.connection_id;
    return { cleared: clearCachedCredentials(connId) };
  },
};

function printUsage() {
  console.log(`Connection CLI — cws-connect operations via cws-core BFF

Usage: node src/cli/conn.js <command> '<json-params>'

Connections
  conn.list           {}                                        # list connections available to this agent (self only)
  conn.acquire        {connectionId}                            # acquire the direct access_token for a connection
  conn.actions        {connectionId}                            # discover named actions for a connection
  conn.status         {connectionId}                            # get connection details (status, owner, scopes)

Applications
  conn.app_actions    {applicationId}                           # app-keyed action catalog (incl. input_schema; no connection needed)
  conn.app_list       {category?}                                   # list your org's custom connector applications (GET /connect/applications)
  conn.callback       {}                                        # platform OAuth callback URL to register in the provider's OAuth app

Applications (custom connector management)
  conn.app_create     {display_name, provider_type, slug?, ...} # create a custom connector application (slug optional — server-generated when omitted)
  conn.app_update     {applicationId, ...optional}              # update your own custom connector (slug/provider_type immutable; OAuth id/secret/scopes updatable)
  conn.actiondef_list   {applicationId}                         # list an app's HTTP action definitions
  conn.actiondef_create {applicationId, name, method, url_template, description, headers?, encoding?, input_schema?}  # description REQUIRED
  conn.actiondef_update {applicationId, actionId, method?, url_template?, description?, headers?, encoding?, input_schema?}
  conn.actiondef_delete {applicationId, actionId}               # delete one action definition
  conn.app_import     {application:{...}, actions:[...]}        # bulk: create app then each action-def (per-action report)
                                                                 #   never forward org_id/oauth_callback_url (server-derived);
                                                                 #   action-def Authorization header is forbidden (see reference doc)

Capability cache (runtime/connect/)
  conn.invoke         {app, action, params?}                    # app-keyed execute: resolve connection via local index → execute
                      {connectionId, action, params?}           #   or target a specific connection (skips app-resolution)
                                                                 #   >1 connections for an app → returns needs_selection (ask
                                                                 #   the user by candidate label; map the choice back to its
                                                                 #   connection_id, retry with connectionId)
  conn.catalog        {app|applicationId, refresh?}             # cached action catalog (fills from conn.app_actions on miss/TTL)
  conn.index          {refresh?}                                # show the local connections index (connection → application)

Local cache
  conn.cached         {}                                        # list locally cached credentials (direct-mode tokens)
  conn.clear_cache    {connectionId?}                           # clear cached credentials (all if no connectionId)

Environment:
  COCO_API_URL     cws-core base URL (default: http://127.0.0.1:8080)
  COCO_API_PREFIX  Path prefix override (default: /api/v1)
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

// Only run the CLI when invoked directly (node src/cli/conn.js …). Guarding this
// lets the module be imported by tests to exercise the pure helpers
// (buildNeedsSelection / resolveInvokeEntry) without executing a command.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main();
}
