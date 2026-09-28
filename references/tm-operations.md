# TM Operations Guide

**Purpose**: Manage the Task Management service workflow — `Project → Issue → Blueprint → Task → Attempt`. The Blueprint is the source of truth for the plan; simple tasks also use a one-step Blueprint, while complex tasks use a multi-step / dependency Blueprint. All commands go through the cws-core BFF down to cws-work.

**When to load this document**:

- When a human's new task has passed the `SKILL.md` new-Issue intake (creation is explicit and the Project is explicit or confirmed), load this reference to look up the `issue.create` parameters, create the Issue, then create a single-step or multi-step Blueprint and go through plan confirmation. If the human chose no Issue, do not call any command in the Issue creation flow
- When you need to dispatch a task to someone else or pick up work yourself, look up `task.create` / `task.claim` → `task.start` (picking up work is two steps: claim to assign, start to begin work)
- When you need to stop an issue early before it reaches a conclusion, look up `issue.terminate` (terminate + cleanup)
- When work is done and you are wrapping up, look up the order `attempt.transition` → `task.transition` → `issue.deliver` → `accept_delivered`; when the human does not accept, do not call reject first — clarify through conversation first, then `issue.resume`
- When a Lead orchestrates the steps of any issue, look up the full `blueprint.*`; even for simple tasks, first build a one-step Blueprint
- When a Worker needs to report a failure / blockage, look up the `failed` / `blocked` options of `attempt.transition`

**Out of scope for this document**:

- KnowledgeBase operations (KB page / folder / file) → `references/kb-operations.md`
- File / artifact upload → `references/as-operations.md`
- IM messages / conversation management → `references/comm-operations.md`
- Member / role / org directory queries → `references/core-operations.md`

**Prerequisites**:

- Before calling, first run `core.me` to confirm the current `member_id` matches the identity in your intent
- Before creating an issue, usually first run `project.list` to get the target projectId
- When you need to reference KB, first use `kb.search` to find the page, then write the link / summary into the Issue/Task description or comment
- After a Worker receives an assignment, start work with the two steps `task.claim` → `task.start`; currently work is not picked up through a task pool

> The complete parameter dependency tree (`core.me → project.list → issue.create → blueprint.create → issue.submit_plan → task.create → ...`) is in [`SKILL.md` Efficiency Shortcuts > Parameter Resolution](../SKILL.md). This document does not repeat it and only fills in TM command-level details.

> Layer 3 operations reference. This document maintains a 1:1 correspondence with the `src/cli/tm.js` dispatch table.
> The authoritative real path is the cws-core OpenAPI: `https://zylos01.jinglever.com/cws-core/openapi.json`

CLI location: `src/cli/tm.js`
Invocation: `node src/cli/tm.js <command> '<json>'`
Help: `node src/cli/tm.js help`

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | cws-core BFF base address |
| `COCO_AUTH_TOKEN` | (empty) | Bearer token, required for authenticated endpoints |
| `COCO_API_PREFIX` | `/api/v1` | Path prefix; only needs to be overridden in non-default scenarios |

## Current Coverage at a Glance

All 45 commands are aligned with the cws-core BFF and can be called directly.

| Domain | Command Count | Status |
| --- | --- | --- |
| Project | 8 | ✅ All available |
| Issue | 14 | ✅ All available |
| Task | 8 | ✅ All available |
| Comment | 3 | ✅ All available |
| Blueprint | 4 | ✅ All available |
| Attempt | 4 | ✅ All available |
| Event Binding | 4 | ✅ All available |

## Error Handling

When the CLI fails, it outputs `{"error":"...","status":<httpStatus>}` to stderr with exit code 1. Common errors:

| HTTP | Meaning | Agent Response |
| --- | --- | --- |
| 400 | Invalid parameters | Check parameters and retry |
| 404 | Resource does not exist or no read permission | Switch to search / ask the Lead |
| 409 | State conflict / already exists | Re-read the latest state before deciding |
| 504 | Backend timeout | Back off and retry |

## Command Listing

### Project (8 commands)

