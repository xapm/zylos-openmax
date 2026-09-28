#!/usr/bin/env node

/**
 * Task Management CLI.
 *
 * Thin stateless wrapper over cws-core's task/project/issue surface, aligned
 * to the `contract-v2` tag of cws-core (which proxies all TM RPCs to
 * cws-work). See `docs/dependency-coverage/cws-tm.md` for the per-endpoint
 * mapping and Findings table.
 *
 * Usage:
 *   node src/cli/tm.js <command> '<json-params>'
 *   node src/cli/tm.js project.create '{"name":"Growth","slug":"growth","leadMemberId":"..."}'
 *
 * All exposed commands are backed by an existing cws-core@contract-v2
 * forwarding endpoint — there are no placeholder / ⏳ entries anymore. The
 * earlier ⏳ batch (blueprint fine-grained ops + taskboard.list) was removed
 * because cws-core does not yet proxy them; re-add when forwarding ships.
 *
 * Pagination convention:
 *   - User-facing camelCase: page, pageSize, orderBy
 *   - Wire snake_case:       page, page_size, order_by
 *   - Most list endpoints use offset paging via {page, page_size}.
 *   - Comment list follows its backend contract and uses {cursor, limit}.
 */

import { getForOrg, postForOrg, patchForOrg, putForOrg, delForOrg, apiPath } from '../lib/client.js';
import { resolveDefaultOrgId } from '../lib/config.js';
import { automationConfiguration } from '../lib/automation-configuration.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

// Org resolution (mirrors conn.js PR#127). Every TM route — projects, issues,
// tasks, comments, blueprints, attempts, event-bindings — is org-owned: the backend
// resolves the org from the JWT principal and 403s ("org membership required")
// on an identity-only token. A bare get()/post() would silently fall through to
// resolveDefaultOrgId(), which returns '' when >1 org is enabled and no org is
// given — producing that opaque 403. Resolve the operating org (explicit {org}
// or the single enabled org) and FAIL FAST with an actionable 400 when it can't
// be determined. Single-org / COCO_ORG_ID deployments resolve exactly as before.
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

// Org-scoped shadows of the bare verbs: each call carries the operating org's
// JWT. Resolved lazily per call so `help` / usage never require an org.
const get   = (path, query) => getForOrg(requireOrgId(), path, query);
const post  = (path, body)  => postForOrg(requireOrgId(), path, body);
const patch = (path, body)  => patchForOrg(requireOrgId(), path, body);
const put   = (path, body)  => putForOrg(requireOrgId(), path, body);
const del   = (path)        => delForOrg(requireOrgId(), path);

// Build the standard PageParams query block from user-supplied camelCase.
function pageParams(p) {
  return {
    page:      p.page,
    page_size: p.pageSize,
    order_by:  p.orderBy,
  };
}

function cursorParams(p) {
  return {
    cursor:   p.cursor,
    limit:    p.limit,
    order_by: p.orderBy,
  };
}

function issueListParams(p) {
  return {
    status:           p.status,
    statuses:         p.statuses,
    priority:         p.priority,
    include_archived: p.includeArchived,
    query:            p.query,
    ...pageParams(p),
  };
}

function requireParams(commandName, names) {
  const missing = names.filter((name) => params[name] == null || params[name] === '');
  if (missing.length > 0) {
    throw new Error(`${commandName} requires ${missing.join(', ')}`);
  }
}

