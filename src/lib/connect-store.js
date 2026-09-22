/**
 * Local disk store for cws-connect capability caches, all under one subtree:
 *
 *   runtime/connect/
 *   ├── connections-index.json          # connection → application (both modes)
 *   ├── action-catalog/<applicationId>.json   # application → capability (both modes)
 *   └── credentials/<connectionId>.json  # real access_token — direct/token mode only
 *                                        #   (owned by credential-cache.js)
 *
 * This module owns the first two (the mode-agnostic *discovery* layer):
 *   - the connections index — resolve an application → its connectionId + status,
 *     the entry point of every call (the agent starts from an app, not a
 *     connection). Maintained from connection.* WS events and refreshable from
 *     `conn.list`.
 *   - the action catalog — an app-keyed cache of the action metadata
 *     (`{toolkit, action, method, description, params, input_schema}`) returned
 *     by `GET /connect/applications/{id}/actions`. Filled on demand, invalidated
 *     by TTL or an explicit refresh; the endpoint returns no version/etag today
 *     (see references/conn-operations.md) so freshness is TTL + error-driven.
 *
 * Pure filesystem I/O — no network. `conn.js` orchestrates network + store.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';
import { readCredentialCache } from './credential-cache.js';

export const CONNECT_DIR = path.join(RUNTIME_DIR, 'connect');
export const INDEX_PATH = path.join(CONNECT_DIR, 'connections-index.json');
export const CATALOG_DIR = path.join(CONNECT_DIR, 'action-catalog');

/**
 * Per-org connections index path. The comm-bridge runs a WS per enabled org and
 * connections belong to a specific org, so the index MUST be org-scoped —
 * otherwise a multi-org agent connected to the same app (e.g. notion) in two orgs
 * could resolve the wrong org's connection. The action catalog stays global
 * (keyed by applicationId) because an application's capabilities are the same
 * across orgs.
 */
export function indexPathForOrg(orgId, dir = CONNECT_DIR) {
  return path.join(dir, `connections-index.${orgId}.json`);
}

/** Default catalog freshness window: 24h. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export function ensureConnectDir(dir = CONNECT_DIR) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
//  Connections index (connectionId → application)
// ---------------------------------------------------------------------------

/** Read the index as { connections: { [connectionId]: entry } }. Missing → empty. */
export function readIndex(indexPath = INDEX_PATH) {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (data && typeof data === 'object' && data.connections && typeof data.connections === 'object') {
      return data;
    }
  } catch {}
  return { connections: {} };
}

