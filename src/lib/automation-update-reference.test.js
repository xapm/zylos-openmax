import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const skill = read('../../SKILL.md');
const update = read('../../references/automation-update.md');

// Shipped instructions are the routing implementation; these do not simulate an Agent.
test('update handoffs have their own workflow before generic task intake', () => {
  assert.ok(skill.includes('kind: "automation-update-request"'));
  assert.ok(skill.includes('[Automation Update](references/automation-update.md) before generic Issue intake'));
  assert.ok(skill.includes('Editing an existing automation must never fall through to creation.'));
});

for (const [scope, safeguards] of Object.entries({
  provenance: ['`sender_type: "HUMAN"`', '`comm.get_message {org,conversationId,messageId}`',
    '`core.me {org}`', '`event-binding.get {org,id:target_binding_id}`',
    '`webhook.get {org,id:target_binding_id}`', 'its owner to match the verified human',
    'its lead to match this selected Agent', 'this verified `org` explicitly',
    'both reads to agree on binding ID, version, source kind, owner and lead',
    'every returned `org_id`, when present, to match the verified org'],
  confirmation: ['operation:"update",target_binding_id,expected_version,configuration',
    '`authorization_kind: "card"`', '`status: "confirmed"`', '`card_interaction_id`',
    '`replaces_proposal_message_id`', '`modifying`: ask what to change; no writes.',
    '`cancelled`: end this request with the existing automation unchanged.',
    'A stale-version rejection requires an authoritative reread', 'a new proposal and fresh confirmation'],
  recovery: ['Do not silently refresh `expected_version` or replay the old update.',
    'Do not automatically repeat PUT', 'Never use create as a fallback',
    'never authorizes an additional update', 'Report success only after the update result and readback agree.'],
  receipt: ['Do not include an Automation list link', 'do not call `core.frontend_url`',
    'do not reissue, rotate, reconstruct or request a new `webhook_url`'],
})) {
  test(`update instructions retain ${scope} safeguards`, () => {
    for (const safeguard of safeguards) assert.ok(update.includes(safeguard), safeguard);
  });
}