const COMMANDS = {
  // =========================================================================
  //  PROJECT
  // =========================================================================

  'project.list': () => get(apiPath('/projects'), {
    status: params.status,       // enum: active|archived
    query:  params.query,
    ...pageParams(params),
  }),

  // contract-v2 create-project body: { name*, description?, slug*,
  // is_default, lead_member_id*, knowledge_base_id?, member_ids? }
  'project.create': () => post(apiPath('/projects'), {
    name:               params.name,
    description:        params.description,
    slug:               params.slug,
    is_default:         params.isDefault,
    lead_member_id:     params.leadMemberId,
    knowledge_base_id:  params.knowledgeBaseId,
    member_ids:         params.memberIds,
  }),

  'project.get': () => get(apiPath(`/projects/${params.id}`)),

  // contract-v2 update-project body: { name?, description?, lead_member_id? }
  'project.update': () => patch(apiPath(`/projects/${params.id}`), {
    name:               params.name,
    description:        params.description,
    lead_member_id:     params.leadMemberId,
  }),

  'project.archive':   () => post(apiPath(`/projects/${params.id}/archive`)),

  'project.members': () => get(
    apiPath(`/projects/${params.id}/members`),
    pageParams(params),
  ),

  'project.member_add': () => post(apiPath(`/projects/${params.id}/members`), {
    member_id: params.memberId,
    role:      params.role ?? 'member',
  }),

  'project.member_remove': () => del(
    apiPath(`/projects/${params.id}/members/${params.memberId}`),
  ),

  // =========================================================================
  //  ISSUE  (✅ all cws-core BFF issue commands — note issue write paths
  //  use the FLAT path /issues/{id}, not /projects/{pid}/issues/{id})
  // =========================================================================

  'issue.list': () => get(apiPath('/issues'), issueListParams(params)),

  'issue.list_in_project': () => get(
    apiPath(`/projects/${params.projectId}/issues`),
    issueListParams(params),
  ),

  // Flat path, no project prefix.
  'issue.get': () => get(apiPath(`/issues/${params.id}`)),

  // create-issue body: requires title*, lead_agent_id*, owner_member_id*;
  // optional priority (default medium), origin_conversation_id,
  // origin_message_id, backlog. Context for the work goes in description
  // (natural language) and later in task comments — not in id lists.
  'issue.create': () => {
    requireParams('issue.create', ['projectId', 'title', 'leadAgentId', 'ownerMemberId']);
    return post(apiPath(`/projects/${params.projectId}/issues`), {
      title:                  params.title,
      description:            params.description || '',
      backlog:                params.backlog,
      priority:               params.priority,              // low|medium|high (optional, default medium)
      lead_agent_id:          params.leadAgentId,
      owner_member_id:        params.ownerMemberId,
      origin_conversation_id: params.originConversationId,
      origin_message_id:      params.originMessageId,
    });
  },

  // Flat path; body: { title?, description?, priority? }.
  'issue.update': () => patch(
    apiPath(`/issues/${params.id}`),
    {
      title:              params.title,
      description:        params.description,
      priority:           params.priority,
    },
  ),

  // Semantic issue lifecycle actions (cws-core BFF). The generic
  // POST /issues/{id}/transition endpoint was removed; each state change is
  // now its own endpoint that enforces invariants and side effects.
  'issue.activate': () => post(
    apiPath(`/issues/${params.id}/activate`),
    { source: params.source ?? 'lead_chat' },
  ),
  'issue.submit_plan': () => {
    if (!params.blueprintId) {
      throw new Error('issue.submit_plan requires blueprintId; create a one-step Blueprint for simple tasks');
    }
    return post(
      apiPath(`/issues/${params.id}/submit-plan`),
      {
        plan_text:       params.planText ?? params.plan,
        blueprint_id:    params.blueprintId,
        source:          params.source ?? 'lead_chat',
        card_message_id: params.cardMessageId,
      },
    );
  },
  // Temporary text-card simulation: when a human replies "接受计划", Lead may
  // proxy that card click with source=text_card_proxy. Real interactive cards
  // should call the same endpoint as the human principal.
  'issue.accept_plan': () => post(
    apiPath(`/issues/${params.id}/accept-plan`),
    { source: params.source ?? 'text_card_proxy' },
  ),
  'issue.deliver':         () => post(apiPath(`/issues/${params.id}/deliver`)),
  'issue.resume':          () => post(
    apiPath(`/issues/${params.id}/resume`),
    {
      reason: params.reason ?? params.feedback,
      source: params.source ?? 'lead_chat',
    },
  ),
  // Temporary text-card simulation: only after the Owner explicitly accepts
  // the delivery may the Lead proxy that acceptance with text_card_proxy.
  'issue.accept_delivered': () => post(
    apiPath(`/issues/${params.id}/accept-delivered`),
    { source: params.source ?? 'text_card_proxy' },
  ),

  // Body field is new_owner_member_id (mirrors task.reassign pattern).
  'issue.reassign_owner': () => post(
    apiPath(`/issues/${params.id}/reassign-owner`),
    { new_owner_member_id: params.ownerMemberId ?? params.newOwnerMemberId },
  ),

  // Flat path; body field is `new_project_id` (not `project_id`).
  'issue.move_project': () => post(
    apiPath(`/issues/${params.id}/move`),
    { new_project_id: params.targetProjectId ?? params.newProjectId },
  ),

  // 提前终止(v0.7): 把一个未结论 Issue 主动停下 → terminated。服务端会级联
  // 取消其下非终态 Task,并给 Lead 发 issue.terminated 事件做善后。
  // 不回滚已发生副作用——善后由 Lead 与人类共同决定(见 SKILL.md)。
  // POST /issues/{id}/terminate, body: { reason?, source? }
  'issue.terminate': () => post(
    apiPath(`/issues/${params.id}/terminate`),
    {
      reason: params.reason,
      source: params.source ?? 'lead_chat',
    },
  ),

  // =========================================================================
  //  TASK  (✅ all 8 on cws-core BFF; create uses the doubly-nested path
  //  /projects/{pid}/issues/{iid}/tasks. v0.7 claim/start split: claim only
  //  assigns, task.start begins work + opens the attempt + checks dependsOn.)
  // =========================================================================

  'task.list': () => get(apiPath('/tasks'), {
    project_id:       params.projectId,
    issue_id:         params.issueId,
    status:           params.status,           // pending|assigned|running|done|failed|cancelled
    include_archived: params.includeArchived,
    ...pageParams(params),
  }),

  'task.get': () => get(apiPath(`/tasks/${params.id}`)),

  // create-task path: /projects/{pid}/issues/{iid}/tasks
  // body: { title*, description?, assignee_id?, blueprint_step_id?, depends_on? }
  // (priority / status are NOT accepted — those live on issue.)
  // depends_on entries MUST be upstream Task ids (task.id). What a task needs
  // goes in description (natural language); upstream deliverables arrive via the
  // upstream task's comments, not a context id list.
  'task.create': () => post(
    apiPath(`/projects/${params.projectId}/issues/${params.issueId}/tasks`),
    {
      title:              params.title,
      description:        params.description || '',
      assignee_id:        params.assigneeId,
      blueprint_step_id:  params.blueprintStepId,
      depends_on:         params.dependsOn,
    },
  ),

  // v0.7 claim/start split: claim ONLY assigns the task to the caller
  // (pending → assigned). It does NOT start work or open an attempt — call
  // task.start next. POST /tasks/{id}/claim (no body; principal from auth header).
  'task.claim': () => post(apiPath(`/tasks/${params.id}/claim`)),

  // v0.7: start an assigned task (assigned → running) and open the attempt.
  // The dependency gate (depends_on all done) is enforced here, not at claim.
  // POST /tasks/{id}/start (no body; principal from auth header).
  'task.start': () => post(apiPath(`/tasks/${params.id}/start`)),

  // Path is /transition (not /status); body field is target_status.
  'task.transition': () => post(
    apiPath(`/tasks/${params.id}/transition`),
    { target_status: params.status ?? params.targetStatus },
  ),
  // Backward-compat alias for older scripts.
  'task.status': () => post(
    apiPath(`/tasks/${params.id}/transition`),
    { target_status: params.status ?? params.targetStatus },
  ),

  // Body field is new_assignee_id (not assignee_id).
  'task.reassign': () => post(
    apiPath(`/tasks/${params.id}/reassign`),
    { new_assignee_id: params.assigneeId ?? params.newAssigneeId },
  ),

  // =========================================================================
  //  COMMENT  (issue/task discussion + the agent-to-agent handoff channel.
  //  A worker writes a completion comment on its task — natural-language
  //  deliverable address/summary — when finishing; the next assignee reads the
  //  upstream task's comments to pick up context. Author is derived from the
  //  auth principal; body is markdown.)
  // =========================================================================

  // body: { work_type ('issue'|'task'), work_id, body_markdown }
  'comment.create': () => post(apiPath('/comments'), {
    work_type:     params.workType,
    work_id:       params.workId,
    body_markdown: params.bodyMarkdown ?? params.body,
  }),

  // Each comment is addressable: GET /comments/{id}.
  'comment.get': () => get(apiPath(`/comments/${params.id}`)),

  // List a work item's comments (time-ordered). Requires workType + workId.
  'comment.list': () => get(apiPath('/comments'), {
    work_type: params.workType,
    work_id:   params.workId,
    ...cursorParams(params),
  }),

  // =========================================================================
  //  BLUEPRINT  (✅ all 4 in contract-v2 — create / get / list / set-steps;
  //  blueprint.create and .list are issue-nested; blueprint.set_steps is
  //  PUT-and-replace, not POST-and-append.)
  // =========================================================================

  // contract-v2 create-blueprint:
  //   POST /api/v1/issues/{issue_id}/blueprints
  //   body: { steps[]*, estimated_budget?, notes? }
  // where each step is { temp_id, description, required_resources?,
  //                     depends_on_temp_ids? }.
  //
  // NOTE: cws-core derives author_agent_id from the auth principal; it is not
  // a request field and must not be forwarded.
  'blueprint.create': () => post(
    apiPath(`/issues/${params.issueId}/blueprints`),
    {
      steps:            params.steps,
      estimated_budget: params.estimatedBudget,
      notes:            params.notes,
    },
  ),

  'blueprint.get': () => get(
    apiPath(`/blueprints/${params.id}`),
    { include_steps: params.includeSteps },
  ),

  // contract-v2 path: GET /api/v1/issues/{issue_id}/blueprints (path-scoped,
  // not query-scoped).
  'blueprint.list': () => get(
    apiPath(`/issues/${params.issueId}/blueprints`),
    pageParams(params),
  ),

  // contract-v2 set-blueprint-steps: PUT (replace all). Replaces the legacy
  // tm.js `blueprint.add_step` which assumed POST-and-append semantics —
  // that surface does not exist in contract-v2.
  'blueprint.set_steps': () => put(
    apiPath(`/blueprints/${params.blueprintId ?? params.id}/steps`),
    { steps: params.steps },
  ),

  // =========================================================================
  //  ATTEMPT  (contract-v2: create / get / list / transition)
  // =========================================================================

  // contract-v2 create-attempt: POST /tasks/{task_id}/attempts
  // (attempt_number auto-increments server-side)
  'attempt.create': () => post(
    apiPath(`/tasks/${params.taskId}/attempts`),
  ),

  'attempt.get': () => get(apiPath(`/attempts/${params.id}`)),

  'attempt.list': () => get(
    apiPath(`/tasks/${params.taskId}/attempts`),
    pageParams(params),
  ),

  // contract-v2 transition-attempt: POST /attempts/{id}/transition
  'attempt.transition': () => post(
    apiPath(`/attempts/${params.id}/transition`),
    {
      target_status:                    params.status ?? params.targetStatus,
      failure_reason:                   params.failureReason,
      blocked_on_approval_request_ids:  params.blockedOnApprovalRequestIds,
    },
  ),

  // =========================================================================
  //  EVENT BINDING  (定时任务 / create-by-agent — cws-core /event-bindings)
  //  create-by-agent: agent 必须 leadMemberId=自己、ownerMemberId=对话人类;
  //  否则被 cws-work 护栏拒（lead≠自己 / owner 缺失或=自己）。见 SKILL.md。
  // =========================================================================

  'event-binding.create': () => post(apiPath('/event-bindings'), automationConfiguration(params, 'timer')),

  'webhook.create': () => post(apiPath('/webhooks'), automationConfiguration(params, 'webhook')),
  'webhook.get': () => get(apiPath(`/webhooks/${encodeURIComponent(params.id)}`)),

  'event-binding.list': () => get(apiPath('/event-bindings')),

  'event-binding.get': () => get(apiPath(`/event-bindings/${params.id}`)),

  // 删除 binding 只停止后续触发,不影响已触发生成的 Issue。
  'event-binding.delete': () => del(apiPath(`/event-bindings/${params.id}`)),

};