function writeIndex(index, indexPath = INDEX_PATH) {
  ensureConnectDir(path.dirname(indexPath));
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Normalize one connection record (from a conn.list item or a connection event)
 * into the index entry shape. Returns null when there is no connection id.
 */
function toEntry(conn) {
  const id = conn.id || conn.connection_id;
  if (!id) return null;
  // Normalize a reauth-required connection to the local blocked state. Some
  // cws-connect list responses express this as status:"error" + needs_reauth:true
  // (or a bare needs_reauth flag) rather than a literal "needs_reauth" status; if
  // we stored the raw status, an "error"+needs_reauth connection would slip past
  // the conn.invoke reauth guard (which keys on status) after a list/backfill
  // refresh and reach credential resolution with a dead token. Collapse any
  // needs_reauth signal to status:"needs_reauth" so the guard always catches it.
  let status = conn.status || 'active';
  if (conn.needs_reauth === true || conn.needsReauth === true) status = 'needs_reauth';
  return {
    id,
    applicationId: conn.application_id || conn.applicationId || null,
    slug: conn.application_slug || conn.slug || conn.provider || null,
    // `name` is the APPLICATION name (e.g. "Gmail"); `displayName` is the
    // connection's user-given label (e.g. "工作邮箱") — the primary human-readable
    // way to tell two same-app connections apart, so multi-connection
    // disambiguation asks the user by a label built from it (never the id).
    name: conn.application_name || conn.name || null,
    displayName: conn.display_name || conn.displayName || null,
    // Creation time (ISO string or epoch ms), preserved so a stable, UNIQUE
    // human label can still be built for legacy connections whose display_name
    // is empty or collides with another same-app connection's.
    createdAt: conn.created_at || conn.createdAt || null,
    // Connector taxonomy (cws-connect): credential_mode is "direct" | "proxy".
    // A proxy connection holds no local token and must execute SERVER-SIDE (see
    // conn.invoke); a direct connection does local egress with a cached token.
    // conn.list / conn.status / list-available carry credential_mode; a sparse WS
    // event may not, so it defaults to null and is filled additively by a later
    // refresh.
    credentialMode: conn.credential_mode || conn.credentialMode || null,
    // Connector taxonomy (cws-connect, Route A): connector_kind is "http" | "mcp"
    // (default "http" server-side; empty is treated as http). It is orthogonal to
    // credentialMode — an MCP connector is still credential_mode=direct — and tells
    // the agent whether to materialize the connection into a local Claude Code MCP
    // server (see mcp-config.js) instead of routing per-action via conn.invoke.
    // conn.list / conn.acquire carry connector_kind; a sparse WS event may not, so
    // it defaults to null and is filled additively by a later refresh (exactly like
    // credentialMode). Kept even on the removal path so a revoke/reauth event, which
    // may not carry connector_kind, can still recognize an MCP connection and tear
    // down its local MCP server.
    connectorKind: conn.connector_kind || conn.connectorKind || null,
    // Ownership scope (cws-connect): "org" (admin-authorized, shared across the
    // org) | "personal" (the individual's own credential). Kept so conn.invoke
    // can enforce the rule that a personal connector must never execute in a group
    // conversation (a private credential triggered by other group members). Like
    // credentialMode, a sparse WS event may omit it, so it defaults to null and
    // is filled additively by a later conn.list refresh.
    ownerScope: conn.owner_scope || conn.ownerScope || null,
    status,
  };
}

/**
 * Insert/update one connection in the index. Additive on unknown fields — a
 * later, richer record (e.g. from conn.list, carrying application_id/name) fills
 * gaps left by a sparser event-sourced upsert, and never nulls known values.
 */
export function upsertConnection(conn, indexPath = INDEX_PATH) {
  const entry = toEntry(conn);
  if (!entry) return null;
  const index = readIndex(indexPath);
  const prev = index.connections[entry.id] || {};
  index.connections[entry.id] = {
    id: entry.id,
    applicationId: entry.applicationId ?? prev.applicationId ?? null,
    slug: entry.slug ?? prev.slug ?? null,
    name: entry.name ?? prev.name ?? null,
    // Additive, like the other fields: a sparse event (slug only, no
    // display_name) must never null a display_name a richer conn.list record
    // already captured.
    displayName: entry.displayName ?? prev.displayName ?? null,
    createdAt: entry.createdAt ?? prev.createdAt ?? null,
    // Additive like the rest: a sparse event (slug only, no credential_mode)
    // must never null a value a richer conn.list record already captured.
    credentialMode: entry.credentialMode ?? prev.credentialMode ?? null,
    // Additive like the rest: a sparse event (e.g. credential_updated, which does
    // not carry connector_kind) must never null a value a richer authorize event /
    // conn.list record already captured — the MCP teardown path depends on it.
    connectorKind: entry.connectorKind ?? prev.connectorKind ?? null,
    // Additive like the rest: a sparse event without owner_scope must not null
    // an ownerScope a richer conn.list record already captured.
    ownerScope: entry.ownerScope ?? prev.ownerScope ?? null,
    status: entry.status ?? prev.status ?? 'active',
  };
  writeIndex(index, indexPath);
  return index.connections[entry.id];
}

/**
 * Access decision (pure, so it can be unit-tested without any IO): may a connector
 * with this ownerScope execute in a conversation of this type?
 *
 * A **personal**-scope connector is the individual's own credential; it may run
 * ONLY in a confirmed direct message. Anything not confirmed `"dm"` — a group, a
 * thread, or an unknown/failed type — blocks it, so a private credential can
 * never be triggered by other members of a shared conversation. **org**-scope
 * (shared, admin-authorized) and unknown-scope connectors are not blocked here.
 *
 * Fail-closed on purpose: the caller passes the type it read from the server for
 * this conversation_id, and if that could not be confirmed to be a DM we refuse
 * rather than leak. Returns true when the connector must be REJECTED.
 */
export function personalConnectorBlockedInConversation(ownerScope, convType) {
  if (ownerScope !== 'personal') return false;
  return (convType || '').toLowerCase() !== 'dm';
}

/** Remove one connection from the index (idempotent). */
export function removeConnection(connectionId, indexPath = INDEX_PATH) {
  const index = readIndex(indexPath);
  if (index.connections[connectionId]) {
    delete index.connections[connectionId];
    writeIndex(index, indexPath);
    return true;
  }
  return false;
}

/**
 * Re-derive a connection's connectorKind when the authoritative list omits it.
 * conn.list (/connect/agents/me/connections) may NOT carry connector_kind, so a
 * naive wholesale rebuild would null it — but the MCP teardown path (revoke /
 * reauth events read ONLY the index) depends on it, so nulling it orphans the
 * local MCP server (Problem ②). Recover it, in order, from:
 *   1. the PREVIOUS index entry (authorize/acquire already wrote connectorKind),
 *   2. else the per-connection credential FILE, which still carries
 *      `connector_kind` (saved verbatim from the Acquire response).
 * Returns null only when no local source knows it (a legacy/http connection).
 */
function deriveConnectorKind(id, prevConnections, credentialsDir) {
  const prev = prevConnections && prevConnections[id];
  if (prev && prev.connectorKind != null) return prev.connectorKind;
  try {
    const cred = credentialsDir !== undefined ? readCredentialCache(id, credentialsDir) : readCredentialCache(id);
    const k = cred && (cred.connector_kind ?? cred.connectorKind);
    if (k != null) return k;
  } catch { /* no credential file — fall through to null */ }
  return null;
}

/**
 * Rebuild the index wholesale from a conn.list array (authoritative refresh).
 * Stale entries absent from the list are dropped by the wholesale rebuild.
 * Orphan entries are additionally SKIPPED: a connection whose app is
 * unresolvable AND whose taxonomy is unknown (`slug == null && credentialMode ==
 * null`) carries no useful discovery/routing information — it can neither be
 * resolved from an app nor routed by conn.invoke — so it must not pollute the
 * rebuilt index.
 *
 * connectorKind is NEVER nulled by a refresh (Problem ②): when the list item
 * omits connector_kind, the value is re-derived from the previous index entry or
 * the per-connection credential file (see deriveConnectorKind). An EXPLICIT
 * connector_kind in the list always wins (so a genuine change still applies).
 * `opts.credentialsDir` overrides where credential files are read (tests / dir
 * injection); production uses the default CREDENTIALS_DIR.
 */
export function replaceIndexFromList(list, indexPath = INDEX_PATH, { credentialsDir } = {}) {
  const prev = readIndex(indexPath).connections;
  const connections = {};
  for (const conn of Array.isArray(list) ? list : []) {
    const entry = toEntry(conn);
    if (!entry) continue;
    if (entry.slug == null && entry.credentialMode == null) continue;
    if (entry.connectorKind == null) {
      entry.connectorKind = deriveConnectorKind(entry.id, prev, credentialsDir);
    }
    connections[entry.id] = entry;
  }
  writeIndex({ connections }, indexPath);
  return connections;
}

/**
 * Resolve an application → its connection entry. `app` may be an application
 * slug (e.g. "notion") or an applicationId (UUID). Prefers an active connection
 * when several match. Returns null when nothing matches.
 */
export function findConnectionByApp(app, indexPath = INDEX_PATH) {
  if (!app) return null;
  const entries = Object.values(readIndex(indexPath).connections);
  const matches = entries.filter((e) => e.slug === app || e.applicationId === app);
  if (matches.length === 0) return null;
  return matches.find((e) => e.status === 'active') || matches[0];
}

/**
 * Resolve an application → ALL of its ACTIVE connection entries (an array). Like
 * findConnectionByApp but returns every active match instead of collapsing to
 * one — the input to multi-connection disambiguation: 0 → resolve/404, exactly
 * 1 → use it, >1 → the caller must ask the user which one (by each
 * candidate's `label`; the agent then maps the choice back to that
 * candidate's `connection_id` and retries with `connectionId`).
 * Non-active entries (e.g. needs_reauth) are excluded so they never count as a
 * selectable candidate. `app` may be a slug or an applicationId.
 */
export function findActiveConnectionsByApp(app, indexPath = INDEX_PATH) {
  if (!app) return [];
  const entries = Object.values(readIndex(indexPath).connections);
  return entries.filter(
    (e) => (e.slug === app || e.applicationId === app) && e.status === 'active',
  );
}

/**
 * List every PER-ORG connections index file in the connect dir.
 *
 * The connections index is org-scoped — one `connections-index.<orgId>.json` per
 * org (see indexPathForOrg) — but the action catalog is GLOBAL (one
 * `action-catalog/<applicationId>.json` shared across all orgs, because an app's
 * capabilities are identical everywhere). Any cross-org decision — chiefly
 * whether dropping one org's connection may invalidate the shared catalog — must
 * therefore consult ALL org indexes, not just the caller's. Missing dir → [].
 * The legacy single-file INDEX_PATH ("connections-index.json", no `<orgId>`
 * segment) is intentionally excluded: it is the non-org-scoped default and never
 * coexists with the per-org files in a real multi-org runtime.
 */
export function listIndexPaths(dir = CONNECT_DIR) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /^connections-index\..+\.json$/.test(n))
    .map((n) => path.join(dir, n));
}

