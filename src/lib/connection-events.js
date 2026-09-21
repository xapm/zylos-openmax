/**
 * Connection events — cws-connect credential lifecycle.
 *
 * Extracted out of comm-bridge.js (which has side-effecting top-level startup
 * code — WS connections, timers, signal handlers — that makes it unsafe to
 * import in a test) so this logic is independently testable. HTTP calls
 * (`post`/`get`) are injectable with production defaults, matching the same
 * dependency-injection shape already used by connect-store.js/credential-cache.js
 * (both accept an optional `dir` param) and channel-connector.js
 * (createChannelInstaller takes injected functions).
 */

import { getForOrg, postForOrg, apiPath } from './client.js';
import {
  upsertConnection,
  removeConnection,
  indexPathForOrg,
  readIndex,
  replaceIndexFromList,
  writeCatalog,
  invalidateCatalog,
  countConnectionsForApp,
} from './connect-store.js';
import { saveCredentialCache, deleteCredentialCache, hasCredentialCache } from './credential-cache.js';
import { upsertMcpServer, removeMcpServer, isMcpConnection } from './mcp-config.js';

// cws-core derives the caller's identity from the authenticated principal for
// this endpoint (security fix, 2026-08-04) — agent_member_id is no longer a
// client-supplied query param, so this never sends one.
export async function acquireCredential(orgId, connectionId, { post = postForOrg } = {}) {
  return post(orgId, apiPath(`/connect/connections/${connectionId}/credential`));
}

export function isEventForMe(data, selfMemberId) {
  if (data.agent_member_id) return data.agent_member_id === selfMemberId;
  if (Array.isArray(data.agent_member_ids)) return data.agent_member_ids.includes(selfMemberId);
  return true;
}

// The connection.authorized event carries only connection_id + provider
// (slug) — not the application_id or display name — so a thin index upsert
// leaves application_id/name null (a nameless card in the UI until the next
// conn.list). Resolves the full identity from the authoritative
// agent-connections list, and warms the app's action-catalog cache so the app
// is invokable immediately after authorize instead of paying a lazy fetch on
// first use. cws-core derives the caller from the authenticated principal for
// this endpoint too (security fix, 2026-08-04) — no id in the path.
export async function warmIdentityAndCatalog(orgId, connectionId, idxPath, { get = getForOrg, catalogDir, credentialsDir } = {}) {
  const list = await get(orgId, apiPath('/connect/agents/me/connections'));
  // Pass credentialsDir so the wholesale rebuild can re-derive an omitted
  // connector_kind from the per-connection credential file (Problem ②) — the
  // agent-connections list may not carry connector_kind.
  replaceIndexFromList(Array.isArray(list) ? list : (list?.connections || []), idxPath, { credentialsDir });
  const entry = readIndex(idxPath)?.connections?.[connectionId];
  const applicationId = entry?.applicationId;
  if (!applicationId) return { applicationId: null, actionCount: 0 };
  // Proxy connectors expose a very large action space and are executed
  // SERVER-SIDE (no local egress), so we never persist a full local catalog for
  // them — discovery is on-demand (see conn.actions / getCatalog proxy path).
  if (entry.credentialMode === 'proxy') {
    return { applicationId, actionCount: 0, skippedCatalog: true };
  }
  const res = await get(orgId, apiPath(`/connect/applications/${applicationId}/actions`));
  const actions = Array.isArray(res) ? res : (res?.actions || []);
  writeCatalog(applicationId, actions, catalogDir !== undefined ? { dir: catalogDir } : undefined);
  return { applicationId, actionCount: actions.length };
}

// -----------------------------------------------------------------------------
// Per-connection lifecycle serialization.
//
// comm-bridge dispatches connection.* handlers fire-and-forget (no await), so two
// events for the SAME connection could otherwise run concurrently — e.g. a slow
// credential_updated (refresh) awaiting Acquire/CLI while a later revoked runs to
// completion, then the stale refresh resumes and re-adds the MCP server + index
// entry the revoke just removed (an orphaned server, a resurrected connection).
//
// We chain each connection's handlers through a per-key promise queue: a new
// event's work runs only after the previous event for the SAME key settles, so
// they execute one-at-a-time in ARRIVAL order. The key is org + connection_id, so
// different connections (and different orgs) still run fully in parallel — this is
// NEVER a global lock. Best-effort: a handler rejection never poisons the chain
// (the next event still runs), and a settled tail is pruned so the map cannot grow
// unbounded.
// -----------------------------------------------------------------------------
const _connectionEventChains = new Map();

