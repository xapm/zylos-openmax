import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual bootstrap function with inert dependencies. Loading the
// complete entrypoint would start the installed service and access credentials.
const entrypoint = readFileSync(new URL('../comm-bridge.js', import.meta.url), 'utf8');
const start = entrypoint.indexOf('function startOrgWs(');
const end = entrypoint.indexOf('\n// =============================================================================\n// Main', start);
assert.ok(start >= 0 && end > start);
const source = entrypoint.slice(start, end);

for (const failure of ['session', 'ws-constructor', 'ws-start', null]) {
  test(`compose starts only after successful synchronous bootstrap (${failure || 'success'})`, () => {
    const org = { org_id: 'org', slug: 'org', self: {} };
    let starts = 0, captured;
    const activeOrgConfigs = new Map(), composeConsumers = [];
    const context = {
      createComposeConsumer: options => { captured = options; return { start() { assert.equal(activeOrgConfigs.get('org'), org); starts++; }, stop() {} }; },
      composeConsumers, activeOrgConfigs, wsClients: [], inboxLedgers: [], liveOrgCount: 0,
      config: {}, DEFAULT_WS_RECONNECT_MAX_MS: 1000, DEFAULT_WS_HEARTBEAT_MS: 1000, DEFAULT_WS_PING_INTERVAL_MS: 1000,
      loadOrgSession() { if (failure === 'session') throw new Error('session'); return {}; },
      createInboxLedger: () => ({ getIdentityChange: () => null, getAckedSeq: () => 0, start() {} }),
      seedSessionFromLedger() {}, saveOrgSession() {}, log() {}, warn() {},
      makeOrgMessageHandler() {}, makeOrgFrameDispatcher() {},
      WsClient: class {
        constructor() { if (failure === 'ws-constructor') throw new Error('ws-constructor'); }
        start() { if (failure === 'ws-start') throw new Error('ws-start'); }
      },
    };
    vm.createContext(context); vm.runInContext(source, context);
    if (failure) assert.throws(() => context.startOrgWs(org, 'ws://test'), new RegExp(failure));
    else context.startOrgWs(org, 'ws://test');
    assert.equal(starts, failure ? 0 : 1); assert.equal(composeConsumers.length, failure ? 0 : 1);
    assert.equal(captured.agentId(), undefined);
    org.self = { member_id: 'hydrated' }; assert.equal(captured.agentId(), 'hydrated');
  });
}