/**
 * Count connections referencing an applicationId across ALL org indexes,
 * optionally excluding one connectionId (the connection being torn down). This
 * reference-counts the GLOBAL action catalog: the revoke/disconnect handler may
 * invalidate action-catalog/<applicationId>.json ONLY when this returns 0 (no
 * OTHER org still has a connection to the app) — otherwise clearing it on one
 * org's revoke would wrongly wipe the shared cache the other orgs still use.
 *
 * Any surviving connection referencing the app counts (not only status:"active"):
 * an org whose connection is e.g. needs_reauth still references the app and can
 * re-warm/consume the shared catalog, so the safe rule is to RETAIN while any
 * reference remains. `dir` selects the connect dir (tests inject a temp dir;
 * production uses CONNECT_DIR).
 */
export function countConnectionsForApp(applicationId, { dir = CONNECT_DIR, excludeConnectionId = null } = {}) {
  if (!applicationId) return 0;
  let count = 0;
  for (const idxPath of listIndexPaths(dir)) {
    const conns = readIndex(idxPath).connections;
    for (const [id, entry] of Object.entries(conns)) {
      if (id === excludeConnectionId) continue;
      if (entry && entry.applicationId === applicationId) count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
//  Action catalog (applicationId → capability metadata)
// ---------------------------------------------------------------------------

export function catalogPath(applicationId, dir = CATALOG_DIR) {
  return path.join(dir, `${applicationId}.json`);
}

/**
 * Read a cached catalog for an application. Returns { applicationId, actions,
 * fetchedAt } when present, else null. When `ttlMs` is given, a record older
 * than it is treated as a miss (returns null) so the caller refetches.
 */
export function readCatalog(applicationId, { ttlMs, dir = CATALOG_DIR, now = Date.now() } = {}) {
  try {
    const rec = JSON.parse(fs.readFileSync(catalogPath(applicationId, dir), 'utf8'));
    if (!rec || !Array.isArray(rec.actions)) return null;
    if (ttlMs != null && rec.fetchedAt && now - rec.fetchedAt > ttlMs) return null;
    return rec;
  } catch {
    return null;
  }
}

/** Persist an application's action catalog. `now` stamps fetchedAt (for TTL). */
export function writeCatalog(applicationId, actions, { dir = CATALOG_DIR, now = Date.now() } = {}) {
  ensureConnectDir(dir);
  const rec = { applicationId, fetchedAt: now, actions: Array.isArray(actions) ? actions : [] };
  fs.writeFileSync(catalogPath(applicationId, dir), JSON.stringify(rec, null, 2));
  return rec;
}

/** Drop one application's cached catalog (idempotent). */
export function invalidateCatalog(applicationId, dir = CATALOG_DIR) {
  try { fs.unlinkSync(catalogPath(applicationId, dir)); return true; } catch { return false; }
}