/** The per-(org+connection) serialization key. */
export function connectionEventKey(orgConfig, connectionId) {
  const org = (orgConfig && (orgConfig.org_id || orgConfig.slug)) || '';
  return `${org}:${connectionId}`;
}

/**
 * Run `task` chained after any in-flight/queued task for the SAME `key`, so tasks
 * with the same key never overlap and run in arrival order. Different keys run in
 * parallel. Returns the promise for this task's run.
 */
export function serializeConnectionEvent(key, task) {
  const prev = _connectionEventChains.get(key) || Promise.resolve();
  // Gate on the previous handler's COMPLETION (settle), swallowing its outcome so
  // one failure never breaks ordering for the next event on this key.
  const run = prev.then(() => task(), () => task());
  _connectionEventChains.set(key, run);
  // Prune once this is still the current tail and it has settled — keeps the map
  // bounded without dropping a chain a later event has already extended. Handle
  // BOTH outcomes here (not `.finally`, whose derived promise would re-throw a
  // rejecting task's error as an unhandledRejection) so pruning never leaks.
  const prune = () => { if (_connectionEventChains.get(key) === run) _connectionEventChains.delete(key); };
  run.then(prune, prune);
  return run;
}

/**
 * Serialized entry point for the comm-bridge dispatch. Same contract as
 * handleConnectionEvent, but chained per (org + connection_id) so two events for
 * the SAME connection never run concurrently (events for different connections /
 * orgs still run in parallel). Returns the promise for the chained handler run.
 */
export function handleConnectionEventSerialized(orgConfig, frame, deps = {}) {
  const connectionId = frame?.payload?.data?.connection_id;
  // No connection_id to serialize on → run directly (handleConnectionEvent
  // warn+skips on the missing id anyway).
  if (!connectionId) return handleConnectionEvent(orgConfig, frame, deps);
  return serializeConnectionEvent(
    connectionEventKey(orgConfig, connectionId),
    () => handleConnectionEvent(orgConfig, frame, deps),
  );
}

/**
 * Handle a `connection.*` event from cws-comm.
 * @param {object} orgConfig
 * @param {object} frame
 * @param {object} [deps] - injectable dependencies (production defaults):
 *   log, warn, post (postForOrg), get (getForOrg), connectDir (indexPathForOrg's
 *   dir override), credentialsDir (credential-cache's dir override), catalogDir
 *   (writeCatalog's dir override), mcpExecFile (command runner injected into the
 *   MCP sink — see mcp-config.js), mcpCwd (agent launch cwd override for the sink)
 */
