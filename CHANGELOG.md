# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.19.0] — 2026-09-11

### Added

- Auto-install the `openmax-kb` companion component during openmax install and upgrade. The post-install and post-upgrade hooks now ensure `openmaxai/zylos-openmax-kb` is present so every agent with openmax has the product knowledge base by default; on upgrade this also back-fills kb onto already-deployed agents.

The step is idempotent (compares the locally-recorded kb version to the pin — skips when already at or above it, upgrades when below, installs when absent), non-fatal (a kb failure never blocks the openmax install/upgrade), time-bounded (30s timeout + SIGKILL so a hung clone cannot stall the upgrade or hold the component lock), and short-circuits under `DEPLOY_REGION=cn`.

## [2.18.0] — 2026-09-07

### Added

- In-chat platform channel connection for Feishu, Lark, DingTalk and WeCom, with human confirmation before creating an authorization session, followed by QR delivery and background connection status updates.

### Fixed

- Separate QR authorization expiry from runtime binding waits, and report watcher errors back to the originating chat.

Requires the matching cws-core confirmation API and cws-fe confirmation/QR cards. Personal WeChat and WhatsApp runtime QR login are not included in this conversational connection flow.

## [2.17.1] — 2026-08-30

### Changed

- `conn.invoke` now routes by the connection's `credential_mode`: **proxy/Composio** connections execute **server-side** via cws-core's proxy execute endpoint (`POST /connect/connections/{id}/actions/execute`), while **direct** connections execute locally (local egress) — `invokeDirect` assembles the request from the per-action catalog templates and calls the provider directly, acquiring/refreshing the credential from cws-core only on a cache miss, a near-expiry OAuth token, or a provider 401. A single entry point (`conn.invoke`) now auto-selects the path; callers no longer choose proxy vs direct.
- `conn.list` / `conn.catalog` data-and-cache boundaries converged: `conn.list` always reads from cws-core; `conn.catalog` serves a local on-disk catalog for direct connectors (persisted) and fetches through to cws-core every time for proxy/Composio connectors (never persisted).

### Removed

- The client-driven `conn.proxy` and `conn.execute` verbs are removed. Server-side execution is reached only through `conn.invoke`'s proxy route (selected automatically by `credential_mode`). Both are kept as explicit tombstones that return an actionable error pointing at `conn.invoke`, so an old caller fails loudly rather than silently.

## [2.17.0] — 2026-08-28

*Stable release. Promotes the 2.17.0-beta.1 … beta.3 pre-releases to a formal version — `comm.send_card` display cards, WeChat/WhatsApp rebind, and log-hygiene / rotation / observability. The itemized notes below (this section plus the beta.2 / beta.1 entries) are the full scope of 2.17.0.*

### Added

