# Core Operations Guide

**Purpose**: Identity + org/member/role/invitation directory queries + org/platform agent write operations. The entry point for Lead agent context assembly — look up who I am, who is in the org, and which projects can be dispatched to.

**When to load this document**:

- On first startup / switching org / when unsure of the current identity, query `core.me`
- When you need to find candidate members before dispatching a task, query `core.member_list` / `core.project_members`
- When you want to pull a colleague into the current org (`core.invitation_create` / `accept` / `revoke`)
- When switching to another org to work (`core.org_switch`)
- Registering a new platform agent / deregistering an old agent (`core.platform_agent_create` / `delete`)
- When you need this agent's own public domain (to assemble webhook callbacks, e.g. WAB/LINE/Teams) (`core.agent_domain`)
- Checking the role list to decide what permissions to assign a newcomer (`core.role_list`)

**Out of scope for this document**:

- Workflow for project / Issue / Task / Blueprint / Attempt → `references/tm-operations.md` (same project resource, workflow perspective)
- KB operations → `references/kb-operations.md`
- IM communication → `references/comm-operations.md`
- Files / artifacts → `references/as-operations.md`
- **Login / registration / token refresh** → the cws-core `/auth/*` endpoints are currently not exposed via CLI; token management is handled automatically inside `src/lib/token.js`

**Prerequisites**:

- Any command carrying `orgId` must be preceded by `core.me` or `core.org_switch` to confirm scope
- `core.invitation_create` requires calling `core.role_list` first to obtain the `role_id`
- `core.invitation_accept` requires the `token` from the invitation link; you cannot fabricate it yourself
- For the full parameter dependency tree, see [`SKILL.md` Efficiency Shortcuts > Parameter Resolution](../SKILL.md)

---

> Layer 3 operations reference. This document stays in 1:1 correspondence with the `src/cli/core.js` dispatch table.
> The authoritative paths are the cws-core OpenAPI spec: `https://zylos01.jinglever.com/cws-core/openapi.json`

CLI location: `src/cli/core.js`
Invocation: `node src/cli/core.js <command> '<json>'`

Status: ✅ cws-core is fully implemented (all 18 commands run end-to-end).

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | cws-core BFF base address |
| `COCO_AUTH_TOKEN` | (empty) | Bearer token |
| `COCO_API_PREFIX` | `/api/v1` | Path prefix |

## Command List

### Identity

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `core.me` | Overview of the current user / agent's identity + member + org + role | `{}` | `GET /api/v1/me` |
| ✅ | `core.self_rename` | Change your own display_name (cws-core identity + local `self.name` sync across each org) | `{name}` | `PATCH /api/v1/me` |

The return fields include `member_id` / `org_id` / `role`; all subsequent commands depend on these IDs.

`core.self_rename` notes:
- Uses the self-service endpoint `PATCH /api/v1/me` (changes the identity-level display_name, effective across all orgs that identity has joined). **Do not** use the admin-only `PATCH /api/v1/members/{id}` — an ordinary agent is `org-member`, and calling that will 403.
- On success, write the new name back to the local config `self.name` of every enabled org, keeping the runtime consistent with cws-core.
- The output contains only the new name + the org slugs it synced to; it does not print any token / api_key.
- Example: `node src/cli/core.js core.self_rename '{"name":"New Name"}'`

### Members

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `core.member_list` | List all members of the current org (filterable by kind / status / name) | `{kind?, status?, search?, page?, pageSize?, orderBy?}` | `GET /api/v1/members` |
| ✅ | `core.member_get` | Get details of a single member (including online_status / role, etc.) | `{memberId}` | `GET /api/v1/members/{id}` |
| ✅ | `core.project_members` | List the members of a project (to find candidates before dispatching a task) | `{projectId}` | `GET /api/v1/projects/{id}/members` |
| ✅ | `core.agent_profiles` | Aggregated agent capability profiles (to pick candidate agents before dispatch), including online_status and optional skills/tags | `{projectId?, memberIds?, include?, capabilities?}` | `GET /api/v1/agent-profiles` |

- `kind` values: `human` / `agent` / `all` (legacy alias `type`)
- `search` fuzzy-matches name / email (legacy alias `q`)
- Pagination parameters follow cws-core's `PageParams`: `page` + `page_size` (the CLI also accepts `pageSize` or legacy `limit`)

`core.agent_profiles` notes (the capability profile the Lead uses when orchestrating agent selection):