export async function handleConnectionEvent(orgConfig, frame, deps = {}) {
  const {
    log = () => {}, warn = () => {}, post = postForOrg, get = getForOrg,
    connectDir, credentialsDir, catalogDir, notify = () => {}, notifyReauth = () => {},
    mcpExecFile, mcpCwd,
  } = deps;
  // Deps forwarded to the Route-A MCP sink. execFile/cwd are undefined in
  // production (mcp-config.js supplies its real defaults) and injected in tests;
  // log/warn always flow through so sink output shares this handler's channel.
  const mcpDeps = { execFile: mcpExecFile, cwd: mcpCwd, log, warn };
  const { event, data } = frame.payload || {};
  if (!event || !data) return;

  const slug = orgConfig.slug;
  const selfId = orgConfig.self?.member_id;
  const connectionId = data.connection_id;

  if (!connectionId) {
    warn(`[${slug}] connection event ${event}: missing connection_id`);
    return;
  }

  if (!isEventForMe(data, selfId)) {
    log(`[${slug}] connection event ${event} not for us (conn=${connectionId}), skip`);
    return;
  }

  const orgId = orgConfig.org_id;

  // Record the connection in this org's local index (connection → application)
  // for both modes. The index is org-scoped — the comm-bridge runs a WS per org,
  // and a multi-org agent must not resolve one org's connection under another.
  const idxPath = connectDir !== undefined ? indexPathForOrg(orgId, connectDir) : indexPathForOrg(orgId);
  const indexConn = {
    connection_id: connectionId,
    application_id: data.application_id,
    application_slug: data.provider,
    // Connector taxonomy, when the event carries it (connection.authorized does;
    // credential_updated does not). Undefined → toEntry normalizes to null and the
    // additive upsert leaves any richer value untouched; the authoritative fill is
    // the conn.list refresh (replaceIndexFromList) below / on the next list.
    credential_mode: data.credential_mode,
    // Connector taxonomy (Route A), when the event carries it. Threaded into the
    // index additively (like credential_mode) so the removal path — revoke /
    // reauth events that may NOT carry connector_kind — can still recognize an MCP
    // connection and tear down its local MCP server. The authoritative fill is the
    // conn.list refresh / the Acquire response below.
    connector_kind: data.connector_kind,
    status: 'active',
  };

  switch (event) {
    case 'connection.authorized': {
      const mode = data.credential_mode || '?';
      log(`[${slug}] connection.authorized conn=${connectionId} mode=${mode}`);
      upsertConnection(indexConn, idxPath);
      // Two working execution models, keyed by credential_mode:
      //   - direct → cache the real access_token locally; conn.invoke does LOCAL
      //     egress with it.
      //   - proxy → NO local token: the credential lives server-side and `acquire`
      //     is rejected, so we correctly SKIP the local credential — but the
      //     connection IS invokable via conn.invoke, which executes the action
      //     SERVER-SIDE. Not an error.
      // Only a genuinely unknown/legacy non-direct, non-proxy mode is unsupported.
      // An unexpected connection from the backend must never crash the event
      // handler — just skip + log.
      // Hoisted so the post-refresh index persistence below (which must run AFTER
      // warmIdentityAndCatalog's wholesale replaceIndexFromList) can see the
      // Acquire-derived MCP taxonomy.
      let acquiredCred = null;
      if (data.credential_mode === 'direct') {
        try {
          acquiredCred = await acquireCredential(orgId, connectionId, { post });
          saveCredentialCache(connectionId, acquiredCred, data.provider, credentialsDir);
          log(`[${slug}] direct credential acquired + cached conn=${connectionId} provider=${data.provider || '?'}`);
          // Route A sink: an MCP connector is a direct-mode connection whose Acquire
          // response carries connector_kind="mcp" + a structured mcp_server. Rather
          // than route it per-action through conn.invoke, materialize it into a live
          // local Claude Code MCP server so the runtime's own MCP host connects,
          // discovers, and calls its tools. The Acquire response is authoritative
          // (the WS event may not carry connector_kind). upsertMcpServer is
          // best-effort and never throws, so it cannot break the credential path.
          if (isMcpConnection(acquiredCred)) {
            const r = await upsertMcpServer({ id: connectionId, slug: data.provider }, acquiredCred, mcpDeps);
            if (r && r.ok) log(`[${slug}] MCP server materialized conn=${connectionId} name=${r.name}`);
          }
        } catch (e) {
          warn(`[${slug}] credential acquire failed conn=${connectionId}: ${e.message}`);
        }
      } else if (data.credential_mode === 'proxy') {
        log(`[${slug}] proxy connection conn=${connectionId} mode=${data.credential_mode || '?'} provider=${data.provider || '?'} — server-side execute; no local credential cached (invokable via conn.invoke)`);
      } else {
        warn(`[${slug}] non-direct connection conn=${connectionId} mode=${data.credential_mode || '?'} provider=${data.provider || '?'} — unknown/legacy mode; skipping local credential (this connection is not invokable via conn.invoke)`);
      }
      // Best-effort: any failure here never breaks the credential/index path above.
      let applicationId = null;
      let actionCount = 0;
      try {
        ({ applicationId, actionCount } = await warmIdentityAndCatalog(orgId, connectionId, idxPath, { get, catalogDir, credentialsDir }));
        if (applicationId) {
          log(`[${slug}] identity resolved + action-catalog warmed conn=${connectionId} app=${applicationId} actions=${actionCount}`);
        }
      } catch (e) {
        warn(`[${slug}] identity/catalog warm failed conn=${connectionId}: ${e.message}`);
      }
      // (P1-2) Persist the Acquire-derived MCP taxonomy into the index AFTER the
      // warm refresh. warmIdentityAndCatalog rebuilds the index wholesale from the
      // agent-connections list (replaceIndexFromList), which may NOT carry
      // connector_kind — so an MCP server we just materialized would leave the
      // index entry connectorKind:null, and teardown (revoke/disconnect/reauth,
      // which read ONLY the index) would never remove it → an orphaned local MCP
      // server holding a dead token. Writing the Acquire-authoritative
      // connector_kind here (additively — it fills the null without nulling
      // slug/app/mode) guarantees a later teardown recognizes it as MCP.
      if (isMcpConnection(acquiredCred)) {
        try {
          upsertConnection({
            connection_id: connectionId,
            application_slug: data.provider,
            connector_kind: acquiredCred.connector_kind,
            credential_mode: acquiredCred.credential_mode,
          }, idxPath);
        } catch (e) {
          warn(`[${slug}] MCP taxonomy persist failed conn=${connectionId}: ${e.message}`);
        }
      }
      // Surface the new capability to the agent session: without this a bot only
      // learns a connection exists if it happens to run conn.list. On authorize we
      // proactively notify it so it can act via conn.* right away. Best-effort —
      // a notify failure never breaks the credential/index/catalog path above.
      try {
        notify({ connectionId, provider: data.provider, applicationId, actionCount, mode });
      } catch (e) {
        warn(`[${slug}] connection.authorized notify failed conn=${connectionId}: ${e.message}`);
      }
      break;
    }

    case 'connection.revoked':
    case 'connection.disconnected': {
      log(`[${slug}] ${event} conn=${connectionId}`);
      // Recognize an MCP connection from the local index BEFORE we drop it — the
      // revoke/disconnect event does not carry connector_kind, so the additively
      // threaded index entry is our only local signal. Tear down its local MCP
      // server (best-effort) so the agent no longer holds it. Read + capture the
      // entry first; removeConnection deletes it right after.
      const existingEntry = readIndex(idxPath).connections[connectionId];
      const wasMcp = isMcpConnection(existingEntry);
      const removedSlug = existingEntry?.slug || data.provider;
      // Resolve the applicationId for the catalog cleanup BEFORE removeConnection
      // deletes the index entry. Prefer the event's application_id when it carries
      // one, else fall back to the captured index entry (a sparse revoke/disconnect
      // event usually carries no application_id). The action-catalog is app-keyed
      // (connect-store.js), so without this the local action-catalog/<appId>.json
      // survives the revoke and leaves orphaned capability metadata behind — the
      // same cleanup the execute-time 422 path already performs (conn.js).
      const applicationId = data.application_id || existingEntry?.applicationId || null;
      removeConnection(connectionId, idxPath);
      deleteCredentialCache(connectionId, credentialsDir);
      // Catalog cleanup is ORG-AWARE / reference-counted. The action-catalog is
      // GLOBAL (action-catalog/<applicationId>.json is shared across every org —
      // the index is per-org, the catalog is not), so a revoke in ONE org must
      // NOT wipe the shared catalog while ANOTHER org still has a connection to
      // the same app. removeConnection already deleted THIS connection's entry
      // from this org's index; countConnectionsForApp then scans ALL org indexes
      // (excludeConnectionId is belt-and-suspenders in case the entry lingered)
      // and only a zero count — this was the last connection to the app across
      // every org — permits the delete.
      //
      // Null-guard: if the applicationId can't be resolved (sparse event + no
      // index entry), skip the catalog delete rather than throw. invalidateCatalog
      // is idempotent and app-keyed; its `dir` override is positional (catalogDir,
      // undefined in production → the default CATALOG_DIR).
      if (applicationId) {
        const others = countConnectionsForApp(applicationId, { dir: connectDir, excludeConnectionId: connectionId });
        if (others === 0) {
          invalidateCatalog(applicationId, catalogDir);
          log(`[${slug}] connection unindexed + credential cache cleared + action-catalog invalidated conn=${connectionId} app=${applicationId} (last connection across all orgs)`);
        } else {
          log(`[${slug}] connection unindexed + credential cache cleared conn=${connectionId} app=${applicationId} (action-catalog retained — ${others} other connection(s) in other orgs still use this app)`);
        }
      } else {
        log(`[${slug}] connection unindexed + credential cache cleared conn=${connectionId} (applicationId unresolved — catalog cache left as-is)`);
      }
      if (wasMcp) {
        const r = await removeMcpServer({ id: connectionId, slug: removedSlug }, mcpDeps);
        if (r && r.ok) log(`[${slug}] MCP server removed conn=${connectionId} name=${r.name}`);
      }
      break;
    }

    case 'connection.credential_updated': {
      log(`[${slug}] credential_updated conn=${connectionId}`);
      // The upstream credential_updated event does NOT carry credential_mode, so
      // we cannot gate on it. Only direct/token-mode connections keep a local
      // credential file, so "a cache file exists" is BOTH our direct-detector AND
      // a liveness signal: a revoke/disconnect/reauth clears the cache (and, for
      // revoke/disconnect, the index entry), so a credential_updated that arrives
      // after — or loses the race to — such an event finds NO cache and must be a
      // complete no-op. Gating the WHOLE body on it (the index upsert included)
      // means a stale/late refresh never resurrects the index entry or the local
      // MCP server for a connection that has been revoked. Proxy-mode connections
      // have no file and are likewise skipped (no wasted acquire).
      if (!hasCredentialCache(connectionId, credentialsDir)) {
        log(`[${slug}] credential_updated: no local credential conn=${connectionId} — proxy or already revoked, skip`);
        break;
      }
      // Additively record/refresh the index for this still-live connection.
      upsertConnection(indexConn, idxPath);
      try {
        const cred = await acquireCredential(orgId, connectionId, { post });
        // FENCE (belt-and-suspenders with per-connection serialization): a
        // revoke/disconnect/reauth may have removed or inactivated this connection
        // while the Acquire was in flight (handlers dispatch fire-and-forget). This
        // refresh is now STALE — re-materializing the MCP server would orphan it
        // (revoke already removed it and will not run again), and re-persisting the
        // index would resurrect a revoked connection. Re-read the index and bail if
        // the connection is gone or no longer active.
        const live = readIndex(idxPath).connections[connectionId];
        if (!live || live.status !== 'active') {
          log(`[${slug}] credential_updated: connection removed/inactivated during acquire conn=${connectionId} — skipping stale refresh`);
          break;
        }
        if (cred?.credential_mode === 'direct') {
          saveCredentialCache(connectionId, cred, data.provider, credentialsDir);
          log(`[${slug}] direct credential re-acquired conn=${connectionId} provider=${data.provider || '?'}`);
          // Route A refresh: an MCP connection's token was rotated — re-materialize
          // its local MCP server so the registered Authorization header carries the
          // fresh token (upsert = remove-then-add). Best-effort; never throws.
          if (isMcpConnection(cred)) {
            // Name the refreshed server from the STABLE slug in the connections
            // index (keyed by connection_id) — exactly the source authorized
            // persisted and revoked reads — NOT data.provider. The REAL upstream
            // credential_updated event carries no provider, so data.provider would
            // fall back to `openmax-mcp-<id>`, a DIFFERENT name than the originally
            // registered `openmax-<slug>-<id>`: refresh would then add a mis-named
            // server and revoke (which uses the index slug) could never remove it,
            // orphaning the server carrying the fresh token. The additive upsert
            // above never nulls the slug, so the index still holds the original.
            // Mirror revoked's best-effort fallback (index slug || data.provider).
            const refreshSlug = readIndex(idxPath).connections[connectionId]?.slug || data.provider;
            const r = await upsertMcpServer({ id: connectionId, slug: refreshSlug }, cred, mcpDeps);
            if (r && r.ok) log(`[${slug}] MCP server refreshed conn=${connectionId} name=${r.name}`);
            // (P1-2) Persist the Acquire-derived MCP taxonomy so a later teardown
            // recognizes it (the credential_updated event carries no connector_kind).
            // Additive — fills connectorKind without nulling other index fields.
            upsertConnection({
              connection_id: connectionId,
              application_slug: data.provider,
              connector_kind: cred.connector_kind,
              credential_mode: cred.credential_mode,
            }, idxPath);
          }
        } else {
          deleteCredentialCache(connectionId, credentialsDir);
          log(`[${slug}] connection no longer direct; dropped stale credential conn=${connectionId}`);
        }
      } catch (e) {
        warn(`[${slug}] credential re-acquire failed conn=${connectionId}: ${e.message}`);
      }
      break;
    }

    case 'connection.reauth_needed': {
      warn(`[${slug}] reauth_needed conn=${connectionId} app=${data.application_id || '?'} trigger=${data.trigger || '?'}`);
      // Recognize an MCP connection from the local index (the reauth event does not
      // carry connector_kind) before we mutate the entry. The connection stays
      // indexed (flagged needs_reauth), but its local MCP server must go: its token
      // is now dead and a re-acquire cannot help until a human re-authorizes, so the
      // agent should not keep a stale server registered. Removed (best-effort) below.
      const reauthEntry = readIndex(idxPath).connections[connectionId];
      const reauthWasMcp = isMcpConnection(reauthEntry);
      const reauthSlug = reauthEntry?.slug || data.provider;
      // Stop calling the provider with a now-dead credential: drop the local
      // cache so conn.invoke never assembles a request with a stale token, and a
      // re-acquire cannot help until a human re-authorizes. Proxy-mode
      // connections have no local file — deleteCredentialCache is a no-op there.
      deleteCredentialCache(connectionId, credentialsDir);
      // Unlike revoked/disconnected (which fully removeConnection), a reauth is
      // recoverable — keep the connection INDEXED but flagged needs_reauth, so
      // conn.invoke can still resolve it and surface an actionable "re-authorize"
      // hint instead of a bare 404. status is the only field forced;
      // application_id/slug/name are carried forward additively by the upsert.
      upsertConnection({ ...indexConn, status: 'needs_reauth' }, idxPath);
      log(`[${slug}] credential cache cleared + connection flagged needs_reauth conn=${connectionId}`);
      if (reauthWasMcp) {
        const r = await removeMcpServer({ id: connectionId, slug: reauthSlug }, mcpDeps);
        if (r && r.ok) log(`[${slug}] MCP server removed (needs_reauth) conn=${connectionId} name=${r.name}`);
      }
      // Notify the owner (real DM) so a human can re-authorize. Best-effort — a
      // notify failure never breaks the cache-clear/flag path above.
      try {
        notifyReauth({ connectionId, provider: data.provider, applicationId: data.application_id, trigger: data.trigger });
      } catch (e) {
        warn(`[${slug}] reauth_needed notify failed conn=${connectionId}: ${e.message}`);
      }
      break;
    }

    default:
      warn(`[${slug}] unknown connection event: ${event}`);
  }
}

