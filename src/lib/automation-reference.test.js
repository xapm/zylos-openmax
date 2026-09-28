import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const reference = readFileSync(new URL('../../references/automation-creation.md', import.meta.url), 'utf8');
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
  for (const required of ['Never blindly repeat the POST', 'event-binding.list',
    'both timer and webhook bindings', 'list omits webhook `event_filter`',
    'Multiple matches remain uncertain', 'Never delete as automatic recovery',
    'not a durable CLI confirmation state machine']) assert.ok(reference.includes(required), required);
});