- **scope is required**: at least one of `projectId` and/or `memberIds` (a single string or an array; the query repeats `member_id`) must be given; if neither is given, the server returns 400. Open-ended "search the whole org by capability" is not here — that is the job of a future search layer.
- `projectId` is resolved by the server calling cws-work into that project's members, then filtered by agent (visibility is authorized by cws-work).
- `capabilities:true` (or `include:["capabilities"]`) → loads **skills** (objective skills self-reported by the agent) + **tags** (subjective capability labels manually annotated by owner/admin, `{tag, kind: curated|freeform, note?}`); without it, only the lightweight view is returned (member_id / display_name / status / online_status).
- Returns unpaginated (scope is naturally bounded). Return fields: each profile contains `member_id` / `display_name` / `kind` (always agent) / `status` / `online_status`; with `capabilities` it additionally contains `skills[]` / `tags[]`.
- **How to use**: the Lead should not exact-match by skill/tag name (agents name things inconsistently, and the server does not do hard filtering either); fetch the profiles with `capabilities`, and let the LLM read skills/tags/note to do semantic matching, then combine with `online_status` to choose candidates. The final assignment still requires confirmation from the initiator (see SKILL.md).
- Example: `node src/cli/core.js core.agent_profiles '{"projectId":"<project-uuid>","capabilities":true}'`

### Projects

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `core.project_list` | List the current org's project directory (paginated) | `{status?, page?, pageSize?, orderBy?}` | `GET /api/v1/projects` |

Write operations for projects such as CRUD / archive / members go through `tm.js` (same resource, workflow perspective).

### Organizations

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `core.org_list` | List all orgs I have joined | `{orderBy?}` | `GET /api/v1/organizations` |
| ✅ | `core.org_get` | Get details of a single org | `{orgId}` | `GET /api/v1/organizations/{id}` |
| ✅ | `core.org_create` | Create a new org; the caller automatically becomes owner; the response includes an access_token scoped to the new org | `{name, slug, displayName}` | `POST /api/v1/organizations` |
| ✅ | `core.org_switch` | Switch to a specified org; the returned new access_token is scoped to the target org's member_id | `{orgId}` | `POST /api/v1/organizations/{id}/switch` — body requires `{}` (empty object), schema closed |

### Roles

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `core.role_list` | List available roles (used to obtain role_id before sending an invitation) | `{scope?}` | `GET /api/v1/roles` |

`scope` values: `org` / `project` / omitted (all).

### Invitations

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `core.invitation_create` | Send an invitation; `displayName` = the invitee's member display name in this org (**required**, stored as members.display_name on accept); org_id is derived by the server from the JWT | `{roleId, displayName, email?, message?}` | `POST /api/v1/invitations` — body contains `display_name` (required, 1–200 characters, 400 if left empty) |
| ✅ | `core.invitation_list` | List this org's invitations (filterable by status pending/accepted/revoked/expired) | `{status?, page?, pageSize?, orderBy?}` | `GET /api/v1/invitations` |
| ✅ | `core.invitation_accept` | Accept an invitation to join a new org; the response includes an access_token scoped to the new org | `{invitationId, token}` | `POST /api/v1/invitations/{id}/accept` — body only has `token`; the display name comes from the `display_name` set when the invitation was created, **accept no longer passes display_name** (passing it will be rejected by the schema) |
| ✅ | `core.invitation_revoke` | Revoke a pending invitation | `{invitationId}` | `DELETE /api/v1/invitations/{id}` |

### Platform Agents (lifecycle of bot members)

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `core.platform_agent_create` | Register an agent member (bot) in the current org, returns member_id | `{displayName, description?, metadata?}` | `POST /api/v1/platform-agents` |
| ✅ | `core.platform_agent_delete` | Deregister an agent member (same as DELETE /members, marked departed) | `{memberId}` | `DELETE /api/v1/platform-agents/{member_id}` |
| ✅ | `core.agent_domain` | Resolve the public base URL of **this agent itself** (used to assemble callback addresses for webhook channels such as WhatsApp Business / LINE / Teams). Two levels: first query the bound domain from cws-core; **only when core returns 404 (no domain bound)** fall back to the environment variable `AGENT_PUBLIC_BASE_URL`. Any other error, or a malformed 200 (missing identity_id / full_domain), always errors out (stderr, exit 1) and does not silently fall back | `{}` | `GET /api/v1/platform-agents/{identity_id}/domain` |

A platform agent = an org-scoped bot member row; like a human member it occupies a `member_id`, and can be dispatched via `task.create` / added to conversations / write to KB.

### Onboarding (Lead agent guides a new organization; for the behavioral side see SKILL.md "Onboarding Lead")

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `core.onboarding_session` | The org's onboarding lifecycle record; `core_issue_id`=the core conversation Issue, `project_id`=the onboarding project; 404=never started | `{}` | `GET /api/v1/onboarding/session` |
| ✅ | `core.onboarding_event` | Funnel event reporting; only callable by the lead agent of an in-progress session; duplicate reports are absorbed by the server's unique index (idempotent 200, `recorded=false`) | `{eventType, occurredAt?, meta?}` | `POST /api/v1/onboarding/events` |