/**
 * Build the proactive `🔌 [Connection authorized]` session-notice text.
 *
 * Pure string builder (no I/O) so it is unit-testable; comm-bridge.js wraps it
 * with the control-queue enqueue. The notice matches conn.invoke's routing — two
 * working execution models are both presented as USABLE; only a genuinely
 * unknown/legacy mode is flagged not-usable.
 *
 *   - direct → self-trigger: the token is already cached locally and the agent
 *     makes the request from its OWN egress (conn.invoke assembles + sends it).
 *     Tell the agent it is ready to use now.
 *   - proxy → server-side execute: no local token is held; conn.invoke runs the
 *     action SERVER-SIDE. Still USABLE — tell the agent it is ready and hint
 *     conn.invoke (executed server-side, no local token needed).
 *   - unknown/legacy non-direct, non-proxy mode → NOT invokable: do NOT present
 *     it as usable and do NOT hint conn.invoke; say it must be recreated /
 *     re-authorized before it can be used.
 *
 * @param {object} orgConfig - needs slug
 * @param {object} info      - { connectionId, provider, actionCount, mode }
 * @returns {string} the notice body
 */
export function buildConnectionAuthorizedNotice(orgConfig, info = {}) {
  const { connectionId, provider, actionCount, mode } = info;
  const app = provider || 'a third-party app';
  const modeNote = mode && mode !== '?' ? `, ${mode} mode` : '';
  const appHint = provider ? ` {app:"${provider}"}` : '';
  if (mode === 'direct') {
    const actionsNote = Number.isInteger(actionCount) && actionCount > 0 ? `, ~${actionCount} actions` : '';
    const callNote = `the token is ready locally — conn.catalog${appHint} to find actions and conn.invoke {app, action, params} to call; you make the request from your own egress`;
    return (
      `🔌 [Connection authorized] A new third-party connection was authorized to you: ${app} (org ${orgConfig.slug}${modeNote}${actionsNote}). `
      + `You can use it now — no install needed: conn.list to see it, ${callNote}. connection_id=${connectionId || '?'}.`
    );
  }
  // Proxy: no local token, but fully USABLE — the action executes server-side.
  // Present it as ready and hint conn.invoke, distinct from direct only in that
  // the request runs server-side (no local egress / cached token).
  if (mode === 'proxy') {
    const callNote = `conn.catalog${appHint} to find actions and conn.invoke {app, action, params} to call; the action runs server-side (no local token needed)`;
    return (
      `🔌 [Connection authorized] A new third-party connection was authorized to you: ${app} (org ${orgConfig.slug}${modeNote}). `
      + `You can use it now — no install needed: conn.list to see it, ${callNote}. connection_id=${connectionId || '?'}.`
    );
  }
  // Unknown/legacy non-direct, non-proxy mode: NOT invokable. Do NOT present it
  // as usable and do NOT hint conn.invoke — conn.invoke will reject it.
  return (
    `🔌 [Connection authorized] A legacy non-direct connection was authorized to you: ${app} (org ${orgConfig.slug}${modeNote}). `
    + `This connection mode is not usable — conn.invoke will reject it. `
    + `To use ${app}, it must be recreated / re-authorized as a direct or proxy (server-side execute) connection. connection_id=${connectionId || '?'}.`
  );
}