function printUsage() {
  console.log(`TM CLI — Task Management against cws-core@contract-v2

Usage: node src/cli/tm.js <command> '<json-params>'

PROJECT  (all ✅ on contract-v2)
  project.list           {status?, query?, page?, pageSize?, orderBy?}
  project.create         {name, leadMemberId, description?, slug?, isDefault?,
                          knowledgeBaseId?, memberIds?}
  project.get            {id}
  project.update         {id, name?, description?, leadMemberId?}
  project.archive        {id}
  project.members        {id, page?, pageSize?, orderBy?}
  project.member_add     {id, memberId, role?}                               # role default: member
  project.member_remove  {id, memberId}

ISSUE  (all ✅ on contract-v2 — write paths use /issues/{id}, NOT /projects/{pid}/issues/{id})
  issue.list             {status?, statuses?, priority?, includeArchived?, query?, page?, pageSize?, orderBy?}
  issue.list_in_project  {projectId, status?, statuses?, priority?, includeArchived?, query?, page?, pageSize?, orderBy?}
  issue.get              {id}
  issue.create           {projectId, title, leadAgentId,
                          ownerMemberId, priority?,
                          description?, originConversationId?, originMessageId?,
                          backlog?}                                          # backlog default true; set false to start in_progress
  issue.update           {id, title?, description?, priority?}
  issue.activate         {id, source?}                                        # source: lead_chat|ui|event_binding|system
  issue.submit_plan      {id, planText, blueprintId, source?, cardMessageId?}
  issue.accept_plan      {id, source?}                                        # source: im|explicit|text_card_proxy; default text_card_proxy
  issue.deliver          {id}
  issue.resume           {id, reason?, source?}                               # human feedback → in_progress
  issue.accept_delivered {id, source?}                                        # source: im|explicit|text_card_proxy; default text_card_proxy
  issue.reassign_owner   {id, newOwnerMemberId (or 'ownerMemberId')}          # change issue owner
  issue.move_project     {id, newProjectId (or 'targetProjectId')}
  issue.terminate        {id, reason?, source?}                           # 提前终止 → terminated; 级联取消 Task + 发善后事件

TASK  (all ✅ on contract-v2; create uses doubly-nested path)
  task.list              {projectId?, issueId?, status?, includeArchived?, page?, pageSize?, orderBy?}
  task.get               {id}
  task.create            {projectId, issueId, title, description?,
                          assigneeId?, blueprintStepId?, dependsOn?}            # dependsOn entries are upstream task.id
  task.claim             {id}                                                    # 只分配 pending→assigned; no body
  task.start             {id}                                                    # assigned→running + 开 attempt; no body
  task.transition        {id, targetStatus}                                      # alias: task.status
  task.reassign          {id, newAssigneeId (or 'assigneeId')}

COMMENT  (issue/task discussion + agent-to-agent handoff channel)
  comment.create         {workType ('issue'|'task'), workId, bodyMarkdown}       # author from auth; markdown body
  comment.get            {id}                                                    # comments are addressable
  comment.list           {workType, workId, cursor?, limit?, orderBy?}

BLUEPRINT  (all ✅ on contract-v2)
  blueprint.create                  {issueId, steps[], estimatedBudget?, notes?}
  blueprint.get                     {id, includeSteps?}
  blueprint.list                    {issueId, page?, pageSize?, orderBy?}
  blueprint.set_steps               {blueprintId (or 'id'), steps[]}             # replaces ALL steps

ATTEMPT  (all ✅ on contract-v2)
  attempt.create         {taskId}                                                # attempt_number auto-increments
  attempt.get            {id}
  attempt.list           {taskId, page?, pageSize?, orderBy?}
  attempt.transition     {id, targetStatus (or 'status'), failureReason?,
                          blockedOnApprovalRequestIds?}

EVENT BINDING  (定时任务 / create-by-agent)
  event-binding.create   {org, source_kind:"timer", configuration} # supported REST body; cron/once/interval + timezone
                         Legacy: {cronExpr, leadMemberId, ownerMemberId, projectId,
                          title, description?}                                   # agent: leadMemberId=自己, ownerMemberId=对话人类
  event-binding.list     {}                                                     # 本 org 的定时任务
  webhook.create         {org, source_kind:"webhook", configuration} # {lead_member_id, owner_member_id, spec, event_filter?}
  webhook.get            {org, id}
  event-binding.get      {id}
  event-binding.delete   {id}                                                   # 停止后续触发, 不影响已生成的 Issue

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

main();
