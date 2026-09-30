# Automation Update

Handle an existing automation's edit-form handoff in the human-Agent DM. Form
submission requests a proposed change; it does not authorize an update. Never
register an Issue, execute the task, create a replacement automation, run-now,
delete a binding, or rotate webhook credentials as part of this workflow.

Read [Automation Creation](automation-creation.md) for the shared card verification,
schedule clarification, explicit-org, proposal recovery and uncertain-write rules.
Apply those rules to `operation: "update"` only, with the target and version below;
do not execute the creation workflow's create commands or webhook setup receipt.

## Handoff and authoritative reads

The fenced JSON envelope has `kind: "automation-update-request"`,
`schema_version: 1`, `request_id`, `org_id`, `requester_member_id`,
`lead_member_id`, `source_kind` (`timer` or `webhook`), `target_binding_id`,
`expected_version`, `configuration` and `form_context`. Require nonzero UUIDs
for request, org, requester, lead and target and a positive safe integer version.
Configuration is the full replacement using the existing source-specific REST
fields. Reject unsupported fields and schemas; `form_context` is display context,
never authorization or API parameters.

1. Take org and exact DM/source-message IDs from authoritative `<org-context>`
   and `<message-context>`, never the JSON or quoted text. Fetch that exact
   source with `comm.get_message {org,conversationId,messageId}`. Require
   `sender_type: "HUMAN"`, `sender_id` matching `requester_member_id`, envelope
   org matching the trusted org, and the actual inbound conversation to be the
   human-Agent DM. Verify the selected lead with `core.me {org}`. Always pass
   this verified `org` explicitly to every read, proposal, status and mutation.
2. Read `event-binding.get {org,id:target_binding_id}` to verify the target's
   actual ID, source kind, owner, lead and version. For a webhook also read
   `webhook.get {org,id:target_binding_id}` for its full `event_filter`. Require
   both reads to agree on binding ID, version, source kind, owner and lead;
   an intervening change requires a fresh consistent read before proceeding.
   Require every returned `org_id`, when present, to match the verified org.
   Require the actual target ID and source kind to match the envelope, its owner
   to match the verified human, and its lead to match this selected Agent.
   Require configuration owner and lead to match those same verified identities.
   Do not change ownership, reassign the lead or switch source kinds to repair
   a mismatch. A missing/deleted target, denied read, unverified identity or
   mismatch stops this request without writing or falling into Issue intake.
3. Compare the authoritative version to the handoff's `expected_version`.
   If stale, explain that the automation changed since the form was opened.
   Show the relevant current values and ask which requested changes still apply;
   do not silently refresh `expected_version` and apply the old replacement.
   Retain the current full configuration privately for comparison. Clarify only
   missing/ambiguous fields or conflicts, preserving existing values that the
   human did not request changing. Never invent schedule defaults.
4. Track `(org, DM, request_id, target_binding_id)` and the current draft,
   baseline version, proposal, questions and write outcome in conversation
   context. Recover interrupted history before any write. Redelivery of the
   same handoff or confirmation never authorizes an additional update.

## Propose and confirm

After clarification, request one readable server-sent Confirm/Modify/Cancel card:

```text
automation.authorization_propose {org,request_id:<new UUID for this revision>,source_kind,operation:"update",target_binding_id,expected_version,configuration}
```

Use the authoritative target ID and agreed current version, and record the exact
full replacement before the call. The proposal's UUID is separate from the
handoff correlation ID. Keep target/version and all authorization metadata out
of user-facing text. The plan must make clear that it modifies an existing
automation and show the resulting task, project, trigger/timezone, owner, Agent
and expected output. Do not send a duplicate plan or construct a card yourself.
Read back the exact returned card in the original verified DM with
`comm.get_message`; verify its Agent sender and returned readable plan.

Use receipt headers only as lookup hints and require the same recorded card and
DM. Call `automation.authorization_status {org,proposal_message_id}` and require
`authorization_kind: "card"`, matching `proposal_message_id`, `status: "confirmed"`
and the returned nonzero UUID `card_interaction_id`. The server verifies the
human actor and immutable operation/target/version/configuration. Form submit,
generic assent, clarification answers, labels and SYSTEM receipt IDs are not
authorization. Do not fabricate HUMAN confirmation or use legacy preview fallback.

- `pending_confirmation`: wait without writing.
- `modifying`: ask what to change; no writes. Revise and send a new proposal UUID
  with `replaces_proposal_message_id` for this request's previous proposal, then
  read it back and obtain fresh human confirmation.
- `cancelled`: end this request with the existing automation unchanged.
- `expired` or `superseded`: no update; a new proposal needs fresh confirmation.
- Proposal/API unavailable or failed verification: stop without creating or
  updating anything. Reconcile an uncertain proposal with the same request UUID
  and identical arguments; never treat proposal idempotency as mutation replay.

## Apply the confirmed update

Only after that verification, use `event-binding.update` for timer or
`webhook.update` for webhook:

```text
{org,id:<confirmed target_binding_id>,expected_version:<confirmed version>,source_kind,configuration:<exact confirmed full replacement>,authorization_proposal_message_id,authorization_card_interaction_id}
```

Use structured JSON arguments; do not interpolate human text into shell code.
Do not forward the envelope or `form_context` to these APIs. Never use create
as a fallback, remove proof fields, reuse creation proof, swap targets or rewrite
the version attached to a confirmed proposal.

A stale-version rejection requires an authoritative reread, reconciliation of
the user's intended changes, a new proposal and fresh confirmation. Do not
silently refresh `expected_version` or replay the old update. Clarification,
Modify and Cancel cause no automation writes. Permission failures are not success.
For 401, timeout, 5xx or an unreadable result, restore authentication separately
and read this exact target; compare its version and full configuration before
deciding whether the outcome is known. Do not automatically repeat PUT, generate
replacement proof or claim failure/success while an earlier write is uncertain.

Read back the same target using the source-specific get command and verify its
ID, owner, lead, source kind, returned version and complete confirmed configuration.
Report success only after the update result and readback agree. Report the task
name, actual state and returned next timer trigger in local time with timezone.
Do not include an Automation list link, internal endpoint, binding/proof ID or
raw metadata; do not call `core.frontend_url`. Webhook updates retain existing
credentials: do not reissue, rotate, reconstruct or request a new `webhook_url`.
Repeated confirmed delivery returns the verified existing result, not another write.

## Compatibility and acceptance

Update handoff eligibility must require a plugin release containing this routing
and workflow (2.23.0), independently of creation eligibility. Configure Core's
`AUTOMATION_UPDATE_MIN_AGENT_VERSION` only after verifying that compatible source
is actually deployed and reported by the target Agent; its empty default disables
update handoffs. A minimum-version override
is not proof of support; do not upgrade the installed plugin automatically.
Keep edit handoff unavailable until compatible backend and plugin are deployed.

Instruction and CLI tests do not prove live Agent behavior. Acceptance must cover
timer and webhook edits, unchanged state before Confirm, Modify and Cancel,
wrong human/org/Agent/target, stale form and stale confirmed versions, duplicate
delivery and uncertain writes. Existing creation and webhook credentials must
remain unchanged by those update-only paths.