`eventType` only permits `d1_activation` (used at the core Issue ice-breaking stage when the user has replied ≥1 round) / `d3_im_connected` (third-party IM binding succeeded); `d7_first_delivery` is set automatically by the server when the core Issue is accepted, and self-reporting it will be rejected with 422. The startup self-report (`online-report`) is sent automatically by comm-bridge on startup and does not need to be called manually.

## Typical Flow: Lead Decides and Dispatches

```bash
# 1. Who am I
node src/cli/core.js core.me '{}'

# 2. List projects, confirm the target project
node src/cli/core.js core.project_list '{"pageSize":50}'

# 3. Look at this project's members (including agents and humans)
node src/cli/core.js core.project_members '{"projectId":"<project-uuid>"}'

# 4. Pull candidate agents' capability profiles (self-reported skills + manually annotated tags + online_status) as the basis for recommending to the initiator
node src/cli/core.js core.agent_profiles '{"projectId":"<project-uuid>","capabilities":true}'

# 5. Dispatch (switch to tm.js; the final assignment still requires confirmation from the initiator)
node src/cli/tm.js task.create '{"projectId":"<p>","issueId":"<i>","title":"...","assigneeId":"<m>"}'
```

## Typical Flow: Pull a Colleague into the org

```bash
# 1. Query roles, obtain the target role's role_id
node src/cli/core.js core.role_list '{"scope":"org"}'

# 2. Send an invitation (the recipient receives an invitation link); displayName = the invitee's member name in this org, required
node src/cli/core.js core.invitation_create '{
  "email":"newbie@example.com",
  "displayName":"New Member",
  "roleId":"<role-uuid>",
  "message":"Welcome to the team"
}'

# 3. Look at this org's pending invitations
node src/cli/core.js core.invitation_list '{"status":"pending"}'

# 4. Changed your mind
node src/cli/core.js core.invitation_revoke '{"invitationId":"<inv-uuid>"}'
```

On the accepting side:

```bash
node src/cli/core.js core.invitation_accept '{
  "invitationId":"<inv-uuid>",
  "token":"<from-invitation-link>"
}'
# → the display name comes from the display_name set when the invitation was created; accept no longer passes display_name
# → the returned access_token is already scoped to the new org's member_id
```

## Typical Flow: org Switching

```bash
# 1. See which orgs I have joined
node src/cli/core.js core.org_list '{}'

# 2. Switch to the target org (returns a new access_token, scoped to the new member_id)
node src/cli/core.js core.org_switch '{"orgId":"<target-org-uuid>"}'
```

After switching, all subsequent CLI calls must use the returned new token; the old token is still scoped to the old org.

## Pagination Conventions

Most cws-core list endpoints use `PageParams` (`page` + `page_size` + `order_by`):

| Resource | Pagination method |
| --- | --- |
| `core.member_list` / `core.project_list` / `core.invitation_list` | `page` + `page_size` (camelCase input `page` / `pageSize`) |
| `core.org_list` / `core.role_list` | Not paginated (returns the full set) |
| Historical messages (`comm.get_messages`) | `after_seq` + `before_seq` + `limit` (conversation-stream-specific cursor) |

> Historical pitfall: the CLI previously sent `cursor` + `limit` for `member_list` / `project_list` / `invitation_list`; the server did not recognize them, silently ignored them, and always returned the first page's default of 20 items. After the fix, all three commands accept both `pageSize` (canonical) / `limit` (legacy alias).

## Relationship with SKILL.md

This document is the Layer 3 sub-skill of [`SKILL.md`](../SKILL.md), responsible only for the **command mechanics** of the Core CLI. The following behavioral content is **in SKILL.md** and is not repeated here:

| Want to see | Which section of SKILL.md |
|---|---|
| When to auto-anchor identity / when to ask a human | [Efficiency Shortcuts > Context Anchoring](../SKILL.md) |
| The position of `core.me` / `core.member_list` in the dependency tree | [Efficiency Shortcuts > Parameter Resolution](../SKILL.md) |
| When to persist `agentId` / `orgId` to memory | [Memory Triggers](../SKILL.md) |
| General error protection | [Behavioral Guardrails > Common Errors](../SKILL.md) |

## Core-Specific Notes

- `org_id` is never passed by the client in any command — the server derives it from the JWT. The CLI does not accept the `orgId` field (except for commands like `org_get` that explicitly query a different org). To change org scope, use `core.org_switch`.
- The same applies to `invitation_create`'s `org_id`; even though it is not written in the doc, do not try to stuff it into the body — doing so will be rejected by the schema.
- The responses of both `org_create` and `org_switch` include a new `access_token`; subsequent calls must use this new token, as the old token is still on the old scope.
- Deregistering an agent via `platform_agent_delete` has the same effect as `DELETE /members/{id}`, but platform_agent_delete includes extra cleanup targeting bot members (token revocation, etc.).
- `core.role_list` is now unpaginated; roles are usually 4-8 items, and exceeding 100 is extremely unlikely, so PageParams was not added to it in cws-core.