| Status | Command | Description | Parameters | Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `project.list` | List the project directory (paginated, supports name/description search) | `{status?, query?, page?, pageSize?, orderBy?}` | `GET /projects` |
| ✅ | `project.create` | Create a new project; members are explicitly supplied through memberIds | `{name, leadMemberId, description?, slug?, isDefault?, knowledgeBaseId?, memberIds?}` | `POST /projects` |
| ✅ | `project.get` | Get details of a single project | `{id}` | `GET /projects/{id}` |
| ✅ | `project.update` | Change project name / description / lead | `{id, name?, description?, leadMemberId?}` | `PATCH /projects/{id}` |
| ✅ | `project.archive` | Archive a project (the frontend "delete" maps to this, no hard delete) | `{id}` | `POST /projects/{id}/archive` |
| ✅ | `project.members` | List project members (pulled from cws-work) | `{id, page?, pageSize?, orderBy?}` | `GET /projects/{id}/members` |
| ✅ | `project.member_add` | Explicitly add a project member | `{id, memberId, role?}` | `POST /projects/{id}/members` |
| ✅ | `project.member_remove` | Remove a project member | `{id, memberId}` | `DELETE /projects/{id}/members/{memberId}` |

### Issue (14 commands)

The write path uses the flat path `/issues/{id}`, not `/projects/{pid}/issues/{id}`. Each state change is a semantic action with invariant validation and side effects; the generic `POST /issues/{id}/transition` and the old acceptance-rejection interface have been removed.

| Status | Command | Description | Parameters | Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `issue.list` | List visible issues in the organization | `{status?, statuses?, priority?, includeArchived?, query?, page?, pageSize?, orderBy?}` | `GET /issues` |
| ✅ | `issue.list_in_project` | List issues within a project (supports filters and search) | `{projectId, status?, statuses?, priority?, includeArchived?, query?, page?, pageSize?, orderBy?}` | `GET /projects/{pid}/issues` |
| ✅ | `issue.get` | Get details of a single issue | `{id}` | `GET /issues/{id}` |
| ✅ | `issue.create` | Register an issue; defaults to `backlog`, set `backlog=false` only when it should enter `in_progress` immediately; Owner and Lead are required | `{projectId, title, leadAgentId, ownerMemberId, priority?, description?, originConversationId?, originMessageId?, backlog?}` | `POST /projects/{pid}/issues` |
| ✅ | `issue.update` | Change issue metadata (does not touch state) | `{id, title?, description?, priority?}` | `PATCH /issues/{id}` |
| ✅ | `issue.activate` | backlog → in_progress; decides whether to wake the Lead based on source | `{id, source?}` | `POST /issues/{id}/activate` |
| ✅ | `issue.submit_plan` | Lead submits the execution plan to the human for confirmation, writes an Issue comment, state → pending_plan; the new flow must include `blueprintId` | `{id, planText, blueprintId, source?, cardMessageId?}` | `POST /issues/{id}/submit-plan` |
| ✅ | `issue.accept_plan` | Human accepts the execution plan; during the text-card simulation period the Lead clicks on their behalf, defaulting to `source=text_card_proxy`; state → in_progress | `{id, source?}` | `POST /issues/{id}/accept-plan` — `source` accepts `im` / `explicit` / `text_card_proxy`; default `text_card_proxy` |
| ✅ | `issue.deliver` | in_progress → delivered | `{id}` | `POST /issues/{id}/deliver` |
| ✅ | `issue.resume` | After human feedback, continue the conversation, re-plan, or rework; pending_plan/delivered → in_progress | `{id, reason?, source?}` | `POST /issues/{id}/resume` |
| ✅ | `issue.accept_delivered` | Owner accepts the delivery; during the text-card simulation period the Lead clicks on their behalf, defaulting to `source=text_card_proxy`; delivered → accepted | `{id, source?}` | `POST /issues/{id}/accept-delivered` — `source` accepts `im` / `explicit` / `text_card_proxy`; default `text_card_proxy` |
| ✅ | `issue.reassign_owner` | Change the issue owner (ownerMemberId); archived objects cannot be changed | `{id, newOwnerMemberId (or 'ownerMemberId')}` | `POST /issues/{id}/reassign-owner` |
| ✅ | `issue.move_project` | Move the entire issue to another project | `{id, newProjectId (or 'targetProjectId')}` | `POST /issues/{id}/move` |
| ✅ | `issue.terminate` | Terminate an inconclusive issue early → terminated; the server cascades to cancel non-terminal Tasks + sends an `issue.terminated` event to the Lead for cleanup (does not roll back side effects that have already occurred) | `{id, reason?, source?}` | `POST /issues/{id}/terminate` — `source` defaults to `lead_chat` |

