import assert from 'node:assert/strict';
import test from 'node:test';
import { automationAuthorizationPreview, automationConfiguration, automationMutation } from './automation-configuration.js';

const base = { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' } };
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
