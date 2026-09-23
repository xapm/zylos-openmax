# Connection Operations Reference

CLI: `node src/cli/conn.js <command> '<json>'`

## What a Connection is (read this first)

A **Connection** is a third-party app or account — mail, chat, calendar, docs, a tracker, any external SaaS/API — that an owner has **authorized directly to you** through cws-connect. It is this platform's answer to "act on an external service": you do **not** install packages, run MCP servers, configure SMTP, drive a browser, or hold credentials in `.env`. You pick an action from the app's catalog and `conn.invoke` it; the token is handled for you — you never hardcode a provider URL or craft a raw HTTP request.

**One universal flow works for every app — you never pre-learn a specific provider:**

1. **`conn.list`** — which apps/accounts are authorized to you right now (each entry pairs an `application` with a `connectionId` + `status`).
2. **`conn.catalog {app}`** (or `conn.app_actions {applicationId}`) — the app's **action catalog**: every action it exposes, each carrying an `input_schema` (JSON Schema) that describes that action's parameters.
3. **`conn.invoke {app, action, params}`** — run the chosen action with `params` shaped by its `input_schema`. The credential is handled for you; `conn.invoke` auto-routes by the connection's `credential_mode` (**`direct`** = local token + your own egress, **`proxy`**/Composio = server-side execute) — see "Two execution models" above.

Because you read the catalog and its `input_schema` **at call time**, the same three verbs drive *any* connected app. What differs per app is only the action names and their `input_schema` — which you **discover, never hardcode** — so a newly-added provider needs zero changes here.

**When the app you need isn't in `conn.list`:** it simply isn't authorized to you yet. Tell the owner and ask them to connect/authorize it — do not fall back to a non-platform workaround (installing something, SMTP, scraping, etc.).

**Two execution models, one verb.** `conn.invoke` resolves the connection and routes on its `credential_mode` (recorded in the local index):

- **`direct`** — the common case: the token is cached locally, so `conn.invoke` assembles the request from the app's catalog (`url_template` + your `params`), injects the token, and calls the provider **from your own egress**. Returns `{ status_code, headers, body }`.
- **`proxy`** (e.g. a **Composio** connector, `credential_source:"composio"`) — the connection holds **no** local token, so `conn.invoke` sends the action to the platform, which resolves it, injects the credential, and calls the provider **server-side**. Returns `{ status_code, body }`. You still call the same `conn.invoke {app|connectionId, action, params}` — the routing is automatic and invisible.

Either way you never hold a URL or craft a raw request. Prefer the cache-aware verbs (`conn.invoke` / `conn.catalog`), which resolve the connection and action for you. See "Credential Handling" and "Capability Cache & Call Chain" below for the mechanics.

> The command reference below is app-agnostic: examples use placeholders like `<app>`, `<toolkit-slug>/<action-name>`, and a generic provider URL. Substitute the real values you get from `conn.list` / `conn.catalog` at runtime — never assume a particular provider.

## Commands

### conn.list
List the connections **enabled for this conversation**.

```bash
node src/cli/conn.js conn.list '{"conversationId":"<conversation-id from <message-context>>"}'
```

`conversationId` is **mandatory** (also for `conn.check` / `conn.invoke`): a
missing or malformed one is refused with `400 conversation_context_invalid`
before any request — there is no flag/env that skips it (fail-closed; a flag
the agent can set would be an escape hatch the model could forge). Returns the
agent-authorized connections filtered to this conversation's enabled set (read
from cws-core `GET /conversations/{id}/connectors`); `[]` when nothing is
enabled, and also `[]` (fail-closed) when the enabled set can't be read.

Self only — cws-core derives the caller's identity from the authenticated
principal, not from any client-supplied parameter (no `agentMemberId` override
exists). Each entry carries status, application, owner, scopes.

### conn.check
Read-only, pre-invoke availability check for **one** app in this conversation —
use it before `conn.invoke` when the user names an app.

```bash
node src/cli/conn.js conn.check '{"app":"<slug or name>","conversationId":"<conversation-id>"}'
```