`ownerMemberId` is the acceptance / governance owner of the Issue and is always required. An Agent creating on behalf of a human must pass **the member id of that human in the conversation**, while `leadAgentId` must be the creating Agent. During the text-card simulation period, the Lead is allowed to use `source=text_card_proxy` to click `accept_plan` / `accept_delivered` only after the Owner explicitly accepts in the conversation. When the human does not accept the plan or delivery, do not call the reject interface; the Lead first continues the conversation to understand the feedback, then `issue.resume` back to `in_progress`, changes the Blueprint / Task, and re-runs `issue.submit_plan`.

### Task (8 commands)

`task.create` uses the doubly-nested path `/projects/{pid}/issues/{iid}/tasks`; the rest use the flat path `/tasks/{id}`.

| Status | Command | Description | Parameters | Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `task.list` | List tasks (can filter by project / issue / backend status / archived dimension) | `{projectId?, issueId?, status?, includeArchived?, page?, pageSize?, orderBy?}` | `GET /tasks` |
| ✅ | `task.get` | Get details of a single task | `{id}` | `GET /tasks/{id}` |
| ✅ | `task.create` | Dispatch a task; with `assigneeId` it goes directly to assigned (assigned, awaiting start), without it, pending awaiting someone to claim | `{projectId, issueId, title, description?, assigneeId?, blueprintStepId?, dependsOn?}` | `POST /projects/{pid}/issues/{iid}/tasks` |
| ✅ | `task.claim` | Claim a task for yourself, **assign only** (pending → assigned); no longer auto-creates an attempt, run `task.start` after claiming | `{id}` | `POST /tasks/{id}/claim` |
| ✅ | `task.start` | Begin work (assigned → running) and open an attempt; the dependency gate (all dependsOn done) is validated here | `{id}` | `POST /tasks/{id}/start` |
| ✅ | `task.transition` | Push the task to a terminal state (done / failed / cancelled); all attempts must reach a terminal state first | `{id, targetStatus (or 'status')}` | `POST /tasks/{id}/transition` |
| ✅ | `task.status` | Alias for `task.transition` | `{id, targetStatus (or 'status')}` | `POST /tasks/{id}/transition` |
| ✅ | `task.reassign` | Reassign an already-claimed task to another member (Lead-only) | `{id, newAssigneeId (or 'assigneeId')}` | `POST /tasks/{id}/reassign` |

`task.claim` / `task.start` both have no body; the principal is inferred from the auth header. Starting from v0.7, claim and start are separated: **claim only assigns the task to yourself (assigned), start actually begins work and creates the Attempt**. The standard two steps for a Worker to pick up work are `task.claim` → `task.start`.

### Comment (3 commands)

Conversations on an Issue / Task, plan explanations, state-change explanations, and agent handoff context are all written as comments. The state change itself is done by the semantic interfaces; comments are used to trace back "why it changed this way".

| Status | Command | Description | Parameters | Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `comment.create` | Write a Markdown comment on an Issue or Task | `{workType, workId, bodyMarkdown}` | `POST /comments` |
| ✅ | `comment.get` | Get a single comment | `{id}` | `GET /comments/{id}` |
| ✅ | `comment.list` | List the comments of an Issue / Task | `{workType, workId, cursor?, limit?, orderBy?}` | `GET /comments` |

### Blueprint (4 commands)

`blueprint.create` and `blueprint.list` use the issue-nested path; `blueprint.set_steps` has full-replacement semantics (PUT), not append.

| Status | Command | Description | Parameters | Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `blueprint.create` | Start a blueprint draft, provide all steps at once (can later be changed with set_steps) | `{issueId, steps[], estimatedBudget?, notes?}` | `POST /issues/{iid}/blueprints` — the server derives the author from the auth principal |
| ✅ | `blueprint.get` | Get a blueprint (with/without steps) | `{id, includeSteps?}` | `GET /blueprints/{id}` |
| ✅ | `blueprint.list` | List the blueprint versions under an issue (view revision history) | `{issueId, page?, pageSize?, orderBy?}` | `GET /issues/{iid}/blueprints` |
| ✅ | `blueprint.set_steps` | Replace steps in a single batch (full replacement, not append) | `{blueprintId (or 'id'), steps[]}` | `PUT /blueprints/{id}/steps` |

