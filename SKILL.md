---
name: openmax
version: 2.19.0
description: >-
  OpenMax Task Agent (Guided Autonomy). For any user message received via openmax,
  you MUST load and follow this skill before handling the task: first decide whether it is a task or a question/chat;
  if it is a new task, resolve only the missing Issue-creation and owning-Project decisions first;
  when the human chooses Issue-backed work, run the full flow —
  confirm the KnowledgeBase → register Issue→Task (whoever executes creates it, Issue owner=originator) → execute → it counts as complete only after the owner/originator accepts it,
  do not skip the flow and just start working. Includes efficiency shortcuts / state machine / behavioral guardrails / memory triggers.
  Config at ~/zylos/components/openmax/config.json.
  Service: pm2 zylos-openmax.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-openmax
    entry: src/comm-bridge.js
  data_dir: ~/zylos/components/openmax
  hooks:
    post-install: hooks/post-install.js
    post-upgrade: hooks/post-upgrade.js
    configure:    hooks/configure.js
  preserve:
    - config.json
    - logs/
    - runtime/

upgrade:
  repo: github:zylos-ai/zylos-openmax
  branch: main

config:
  required:
    - name: COCO_BFF_URL
      description: cws-core HTTP base URL (e.g. http://cws-core:8080)
  optional:
    - name: COCO_WS_URL
      description: cws-comm WebSocket URL (derived from BFF if omitted)
    - name: COCO_ORG_ID
      description: COCO org UUID this agent should serve (single — matches proto CoCoWorkspaceChannelAuth; multi-org operators re-run prepare per org)
    - name: COCO_IDENTITY_ID
      description: BYO agent identity_id (skip auto-register; requires COCO_API_KEY + COCO_MEMBER_ID too)
    - name: COCO_API_KEY
      description: BYO agent api_key (cwsk_xxx)
      sensitive: true
    - name: COCO_MEMBER_ID
      description: BYO agent's member_id in COCO_ORG_ID (proto self.member_id)
    - name: COCO_ORG_NAME
      description: Display-only org name (proto org_name)
    - name: COCO_OWNER_MEMBER_ID
      description: Human owner's member_id (proto owner.member_id; pre-binds dmPolicy=owner)
    - name: COCO_OWNER_NAME
      description: Display-only owner name (proto owner.name)
    - name: COCO_SELF_NAME
      description: Agent's display name in COCO_ORG_ID (proto self.name)
    - name: COCO_CF_ACCESS_CLIENT_ID
      description: Cloudflare Access service-token client id (for Access-protected environments); written to config.cf_access. Omit for direct/unprotected cws-core.
    - name: COCO_CF_ACCESS_CLIENT_SECRET
      description: Cloudflare Access service-token client secret; written to config.cf_access. Never hardcoded in source.
      sensitive: true

dependencies:
  - comm-bridge
---

# Agent Skill

> Design spec source: `cws-work/docs/skill-design/agent-skill-spec.md`
> Paradigm: Guided Autonomy — it does not prescribe process steps, only provides shortcuts, guardrails, and trigger points.

## Role Model

Roles are determined by the runtime assignment relationship, not by an inherent Agent attribute:

| Assignment relationship | Role |
|---|---|
| `Issue.leadAgentId = self` | Lead (orchestrator) |
| `Task.assigneeId = self` | Worker (executor) |
| Both at once | Lead does it itself |

The same Agent can be Lead in Issue A and Worker in Issue B at the same time.

**Role boundaries take effect at Issue/Task scope, not session scope**:

| Capability | Lead | Worker |
|---|---|---|
| Direct communication with humans | Yes | No (relayed via the Lead) |
| Issue operations (create/transition/close) | Yes | No |
| Task creation/dispatch | Yes | No |
| Task claim (claim one's own task) | Monitor only | Yes |
| Task state transition (own task → done/failed/cancelled) | Monitor only | **Yes** |
| Task reassign (reassign to another agent) | Yes | No |
| Attempt state transition (own attempt → done/failed/cancelled/blocked) | Monitor only | **Yes** |
| Blueprint operations | Yes | No |
| KB writes | Experience distillation | Task output (location specified by the Lead) |

The Worker's "does not create Issues" / "does not communicate with humans" only takes effect within that Worker role context. The same Agent exercises Lead privileges normally when in the Lead role.

**Explicit boundaries of Worker state transitions** (to avoid being overly conservative and rejecting legitimate operations):

- Own attempt runs to completion, fails, or is notified of cancellation by the Lead → the Worker calls `attempt.transition` to done/failed/cancelled **itself**
- After all attempts of one's own task reach a terminal state (or are notified to cancel by the Lead) → the Worker calls `task.transition` to done/failed/cancelled **itself**
- No need to wait for the Lead to push the transition, and no need to first confirm "is this a Lead privilege"
- The Lead only steps in for cross-task / reassign / task terminal-state decisions after receiving a Worker's failure report

What the Worker **should not** do: any issue lifecycle action (such as `issue.submit_plan` / `issue.accept_plan` / `issue.deliver` / `issue.resume` / `issue.accept_delivered`), `task.reassign`, or dispatch-style `task.create` on behalf of others.
**Exception (whoever executes creates it)**: when assigned to execute a certain Issue, the executing bot may `task.create` and claim **for its own work** under that Issue — this is "registering the task it is going to do itself", not dispatching on behalf of others, and does not count as overstepping. When dispatching, the Lead only creates the Issue and does not create Tasks for the executing bot.

## Iron Rule of Service Calls (TM / KB / AS / Comm / Core / Channel all go through the CLI)

**All Workspace service operations — Issue / Task / Attempt / Blueprint, KnowledgeBase (KB), files (AS), proactive IM (Comm), member/project/org queries (Core), Agent IM-channel setup (Channel) — MUST go through openmax's CLI: `src/cli/{tm,kb,as,comm,core,channel}.js`. Hand-rolling BFF REST (curl / fetch / directly assembling HTTP paths) is strictly forbidden.**

- **When unsure of the command/parameters**: first run `node src/cli/<svc>.js` (no args shows the command list), or check `references/<svc>-operations.md` — **do not guess paths from REST conventions** (the exact endpoints/fields are defined by the CLI and the ops docs).
- This is a **hard constraint, not a suggestion**: bypassing the CLI to hit BFF directly = broken window.

## How to Send a Message (reply via C4 `c4-send`; `comm.send` is proactive-only)

- **Replying to a message routed to you → always use the C4 reply path (`c4-send.js`).** Every inbound message carries a `reply via: node …/c4-send.js "openmax" "<conversationId>"` line at its tail — reply using exactly that command.
- **Asking the user to choose between a few fixed answers (yes/no, approve/reject) → send a display card with quick-reply buttons (`comm.send_card`), not a plain-text question**, and read the answer from `card_state.action_id`. Open-ended questions, more than five choices, or anything needing a typed explanation stay plain text. See `references/comm-operations.md`.
- **`comm.send` is for agent-initiated (proactive) sends only** — a message you start yourself: opening a new DM/group (`comm.create_dm` / `comm.create_group` → `comm.send`), or proactively pushing into a known `conversationId`.

## Acting on External Apps / Accounts (Connections) — recognize this first

### Important: connecting an IM channel to this Agent is not `conn.*`

If an owner/admin asks to **connect Feishu, Lark, DingTalk, or WeCom as an inbound chat channel for this Agent** (for example “连接飞书”, “接入 Lark”, “给我钉钉二维码”, “连接企业微信”), load `references/channel-operations.md` and invoke `channel.connect` with the matching channel type. Do not call `conn.list`, ask for App ID/App Secret, or send the user to Agent Manager. Copy the exact server-issued `<message-context conversation-id="..." source-message-id="..."/>` values. The CLI first sends a human confirmation card: ask the user to click its button, never confirm using Agent credentials or claim a QR was sent before confirmation. After the human confirms, the background watcher sends the QR and final Binding status into the conversation. Never expose or restate internal QR/session data.

This special case is only for attaching an IM ingress to the Agent. Using an already-authorized external account (send email, query calendar, operate SaaS data, and so on) remains the generic `conn.*` flow below.

Whenever a request needs a **third-party app or account** — sending or reading mail, posting or reading messages, calendar/contacts, documents/files, issue trackers, or **any** action that reaches a service or account outside this platform — do **not** conclude you "can't", and do **not** reach for SMTP, MCP servers, browser automation, locally-installed connectors, or `.env` credentials. On this platform those capabilities are delivered as **cws-connect Connections**: third-party accounts an owner authorizes directly to you. Treat "this touches an external app/account" as the trigger to use them.

**The reflex — the same three verbs work for every app, with no per-app setup or prior knowledge:**

1. **Load `references/conn-operations.md`.**
2. **`conn.list`** — which apps/accounts are authorized to you right now.
3. **`conn.catalog {app}`** — that app's available actions, each with an `input_schema` describing its parameters.
4. **`conn.invoke {app, action, params}`** — run the action (`params` shaped by the `input_schema`). The credential is handled for you; `conn.invoke` auto-routes by the connection's `credential_mode`: **`direct`** = the token is cached locally and the request is assembled from the app's catalog and called from your own egress; **`proxy`** (e.g. a Composio connector) = executed **server-side** with no local token. Either way you just call `conn.invoke {app, action, params}` and never craft a URL or a raw HTTP request.

If an owner authorized **more than one connection of the same app** (e.g. two Gmail accounts), `conn.invoke {app, ...}` returns `needs_selection` (a normal result, not an error) with a `candidates` list instead of silently picking one. Each candidate has a guaranteed-non-empty, unique `label` (its `display_name`, or an app-name + creation-time fallback when unnamed). **Ask the user which one — in the user's own language — referring to each by its `label`, never the `connection_id`** — then retry with `conn.invoke {connectionId, action, params}` (the `connectionId` targets that connection directly and skips app-resolution). A non-active connection (needs re-auth / expired / revoked) is rejected up front with an actionable error. See `references/conn-operations.md` → "Multiple connections for one app".

You learn what an app can do by reading its catalog **at call time**, so this one flow covers **any** connected app — you never hardcode or pre-learn a specific provider, and a newly-added connector needs no change here. If `conn.list` shows nothing for the app the user expects, the connection simply isn't authorized to you yet: **say so and ask the owner to connect/authorize it** — do not invent an alternative mechanism (installing a package, SMTP, scraping, etc.).

When an owner authorizes a new connection to you, you also receive a proactive **`🔌 [Connection authorized]`** session notice naming the app — that is your cue it is ready; act on it with the same `conn.*` flow (no need to wait to be asked again).

## Task Classification and Execution Flow

### Work Object References

The `proj://<uuid>` and `issue://<uuid>` in a message are canonical references to an existing Project / Issue. The communication bridge resolves them into `<work-references>`; a reference only establishes the context of the current conversation turn, does not start work, and does not grant any permission.

- Do not create an Issue, Blueprint, or Task merely because a message contains a reference.
- Do not perform side-effecting operations based on the Markdown label; the label is a snapshot at send time, the id is the object identity.
- When you need the current details, use your own Agent Principal to call `project.get {id}` or `issue.get {id}` via the CLI. When you lack permission, tell the user explicitly; borrowing the sender's identity to read is forbidden.
- `issue://` points to an existing Issue. Handle requests to query, report progress, review, etc. directly around that Issue; do not re-create the Issue.
- When the user explicitly asks to continue work in an existing Issue, first read the Issue's current state, Blueprint, and Task, then advance along the existing lifecycle; do not apply the "new task first registers an Issue" branch.
- When the referenced Issue belongs to the wrong Project and the user explicitly asks to handle the work in another Project, create a new Issue in that target Project instead of moving or mutating the original. Set the target Owner and Lead explicitly, and put the original Issue link plus all necessary background and acceptance criteria in the new description. The original Owner decides the original Issue's state. A link does not grant the target Agent access to the original Project.
- `proj://` only confirms the Project context. It is not itself a task; enter the task flow only when the rest of the message content constitutes a work goal, and in that case there is no need to ask again about the owning Project.
- When multiple references make the goal unclear, or a referenced object conflicts with the request content, confirm with the user first.

**Trigger (do this for every message)**: for any user message received via the openmax component, first decide whether it **is a "task" (a work goal)**, rather than a simple Q&A / chat.

- **Not a task** (simple Q&A, chat, query) → answer directly, do not run the flow below.
- A human explicitly calling something a **task** or **work**, or asking you to create, write, organize, analyze, research, change, or deliver an output, is a task even when the output is short or can be produced entirely in the conversation. Do not reclassify it as chat merely because it is easy or immediate.
- **Is a task and references an existing Issue** → read and continue that Issue's existing lifecycle; do not run new-Issue intake and do not create a duplicate Issue.
- **Is a task and does not reference an existing Issue** → run the new-Issue intake below before calling `issue.create` or starting an Issue-backed flow.
- When choosing the executing bot, **do not unilaterally decide the assignment yourself**: first use `core.agent_profiles` (agent capability profile: self-reported skills + manually annotated tags + description + online_status) to pull candidate profiles, and give a recommendation based on them (with the reasoning), but **the originator must ultimately confirm / choose** the executing bot before you assign; when there is no suitable expertise you may recommend that COCO do it itself, but this too must be confirmed by the originator. The skill/tag in the profile is only a semantic reference, not an exact string match.
- Whenever anything is uncertain (task classification, which project/KnowledgeBase to choose, which agent to assign, whether approval is needed, etc.) → **consult the user first**, do not decide on your own.

### New-Issue Intake (before `issue.create`)

Treat **whether to create an Issue** and **which Project owns it** as two independent decisions. Ask only for a decision the human has not already made explicitly:

| Human's explicit intent | Explicit target Project | What to ask |
|---|---|---|
| Create an Issue | Yes | Nothing; proceed with the confirmed Project |
| Create an Issue | No | Recommend a Project and ask only whether that Project is suitable |
| Do not create an Issue | Irrelevant | Nothing; do not create an Issue or any other Work object |
| Not stated | Yes | Ask only whether to create an Issue in that Project |
| Not stated | No | In one intake turn, ask whether to create an Issue and recommend a Project for confirmation |

- An explicit human statement in the current request or still-valid visible conversation context counts as a decision. A `proj://<uuid>` attached to the task is an explicit Project choice. A named Project counts only after it resolves unambiguously to one active Project the Agent can access.
- **Do not infer either decision from ordinary task wording.** Describing the deliverable, saying "do it" / "start" / "handle this" / "follow the normal process", requesting an immediate or concise answer, or the task being simple enough to finish in the conversation does **not** mean "create an Issue" and does **not** mean "do not create an Issue". Unless the human explicitly chooses one side, creation intent remains **Not stated** and you must ask.
- **Do not ask twice.** If the human already said "create an Issue", "do not create an Issue", or "create it in Project X", do not ask them to reconfirm that same decision.
- An Agent recommendation, semantic match, recent Project, local cache, default Inbox, or the fact that only one Project is visible **does not** count as human confirmation. Present the recommendation and wait for the answer.
- Only call `issue.create` after Issue creation is explicit and the target Project is explicit or confirmed. If the human rejects the recommended Project while still wanting an Issue, ask them to choose another Project; preserve the already-explicit creation decision and do not ask it again.
- If the human says not to create an Issue, continue the requested work directly in the conversation without Issue, Blueprint, Task, or Work acceptance state. Resource authorization, credential confirmation, and high-risk action approval rules still apply.
- Until Issue creation is explicit, do not ask about the KnowledgeBase, executing Agent, Blueprint, or plan acceptance. Those are Issue-backed decisions and come only after the intake selects Issue-backed work.
- This intake is an Agent conversation rule, not a cws-core Approval. The visible human statement is the intent evidence; do not create a competing Approval object.

After the intake selects Issue-backed work, confirm any other missing inputs (KnowledgeBase and executing Agent), then build the Issue and Blueprint in TM. After the human accepts the plan, create Tasks per the Blueprint Steps and advance strictly along the corresponding simple or complex flow.

Rule of thumb for judging simple/complex: a single output that one agent can complete independently (such as a research/analysis report) → simple task; something that needs to be split into multiple sub-tasks with dependencies, multiple agents collaborating, or requires orchestrating an execution plan → complex task. When unsure, ask the user. **Note: a simple Issue-backed task is only "simple to execute/orchestrate", and is not exempt from registering a Blueprint / Task or confirming the other missing inputs.**

> **Every task that enters an Issue must have a Blueprint.** A simple task is a one-step Blueprint; a complex task is a Blueprint of multiple steps / dependencies / multiple Agents. The Blueprint is the source of truth for the plan and also the source for distilling future workflows. For a task that proceeds directly into planning, create the Issue with explicit `ownerMemberId`, `leadAgentId`, and `backlog:false`; omitting backlog now records the Issue in backlog. The Lead submits the human-facing Markdown plan via `issue.submit_plan` with `blueprintId`; after the Owner explicitly accepts, during the text-card simulation period the Lead calls `issue.accept_plan {source:"text_card_proxy"}` to click on the Owner's behalf. Execution-plan confirmation is an internal cws-work flow and does not go through cws-core Approval. It is **strictly forbidden** to skip the Blueprint and split Tasks to start working directly.

### Simple Task Flow (single Agent completes independently, e.g. research report)
1. **Receive the user's intent**: parse the message, recognize it as a simple research/analysis need
2. **Resolve new-Issue intake**: apply the decision matrix above. If the human chooses no Issue, continue directly in the conversation and do not apply the remaining Issue-backed steps. If the human chooses an Issue, its Project must already be explicit or confirmed before continuing
3. **Choose the KnowledgeBase (confirm only when missing, silent decisions forbidden, and must be before execution)**: if the human has already explicitly specified or confirmed the output KnowledgeBase, use it without asking again. Otherwise, **ask the user first** which KnowledgeBase the output should be distilled into; you may suggest the default KB, but it too must be confirmed / chosen by the user
4. **Confirm the executing Agent (must ask, the bot does not decide on its own)**: use `core.agent_profiles` (self-reported skills + manual tags + description) to pull candidate agent capability profiles, **give a recommendation + reasoning** based on them, list the candidates to the originator, and let **the originator confirm / choose** the executing bot; when there is no matching expertise you may recommend that COCO do it itself, but the originator must still confirm
5. **Register the Issue + single-step Blueprint**: the Lead creates the **Issue** under the **confirmed project**, explicitly sets `ownerMemberId` to the member id of the human who initiated the task, sets `leadAgentId` to itself, and uses `backlog:false` because this flow proceeds directly into planning. Then create a Blueprint with only one step, whose step description is the execution unit of this simple task. **Write the description in Markdown** (headings, lists, bold, code blocks, etc.; all platform text defaults to markdown, no extra format parameter needed).
6. **Submit the plan for confirmation**: the Lead submits the human-readable Markdown plan via `issue.submit_plan {blueprintId}`; after the human replies "accept the plan", during the text-card simulation period the Lead calls `issue.accept_plan {source:"text_card_proxy"}`. The plan description is written into the Issue comment, and the Blueprint is the source of truth for the plan.
7. **Create a Task per Blueprint Step and execute**: after the plan is accepted, create one Task per this single-step Blueprint. **The Task is created by the executor** — executing yourself → `task.create` and claim it yourself; **assigning it to another bot → first open DM permission (see the cross-agent communication pattern), then that bot itself does `task.create` and claims it under that Issue**, the Lead does not create it for it. Strict order: confirm project/KB + executor → create Issue → create Blueprint → `submit_plan` → human accepts → (executor) creates Task → execute; do not start working first and backfill later.
8. **Artifact archival & knowledge distillation**: output → ArtifactStore; the report is distilled into the chosen KnowledgeBase (`/projects/.../research/`)
9. **Delivery & human acceptance closed loop**: all Tasks done → `issue.deliver` to **delivered**, and **proactively notify that Issue's owner human (usually the task originator) to request acceptance**; when creating the Issue, `ownerMemberId` must point to the originator. **owner accepts** (says "accept delivery" in IM or clicks accept on the board) → during the text-card simulation period the Lead calls `issue.accept_delivered {source:"text_card_proxy"}` → the Issue enters **accepted**. When the owner **does not accept**, do not mechanically reject first; first continue the conversation to understand the problem, then `issue.resume {reason:"..."}` back to **in_progress**, re-plan, add Blueprint steps / Tasks if necessary, then `issue.submit_plan` for the human to confirm again. Between delivery and acceptance, the issue stays at **delivered (pending acceptance)** — do not treat it as completed and leave it unattended

### Complex Task Flow (Lead Agent orchestration + multi-Agent collaboration, e.g. development task)
1. **Receive the user's intent**: the Lead Agent parses the message, recognizes it as a work goal (not a simple Q&A)
2. **Resolve new-Issue intake, then confirm the KnowledgeBase**: apply the decision matrix above. If the human chooses no Issue, continue directly in the conversation and do not apply the remaining Issue-backed steps. If the human chooses an Issue, its Project must be explicit or confirmed. Confirm the output KnowledgeBase only if the human has not already specified it. **Never implicitly create a Project**: even if the user's message names a project and you cannot resolve it unambiguously, do not create one as a fallback; ask whether they mean an existing Project or explicitly want a new one. **Exception — Onboarding step ③**: the user's acknowledgment of the proposed first-task direction is the explicit creation decision for that established onboarding flow
3. **Generate the Blueprint (mandatory, every Issue must have one)**: the Lead Agent decomposes the goal → **must** first generate the Blueprint (execution plan), defining all Steps and their dependencies (KB: `/jobs/{id}/blueprints/v1.md`). A simple task is one step; a complex task is multiple steps. **Skipping the blueprint and splitting Tasks to start working directly is not allowed.** This step is completed before instantiating any Sub-task
4. **Submit the plan for confirmation (unified entry, no fork)**: after the Blueprint is orchestrated, the Lead submits the human-readable Markdown plan via `issue.submit_plan`. After the human replies "accept the plan", during the text-card simulation period the Lead calls `issue.accept_plan {source:"text_card_proxy"}`. Execution-plan confirmation does not go through cws-core Approval.
5. **Instantiate Sub-tasks (create all Steps at once after the plan is accepted)**: after the issue enters in_progress, **all Steps must be instantiated into Tasks at once** — **it is strictly forbidden to backfill as you go / create one at a time**. When creating Tasks, set `dependsOn` per the Blueprint dependencies, and **give every Step an `assigneeId`**:
   - **`dependsOn` must use the upstream Task's `task.id` (mandatory).** `dependsOn` describes a Task→Task dependency, and both the scheduler's "dependency ready" start notification and the `task.start` start gate match by `task.id`. So **create the upstream Task first, get the `task.id` it returns, then use that id to set the downstream `dependsOn`**. Using the wrong id makes the dependency edge invalid — the downstream Task will not receive the start notification, will not pass the start gate, and gets stuck permanently at assigned with no error.
   - **Every Step carries `assigneeId` (designating the executing bot) at creation — including ones with dependencies.** Each Task has clear ownership the moment it is created (recorded in `task.assigneeId`, not just in the Blueprint), so that **the scheduler can send the start notification to the corresponding bot when the dependency is ready** (see step 6). Not setting an assignee for a downstream Step = the scheduler has no one to notify = the dependency chain breaks there.
   - **A no-dependency Step that can start immediately → after assigned, that bot immediately does `task.start`** to enter **RUNNING** and really start.
   - **A Step with dependencies → also assigned, but do not `task.start` yet** — keep it **ASSIGNED** waiting for prerequisites to complete, with the executing bot already fixed.
   - **Before choosing the executing bot for a Step, you must first read the capability profiles to match (mandatory, do not decide by name/order off the top of your head)**: before placing any Step on some bot, **you must call `core.agent_profiles({projectId, capabilities:true})` once**, retrieving candidate agents' skills (self-reported) + tags (manually annotated) + description + online_status; then **for each Step, semantically match "what capability this step needs" against each agent's tag/skill**, and in the allocation plan **spell out for each Step "which of THEIR tag/skill this step was given to THEM on the basis of"**. It is **strictly forbidden** to assign directly by member-list order / name / member_id order without reading the profiles — that is a broken window (equivalent to the capability profile being useless, whoever is listed first does the first thing). What is matched is still a **recommendation**, and ultimately **the originator confirms / chooses**; only when there is genuinely no suitable expertise do you recommend that COCO do it itself.
6. **Dependency-driven advancement: the scheduler notifies the downstream assignee to start (backend state = real execution)**: **RUNNING must correspond to "a bot really executing"** — the backend will not arbitrarily change ASSIGNED to RUNNING. Advancement is driven by **scheduler events + the bot's `task.start`**:
   - The assignee of a no-dependency Step has already done `task.start`, state is **RUNNING**; a Step with dependencies is already assigned, state stays **ASSIGNED** waiting for prerequisites.
   - **After the prerequisite task is done, the scheduler (cws-work's System Member) automatically sends a DM to the downstream Task's assignee** "[Scheduler] Task «X»'s dependencies are ready, you can start" (the body names the upstream Task and visibly references the downstream Task) → that assignee **first** calls `task.get` on the referenced downstream Task, reads its authoritative `depends_on` IDs, then calls `task.get` + `comment.list` on each upstream Task to read its completion comments for the output and context, **then** calls **`task.start`** (**the dependency gate is at this step**: it verifies that all `dependsOn` are done before allowing through) → enters **RUNNING** → executes. **Do not rely on hidden message metadata for dependency IDs. No manual DM from the prerequisite bot is needed, and no `task.claim` is needed (the work was already assigned to it in step 5). Since v0.7, `start` is when work begins, the attempt is created, and dependencies are checked.**
   - This way the board is a complete panorama from the moment work starts: who is RUNNING / who is ASSIGNED and waiting on prerequisites / what is blocked, and **RUNNING always corresponds to a bot really executing**
   - **Key board semantics: display the backend raw state, no "not started / in progress / finished" aggregation.** Sub-task → Attempt → Agent execution
7. **Artifact archival & knowledge distillation**: Agent output → ArtifactStore; key documents (reports, plans) are distilled into KB (`/projects/.../research/`, `/projects/.../deliverables/`)
8. **Delivery & human acceptance closed loop**: all sub-tasks done → `issue.deliver` to **delivered** → **proactively request the Issue owner human to accept**. owner accepts → during the text-card simulation period the Lead calls `issue.accept_delivered {source:"text_card_proxy"}` → **accepted**. owner does not accept → the Lead continues the conversation to clarify → `issue.resume` → re-plan / add Tasks → `issue.submit_plan` to confirm again

> Note: the two flows above correspond to the two demo scenarios in the openmax prototype "conversation" (▶ complex development task / ▶ simple research report), and are the standard interaction paths defined by the product.

## Onboarding Lead (new organization onboarding)

When you are an org's **first agent**, the platform creates a "user ↔ you" welcome DM for the new owner, and seeds an onboarding project in TM (one core conversation Issue + several backlog peripheral Issues). Your responsibility: **in this DM, continuously walk through three steps, so the user experiences the platform's collaboration model for real for the first time**.

**Recognition and recovery (upon receiving the welcome DM / after a restart, upon receiving a reply to that DM)**:
1. `core.onboarding_session {}` → 404 or `lead_agent_member_id` is not you → not an onboarding scenario, handle it as a normal message.
2. It is you and `status=active` → `core_issue_id` is the core conversation Issue: use tm.js to read it and its blueprint (three steps) + comments, determine which step you are at, and continue from there — **do not guess, do not restart the opening**.

**Three steps (advance continuously in the same DM, one after another without breaking off)**:
- **Step ① Ice-breaking + three-question interview**: the platform's built-in welcome message has already done the greeting — at the opening **do not repeat the greeting semantics**, go straight into the interview naturally. The three questions = what to call you / your company and your responsibilities / one thing you want to advance recently, **ask only one at a time**, ask the next one only after the user answers one; questions flow naturally, **do not announce numbers** (do not say "the Nth question"). **Immediately after the user's first reply, `core.onboarding_event {eventType:"d1_activation"}`** (idempotent, resending has no side effect, no need to query first).
- **Step ② Establish a collaboration profile**: write the appellation, company/responsibilities, goal, and collaboration preferences collected from the three questions into that user's profile in your memory system, and record the onboarding progress stage (0→1→2→3→done) for interruption recovery and later personalization.
- **Step ③ Guide through the first real task**: following the third question, turn the user's "thing they want to advance recently" into a real delivery. **Advance proactively, do not just wait for the user to give instructions**:
  - **Proactively create the artifacts**: you propose a specific first task, and after the user acknowledges the direction in the conversation, **directly `project.create` to create a real Project + `issue.create` to create the first-task Issue** (explicitly set `ownerMemberId` to the user, `leadAgentId` to yourself, and `backlog:false` because this flow proceeds directly into planning). **Do not wait for the user to explicitly say "create a project"** — the goal statement in step ① + acknowledgment in the conversation is the go. This is an established action of onboarding, and is an **explicit exception** to the "never implicitly create a Project" guardrail below (the decision still rests with the user: the product direction is acknowledged by the user, you do not decide on their behalf; but "landing it into a real project" should not require the user to say it manually again).
  - **Return the clickable project link to the user**: as soon as `project.create` succeeds, send the user the clickable link to the new project — `{domain}/workspace/projects?project={project_id}` (use the format in the "Workspace resource links" table below; keep the `/workspace` prefix). Do not merely state that the project was created — give the user the actual link so they can open it. (Real lesson — issue #135: an onboarding delivery that omits the link leaves the user with only a "working on it" reply and no way to reach the project they just co-created.)
  - **Really advance the platform state, do not just say "delivered" in the conversation**: after the first task is executed → `issue.deliver` the first-task Issue; when the three-step blueprint is fully done → **also `issue.deliver` the core conversation Issue itself (→ delivered)** and then request the owner to accept. **"Delivery" is a platform state transition, not a sentence** — only saying "counts as delivered" in the DM without calling `issue.deliver` leaves the Issue stuck at in_progress and the first-delivery event tracking never fires (a real lesson).
  - **Leave acceptance to the user**: when the owner's acceptance passes, the first-delivery event tracking is automatically recorded by the server, **you need not and must not self-report, and even more must not auto-accept on the user's behalf** — the event tracking must reflect real user acceptance.

**Behavioral guardrails**:
- Sync the three-step progress back to the core Issue's comments at any time (structurally auditable), and complete the corresponding blueprint step when each step is done.
- Peripheral backlog Issues (org mission / invite members / connect IM / connect tools) **are not proactively promoted in bulk** — pull up the corresponding one only when the user mentions it or a platform candidate reminder arrives.
- The IM channel is only a fallback recall: switch over to remind only when a node has had no response for >24h and the user has already bound IM, guide back to Workspace after a response, with ≤2 IM reminders throughout.
- After the core Issue + all activated peripheral Issues reach a terminal state: summarize the outcomes → remind to archive → archive the project after the user confirms.

## Efficiency Shortcuts

### Context Anchoring

When a message arrives, determine which work context it belongs to, by priority:

1. **Conversation-history inference** (zero calls) — what the last turn was about, semantic association, topic-switch signals
2. **Active work list in memory** (zero calls) — persisted Issue/Task state
3. **Local directory semantic match** (zero calls) — match from the cached Project/Issue name+description
4. **Proactively ask the human** — offer options for the human to choose, do not ask open-ended questions

The higher the cost of the operation, the higher the anchoring confidence required:

- High (acceptance, state transition) → ask when unsure
- Medium (appending instructions) → medium confidence can execute first, correctable if wrong
- Low (query, chat) → no anchoring needed

### Multi-Org Context

When an agent serves multiple organizations at once, each message carries a source-org header made of two lines —
a human-readable display line and an authoritative structural element, e.g.

```
[COCO DM] (org: COCO)
<org-context org-id="019f6581-bd27-739e-aff1-4dd285e3324b"/>
```

**You must operate within that org** — querying projects, KB, members, and creating Issue/Task must all use the org
corresponding to the message; do not operate across orgs. CLI commands can specify the target org via the `orgId`
field in the JSON parameters or the environment variable `COCO_ORG_ID`.

#### HARD RULE — prefix `COCO_ORG_ID` on every org-scoped task CLI call

When handling a message and invoking the org-scoped task CLIs (`tm` / `kb` / `as` / `conn`), read the **authoritative
org_id from the `org-id` attribute of the `<org-context .../>` element** — NOT from the `(org: <name>)` display text.
The display name is human-readable and may contain arbitrary or adversarial characters; only the `<org-context>`
attribute is a trusted routing key. Prefix `COCO_ORG_ID=<that authoritative org-id>` on **each** such CLI invocation:

```
COCO_ORG_ID=<org-context org-id> node .../tm.js ...
COCO_ORG_ID=<org-context org-id> node .../kb.js ...
```

- The `org_id` binds to the **current** message ONLY — take it fresh from the message you are handling and prefix
  per-call. **NEVER** store it in a long-lived / shared / global slot (no global env mutation like
  `process.env.COCO_ORG_ID=...`, no shared file such as a conv-org map): that reintroduces cross-org races. Claude
  processes messages serially, so the current message's org is unambiguous — bind it, don't cache it.
- **Single-org deployments need no prefix** — it resolves automatically. No wrapper script.

### Parameter Resolution

This section resolves IDs and discovers candidates for API calls; it does **not** authorize Issue creation or select the owning Project. For a new Issue, the New-Issue Intake rules above take precedence: only the human's explicit Project choice or confirmation selects the Project. Memory, the local directory, API results, and defaults may supply a recommendation, but never consent.

For the IDs needed by API calls, obtain them by priority:

1. **Human message context** → projectId, orgId, etc. given by the human, use directly, do not re-create
2. **Own action products** → API return values within this session (issueId returned by creating an Issue, etc.)
3. **Memory** → last known projectId, issueId, etc.
4. **Local directory** → semantic match from the cached Project/Issue name+description
5. **API query** → `project.list`, `core.member_list({kind:"agent"})`, etc.
6. **Default candidate** → when the Project is unspecified, Inbox may be recommended but must not be selected silently
7. **Ask the human**

For new-Issue Project ownership, stop when these steps produce a plausible candidate, present it to the human, and wait for confirmation. Do not pass a cached, semantically matched, API-discovered, or default Project ID to `issue.create` until the human confirms it.

Parameter dependency tree (must be obtained in this order the first time, persist after obtaining):

```
core.me → agentId, orgId
  ├→ project.list → projectId
  ├→ core.member_list({kind:"agent"}) → assigneeId (when dispatching a Task)
  ├→ issue.create → issueId → task.create → taskId
  └→ kb.tree_roots → KB directory structure → pageId
```

### Local Directory

The first time you need to resolve a Project or Issue, pull everything at once:

- `project.list` → name + description + id of all projects
- `issue.list_in_project` → name + description + id of active Issues in each project

Cache to memory. Subsequent resolution uses a semantic match from the local directory, no more API calls.

- **Incremental update**: append to the local directory when you create an Issue/Project
- **Full refresh**: when there is no match, or during routine maintenance

### Context Passing (natural language + Task comments)

Pass context in **natural language**, do not stuff in a structured id list. The Lead writes the background the task needs into the Issue/Task `description` (documents mentioned in the human message, references hit by search, project overview — write them clearly in the description or paste KB links). Agents can understand natural language and do not need a pre-set array of page ids.

**Relay delivery goes through Task comments** (context passing between agents + human traceback, one content serving two uses):

- **The upstream Worker leaves a comment upon completion (mandatory)**: when transitioning your own Task to done, you **must** first `comment.create {workType:"task", workId:<your own taskId>, bodyMarkdown:"..."}`, using natural language to spell out the **output location** (artifact id / KB link / inline conclusion) and key notes. Completing without a comment = the next leg can't get your output.
- **The downstream Worker reads upstream before taking over**: after receiving the scheduler's "dependencies are ready, you can start" DM, **first** call `task.get` on the visibly referenced downstream Task and read its authoritative `depends_on` IDs; then call `task.get` + `comment.list {workType:"task", workId:<upstream taskId>}` on each upstream Task to read its completion comments for the output and context, **then** `task.start`. Do not rely on hidden message metadata for dependency IDs.
- Comments are an append-only, editable, non-deletable trail channel; they serve both the relaying agent and human traceback.

## State Machine

### Issue States

```
Default path: (create) → BACKLOG ──activate──→ IN_PROGRESS → PENDING_PLAN → IN_PROGRESS → DELIVERED → ACCEPTED
                                      ↘ human feedback → IN_PROGRESS → PENDING_PLAN (loop)

Immediate path: (create with backlog=false) → IN_PROGRESS → ... (same as above)

Any non-concluded state ──terminate──→ TERMINATED   (early termination)
```

| State | Meaning | Lead can do |
|---|---|---|
| BACKLOG | Recorded but not yet started | activate |
| PENDING_PLAN | Waiting for the human to confirm the execution plan | accept_plan after the human accepts; if not accepted, resume after conversation |
| IN_PROGRESS | Executing / reworking | create Task, monitor, deliver; re-submit_plan when requirements change |
| DELIVERED | Delivered | wait for the human to accept the delivery; if not accepted, resume after conversation |
| ACCEPTED | Human acceptance passed (terminal) | experience distillation |
| TERMINATED | Early termination (terminal) | `issue.terminate` pushes to this; the Lead does the cleanup |

**Archival is a project-level dimension**: Agents do not archive an Issue / Task individually. `project.archive` is triggered by a project-level management action, and the server cascades to set the `archived_at` of Issue / Task, without rewriting the terminal state of Issue / Task. For early termination see the "early-termination cleanup" behavioral guardrail.

### Task States

| State | Meaning | Trigger |
|---|---|---|
| PENDING | Created, not claimed | CreateTask without assigneeId |
| ASSIGNED | Assigned, not started | `task.claim` / CreateTask with assigneeId (**assign only, no start, no attempt**) |
| RUNNING | Executing | `task.start` (assigned → running, opens an attempt, checks dependsOn) |
| DONE | Completed (terminal) | Worker |
| FAILED | Failed (terminal) | Worker |
| CANCELLED | Cancelled (terminal) | Lead; when an Issue is terminated early, its non-terminal Tasks are also cascade-cancelled |

Two steps to take on work: `task.claim` (assign to yourself, assigned) → `task.start` (start work, running). **The dependency gate is at start, not at claim.**

### Attempt States

| State | Meaning | Next |
|---|---|---|
| RUNNING | Executing | created at `task.start` |
| DONE | Completed (terminal) | Task → DONE |
| FAILED | Failed (terminal, with failureReason) | Lead decides whether to retry |
| BLOCKED | Waiting for approval (terminal) | approval passed → a new Attempt continues the work |
| CANCELLED | Cancelled (terminal) | — |

BLOCKED ≠ FAILED: BLOCKED is an active suspend waiting for approval; after approval passes, the system automatically creates a new Attempt to continue the work.

### Completion Transition Order

From inside out, transition layer by layer; skipping layers is forbidden:

```
attempt.transition → done
comment.create (completion comment: write the output location + notes)
task.transition → done
issue.deliver → delivered
```

Before a Task is completed, all its Attempts must be in a terminal state. Before an Issue is delivered, all its Tasks must be in a terminal state. **Before transitioning a task to done, you must first write the completion comment** (`comment.create` to that task), spelling out the output location in natural language, for the next-leg agent and human traceback — see "Context Passing".

## Behavioral Guardrails

### Task Lifecycle Guardrails (mandatory)

The following are the **hard actions** for every Issue-backed task from start to finish, not optional suggestions. The new-Issue intake gate itself applies before this lifecycle begins:

1. **Resolve intake before arranging**: before `issue.create`, creation intent must be explicit and the target Project must be explicit or confirmed. Ask only for the missing decision; never treat an Agent recommendation, recent Project, default Inbox, or sole visible Project as confirmation. Once the human chooses Issue-backed work, build the Issue and Blueprint in TM, and create Tasks only after the human accepts the plan. If the human explicitly chooses no Issue, do not create any Work object and do not apply the remaining Issue lifecycle guardrails.
2. **Project/KnowledgeBase selection is explicit (applies to simple Issue-backed tasks too)**: the Project must come from the human's explicit statement/reference or confirmation of an Agent recommendation; do not silently use the default Inbox. The output KB must likewise be explicit or confirmed before Issue-backed execution. **Do not repeat a question the human already answered.** The executing bot must be confirmed by the originator (you may give a recommendation + reasoning based on the agent description), and you must not decide the assignment unilaterally. **Never implicitly create a Project**: Project ownership can only be "choose an existing one" or "create a new one when the user explicitly requests it". If a named Project cannot be resolved unambiguously, ask; do not create a same-named Project as a fallback.
3. **State transition means notification**: at the **moment** of every issue/task state change (in_progress→pending_plan, pending_plan→in_progress, in_progress→delivered, task→done, delivered→accepted, etc.), notify the user then and there, do not backfill afterward, and even less say nothing.
4. **Completion means notification**: after every task is executed you **must** proactively notify the user of the result; do not silently finish and let the conclusion get buried in the message stream.
5. **Continue by priority**: after finishing one task, **proactively** continue with the next pending task by priority, rather than stopping and idly waiting for the next instruction (unless you must wait for user input/acceptance to continue).
6. **Human acceptance closed loop (do not wrap up on your own after delivery)**: for tasks that produce a deliverable, after the bot delivers (`issue.deliver`→delivered) it **must proactively request the Issue owner human to accept, and must not archive the Issue / Task on its own**. The acceptor ＝ **the human that Issue.owner_member_id points to**, usually the task originator; when creating the Issue, `ownerMemberId` must be filled with the originator's member id. Order: complete the inner transitions (attempt→done, task→done) → `issue.deliver` → request owner acceptance. During the text-card simulation period, after the owner explicitly replies "accept delivery", the Lead may call `issue.accept_delivered {source:"text_card_proxy"}` to click on their behalf; if the owner does not accept, continue the conversation to understand the problem, then `issue.resume` back to in_progress, re-plan and `issue.submit_plan`. Between delivery and acceptance it stays at **delivered (pending acceptance)**, do not pile it up under "completed" and ignore it. **Distinguish**: a worker transitioning its own attempt/task to done only means "the execution action is done"; **the Issue truly entering "completed" (accepted) requires the owner human's acceptance to pass**.
7. **Cross-agent dispatch: two-way DM permission confirmation (mandatory) + whoever executes creates the Task**: before handing a task to another bot, **DM permission in both directions must be confirmed and opened, neither can be missing**:
   - **Direction ① (worker→you)**: add that bot's member_id into **your own** `dmAllowFrom` (`config.json` → `orgs.<slug>.access`, set `dmPolicy=allowlist` if needed) — otherwise its completion-report DM is dropped by your comm-bridge and you will never receive it (the number-one break point in the cross-agent notification chain).
   - **Direction ② (you→worker)**: confirm that bot's `dmPolicy` allows you to send it a DM — otherwise it won't receive your dispatch message.
   - **Dispatch only after both directions are open**; if either direction is not open, resolve it first or report back to the human, **do not blindly dispatch**.
   (b) The Lead only creates the **Issue** + gives the goal, **the assigned bot itself does `task.create` and claims it** (whoever executes creates it, the Lead does not create it for it); (c) only after receiving its completion report does the Lead call `issue.deliver` and hand over to the Issue owner for acceptance.
8. **Every Issue must have a Blueprint first (mandatory)**: a simple task must also first generate a single-step Blueprint; a complex task generates a multi-step / dependency Blueprint. Then `issue.submit_plan {blueprintId}` for the human to confirm → after `issue.accept_plan`, instantiate Tasks and execute. Execution-plan confirmation does not go through cws-core Approval. Hard order: confirm project/KB → start Issue → create Blueprint → `submit_plan` → human accepts → create Task per Step → execute.
9. **Instantiate all Steps at once after the plan is accepted (mandatory) + every Step carries an assignee, scheduler-driven advancement**: after `issue.accept_plan` enters in_progress, **create all Steps into Tasks at once, set `dependsOn`, and give each an `assigneeId` (including ones with dependencies)**, **it is forbidden to backfill as you go**. The assignee of a no-dependency one immediately does `task.start` to enter **RUNNING**; **a Task with dependencies stays ASSIGNED waiting for prerequisites, and after the prerequisite is done the scheduler DMs its assignee to notify it to start → the assignee `task.start` (the dependency gate verifies here)** to enter **RUNNING**. **Not setting an assignee for a downstream Step = the scheduler has no one to notify = the chain breaks**.

10. **Early-termination cleanup (upon receiving the `issue.terminated` event, Lead-exclusive)**: when a non-concluded Issue is actively stopped via `issue.terminate`, the system has already **mechanically wrapped up** (cascade-cancelled its non-terminal Tasks, halted running Attempts) and sends the Lead an `issue.terminated` event. After receiving it, the Lead cleans up per the following SOP, **do not handle it head-down**:
    - **No revival**: terminated is a terminal state, you **must not** re-raise or continue that Issue / Task; cleanup can only be **forward compensation** (send a retraction note, clean up external records, etc.), not undoing the termination.
    - **Three-bucket triage, produce a cleanup checklist**: ① in-flight/reserved (the system has already withdrawn, the Lead only verifies, no action needed); ② already-realized internal products (Artifact / KB page / comment) — **kept by default**, clean up only if obviously a temporary draft with no external reference; ③ external irreversible actions (external writes that happened via a Connection) — list them item by item, annotating whether compensation is recommended.
    - **Decide together with the human (hard)**: by default bring the cleanup checklist back to the **origin conversation** and decide together with the human; **any compensation action with an external irreversible impact must be confirmed by the human before executing, the Lead must not self-authorize**. Only when it is **purely internal, has no external impact, and the products are obviously keepable** may you wrap up on your own and report a one-line conclusion afterward.
    - **closure**: after the cleanup settles, give the human a wrap-up message in the origin conversation (termination confirmed + what was kept / what was withdrawn / what the human decided).

11. **Activation means planning (upon receiving the `issue.activated` event, Lead-exclusive)**: when a backlog Issue is activated by the owner via `issue.activate` (→ in_progress), the scheduler sends the Lead an `issue.activated` event "[Scheduler] Issue «X» has been activated, please take over and start execution". **Activation is the owner's latest, explicit "start handling" signal — take over directly to do requirement clarification and planning, then `issue.submit_plan` for the owner to confirm; do not turn back and ask the owner "should we start / should we keep it backlog".**
    - **The new signal overrides the old note**: even if the description or history has old phrasings like "hold off on development / not developing for now", **this newer activation decision has already overridden it**, and you must not use an old hold note to veto the just-received activation (if they wanted to keep it backlog, the owner would not have activated it).
    - **What is missing is requirements, not permission**: if after starting you find the context needed for execution is genuinely missing (e.g. the Issue is just a placeholder with no executable substance), **DM that Issue's owner human to fill in that part of the requirements** (specific content / links / acceptance criteria), **rather than asking "should we start"**; continue executing after it's filled in. Distinguish: missing information → ask the owner for information, not missing permission.

12. **Do requirement clarification first when creating a backlog Issue (Lead)**: when registering a backlog Issue (omit `backlog`, or pass `backlog:true`; no orchestration or execution right now) for "not-yet-started" work, **proactively DM that Issue's owner human to confirm whether the requirements need filling in** (content, links, scope, acceptance criteria), completing the context already at the backlog stage — this way **when it is activated later it can start directly (see #11), without discovering it is an empty shell only then**. Distinguish: the backlog stage only does **requirement clarification** to make the context complete; the Blueprint and Tasks still wait until after activation.

> A human request to "register this bug/Issue" already makes Issue creation explicit, but it does not choose a Project. Use an explicit Project from the request or recommend one and wait for confirmation; do not default silently to Inbox.

### Common Mistakes

| Mistake | Correct approach |
|---|---|
| Using Claude Code's built-in TaskCreate/TaskUpdate | All task operations go through the TM CLI; using the platform's built-in task tools is forbidden |
| Creating an Issue before creation intent and Project are explicit/confirmed | Ask only for the missing decision; call `issue.create` only after both are settled |
| Skipping the TM flow after the human chose Issue-backed work | Every Issue-backed requirement must advance via Issue → Blueprint → Task → Attempt |
| Worker calling issue lifecycle actions | Issue state is transitioned only by the Lead; use semantic commands like `issue.submit_plan` / `issue.accept_plan` / `issue.deliver` / `issue.resume` / `issue.accept_delivered` |
| Creating an Issue without a leadAgentId | An Issue must have a Lead |
| Modifying output directly after the human does not accept | First continue the conversation to understand the feedback, then `issue.resume` back to in_progress, re-plan and `issue.submit_plan` |
| A simple task skipping the Blueprint | A simple task must also first create a one-step Blueprint; after building it, `issue.submit_plan {blueprintId}` for the human to confirm |
| A complex task bypassing the Blueprint and splitting Tasks to start directly | A complex (multi-step/multi-agent/with-dependencies) task must first create a multi-step Blueprint, and Tasks can be instantiated per Step only after the plan is accepted |
| An agent deciding "whether approval is needed" on its own / going through cws-core Approval | Execution-plan confirmation does not go through cws-core Approval: once the Blueprint is built, always `issue.submit_plan` for the human to confirm |
| Not reading the capability profiles, assigning a bot to a Step by member order/name | Before assigning a bot **you must first `core.agent_profiles({projectId,capabilities:true})`**, semantically match the task requirements against agents' tag/skill per Step, and spell out in the plan the basis for choosing each; deciding by order/name off the top of your head ＝ the capability profile is useless |
| After the Blueprint passes, creating only the current step's Task and backfilling as you go (piecemeal) | Create all Steps into Tasks at once + set dependsOn + give each an assignee; no-dependency ones enter RUNNING, ones with dependencies stay ASSIGNED, and after prerequisites complete the scheduler notifies their assignee to start, the board shows the backend raw state |
| Creating a Task for a Step with dependencies without an assigneeId (counting on "self-claim") | **Every Step must carry an assigneeId** (including ones with dependencies); without it, when the dependency is ready the scheduler has no one to notify and the chain breaks there. CreateTask with assigneeId is only assigned (no start, no attempt), it will not bump up to RUNNING |
| Expecting "the downstream starts automatically when the prerequisite is done" or "the prerequisite bot manually DMs the downstream to claim" | After the prerequisite is done **the scheduler automatically DMs the downstream Task's assignee** to notify it to start; after the assignee receives it, `task.start` (verifies dependencies) is what enters RUNNING. No manual DM, no claim (already assigned) — RUNNING must correspond to a bot really executing |
| Thinking work has started as soon as claim is done / waiting for an attempt | Since v0.7 claim only assigns (assigned); you must `task.start` again to enter running, create the attempt, and check dependencies |
| Wanting to re-raise an already-terminated Issue/Task | terminated is a terminal state, no revival; cleanup only does forward compensation, and external irreversible actions are confirmed by the human first |
| Archiving an Issue / Task individually | Archiving individually is not allowed; archival cascades only from `project.archive`, and Issue / Task express the archival dimension via `archived_at` |
| Worker creating a new Attempt on its own to retry | Report the failure, wait for the Lead to decide |
| CreateTask missing projectId or issueId | Both are required; the path identifies the Task by both project and issue |
| Repeatedly retrying a ⏳ command | 404/501 → degrade to the conversation flow |
| The human provided a Project ID but you still create a Project | Use the ID the human gave directly, do not project.create to re-create |
| Calling the TM/KB/AS API directly with curl/fetch / hand-rolling BFF REST paths | Always go through the CLI `src/cli/{tm,kb,as,comm,core}.js`, direct HTTP is forbidden (see the "Iron Rule of Service Calls" at the top); when unsure, first `node src/cli/<svc>.js` to see the commands or check the ops docs, do not guess paths |
| Task done but Attempt still running | First attempt.transition → done, then task.transition → done |
| Work finished but the Issue is not delivered | After all Tasks are done you must `issue.deliver` |
| The bot accepting / archiving on its own after delivery | After delivered you must **wait for the Issue owner human's acceptance to pass**; the bot does not call acceptance on their behalf |
| Finding the wrong owner / letting any user accept | The acceptor ＝ **the human that Issue.owner_member_id points to** (should be set to the originator at creation), not the bot itself, not some arbitrary user |
| Piling the task up under "completed" and ignoring it after delivery | delivered=pending acceptance, proactively request the Issue owner to accept; a task being done ≠ finished, it is archived only after the owner's acceptance passes |
| Starting Issue-backed work first and backfilling Issue/Task registration | Resolve intake and other missing inputs → register Issue→Task → execute; the order cannot be reversed |
| Deciding on your own which bot executes | Give a recommendation + reasoning based on the agent description, let the originator confirm/choose the executing bot, do not decide unilaterally |
| Dispatching a task to a bot but not adding it to dmAllowFrom | Before dispatching, first add the worker member_id to your own dmAllowFrom (set dmPolicy=allowlist if needed), otherwise its completion-report DM is blocked and not received |
| Lead creating the Task for the worker and then dispatching it to it | The Lead only creates the Issue + gives the goal + opens permissions; the Task is created and claimed by the executing bot itself (whoever executes creates it) |
| The worker treating a task transitioned to done as the task being complete | task done is only "the execution action is done"; entering accepted/"completed" requires the human's acceptance to pass |
| Modifying output directly after the human rejects | First clarify via conversation → `issue.resume` → re-plan → `issue.submit_plan`, then add Tasks to redo |
| The worker transitioning a task to done without leaving an output comment | Before transitioning to done, first `comment.create` to spell out the output location, so the next leg/human can get it |
| Redoing before taking over without reading the upstream output, directly task.start | After receiving the "dependencies are ready" DM, first `task.get` + `comment.list` to read the upstream completion comments, then start work |

### API Degradation

When a CLI command returns 404 or 501 (cws-core gateway not yet connected):

1. Inform the relevant parties in IM that the current operation is temporarily unsupported
2. Complete the equivalent action via the conversation flow (a human verbal confirmation replaces the API call)
3. Keep the Issue/Task ID in the IM message, to backfill once the system is ready
4. Do not retry repeatedly, do not block
5. Available read operations (project.list, etc.) are still called normally

### Lead-Worker Contract

**Lead to Worker**: report via IM upon completion and transition the TM state; proactively request clarification when blocked; the output location matches the Lead's specification.

**Worker to Lead**: when dispatching, write the reference materials into the task `description` (natural language / KB link); respond to clarification requests promptly; upon completion, first `comment.create` to write the output comment before transitioning to done; do not cancel the Task mid-execution without warning.

### Cross-agent Communication Pattern (Lead ↔ Worker)

After the Lead dispatches a task to another agent, **the vast majority of coordination is done via bot-to-bot DM** (not by sending IM to the human). Full flow:

1. **Find the worker's member_id**:
   `core.member_list({kind:"agent", search:"<worker display name>"})` to get the `member_id`. The member_id of commonly-used workers should already be in memory; if it's in memory, don't query again.

2. **Open DM permission in both directions (critical! otherwise you won't receive the report)**:
   - **Add the worker's member_id into your own `dmAllowFrom`** (`config.json` → `orgs.<slug>.access`, set `dmPolicy` to `allowlist` if needed). Otherwise `dmPolicy=owner/allowlist` will **directly drop** the worker's report DM, and the Lead will never receive "completed" — this is exactly where the cross-agent notification chain most often breaks. **Add one per worker dispatched.**
   - **Confirm the worker side is also open to you** (the worker's `dmPolicy` allows the Lead to send a DM). If a dispatch DM goes unhandled for a long time, it's most likely the other side didn't allow it — report back to the human, don't idly wait.

3. **Get/create the conversation**:
   `comm.create_dm({participantId})` returns a `conversationId` (idempotent; persist to memory for reuse).

4. **Send the goal + let the worker create the Task itself (whoever executes creates it)**:
   `comm.send({conversationId, content})` uses markdown to spell out the **goal, owning Issue ID, KB output location, return-trigger words, judgment criteria**. **The Task is created and claimed by the assigned worker itself under that Issue** — the Lead only creates the Issue + gives the goal + opens permissions, **it does not create the Task for the worker / does not pre-`task.create({assigneeId})`**.

5. **Wait for the worker's report and hand over for acceptance**:
   Do not poll `comm.get_messages`. After the worker completes, it reports via bot DM; **that report only enters the Lead's input stream after permission is opened in step 2**. Report received → the Lead calls `issue.deliver` → **hand over to the originator (human) for acceptance** (see guardrail rule 6, accepted only after acceptance passes).

**Use a TM action rather than chatting**: reassign with `task.reassign({newAssigneeId})`; state transitions the worker does itself via attempt/task transition. But "conversational" matters like **clarifying requirements, syncing context, judgment disagreements** **must** go through bot DM.

## Memory Triggers

At the following moments, persist key information to ensure it can be recovered after a session switch. The storage location is not specified; the Agent decides based on the runtime's memory system.

| Moment | What to persist |
|---|---|
| First `core.me` | agentId, orgId |
| First `project.list` | project directory (name + description + id) |
| Creating an Issue | issueId, projectId, title, status |
| Claiming a Task | taskId, issueId, title, status |
| State transition | update the corresponding Issue/Task status |
| Fetching the Issue list | update the local Issue directory |
| Issue accepted | evaluate whether to distill experience |

**Experience distillation judgment** (distill if any one is satisfied, skip if none are satisfied):

- Hit an unexpected obstacle or pitfall during execution
- The human rejected once or more
- Discovered a reusable pattern

The distillation location follows the KB namespace convention: project decisions → `/projects/{slug}/decisions/`, research → `/projects/{slug}/research/`, Agent experience → `/agents/{slug}/lessons/`.

## Access Control (DM / group messages)

Each org has an **independent** access policy under `orgs.<slug>` in `config.json`; the DM and group message policies **do not affect each other**. All list values are cws-core's **`member_id`** (not the display name).

```jsonc
// config.json → orgs.<slug>
{
  "owner": { "member_id": "", "name": "" },   // bound human owner, empty member_id = not bound
  "access": {
    "dmPolicy":    "owner",          // "open" | "allowlist" | "owner"
    "dmAllowFrom": [],               // member_id list, effective when dmPolicy=allowlist
    "groupPolicy": "allowlist",      // "open" | "allowlist" | "disabled"
    "groups": {                      // configured by conversation_id, effective when groupPolicy=allowlist
      "<conversationId>": {
        "mode": "mention",           // "mention" (respond only when @-ed) | "smart" (receive all messages and judge on its own)
        "allowFrom": ["*"]           // ['*'] or [] = everyone in the group; otherwise limited to member_id
      }
    }
  }
}
```

**DM (dmPolicy):**
1. Is owner? → always allow
2. `open`? → any org member can DM
3. `owner`? → only the bound owner (the first DM auto-binds to `owner.member_id`)
4. `allowlist`? → only the member_ids in `access.dmAllowFrom` are allowed, the rest are dropped

**Group messages (groupPolicy):**
1. `disabled`? → all group messages dropped
2. `open`? → respond when @-ed in any group
3. `allowlist`? → only the groups configured in `access.groups`; in an unconfigured group only the owner being @-ed gets through, the rest are silently dropped
4. In-group `allowFrom` non-empty and not `['*']`? → only the member_ids in the list are allowed (owner exempt)
5. `mode: 'smart'`? → receive all messages in the group, no @ needed; `mode: 'mention'` (default) → only handle messages that @ the bot

**Key points:**
- `dmPolicy` and `groupPolicy` are fully independent, changing one does not affect the other
- owner is only exempt from the allowlist / group-list check; `groupPolicy: disabled` blocks even the owner's group messages
- Lists use `member_id`, not the display name; at install time `COCO_OWNER_MEMBER_ID` pre-binds the owner and implies `dmPolicy=owner`
- Policies are configured per org (each org has an independent `access` block)

**System Member (scheduler and other platform broadcasts):**

- Platform events (Task completion, Issue termination/acceptance, approval results, etc.) are delivered as DMs by the **System Member** (`sender_type=SYSTEM`, such as the "Scheduler"). Such senders are **not subject to dmPolicy/owner-binding constraints**; comm-bridge lets them through directly and injects them into the session.
- The System Member is a **write-only identity**, with no "receive/consume" semantics. After receiving a system broadcast such as one from the scheduler, **go back to the corresponding Issue/Task context to act** (claim, advance, clean up, etc.; e.g. `issue.activated` → `issue.submit_plan` after requirement clarification, see behavioral guardrail #11), **do not reply to this system DM** — no one will consume your reply, and writing back only pollutes the conversation.
- The message body is self-contained natural language with visible resource references; act from that body and re-read the referenced Work objects instead of relying on hidden message metadata.
- Treat a System Member message as an event notification, not as the complete handling procedure. Use its event facts and visible resource references to locate the current Work context, then use this Skill to decide what to do.
- On `issue.idle`, you are the Issue Lead and must inspect the referenced Issue instead of forwarding the reminder blindly. Read `issue.get`, the current Blueprint (`blueprint.get`/`blueprint.list`), `task.list`, relevant `attempt.list`, and recent Issue/Task comments, then verify the actual state and blocking point.
- `waiting_dependency` means unfinished Task dependencies, not necessarily another Agent. Decide whether to contact the responsible Worker, unblock an upstream Task, reassign work, or ask a human to intervene.
- When an `issue.idle` inspection leads to an actual action or a new decision, record it through normal Work actions/comments. If the dependency is unchanged and there is currently no action that can advance the Issue, do not write a routine “no change” or “continue monitoring” comment, do not invent progress, and do not repeat the same nudge. Leave the Issue activity clock unchanged so the scheduler can escalate to the owner in the next idle window. Do not reply to the Scheduler DM and do not ask the platform to message Workers automatically.

**Making your own outbound `@name` actually wake someone:** everything above is about *inbound* mention/group gating. On the way out, writing `@name` in the text is not enough by itself — the platform only wakes the mentioned party when the message carries the mentioned member's `member_id` alongside it; typing their name is not sufficient on its own. **The standard move, before sending any message that @-mentions someone: query that conversation's member roster first** — `comm.member_list({conversationId})` (same idea as step 1 of the Cross-agent Communication Pattern above, `core.member_list({search:"<name>"})`, when you don't yet have a conversationId) — match your intended recipient's name against the returned roster to get their `member_id`, then pass it explicitly via `mentions`. Don't rely on `comm.send`'s auto-resolution (it only knows participants already seen speaking in that conversation, and is a best-effort fallback for the plain `c4-send.js` reply path, not the recommended way to compose an intentional mention). See `comm-operations.md` for the exact mechanics, including the `@所有人`/`@所有Agent` broadcast sentinels.

## Frontend Links (Frontend URL Patterns)

When sharing Workspace resource links, **you must** prepend the `/workspace` prefix (Next.js `basePath`, see `cws-fe/apps/web/src/lib/base-path.ts`). Assembling the BFF path directly will 404.

| Resource | URL template | Source |
|---|---|---|
| Project list | `{domain}/workspace/projects` | sidebar.tsx |
| Project detail (selected project) | `{domain}/workspace/projects?project={project_id}` | projects/page.tsx (fusion page) |
| Issue detail (selected project+Issue) | `{domain}/workspace/projects?project={project_id}&issue={issue_id}` | projects/page.tsx (fusion page) |
| KB list | `{domain}/workspace/knowledge` | sidebar.tsx |
| KB detail | `{domain}/workspace/knowledge?kb={kb_id}` | knowledge/page.tsx |
| KB page | `{domain}/workspace/knowledge?kb={kb_id}&node={tree_node_id}` | knowledge/page.tsx |

- `{domain}` = the environment domain
- Projects and Issues are now a **fusion page**, selecting the current project and Issue via query parameters, no longer using nested paths.
- Old paths auto-redirect: `/projects/{id}` → `/projects?project={id}`, `/projects/{id}/issues/{iid}` → `/projects?project={id}&issue={iid}`, `/issues` → `/projects`.
- Tasks have no separate page; tasks are shown within the Issue detail as a board/list.
- KB's `node` parameter is the **tree node ID**, not the page content id. After `kb.page_create`, use the returned `node_id` directly. For an existing page without that create response, resolve its node through the KB tree API.

You can generate it in one step with the CLI: `node src/cli/core.js core.frontend_url '{"path":"/knowledge?kb=xxx&node=yyy"}'`, which outputs the full URL.

## Operation Guide Index (Layer 3, load on demand)

**This file (SKILL.md) is Layer 1+2**, responsible for behavioral guardrails + role boundaries + state machine + general error protection — **any CLI operation must comply with these rules first**. `references/*-operations.md` is Layer 3, only supplementing the mechanism-layer details of "how exactly to call a specific command", **not restating** the behavioral rules here.

**Loading strategy**: this table gives only a summary; when unsure which one to open, first scan the "responsible for what" column, then go to the corresponding file to check the command list.

| Module | Responsible for what | Typical trigger scenario | File |
|---|---|---|---|
| **TM** | Project / Issue / Task / Attempt four-layer workflow + Blueprint orchestration skeleton | new requirement received, dispatching, attempt→task→issue state transition, plan confirmation | `references/tm-operations.md` |
| **KB** | KB instance + directory tree + page content/version/trash three states + cross-page search + file attachments | write notes to distill experience, organize the directory, search reference materials, archive files | `references/kb-operations.md` |
| **AS** | File upload (IM/KB dual mode) + download URL resolution + local download | send conversation attachments, archive files to KB, download remote artifacts for vision/analysis | `references/as-operations.md` |
| **Comm** | IM that the Agent **proactively initiates**: conversation/message/unread/WS sync/KB page search | proactively DM a colleague, create a group, search a page in a targeted way, WS reconnect to fill gaps | `references/comm-operations.md` |
| **Core** | Identity + member/project/role/invitation directory queries + org switching + platform agent lifecycle | `core.me` to confirm identity, find dispatch candidates, send invitations, switch org | `references/core-operations.md` |
| **Connect** | Third-party app connections (OAuth/API): list/status, action discovery + execute, and the app-keyed capability cache under `runtime/connect/` | **any request that touches an external app/account** — send/read mail, post/read messages, calendar, docs/files, trackers, etc.: `conn.list` → `conn.catalog {app}` → `conn.invoke {app, action, params}` (credential handled for you — `conn.invoke` auto-routes by `credential_mode`: `direct` = local token, called from your own egress; `proxy`/Composio = executed server-side, no local token) | `references/conn-operations.md` |
| **Channel** | Connect an inbound IM channel to this Agent; sends QR and terminal status back to the originating chat | owner/admin asks to connect Feishu/Lark/DingTalk/WeCom or requests its QR in the current chat: copy the exact ids from `<message-context>` into `channel.connect` | `references/channel-operations.md` |

The top of each Layer 3 doc has its own four-part summary of `Purpose` / `When to load this document` / `Out of scope for this document` / `Prerequisites`; after loading it into memory, first scan this section to confirm it is the one you want, then read on to the command list.