Returns `{ app, app_name, state, connection_ids }`; `state` is `enabled` (go
ahead), `not_enabled` (authorized but switched off here — ask the user whether
to enable it in the input-box connector panel), `not_authorized` (guide them to
`/connections`), or `needs_reauth` (ask them to re-authorize). An unreadable
enabled set fails closed with a 503 readiness code, never `enabled`. Reply to
the user in plain language — never surface the state names or status codes.

### conn.auth_notice
Case B follow-up: after `conn.check` returns `not_authorized`, post the
structured **"go authorize" card** into this conversation. The chat renders it
as a card whose button deep-links to that app's own connect dialog
(`/connections?connect=<slug>`).

```bash
node src/cli/conn.js conn.auth_notice '{"conversationId":"<conversation-id>","apps":["notion"]}'
```

`apps` is a list of app slugs (display names / application ids also match,
exactly and case-insensitively), resolved against the application catalog
(`GET /connect/applications`) to `{name, slug}`. An app not in the catalog is
refused with `404 unknown_connector` and nothing is posted. `conversationId` is
mandatory (`400 conversation_context_invalid` otherwise). Returns
`{ status: "sent", conversation_id, connectors }`. The message is
`AGENT_STRUCTURED` with body schema `prototype.connector-auth-notice.v1`
(`connector_names[]` / `connector_slugs[]`, index-aligned), a metadata copy, and
a plain Chinese `fallback_text` for clients that don't render the card.

### conn.acquire
Acquire the credential for a connection. Returns `access_token`, `token_type`,
`expires_at`, `toolkits[]` — the token is cached locally and injected for you on
`conn.invoke`, so you normally never call this directly.

```bash
node src/cli/conn.js conn.acquire '{"connectionId":"2b0e4f41-..."}'
```

The comm-bridge automatically acquires and caches credentials on `connection.authorized` events. Use this command to manually acquire or refresh.

### conn.actions
Discover the named actions available for a connection's provider. Pair with `conn.invoke` to run one by name. Scoped to the agent's authorization on the connection.

```bash
node src/cli/conn.js conn.actions '{"connectionId":"2b0e4f41-..."}'
```

Returns an array of `{ toolkit, action, method, description, params[], input_schema }`. `input_schema` is a JSON Schema (draft-07 style) describing the raw provider request body forwarded for that action; an empty string means the schema is not published / unknown (do NOT assume an empty body), while an explicit empty-object schema (`{"type":"object","properties":{},"additionalProperties":false}`) means the action takes no request body. `params[]` still lists URL path/query placeholders separately. To run an action, use `conn.invoke {app, action, params}`.

### conn.status
Get connection details: status, owner, application, scopes, expiry.

```bash
node src/cli/conn.js conn.status '{"connectionId":"2b0e4f41-..."}'
```

### conn.app_actions
Discover the **app-keyed action catalog** for an application — every action the app exposes (each with its `input_schema`), **without needing an existing connection**. Unlike `conn.actions` (connection-scoped and gated on the connection-agent authorization boundary), this is capability metadata readable by any org member: use it to see what an app can do before a connection exists, or to build a per-application capability cache shared across that app's connections.

```bash
node src/cli/conn.js conn.app_actions '{"applicationId":"cb4e4f15-..."}'
```

Returns an array of `{ toolkit, action, method, description, params[], input_schema }` (same shape as `conn.actions`). Resolved strictly by `applicationId` — the BFF route keys on the path id and does not accept a slug override, so the requested resource identity always matches the returned catalog.

### conn.callback
Return the platform's OAuth **callback URL** — the redirect URI to register in your
provider's OAuth app **before** you create a connector. Read-only, no params.

```bash
node src/cli/conn.js conn.callback '{}'
```

Returns `{ callback_url }`. The endpoint is authed (bearer) but **not** org-scoped;
the CLI still authenticates it with the org's token (harmless — the route ignores
the org scoping). Fetch this value first, register it as the redirect URI at your
OAuth provider, then run `conn.app_create` with the provider's `oauth_client_id` /
`oauth_client_secret`.

## Custom connector management (applications + action-defs)

The verbs above **use** connections an owner already authorized to you. The verbs
in this section **onboard and manage the connector applications themselves** — you
create a custom connector application, then define the HTTP **action definitions**
(the DB-backed action catalog) it exposes. These are org-scoped and ownership-gated
server-side: you can only update/delete an application (and its action-defs) that
belongs to your own org.

