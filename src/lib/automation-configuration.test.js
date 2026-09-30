import assert from 'node:assert/strict';
import test from 'node:test';
import { automationAuthorizationPreview, automationAuthorizationProposal, automationConfiguration, automationMutation } from './automation-configuration.js';

const base = { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' } };
const cardID = '01000000-0000-4000-8000-000000000002';

for (const kind of ['timer', 'webhook']) {
  test(`${kind} card consent is exclusive transport metadata for create and update`, () => {
    const proof = { authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID };
    const params = { id: 'binding', expected_version: 2, source_kind: kind, configuration: base, ...proof };
    for (const operation of ['create', 'update']) {
      const result = automationMutation(params, kind, operation);
      assert.equal(result.authorization_card_interaction_id, cardID);
      assert.equal(result.authorization_confirmation_message_id, undefined);
      assert.throws(() => automationMutation({ ...params, authorization_confirmation_message_id: '1790220732845' }, kind, operation), /exactly one/);
      for (const value of ['', null, 1, '1790220732845', cardID.replaceAll('-', ''), '00000000-0000-0000-0000-000000000000']) {
        assert.throws(() => automationMutation({ ...params, authorization_card_interaction_id: value }, kind, operation), /canonical nonzero UUID/);
      }
      assert.throws(() => automationMutation({ ...params, authorization_proposal_message_id: undefined }, kind, operation), /requires both/);
    }
    assert.throws(() => automationMutation({ source_kind: kind, configuration: { ...base, ...proof } }, kind), /unsupported/);
  });
}

test('replacement names one previous proposal without altering the configuration', () => {
  const params = { source_kind: 'timer', operation: 'create', request_id: cardID,
    configuration: { ...base, timezone: 'Asia/Singapore' }, replaces_proposal_message_id: '1790220732844' };
  assert.equal(automationAuthorizationProposal(params).replaces_proposal_message_id, '1790220732844');
  assert.equal(automationAuthorizationProposal(params).configuration, params.configuration);
  for (const value of ['', null, 1, '01', 'not-a-message']) {
    assert.throws(() => automationAuthorizationProposal({ ...params, replaces_proposal_message_id: value }), /canonical decimal/);
  }
});
test('readable proposal binds its request UUID to the unchanged final configuration and scope', () => {
  const request_id = '01000000-0000-4000-8000-000000000001';
  const configuration = { ...base, timezone: 'Asia/Singapore' };
  const params = { org: 'org', source_kind: 'timer', operation: 'update', target_binding_id: 'binding', expected_version: 2, configuration, request_id };
  assert.deepEqual(automationAuthorizationProposal(params), {
    source_kind: 'timer', operation: 'update', target_binding_id: 'binding', expected_version: 2, configuration, request_id,
  });
  assert.deepEqual(automationAuthorizationProposal({ ...params, operation: 'create', target_binding_id: '', expected_version: 0 }), {
    source_kind: 'timer', operation: 'create', configuration, request_id,
  });
  for (const value of [undefined, null, 42, '', 'some-key', '00000000-0000-0000-0000-000000000000', ` ${request_id}`, request_id.replaceAll('-', '')]) {
    assert.throws(() => automationAuthorizationProposal({ ...params, request_id: value }), /request_id must be a UUID/);
  }
  assert.throws(() => automationAuthorizationProposal({ ...params, operation: 'delete' }), /operation/);
  assert.throws(() => automationAuthorizationProposal({ ...params, expected_version: 0 }), /preview requires/);
  assert.throws(() => automationAuthorizationProposal({ ...params, configuration: { ...base, request_id } }), /unsupported/);
  for (const timezone of [undefined, null, '', '   ', 0]) {
    assert.throws(() => automationAuthorizationProposal({ ...params, configuration: { ...base, timezone } }), /explicit timezone/);
  }
  assert.equal(automationAuthorizationProposal({ ...params, source_kind: 'webhook', configuration: base }).configuration, base);
});
for (const kind of ['timer', 'webhook']) {
  test(`${kind} rejects missing or mismatched route discriminator`, () => {
    assert.throws(() => automationConfiguration({ configuration: base }, kind), /source_kind is required/);
    assert.throws(() => automationConfiguration({ source_kind: kind === 'timer' ? 'webhook' : 'timer', configuration: base }, kind), /source_kind must be/);
  });
  test(`${kind} rejects unsupported configuration and spec fields`, () => {
    for (const configuration of [{ ...base, enabled: false }, { ...base, spec: { ...base.spec, priority: 1 } }]) {
      assert.throws(() => automationConfiguration({ source_kind: kind, configuration }, kind), /unsupported/);
    }
  });
}
test('wrong-route fields cannot silently disappear, including legacy calls', () => {
  for (const field of ['schedule_kind', 'cron_expr', 'timezone', 'run_at', 'interval_seconds', 'anchor_at']) {
    assert.throws(() => automationConfiguration({ source_kind: 'webhook', configuration: { ...base, [field]: 'value' } }, 'webhook'), /unsupported/);
    assert.throws(() => automationConfiguration({ ...base, [field]: 'value' }, 'webhook'), /unsupported/);
  }
  assert.throws(() => automationConfiguration({ source_kind: 'timer', configuration: { ...base, event_filter: '' } }, 'timer'), /unsupported/);
});

test('authorization preview keeps final configuration and operation separate', () => {
  const configuration = { ...base, cron_expr: '0 9 * * *' };
  assert.deepEqual(automationAuthorizationPreview({ org: 'org', source_kind: 'timer', operation: 'create', configuration }), {
    source_kind: 'timer', operation: 'create', target_binding_id: '', expected_version: 0, configuration,
  });
  assert.throws(() => automationAuthorizationPreview({ source_kind: 'timer', operation: 'delete', configuration }), /operation/);
});

test('preview rejects ambiguous scope and lossy update versions', () => {
  for (const scope of [
    { operation: 'create', target_binding_id: 'binding' },
    { operation: 'create', expected_version: 1 },
    { operation: 'update' },
    { operation: 'update', target_binding_id: ' ', expected_version: 1 },
    { operation: 'update', target_binding_id: 'binding', expected_version: '1' },
    { operation: 'update', target_binding_id: 'binding', expected_version: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => automationAuthorizationPreview({ source_kind: 'timer', configuration: base, ...scope }), /preview requires/);
  }
});

for (const kind of ['timer', 'webhook']) {
  test(`${kind} updates require both proofs and creates reject partial proof`, () => {
    const params = { id: 'binding', expected_version: 2, source_kind: kind, configuration: base };
    assert.deepEqual(automationMutation(params, kind), base);
    assert.throws(() => automationMutation(params, kind, 'update'), /requires both authorization/);
    for (const proof of [
      { authorization_proposal_message_id: '1790220732844' },
      { authorization_confirmation_message_id: '1790220732845' },
    ]) {
      for (const operation of ['create', 'update']) {
        assert.throws(() => automationMutation({ ...params, ...proof }, kind, operation), /requires both authorization/);
      }
    }
  });
  test(`${kind} authorization proof is transport metadata, never form configuration`, () => {
    const proof = { authorization_proposal_message_id: '1790220732844', authorization_confirmation_message_id: '1790220732845' };
    assert.deepEqual(automationMutation({ source_kind: kind, configuration: base, ...proof }, kind), { ...base, ...proof });
    assert.throws(() => automationMutation({ source_kind: kind, configuration: { ...base, ...proof } }, kind), /unsupported/);
    for (const field of Object.keys(proof)) {
      for (const value of [1790220732844, '001', '', ' ', null, 'fake', '1'.repeat(129)]) {
        for (const operation of ['create', 'update']) {
          assert.throws(() => automationMutation({ id: 'binding', expected_version: 2, source_kind: kind, configuration: base, ...proof, [field]: value }, kind, operation), /canonical decimal/);
        }
      }
    }
  });
  test(`${kind} update preserves expected version and prevents malformed targets`, () => {
    const proof = { authorization_proposal_message_id: '1790220732844', authorization_confirmation_message_id: '1790220732845' };
    assert.equal(automationMutation({ id: 'binding', expected_version: 2, source_kind: kind, configuration: base, ...proof }, kind, 'update').expected_version, 2);
    assert.throws(() => automationMutation({ source_kind: kind, configuration: base, ...proof }, kind, 'update'), /update requires/);
  });
}
