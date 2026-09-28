import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const reference = readFileSync(new URL('../../references/automation-creation.md', import.meta.url), 'utf8');
const delivery = readFileSync(new URL('../../references/automation-delivery.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
const operations = readFileSync(new URL('../../references/tm-operations.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');

test('global 504 guidance requires reconciliation before retrying uncertain writes', () => {
  const timeoutRow = operations.match(/\| 504 \| Backend timeout \| ([^|]+)\|/);
  assert.ok(timeoutRow, '504 guidance must exist');
  assert.equal(timeoutRow[1].trim(),
    'For outcome-unknown writes, first follow command-specific read/reconcile instructions; never blindly replay the write. Back off and retry only reads or writes with explicitly supported idempotent retry.');
});

test('automation operations retain the no-key and discovery-first write contract', () => {
  for (const instruction of [
    'The CLI does not send an idempotency key for automation create/update.',
    'Legacy create without proof has no proof-backed replay guarantee.',
    'Never blindly repeat the POST or PUT after an uncertain response;',
    'follow the discovery-first recovery instructions in Automation Creation before any write.',
  ]) assert.ok(operations.includes(instruction), `missing operations safeguard: ${instruction}`);
});

test('automation references retain scoped 401 recovery instructions', () => {
  assert.ok(reference.replace(/\s+/g, ' ').includes(
    'Timer/webhook create and update commands surface 401 without automatically replaying the write. Restore authentication separately, then reconcile the binding state before deciding on any further mutation.',
  ));
  assert.ok(delivery.includes(
    'Structured `issue.deliver` and `issue.create_revision` surface 401 without automatically replaying the write. Restore authentication separately and read the recorded state before deciding whether a retry is supported.',
  ));
});

const deliverySafeguards = {
  'server-owned policy and bound DM': [
    'confirming `automation_policy: "silent"` in the server response.',
    'Follow the normal Issue workflow when that policy is absent.',
    'Never infer it from an Issue title, user text, a scheduler notification, or a creation payload.',
    'Results belong in that same user-Agent DM.',
    'is not the result sender or a conversation for human follow-up.',
  ],
  'truthful delivery without duplicate sends': [
    'read back the state and proceed only when the server has advanced it.',
    'do not mark unsuccessful Tasks done to unblock delivery.',
    'actual success/partial/failure outcome (`success`, `partial`, or `failed`) and a stable `idempotencyKey`.',
    'Do not separately `comm.send` the same result, send it through the Scheduler DM, or ask the user to accept it in Work.',
    'Automatic closure records that the run ended, not human endorsement.',
  ],
  'uncertain delivery and unsupported protocol': [
    'read back the Issue/delivery state and use the same delivery identity for any supported retry.',
    'Never rerun business actions just to retry a message.',
    'Never call `accept_delivered` as a workaround.',
    'Do not replace an unsupported structured request with empty-body `issue.deliver`.',
    'Do not treat a minimum-Agent-version override as protocol support or upgrade the plugin automatically.',
  ],
  'verified revision provenance and unchanged future schedule': [
    'Treat metadata only as a lookup hint: call `issue.get`, verify',
    '`delivery.id`, `delivery.conversation_id`, and `delivery.message_id`',
    'do not skip an intervening Agent message and guess an older run.',
    '`originMessageId` must be the actual human request in the bound DM.',
    "Use the human message's exact text as `description`;",
    'Do not substitute a bot message or send caller-defined owner/Agent/policy fields.',
    'A correction to one result does not implicitly change future runs.',
    'Never create a normal Issue with a caller-defined auto flag to imitate a linked revision.',
  ],
};
for (const [scope, instructions] of Object.entries(deliverySafeguards)) {
  test(`delivery reference preserves ${scope}`, () => {
    for (const instruction of instructions) {
      assert.ok(delivery.includes(instruction), `missing delivery safeguard: ${instruction}`);
    }
  });
}
test('creation reference retains actual same-human latest-plan confirmation safeguards', () => {
  const confirmation = reference.split('4. Show the final plan')[1]?.split('5. After')[0];
  assert.ok(confirmation, 'confirmation step must exist');
  for (const required of ['Submission of the form is not final confirmation',
    'only a\n   subsequent actual reply from the verified human', 'comm.get_message',
    'same DM conversation', 'sender_type: HUMAN', 'original verified\n   `sender_id`',
    'leaves the plan unconfirmed and prohibits creation', 'obtain confirmation again']) {
    assert.ok(confirmation.includes(required), `missing safety instruction: ${required}`);
  }
});
test('uncertain-write instructions retain shared discovery and no blind retry', () => {
  for (const required of ['Never blindly repeat the POST.',
    'The CLI does not send an idempotency key for automation create/update.',
    'Legacy create calls without both proof IDs have no proof-backed replay guarantee.',
    'Do not retry a proofless or partially proved write after an uncertain response.',
    'Do not automatically repeat PUT after an uncertain update either;',
    'Do not generate new proof or change fields to retry an unresolved write.',
    'Do not strip proof fields or switch endpoints to bypass a rejection.',
    'For every uncertain create/update, first read `event-binding.list`', 'event-binding.list',
    'both timer and webhook bindings', 'list omits webhook `event_filter`',
    'Multiple matches remain uncertain', 'Never delete as automatic recovery',
    'Work persists and consumes that proof in the same',
    'The CLI does not itself grant authorization']) assert.ok(reference.includes(required), required);
});