Two invariants hold for every verb here (they mirror the rest of `conn.*`):

- **You never supply `org_id`.** cws-core derives the owning org from your
  authenticated principal. (`{org}` still selects *which* enabled org's token to
  use on a multi-org agent — it is not written into any request body.)
- **You never supply `oauth_callback_url`.** cws-core injects the provider-facing
  redirect URI on create/update and returns it read-only on the item — register
  that value at your OAuth provider. (Use **`conn.callback`** to fetch it *before*
  creating the connector so you can register it in the provider's OAuth app first.)

### conn.app_create
Create a custom connector application.

```bash
node src/cli/conn.js conn.app_create '{"slug":"acme","display_name":"Acme","provider_type":"api_key","api_key_location":"header","api_key_header_name":"X-Api-Key","category":"crm"}'
```

Required: `display_name`, `provider_type` (`oauth2` | `api_key`). `slug` is
**optional** — cws-core generates one from `display_name` when omitted; pass an
explicit `slug` only when you need a specific value (it is honored as-is). Optional:
`slug`, `description`, `icon_url`, `category`,
`tags[]`, `default_ttl_seconds`, and the auth-shape fields —
API-key: `api_key_location` (`header` | `query`), `api_key_header_name`;
OAuth: `oauth_authorize_url`, `oauth_token_url`, `oauth_client_id`,
`oauth_client_secret`, `oauth_scopes_default[]`, `oauth_pkce` (bool),
`oauth_token_auth_method` (`basic` | `post`), `oauth_token_body_format`
(`form` | `json`). Returns the created `application` item (its `source` is a
read-only derived `"custom"`; `oauth_callback_url` is returned for you to register).

### conn.app_list
List the connector applications visible to your org — the public catalog **∪**
your own org's custom connectors. This is **how you enumerate `applicationId`s
without an existing connection** (contrast `conn.list`, which is
connection-scoped and only returns apps you already have a connection to).

```bash
node src/cli/conn.js conn.app_list '{}'
```

Optional `category` filters the result (e.g. `{"category":"crm"}`). The owning
org is derived **server-side** from your authenticated principal — you never pass
`org_id` (and `{org}` only selects which enabled org's token to use on a
multi-org agent). Returns an **array** of application items, each with
`applicationId` / `id`, `slug`, `display_name`, `provider_type`, `source`,
`visibility`, `credential_source`, `credential_mode`, `category`, the auth-shape
fields (`oauth_*` / `api_key_*`), `is_enabled`, `oauth_callback_url`,
`created_at`, … (same item shape `conn.app_create` / `conn.app_update` return).

### conn.app_update
Update your own custom connector application (ownership-gated).

```bash
node src/cli/conn.js conn.app_update '{"applicationId":"cb4e4f15-...","display_name":"Acme CRM","category":"sales","is_enabled":false}'
```

`applicationId` (UUID) required plus at least one updatable field. `slug` and
`provider_type` are **immutable** and not accepted; the same custom fields as
create are updatable, plus `is_enabled`. This includes the full OAuth set —
`oauth_client_id`, `oauth_client_secret`, `oauth_scopes_default[]`,
`oauth_authorize_url`, `oauth_token_url`, `oauth_pkce`, `oauth_token_auth_method`,
`oauth_token_body_format`.

Two write semantics to know:

- **`oauth_client_secret` is write-only "blank = keep".** A **blank** (empty or
  whitespace-only) secret is **dropped** — it never overwrites/clears the stored
  one, so you can safely update other fields without re-sending it. Pass a
  **non-empty** value only when you intend to set or rotate it. (An update whose
  *only* field is a blank secret is rejected as "no updatable fields".)
- **`oauth_scopes_default` clears on explicit empty.** An explicit empty array
  (`[]`) is forwarded and **clears** the default scopes (asymmetric with the
  secret above). Omit the field to leave scopes unchanged.

### conn.actiondef_list
List an application's HTTP **action definitions** (the DB-backed action catalog you
publish for agents). Distinct from `conn.app_actions` / `conn.actions`, which return
the *resolved capability catalog* agents execute.