/**
 * DM the org owner that a connection needs re-authorization (P0 reauth handling).
 *
 * A real DM (not a session-level control inject like notifyConnectionAuthorized):
 * opens/gets the owner DM conversation, then posts a concise, human-actionable
 * message. Lives here rather than in comm-bridge.js so it is unit testable —
 * `post` (postForOrg) is injectable, matching the DI shape of the rest of this
 * module; comm-bridge.js has import-time side effects and cannot be loaded in a
 * test. Returns `{ sent, ... }` and never throws for the expected no-owner case;
 * the comm-bridge wrapper handles logging + swallows unexpected HTTP failures.
 *
 * @param {object} orgConfig - needs org_id + owner.member_id
 * @param {object} info      - { connectionId, provider, applicationId, trigger }
 * @param {object} [deps]    - { post = postForOrg }
 */
export async function sendOwnerReauthDm(orgConfig, info = {}, { post = postForOrg } = {}) {
  const ownerId = orgConfig.owner?.member_id;
  if (!ownerId) return { sent: false, reason: 'no-owner' };
  const orgId = orgConfig.org_id;
  const app = info.provider || info.applicationId || 'a connection';
  // Open (or fetch the existing) owner DM. cws-core derives caller + org from the
  // JWT, so only peer_member_id is sent.
  const conv = await post(orgId, apiPath('/conversations/dm'), { peer_member_id: ownerId });
  const conversationId = conv?.id || conv?.conversation_id;
  if (!conversationId) return { sent: false, reason: 'no-conversation' };
  const text = `你的 ${app} 连接已失效，需要重新授权，请到连接页点「重新授权」。`;
  await post(orgId, apiPath(`/conversations/${conversationId}/messages`), {
    client_msg_id: `reauth-${info.connectionId || 'x'}-${Date.now()}`,
    type: 'AGENT_TEXT',
    content: { content_type: 'text', body: { text }, attachments: [] },
  });
  return { sent: true, conversationId };
}