- Log rotation: a `log-rotate` task registered into the existing `TaskRegistry` performs a **daily** size check and rotates any PM2 log file (`pm_out_log_path` / `pm_err_log_path`) exceeding 20 MB via copytruncate — streaming the current contents into a timestamped `.gz` archive next to the log, then truncating the live file to 0 (safe under PM2's O_APPEND writer; `pm2 logs` keeps following). `runOnStart` reclaims an already-oversized file at boot. Archives are gzipped and kept indefinitely; the live file stays plain text. Graceful no-op outside PM2.

### Fixed

- Log hygiene: successful (2xx) periodic `runtime-metrics` and `online-report` RPCs no longer print their `[rpc] → … / ←` pairs to stdout, cutting the dominant `out.log` flood from these ~10–60s reporters. A new opt-in `quietOnSuccess` client option suppresses stdout only on success — errors (>=400) still log via `console.warn`, all other RPC logging is unchanged, and the file sink (`COCO_RPC_LOG_FILE`) is unaffected. The routine `online-report: triggered=false reason=…` summary is also suppressed; only a meaningful `triggered=true` event is logged. High-frequency benign no-op system events (reactions, read/delivered receipts, mention/created notices) no longer log at all; every other system frame now logs exactly one line — a `system event=…` trace for known events and a single `unhandled system event: …` line for unknown ones (previously an unknown event double-logged: one trace plus one unhandled line) — so contract drift stays visible without the duplication.
- Token/auth error logging no longer renders as `[object Object]`: the error branch now drills into the cws-core error envelope (`error.detail` / `error.title`) and coerces to a string, so the real failure cause surfaces.
- Log levels: token lifecycle progress logs and the benign `unhandled system event` (message reactions) now write to stdout instead of stderr, so `error.log` retains only genuine errors.
- Log rotation: same-second rotations of one file no longer overwrite each other. The second-granular timestamp could yield an identical `<stem>.<stamp>` base for two rotations within one second (runOnStart + a manual tick, a crash-restart), silently clobbering the earlier `.log.gz` — data loss under the "archives kept forever" guarantee. `rotateFile` now claims a collision-proof base via a reservation loop that appends `.1`, `.2`, … skipping any base whose `.log.gz` already exists and reserving the snapshot slot with an `O_EXCL` create, so neither a published archive nor a preserved snapshot is ever overwritten.
## [2.17.0-beta.2] — 2026-08-28

*Beta / experimental release (full notes in the GitHub release).*

### Fixed

- WeChat / WhatsApp rebind: disconnect now truly destroys the channel session — a per-channel `logout` hook (WeChat admin account delete + login cancel; WhatsApp `auth_info` removal) with an in-flight-login guard and a file fallback on any partial account-delete failure — so a reconnect issues a fresh QR instead of reviving the old account. Pairs with cws-connect !118.

## [2.17.0-beta.1] — 2026-08-27

*Beta / experimental release. `comm.send_card` ships as a beta preview:
it has never been exercised end-to-end against a live environment, so the
parameter surface may change before a stable 2.17.0.*

### Added

- `comm.send_card` — send a `cws.card.v1` **display** card: a title/summary plus
  up to five `ui.quick_reply` buttons, for asking the user to pick one of a few
  fixed answers. The choice reads back from `card_state.action_id`, so no free
  text has to be parsed. `src/lib/card.js` mirrors the cws-comm validator's
  caps (code points, not bytes) and rejects a malformed card locally with the
  offending field named, instead of surfacing an opaque 422 from cws-core.
  Interactive (business-operation) cards are out of scope.
- Option-text comparison now trims with Go's `unicode.IsSpace` set rather than
  JS `String.trim`. The two disagree in both directions: U+0085 slipped a
  duplicate pair past the local check into a 422 from cws-core, and U+FEFF made
  two options the backend considers distinct fail here as "duplicates" while the
  caller was looking at two texts that plainly differ. Normalization decides
  equality only — the text on the wire is never rewritten.
- An id the caller supplies is now honoured regardless of its position: a
  derived id that would take it yields to the positional form. Previously the
  invariant only held when the explicit id came first, and the error blamed the
  option the caller had actually chosen.
- `references/comm-operations.md` — "Display cards" section covering the verb,
  the three fields all named `type`, the frozen limits, and why the answer must
  be matched on the action id rather than the label.

## [2.16.4] — 2026-08-26

### Fixed

- `issue.idle` handling no longer writes routine no-change comments when the Lead has no action that can advance the Issue. This avoids rearming hourly Lead reminders and lets the next idle window escalate the owner; actual actions and new decisions are still recorded through normal Work operations.

## [2.16.3] — 2026-08-25

### Fixed

- Every inbound OpenMax envelope now explicitly requires loading the `openmax` Skill before handling the message, preventing a freshly restarted runtime from occasionally answering without the Skill.
- Short conversational deliverables are still tasks when the human explicitly calls them work/tasks or asks the Agent to create, write, organize, analyze, research, change, or deliver an output.
- Simple-task KB selection now skips repeat questions when the human already chose the KB, while Project parameter resolution explicitly treats cache, search, and Inbox as recommendation sources rather than human consent.

## [2.16.2] — 2026-08-25

### Fixed

- New-task intake no longer infers an Issue decision from ordinary task wording, deliverable format, immediacy, simplicity, or phrases such as "follow the normal process". Until the human explicitly chooses Issue-backed work, OpenMax asks only for the missing Issue/Project decisions and defers KnowledgeBase, executor, Blueprint, and plan questions.

## [2.16.1] — 2026-08-25

### Changed

- New-task Issue intake now treats creation intent and target Project as independent decisions and asks only for missing information. Explicit human choices are not reconfirmed; Agent recommendations, recent/default Projects, and a sole visible Project do not count as confirmation. OpenMax calls `issue.create` only after creation and Project are settled, while an explicit no-Issue choice continues directly in the conversation without Work objects.

## [2.16.0] — 2026-08-24

Group-history dedup correctness plus a mention roster fallback so an `@name` aimed at someone who has not spoken in the conversation still wakes them.

### Added

- Mention roster fallback: when an outbound message `@`-mentions a participant not yet in the local mention registry (someone who has never spoken in the conversation), fetch the conversation roster once (`GET /conversations/{id}/members`, gap-fill, first-wins on duplicate display names) and resolve the mention against it. Best-effort — a failed, timed-out, or hung fetch never blocks the send.

### Fixed

- group-history: compare `message_id` as strings in both identity checks (`recordHistoryEntry` dedup and `getHistory` exclusion), so a message the delivery path sends sometimes as a JSON number and sometimes as a string is no longer recorded/appended twice, and the in-flight message is correctly excluded from its own history. Normalized at compare time, so existing on-disk logs need no migration.
- mention: bound the roster-hydration `GET` with a short (2s) timeout so an unresponsive members endpoint can no longer hang the entire send (a never-settling fetch that `try/catch` cannot rescue); on timeout the send proceeds without a structured mention.
- mention: fix a roster-fetch trigger false-negative where a resolvable longer name (e.g. `test11`) masked a distinct shorter `@name` sharing its prefix (`test`), leaving that mention silently unresolved forever; the trigger now strips actually-resolved mention spans instead of comparing name prefixes.
- mention: negative-cache roster fetches per conversation (stamped before the request, TTL-bounded) so an unresolvable `@name` — or an unresponsive endpoint — no longer re-fetches `/members` on every message.

## [2.15.0] — 2026-08-22

Stable release of the custom-connector CLI (promotes `2.15.0-beta.2`). Changes since `2.15.0-beta.2`:

### Added

- `conn.app_list` — list the org's custom connector applications (`GET /connect/applications`), with an optional `category` filter.

### Changed

- `conn.app_create` / `conn.app_update` reworked: `slug` is now optional on `conn.app_create` (server-generated when omitted); `conn.app_update` supports full-field OAuth updates; action-def `description` is now required.

### Removed

- `conn.app_delete` CLI verb dropped (`conn.actiondef_delete` retained). Reverted the #131 card-message documentation that had merged from `main`.

### Docs

- `references/conn-operations.md`: document the two ways the Agent adds actions to a custom connector — (A) import via CLI (`conn.app_import` for new app+actions, `conn.actiondef_create` for an existing one) and (B) hand the user a directly-importable `{"actions":[…]}` block to self-import (distinct from `conn.app_import`'s `{application, actions}`; not a bare array), with field rules and an example. Also **corrected the action-`name` examples to bare action-only names** (e.g. `list_repos`, not `repos/list`): the client submits just the action segment and the server composes the stored `{connector-slug}/{name}`.

## [2.15.0-beta.2] — 2026-08-21

*Beta / experimental release — continues the custom-connector CLI preview.*

### Changed

- `conn.js` **no longer sends `credential_source`, `visibility`, or
  `credential_mode`** on `conn.app_create` / `conn.app_update` (and the
  `conn.app_import` app body, which reuses the create planner). cws-core now
  forces these three server-side (`custom` / `org` / `direct`) and its
  custom-connector create/update request schema (strict huma) **rejects them with
  HTTP 422 if present**. They were removed from the `APP_CREATE_FIELDS`
  (`credential_source`, `visibility`) and `APP_UPDATE_FIELDS`
  (`credential_source`, `visibility`, `credential_mode`) allowlists, so the request
  planner drops them exactly the way it already drops the server-injected
  `org_id` / `oauth_callback_url`. `references/conn-operations.md` updated to match.

### Added

- `conn.app_list` — list the org's custom connector applications
  (`GET /connect/applications`), optional `category` filter. Enumerates
  `applicationId`s **without** an existing connection (contrast connection-scoped
  `conn.list`); org is derived server-side (never a client param).
- New `conn.callback` command — returns the platform's OAuth **callback URL**
  (`GET /api/v1/connect/oauth-callback-url`, D8 envelope `{ data: { callback_url } }`,
  unwrapped to `{ callback_url }`). Register this redirect URI in the provider's
  OAuth app **before** creating a connector. The endpoint is authed (bearer) but
  not org-scoped; the CLI authenticates it with the operating org's token.

### Removed

- Dropped the card-message docs (reverted #131 on this branch): removed the
  `SKILL.md` "prefer a card for a yes/no choice" behavioral bullet and the
  `references/comm-operations.md` "Card messages" section.
- Removed the `conn.app_delete` CLI verb (handler, `planAppDelete` helper, usage
  line, tests) and its `references/conn-operations.md` documentation.

## [2.15.0-beta.1] — 2026-08-19

*Beta / experimental release. The custom-connector CLI verbs (`conn.app_*` /
`conn.actiondef_*` / `conn.app_import`) ship as a beta preview — the command
surface and parameters may change before the stable 2.15.0.*

### Added

- Custom-connector management verbs on `conn.js` — onboard and manage custom
  connector **applications** and their DB-backed HTTP **action definitions**
  against the cws-core BFF `/connect/applications*` surface (REST contract
  alpha.90). New verbs: `conn.app_create` (`POST /connect/applications`),
  `conn.app_update` (`PATCH …/{id}`), `conn.app_delete` (`DELETE …/{id}`),
  `conn.actiondef_list` (`GET …/{id}/action-defs`), `conn.actiondef_create`
  (`POST …/action-defs`), `conn.actiondef_update`
  (`PATCH …/action-defs/{action_id}`), `conn.actiondef_delete`
  (`DELETE …/action-defs/{action_id}`), plus `conn.app_import` — a bulk verb that
  creates the application then loop-creates each action-def from an import JSON,
  returning a per-action success/failure report (`actions_total` /
  `actions_created` / `actions_failed` / `results[]`) so a partial import is
  visible and never aborts the remaining actions.
- Every management verb is org-scoped like the rest of `conn.*`: it resolves the
  operating org via `requireOrgId()` and routes through the org-scoped
  `getForOrg`/`postForOrg`/`patchForOrg`/`delForOrg` helpers, failing fast with an
  actionable HTTP 400 on a multi-org agent with no `{org}` / `COCO_ORG_ID`.
  Required params are validated locally (400) and `applicationId`/`actionId` must
  be UUIDs.
- Security: `org_id` and `oauth_callback_url` are **never** forwarded in a request
  body — both are server-derived (org from the authenticated principal; callback
  URL injected by cws-core on create/update). Request bodies are built from a
  strict field allowlist rather than by spreading caller params, so those fields
  (and any unknown key) cannot leak through even when supplied. (`org_id` is still
  honored only as an operating-org selector, never written to a body.)
- Action-def `headers` reject a caller-supplied `Authorization` key locally,
  **case-insensitively** (`Authorization` / `authorization` / `AUTHORIZATION`), in
  the pure planner shared by `conn.actiondef_create`, `conn.actiondef_update`, and
  the `conn.app_import` action loop — throwing
  `{status:400, error:"headers.Authorization is forbidden — the connection credential
  is injected at call time"}` (in `app_import` the offending action is recorded as a
  per-action failure and never created). Provider auth comes from the connection,
  not from action headers; a stored `Authorization` on a DB-backed custom action-def
  is applied after credential injection on the execution path and would override the
  per-connection auth, so the CLI must not author such a row.
- `references/conn-operations.md`: a "Custom connector management" section
  documenting the new verbs and the action-def schema semantics (method set;
  `url_template` `{placeholder}` slots; `encoding` `""`=JSON / `form` / `none`;
  `input_schema` = JSON Schema draft-07; the **`Authorization` header is
  forbidden** — the connection token is injected at call time). `printUsage()` gains
  an "Applications (custom connector management)" section.

## [2.14.7] — 2026-08-18

### Added

- Multi-connection disambiguation by `label`. When an owner has authorized
  more than one connection of the same app to a single agent (e.g. two Gmail
  accounts), `conn.invoke` no longer silently uses the first match: when >1 active
  connection matches the app it returns a `needs_selection` result — a normal
  value printed to stdout with exit 0, **not** a thrown error — carrying
  `candidates[]` (each with `connection_id`, `label`, `display_name` (nullable),
  `status`) and a language-neutral `agent_instruction`. Each candidate carries a
  guaranteed-non-empty, unique `label` (the connection's `display_name` when set,
  else a fallback built from the app name + creation time) — legacy connections
  have `display_name: null` (explicitly supported, not backfilled), so only the
  `label` reliably distinguishes them. The agent asks the user to pick **by
  `label`** (never the `connection_id`, which is internal), maps the choice back
  to its `connection_id` itself, and retries. Candidates are returned in a
  **deterministic order** (created_at ascending, id tiebreak) so a given label and
  candidate position are invariant to the server's return order. A new optional
  `connectionId` (alias `connection_id`) param targets a specific connection
  directly, skipping app-resolution — the one-command retry after the user picks.
  The 0-active and exactly-1-active paths are unchanged (404 / direct use).

## [2.14.6] — 2026-08-18

### Fixed

- Org-scope the remaining CLI surface (`as` / `comm` / `tm` / `kb` / `core`) so a
  multi-org agent never calls the backend with an identity-only token — the same
  connector-403 "org membership required" root cause fixed for `conn` in 2.14.4
  (PR#127). Every org-owned command now resolves the operating org (explicit
  `{org}` or the single enabled org) and routes through
  `getForOrg`/`postForOrg`/`patchForOrg`/`putForOrg`/`delForOrg`, failing fast
  with an actionable HTTP 400 when the org cannot be resolved (multi-org with no
  `{org}` and no `COCO_ORG_ID`) instead of sending an identity-only request that
  403s. Covers all 45 `tm.js` commands, all 38 `kb.js` commands, the 3 `as.js`
  network functions (`uploadMedia`/`getMediaUrl`/`resolveUris`) + 4 `as.*`
  commands, all 16 `comm.js` IM commands, and the 14 org-owned `core.js`
  commands. Single-org / `COCO_ORG_ID` deployments are unaffected.
- The 4 previously-ambiguous `core.js` commands are now org-scoped:
  `platform_agent_create`, `platform_agent_delete`, `org_get`, `role_list`.
- Bug A — `as.js` `getMediaUrl` dropped the org: it ran a bare
  `post('/artifacts/resolve')`, so the `org_id` comm-bridge already passed
  (`getMediaUrl(attId, orgConfig.org_id)`) landed in an ignored `opts` argument
  and multi-org media resolve/download went out identity-only and 403'd. The org
  id is now a real positional parameter routed through `postForOrg`.
- Bug B — `comm.js` `convClient` silently fell back to bare `get/post/del` when
  no `{org}` was passed, a latent multi-org 403 in the 6 conversation-member
  commands. It now always resolves the operating org (fail-fast on multi-org
  with no `{org}`).
- `COCO_ORG_ID` on the no-`{org}` path is now validated consistently by both
  `config.resolveDefaultOrgId` and `comm.js` `resolveOrgConfig`, but only
  against a *populated* config set: a value matching an enabled org is used; a
  value that is not enabled while `config.orgs` is populated is treated as a
  bad value — a single-enabled deployment falls back to its sole org (with a
  stderr warning) and any other case (multiple enabled, or a
  populated-but-all-disabled tenant) fails fast with an actionable HTTP 400
  rather than guessing. The env-only passthrough is gated on a *truly empty*
  `config.orgs` map (zero configured orgs): only then is there nothing to
  validate against and the env value is trusted. A populated-but-all-disabled
  config **fails closed** (400 before any network call), not routes by env.
  Resolution outcomes are logged to stderr only (never stdout, which carries
  CLI JSON); the happy path stays quiet unless `COCO_ORG_LOG=1`.

### Added

- Deliver the message's `org_id` into task-CLI calls so a multi-org agent runs
  each `tm` / `kb` / `as` / `conn` invocation against the org the message
  belongs to. The inbound message header now carries the org_id as a dedicated,
  unforgeable structural element — `<org-context org-id="<uuid>"/>` on its own
  line — separate from the human-readable `(org: <name>)` display text, so an
  untrusted/adversarial org name cannot forge a competing routing id. `SKILL.md`
  documents the hard rule to read the authoritative `org_id` from the
  `<org-context>` `org-id` attribute (not the display text) and prefix
  `COCO_ORG_ID=<uuid>` on each such call, bound to the current message only
  (never stored in a shared/global slot). Single-org deployments need no prefix
  and are unaffected.

### Unchanged (deliberate)

- Identity / bootstrap commands stay identity-scoped: `core.me`, `core.org_list`,
  `core.org_switch`, `core.org_create`, `core.self_rename`,
  `core.invitation_accept`, and the agent-domain resolvers. `invitation`
  create/list/revoke are org-scoped; `accept` stays identity (pre-membership).
- `metrics-reporter.js` and `channel-liveness-reporter.js` were already
  org-scoped (`putForOrg`) and are untouched.

## [2.14.5] — 2026-08-17

### Added

- Add the Lead runbook for `issue.idle`: inspect the Issue execution context,
  decide how to unblock or follow up with Workers, and record the action through
  normal Work operations without replying to the write-only Scheduler member.

### Changed

- Make dependency-ready handoff follow the visible System Member message contract:
  resolve upstream Task IDs from the referenced downstream Task's authoritative
  `depends_on` field instead of relying on hidden `upstreamTaskIds` metadata.

## [2.14.4] — 2026-08-17

### Fixed

- Org-scope every cws-connect CLI command so a multi-org agent never calls
  cws-core with an identity-only token (the production connector-403 "org
  membership required"). All 10 org-owned `conn.*` commands — the 7 low-level
  verbs (`list`/`acquire`/`proxy`/`actions`/`execute`/`status`/`app_actions`)
  plus the 3 agent-facing entry points (`catalog`/`invoke`/`index`) — now
  resolve the operating org via `requireOrgId()` and route through
  `getForOrg`/`postForOrg`. When the org cannot be resolved (multi-org with no
  `{org}` and no `COCO_ORG_ID`) they now fail fast with an actionable HTTP 400
  instead of sending an identity-only request that 403s, or (for `conn.index`)
  returning a misleading empty result. Single-org / `COCO_ORG_ID` deployments
  are unaffected.

## [2.14.3] — 2026-08-14

### Added

- P0 re-authorization handling on the openmax side. A `connection.reauth_needed`
  event now stops calling the dead connection: it clears the local credential
  cache and keeps the connection indexed under a new `needs_reauth` status
  (rather than fully removing it), so `conn.invoke` can surface an actionable
  "re-authorize" hint (HTTP 409, needs re-authorization) instead of a bare 404.
- The owner is also notified via a best-effort DM (`sendOwnerReauthDm`): open/get the owner
  DM conversation, then post a concise `你的 <app> 连接已失效，需要重新授权，请到连接页点「重新授权」`
  message. Wired into the comm bridge's connection-event handler alongside the
  existing authorize notification; best-effort and never breaks the event path.

## [2.14.2] — 2026-08-13

### Changed

- Generic token injection in `direct-exec` (local-egress path only; no proxy path touched).
  Request assembly no longer hardcodes `Authorization: Bearer <token>`. It now derives the
  HTTP auth scheme from the credential's `token_type` via a new `canonicalAuthScheme()` helper
  that mirrors cws-connect's `canonicalAuthScheme` EXACTLY: `""` / `bearer` / `api_key`
  (any case) → `Bearer`, `basic` (any case) → `Basic`, anything else verbatim
  (e.g. `Token`). An optional `auth_injection` descriptor
  (`{ location: 'header'|'query', name, value_template }`, with a literal `{token}`
  placeholder) can instead place the credential in a custom header or query parameter
  (e.g. `X-API-Key`, `?api_key=…`, `Authorization: SSWS …`); the descriptor wins over a
  same-named templated header, and a `headers_template` `authorization` key still can never
  override the injected Authorization on the canonical path.

## [2.14.1] — 2026-08-13

### Added

- Accept the targeted `agent.config.diagnostics_changed` WebSocket system event and atomically
  persist its boolean diagnostics gate to `config.json`. The active comm bridge updates its
  in-memory gate synchronously, so deterministic diagnostics commands can be enabled or disabled
  without restarting the Agent session. Exact Agent targeting and boolean-only validation remain
  closed; probe execution continues to use the separate `agent.diagnostics.command` event family.

## [2.14.0] — 2026-08-13

### Added

- **Direct-mode local-egress execution for Connections.** `conn.invoke` now splits internally on
  the resolved connection's credential mode and is transparent to the caller (same command, same
  `{status_code, headers, body}` result shape):
  - **direct** → new `src/lib/direct-exec.js` resolves the action from the **local** action-catalog
    cache (now carrying per-action `url_template` + optional `headers_template`), validates params
    against `input_schema`, fills `{placeholder}` path/query tokens and builds the JSON body from the
    remaining params, injects `Authorization: Bearer <local-cache-token>`, and makes the HTTP request
    **from this host directly to the provider** (raw response passthrough). The response body is read
    with a **streaming** 10 MB cap — an oversized response is cancelled mid-stream and errors (status
    502) rather than being buffered whole or silently truncated. Request assembly is **code-driven
    from the catalog** — the caller/LLM supplies only `action` + `params` and can never inject a
    free-form URL. `{placeholder}` tokens resolve from **both** the action params and the
    credential's `url_placeholders` (connection-owned NON-secret URL parts, e.g. a self-hosted
    connector's `base_url` like Jenkins) — a `url_placeholders` value is substituted **verbatim** as
    a structural prefix (not percent-encoded), while a param value is URL-encoded; params win on a
    name clash. A `{base_url}`-style token that neither source provides is a clear **422** (no
    literal `{base_url}` ever reaches the wire). `url_placeholders` round-trips through the local
    credential cache and is re-fetched on re-acquire.
  - **proxy** → unchanged server-side `/actions/execute` path.
- **Local token cache + refresh-on-invoke (O4).** Two signals: `token_type` gates whether a token
  can be refreshed at all — cws-connect stores `"api_key"` (no refresh flow) vs `"bearer"` (OAuth);
  `expires_at` gates whether a refreshable token is refreshed proactively. An **api_key** is never
  refreshed (proactively or on a 401) — a provider 401 is surfaced. An **OAuth** token is refreshed
  proactively when it carries an `expires_at` that is near/expired, and reactively **once** on a
  provider 401 (this covers non-expiring OAuth like GitHub, which has no `expires_at`); a second
  401 is surfaced (no loop). Refresh re-acquires via cws-core and re-saves the local cache.
- **Re-acquire on a direct cache miss (O4).** When a resolved connection has no local credential
  file (authorized offline, `runtime/` wiped/reinstalled, or `conn.clear_cache`), `conn.invoke`
  now re-acquires via cws-core, saves the credential, and proceeds with local direct execution
  instead of falling through to the proxy path (which cws-connect rejects for a direct connection
  with `ErrDirectNotProxyable`/422). `acquire` returns `credential_mode`, so a proxy connection is
  discovered on the same call and routed server-side without caching anything. Only an acquire
  failure is surfaced — a direct call is never silently downgraded.
- **Audit logging for direct calls (O6).** Each direct call logs a short `[conn.direct]` line with
  the request method + the **un-expanded `url_template`** (placeholders kept literal, so a secret in
  a query placeholder like `?api_key={api_key}` can never reach the log) + params only, params
  redacted (`redact.js`), headers never logged; same stdout/file sinks (`COCO_RPC_LOG` /
  `COCO_RPC_LOG_FILE`) as the RPC client.
- `readCredentialCache()` in `credential-cache.js` (full record incl. token, for direct execution).

### Changed

- **Connection-authorized notice is now mode-aware (O3).** Direct connections get self-trigger
  wording ("the token is ready locally … you make the request from your own egress"); proxy
  connections keep the server-side-injection wording.
- **Hid `conn.proxy` / `conn.execute` from the agent surface (O5).** Removed from the `conn.js`
  help text and from `references/conn-operations.md` agent guidance (they are proxy-only now). The
  handler functions and dispatch entries are **retained** (proxy mode + future use). Updated
  `SKILL.md` / `conn-operations.md` to describe `conn.invoke`'s mode-transparent behavior and the
  new catalog `url_template`.

## [2.13.0] — 2026-08-12

### Added

- **Notify the agent when a connection is authorized to it.** On a `connection.authorized` WS
  event the comm-bridge now enqueues a one-line session notice (`🔌 [Connection authorized] …`, via the C4
  control queue, mirroring the owner-changed notice) naming the app, so a bot learns it can act
  via `conn.*` **immediately** instead of only discovering the connection if it happens to run
  `conn.list`. The notice is produced by an injectable `notify` dep on `handleConnectionEvent`
  (keeps the logic unit-testable); it is **best-effort** — a notify failure never breaks the
  credential/index/catalog path — and fires **only on authorize** (not revoke / disconnect /
  credential-updated / reauth). Completes the third item of the connect-discoverability design
  (the first two — the always-loaded SKILL.md trigger and the app-agnostic ops rewrite — are below).

### Changed

- **Made third-party Connections discoverable from the always-loaded layer.**
  A bot asked to do something involving an external app/account (e.g. "send an
  email") could previously conclude it "had no capability" and reach for
  SMTP/MCP/local-connector workarounds, because `SKILL.md` (always loaded) only
  referenced Connect via one narrow Layer-3 index row while the `conn.*` capability
  and `conn-operations.md` sit load-on-demand. Added a new always-loaded `SKILL.md`
  section — "Acting on External Apps / Accounts (Connections) — recognize this
  first": any request that touches an external app/account is the trigger to load
  `conn-operations.md` and use `conn.list` → `conn.catalog` → `conn.invoke`. The
  rule is **generic (no per-app names/examples)**, so onboarding new connectors
  needs no skill change. Also broadened the Layer-3 index row's trigger wording
  from specific apps to action types.
- **Rewrote `references/conn-operations.md` to be app-agnostic.** Added a "What a
  Connection is" preamble covering what a Connection is, what it is for, and the
  one universal `list → catalog → invoke` flow that works for every app (actions +
  `input_schema` are discovered at call time, never hardcoded). Replaced the
  provider-specific examples (raw provider URLs, a named action) with placeholders.
  Docs-only; no code change.

## [2.12.9] — 2026-08-12

### Changed

- **Moved the reply-vs-proactive-send rule into `SKILL.md` (always loaded).**
  `SKILL.md` now has a concise "How to Send a Message" section: replying to a
  message routed to you always uses the C4 `c4-send` reply path (the `reply via:`
  command on the inbound message), while `comm.send` is for agent-initiated
  (proactive) sends only. The 2.12.7/2.12.8 notes previously lived only in
  `references/comm-operations.md`, which is load-on-demand (Layer 3); the rule is
  now stated where it is always loaded. `comm-operations.md` drops the duplicated
  rule and points to `SKILL.md`, keeping only `comm.send`'s call mechanics.
  Docs-only; no code change.

## [2.12.8] — 2026-08-12

### Changed

- **Emphasized that replies always go through the C4 reply path (`c4-send.js`),
  never `comm.send`.** Added alongside the existing "`comm.send` is only for
  agent-initiated (proactive) sends" note in `references/comm-operations.md`.
  Docs-only; no code change.

## [2.12.7] — 2026-08-11

### Changed

- **Clarified that `comm.send` is only for agent-initiated (proactive) sends** —
  opening a new DM/group, or proactively pushing a message into a known
  conversation. Documented in `references/comm-operations.md`. Docs-only; no
  code change.

## [2.12.6] — 2026-08-10

### Fixed

- **The readiness cap can no longer emit a false "online" when no agent session
  exists.** The 10-minute fail-open exists so an agent that is *present but busy*
  cannot strand its org un-onboarded. But when the blocker was "no session at
  all", the cap still released the report — asserting something untrue, which the
  platform then acts on (welcome DM + seeded onboarding against a runtime that
  does not exist). This is exactly the premature-welcome path traced in the
  2026-08-10 cws-agent-runtime investigation: a transient prepare-phase
  comm-bridge whose `online-report` was taken as proof the real runtime was up,
  2 seconds before it was SIGINT'd. `no_session` and `session_predates_launch`
  are now in `NO_FAIL_OPEN_REASONS` and defer instead of failing open; the WS
  reconnect and periodic tick still retry, so this delays rather than cancels.
  In practice prepare tears down at ~56s, far below the cap — the previous
  behaviour was safe only by coincidence.

### Added

- **Multi-stage `readiness` object in the runtime-metrics payload.** The platform
  used to infer provisioning progress from `runtime.state` / WS-presence, both
  unreliable. This runtime is the only place that sees every input (status file,
  session-in-launch, proc liveness, health), so it now emits the conclusion: an
  additive `readiness` = `{ ready, observable, stage, reason }` on the
  runtime-metrics PUT, where `stage` climbs a monotonic ladder
  (`runtime_down → runtime_up → session_ready → ready`). `runtime.state` is
  untouched and the field is omitted entirely when no verdict exists (absent ≠
  `{ready:false}`), so a platform that does not know the field keeps working off
  `runtime.state`. cws-core's provisioning gate consumes this directly.

- **Documented `readiness_gate` / `readinessTrigger` snake_case knobs now take
  effect.** `poll_ms` / `min_gap_ms` were previously merged raw against camelCase
  defaults and silently ignored; a shared `normalizeNumericOptions` helper now
  honors the documented snake_case keys (with `min_gap_ms = 0` allowed as "no
  floor", `poll_ms = 0` rejected to avoid a busy-loop).

- **Event-driven runtime-metrics report on readiness edges.** The platform
  decides whether an agent can be talked to from the reported `runtime.state`,
  but that only travelled upward on the 60-second metrics tick (plus a 15-second
  initial delay), so a freshly provisioned agent could stay greyed out in the UI
  for up to a minute after it was genuinely able to work. One extra report now
  fires when the gate-relevant state changes.

  Deliberately **not** on every transition: local execution state flaps between
  busy and idle constantly while an agent works, and reporting each flap would
  turn a 1/min PUT into a continuous stream — a worse problem than the latency it
  fixes. The fingerprint is only what the platform's chat gate can act on
  (`ready`, and whether a running agent process is observable), so busy↔idle
  moves neither bit and produces no extra reports. A 5s floor bounds pathological
  flipping, suppressed edges are logged rather than silently dropped, overlapping
  reports cannot stack, and the periodic tick is untouched so any missed edge
  still heals. Opt out with `metricsReport.readinessTrigger.enabled = false`;
  `poll_ms` / `min_gap_ms` are tunable.

## [2.12.5] — 2026-08-10

### Fixed

- **The onboarding trigger no longer fires at an agent that cannot act yet.**
  `online-report` is what makes cws-core start onboarding, and it was sent the
  moment the WebSocket opened. But the socket coming up only proves the
  comm-bridge process is alive — the runtime agent behind C4 may still be
  booting, and on a fresh install no agent session exists at all (the `onOpen`
  first-connect branch already documented that "prepare phase" window). The
  server therefore began onboarding — welcome DM, seeded issues, an `active`
  onboarding session — against an agent that could not respond for minutes, so
  the first real message arrived long after onboarding was believed to have
  started. The report is now held until the agent is actually ready.

  Readiness is deliberately **not** just `state === 'idle'`: the activity
  monitor defines idle as `activeTools === 0 && inactiveSeconds >= 3`, and with
  no conversation file yet its activity source degrades
  `conv_file → tmux_activity → default`, so a still-booting runtime with no
  session reads `idle` exactly like a finished one. The gate additionally
  requires proof that a session reached its SessionStart hooks *within the
  current runtime launch*
  (`foreground-session.json.observed_at >= agent-status.json.runtime_launch_at`,
  which also rejects a stale value from a previous launch), plus `health = ok`,
  a fresh status file, sustained idle, and a not-confirmed-dead process.

  **Fail-open by design:** the gate delays the trigger, it never cancels it. The
  wait is capped (default 10 min) and then reports anyway — a permanently busy
  agent or a stopped activity monitor must not strand an org un-onboarded, which
  would trade a latency bug for a deadlock. New optional config
  `agent.readiness_gate` (`enabled`, `min_idle_seconds`, `poll_ms`,
  `max_wait_ms`, `stale_status_ms`, `heartbeat_ms`); defaults need no config
  change, and `enabled: false` restores the previous behavior. These snake_case
  keys are normalized to the module's internals at the boundary, so every
  documented knob takes effect; values that are not positive numbers are ignored
  rather than propagated, since a `NaN` cap would disable fail-open and a `NaN`
  poll interval would turn the wait into a busy spin.

  The gate only ever applies while an org still has something to report: the
  reporter now exposes `isDone(slug)` and the gate is skipped outright once the
  report has succeeded (or the endpoint 404'd), so later reconnects are not made
  to wait for readiness on their way to a no-op. Only the first check is
  synchronous — a ready agent adds no delay at all; polling starts only after a
  check fails.

  Scope note: this removes only the not-ready share of the delay. Loading the
  skill and running the Issue→Task registration flow is the agent's own
  first-turn work and is unaffected.

### Added

- **`[readiness]`-tagged diagnostics for the gate**, so a held trigger can be
  diagnosed from logs alone on machines we have no shell access to. Every hold
  logs the blocking reason plus the full snapshot behind it
  (`state=… idle=…s health=… status_age=…s session=in-launch|predates-launch|none proc=… session_id=…`),
  re-logs on a 30s heartbeat while still held (a long wait that logged once and
  then went silent was indistinguishable from a hung process), logs immediately
  when the blocker changes, and logs the outcome — ready after N seconds and how
  many polls, or the fail-open cap being reached. When several conditions fail at
  once the most fundamental one is named, so a boot window reports `no_session`
  rather than the incidental `idle_too_brief`.

## [2.12.4] — 2026-08-06

Promotes the 2.12.4 beta line to a stable release. No code changes since
`2.12.4-beta.2`; this entry consolidates what the two pre-releases shipped, and
the per-beta sections below are retained for traceability.

### Fixed

- **WebSocket dial reliability** (from `2.12.4-beta.2`) — a dial that was accepted
  but never answered left the agent offline permanently, because the pre-open
  phase had no timer and the frame watchdog only starts inside the `open`
  handler. Dialing is now single-flight, a stalled dial times out and is
  supervised, and the resend path is serialized so results queued mid-run are no
  longer discarded. Deployed and verified live before this release.
- **Connect-result delivery** (from `2.12.4-beta.2`) — connect results are
  retried and persisted, and a boot-crashing connect-result queue was repaired
  and given regression coverage.

### Security

- **Removed the client-controllable `agentMemberId`/`agent_member_id` identity
  override** (from `2.12.4-beta.1`) from every cws-connect command path,
  including the WS-driven connection-event handlers. See the beta.1 section
  below for the full account.

## [2.12.4-beta.2] — 2026-08-05

### Fixed

- **A WebSocket dial that was accepted but never answered left the agent offline permanently.** `WsClient._connect()` created the socket and attached handlers, but armed no timer for the pre-open phase — the frame watchdog only starts *inside* the `open` handler. So a dial that produced no `open`, no `error` and no `close` (black-holed hop, silent proxy, upgrade never answered) parked the client in `CONNECTING` with no timer left running: no reconnect was ever scheduled, nothing further was logged, and since presence is leased off this WebSocket the agent stayed offline until someone restarted the process. This matches an observed incident where a runtime generation logged `connecting…`, never reached `[ws] open`, was never seen by cws-comm, and sat that way until it was paused ~5 minutes later.
  - The `ws` library's `handshakeTimeout` is now passed through (default 15s, `server.ws_handshake_timeout_ms`), so a hung upgrade surfaces as an `error` and enters the existing backoff-retry path.
  - An absolute dial deadline (default 25s, `server.ws_dial_timeout_ms`) backs it up for hangs the library does not surface: the socket is terminated and a retry scheduled. It is only armed while the socket is genuinely still `CONNECTING`, and never keeps the process alive on its own.
  - Dialing is now single-flight: `_connect()` refuses to start while an attempt is already unresolved, and terminates any socket from a previous attempt before replacing it so an orphan cannot complete its handshake later and become a second session. Previously only the *scheduling* was deduped, which left a gap — nothing stopped a second dial from being started directly.
  - `_scheduleReconnect()` is now idempotent. The dial deadline and a late `close` for the same dead socket could otherwise each queue an attempt, and two concurrent dials on one credential set is precisely what causes duplicate-session trouble.
  - Reconnect logging now records how long the ws-ticket sat between being minted and being dialed, so a failed connect no longer needs a live reproduction to explain.

- **A connect-result that failed to POST was dropped, leaving the channel connected but recorded as `pending` forever.** The connector reported the outcome of a connect/disconnect once, best-effort: on failure it logged `connect-result report failed` and gave up. A single transient 5xx from cws-core therefore left the binding stuck in `pending`, which the UI renders as a permanent "connecting" spinner with no way to retry — observed live when a `connected` report came back 503 while the WhatsApp channel was in fact up and serving.
  - Delivery is now retried with backoff (3 attempts by default).
  - Anything still undelivered is persisted to `pending-connect-results.json` (owner-only) and re-sent by a new `connect-result-resend` task every 60s, which also runs at startup so a result stranded by a crash is delivered on the next boot. Entries are deduped per binding+request, capped, and dropped after 24h.

- **The first version of that on-disk queue crashed `comm-bridge` at startup.** Its file path was built from a `DATA_DIR` constant that does not exist in this repo (everything else uses `RUNTIME_DIR` from `session.js`), so the module threw `ReferenceError: DATA_DIR is not defined` while loading — the service could not boot at all. Found by writing the tests that were missing above, which is exactly the cost of having skipped them; verified by booting the entry point against an isolated `HOME`.
  - The queue is now `src/lib/connect-result-queue.js` — `createConnectResultQueue({file, sendResult, now, fsDep, log, warn, maxAgeMs, maxItems})` — with `comm-bridge.js` reduced to wiring. Same reason as `connection-events.js`: `comm-bridge.js` has side-effecting top-level startup code, so logic that lives inline in it cannot be unit-tested, and untested code in that file fails in production rather than in CI.
  - The live report and the resend now share one `postConnectResult()`, so a queued result is delivered on exactly the same path (and payload shape) as the original attempt.
  - Behaviour fixes found while testing: the queue file's parent directory is created before writing, a non-array JSON file is treated as empty rather than iterated, a resend round where *every* attempt fails no longer rewrites the file (`queuedAt` stamps must keep accruing, or an entry could never age out), and an entry with no `queuedAt` at all is dropped instead of retried forever.

- **Single-flight did not cover the phase where a dial is most likely to be duplicated.** The guard tested `state === 'connecting' && this.ws`, but `_connect()` awaits `urlProvider()` — hydration plus a single-use ws-ticket fetch — *before* any socket exists or the state advances. During that await the client looked idle, so the new stall watchdog's `ensureConnecting()` would schedule a second `_connect()`: two tickets burned, and once both resolved the second socket replaced the one that was about to succeed. The very failure the guard exists to prevent, one step earlier in the sequence. Reported in review; reproduced locally with a never-resolving provider.
  - A `dialing` flag now marks an attempt in flight from the moment `_connect()` is entered until a socket exists or the attempt bails, and `ensureConnecting()` respects it. Deliberately inlined rather than delegating to a helper: `await helper()` would defer socket creation by a microtask, and callers rely on a dial with no `urlProvider` creating its socket synchronously.
  - `_connect()` also re-checks `stopped` after `urlProvider()` resolves. A stop or disable that landed while the ticket fetch was pending previously carried on into creating a socket, reviving a client the caller had deliberately shut down.

- **A result queued while a resend was in flight was silently discarded.** `resend()` rewrote the queue file from the snapshot it read at the top of the run, but `queue()` is a synchronous read-modify-write that can land during one of the run's awaits — and in production those two are exactly concurrent (the connector's live failure path queues while the interval-driven resend task runs). Reproduced: with `[old]` queued, a slow resend running, and `new` queued mid-run, the final rewrite left `[]` — losing a result whose binding then stays `pending`, the very spinner this queue exists to prevent. Reported in re-review.
  - The rewrite now removes only the entries the run actually finished with, from the file as it stands at the end. Entries are matched on binding+request **plus `queuedAt`**, so a re-queue of the same command that arrived mid-run (which supersedes in place and carries a fresher stamp) is not mistaken for the entry just delivered and deleted.

- **The connect-result resend could overlap itself, duplicating sends and losing writes.** `TaskRegistry` invoked timer callbacks without awaiting them, and the POST had no deadline (native `fetch` has none), so a slow or hung resend overlapped the next 60s tick — each run re-sending entries the other was still working through, then clobbering its rewrite of the shared queue file. Reported in review.
  - `TaskRegistry` now serializes async ticks: a tick that lands while the previous run is in flight is a logged no-op, and a rejection is contained instead of surfacing as an `unhandledRejection`. Adds `tickNow(name)` (one tick through the same path) and `inFlight` in `list()`.
  - `createConnectResultQueue().resend()` is single-flight in its own right, so a caller other than the task cannot race it either.
  - `postForOrg` accepts an opt-in `{ timeoutMs }` (threaded to `fetch` as `AbortSignal.timeout`, per attempt so the 401 retry gets its own); the connect-result POST uses 20s. Every other caller is unchanged.

### Testing

- **22 tests for the connect-result retry/queue path, closing the gap flagged above.** `channel-connector.test.js` (+7): a transient failure followed by success delivers exactly one result and queues nothing; exhausting the attempts hands the full payload to the queue hook; backoff grows and does not sleep after the last attempt; `reportAttempts` is honoured; a queue hook that itself throws is warned about and never escapes the flow; `error` and `disconnected` receipts get the same treatment as `connected` ones. Its `makeConnector` helper gained `reportFailTimes`/`reportAttempts`/`persistFails` knobs and now exposes attempts, queued payloads and backoff sleeps — the pre-existing tests are unaffected. `connect-result-queue.test.js` (+15) covers persistence (stamping, 0600 mode, dedup per binding+request, two commands on one binding both kept, cap keeps the newest, corrupt/non-array files, an unwritable path warning instead of throwing) and resending (empty no-op, full payload delivered and cleared, a failure kept with its original stamp and retried next tick, partial failure keeping only the undelivered entry, over-age entries dropped unsent).
- **13 further tests for the review findings.** `ws.test.js` (+2): a dial whose ticket fetch is still pending counts as in flight, so neither the supervisor nor a direct re-entry starts a second one (and the original dial still completes); stopping during that pending phase abandons the dial instead of being revived by the late ticket. `connect-result-queue.test.js` (+3): an overlapping call joins the run in flight rather than starting a second (asserted by no two sends in flight and each entry delivered exactly once — overlapping runs would have doubled both), the guard does not latch after a run completes, and a run that throws internally still releases the slot. New `task-registry.test.js` (+5): duplicate registration, `runOnStart` + `list()` reporting, an in-flight async task skipping the next tick without latching, a rejecting task contained rather than unhandled, and `stopAll` clearing both timers. A further 3 for the rewrite race: a result queued during a slow run survives the final rewrite, a re-queue of the same command mid-run is not deleted as already-done, and an entry that failed mid-run keeps its stamp while a newly queued one is added. Every mechanism fix was checked by reverting it and confirming the relevant tests go red.

### Added

- **A stall supervisor (`ws-stall-watchdog`, every 30s).** Judged on connection *phase*, not liveness: a stuck dial is `CONNECTING`, not disconnected, so no liveness check can see it. If a client has been out of `open` for more than 90s it is asked to ensure an attempt is in flight. Deliberately narrow — it skips clients that were stopped on purpose and orgs no longer enabled in the live config, and it delegates timing to the client's own backoff so a broken environment cannot be amplified into a connect storm.
- `WsClient.ensureConnecting()` for that supervisor, plus `state`/`stalledMs()` phase tracking. `forceReconnect()` keeps its documented no-op-without-a-socket contract, which `ensureConnecting()` handles instead.
- Eight regression tests, including a socket that stays `CONNECTING` and emits nothing (the exact shape that used to wedge permanently), that a second dial is refused while one is in flight, and that replacing a previous attempt leaves the old socket terminated.

## [2.12.4-beta.1] — 2026-08-04

### Security

- **Removed the client-controllable `agentMemberId`/`agent_member_id` identity-override parameter from `conn.js`'s cws-connect commands, ahead of a corresponding backend fix in cws-core.** An audit found that `conn.list`, `conn.acquire`, `conn.actions`, `conn.execute`, and `conn.proxy` defaulted to the caller's own identity via `resolveSelfMemberId()`, but also accepted a client-supplied override that let a caller specify a *different* agent's `member_id` — since cws-core forwarded this value to cws-connect without verifying it matched the authenticated principal, this was a confused-deputy/IDOR-shaped gap (a caller who obtained another agent's `member_id` could acquire its credentials, proxy through its connections, or execute actions as it). A parallel fix landing in cws-core will derive `agent_member_id` from the authenticated principal server-side instead of trusting client input, making the override meaningless to send — leaving it in this CLI would misleadingly suggest it still does something.
  - **`src/cli/conn.js`:** `conn.list`, `conn.acquire`, `conn.actions`, `conn.execute`, and `conn.proxy` now call `resolveSelfMemberId()` unconditionally; the `params.agentMemberId || params.agent_member_id ||` fallback is gone. `resolveSelfMemberId()` itself is unchanged — it was always the correct default path.
  - Also found and fixed the same pattern in two capability-cache commands that route through the same underlying cws-connect endpoints: **`conn.catalog`** (resolves an app via `resolveConnectionForApp`, which hits the same `list-connect-available-connections` endpoint as `conn.list`) and **`conn.invoke`** (resolves a connection the same way, then executes via the same endpoint as `conn.execute`) — both had an identical client-overridable `agentId` that fed into those calls. Also fixed **`conn.index`**'s `{refresh}` path, which calls the same agent-connections endpoint directly. None of these three were in the original 5-endpoint list but exhibit the exact same anti-pattern against the exact same endpoints, so leaving them unfixed would have left an equivalent bypass.
  - `printUsage()` no longer documents `agentMemberId?` as an accepted param on any of these commands.
  - No compatibility break expected: no known legitimate caller (human or agent) supplied this override. This is one part of a larger, coordinated fix; the cws-core and cws-connect backend changes are tracked and landing separately in their own repos.
  - **`src/comm-bridge.js`'s WS-driven `connection.authorized`/`connection.credential_updated` handlers were a separate code path from `conn.js` and had the identical gap** — `acquireCredential()` still sent `?agent_member_id=`, and the post-authorize identity/action-catalog warm step called the *old* `/connect/agents/{agent_member_id}/connections` path (which cws-core's fix removes entirely, not just ignores — this one was a real functional break, not just a stray param). Fixed both. This logic is now extracted into `src/lib/connection-events.js` (`handleConnectionEvent`/`acquireCredential`/`isEventForMe`, dependency-injectable HTTP+storage, matching the existing DI pattern in `connect-store.js`/`credential-cache.js`/`channel-connector.js`) so it's independently testable — `comm-bridge.js` itself has side-effecting top-level startup code (WS connections, timers, signal handlers) that makes it unsafe to import directly in a test. New `src/lib/connection-events.test.js` asserts on the actual HTTP calls made for direct/proxy `connection.authorized` and `connection.credential_updated`, confirming none of them ever send `agent_member_id` or hit the old agent-scoped list path.

## [2.12.3] — 2026-08-01

### Fixed

- **A fullwidth `＠` (U+FF20) typed instead of the ASCII `@` (U+0040) silently produced a mention-less message.** This is a common CJK input-method slip (autocorrect to fullwidth punctuation while typing Chinese/Japanese, or copy-pasting from a source that already used the fullwidth form) — the outgoing text looked like a normal mention to a human reader, but carried no `mentions` data at all, so the target was never woken and there was no error or indication anything was wrong.
  - `src/lib/mention.js`: both the individual-name matcher and the `@所有人`/`@所有Agent` broadcast sentinels now accept either `@` or `＠` as the trigger character, with the same boundary-awareness as the ASCII form. `resolveMentions`'s text-canonicalization pass normalizes a fullwidth trigger to the plain ASCII `@` in its output.
  - Also fixed an early-exit guard that checked for a literal ASCII `@` before even attempting to match — a fullwidth-only message was rejected before reaching the (already fullwidth-aware) matching logic at all.
  - New test coverage: 5 cases in `src/lib/mention.test.js` (individual mention, both broadcast sentinels, boundary-awareness, canonicalization, and mixing ASCII + fullwidth triggers on one message).

## [2.12.2] — 2026-08-01

### Fixed

- **An agent's own outbound `@name` mention never woke its target, even though a human's `@name` mention (typed in the web app) worked fine.** The messaging backend only registers a mention when the sending client explicitly attaches the mentioned member's id alongside the message — it does not parse `@name` out of the message text itself. The web app's compose box already does this attachment step when a human selects someone from its @-mention picker; this repo's own send paths (`src/cli/comm.js` `comm.send`, `scripts/send.js`) never did, so an outbound `@name` from an agent was stored as plain text with no mention data at all, regardless of any group/DM permission settings.
  - **`src/lib/mention.js`:** the per-conversation participant registry now also records each participant's member id (previously display-name-only, used only for text canonicalization); a new `buildMentions(text, conversationId)` resolves `@name` tokens in outgoing text to the required mention entries, matching known participants case/spacing-tolerantly (longest name first) and deduping by member id. Returns `undefined` — not an empty array — when nothing matches, so a plain send stays identical to before. Fully backward compatible with a registry file written by an older version.
  - **Match is boundary-aware, not a bare substring test:** a shorter registered name (e.g. `luna`) no longer fires on a longer name that merely starts with it (e.g. `@luna.coco`) — a match now requires whatever follows the name to not itself be able to continue the same identifier (letter/digit/`.`/`_`/`-`), so it can't wake the wrong person. Applies to both the mention-resolution and the older text-canonicalization pass.
  - **`@所有人`/`@Everyone` and `@所有Agent`/`@所有agent`/`@All agents` broadcast mentions** are now also recognized (matching the exact literal labels the web app's own compose picker renders) and resolve to the broadcast mention entries — no participant lookup needed, and both can appear on the same message alongside individual mentions. Same boundary-awareness as above: a longer word or suffix that merely starts with one of these labels (e.g. `@EveryoneElse`, `@All agentship`, `@所有agent123`, `@所有人类`) does not upgrade to a real broadcast wake.
  - **`src/cli/comm.js` `comm.send`:** now auto-attaches resolved mentions unless the caller passes its own `mentions` (array of member ids or `{type, member_id}`).
  - **`scripts/send.js`** (the standard outbound interface): resolves mentions per chunk before each send, so a long message split across multiple posts still mentions correctly wherever the `@name` actually appears.
  - The recommended move before sending an intentional @-mention is now to look up the recipient's id first (`core.member_list` / `comm.member_list`, documented in `SKILL.md` / `references/comm-operations.md`) and pass `mentions` explicitly; auto-detection from conversation history is a fallback for a plain reply that has no parameter to carry an explicit id through, and can't find someone who hasn't spoken yet.
  - New test coverage: `src/lib/mention.test.js` (21 cases, incl. dedup, multi-mention, case/spacing tolerance, the prefix-collision fix for both individual and broadcast mentions, and backward compatibility with a pre-existing display-name-only registry file).

## [2.12.1] — 2026-07-30

First stable of the 2.12.1 line. Promotes the `2.12.1-beta.1` through `2.12.1-beta.8` prereleases to stable (the application-connections/connect capability-cache work — see the beta entries below for full per-change detail), plus one new security fix on top that did not go through a beta.

### Security

- **Token/secret values no longer appear in plaintext in RPC logs; sensitive files hardened to 0600/0700.**
  - **`src/lib/token.js`, `src/lib/client.js`:** the RPC-logging path (`COCO_RPC_LOG`, default ON) logged full request/response bodies verbatim — on the `/auth/agent/token`, `/auth/refresh`, `/auth/ws-ticket` endpoints this meant `access_token`/`refresh_token` values were written straight to the PM2 log file. Both files now run logged bodies through a new `src/lib/redact.js` (`redactSecrets()`) that replaces known-sensitive fields (`access_token`, `refresh_token`, `id_token`, `api_key`, `client_secret`, `password`, `secret`, `ticket`) with `[REDACTED]` before serializing — log *structure* (method/URL/status/non-sensitive fields, incl. `*_expires_at` timestamps) is preserved for debugging; the logging toggle itself is unchanged. New `src/lib/redact.test.js` (7 cases, incl. false-positive checks for fields that merely contain "token"/"secret" as a substring).
  - **`src/lib/token.js` `writeDisk()`:** the per-org JWT cache (`runtime/tokens/<org_id>.json`, holds a live current access_token+refresh_token) was written with default umask (0644 file / dir), world-readable. Now 0600 file / 0700 dir, with a defensive `chmodSync` on every write so a pre-existing 0644 file from before this fix also gets corrected.
  - **`src/lib/config.js` `updateConfig()`, `hooks/post-install.js`:** `config.json` (holds `agent.api_key`, the long-lived credential that mints all JWTs) was written at default umask (0644), also world-readable. Now 0600 with defensive `chmodSync`.
  - **`src/lib/group-history.js`:** full plaintext group-chat transcripts (`runtime/group-logs/*.log`) were world-readable (0644 file / 0755 dir). Now 0600/0700.
  - **`hooks/post-upgrade.js`:** added an unconditional permission-remediation step that runs on every upgrade regardless of whether the schema-migration branch fires — chmods `config.json`, `runtime/tokens/`, and `runtime/group-logs/` (dir + existing files) to 0600/0700. This is what makes the fix apply automatically to already-deployed bots on their next upgrade, not just to fresh installs or the next token/config write.
  - Found via a live audit prompted by another team reporting the same `corePost()` logging pattern in their own fork; independently verified on this host (582 log lines with token strings, 11MB `out.log`, was 0644) before this fix, plus two additional not-yet-reported issues (the token-cache file and `config.json`'s `api_key`, both also 0644 and worse than the log leak since they're live/current rather than historical). A follow-up audit of the full v2.12.0→2.12.1-beta.8 diff (the connect feature work below) found no new issues of this kind — `src/lib/credential-cache.js` was already hardened the same way in beta.5.
- **`src/lib/redact.js`'s sensitive-key set was missing the generic `token` field.** Review found `core.invitation_accept` sends `{token: params.token}` (the invitation-acceptance secret), which the exact-match set didn't cover — it stayed in plaintext despite the rest of the redaction fix above. A systematic re-check of every CLI's request-body field names found one more of the same class: `as.js`'s `upload_token`. Added `token`, `upload_token`, `verify_token` (WAB webhook credential), and `app_secret` (Meta app secret) to the set.

## [2.12.1-beta.8] — 2026-07-29

### Changed

- **`connection.authorized` now resolves full connection identity + warms the action-catalog (`src/comm-bridge.js`, `references/conn-operations.md`).** The upstream `connection.authorized` event carries only `connection_id` + `provider` (slug) — not the `application_id` or display name — so the thin index upsert left `application_id`/`name` null until the next `conn.list` (surfacing as a nameless connection card in the UI). The handler now, after the existing index upsert + (direct-mode) credential acquire, refreshes the org index from the authoritative agent-connections list (`replaceIndexFromList`) so identity (`application_id`/`slug`/`name`) is correct immediately, and **warms the app's action-catalog cache** (`writeCatalog` from `/connect/applications/{id}/actions`) so the app is invokable right after authorize instead of paying a lazy fetch on first use. Best-effort: any failure here never breaks the credential/index path. Both modes (proxy + direct) warm the catalog.

## [2.12.1-beta.7] — 2026-07-29

### Added

- **Connector capability cache + cache-aware call chain, consolidated under `runtime/connect/` (`src/lib/connect-store.js`, `src/cli/conn.js`, `src/comm-bridge.js`, `references/conn-operations.md`, `SKILL.md`).** All connect-side local state now lives under one subtree, split by natural key rather than credential mode: `connections-index.<orgId>.json` (connection → application, **per org**, both modes), `action-catalog/<applicationId>.json` (application → capability, global, both modes), and `credentials/<connectionId>.json` (real access_token — **direct/token mode only**; migrated one-time from the old `runtime/credentials/`). New cache-aware CLI verbs give any bot the recommended flow for free without needing to "know" it: `conn.invoke {app, action, params, org?}` resolves the connection for an application from the org-scoped local index (refreshing from `conn.list` on a miss **or when the cached entry still lacks an applicationId** — the sparse-event window) then executes against that org's JWT/member — authorization + token injection stay fully server-side (`connection_agents` re-checked every call); `conn.catalog {app|applicationId, org?, refresh?}` returns the action catalog, filling from `conn.app_actions` on a miss / 24h-TTL / explicit refresh; `conn.index {org?, refresh?}` inspects the index. The index is **per-org** so a multi-org agent connected to the same app in two orgs never resolves the wrong org's connection. Invalidation is TTL + error-triggered (the app-actions response carries no version/etag yet — a small cws-connect follow-up would enable precise invalidation).

### Changed

- **Proxy-mode connections no longer persist a credential blob (`src/comm-bridge.js`, `src/lib/credential-cache.js`).** The `connection.authorized` handler acquires + caches a credential **only for direct/token-mode** connections (which hold a real `access_token`); proxy-mode connections are recorded in the index but store nothing locally, since their token is injected server-side by cws-connect at call time and the old proxy cache was write-only (never read back on the request path). `connection.credential_updated` — whose upstream event carries **no** `credential_mode` — refreshes the token iff a local credential file already exists (the direct-mode marker), and drops the file if the connection is no longer direct; proxy connections (no file) are skipped without a wasted acquire. Credentials moved to `runtime/connect/credentials/` (one-time best-effort migration from `runtime/credentials/`); `connection.revoked`/`disconnected` now also remove the connection from the org's local index in addition to clearing any cached credential.

## [2.12.1-beta.6] — 2026-07-29

### Added

- **`conn.app_actions {applicationId}` — app-keyed action catalog (`src/cli/conn.js`, `references/conn-operations.md`).** New CLI verb hitting `GET /api/v1/connect/applications/{id}/actions` to list every action an application exposes, each with its `input_schema`, **without needing an existing connection**. Complements `conn.actions` (connection-scoped, agent-authorization-gated): this is capability metadata readable by any org member, useful for seeing what an app can do before connecting and for building a per-application capability cache. Resolved strictly by `applicationId` (no slug override, so URL identity always matches the result). Consumes the cws-connect `ListApplicationActions` RPC added in cws-connect-sdk-go v0.1.0-alpha.17; `conn.actions`/`conn.list` also now surface the new `input_schema` and `application_slug`/`application_name` fields automatically (pure passthrough, no code change needed).

## [2.12.1-beta.5] — 2026-07-28

### Changed

- **Hardened the local connector credential cache (`src/lib/credential-cache.js`, `src/comm-bridge.js`, `src/cli/conn.js`).** Cached credentials are now written with restrictive permissions — files `0600`, the cache directory `0700` — so acquired access tokens / proxy refs are not world-/group-readable on the host. Each cached record is enriched with its `provider` (application slug) — the acquire response carries no provider id and the file is keyed only by the connection UUID — and the read/write/clear paths are consolidated into a single `credential-cache` module reused by the comm-bridge auto-acquire flow and the `conn.cached`/`conn.clear_cache` CLI verbs. Covered by `src/lib/credential-cache.test.js`.

## [2.12.1-beta.4] — 2026-07-28

### Added

- **Connector action discovery + execution in the `conn` CLI (`src/cli/conn.js`, `references/conn-operations.md`).** Completes the agent-facing connector-action path end-to-end (cws-connect `ListActions`/`ExecuteAction` → cws-core BFF → agent):
  - `conn.actions {connectionId, agentMemberId?}` → `GET /connect/connections/{id}/actions?agent_member_id=` — discovers the connection provider's invokable actions (`[{toolkit, action, method, description, params}]`).
  - `conn.execute {connectionId, action, params?, agentMemberId?}` → `POST /connect/connections/{id}/actions/execute` — invokes a named action (`toolkit-slug/action-name`); cws-connect resolves the action and injects the token server-side, so the agent needs neither the token nor the provider URL.
  - Both carry `agent_member_id` (defaulting to the agent's own resolved member_id) so cws-connect enforces the same connection-agent authorization boundary as `conn.proxy`. Reference doc backfilled for both verbs (incl. `conn.execute`, previously undocumented) and the BFF endpoint table. (depends on cws-connect MR!40 + SDK alpha.16 + cws-core MR!401)

## [2.12.1-beta.3] — 2026-07-27

### Fixed

- **comm-bridge no longer log-spams on `delivery_state_update` frames (`src/comm-bridge.js`, #78).** cws-comm pushes a delivery-watermark frame (`{conversation_id, ack_until_seq}`) per message; in busy conversations the dispatcher's `default` branch logged `unknown frame type: delivery_state_update` at warn on every one, drowning useful bridge logs (no functional impact). The frame is now recognized and ignored like the other non-surfaced state frames (`typing`/`presence`/`read_receipt`/`read_state_update`) — it stays discoverable via the periodic frame-type metric (`recordFrameType`), so no per-frame log is emitted. The `default` branch still `warn`s on a genuinely-unknown/new frame type. (closes #78)

## [2.12.1-beta.2] — 2026-07-27

### Added

- **Conversation member-management commands in the `comm` CLI (`src/cli/comm.js`, `references/comm-operations.md`).** Adds the sanctioned CLI path for group-admin actions that previously had none (membership could only be set at group creation): `comm.member_list`, `comm.member_add` (single or `memberIds[]` batch), `comm.member_remove`, `comm.member_remove_batch`, and `comm.leave` — mapping onto endpoints cws-core already exposes. Conversation-scoped commands (incl. `get_conversation`) accept an optional `{org}` that routes through that org's JWT via the `*ForOrg` helpers, so multi-org installs avoid the identity-only-token 401 from `resolveDefaultOrgId()`; default single-org behavior is unchanged. `member_list` returns the full list (cws-core `ListMembers` is not paginated). Documented the owner-must-transfer 409, self-removal→`leave`, and batch partial-success semantics. Covered by contract tests in `src/cli/comm.test.js`. (#84 / #90)

## [2.12.1-beta.1] — 2026-07-27

### Fixed

- **@-mention detection is now by stable member ID only — fixes `@luna.coco` waking a bare `luna` agent (#85; root of cws-comm #329) (`src/lib/self-mention.js`, `src/comm-bridge.js`).** `shouldHandleMessage` previously OR'd an ID match with a fragile text/name match (`@<selfName>` regex), so `@luna.coco` matched the prefix `luna` and woke the wrong agent — fleet-wide, and it also mis-fired the `senderIsOwner && mentioned` owner-mention allowlist bypass. Detection is now decided purely from the message's structured `mentions[]` array (member UUIDs, `mentioned_id` per entry) against the agent's own `member_id`; cws-comm/cws-core treat that array as the only mention source and never parse @names from text. Text/name matching (`isSelfNameMentionedInText`) is removed entirely, so the whole name/substring/dot/hyphen collision class is gone.
  - **@all / @all_agents handled for free.** cws-comm expands `@all`/`@all_agents` into one row per targeted member carrying the real `mentioned_id`, so `@所有Agent` includes the agent's own id (matched) and `@所有人` targets human members only (not matched). The `is_mention_all` flag is intentionally not a match signal — keying off it would add no real coverage while making agents answer human-only `@所有人` broadcasts in multi-human groups.
  - Covered by `src/lib/self-mention.test.js`; verified against live int frames.

## [2.12.0] — 2026-07-26

### Added

- **Restricted Workspace Agent Diagnostics probe handler — default-off, closed-interpreter (`src/lib/diagnostics.js`, `src/comm-bridge.js`, `src/lib/config.js`).** Handles the `agent.diagnostics.command` system frame *before* LLM processing and supports exactly one action, `diagnostics.message.send_probe`, which posts a fixed-format probe message (`[workspace-diagnostics:<token>]`) to a conversation via the existing production message endpoint using the Agent runtime's own credentials — the LLM is bypassed entirely.
  - **Not a generic remote-control facility.** Every action has an explicit implementation and the send-probe body is constructed locally; the control frame cannot carry arbitrary message text, receivers, URLs, HTTP paths, headers, credentials, local paths, or commands. `command_id`, `probe_token` (`^[A-Za-z0-9_-]{8,128}$`) and `conversation_id` (`^[A-Za-z0-9_-]{1,128}$`) are all charset-validated before use, so a crafted frame cannot inject path-traversal or query-string segments into the request URL. TTL (`expires_at`) and action are validated; command IDs are deduplicated with a bounded FIFO cache; a transport failure forgets the command ID so a control-plane retry can complete (cws-comm still dedups `client_msg_id`).
  - **Disabled by default** (`diagnostics.enabled: false`) and intended only for dedicated test agents in non-production environments; both the Workspace and OpenMax diagnostics switches must be enabled for a probe to run.
  - Related Workspace changes: cws-comm MR!468, cws-core MR!397. Covered by unit tests (`src/lib/diagnostics.test.js`). (#86)

## [2.11.1] — 2026-07-23

### Fixed

- **comm-bridge: first-boot/catch-up `/sync` no longer wedges forever on an unfetchable message at the HEAD of the backlog (`src/comm-bridge.js`, `src/lib/inbox-ledger.js`, `src/lib/content-fetch-giveup.js`, `src/lib/sync-head-retry.js`).** Follow-on to #79 / PR#76. PR#76 correctly halts the `/sync` sweep (and leaves the cursor un-advanced) when a message's content can't be fetched, so a **transient** failure is re-pulled in seq order on the next sweep. But if the message at the head of the backlog is **permanently** unfetchable (e.g. a message with an empty body), the sweep halts on it every time. A full-inbox-replay (`fromStart`) sweep only runs on a WS (re)connect — the in-connection gap-detector takes the non-`fromStart` path, which returns early while the sync cursor is still `0` — so on a **stable** connection that never reconnects, the single first-boot sweep halts on the bad head and the entire backlog behind it is never delivered. A freshly started agent could therefore connect, report online, and sit idle on a backlog it never drained.
  - **Transient fetch error vs empty body — never drop a real message.** Two failure modes are distinguished and handled OPPOSITELY (`src/lib/inbound-content.js`): a **transient fetch error** (the content GET *threw* — 5xx/429/network/404-replication-lag) is `status: 'error'`; a GET that *succeeded* but returned an empty/unusable body is `status: 'skip-empty'` (poison). ONLY poison is skip-eligible. A transient error is never counted toward the give-up budget and is never skipped — the sweep halts and re-pulls it in seq order on the next reconnect (PR#76). This matters because the in-sweep retry (below) compresses what used to be reconnect-spaced attempts (minutes apart) into a ~2s burst; without this split, a brief GET outage on a single message's detail fetch would race to the give-up cap and permanently drop a **legitimate** message (exactly the high-value onboarding/owner DMs). The handler's fetch thunk therefore lets the GET *throw* (rather than swallowing errors to a null return) so the transient case is classified correctly; classification biases to "transient" whenever the terminal attempt threw.
  - **Bounded give-up.** The halt-and-retry-in-order behavior is preserved for the first `MAX_CONTENT_FETCH_ATTEMPTS - 1` (= 4) consecutive **empty-body** failures. On the **Nth** (5th) consecutive empty-body failure the bridge gives up on that one message: it (a) advances the `/sync` sweep cursor **past** it (skip + continue, instead of halting), (b) advances the inbox-ledger watermark past its seq (via a new `inboxLedger.skip(seq)`) so the gap-detector stops re-triggering `/sync` on it, and (c) emits an `ALARM` warn-log naming the msg/seq and attempt count so the (possible) data loss is observable — never silent. A successful fetch resets the counter, so only truly-**consecutive empty-body** failures accumulate, and counters are independent per seq. (Transient errors do not touch the counter.)
  - **In-sweep retry (drives give-up without a reconnect).** The give-up counter only advances when the `/sync` path re-attempts the failing head, but sweeps only fire on (re)connect — so a stable connection would otherwise reach only failure #1 and halt forever. The sweep now **re-attempts the same failing head in-sweep** (never advancing past it — seq ordering preserved) until it resolves or the give-up threshold is reached, so a single sweep drains the counter and skips a permanently-bad head **independent of reconnects**. Bounded by a hard per-head attempt cap (`SYNC_HEAD_MAX_INSWEEP_ATTEMPTS`, comfortably above the give-up threshold) as a safety net; if the counter cannot advance (e.g. the seq is already at/behind the ledger watermark) the loop falls back to PR#76 halt-ordering rather than spinning. Backoff between in-sweep attempts is `config.message.content_fetch_giveup_retry_delay_ms` (default 400ms). A whole-sweep retry budget (`SYNC_SWEEP_MAX_RETRY_BUDGET` = 20) caps the *total* in-sweep re-attempts across one sweep, so a pathological backlog with many consecutive bad heads can't drag a single catch-up sweep out indefinitely (or hold the per-org sync guard). Because giving up on one empty-body head costs 4 re-attempts, **one sweep skips at most ~5 empty-body heads**; a 6th within the same sweep halts and is deferred to the next reconnect (a delay, not a permanent wedge — reconnects recur, and each subsequent sweep skips the next batch; the persisted counter carries progress across them). In practice a first-boot backlog has a single empty head (the seeded welcome DM), so one sweep clears it.
  - **Durable counter.** The per-seq consecutive-failure count is persisted in the inbox-ledger file (`runtime/inbox-{org}.json`, new `fetch_failures` field) so it keeps accumulating across process restarts and reconnects — the wedge's signature also includes repeated connect→restart→reconnect legs, so an in-memory-only counter would reset every restart and never reach the cap.
  - **Realtime path unchanged below the cap.** A realtime content-fetch failure still `forceReconnect()`s as before; after reconnect the same message re-appears on the `/sync` path (where it carries a seq) and is counted there, so it can't loop forever either.
  - The give-up decision and the in-sweep retry loop are extracted into small pure, unit-tested helpers (`src/lib/content-fetch-giveup.js`, `src/lib/sync-head-retry.js` — the latter's tests cover the "stable connection, no reconnect, permanent empty head → head skipped, backlog delivered" acceptance case); ledger persistence/skip behavior and cross-reload count survival are covered in `src/lib/inbox-ledger.test.js`.
  - Note: the reason a seeded welcome message can arrive with an empty body is a separate server-side issue tracked independently; this change is the correct client behavior in the meantime.

## [2.11.0] — 2026-07-23

First stable of the 2.11 line. Promotes the `2.11.0-beta.1` and `2.11.0-beta.2` prereleases to stable — no code changes beyond those two betas. Highlights: the first-boot inbox-replay fix (#79) from beta.2 — a freshly started agent no longer discards the inbox backlog it should act on, instead of connecting, reporting online, and then sitting idle — plus beta.1's channel-liveness 404 backoff, the `[COCO …]` → `[OPENMAX …]` inbound-tag rebrand, and the empty-message fix. See the beta entries below for full per-change detail.

## [2.11.0-beta.2] — 2026-07-23

Beta prerelease bundling the first-boot inbox-replay fix (#79). Pre-release — stable `zylos upgrade --check` does not pull `-beta` tags; use `--beta` to test. Promote to `2.11.0` (no suffix) once validated.

### Fixed

- **comm-bridge: first-boot now replays and dispatches the inbox backlog instead of discarding it (`src/comm-bridge.js`, `src/lib/inbox-ledger.js`).** On the first-ever connect (`sync_seq=0`) the bridge used to call `initSyncSeq`, which paged the whole inbox only to seek the cursor to the **end** and `ackSync` past everything — silently dropping the messages a freshly started agent must act on. Combined with the runtime briefly starting a comm-bridge during the prepare phase (which connects, then drops right as those messages arrive), a fresh agent could connect, report online, and then sit idle on an inbox backlog it never acted on (#79). Now the first-connect path **replays `/sync` from seq 0 and dispatches each event** (`syncMissedEvents(..., { fromStart: true })`), so the backlog is delivered in order. Also, the first-boot replay clears **both** dedupe layers so a prepare-phase bridge that recorded-but-never-delivered a message cannot suppress it: (a) `inbox-ledger` gains `resetReceived()` (seq-level), called before the replay; (b) the message-id deduper (`runtime/dedup.json`, checked earlier in the handler than the ledger) is `forget()`-ten per replayed backlog entry — the first-boot events now carry a `_firstBoot` marker so the handler drops any stale id mark before its duplicate check. Without (b) the replay would still be swallowed by a tainted `dedup.json` even after (a). Additionally: if the durable ledger `acked_seq` is ahead of a lost/reset session cursor, the session cursor is seeded from it so a warm agent is not mistaken for a first boot and does not replay its whole inbox. `initSyncSeq` (seek-to-inbox-end) is removed. The full unacked window replay is bounded by the existing `SYNC_MAX_EVENTS` per-sweep cap. (closes #79)

## [2.11.0-beta.1] — 2026-07-21

Beta bundling the unreleased channel-liveness 404 backoff (was staged as 2.10.3, never tagged), the inbound-tag rebrand, and the empty-message fix. Pre-release — stable `zylos upgrade --check` does not pull `-beta` tags; use `--beta` to test. Promote to `2.11.0` (no suffix) once validated.

### Changed

- **Inbound conversation tag rebranded `[COCO …]` → `[OPENMAX …]` (`src/lib/message.js`).** The `TYPE_TAG` prefix the agent sees on each inbound message (`[OPENMAX DM]`/`[OPENMAX GROUP]`/`[OPENMAX THREAD]`) was a hardcoded brand string. The `(org: <name>)` suffix is unchanged (still config `org_name`); `parseEndpoint` still strips the legacy `[COCO …]/` prefix (and now `[OPENMAX …]/`) for back-compat — routing is unaffected (by conversation id). (PR #75)

### Fixed

- **comm-bridge: retry inbound content fetch; never forward an empty message (`src/lib/inbound-content.js`, `src/comm-bridge.js`).** The WS `message` frame carries only metadata; the body comes from a follow-up content fetch to the platform backend. On failure that fetch used to return `null` and the handler forwarded a metadata-only **empty** message. Now: retry once (`config.message.content_fetch_retries`, default 1; `content_fetch_retry_delay_ms`, default 400); if still failing, do **not** forward and do **not** advance read-state/cursor — realtime frames `forceReconnect()` so `/sync` replays in order, sync-replay frames just halt cursor advance (no reconnect storm); the incident is warn-logged. (PR #76, closes #13)
- **channel-liveness reporter no longer floods `error.log` on a persistent 404 (`src/lib/channel-liveness-reporter.js`).** On production, the channel-liveness report endpoint returns `404 page not found` on every attempt (the endpoint isn't deployed on that host, while `runtime-metrics`/`reported-policy`/`sync/ack` all 200). The reporter's existing `warnedEndpoint404` guard muted its *own* warn after the first 404, but the PUT was still **issued every ~60s** — so the shared HTTP client (`client.js`) kept logging an `[rpc]` request+response pair per tick, filling `error.log` indefinitely.
  - **A 404 is not transient**, so after `disable404Threshold` (default **1**) consecutive 404s the reporter now **stops issuing the PUT entirely** — which is what actually stops the log flood — and logs the condition **once** at warn level (no per-tick pair).
  - **Self-healing:** while disabled it re-probes once every `reprobeEveryTicks` ticks (default **180**, ≈ once per 3 hours at the 60s cadence); a successful probe re-enables the reporter (logged as recovered). Set `reprobeEveryTicks: 0` to stay disabled until restart.
  - **200 and other/transient errors (5xx, network) are unchanged** — they keep retrying every tick, and any non-404 outcome resets the consecutive-404 streak so it can't accidentally disable the reporter.
  - **Config.** New optional `channelLiveness.disable404Threshold` and `channelLiveness.reprobeEveryTicks` (wired through `comm-bridge.js`).
  - Note: the endpoint being absent is **server-side** (the platform backend hasn't shipped the route to that environment); this change is the correct client behavior in the meantime. Tests extended in `src/lib/channel-liveness-reporter.test.js`.

## [2.10.1] — 2026-07-17

### Fixed

- **Client-side WS keepalive ping (`src/lib/ws.js`).** The WS client's frame-watchdog terminates the connection when no inbound frame arrives for `heartbeatIntervalMs*2 + 5s` (65s at defaults), and was designed assuming the SERVER pings every 30s to feed it. In production the client receives **zero** server pings (they don't traverse the prod path), so on quiet orgs the watchdog starved every ~65-90s and the connection churned — close code **1006** every few minutes. In a test environment server pings arrive every 30s and it stayed stable, masking the issue.
  - **Fix:** the client now sends its own WS-level ping every `pingIntervalMs` (default **20000**, comfortably below the 65s watchdog window) starting on `open`. An RFC-compliant server — or the nearest terminating proxy — auto-replies with a pong, which the existing `on('pong')` handler uses to advance `lastFrameAt`. This feeds the watchdog without depending on server pings arriving, and keeps the pipe warm through intermediaries (the standard IM keepalive direction).
  - **Purely additive / client-side.** The server-side ping path and the watchdog are unchanged. The ping timer is armed on `open` (guarded against double-arming) and cleared in `_clearTimers()` so reconnects/closes don't leak timers.
  - **Config.** New `config.server.ws_ping_interval_seconds` (seconds) overrides the 20s default; wired through `comm-bridge.js` alongside the other WS options.
  - If control-frame ping/pong ever turns out to be stripped end-to-end, an app-level JSON heartbeat (would need a server-side handler) is the documented fallback — not in this change.

## [2.10.0] — 2026-07-16

### Added

- **Channel-liveness reporter (`src/lib/channel-liveness-reporter.js`).** On the same ~60s periodic tick that drives runtime-metrics, openmax now enumerates the 13 IM channel components' pm2 online/offline status and self-reports it to the platform backend (HTTP 202). Body is `{ "channels": [{ "channel_type": ..., "online": ... }, ...] }`; identity is derived from the JWT (not the body).
  - **Reuses existing pm2/channel plumbing.** The channel → pm2-process mapping is the existing `CHANNEL_COMPONENT` table (its keys already are the platform catalog `channel_type` values), and pm2 status is read via a single shared `readPm2Statuses` helper extracted from `channel-connector.js` (one `pm2 jlist`, also now used by `defaultVerify`). No new pm2 logic.
  - **Mirrors the runtime-metrics self-report path.** Uses the authenticated org-scoped client (`putForOrg`/`apiPath`) and does a single PUT per tick to the PRIMARY org only, resolved via the shared `selectPrimaryOrg` helper (extracted from `metrics-reporter.js` and reused by both reporters) with that org's `self.member_id`. the platform keys channel state on identity (cross-org-stable), so one report is sufficient. No new HTTP/auth path.
  - **Safety guard.** If `pm2 jlist` fails or returns nothing, the tick is skipped (warned once, re-armed on recovery) — never reports "all 13 offline" on a pm2 error. Best-effort: individual PUTs are guarded (a missing endpoint 404 is warned once then skipped) and the report never throws into the shared metrics loop.
  - **Config gating.** New `channelLiveness` block mirrors `metricsReport`: enabled unless `channelLiveness.enabled: false`; cadence via `channelLiveness.intervalSeconds` (default 60s).
  - E2E requires the platform backend (with the channel-liveness endpoint) deployed to the targeted environment; code-complete but E2E-pending-deploy.

## [2.9.8] — 2026-07-16

### Security

- **Bump `ws` to `^8.21.0` (resolves to 8.21.1).** `ws` `<8.21.0` is affected by a high-severity WebSocket memory-exhaustion DoS (GHSA-96hv-2xvq-fx4p) from tiny fragments and data chunks; the lockfile previously resolved to the affected `8.20.1`. `npm audit` is now clean.

## [2.9.7] — 2026-07-15

### Fixed

- **Knowledge page links now use the `node_id` returned by `kb.page_create`.** The create-page contract now returns the generated tree node ID together with page metadata, so the Skill no longer tells agents to list the parent folder and match on `page_id`. The frontend `node=` parameter still strictly requires the tree node ID; using the page `id` remains invalid.

## [2.9.6] — 2026-07-15

### Fixed

- **`issue.accept_delivered` now defaults to the Lead's documented text-card proxy source.** The CLI previously sent `source=explicit` when the Lead omitted `source`, so the backend treated the Agent as a non-Owner and returned an acceptance-forbidden error, even after the Owner had explicitly accepted in chat. The default now matches `issue.accept_plan` and the Skill contract: during the text-card simulation period, the Lead sends `source=text_card_proxy` on the Owner's behalf after explicit human acceptance; callers may still override `source`.

## [2.9.5] — 2026-07-15

### Fixed

- **Runtime-metrics CPU and memory are now container-scoped (cgroup), not node-level.** The reporter previously took CPU/memory from the zylos-dashboard's `/api/state`, which derives them from `os.cpus()` / `os.totalmem()` — not cgroup-aware, so inside a limited container they reported the *host node's* cores/RAM and host-wide utilization instead of the container's quota and actual consumption. New `src/lib/cgroup-resources.js` (a faithful port of the runtime service's ops-daemon resource collector) reads the container's real figures: CPU from `cpu.max` / `cpu.stat:usage_usec` (v1 fallback `cpu.cfs_quota_us` / `cpuacct.usage`) with per-tick differential sampling of the cumulative counter; memory from `memory.max` / `memory.current` (v1 `memory.limit_in_bytes` / `memory.usage_in_bytes`) reporting the **working set** (`current − inactive_file`, matching `kubectl top`). cgroup v2 primary with v1 fallback; the `"max"` / `-1` / `PAGE_COUNTER_MAX` unlimited sentinels are all handled. **Disk stays sourced from the dashboard** — its `statfs` on the volume mount is already the correct container-visible scope. The reported payload shape is unchanged; only the source of the CPU/memory numbers moves. When the agent is **not** in a cgroup (external / non-containerized, `cgroup_version` "none") the reporter falls back to the dashboard's node-level CPU/memory (logged once) rather than reporting null. Unit coverage added for the collector (v2/v1, unlimited sentinels, differential sampling, counter reset, no-cgroup) and the reporter's fallback path.

## [2.9.4] — 2026-07-14

### Changed

- **onboarding-lead now sends the clickable project link to the user after `project.create` succeeds** (PR #60, closes a guidance gap). The SKILL.md onboarding guide step ③ previously instructed the agent to create the Project + Issue and deliver, but never to send the clickable `/workspace`-prefixed project link — the link-format table existed, the "send it" instruction did not. Docs-only change.

## [2.9.3] — 2026-07-13

### Changed

- **Issue intake now matches the backlog-first contract.** `issue.create` requires both `ownerMemberId` and `leadAgentId`; omitting `backlog` records the Issue in backlog, while workflows that immediately plan and execute pass `backlog:false`. The Skill now routes work that belongs in another Project by creating a separate target Issue with the original link and necessary context, without moving, closing, or otherwise mutating the original Issue.

## [2.9.2] — 2026-07-13

### Fixed

- **`tm` CLI aligned with the current platform backend contracts.** `project.list`, `issue.list`, and `issue.list_in_project` now forward the `query` search parameter; `project.create` forwards `knowledgeBaseId`, `memberIds`, and `isDefault` (project members are explicitly supplied via `memberIds` — the CLI does not inject the caller; Blueprint authors remain derived from the authenticated principal). Added organization-level `issue.list` and Project member add/remove commands. Comment listing now uses cursor pagination (offset pagination retained elsewhere). The shared HTTP client (`src/lib/client.js`) honors the documented `COCO_AUTH_TOKEN` compatibility variable. TM operation docs (`references/tm-operations.md`, `docs/dependency-coverage/tm.md`, `SKILL.md`) refreshed — Task and Attempt transition documentation now lists only valid terminal targets — and CLI wire-contract tests added (`src/cli/tm.test.js`).
  **Deployment dependency:** the `query` search parameter and `is_default` on project create require a corresponding platform backend update to be deployed. Until then, the platform backend silently ignores `query` (list endpoints return unfiltered results) and rejects `project.create` with `isDefault` with a 422 (`unexpected property body.is_default`). These capabilities activate automatically once the backend update lands; no CLI change needed.

## [2.9.1] — 2026-07-13

### Fixed

- **Group @-mentions of the bot are no longer silently dropped when the hand-configured `self.name` drifts from the agent's real display name — and the authoritative name is now guaranteed ready before any message is processed.** platform-native group messages carry the @ as plain text (no structured `mentions[]`), so mention detection matched only `orgs.<slug>.self.name` — a hand-set value that silently drifts (wrong case / suffix / stale after a rename), causing real @s to be dropped as `group:mention (not @-ed)`. Two-part fix: (a) mention detection now matches against BOTH the authoritative per-org `display_name` from the platform backend (read from the existing owner-sync self-member lookup, persisted as `self.display_name` via `setSelfDisplayName`, no extra API call) and the configured `self.name` (kept as an alias). (b) A startup/reconnect readiness barrier guarantees the authoritative name is hydrated BEFORE the WS can deliver or replay a single frame: `syncOwnerFromCore` returns an explicit `{ nameReady, reason }` (a skipped or failed self-member read can no longer be mistaken for success), and the new `lib/self-name-hydration.js` hydrator (JWT acquire → member_id write-back backfill → authoritative sync, bounded exponential-backoff retries, per-org sticky success) runs at two structural barrier points — the awaited pre-connect bootstrap, and the `WsClient` `urlProvider`, which is awaited before the socket object exists, covering the initial connect AND every reconnect's catch-up replay. Bounded fail-open so a backend outage at boot can't keep an org offline forever: after retries the connection proceeds with the persisted last-known `display_name` when one exists, else with a loud `SELF-NAME NOT HYDRATED` warning and matching degraded to the configured `self.name` until the next reconnect / periodic 5-min sync heals it. Deterministic unit coverage (9 tests) includes the incident regression: drifted `self.name`, no cached `display_name`, and an immediate plain-text `@<authoritative display_name>` replay frame handled correctly on first connect.

## [2.9.0] — 2026-07-12

### Docs

- Translated `SKILL.md` and all `references/*-operations.md` (as/comm/core/kb/tm) from Chinese to English. Documentation-only change: the always-loaded behavioral spec and on-demand operation guides are model-facing, and English is comprehended more reliably. No behavioral rules, commands, JSON keys/values, enums, IDs, or paths were altered; a faithful one-to-one translation. Also harmonized the SKILL.md Layer 3 index labels with the reference files' section headers (`Purpose` / `When to load this document` / `Out of scope for this document` / `Prerequisites`).

## [2.8.12] — 2026-07-12

### Fixed

- **Credit-arrears overdue gate now applies only to platform-managed agents — external / self-hosted agents are exempt.** The overdue gate was false-blocking EXTERNAL agents: credit-arrears enforcement is applied at the gateway and only affects platform-managed agents (they have gateway-managed LLM keys). External agents (self-hosted, bringing their own LLM key) are not gateway-managed, so the org-level enforcement flag can read true while their LLM still works — the gate would then drop their messages and send a spurious "out of credits" notice. `isOrgLLMSuspended` now resolves the agent's origin FIRST (via the platform backend, through the existing per-org authed client) and only proceeds to the plan-state / enforcement check when the origin is positively platform-created; an external or an unknown/unresolved origin returns "not suspended" immediately and skips the plan-state query entirely (fail-open — never false-blocks external or origin-unknown agents). Origin is immutable (set once at member creation) so it is cached PERMANENTLY per org_id; lookup errors / missing member_id / absent field are not cached and retry on the next message until a definitive value lands. The origin lookup is itself timeout-bounded (~800ms, raced, no retry, mirroring the plan-state deadline): a timeout is treated exactly like the unknown/error path — origin null, not cached, message allowed through and the plan-state query skipped (fail-open). The 800ms plan-state timeout and 30s plan-state cache for the platform-created path are unchanged.

## [2.8.11] — 2026-07-12

### Added

- **Credit-arrears gate — notify the user instead of waking a suspended LLM.** When an org's LLM is suspended for non-payment (欠费), a user message reaching the openmax bridge is no longer forwarded to the runtime. Credit arrears does not drop the WS (the agent stays online and keeps receiving frames; only the LLM call is blocked at the gateway), so the bridge now intercepts after `shouldHandleMessage` accepts a real user message and BEFORE `forwardToC4`: it consults the authoritative signal — the platform backend billing plan-state (queried through the existing per-org authed client, cached 30s per org) — and when suspended sends the sender a short bilingual "out of credits" notice via the same reply path a policy drop uses, then skips the forward. The check is **fail-open**: any billing-query error (network, non-200, missing field) — or the query exceeding an ~800ms hard timeout (raced, no retry) — is treated as "not suspended" so it can never black-hole a user's messages; the gateway remains the hard enforcement boundary. Only successful lookups are cached (30s); timeouts and errors are never cached, so a transient stall self-heals on the next frame. The "out of credits" notice is throttled to at most once per 5 minutes per (org + reply target) — a suspended org always has its message dropped, but a chatty sender isn't spammed. Sync-replay frames and agent senders receive no notice (avoids stale spam / reject-notice ping-pong). User-facing copy is interim pending final FE wording.

## [2.8.10] — 2026-07-12

### Added

- Parse canonical `proj://<uuid>` and `issue://<uuid>` references from inbound messages into a normalized `<work-references>` prompt block. References establish context only: they do not grant access, start work, or imply creation of a new Issue. The OpenMax skill now resolves referenced objects with the agent's own Principal and reuses an existing Issue instead of duplicating it. Canonical UUID shape is enforced and references are capped at 10 per message.

## [2.8.9] — 2026-07-11

### Fixed

- **`core.agent_domain` / `resolveAgentBaseUrl()` — malformed platform backend 200 responses now fail loudly instead of silently falling back to `AGENT_PUBLIC_BASE_URL`.** Two paths violated the documented "only a backend 404 reaches the env tier" contract: (a) `resolveAgentIdentityId()` returned `''` when the identity lookup answered 200 without an `identity_id`, silently skipping the backend domain tier entirely; (b) `resolveAgentBaseUrl()` treated a 200 from the domain lookup without `full_domain` as "no bound domain" and fell through to env. Both masked backend protocol corruption as a valid fallback — a stale env URL could keep receiving webhooks. Both cases now throw a descriptive protocol-violation `Error` (CLI: message on stderr, exit 1). **Breaking note:** callers that relied on the malformed-200 → env fallback now see an error; the env fallback remains ONLY for the 404 (no bound domain) case, and non-404 HTTP/network errors still propagate. Docs (`src/cli/core.js` usage/comments, `references/core-operations.md`) updated to the strict semantics; unit tests flipped from pinning the silent fallback to asserting the throw.

## [2.8.8] — 2026-07-11

### Added

- **`core.agent_domain` — self public base-URL resolution (step 2).** New `src/cli/core.js` command (thin wrapper over the reusable `resolveAgentBaseUrl()` in `src/lib/agent-domain.js`) that resolves the agent's OWN publicly-reachable base URL for webhook-channel URL construction (WhatsApp Business / LINE / Teams). Two-tier resolution order: **(1)** ask the platform backend for the agent's bound domain (identity_id from config `agent.identity_id`, falling back to a `/me` lookup) → `{ok:true, source:"core", full_domain, label, root_suffix, base_url}` where `base_url = "https://" + full_domain`; **(2)** on 404 (no bound domain) fall back to the `AGENT_PUBLIC_BASE_URL` env var → `{ok:true, source:"env", base_url}` (trailing slash stripped); if neither yields a URL → `{ok:false, error:"no bound domain and AGENT_PUBLIC_BASE_URL unset"}` with exit code 1. Non-404 backend errors propagate. The resolver takes injectable deps so step-3 channel code can import the same logic.

## [2.8.7] — 2026-07-10

### Removed

- **Reverted the component-reported connection-state consumption (#34 / v2.8.5)** per the 2026-07-10 architecture decision: existing channel components must not be modified for platform features, so no component will write `runtime/connection-state.json`. Connect verification returns to the bounded pm2 process-health poll. Definitive credential validation now happens server-side before any command reaches the agent.

## [2.8.6] — 2026-07-10

### Fixed

- **whatsapp QR relay never fired**: `whatsappQrLogin` read `.status` from the component's `status.json`, but zylos-whatsapp writes `.state` — the flow was blind to `qr_waiting`, relayed zero QR codes, and every connect timed out ("whatsapp login timed out waiting for scan"). Now reads `state` with `status` fallback. Found live in a test environment.

## [2.8.5] — 2026-07-10

### Changed

- **Channel-connect verification now consumes the component's REAL login state (#34).** A channel component may report its connection state by atomically writing `~/zylos/components/<component>/runtime/connection-state.json` with `{ "state": "connected" | "auth_failed" | "connecting" | "disconnected", "detail": "<short human reason, optional>", "updatedAt": "<ISO8601>" }` on every connection-state transition. The connect verification poll treats a **fresh** file (`updatedAt` ≤ 10 minutes old) as authoritative: `connected` resolves the binding as connected, `auth_failed` fails it **immediately** with the component-reported detail in the receipt (no more waiting out the verify timeout on bad credentials), and `connecting`/`disconnected` keep polling until the deadline (`component never reached connected state`). A stale, absent, or unparseable file falls back to the previous pm2-online process-health check for that tick, so components that don't write the file behave exactly as before. Fixes the incident where garbage wecom credentials still produced a `connected` binding because only pm2 process health was checked.
- `defaultVerify` now returns `{ ok, detail }` and the component-reported detail feeds the failure receipt (composing with a start error when both exist); injected `verifyConnected` deps that return a plain boolean are still accepted and normalized.

## [2.8.4] — 2026-07-10

### Fixed

- **Channel connect no longer reports a false failure when the service start races `zylos add`'s own startup** (found in a test environment: a telegram binding went `error` while the component came up fine). A thrown pm2 start/restart now defers to the connect verification (process-health poll / QR flow) instead of failing the connect immediately; the receipt only reports `starting service failed: …` when the service truly never comes online.
- **wechat QR login waits for the just-started component to become ready** (bounded 45s window) instead of crashing with `fetch failed` when the admin token file / HTTP listener hasn't appeared yet — this made the frontend show no QR at all on first connect.

### Changed

- **Failure receipts now carry a bounded, sanitized slice of the underlying error** (`install/upgrade failed: …`, `writing credentials failed: …`, `QR login flow failed: …`, `starting service failed: …`) — whitespace-collapsed, capped at 300 chars, with any credential values the flow handled masked out — so operators can diagnose from the binding row without shell access to the agent host.

## [2.8.3] — 2026-07-10

### Removed

- **Dropped the `[SYSTEM · DO FIRST]` skill-flow directive** that was appended inside every inbound `<current-message>` block (and its `message.enforceSkillFlow` config flag). Inbound messages now carry the user's words unmodified.

### Fixed

- **Config-first loaders could keep stale credentials after connect.** Five components (discord, zalo, line, whatsapp-business, ms-teams) resolve credentials config-first (`config.json` value beats the env var), so writing fresh credentials only to `~/zylos/.env` left a previously-configured `config.json` credential in effect after the restart — the pre-restart credential probe (which validates the *submitted* values) plus pm2-online could then report a false `connected`. The connector now mirrors the submitted credentials into each component's canonical `config.json` keys (`botToken`; `channelAccessToken`/`channelSecret`; `credentials.*`; `teamsAppCatalogId`) alongside the env write, so the fresh submit always wins regardless of loader precedence. The env-first components (feishu, lark, telegram, dingtalk, wecom, slack) are unaffected.

## [2.8.2] — 2026-07-10

### Added

- **QR-login channels: wechat / whatsapp.** All 13 catalog channels are now connectable. QR channels skip the credential pull entirely: connect installs/starts the component, then drives the login — wechat via the local admin API (`/v1/login/start` → poll session → relay each `qr_ready` code → `finalize` on confirm; a 409 "account already exists" resolves as already-connected), whatsapp via the component's `status.json`/`qr.png` files (`qr_waiting` → relay, `open` → connected; a persisted session reconnects with no scan). Each fresh/rotated QR is relayed through the new `reportQR` callback to the platform backend so the frontend renders it on the connecting card. Login window is 270s (inside the FE's 5-min cap); QR payloads are never logged.

## [2.8.1] — 2026-07-10

### Added

- **Channel connector: 10 more credential channels.** `CHANNEL_COMPONENT` now covers all non-QR channels — lark, telegram, dingtalk, wecom, slack, discord, zalo (Tier A outbound) and line, whatsapp_business, ms_teams (webhook-inbound; public ingress is user-managed). Each entry maps the platform catalog form fields to the component's env contract (verified against every component's config loader) plus its `enabled`/mode config.json flags. Underscore channel_types (`ms_teams`, `whatsapp_business`) translate to the hyphenated component names here — no backend rename.
- **One-shot credential probes (deep-verify).** Before any install/restart side effects, `connect` validates the submitted credentials directly against the IM platform (telegram/zalo `getMe`, feishu/lark `tenant_access_token`, dingtalk v1.0 `accessToken`, slack `auth.test` + `apps.connections.open`, discord `/users/@me`, line `/v2/bot/info`, WhatsApp Business Graph lookup, ms_teams AAD client-credentials grant). A definitive rejection reports `error` (`credential check failed: …`, secret-free detail) without touching the installed component; an unreachable API is treated as inconclusive (components may use their own proxy) and connect proceeds with the process-health fallback. wecom has no public check endpoint and skips the probe.

### Notes

- wechat / whatsapp (QR-login channels) remain unsupported by this path — they need the QR-relay flow (batch 2).
- Probe timeout is 8s; probes never log URLs, bodies, or credential values.

## [2.8.0] — 2026-07-10

### Added

- **Channel connect/disconnect lifecycle connector (feishu).** The platform dispatches a `channel.connect` / `channel.disconnect` command over the messaging service to this openmax runtime — the single channel path for all agents (platform + external). `connect` is idempotent: pull bind credentials from the platform backend with a one-shot token → probe the component → `zylos add` if missing / `zylos upgrade` if present → write creds + config → restart → verify → report the result. `disconnect` soft-disables (pm2 stop + `enabled:false`), keeping the component and credentials installed so reconnect is the same idempotent connect.
- **Connect-result callback wired to the platform backend.** The connector now reports each terminal connect/disconnect outcome to the platform backend, echoing `request_id` so the platform can match it against the in-flight command (its authorization + idempotency check). This drives the binding `pending → connected/error` (and soft-delete on disconnect), replacing installed_channels polling. Best-effort: a report failure warns and never throws out of the WS dispatcher.

### Changed

- **Runtime-metrics reporter no longer sends `installed_channels`.** Channel state is now driven by the connect-result callback above, not by polling the runtime's installed channels.

### Notes

- Connect verification is currently a bounded pm2-`online` poll (process health only); a real IM-readiness signal (feishu websocket handshake marker) is tracked in #34.

## [2.7.5] — 2026-07-09

### Changed

- **Runtime-metrics reporter now sends a single report to the primary (first-enabled) org instead of one per org.** The 60s reporter previously PUT the same payload once per active org; it now takes the first entry of the insertion-ordered active-org map (the primary org) and issues a single runtime-metrics report to the platform backend. If no org is configured, or the primary org has no `self.member_id`, it warns and skips gracefully without crashing the tick.

### Added

- **Added top-level `version` field to the runtime-metrics payload** carrying openmax's own package version (read once at module load, same pattern as auto-upgrade). A downstream service reads `body.version`.

## [2.7.4] — 2026-07-09

### Changed

- **Auto-upgrade checks are opt-in and no longer run on service restart.** Scheduled auto-upgrade now registers only when `autoUpgrade.enabled` is explicitly `true`; missing config defaults to disabled. When enabled, the first check waits for the full configured interval instead of firing shortly after process start/restart.

## [2.7.3] — 2026-07-09

### Added

- **Install IM channel components from platform channel-connect commands (external-agent channel dispatch, Phase 1: feishu).** openmax now handles `channel.*` commands relayed over the messaging service: it pulls the bind credentials from the platform backend with a one-time `X-Channel-Bind-Token`, then installs / configures / starts the mapped zylos IM component (`zylos add` → write `.env` secrets + `config.json` → pm2 restart). Fire-and-forget off the WS dispatcher (never throws), bounded timeouts so a hung `zylos`/`pm2` can't stall heartbeats, and secret values are never logged (keys only). Phase 1 wires **feishu** only; other `channel_type`s are skipped with a warning. `metrics-reporter` additionally reports `installed_channels` (from `zylos list` + `pm2 jlist`) so the platform can reconcile channel connection status. New `getForOrgWithHeaders` client helper attaches the one-shot bind token alongside the org JWT. (#27)

### Changed

- **Onboarding Lead 步③ — materialize artifacts + advance platform state (doc/behavior).** The Lead now proactively `project.create` + `issue.create` the user's first real Project/Issue once the user has stated a goal and agreed to a direction, instead of waiting for the user to explicitly say "create project" (surfaced in a live onboarding test: the project was only created after the user manually asked). Added an explicit exception to the "never implicitly create a Project" guardrail for the onboarding first-task, and clarified that the *direction* (not the act of materializing it) is what stays the user's call. Also made explicit that when the 3-step blueprint completes the Lead must `issue.deliver` the **onboarding Issue** itself (not just say "delivered" in the DM) and then request owner acceptance — otherwise the onboarding Issue stays `in_progress` and the first-delivery datapoint never fires. Acceptance stays a genuine owner action (no self-accept). Docs only (SKILL.md); no runtime code change.

## [2.7.2] — 2026-07-08

### Changed

- Onboarding Lead 步① interaction guidelines (#23): the agent opener must not
  repeat the built-in welcome greeting (go straight into the interview);
  the three interview questions are asked one at a time (wait for each answer)
  and without numbering ("第 N 个问题"). Decided by the product owner after a
  live end-to-end onboarding test (2026-07-08).

## [2.7.1] — 2026-07-08

### Fixed

- **fix(upgrade-executor): run main() under PM2 fork-mode wrapper**. PM2 fork mode starts apps through its ProcessContainer wrapper, which `require()`s the target script — so `require.main === module` was false under pm2 and the upgrader's `main()` never ran: the `zylos-openmax-upgrader` app sat online doing nothing forever. Observed on the mechanism's first live run (v2.6.0 → v2.7.0). The entry gate is now `shouldRunMain()`: direct CLI execution, or pm2-managed with `pm_exec_path` pointing at the executor itself; plain imports (unit tests, other modules) remain side-effect free. Verified end-to-end with a live v2.6.0 → v2.7.0 auto-upgrade (detect → snapshot → upgrade → restart → verify → self-clean, ~19s).


## [2.7.0] — 2026-07-08

### Added

- **feat(onboarding): boot-time online report for onboarding trigger**. On WebSocket open, the comm bridge now reports each org's agent member online to the platform backend, allowing the backend to seed or resume the org-first-agent onboarding flow. The report is idempotent, isolated from messaging, and retries from reconnects and periodic sync until it succeeds.
- **feat(core-cli): onboarding session and funnel event commands**. Added `core.onboarding_session` for discovering an org's onboarding lifecycle record and `core.onboarding_event` for reporting self-reportable onboarding milestones.
- **docs(skill): Onboarding Lead flow**. Documented how an agent leading a new org's onboarding should recognize welcome DMs, resume from existing session structure, guide the first three onboarding steps, and avoid peripheral-task upsells.

### Fixed

- **fix(onboarding): fresh-install member_id re-resolution**. The online reporter now re-reads `self.member_id` from live config when the boot-captured org config is stale, so the first token exchange write-back can trigger online-report without requiring a service restart.
- **fix(onboarding): bounded retries and older-core compatibility**. The reporter skips with a warn-once path when the backend lacks the online-report endpoint, retries transient failures from periodic sync, and deduplicates concurrent reporting attempts.

## [2.6.0] — 2026-07-08

### Added

- **feat(auto-upgrade): dedicated on-demand PM2 upgrader app**. Auto-upgrade now launches a sibling PM2 app, `zylos-openmax-upgrader`, instead of a detached child of the `zylos-openmax` service. The upgrader is parented to the PM2 daemon, survives `pm2 stop zylos-openmax` during `zylos upgrade openmax`, is not saved into the PM2 dump, and self-deletes after terminal completion.
- **feat(auto-upgrade): PM2 watchdog recovery for interrupted upgrades**. The upgrader runs with bounded PM2 autorestart. If it is killed mid-flight, the restarted instance detects a foreign running marker, marks the upgrade failed, ensures openmax is running, notifies the owner, and exits without re-running the upgrade.
- **feat(auto-upgrade): rollback snapshot and verification guardrails**. Before upgrading, the executor snapshots the installed skill directory to `runtime/rollback-snapshot`; failed post-upgrade verification restores that snapshot, restarts openmax, re-verifies, and reports whether rollback succeeded.

### Fixed

- **fix(auto-upgrade): prevent suicide upgrades and retry loops**. Service-side upgrade checks now start the PM2 upgrader asynchronously, preserve failed-version cooldown, require a real version change, and avoid blocking the comm-bridge event loop on PM2 calls.
- **fix(auto-upgrade): stale marker and zombie handling**. Running markers without a live upgrader are converted to failed after a start grace period; stopped/errored upgrader leftovers are cleaned; online-but-stale upgraders produce a one-time owner warning instead of being deleted.
- **fix(upgrade-executor): restore accuracy and bounded logs**. The executor uses array-argument process execution, atomic marker writes, version-aware interrupted-run handling, bounded log capture, and true replace-restore behavior during rollback.

## [2.5.2] — 2026-07-08

### Fixed

- **fix(metrics-reporter): authenticated dashboard state with automatic API key provisioning**. When zylos-dashboard requires auth and `metricsReport.dashboardApiKey` is missing or stale, the reporter now provisions a local `openmax-metrics` read API key through the dashboard CLI, persists it to config, exchanges it for a short-lived session token, and reports metrics in the same tick.
- **fix(metrics-reporter): dashboard API key rotate output parsing**. The dashboard CLI prints `Key:` for `generate` and `New key:` for `rotate`; the reporter now accepts both real output formats, so existing-key fleets recover through rotate instead of failing to parse the new key.
- **fix(metrics-reporter): prevent provisioning and auth retry loops**. Auto-provisioning is serialized across overlapping metrics ticks, runs at most once per process, and keeps the existing finite retry/warn-once behavior for expired tokens, invalid keys, missing dashboard CLI, and persistent 401 responses.

## [2.5.1] — 2026-07-07

### Fixed

- **fix: frontend_base_path default `/cws` → `/workspace`**. The code default in `config.js` and the fallback in `client.js` `frontendUrl()` still used the legacy `/cws` path. New installs without a config.json override would generate wrong browser links. Updated both to `/workspace` to match the current frontend basePath.
- **fix: post-upgrade migration for existing `/cws` configs**. Added a migration step in `post-upgrade.js` that auto-corrects `frontend_base_path: "/cws"` to `"/workspace"` during `zylos upgrade openmax`. Existing installs are fixed automatically on upgrade.
- **fix: hardcoded domain in `frontendUrl()` comment**. Replaced a hardcoded environment domain with a `{bff_url}` placeholder — the domain is resolved from config, not hardcoded.

## [2.5.0] — 2026-07-06

### Changed

- **feat(auto-upgrade): detached child process execution**. Re-enables self-upgrade with a safe execution model. When a new version is detected, openmax spawns a detached child process (`scripts/upgrade-executor.cjs`) that runs `zylos upgrade openmax --yes --mode overwrite`. The child is `detached: true` + `unref()`, so it survives the parent PM2 process being stopped by zylos upgrade. Post-upgrade verification checks the installed version and PM2 status match before reporting success. On failure: writes error details to the marker, then `pm2 restart zylos-openmax` as a safety net to ensure the old version comes back up. Owner DM notifications at three points: pre-upgrade ("upgrading now"), post-upgrade success, and post-upgrade failure with rollback details. Guard against concurrent upgrades via marker status check. Stale running markers (>10 min) are auto-resolved as failed.
- **GitHub API auth**: auto-upgrade now passes `GITHUB_TOKEN`/`GH_TOKEN` when available, raising the rate limit from 60/hr (unauthenticated) to 5000/hr.

### Fixed

- **fix(auto-upgrade): marker race between executor and restarted service**. `zylos upgrade` restarts the PM2 service mid-upgrade, so the restarted service's `notifyUpgradeComplete` was consuming the still-running marker before the executor could write the terminal result — reporting a successful upgrade as failed. `readAndClearMarker` now skips `running` markers (returns null, leaves file intact); the detached executor retains ownership of the marker lifecycle and writes `completed` or `failed` once it finishes.
- **fix(auto-upgrade): prevent failed upgrade retry loop**. When an upgrade failed, the service restarted, consumed the failed marker, and immediately retried the same version — creating an infinite restart→fail→retry loop. Added version-specific cooldown: failed target version is recorded in `upgrade-failed-version`; `checkForUpdates` skips that version until a newer release is available. Successful upgrades clear the record.

## [2.4.3] — 2026-07-06

### Fixed

- **fix(auto-upgrade): disable self-upgrade execution**. The auto-upgrade timer was calling `zylos upgrade openmax` from within the openmax process — a suicide upgrade that stops its own PM2 service mid-execution, leaving the service stopped and files potentially unupdated. Now the timer only detects new versions and notifies owners via DM with the manual upgrade command. The `notifyUpgradeComplete` startup hook is preserved for external upgrades that leave a marker.

## [2.4.2] — 2026-07-06

### Fixed

- **fix(skill): frontend URL basePath /cws → /workspace**. The frontend migrated its default base path to `/workspace`. Updated all frontend URL templates in SKILL.md and removed a hardcoded test environment domain.

## [2.4.1] — 2026-07-03

### Fixed

- **fix(auto-upgrade): owner DM notification** — `notifyOwners` read `res?.data?.id` but the create-DM endpoint returns `{ conversation: { id } }`; fixed to `res?.conversation?.id`.
- **fix(auto-upgrade): runUpgrade flags** — added `--yes` (skip interactive confirmation in non-TTY) and `--mode overwrite` to the `zylos upgrade` invocation.

## [2.4.0] — 2026-07-02

### Added

- **feat(comm-bridge): channel-connect WS event handling**. Handles `connection.authorized`, `connection.revoked`, `connection.disconnected`, `connection.credential_updated`, and `connection.reauth_needed` system events. On authorization, acquires credentials from the platform backend and caches them locally at `runtime/credentials/{id}.json`. Revoke/disconnect clears the cache; credential_updated re-acquires. Events are filtered by agent member_id.
- **feat(cli): conn.js — Connection management CLI**. New CLI module (`src/cli/conn.js`) with 6 commands: `conn.list` (available connections), `conn.acquire` (credential acquisition), `conn.proxy` (proxy-mode request forwarding), `conn.status` (connection details), `conn.cached` (local credential cache), `conn.clear_cache` (cache cleanup).
- **docs: conn-operations.md** — Operation reference for the connection CLI, including credential modes (direct/proxy), WS event flow, and backend endpoint mapping.

## [2.3.1] — 2026-07-02

### Fixed

- **fix(auto-upgrade): ZYLOS_BIN path resolution**. Hardcoded `~/zylos/zylos` path fails when zylos is installed via npm (nvm PATH). Now uses `process.env.ZYLOS_BIN || 'zylos'` for PATH-based lookup.
- **fix(metrics-reporter): field name mismatch with the backend schema**. Renamed `mem_total` → `mem_total_bytes`, `mem_used` → `mem_used_bytes`, `disk_free` → `disk_free_bytes` to match the backend's runtime-metrics schema. Removed `reported_at` from the request body (server-side field).

## [2.3.0] — 2026-07-02

### Added

- **feat(comm-bridge): runtime metrics reporting to the platform backend**. Periodically reads agent runtime metrics (CPU, memory, disk, context, cost, state, model) from zylos-dashboard's `/api/state` and reports them to the platform backend. Registered as a 60s periodic task, configurable via `config.metricsReport`. A 404 is silently skipped (endpoint not yet deployed on the backend).

## [2.2.0] — 2026-07-01

### Added

- **feat(tm): Issue 执行计划确认与交付反馈循环命令**。
  - 新增 `issue.submit_plan` / `issue.accept_plan` / `issue.resume`，对接平台后端的计划确认流程。
  - SKILL 和 TM 参考文档改为文本卡片模拟路径：Lead 发计划/交付消息，人类回复接受后 Lead 用 `source:"text_card_proxy"` 代点；人类不接受时先对话澄清，再 `issue.resume` 回到执行中并重新计划。
- **Skill 强制：`dependsOn` 必须使用上游 Task 的 `task.id`**。实例化 Sub-task 时，下游 Task 的 `dependsOn` 要用先建出来的上游 Task 返回的 `task.id`（先建上游、拿到 id、再设下游）。调度中心的「依赖就绪」开工通知与 `task.start` 开工闸都按 task.id 匹配；用错 id 会让依赖边失效——下游 Task 永不被通知、过不了开工闸、无报错地永久卡在 assigned。动机：并发角色探针实测复现，平台后端侧已加 `CreateTask` 校验兜底。
- **Skill 行为护栏：绝不隐式创建 Project**。项目归属只能"选已有"或"用户明确要求时新建"——即便用户提到某个项目名而 bot 查不到同名项目，也禁止擅自建一个兜底，必须回过头问用户（指哪个已有项目，还是要新建）。`project.create` 仅在人类明确指示新建时才调。
- **Skill 行为护栏 #11/#12：激活即开工 + backlog 创建即澄清**。收到 `issue.activated`（owner 经 `issue.activate` 激活 backlog Issue）后，Lead **直接 `issue.start_execution` 开工**，不再回头问 owner「要不要开始 / 保持 backlog」。

### Changed

- **所有 Issue 计划统一落 Blueprint**：简单任务也先创建单 step Blueprint，`issue.submit_plan` 新流程要求传 `blueprintId`；Issue comment 记录人类看到的计划说明，Blueprint 作为计划事实源和未来 workflow 固化来源。
- `core.project_list` 默认按 `status=active` 过滤。按名称解析归属项目时不再匹配到已归档项目。
- **前端链接规则同步前端融合页**：项目/Issue URL 从嵌套路径改为 query 参数（`/projects?project={id}&issue={iid}`）。删除已移除的 `/tasks` 页面。旧路径自动重定向。

## [2.1.0] — 2026-07-01

### Added

- **feat(comm-bridge): auto-upgrade with owner notification** (`src/lib/auto-upgrade.js`)。comm-bridge.js 启动后定期（默认每 24 小时）通过 GitHub Releases API 检查 zylos-openmax 最新版本。发现新版本时自动执行 `zylos upgrade openmax`，升级完成 PM2 重启后通过 DM 通知 owner（包含版本号和 release notes 摘要）。
  - 首次检查延迟 60 秒（避免启动竞争）
  - 升级标记文件 `runtime/upgrade-marker.json` 跨重启传递版本信息
  - 通知通过平台后端的 DM 接口获取 owner DM 会话 + `scripts/send.js` 发送
  - 可通过 `config.json` 配置：`autoUpgrade.enabled`（默认 true）、`autoUpgrade.intervalHours`（默认 24）

### Changed

- **refactor(comm-bridge): TaskRegistry 统一管理定时任务** (`src/lib/task-registry.js`)。4 个应用级定时任务（typing-poll / frame-metrics / owner-config-sync / auto-upgrade）通过 `TaskRegistry` 集中注册、启动、停止。`shutdown()` 从 4 段清理代码简化为 `tasks.stopAll()` 一行。执行逻辑不变，`list()` 方法预留健康检查扩展。

## [2.0.1] — 2026-07-01

### Changed

- **docs(tm): 刷新 TM 依赖覆盖文档至 v0.7 合约** (PR #2)。Issue 状态更新为 `backlog/in_progress/pending_plan/delivered/accepted/terminated`；Task 状态新增 `assigned`；移除过时的 `claimable`/`agent_skills` 引用；新增 `include_archived`/`statuses` 参数；issueItem/taskItem schema 清理（移除 `mode`、`skill_tags`、`context_page_ids` 等已删字段）；TaskBoard 章节更新为已完全删除。
- **fix(tm): 移除 smoke 文档中已禁用的 archive/restore 流程** (PR #1)。

### Removed

- **删除 `SKILL-v2.md`** (PR #4)。根目录冗余的 SKILL 草稿文件，仅保留 `SKILL.md`。

## [1.0.66] — 2026-06-25

### Added

- **feat(tm): comment CLI 命令 + agent 间接力交付走 Task 评论**（对齐任务管理后端设计 §3/§4）。
  - 新增 `comment.create {workType, workId, bodyMarkdown}` / `comment.get {id}` / `comment.list {workType, workId}`，对接平台后端的评论接口。
  - SKILL 硬规则：worker 把 task 流转到 done 前**必须**先 `comment.create` 写完成评论（自然语言写产出物地址）；下一棒收到「依赖已就绪」DM（正文点名上游 Task、payload 带 `upstreamTaskIds`）后**先** `task.get` + `comment.list` 读上游产出再 `task.start`。

### Changed

- **去掉已删除的结构化字段参数**（the task-management backend 已删字段）：`task.create` 移除 `skillTags` / `contextPageIds`；`issue.create` / `issue.update` 移除 `dueDate` / `contextPageIds` / `inputArtifactIds`；priority 改为可选（默认 medium）。上下文改由自然语言 description + task 评论承载。
- 移除幽灵参数 `descriptionFormat`：平台所有文本默认 markdown，不再记格式。

> 注：`references/tm-operations.md` 等共享参考文档由各服务团队维护，其中对已删参数的描述需相应服务团队同步更新。

## [1.0.65] — 2026-06-24

### Changed

- **fix(hooks): post-install 和 post-upgrade 从 API 拉真实 org_name**。安装和升级时自动向平台后端查询组织真实名称，写回 `org_name`，无需依赖 `COCO_ORG_NAME` 环境变量。Best-effort：API 不通时跳过，不影响流程。

## [1.0.64] — 2026-06-24

### Changed

- **refactor(config): orgs key 使用完整 org_id，org_name 使用真实组织名**。
  - `post-install` 新建 org 时 key 从 `org-${id.slice(0,8)}` 改为完整 org_id UUID
  - `post-upgrade` 自动迁移旧 key（如 `org-019ea63a`、`legacy-test`）到完整 org_id
  - 消息头 `(org: X)` 已使用 `org_name` 原值，无拼接，不受影响
  - 完全向后兼容：旧 config 中的任何 key 格式在 runtime 中正常工作

## [1.0.63] — 2026-06-24

### Fixed

- **fix(comm-bridge): handleConfigUpdate 即时同步 + 错误日志修正**。收到 system 事件（group_mode_changed 等）更新本地 config 后，立即调 `syncConfigToComm()` 回报消息服务，不再只依赖 5 分钟定时兜底。同时将 `syncConfigToComm` 的 404 响应和 `makeOrgFrameDispatcher` 的 unknown frame type 从 `log()` 改为 `warn()`，确保异常写入 error.log。

## [1.0.62] — 2026-06-24

### Fixed

- **fix(comm-bridge): sync 游标修正 + dedup 加固 — 根治消息重放**。消息服务有两套独立 seq：per-conversation 消息 seq 和 per-user org-wide inbox seq。sync API 期望 inbox seq 但 openmax 一直存 per-conversation 的消息 seq 作为 `last_seq`，导致重启后游标指向错误位置，拉回大量已处理消息。改动：
  - **P0**: 新增 `sync_seq` 字段（inbox seq）替代 `last_seq`；`syncMissedEvents` 只从 sync response 的 `ev.seq` 更新游标，不再被实时 WS 消息的 per-conversation seq 污染；首次连接通过 `initSyncSeq` 初始化游标位置
  - **P1**: dedup 窗口 500→3000（覆盖 SYNC_MAX_EVENTS 的 1.5×）
  - **P2**: 新增 `ackSync` — sync 完成后向消息服务确认已处理的最高 seq
  - **P3**: 移除 `createDeduper` 的 `ttlMs` 死参数；清理 `last_seq` 相关注释
  - 向后兼容：首次升级自动从 `last_seq` 迁移到 `sync_seq`

## [1.0.43] - 2026-06-18

### Added
- **Issue owner support in TM CLI**: `issue.create` now forwards optional
  `ownerMemberId` as `owner_member_id`, aligning with the task-management backend issue owner /
  owner-only acceptance semantics.

### Changed
- **TM Skill guidance now treats Issue owner as acceptance authority**:
  create Issues with `ownerMemberId` set to the requesting human when an Agent
  creates on their behalf; delivered Issues must be accepted/rejected by that
  owner, not by the Agent/Lead.

## [1.0.42] - 2026-06-17

### Changed
- **Owner and config sync moved to periodic timer (5 min)**: `syncOwnerFromCore`
  and `syncConfigToComm` no longer run on WS connect; both execute every 5 min
  via a single `startPeriodicSync()` timer. Avoids blocking WS setup.

### Removed
- **`notifyPolicyChanged()` removed**: policy enforcement is code-level
  (`shouldHandleMessage`), not LLM-level; notifying the agent via C4 on
  policy changes served no purpose.

## [1.0.41] - 2026-06-17

### Added
- **Org context in message envelope**: inbound messages now include the source
  org name/id in the tag line (e.g. `[COCO DM] (org: COCO)`), so the agent
  knows which org to operate in when serving multiple orgs simultaneously.
- **Multi-org awareness in SKILL.md**: added guidance to always operate within
  the org indicated by the message tag; never cross-org.

## [1.0.40] - 2026-06-17

### Added
- **Typing indicator via emoji reaction**: on message receive, adds 👀 reaction
  (configurable via `message.receive_reaction_code`); reaction is removed when
  the agent replies or after 120 s timeout. Graceful shutdown cleans up all
  active reactions. (`src/comm-bridge.js`, `scripts/send.js`)

### Fixed
- **Reaction removal for non-reply sends**: `markTypingDone` was only triggered
  on explicit `reply-to` sends; normal conversation sends (the default path)
  never wrote the `.done` marker. Now uses `conversationId` as fallback key,
  and the poller matches by both `messageId` and `conversationId`.

## [1.0.31] - 2026-06-16

### Added
- **`task.start`** (`src/cli/tm.js`): v0.7 the task-management backend
  split claim/start. Claim now ONLY assigns a task (pending → assigned);
  `task.start` is the new step that actually begins work (assigned → running),
  opens the attempt, and enforces the `dependsOn` gate. Worker 接活两步:
  `task.claim` → `task.start`.
- **`issue.terminate`** (body `{reason?, source?}`):
  提前终止一个未结论 Issue → `terminated`. The server cascades cancellation to
  non-terminal Tasks and emits `issue.terminated` for the Lead to run cleanup.

### Changed
- **`task.claim` semantics**: no longer auto-runs or auto-creates an attempt; it
  only assigns (pending → assigned). The dependency gate moved from claim to
  `task.start`.
- **SKILL.md** state machine + guardrails updated for v0.7: new `assigned` Task
  state and `terminated` Issue state; archive is now terminal-only
  ({accepted, terminated}); added the **提前终止善后 SOP** (Lead handles
  `issue.terminated`: no revival, three-bucket triage, external irreversible
  actions decided with the human, closure message).
- `references/tm-operations.md`: documented `task.start` / `issue.terminate`,
  tightened `issue.archive` to terminal-only, fixed `task.claim` and
  create-with-assignee descriptions; command count 38 → 40.

## [1.0.21] - 2026-06-12

### Added
- **Agent owner is now synced from the platform backend, the authoritative source**
  (`src/comm-bridge.js`, `src/lib/config.js`, `src/cli/comm.js`). An agent's
  owner can be reassigned server-side via the platform backend. On every WS
  (re)connect the bridge pulls its own member record and, when the backend
  reports a different `owner_member_id`, updates both the live in-memory org config and
  `config.json` — no restart needed. Pull-based by design: ownership is never
  mutated from a pushed WS payload (a forged frame must not be able to hand the
  bot to an attacker); the authoritative read is an authenticated GET.
- **`comm.get_owner` / `comm.set_owner` / `comm.sync_owner` CLI commands**
  (`src/cli/comm.js`) for inspecting and reconciling the local owner cache
  against the backend (manual / trigger path; the running service auto-syncs on each
  reconnect). Plus `setOwner()` in `src/lib/config.js` — an authoritative
  overwrite (vs `bindOwner`'s first-DM no-op-if-bound).

### Changed
- **First-DM owner auto-bind is now an explicit fallback** — it only takes
  effect when the platform backend has no owner recorded for the agent. When the
  backend reports an owner it always wins. (`src/comm-bridge.js`)
- **Owner edits to `config.json` now apply live** via the config watcher (in
  place, no restart) — same treatment as access-policy edits. `org_id` /
  `api_key` / `self` remain structural (restart required). (`src/comm-bridge.js`)

## [1.0.19] - 2026-06-11

### Fixed
- **Media messages (image/file) rendered as a blank bubble; captions are now
  carried with the file** (`scripts/send.js`, `src/lib/message.js`).
  `sendMediaMessage` posted `content.body = {}`, while the frontend's own web client
  sends `body = { file_name, text }`; the empty body left the file/image card
  blank and dropped any caption (forcing a separate follow-up text message).
  `sendMediaMessage` now sends `body: { file_name, text? }` matching the web
  client, and `parseMediaPrefix` supports an optional newline-separated caption
  after the path (`[MEDIA:file]/path\n<caption>`) instead of merging it into the
  path (which previously caused an ENOENT send failure). Verified live against
  a test environment. (GitHub #31)

### Changed
- **Message-dedup retention `maxEntries` is now configurable (default raised
  20 → 500)** (`src/comm-bridge.js`, `src/lib/config.js`). Read from
  `config.message.dedup_max_entries` if set, else `DEFAULT_DEDUP_MAX_ENTRIES`
  (500) — mirroring the existing `dedup_ttl` override pattern. The seen-id
  window must span a full reconnect/restart catch-up (up to SYNC_MAX_EVENTS =
  2000 events); at 20, any restart whose catch-up re-pulled more than 20
  messages let the older tail age out of the window and replay as "new" inbound
  messages (observed twice during v1.0.1x upgrade restarts). 500 covers normal
  restarts and typical catch-ups, and operators can raise it via config without
  a code change. No message was ever re-executed — dedup only affects delivery,
  not action — but the replays are noisy. (GitHub #30)

## [1.0.18] - 2026-06-11

### Fixed
- **DM access control now always allows the bound owner, regardless of
  `dmPolicy`** (`src/comm-bridge.js`). Previously the DM branch checked
  `open` / `allowlist` / `owner` policies without an owner short-circuit, so
  under `dmPolicy=allowlist` the bound owner's own DMs were dropped (and the
  sender got `NOTICE_DM_NOT_ALLOWED`) unless their `member_id` was also
  manually present in `dmAllowFrom`. The group branch already had an owner
  exemption (`senderIsOwner && mentioned`); the DM branch did not. Added a
  `dm:owner-exempt` short-circuit at the top of the DM branch to mirror it.
  Matches the tracked incident for this behavior.
  The auto-bind path (first-ever DM under `owner` policy with no bound owner)
  is unchanged.

## [1.0.17] - 2026-06-11

### Changed
- **Reworked the skill-flow injection: moved from a leading `<openmax>`
  tag to an imperative directive placed INSIDE `<current-message>`, right after
  the user's words** (`src/lib/message.js`). Motivation: a leading
  component-named XML tag tends to be read as ignorable envelope/metadata
  (banner-blindness on every message), so task requests (e.g. "do a code
  review") sometimes weren't run through the task flow. Post-user placement
  uses recency + co-location with the actual ask so the directive can't be
  dismissed as envelope. New wording (English) is imperative, names task verbs
  (do-it-for-me / review / analyze / develop / integrate / research), and
  requires: for a **human** task, classify simple vs complex, register
  Issue→Task, and run the matching flow (simple = light; complex = heavy +
  Blueprint approval) before acting — don't answer as chat. `enforceSkillFlow`
  still gates the injection.

### Changed
- **Promoted "always use the coco CLI, never hand-roll BFF REST" from a 常见错误
  table row to a top-level iron rule in SKILL.md body** ("服务调用铁律"), placed
  just before the task-classification flow so it's seen whenever the skill is
  loaded. Motivation: an agent (with the skill installed) hand-rolled backend REST
  and guessed a wrong nested path for issue-update instead of the flat
  path the CLI uses. The rule now states all TM/KB/AS/Comm/Core ops go through
  `src/cli/{tm,kb,as,comm,core}.js` and directs agents to run the CLI / read the
  ops doc rather than guess REST paths. Kept the rule general — the exact
  endpoint/field details (flat-vs-nested write paths, accepted PATCH fields)
  stay in the CLI and `references/*-operations.md` as the reference. Strengthened
  the matching 常见错误 row to point at the new rule.

### Changed
- **Corrected the complex-task dependency model to bot-driven self-claim
  (status must reflect reality).** v1.0.14 described dependent steps as
  "auto-advancing" to running when their predecessor completes — but the
  the task-management backend has no such auto-advance, and more importantly auto-flipping
  a task to RUNNING without a bot actually executing it makes the status lie.
  Revised the flow (复杂任务流程 step 5/6) and guardrail #9:
  - On instantiation, **dependent steps are created WITHOUT `assigneeId`** so
    they sit in 待办 (pending); only steps with no unmet dependency are created
    WITH `assigneeId` (auto-claim → 进行中). The planned executor of a dependent
    step is recorded in the Blueprint step, not on the task, until claim time.
  - Advance is **bot-driven**: the finishing bot notifies the downstream bot
    (bot-DM), which then `task.claim`s its own task (claim validates
    `dependsOn`) → becomes assignee → 进行中 → executes. RUNNING only ever flips
    when a real bot picks the task up — no phantom "in progress".
  - Rationale: creating a dependent task WITH `assigneeId` triggers the task-management backend's
    create-time auto-claim (which does NOT check `dependsOn`), forcing it
    straight to running and leaving 待办 empty.
  - Added matching 常见错误 rows (don't pass assigneeId for dependent steps;
    don't expect backend auto-advance).

## [1.0.14] - 2026-06-10

### Changed
- **SKILL.md: complex-task guardrail now mandates one-shot instantiation of all
  Blueprint steps.** After a Blueprint is approved, the Lead MUST instantiate
  *all* steps as Tasks at once with their `dependsOn` dependencies set —
  piecemeal "create one step at a time as you go" is now explicitly forbidden.
  Dependency-driven flow: independent steps enter `running` (进行中) in parallel;
  dependent steps wait in `pending` (待办) and auto-advance to `running` once
  their predecessor is `done`. This makes the kanban/task panel show the full
  DAG of an issue from the start (what's running / waiting / blocked). Documents
  the board semantic: **待办 = planned-but-dependency-blocked steps**, not
  not-yet-decomposed steps. Added a matching row to the 常见错误 table.
- **Renamed the skill from `coco-agent` to `openmax`** for naming
  consistency — frontmatter `name`, and the per-message injected directive tag
  `<coco-agent>` → `<openmax>` (src/lib/message.js; directive body
  already referenced "openmax skill"). No code parses the tag literally,
  so the rename is behavior-neutral.
- **Trimmed redundant skill text (conservative dedup; 3-layer reinforcement
  structure kept):** removed the redundant "强制加载提示" note (enforcement lives
  in code, not in a skill declaration); consolidated the duplicated
  one-shot-instantiation wording between 复杂任务流程 step 6 and guardrail #9
  (step 6 is now the authority, #9 a terse red-line pointer); merged two
  near-identical Blueprint anti-pattern rows in the 常见错误 table into one.

## [1.0.13] - 2026-06-10

### Fixed
- **Dedup retention is now count-based instead of time-based (TTL).** The
  message_id deduper previously evicted ids after a 5-minute TTL. A
  reconnect/restart catch-up can replay up to `SYNC_MAX_EVENTS` (2000) events
  regardless of how long the bot was offline, so after an outage longer than the
  TTL the replayed ids had already aged out — letting duplicates leak back into
  delivery. `createDeduper` now retains the most recent `maxEntries` ids
  (default 5000, well above the catch-up cap) and drops the TTL sweep entirely;
  `ttlMs` is kept only for call-site backward-compat. `comm-bridge.js` wires the
  persistent deduper with `maxEntries: 20` — enough for a normal restart, where
  catch-up only re-pulls a handful. Caveat: an outage long enough that a single
  catch-up re-pulls >20 messages could replay the tail beyond the most-recent
  20; bump `maxEntries` to cover longer outages if needed.

## [1.0.12] - 2026-06-10

### Fixed
- **HOTFIX: revert the global seq-floor delivery gate from 1.0.10 — it dropped
  live messages and caused a delivery outage.** The 1.0.10 gate assumed `seq`
  was a per-org monotonic cursor and dropped any inbound with
  `seq <= sessionRef.last_seq`. In reality `seq` is **per-conversation**: after a
  reconnect catch-up advanced the single org-wide `last_seq` to a high value
  (from one busy conversation), brand-new messages in other conversations (with
  lower per-conversation seq) were misclassified as "already delivered" and
  silently dropped — no messages got through. Removed the seq gate entirely.
  Duplicate suppression now relies solely on the **id-based deduper**, which the
  1.0.10 change also made **persistent** (`runtime/dedup.json`) — that part is
  safe and is kept, so restart/reconnect still gets reduced (id-based) replay
  protection without the over-dropping bug. `last_seq` remains the catch-up
  cursor only. Lesson: never gate delivery on a per-conversation seq with an
  org-wide cursor.

## [1.0.11] - 2026-06-10

### Changed
- **post-install now gates env-vs-interactive on `COCO_API_KEY`.** Previously the
  hook chose its path purely by TTY (interactive on a terminal, env-driven
  without one). Now: if `COCO_API_KEY` has a value, the hook takes **everything**
  from env vars (borrowing the same env keys as `scripts/init-openmax.sh`:
  `COCO_BFF_URL` / `COCO_WS_URL` / `COCO_IDENTITY_ID` / `COCO_MEMBER_ID` /
  `COCO_ORG_ID` / `COCO_ORG_NAME` / `COCO_OWNER_*` / `COCO_SELF_NAME` /
  `COCO_CF_ACCESS_*`) and writes config with **no prompts — even on a TTY**.
  When `COCO_API_KEY` is absent, behavior is **unchanged**: interactive prompts
  on a TTY, otherwise the non-interactive env + auto-register bootstrap. Minimal
  change — only the path-selection gate (`useEnvPath = hasEnvApiKey || !isInteractive`)
  was added; the interactive and env blocks themselves are untouched, so the
  existing idempotency (existing `agent.api_key` is never overwritten) and the
  auto-register fallback are preserved.

## [1.0.10] - 2026-06-10

### Fixed
- **Duplicate message delivery after a service restart / WS reconnect.** The
  inbound deduper was in-memory only (`createDeduper`, a TTL Map), so a process
  restart wiped it; the persisted `last_seq` cursor was only *advanced* after
  forwarding and never used to *gate* delivery. On restart/reconnect the
  catch-up re-sync re-pulled recent messages and, with the deduper empty, they
  were re-delivered as new (observed as a burst of already-handled messages).
  Two fixes:
  - **Persistent seq floor (primary)** — `comm-bridge.js` now drops any inbound
    whose `seq <= sessionRef.last_seq` right after seq is hoisted (covers both
    live frames and sync catch-up). Since `last_seq` is persisted to
    `runtime/session.json` and reloaded on warm restart, an already-processed
    message can't be re-delivered even after the in-memory deduper resets.
    `last_seq` is still advanced only after a message is forwarded, preserving
    exactly-once delivery.
  - **Persistent deduper (belt-and-suspenders)** — `createDeduper` gained an
    optional `persistPath`; the seen-id window is backed by `runtime/dedup.json`
    (debounced atomic writes, TTL-pruned on load) so it survives a restart and
    covers the narrow crash-window case where a message was forwarded but
    `last_seq` wasn't yet saved. Best-effort: fs errors degrade to in-memory.
  - Scope: `src/comm-bridge.js` + `src/lib/ws.js` (+ `RUNTIME_DIR` export from
    `src/lib/session.js`). No protocol or cross-component changes.

## [1.0.9] - 2026-06-10

### Added
- **Forced skill-flow directive injected into every inbound envelope
  (`message.enforceSkillFlow`, default true) — enforcement L1, belt-and-suspenders
  on top of the v1.0.7 imperative description.** A `SKILL.md` is load-on-demand
  guidance, not a runtime gate: an agent only follows the task flow if it
  actually loads + obeys the coco-agent skill on that message. The skill
  description (v1.0.7) already nudges this, but per Gavin's directive we now also
  inject the rule into the message itself. `formatInboundForC4` leads every coco
  inbound message with a short `<coco-agent>` directive block (mirrors the
  existing `<smart-mode>` injection) telling the agent to **load the coco-agent
  skill and run its task flow before handling** — judge task vs. chat; if a task,
  confirm project + KB, register Issue→Task (whoever executes creates it), follow
  the simple/complex flow, and wait for the initiator's acceptance before
  set_acceptance/archive; bidirectional DM-permission check before cross-agent
  dispatch. The block is deliberately terse (a pointer, not the full skill) to
  keep per-message token cost minimal. The rule **travels with the component**:
  upgrading openmax on any bot auto-applies it, no per-bot instruction
  edits. Toggle off via `config.message.enforceSkillFlow = false`. Note: still
  strong guidance, not a hard gate — a true 100% gate needs server-side
  enforcement at task intake (the platform backend). Revives the approach from PR #18
  (previously closed in favor of the description-only route).

## [1.0.8] - 2026-06-10

### Docs
- **Complex tasks now hard-require a Blueprint + approval (was descriptive, now a guardrail).**
  The complex-task flow already *described* generating a Blueprint and getting
  it approved, but nothing forbade running a genuinely complex job in `light`
  mode — decomposing it straight into a pile of Tasks and starting work,
  skipping the blueprint and its approval gate. That shortcut hollows out the
  complex-task flow (no plan, no approval). SKILL.md now states the constraint
  explicitly in three places:
  - **判断简单/复杂** section: a new callout — *复杂任务 = heavy 模式 + Blueprint（强制，不可绕过）*；
    `light` mode is only for single-output/single-agent simple tasks; anything
    multi-step / multi-agent / dependency-bearing must go heavy + Blueprint;
    when unsure, ask.
  - **复杂任务流程** steps 3–4: generating the Blueprint and passing approval are
    marked mandatory gates — no Task may be instantiated before the Blueprint is
    approved.
  - **行为护栏** new rule 8 + two 常见错误 rows: a complex task run via `light` to
    bypass the blueprint, and instantiating Tasks with no approved Blueprint,
    are both named as errors. Per Gavin's directive.

## [1.0.7] - 2026-06-09

### Changed
- **Skill `description` rewritten into an imperative load-and-follow directive.**
  The old description ("…首次行为决策时加载") was too soft — agents (even ones on
  the latest skill) judged a request answerable directly and never loaded the
  full SKILL.md, so the task flow never triggered. The description is the exact
  signal the model uses to decide whether to load a skill, and it's **always in
  context** (auto-discovered, prompt-cached) and **travels with the component**
  (no per-bot CLAUDE.md edits). It now says: any message received via
  openmax → before handling a task, **must load and obey this skill** →
  judge task vs. chat; if a task, run the full flow (confirm project + KB →
  register Issue→Task [whoever executes creates it] → execute → initiator
  acceptance before completion/archive). Cost: the full skill loads at most once
  per session, then is cached. Chosen over per-message envelope injection
  (cheaper, portable). Honest limit: still strong guidance, not a hard runtime
  gate — a 100% gate needs server-side enforcement at task intake (the platform backend).

## [1.0.6] - 2026-06-09

### Docs
- **Cross-agent delegation: DM-permission + whoever-executes-creates-the-task; acceptance gates completion.** Three fixes after a real delegation failure (a Worker finished but its bot-DM completion report never reached the Lead):
  - **DM permission at dispatch (root cause)**: a Worker's report DM is dropped when the Lead's `dmPolicy` is `owner`/`allowlist` and the Worker isn't allowlisted — so the Lead never learns the task finished. SKILL now mandates: before delegating, add the Worker's `member_id` to the Lead's `dmAllowFrom` (set `dmPolicy=allowlist` if needed) **and** confirm the Worker's policy allows the Lead. Corrected the stale "Worker reply surfaces via WS" claim in the cross-agent section.
  - **Whoever executes creates the Task**: the Lead creates only the **Issue** + conveys the goal; the **assigned bot creates its own Task** under that Issue and claims it (Lead no longer pre-`task.create({assigneeId})`). Reconciled the role-model note (carved out the "register your own delegated work" exception) and reordered the simple-flow steps (confirm executor → create Issue → executor creates Task → execute).
  - **Human acceptance gates BOTH completion and archive**: a Worker's `attempt/task → done` only means "execution finished"; the Issue reaching **accepted (「完成」)** and **archived** both require the initiating human's 验收 — the bot never self-advances to accepted/archived.
  - New guardrail rule 7 + three common-errors rows.

## [1.0.5] - 2026-06-09

### Docs
- **Human-acceptance loop + project/KB-first ordering encoded in `SKILL.md`.**
  Two follow-ups requested after v1.0.4:
  - **Acceptance loop**: the API already supports it
    (`issue.set_acceptance {accepted, source:im|explicit, rejectionReason}` →
    accepted→archived / rejected→rework), but the behavior wasn't encoded. SKILL
    now mandates: after delivery the bot **must request acceptance from the human
    who INITIATED the task** (the task initiator, identified via the issue's
    `originConversationId` — NOT the bot itself, NOT the owner, NOT an arbitrary
    user; a Worker relays via its Lead) **and must NOT self-accept/self-archive**;
    on 验收通过 → `set_acceptance(accepted:true)` → archived; on 退回 →
    `set_acceptance(accepted:false, rejectionReason)` → reopened → executing.
    Added as guardrail rule 6 + rewrote the "验收 & 状态收敛" step in both
    simple/complex flows + three common-errors rows. "任务做完≠结束，发起人验收通过才
    归档." Stale `pending_acceptance` wording corrected to the real
    delivered→accepted→archived states.
  - **Project/KB-first ordering — BOTH simple AND complex
    tasks**: simple-task flow gets an explicit step 4 「登记 Issue→Task」 and the
    complex-task flow's step 2 now requires confirming **project + KB** with the
    user before orchestration/execution — both enforcing *confirm project/KB →
    register Issue→Task → execute* (no execute-then-backfill).
  - **Executor-bot selection must be user-confirmed**: the bot must NOT
    auto-assign the executing agent. It **recommends** based on agent
    descriptions (with rationale) but the **task initiator confirms/chooses**
    which bot runs it (COCO-self only as a confirmed fallback). Updated the
    trigger note, simple-flow step 5, complex-flow step 5 (assignee chosen at
    blueprint-approval/instantiation), guardrail rule 2, +1 common-errors row.

## [1.0.4] - 2026-06-09

### Fixed
- **Image/file messages now carry a `[image]` / `[file: name]` label in the
  message body** instead of an empty `said:`. The bridge built the C4 envelope
  with the raw text as the body (empty when an image has no caption) and only
  appended the media as a `---- <kind>: <path>` suffix, so a bare image arrived
  as `said:` with nothing after it. `comm-bridge.js` now sets the body to
  `[image]` / `[file: <name>]` (with any caption appended), keeping the
  `---- <kind>: <path>` suffix for the local path (`src/comm-bridge.js`).
- **Quoted image/file messages now reach the agent — with content, not just a
  label.** A reply that quotes an image/file with no caption produced empty
  quoted text, so the whole `<replying-to>` was dropped (the agent couldn't even
  tell an image was quoted). `comm-bridge.js` now (1) labels the quoted media as
  `[image]` / `[file: <name>]`, and (2) downloads the quoted message's
  attachment and appends `---- <kind>: <path>` to the quoted text, so the agent
  can actually read the referenced media — not merely know it exists
  (`src/comm-bridge.js`).

### Docs
- **Mandatory task-lifecycle guardrails added to `SKILL.md`** (new
  「任务生命周期护栏（强制）」section under 行为护栏). Encodes the behaviors that
  were defined-but-not-followed: (1) **every** handling must first create a Task
  in TM (Issue→Task) before executing — no "small enough to skip" exception, (2)
  require user project/KB selection for deliverable tasks
  (default Inbox only for internal bug-filing), (3) notify the user at the
  moment of every issue/task status transition, (4) notify on every task
  completion, (5) auto-continue to the next task by priority after finishing
  one. Closes the agent-conformance issues.
- **Hardened the project/KB-selection + Issue→Task trigger rules** after a
  smoke test showed a simple research task (gold-price analysis / connector
  list) skipping project/KB selection. Changes: the 触发 section now lists two
  non-skippable up-front actions for any 任务 — register Issue→Task, and confirm
  project + KB — explicitly **not exempt for "simple" tasks**; simple-task flow
  steps 2/3 make project/KB a mandatory question (禁止默默用默认); guardrail rule 1
  names skipping Issue→Task registration as the #1 root cause of "task flow not
  triggered"; guardrail rule 2 states simple research/analysis reports are NOT
  exempt. Closes the project/KB-selection gap.

## [1.0.3] - 2026-06-09

### Added
- **`COCO_RPC_LOG_FILE` env var** — append every RPC request/response line to a
  file, independent of the stdout sink (`COCO_RPC_LOG`). Use case: in
  integration phase we run smoke tests with `COCO_RPC_LOG=0` to keep the test
  client output readable, but still want full RPC traces on disk for
  post-mortem. Set `COCO_RPC_LOG_FILE=<path>` to enable file logging; unset or
  empty disables it. Format: `<ISO-timestamp> [rpc] → <method> <url> req: ...`
  / `[rpc] ← <method> <url> resp <status>: ...`. Wired in both
  `src/lib/client.js` (REST traffic) and `src/lib/token.js` (auth handshake).
  Best-effort: disk errors are swallowed silently so RPCs never fail because
  the log file is unwritable.
- **Outbound @-mention canonicalization** (`src/lib/mention.js`). the frontend
  highlights a mention by matching `@<participant display_name>` in the message
  text (no member_id/token in the body — purely client-side name matching). The
  bridge now records the display names it sees per conversation
  (`recordParticipants`, from inbound sender + group context), and `send.js`
  runs `resolveMentions` to canonicalize any `@name` token in outbound text to
  the exact recorded display_name (case/spacing-tolerant, longest-name-first),
  so the agent's mentions land on the frontend's matcher. Render-side highlighting for
  agent (`AGENT_TEXT`) messages is tracked in the frontend issue #6; once that lands,
  these canonicalized mentions light up with no further change here.

### Fixed
- **Quoted/reply messages now reach the agent.** When an inbound message is a
  reply (the messaging service `parent_id`), the bridge fetches the quoted message and
  surfaces it as a `<replying-to>` block. Previously `comm-bridge.js` never
  built `quotedContent`, so replies were invisible to the agent even though
  `formatInboundForC4` already supported the block (`src/comm-bridge.js`).
- **`<group-context>` is now chronological (oldest→newest).** the messaging service
  `list-messages` with `before_seq` returns DESC (newest→oldest); the bridge
  passed that order straight through, so group history read backwards. It now
  sorts the fetched context ascending by `seq` before formatting
  (`src/comm-bridge.js`).

### Docs
- **Access-control section added to `SKILL.md`** documenting per-org
  `dmPolicy` (`open`/`allowlist`/`owner`), `groupPolicy`
  (`open`/`allowlist`/`disabled`), per-group `mode`/`allowFrom`, and
  `dmAllowFrom` — all keyed by the platform backend `member_id`, with a config example and
  the DM/group independence note (closes #10).

## [1.0.2] - 2026-06-09

### Changed
- **Invitation CLI aligned with the create-time display-name contract.** The invitee display name is now set when the invitation is
  created (stored on the invitation, becomes `members.display_name` on accept)
  rather than supplied at accept time:
  - `core.invitation_create` now sends a **required** `display_name`
    (accepts `displayName` or `display_name`; server rejects blank with 400).
  - `core.invitation_accept` no longer sends `display_name` — the body is now
    just `{token}` (sending `display_name` would be schema-invalid post-#86).
  - Usage text and `references/core-operations.md` (command rows + flow
    examples) updated to match.
- **Improved the inbound message envelope** delivered to the agent, for
  parity with other C4 channels:
  - Resolve the sender's display name (and group-context senders) via a cached
    member lookup, falling back to the raw member id only when no
    name is available.
  - Minimal `reply via` target: `<conversationId>[|reply:..][|thread:..]
    [|parent:..]` — the `[COCO TYPE]/` prefix (never used for routing) is
    dropped. `parseEndpoint` still accepts the legacy `[COCO TYPE]/...` form,
    so in-flight messages remain replyable.
  - The attributed utterance (`<name> said: <content>`) now lives inside the
    `<current-message>` block, with the conversation-type tag on its own line.

## [0.3.9] - 2026-06-03

### Fixed
- **Outbound `scripts/send.js` was POSTing the old `MessageContent[]` array
  body, which the platform backend now rejects with HTTP 422.** The backend's current
  send-message contract takes a
  single `content` object plus a top-level `type` enum:

  ```
  { client_msg_id, type, content: {content_type, body, attachments}, parent_id? }
  ```

  v0.3.8 and earlier sent:

  ```
  { client_msg_id, content: [{type, body}], reply_to? }
  ```

  Rewrote `sendText` and `sendMediaMessage` to the new schema:
  - text and markdown → `type: 'AGENT_TEXT'`,
    `content: { content_type: 'text'|'markdown', body: { text }, attachments: [] }`
  - image and file → `type: 'IMAGE'|'FILE'`, `content.attachments` array
    with `{artifact_id, file_name, content_type, size_bytes}` (mediaId
    from the artifact-store upload IS the artifact_id; mediaId stays as the
    short-name in the bridge but maps onto attachments)
  - reply target field renamed `reply_to` → `parent_id` to match
    the backend's parent-id field

- **Inbound message content arrived empty in the C4 envelope** because
  the bridge read `msg.content.text`, but after spreading the
  get-message detail into `msg`, `msg.content` is the structured
  `{content_type, body, attachments}` object — the actual text is at
  `msg.content.body.text` (or, as a string shortcut, at
  `msg.message.content`). `formatInboundForC4` therefore got an empty
  string and Claude saw `said: ` with no body. Bridge now extracts text
  via:

  ```
  msg.content?.body?.text
    || (typeof msg.message?.content === 'string' ? msg.message.content : '')
    || (typeof msg.content === 'string' ? msg.content : '')
    || ''
  ```

  and pulls the media reference from `msg.content.attachments[0]`
  (`artifact_id` / `file_name`) instead of the legacy `media_id` /
  `filename` flat fields. Legacy fallbacks are kept so older payload
  shapes still parse.

- **`fetchRecentMessages` context lines** had the same blind spot; they
  now also read `m.content.body.text` before falling back to
  `typeof m.content === 'string' ? m.content : ''`.

## [0.3.8] - 2026-06-03

### Fixed
- **`forwardToC4` was calling `c4-receive.js` with positional args
  (`<channel> <endpoint> <body>`), which `c4-receive.js` now rejects with
  `Error: Unexpected argument: openmax`.** The comm-bridge interface
  switched to named flags (`--channel` / `--endpoint` / `--content` /
  `--json`) and zylos-telegram / zylos-lark already use the new form;
  zylos-openmax never followed. The breakage was masked until
  v0.3.7 because the case-sensitivity bug in `shouldHandleMessage` was
  dropping every inbound DM before it ever reached the C4 forward step.
  - Switched `forwardToC4` to the named-flag form
    (`--channel <slug> --endpoint <endpoint> --json --content <body>`).
  - `execFile` passes argv array directly, so `body` is forwarded
    verbatim with no shell escaping required.
  - `--json` matches what telegram/lark already do, paving the way for
    parsing structured rejection responses in a future change.

## [0.3.7] - 2026-06-03

### Fixed
- **DMs were misrouted into the group/thread branch of `shouldHandleMessage`
  because of a case mismatch.** the platform backend's HTTP API returns conversation
  type as an uppercase enum (`DM` / `GROUP` / `STRAT` / `BROADCAST` /
  `BRIDGE`), but
  `src/comm-bridge.js` and `src/lib/message.js` compared against the
  lowercase wire values `'dm'` / `'group'` / `'thread'`. As a result a real
  DM with `conv.type === "DM"` fell through to the group branch and was
  dropped by `groupPolicy: "allowlist"` with an empty `groups{}`, surfacing
  as `drop ...: group:allowlist (<conv> not in groups{})` in the bridge
  log even when the inbound message was a 1-on-1 DM with the owner.
  - `shouldHandleMessage` and the late `convType` recompute in
    `handleIncomingMessage` now both normalize `conv?.type` to lowercase
    before classification.
  - `formatInboundForC4` likewise lowercases before checking
    `VALID_TYPES`, so the C4 envelope tag (`[COCO DM]` / `[COCO GROUP]` /
    `[COCO THREAD]`) reflects the actual conversation type.

### Added
- **Log every inbound WS message frame** at the entry of
  `handleIncomingMessage`, before dedupe / fetch. Previously only the
  REST follow-up content fetch left a trace, which made it
  hard to see whether a WS push had actually arrived. New format:
  ```
  [ws] [<org-slug>] message frame: id=<id> conv=<conv_id> sender=<sender_id>
  ```
  Duplicate-suppressed frames now also log
  `[ws] [<org-slug>] msg=<id> duplicate, skipping` instead of silently
  returning, so a noisy retry loop is visible in the log instead of
  appearing as a missing push.

## [0.3.6] - 2026-06-03

### Fixed
- **`ws_url` was sticky across re-installs.** Both `hooks/configure.js`
  and `hooks/post-install.js` only auto-derived `ws_url` from the
  (possibly new) `bff_url` when the existing `config.server.ws_url` was
  empty. A previous install's `DEFAULT_CONFIG` seed
  (`ws://127.0.0.1:8080/ws`) therefore survived after the operator
  pointed `bff_url` at a real the platform backend, and the runtime kept trying to
  connect to localhost.
  - `configure.js` now re-derives `ws_url` from `bff_url` unconditionally
    when the operator did not supply `COCO_WS_URL`. Explicit
    `COCO_WS_URL` is still honored verbatim for the case where the messaging service
    is on a different host.
  - `post-install.js` Step 1 default now comes from the freshly entered
    `bff_url`, not from the stale `config.server.ws_url`. Operators can
    still override at the prompt.

## [0.3.5] - 2026-06-03

### Fixed
- **Frame watchdog killed healthy WebSocket connections at ~90s.**
  `src/lib/ws.js` only refreshed `lastFrameAt` inside the `'message'`
  event handler, which fires for data frames only. the messaging service sends
  WebSocket protocol-level **Ping** control frames every 30s, and the npm `ws`
  library auto-replies with Pong frames — but those control frames fire
  the `'ping'` / `'pong'` events, NOT `'message'`. So even on a perfectly
  healthy connection the watchdog saw "no frames received within the
  65 s window" at its third 30 s tick and called `ws.terminate()`,
  producing a misleading abnormal-close cycle (code 1006).
  - Subscribed `ws.on('ping')` and `ws.on('pong')` to also refresh
    `lastFrameAt`.
  - Added a single-line `[ws] ping received` debug trace so server-side
    Ping cadence is visible in `pm2 logs` (cheap — the server's default
    ping interval is 30 s).

## [0.3.4] - 2026-06-02

### Breaking
- **`COCO_ORG_IDS` (plural, comma-separated) replaced by `COCO_ORG_ID`
  (singular).** The non-interactive install path now binds exactly one
  (agent, org) pair per prepare run, matching the agent-manager SDK's
  channel-auth initialization payload shape 1:1.
  Operators that need a single runtime to serve multiple orgs run the
  prepare hook once per org_id; the hook is idempotent (existing
  `config.agent.api_key` and existing `org_id` blocks short-circuit), so
  re-running is safe. The interactive (`zylos add`) flow keeps its
  multi-org loop unchanged.

### Added
- **Channel-auth-aligned org metadata env vars** in the non-interactive
  install path. An operator with a channel-auth payload can
  map every field to env vars 1:1:
  - `COCO_ORG_NAME`        → payload `org_name`        → `orgs.<slug>.org_name`
  - `COCO_OWNER_MEMBER_ID` → payload `owner.member_id` → `orgs.<slug>.owner.member_id`
  - `COCO_OWNER_NAME`      → payload `owner.name`      → `orgs.<slug>.owner.name`
  - `COCO_SELF_NAME`       → payload `self.name`       → `orgs.<slug>.self.name`
  All four are optional; absent fields fall through to existing runtime
  defaults (`owner` auto-binds on first DM under `dmPolicy=owner`,
  `self.member_id` auto-fills from JWT claims on first WS connect,
  display names start empty).
- `seedOrg(orgId, opts)` refactor: takes an options object instead of a
  positional `memberId` arg so the five org-shape fields stay named.

### Mapping reference
`channel-auth initialization payload → env var`:

| payload                     | env var                |
|---|---|
| `server.bff_url`            | `COCO_BFF_URL`         |
| `server.ws_url`             | `COCO_WS_URL`          |
| `api_key`                   | `COCO_API_KEY`         |
| `org_id`                    | `COCO_ORG_ID`          |
| `org_name`                  | `COCO_ORG_NAME`        |
| `owner.member_id`           | `COCO_OWNER_MEMBER_ID` |
| `owner.name`                | `COCO_OWNER_NAME`      |
| `self.member_id`            | `COCO_MEMBER_ID`       |
| `self.name`                 | `COCO_SELF_NAME`       |

`identity_id` is **not** in the payload; the hook continues to require
`COCO_IDENTITY_ID` for the BYO path until the payload contract decides
whether to add it.

## [0.3.3] - 2026-06-02

### Fixed
- **BYO agent prompt never fires under `zylos add`.** The configure hook
  (`hooks/configure.js`) used to delegate to `hooks/post-install.js` via
  dynamic import. Because configure runs *before* the TTY-interactive
  post-install pass, post-install detected `process.stdin.isTTY === false`
  in that nested call and went down the env-driven non-interactive branch
  — which auto-registered the agent. By the time the real (TTY-interactive)
  post-install ran, `config.agent.api_key` was already set, so the idempotency
  guard short-circuited Step 2 and the v0.3.2 BYO prompt was never asked.
- The fix narrows `configure.js` to a single responsibility: read the stdin
  JSON, persist `COCO_BFF_URL` / `COCO_WS_URL` into `config.server.*`, exit.
  It no longer registers the agent, seeds orgs, or imports post-install.
  `zylos add`'s subsequent post-install invocation then runs in TTY mode
  with `config.server.*` pre-filled as defaults and prompts BYO + org_ids
  as designed in v0.3.2.

### Migration
- If you upgraded to v0.3.2 and the auto-register fired against your will,
  your `~/zylos/components/openmax/config.json` already holds the
  unintended `agent.identity_id` + `api_key`. Two ways to recover:
  1. Delete config.json and re-run `zylos add openmax`. The BYO
     prompt will fire correctly under v0.3.3+.
  2. Manually replace `config.agent.{identity_id, api_key}` with the values
     from your pre-provisioned agent, then set
     `orgs.<slug>.self.member_id` to the corresponding member_id.

## [0.3.2] - 2026-06-02

### Added
- **Bring-your-own (BYO) agent identity at install.** Step 2 of the install
  flow now asks three fields up front — `identity_id`, `api_key`,
  `member_id`. If all three are non-empty the install uses them verbatim
  and skips agent auto-registration entirely. Any blank field falls
  back to the existing auto-register flow.
  - **Why:** when an agent was pre-provisioned elsewhere (e.g. via
    an admin API), the operator already
    has these three IDs. Forcing a re-register would burn a second identity.
  - The provided `member_id` is applied to the **first** org_id entered in
    the loop (`orgs[first].self.member_id`), since a BYO member_id is by
    definition tied to one specific org. Subsequent orgs auto-fill their
    member_id from JWT claims at runtime as before.
  - Non-interactive (env-driven) path picks up `COCO_IDENTITY_ID`,
    `COCO_API_KEY`, `COCO_MEMBER_ID` with the same all-three-or-none gate.
  - Idempotency preserved: an existing `config.agent.api_key` still
    short-circuits the whole step.

### Changed
- `SKILL.md` `config.optional` adds the three BYO env vars (api_key marked
  `sensitive: true`).

## [0.3.1] - 2026-06-02

### Added
- **Verbose RPC logging.** `client.js` and `token.js` now print every
  outbound REST call as `[rpc] → METHOD url req: {...}` /
  `[rpc] ← METHOD url resp <status>: {...}`. Enabled by default in the test
  env; set `COCO_RPC_LOG=0` to silence (intended for production once Cloudflare
  Access plumbing is removed). 4xx/5xx responses log at `warn` level.

### Changed
- **Install seed: full default `orgs.<slug>` block.** Confirms the contract
  promised in v0.3.0 docs — when interactive install accepts an org_id, the
  written block now matches the layout operators are expected to edit
  manually:
  ```json
  {
    "enabled": true,
    "org_id":   "",
    "org_name": "",
    "owner": { "member_id": "", "name": "" },
    "self":  { "member_id": "", "name": "" },
    "access": {
      "dmPolicy":    "owner",
      "groupPolicy": "allowlist",
      "groups":      {}
    }
  }
  ```
  `dmAllowFrom` is no longer pre-seeded (runtime falls back to `[]` via the
  `access.dmAllowFrom || []` guard in `shouldHandleMessage`); `self.name`
  starts empty instead of `"Zylos"` so it doesn't leak a placeholder if the
  operator never edits it.
- `token.js` member_id write-back now seeds `self` as
  `{ member_id: '', name: '' }` (was `{ name: 'Zylos' }`) when the field
  is missing, matching the new install shape.

## [0.3.0] - 2026-06-02

### Breaking
- **register-agent contract aligned with the current platform backend.** Previously the
  install hook sent `{ username, display_name }` to the agent-register
  endpoint; the platform backend now rejects those fields (HTTP 422)
  and the body must be empty `{}`. Old install transcripts have been failing
  since the the platform backend auth refactor; this MR fixes the call.
- **Install prompt surface trimmed to the bare minimum.** Interactive install
  now asks only for `bff_url`, `ws_url`, then one or more `org_id`s in a
  loop. `username`, `display_name`, `member_id`, and per-org access policy
  are no longer asked at install time. `member_id` is auto-filled from JWT
  claims on the first agent-token exchange; access policy defaults to
  `dmPolicy=owner` + `groupPolicy=allowlist` and can be edited in
  config.json afterwards.
- **`config.required` schema for `zylos add`** trimmed from five fields to
  one required (`COCO_BFF_URL`) plus two optional (`COCO_WS_URL`,
  `COCO_ORG_IDS` comma-separated). The legacy env vars
  (`COCO_AGENT_TICKET`, `COCO_AGENT_NAME`, `COCO_ORG_ID`,
  `COCO_SELF_MEMBER_ID`) are no longer read.

### Added
- **Multi-org JWT routing across the entire REST surface.** Previously
  `client.js` resolved the bearer token via `getAccessToken()` with no
  `orgId`, so multi-org agents fell back to the single-enabled-org or
  `COCO_ORG_ID` env var heuristic and could end up calling the platform backend with the
  wrong org's JWT. New `getForOrg / postForOrg / patchForOrg / putForOrg /
  delForOrg` variants thread `orgId` straight through `doRequest` into
  `getAccessToken(orgId)`. `kbClient(orgId)` and `asClient(orgId)` also pass
  the org down, so every call from the per-org WS handlers, the CLIs, and
  the comm-bridge sync sweep uses that org's cached JWT.
- **JWT claim auto-fill for `self.member_id`.** When `token.exchange` returns
  an org-scoped JWT, the `member_id` claim is decoded and written back into
  `config.orgs[slug].self.member_id` if that field was empty. This lets
  interactive install stay one-shot and lets first-time agents respond to
  `@mentions` from the very first message after their JWT is minted.
- **Inflight Promise dedup** in `token.js` (per cache key: exchange / refresh
  / per-org). Concurrent boot of N orgs no longer fans out N parallel
  token-exchange calls; the second-through-Nth caller awaits the
  first's Promise.
- **Identity-only JWT support** (token exchange with an empty body) — needed
  before an agent is in any org, e.g. to create an organization.
  `exchange('')` and `getAccessToken('')` mint and cache an identity-only
  JWT at `runtime/tokens/_identity.json`.
- **Bootstrap pre-mint.** `comm-bridge.js` now eagerly calls
  `getAccessToken(org_id)` for every enabled org before the first WS
  handshake, so `self.member_id` write-back lands before any inbound message
  hits the self-echo / @-mention filter. Failures are non-fatal — the WS
  urlProvider retries through the usual backoff loop.
- **Structured bootstrap logs** with `[install] / [bootstrap] / [token] /
  [ticket] / [ws]` prefixes; visible via `pm2 logs zylos-openmax`.

### Changed
- Registration failure during install is now a **hard failure** (exit 1,
  config.json not written). Old behavior was to print a warning and let the
  operator retry by editing config.json — that left half-bootstrapped
  configs on disk.
- `token.invalidate()` distinguishes "clear all" (no arg) from "clear this
  org" (explicit org id, `''` for identity-only).

### Temporary — remove before production
- **`src/lib/cf-access.js`** hard-codes a `CF-Access-Client-Id` /
  `CF-Access-Client-Secret` service-token pair for a test environment. Every
  outbound REST call (`client.js`, `token.js`, install hook fetch) and the
  WebSocket handshake (`ws.js`) spread `cfAccessHeaders()`. Production
  release MUST delete `cf-access.js` and the four import/spread sites it's
  referenced from.

## [0.2.5] - 2026-06-02

### Added
- `SKILL.md` frontmatter now declares the full lifecycle (modeled after
  `zylos-lark`), so `zylos add openmax` drives the install
  end-to-end instead of stopping after download + register:
  - `type: communication`
  - `lifecycle.npm: true` → triggers `npm install --omit=dev`
  - `lifecycle.service.{type, name, entry}` → registers
    `pm2 zylos-openmax` pointing at `src/comm-bridge.js`
  - `lifecycle.hooks.{post-install, post-upgrade, configure}` → wires
    the three hooks already in `hooks/`
  - `lifecycle.preserve: [config.json, logs/, runtime/]` → upgrade-safe
    fields
  - `lifecycle.data_dir` → declares the data root path explicitly
  - `upgrade.{repo, branch}` → the source repo
    on `main`
  - `config.required` → five fields (`COCO_BFF_URL`, `COCO_AGENT_TICKET`
    sensitive, `COCO_AGENT_NAME`, `COCO_ORG_ID`, `COCO_SELF_MEMBER_ID`)
    that `zylos add` will prompt the operator for.

- New `hooks/configure.js` — receives the prompted values as stdin JSON
  from `zylos add`, copies them into `process.env`, then delegates to
  `hooks/post-install.js`. This avoids reintroducing a `.env` round-trip
  (the canonical store remains `config.json`) while still letting the
  install flow drive the env-driven non-interactive bootstrap path that
  was added in v0.2.0.

### Behaviour after this version

```
zylos add openmax --branch main
  → download from the source repo
  → npm install --omit=dev
  → prompt operator for 5 config fields
  → run hooks/configure.js (writes config.json via post-install)
  → run hooks/post-install.js again (idempotent no-op — api_key already
    set so registration is skipped)
  → start pm2 zylos-openmax
```

## [0.2.4] - 2026-06-02

### Removed
- `agent.client_id` — generated by post-install as UUIDv4 but never read by
  the runtime. Dropped from `DEFAULT_CONFIG`, dropped from post-install
  generation, and stripped from existing configs (top-level and
  `agent.client_id`) by `hooks/post-upgrade.js`. Cleanup-only — no
  functional impact since the field was dead.
- `server.platform` — same story (never read by runtime). Dropped from
  `DEFAULT_CONFIG`. `hooks/post-upgrade.js` strips it from both
  `comm.platform` (legacy v0.3 location) and `server.platform`
  (intermediate v0.4 migrations).

### Changed
- `server.reconnect_max_delay` and `server.heartbeat_interval` are no
  longer in `DEFAULT_CONFIG`. Defaults are now hardcoded as constants in
  `src/comm-bridge.js`:
  - `DEFAULT_WS_RECONNECT_MAX_MS = 30_000`
  - `DEFAULT_WS_HEARTBEAT_MS     = 30_000`

  Behavior: `config.server.{reconnect_max_delay, heartbeat_interval}` are
  still honoured if set, but the `server` block can now drop down to just
  `{bff_url, ws_url}`. Existing configs that include the knobs continue
  to work — values present in config still take precedence over the
  hardcoded defaults.

## [0.2.3] - 2026-06-02

### Changed
- `message.context_messages` and `message.dedup_ttl` are no longer part of
  `DEFAULT_CONFIG`. Defaults are now hardcoded as constants in
  `src/comm-bridge.js`:
  - `DEFAULT_CONTEXT_MESSAGES = 5` (was 10; aligned with zylos-lark's
    `DEFAULT_HISTORY_LIMIT`)
  - `DEFAULT_DEDUP_TTL_MS = 5 * 60 * 1000` (unchanged; matches lark's
    `MESSAGE_DEDUP_TTL_MS`)

  Behavior: `config.message.context_messages` / `config.message.dedup_ttl`
  are still honoured if set, but the `message` block can now be **omitted
  entirely** from `config.json`. Existing configs that include the block
  continue to work — values present in config still take precedence over
  the hardcoded defaults.

## [0.2.2] - 2026-06-02

### Added
- **Reconnect catch-up**: `comm-bridge.js` now invokes the platform sync endpoint
  after every successful WS open, pulling any conversation events
  (`{conversation_id, message_id, seq}`) with `seq > sessionRef.last_seq`
  and dispatching them through the normal message handler. Each event
  passes through the existing message dedupe, so a message that arrives
  via both WS and sync is processed once. First-ever connect with
  `last_seq=0` is a no-op. The sync sweep is bounded to 2000 events per
  open and paged at 100; further backlog is pulled on the next reconnect
  (or via the `comm.sync` CLI). Per-org `_syncInFlight` guard prevents
  overlapping sweeps from a rapid reconnect storm.

### Changed
- On WS close code `4003` (session expired), `last_seq` is now **preserved**
  (only the token cache is invalidated). Previous behavior wiped the
  org session entirely, defeating sync catch-up after a session expiry.

## [0.1.0] - 2026-05-19

### Added

- Project structure and directory layout
- Communication module: `comm-bridge.js` (WebSocket to C4 bridge) skeleton
- Service CLIs: `cli/{tm,kb,as,comm,core}.js` skeletons (stateless, JSON in/out)
- Skill layer: `SKILL.md` (L1+L2) + `references/*-operations.md` (L3 on demand)
- Shared infrastructure: `lib/{client,config,ws,message,media}.js`
- Design document `DESIGN.md` v0.2