```bash
node src/cli/conn.js conn.actiondef_list '{"applicationId":"cb4e4f15-..."}'
```

Returns an array of `{ id, application_id, name, method, url_template, headers?,
encoding, input_schema, created_at?, updated_at? }`.

### conn.actiondef_create
Create one HTTP action definition on an application (ownership-gated).

```bash
node src/cli/conn.js conn.actiondef_create '{"applicationId":"cb4e4f15-...","name":"list_repos","description":"List the authenticated user's repositories","method":"GET","url_template":"{base_url}/user/repos","encoding":"","input_schema":"{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}"}'
```

Required: `applicationId` (UUID), `name`, `method`, `url_template`, **`description`
(non-empty)**. Optional: `headers` (map), `encoding`, `input_schema`. See
**Action-def schema semantics** below for the field rules. `description` is
rejected locally with `{status:400}` when missing or empty — before any network
call (and, in `conn.app_import`, recorded as that action's per-action failure).

### conn.actiondef_update
Partial-update one action definition (ownership-gated; parent-scoped by
`applicationId`).

```bash
node src/cli/conn.js conn.actiondef_update '{"applicationId":"cb4e4f15-...","actionId":"7d2a...","method":"POST","url_template":"{base_url}/user/repos"}'
```

`applicationId` + `actionId` (both UUID) required, plus at least one of `method`,
`url_template`, `encoding`, `input_schema`, `headers`. Note the server rule for
`headers`: a **non-empty** map replaces the stored headers; an empty map leaves
them unchanged.

### conn.actiondef_delete
Delete one action definition (ownership-gated).

```bash
node src/cli/conn.js conn.actiondef_delete '{"applicationId":"cb4e4f15-...","actionId":"7d2a..."}'
```

### conn.app_import
Bulk-onboard a custom connector from an import JSON: create the application, then
loop-create each action-def, reporting **per-action** success/failure so a partial
import is visible (mirrors the cws-fe "actions JSON import" flow).

```bash
node src/cli/conn.js conn.app_import '{"application":{"slug":"acme","display_name":"Acme","provider_type":"api_key","api_key_location":"header","api_key_header_name":"X-Api-Key"},"actions":[{"name":"list_repos","description":"List repositories","method":"GET","url_template":"{base_url}/user/repos"},{"name":"get_repo","description":"Get one repository","method":"GET","url_template":"{base_url}/repos/{id}"}]}'
```

`application` (same fields as `conn.app_create`) is validated **before** any network
call; an invalid app body fails fast without creating anything. Returns
`{ application, applicationId, actions_total, actions_created, actions_failed,
results[] }` where each `results[i]` is `{ index, name, ok, id? , error?, status? }`.
Action-def failures do **not** abort the remaining actions — the app and its
succeeding action-defs stand, and you fix/retry the failed ones with
`conn.actiondef_create`.

### Adding actions to a custom connector — two paths

When a user wants actions added to a custom connector, you (the Agent) have **two
ways** — pick by what the user wants:

**A) Import them yourself via the CLI.** If the user just wants it done, call the CLI
from your own egress:
- **New connector + its actions in one shot** — `conn.app_import` with
  `{"application":{…},"actions":[…]}` (creates the app, then loop-creates each action;
  per-action partial-failure is reported in `results[]`).
- **Add actions to an *existing* connector** — `conn.actiondef_create`, one call per
  action (`applicationId` + the action fields).

**B) Hand the user a JSON block to self-import.** If the user wants to paste it into the
UI themselves (cws-fe「添加动作」/「动作 JSON 导入」box), give them a **directly-importable**
object — a single top-level `actions` array, one entry per action. The shape must be
exactly right:
- **Do** emit `{"actions":[ {…}, {…} ]}` — an object with one `actions` array.
- **Do NOT** wrap it in `application` — the `{"application":{…},"actions":[…]}` shape is
  only for the CLI `conn.app_import` (path A), which *also creates the connector*.
- **Do NOT** emit a bare array (`[ {…} ]`) — it must be the `{"actions":[…]}` object.