### Attempt (4 commands)

| Status | Command | Description | Parameters | Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `attempt.create` | Manually open a new round (the standard start flow creates the attempt through `task.start`) | `{taskId}` | `POST /tasks/{taskId}/attempts` |
| ✅ | `attempt.get` | Get attempt details (view status / startedAt / failureReason) | `{id}` | `GET /attempts/{id}` |
| ✅ | `attempt.list` | List all attempts of a task (view each retry / failure reason) | `{taskId, page?, pageSize?, orderBy?}` | `GET /tasks/{taskId}/attempts` |
| ✅ | `attempt.transition` | Push the attempt state (done / failed / blocked / cancelled); a Worker uses this to mark their own execution result | `{id, targetStatus (or 'status'), failureReason?, blockedOnApprovalRequestIds?}` | `POST /attempts/{id}/transition` |

`attempt.create` usually does not need to be called directly — `task.start` automatically creates the Attempt. Use it only when you need to manually start a new round of attempts.

### Automation creation

For explicit `automation-create-request` form handoffs, follow
[Automation Creation](automation-creation.md) before generic Issue intake.
`event-binding.create` and `webhook.create` accept `{org, source_kind, configuration}`.
`source_kind` must match the command (`timer` / `webhook`). The configuration
accepts only the listed create REST fields; unknown fields are rejected.
Timers preserve `schedule_kind`, `timezone`, `cron_expr`,
`run_at`, `interval_seconds`, `anchor_at`, `lead_member_id`, `owner_member_id`
and `spec`. Webhooks preserve `lead_member_id`, `owner_member_id`, `spec` and
`event_filter`. Use `webhook.get {org,id}` to read a webhook configuration.
The webhook creation result contains a secret `webhook_url`; never put it in
public output or persistent memory. The CLI sends no create idempotency key.
`event-binding.list` includes both source kinds; fetch webhook filters with
`webhook.get` using candidate IDs from that list. `event-binding.delete` also
soft-deletes webhook bindings, but requires explicit human cleanup authorization.

### Event Binding (4 commands)

Scheduled task = `EventBinding(sourceKind=timer)`: when the time comes the platform creates an Issue and dispatches it to the lead (you), and you simply "receive a new Issue" without being aware that you were woken by cron.

| Status | Command | Description | Parameters | Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `event-binding.create` | Create a scheduled task (create-by-agent main path) | `{cronExpr, leadMemberId, ownerMemberId, projectId, title, description?}` | `POST /event-bindings` |
| ✅ | `event-binding.list` | List the scheduled tasks of this org | `{}` | `GET /event-bindings` |
| ✅ | `event-binding.get` | Get scheduled task details (view nextTriggerAt) | `{id}` | `GET /event-bindings/{id}` |
| ✅ | `event-binding.delete` | Delete a scheduled task (stops future triggers, does not affect already-generated Issues) | `{id}` | `DELETE /event-bindings/{id}` |

create-by-agent guardrails (enforced by cws-work, violations error out directly):

- `leadMemberId` must = **your own member id** (an agent can only set itself as lead)
- `ownerMemberId` must = **the member id of that human in the conversation**, and cannot be yourself (owner is the governance responsible party = human)
- `cronExpr` has 5 fields (minute hour day month weekday)

## Typical Usage Scenarios

### 1. Lead takes a simple Issue and does it themselves

