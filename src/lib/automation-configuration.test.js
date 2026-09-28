import assert from 'node:assert/strict';
import test from 'node:test';
import { automationConfiguration } from './automation-configuration.js';

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