```json
{"actions":[
  {"name":"list_repos","description":"List the user's repositories","method":"GET","url_template":"{base_url}/user/repos"},
  {"name":"get_repo","description":"Get one repository","method":"GET","url_template":"{base_url}/repos/{id}","input_schema":"{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"}},\"required\":[\"id\"]}"}
]}
```

Either path uses the same per-action fields — required `name` / `method` /
`url_template` / `description`; optional `headers` / `encoding` / `input_schema` — per
**Action-def schema semantics** below (`Authorization` header forbidden; `input_schema`
is a draft-07 JSON Schema **string**). Fill `description` for every action (required,
non-empty). Each action `name` is just the action segment (e.g. `list_repos`) — the
server prepends the connector slug to form the stored `{slug}/{name}`, so submit the bare
action name, not `slug/name`.

### Action-def schema semantics

One action-def row = one HTTP action published for agents to execute.

- **`name`** — the **action-only** name, e.g. `"list_repos"` (non-empty). Submit just the
  action segment — the server prepends the connector slug and stores it as
  `"{connector-slug}/{name}"`, which is what appears in the catalog and what agents pass
  to `conn.invoke`. (So don't write the slug prefix into the name yourself.)
- **`description`** — **required, non-empty** on create/import. A short
  human-readable summary of what the action does; it surfaces to agents in the
  resolved catalog (`conn.actions` / `conn.app_actions`) to help them pick the right
  action. The CLI rejects a missing/blank `description` locally (`{status:400}`)
  before any network call. (On `conn.actiondef_update` it is an *optional* editable
  field.)
- **`method`** — one of `GET` | `POST` | `PUT` | `PATCH` | `DELETE`.
- **`url_template`** — absolute, or `{base_url}`-prefixed. `{placeholder}` slots are
  filled from params (path/query); an **unfilled query placeholder is dropped**.
- **`encoding`** — `""` (empty) = JSON body · `form` = urlencoded · `none` = no body.
- **`input_schema`** — a JSON Schema **draft-07** string describing the action's
  params. `{"type":"object","properties":{},"additionalProperties":false}` means the
  action takes no request body.
- **`headers`** — static or templated headers. **The `Authorization` header is
  forbidden.** Provider auth comes from the *connection* (the credential is injected
  from the connection at call time), **not** from action headers — a stored
  `Authorization` would override the per-connection auth, so it must never be
  authored. The CLI **rejects it locally, case-insensitively** (`Authorization` /
  `authorization` / `AUTHORIZATION`): `conn.actiondef_create` / `conn.actiondef_update`
  fail with `{status:400, error:"headers.Authorization is forbidden — the connection
  credential is injected at call time"}`, and `conn.app_import` records the offending
  action as a per-action failure (that row is never created). Do not put credentials
  in `headers`.

### conn.cached
List locally cached credentials (from WS event auto-acquire).

```bash
node src/cli/conn.js conn.cached '{}'
```

Returns `{ count, credentials: [{ connection_id, provider, has_access_token }] }`.

### conn.clear_cache
Clear cached credentials. Without `connectionId`, clears all.

```bash
node src/cli/conn.js conn.clear_cache '{"connectionId":"2b0e4f41-..."}'
node src/cli/conn.js conn.clear_cache '{}'
```

## Credential Handling

`conn.invoke {app, action, params}` auto-routes by the connection's
`credential_mode` — you always call the same verb; the credential handling differs:

- **`direct`** — `conn.invoke` acquires the connection's real `access_token`, caches
  it locally (`connect/credentials/<id>.json`, `0600`), assembles the request from
  the catalog's `url_template` + params, injects the token, and calls the provider
  **from this host's egress**. The token is refreshed proactively when its
  `expires_at` is near/expired and reactively once on a provider 401; a missing
  local cache is re-acquired before the call.
- **`proxy`** (e.g. a **Composio** connector, `credential_source:"composio"`) — the
  connection holds **no** local token and its `acquire` is rejected server-side, so
  `conn.invoke` does **not** touch the credential cache or the local catalog. It
  POSTs the action to `POST /connect/connections/{id}/actions/execute`, and the
  platform resolves the action, injects the credential, and calls the provider
  **server-side**, returning `{ status_code, body }`.

Request assembly is **code-driven from the catalog** — the action name must resolve
in the local catalog and the URL can only be that action's `url_template` expanded
with schema-checked params. A free-form provider URL is never accepted from the
caller.

## Capability Cache & Call Chain (runtime/connect/)

All connect-side local state lives under one subtree, split by its natural key:

```
runtime/connect/
├── connections-index.<orgId>.json   # connection → application, per org
├── action-catalog/<applicationId>.json   # application → capability
└── credentials/<connectionId>.json  # real access_token, 0600
```

The connections index is **per-org** (`connections-index.<orgId>.json`): the
comm-bridge runs a WS per enabled org and a connection belongs to one org, so a
multi-org agent connected to the same app in two orgs must not resolve the wrong
org's connection. The `conn.*` capability verbs take an optional `{org}` (default:
the single/default enabled org) and run the lookup **and** the execute call
against that org's index, JWT, and member. The action catalog stays global
(keyed by applicationId) since an app's capabilities are the same across orgs.