```bash
# 0) Context assembly: search KB for reference material, collect page IDs
node src/cli/kb.js kb.search '{"query":"competitive pricing","folderId":"tn-projects-growth"}'
# -> hits pg-pricing-ref-001, pg-market-overview-002

# 1) Create an Issue for immediate planning/execution
node src/cli/tm.js issue.create '{
  "projectId":"proj-1",
  "title":"Notion competitive pricing analysis","description":"Compare the pricing tiers of 5 direct competitors",
  "priority":"medium","leadAgentId":"agent-self",
  "ownerMemberId":"human-requester-1","backlog":false,
  "originConversationId":"conv-1","originMessageId":"msg-42"
}'

# 1.5) Create a single-step Blueprint as the source of truth for the plan
node src/cli/tm.js blueprint.create '{
  "issueId":"iss-1",
  "steps":[
    {"temp_id":"s1","description":"Complete the competitive pricing analysis and output the conclusion to KB"}
  ],
  "notes":"Single-Agent simple task, one step is enough"
}'

# 1.6) Lead sends the plan text card to the human for confirmation; after the human replies "accept the plan", the Lead clicks on their behalf
node src/cli/tm.js issue.submit_plan '{"id":"iss-1","blueprintId":"bp-1","planText":"1. Complete the competitive pricing analysis\\n2. Output the conclusion to KB","source":"lead_chat"}'
node src/cli/tm.js issue.accept_plan '{"id":"iss-1","source":"text_card_proxy"}'

# 2) Create a Task per the single-step Blueprint and claim it
node src/cli/tm.js task.create '{
  "projectId":"proj-1","issueId":"iss-1","blueprintStepId":"step-1",
  "title":"Competitive pricing analysis","assigneeId":"agent-self"
}'
node src/cli/tm.js task.claim '{"id":"task-1"}'

# 3) Work done, flow Attempt → Task → Issue → deliver
node src/cli/tm.js attempt.transition '{"id":"att-1","targetStatus":"done"}'
node src/cli/tm.js task.transition    '{"id":"task-1","targetStatus":"done"}'
node src/cli/tm.js issue.deliver      '{"id":"iss-1"}'

# 4) The owner human accepts. During the text-card simulation period: after the human replies "accept the delivery", the Lead clicks on their behalf
node src/cli/tm.js issue.accept_delivered '{"id":"iss-1","source":"text_card_proxy"}'
```

### 2. Lead orchestrates a complex Blueprint

```bash
# 1) Create Issue
node src/cli/tm.js issue.create '{
  "projectId":"proj-1","priority":"high",
  "title":"Quarterly product planning","leadAgentId":"agent-self",
  "ownerMemberId":"human-requester-1","backlog":false
}'

# 2) Start a Blueprint draft (with Steps, submitted at once)
node src/cli/tm.js blueprint.create '{
  "issueId":"iss-2",
  "steps":[
    {"temp_id":"s1","description":"Step 1: Research user pain points"},
    {"temp_id":"s2","description":"Step 2: Write the requirements document","depends_on_temp_ids":["s1"]}
  ]
}'

# 3) When you need to modify Steps, replace them wholesale
node src/cli/tm.js blueprint.set_steps '{
  "blueprintId":"bp-1",
  "steps":[
    {"temp_id":"s1","description":"Step 1: Research user pain points (including a survey)"},
    {"temp_id":"s2","description":"Step 2: Write the requirements document","depends_on_temp_ids":["s1"]},
    {"temp_id":"s3","description":"Step 3: Technical feasibility assessment","depends_on_temp_ids":["s2"]}
  ]
}'

# 4) Lead renders the plan text and submits it to the human for confirmation; the Blueprint ID is bound as the machine-executable skeleton
node src/cli/tm.js issue.submit_plan '{"id":"iss-2","blueprintId":"bp-1","planText":"1. Research user pain points\\n2. Write the requirements document\\n3. Technical feasibility assessment","source":"lead_chat"}'
node src/cli/tm.js issue.accept_plan '{"id":"iss-2","source":"text_card_proxy"}'

# 5) After the plan is accepted, dispatch Workers per Step
node src/cli/tm.js task.create '{
  "projectId":"proj-1","issueId":"iss-2",
  "blueprintStepId":"step-1","title":"User interviews","assigneeId":"worker-1"
}'
```

### 3. Worker executes an already-assigned task

```bash
# 1) After receiving a notification from the scheduling center or the Lead, read the task
node src/cli/tm.js task.get '{"id":"task-7"}'

# 2) When unassigned, claim it first; if it is already ASSIGNED to you, you can skip
node src/cli/tm.js task.claim '{"id":"task-7"}'

# 3) After dependencies are satisfied, begin work, enter RUNNING and create the Attempt
node src/cli/tm.js task.start '{"id":"task-7"}'
node src/cli/tm.js comment.list '{"workType":"task","workId":"upstream-task-1"}'

# 4) View the current Attempt info
node src/cli/tm.js attempt.list '{"taskId":"task-7"}'

# 5) Complete
node src/cli/tm.js attempt.transition '{"id":"att-3","targetStatus":"done"}'
node src/cli/tm.js task.transition '{"id":"task-7","targetStatus":"done"}'
```

