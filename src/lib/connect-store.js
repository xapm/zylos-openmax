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
    status: entry.status ?? prev.status ?? 'active',
  };
  writeIndex(index, indexPath);
  return index.connections[entry.id];
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
 * Rebuild the index wholesale from a conn.list array (authoritative refresh).
 * Stale entries absent from the list are dropped by the wholesale rebuild.
 * Orphan entries are additionally SKIPPED: a connection whose app is
 * unresolvable AND whose taxonomy is unknown (`slug == null && credentialMode ==
 * null`) carries no useful discovery/routing information — it can neither be
 * resolved from an app nor routed by conn.invoke — so it must not pollute the
 * rebuilt index.
 */
export function replaceIndexFromList(list, indexPath = INDEX_PATH) {
  const connections = {};
  for (const conn of Array.isArray(list) ? list : []) {
    const entry = toEntry(conn);
    if (!entry) continue;
    if (entry.slug == null && entry.credentialMode == null) continue;
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