- **connections-index** and **action-catalog** are the *discovery* layer. The
  index resolves an application → its `connectionId` + `status` (the agent's entry
  point is an app, not a connection); the catalog caches the per-application action
  metadata (`input_schema` etc.).
- **credentials/** caches the connection's real `access_token` (files are `0600`),
  which `conn.invoke` injects into the request at call time.

### Recommended agent flow (identify → call)

Any bot with this skill gets the flow for free by calling the cache-aware verbs —
it does not need to "know" the sequence:

1. **`conn.invoke {app, action, params, conversationId}`** — (`conversationId` mandatory; gated on this conversation's enabled set) resolves the connection for `app`
   from `connections-index.json` (refreshing from `conn.list` on a miss), then
   routes on its `credential_mode`:
   - **`direct`** — assemble the request from the local catalog's `url_template`
     and call the provider from this host, injecting the locally-cached token
     (refreshed on near-expiry / 401). On an action/schema-shaped error it
     invalidates the cached catalog once so the next `conn.catalog` refetches.
   - **`proxy` / composio** — POST the action to the platform's server-side
     execute endpoint (`POST /connect/connections/{id}/actions/execute`); no local
     token or catalog is touched. Returns the server passthrough `{ status_code,
     body }`. A legacy index entry with no recorded `credential_mode` triggers one
     `conn.list` refresh (which now returns it) before routing.
2. **`conn.catalog {app|applicationId}`** — returns the cached action catalog for
   discovery, filling from `conn.app_actions` on a miss / TTL-expiry (24h) /
   `{refresh:true}`. Read this to pick an `action` + build `params` from its
   `input_schema` before calling `conn.invoke`.
3. **`conn.index {refresh?}`** — inspect the local index (observability).

Invalidation is **TTL + error-triggered** — the app-actions response carries no
version/etag today (see "cws-connect follow-up" below), so there is no
change-detected refresh yet.

> **catalog note:** the catalog carries a per-action `url_template` (and an
> optional `headers_template`, Authorization excluded). `conn.invoke` uses these
> to assemble the real request locally — the mapping comes from the catalog, never
> from a caller-supplied URL. If a cached catalog predates `url_template`,
> `conn.invoke` returns a clear error — run `conn.catalog {refresh:true}`.

### Multiple connections for one app (disambiguation)

An owner can authorize **more than one connection of the same app** to you (e.g.
two Gmail accounts). When you `conn.invoke {app, action, params}` and **more than
one active connection matches** that app, `conn.invoke` does **not** silently pick
one. It returns a **normal result** (stdout, exit 0 — not an error) asking you to
disambiguate:

```json
{
  "needs_selection": true,
  "reason": "multiple_connections",
  "app": "gmail",
  "agent_instruction": "Multiple connections match this app. Ask the user which one to use, phrasing your question in the USER'S language (they may write Chinese or English). Refer to each connection by its label, never the connection_id. Then retry with the chosen connectionId.",
  "candidates": [
    { "connection_id": "c-8f2a4e91", "label": "工作邮箱", "display_name": "工作邮箱", "status": "active" },
    { "connection_id": "c-1b7d0c33", "label": "个人邮箱", "display_name": "个人邮箱", "status": "active" }
  ],
  "retry_hint": "conn.invoke {\"connectionId\":\"<chosen>\",\"action\":\"<same>\",\"params\":{...},\"conversationId\":\"<same>\"}"
}
```

**What to do when you get `needs_selection`:**

1. **Ask the user which connection to use, in the user's own language** (they may
   write Chinese or English — the `agent_instruction` is language-neutral guidance
   on purpose; localize the actual question yourself).
2. **Refer to each candidate by its `label`, never the `connection_id`.** The id
   is an internal handle the user never sees. Each candidate carries a
   guaranteed-non-empty, **unique** `label`: it is the connection's `display_name`
   when set, otherwise a human fallback built from the app name + creation time
   (e.g. `"Gmail · 2026-01-05"`) — so even legacy connections with empty or
   duplicate `display_name` stay distinguishable. Present the `label` as-is; you
   may also invite the owner to name an unnamed connection.
3. **Retry with the chosen connection's id** — pass it as `connectionId` (see
   below). One command re-invokes the same action against the picked connection.

Counts: **0** active → same as before (refresh once, then a 404 "no connection
found" if still none); **exactly 1** → used directly (unchanged); **>1** →
`needs_selection`. `conn.catalog {app}` is per-application and shared across an
app's connections, so it needs **no** disambiguation.

A connection that is **not active** (needs re-authorization, expired, revoked, or
in an error state) is **never** a silent candidate and is rejected **before** any
credential work: `conn.invoke` returns a 409 with an actionable message (for a
reauth-required connection, a "re-authorize on the connection page" hint) — for
both the app-resolved path and the explicit `connectionId` path.

### Targeting a specific connection — `connectionId`

`conn.invoke` accepts an optional **`connectionId`** (alias `connection_id`). When
present it **skips app-resolution entirely** and runs the action against that
connection directly:

```bash
node src/cli/conn.js conn.invoke '{"connectionId":"c-8f2a4e91","action":"gmail/messages-send","params":{...},"conversationId":"<conversation-id>"}'
```

This is exactly the retry after a `needs_selection` prompt: the user picked by
`label`, you map that choice back to the candidate's `connection_id` yourself, and
re-invoke by `connectionId`. `app` is not required when `connectionId` is given.

## WS Event Flow

The comm-bridge automatically maintains the index for all modes, and (for `direct` connections only) the action-catalog cache and credentials — a `proxy`/composio connection is indexed but keeps no local catalog or credential:

| Event | Action |
|-------|--------|
| `connection.authorized` | Upsert into `connections-index.<orgId>.json` (recording the connector taxonomy `credentialMode` — the index no longer records `credentialSource`; classification keys purely on `credentialMode`), then **refresh that org's index from the authoritative agent-connections list** so `applicationId`/`slug`/`name` are correct immediately — the event payload carries only `connection_id` + `provider` (slug), so a bare upsert alone would leave `applicationId`/`name` null until the next `conn.list`. Then, **by mode**: a **`direct`** connection **warms the action-catalog cache** (`action-catalog/{applicationId}.json`, from `/connect/applications/{id}/actions`) and **acquires the credential** → cache to `runtime/connect/credentials/{id}.json`; a **`proxy`/composio** connection does **neither** (it holds no local token and executes server-side, so no credential is acquired and no full catalog is warmed). The identity refresh + catalog warm are **best-effort** (a failure never blocks the credential/index path). **Also enqueues a one-line session notice to the agent** (`🔌 [Connection authorized] …`, via the C4 control queue) so the bot learns it can act via `conn.*` right away, instead of only discovering the connection by chance on a later `conn.list`. |
| `connection.revoked` | Remove from index + delete cached credential |
| `connection.disconnected` | Remove from index + delete cached credential |
| `connection.credential_updated` | Upsert index; **only when a local credential file already exists** (i.e. a `direct` connection) re-acquire and rewrite the cached token so the local `access_token` stays current. A `proxy`/composio connection has no local file, so this is a no-op for it. |
| `connection.reauth_needed` | **Stop calling the dead connection**: delete the cached credential and keep the connection indexed but flagged `status: needs_reauth` (not removed — reauth is recoverable), so `conn.invoke` surfaces an actionable 409 "needs re-authorization" hint instead of a bare 404. Also **best-effort DM the owner** to re-authorize (`sendOwnerReauthDm`; a no-owner / send failure only warns, never blocks the event path). |

Cache location: `components/openmax/runtime/connect/`

### Agent-side effect of each event

What the agent actually does and stores locally per event. The authorization/token
boundary is enforced server-side by cws-connect; this table is only the
**agent-side** effect.

| Trigger (endpoint) → event | agent does / stores |
|---|---|
| **Authorize to agent** → `connection.authorized` | Upsert the org index (`connections-index.<orgId>.json`, incl. `credentialMode`; `credentialSource` is no longer recorded), then **refresh it from the agent-connections list** so `{applicationId, slug, name, status:active}` is correct despite the sparse event payload. Then, **for a `direct` connection only**: **warm the action-catalog cache** (`action-catalog/<applicationId>.json`) **and** `acquire` the credential and write the real `access_token` to `connect/credentials/<connectionId>.json` (file `0600`, dir `0700`). A **`proxy`/composio** connection skips both — no local credential file and no full catalog (it executes server-side). |
| **Revoke this agent** (`DELETE /connections/{id}/agents/{memberId}`) → `connection.revoked` | Remove from the org index **and** delete `connect/credentials/<connectionId>.json` (the cached token). |
| **Disconnect the connection** (`POST /connections/{id}/disconnect`) → `connection.disconnected` | Same as revoke: remove from the org index **and** delete the cached token file. |
| Token refreshed → `connection.credential_updated` | Re-`acquire` and rewrite the cached token so the local `access_token` stays current — **only when a local credential file exists** (`direct`); a `proxy`/composio connection has no local file and is skipped. |

Note: **revoke vs disconnect** differ in *meaning* — revoke removes only *this
agent's* authorization (`connection_agents` binding) while the connection lives on
for others; disconnect tears down the whole connection for everyone — but the
agent's **local cleanup is identical** (unindex + delete the cached credential).

## BFF Endpoints (via cws-core)

| Method | Path | CLI |
|--------|------|-----|
| GET | `/connect/agents/me/connections` | conn.list / conn.index --refresh |
| POST | `/connect/connections/{id}/credential` | conn.acquire (also the token refresh) |
| POST | `/connect/connections/{id}/actions/execute` | conn.invoke (proxy/composio server-side execute) |
| GET | `/connect/connections/{id}` | conn.status |
| GET | `/connect/connections/{id}/actions` | conn.actions |
| GET | `/connect/applications/{id}/actions` | conn.app_actions / conn.catalog |
| GET | `/connect/oauth-callback-url` | conn.callback |
| GET | `/connect/applications` | conn.app_list |
| POST | `/connect/applications` | conn.app_create / conn.app_import |
| PATCH | `/connect/applications/{id}` | conn.app_update |
| GET | `/connect/applications/{id}/action-defs` | conn.actiondef_list |
| POST | `/connect/applications/{id}/action-defs` | conn.actiondef_create / conn.app_import |
| PATCH | `/connect/applications/{id}/action-defs/{action_id}` | conn.actiondef_update |
| DELETE | `/connect/applications/{id}/action-defs/{action_id}` | conn.actiondef_delete |

None of the connection/action *usage* endpoints accept a client-supplied
`agent_member_id`, and none of the application/action-def *management* endpoints
accept a client-supplied `org_id` or `oauth_callback_url` — cws-core
derives the caller's identity from the authenticated principal on every one of
them (security fix, 2026-08-04). The CLI never had a way to target a
connection/action that doesn't belong to the calling agent.

## cws-connect follow-up (optional, non-blocking)

`ListApplicationActionsResponse` returns only `ActionInfo` (`toolkit, action,
method, description, params, input_schema`) — **no version/etag**. `Toolkit.version`
exists in the model but is not surfaced on this endpoint. To enable *precise*
catalog invalidation (refresh only when the catalog actually changed), add a
catalog-level version/etag (and ideally `If-None-Match → 304`). Until then the
agent-side cache relies on TTL + error-triggered refresh.