### 4. Worker reports a blockage / failure

```bash
# Mark the Attempt as failed (with reason)
node src/cli/tm.js attempt.transition '{
  "id":"att-3","targetStatus":"failed","failureReason":"missing_credentials"
}'

# When approval is needed, mark it blocked
node src/cli/tm.js attempt.transition '{
  "id":"att-3","targetStatus":"blocked",
  "blockedOnApprovalRequestIds":["apr-1"]
}'
```

### 5. create-by-agent: create a scheduled task for a human

When a human says in a DM "help me set up a scheduled task", you (the selected lead agent) are responsible for asking it out clearly before creating it — you know best what context is needed to run this task when the time comes.

```bash
# 0) Interactively ask it out clearly (don't guess out of thin air; missing context is the biggest pitfall of scheduled tasks):
#    - how often to run → convert to a 5-field cron (state the timezone assumption clearly)
#    - which project it belongs to
#    - what to do when the time comes → title / description, ask for as much context as possible
# 1) Restate and confirm, then create: leadMemberId=yourself, ownerMemberId=the human in the conversation
node src/cli/tm.js event-binding.create '{
  "cronExpr":"0 9 * * 1",
  "leadMemberId":"<your own member id>",
  "ownerMemberId":"<the conversation human's member id>",
  "projectId":"prj-1",
  "title":"Weekly cleanup of expired artifacts",
  "description":"Clean up temporary artifacts older than 7 days and output a cleanup report"
}'
# 2) Report the result (binding id + nextTriggerAt)
```

Key points:

- **owner=human, lead=yourself** is a hard constraint; filling it in wrong is rejected directly (see the guardrails above)
- For explicit form handoffs, required missing information must be resolved and the latest plan confirmed in the human's DM before creation; follow the Automation Creation workflow above.

## Relationship with SKILL.md

This document is a Layer 3 sub-skill of [`SKILL.md`](../SKILL.md), responsible only for the **command mechanics** of the TM CLI (parameters / endpoints / ordering / typical flows). The following behavioral content is **in SKILL.md** and is not repeated here:

| Want to see | Which section of SKILL.md |
|---|---|
| The capability-boundary comparison table for Lead and Worker | [Role Model](../SKILL.md) |
| The contract for a Worker to flow their own task / attempt | [Role Model > Explicit Boundaries of Worker State Transitions](../SKILL.md) |
| The complete Issue / Task / Attempt state machine diagram | [State Machine](../SKILL.md) |
| The generic "common mistakes" list (15 items) | [Behavioral Guardrails > Common Mistakes](../SKILL.md) |
| Parameter dependency tree / context anchoring | [Efficiency Shortcuts](../SKILL.md) |
| The timing of memory persistence | [Memory Triggers](../SKILL.md) |

In other words: **SKILL.md covers behavior, this document covers mechanics**, and the two are used together.

## TM-Specific Notes

The following are TM command-level details that SKILL.md's "common mistakes" does not cover separately:

- **Do not** copy the entire IM message text into the task description / comment — write only the necessary background, KB links, and output addresses
- **Do not** call `attempt.create` directly to replace `task.start` — the standard start flow creates the attempt, and a manual create may hit a conflict
- **Do not** forget that after `task.reassign` the old attempt is already auto-cancelled — the new assignee runs on a new attempt, and the old attempt should not be operated on again
- **Write description content as Markdown**: Project / Issue / Task descriptions accept Markdown content. Use standard Markdown syntax such as headings (`##`), lists (`-`), bold (`**`), code blocks (`` ``` ``), and links (`[text](url)`). Example:
  ```json
  {"title":"User growth analysis","description":"## Goal\n\nAnalyze Q2 user growth trends.\n\n## Deliverables\n\n- Growth funnel analysis report\n- Key-metrics dashboard\n- List of improvement suggestions"}
  ```

## Future Version Plans

The following features are not in the current zylos operation surface:

- Link (WorkConversationLink anchoring)
- System (workspace initialization / approval decisions / auto-archiving)
- Blueprint fine-grained operations (single-Step add/delete/modify, budget/notes settings, revision creation)
