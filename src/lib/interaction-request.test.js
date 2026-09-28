import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChoiceRequest, InteractionRequestError } from './interaction-request.js';

const base = {
  conversationId: 'c1',
  title: 'Upgrade?',
  summary: '3 components can be upgraded',
  text: 'dashboard 0.5.4 and lark 0.3.11 both have newer releases.',
};

test('builds the choice shape the endpoint declares', () => {
  const body = buildChoiceRequest({ ...base, text: 'Upgrade all three?', options: ['Yes', 'No'] });
  assert.equal(body.interaction_type, 'choice');
  assert.equal(body.choice.title, 'Upgrade?');
  assert.equal(body.choice.summary, '3 components can be upgraded');
  assert.deepEqual(body.choice.blocks, [{ type: 'text', text: 'Upgrade all three?' }]);
  assert.deepEqual(body.choice.options, [{ label: 'Yes' }, { label: 'No' }]);
});

test('🔴 the body is never derived from summary, because the client shows both', () => {
  // Defaulting the body to the summary rendered the same sentence twice in the
  // card — once beside the title, once as the body.
  const { text, ...noBody } = base;
  assert.throws(
    () => buildChoiceRequest({ ...noBody, options: ['Yes'] }),
    (e) => e instanceof InteractionRequestError && e.field === 'text',
  );
  const withText = buildChoiceRequest({ ...base, text: 'body says something else', options: ['Yes'] });
  assert.deepEqual(withText.choice.blocks, [{ type: 'text', text: 'body says something else' }]);
  assert.notEqual(withText.choice.blocks[0].text, withText.choice.summary);
});

test('🔴 passing both `text` and `blocks` is refused, not resolved by precedence', () => {
  // This used to let `blocks` win and drop `text` silently — the last silent
  // drop left at the top level, and the caller who passed both is precisely the
  // one who believes both are being shown.
  const err = refusal(() => buildChoiceRequest({
    ...base,
    text: 'a paragraph the caller expects to see',
    blocks: [{ type: 'markdown', text: '- a\n- b' }, { type: 'divider' }],
    options: ['Yes'],
  }));
  assert.equal(err.field, 'text');
  assert.match(err.message, /blocks/);
});

test('blocks alone still pass through untouched', () => {
  // The control for the refusal above: it must fire on the combination, not on
  // `blocks` itself.
  const { text, ...noText } = base;
  const explicit = buildChoiceRequest({
    ...noText,
    blocks: [{ type: 'markdown', text: '- a\n- b' }, { type: 'divider' }],
    options: ['Yes'],
  });
  assert.equal(explicit.choice.blocks.length, 2);
  assert.equal(explicit.choice.blocks[0].type, 'markdown');
});

test('🔴 an option id is refused, not dropped', () => {
  // Silently dropping it would leave the caller matching the answer against an
  // id the server never saw.
  assert.throws(
    () => buildChoiceRequest({ ...base, options: [{ label: 'Yes', id: 'yes' }] }),
    (e) => e instanceof InteractionRequestError && e.field === 'options[0].id',
  );
});

test('option accepts a bare string, `label`, or the old `text` alias', () => {
  const body = buildChoiceRequest({
    ...base,
    options: ['A', { label: 'B', style: 'primary' }, { text: 'C' }],
  });
  assert.deepEqual(body.choice.options, [
    { label: 'A' }, { label: 'B', style: 'primary' }, { label: 'C' },
  ]);
});

test('🔴 a card with no options is refused — that shape no longer exists', () => {
  for (const options of [undefined, []]) {
    assert.throws(
      () => buildChoiceRequest({ ...base, options }),
      (e) => e instanceof InteractionRequestError && e.field === 'options',
    );
  }
});

test('🔴 replyTo and mentions are refused rather than silently lost', () => {
  // The endpoint has no field for either; a reply-to that vanishes looks
  // exactly like one that was never asked for.
  assert.throws(
    () => buildChoiceRequest({ ...base, options: ['Yes'], replyTo: '123' }),
    (e) => e.field === 'replyTo',
  );
  assert.throws(
    () => buildChoiceRequest({ ...base, options: ['Yes'], mentions: [{ member_id: 'm' }] }),
    (e) => e.field === 'mentions',
  );
});

test('title and summary are both required', () => {
  assert.throws(() => buildChoiceRequest({ summary: 's', options: ['Y'] }), (e) => e.field === 'title');
  assert.throws(() => buildChoiceRequest({ title: 't', options: ['Y'] }), (e) => e.field === 'summary');
});

test('confirm is passed through when given, and validated when malformed', () => {
  const body = buildChoiceRequest({ ...base, options: ['Yes'], confirm: { text: 'Sure?', label: 'Do it' } });
  assert.deepEqual(body.choice.confirm, { text: 'Sure?', label: 'Do it' });
  assert.throws(() => buildChoiceRequest({ ...base, options: ['Y'], confirm: {} }), (e) => e.field === 'confirm.text');
});

test('a key is always sent, and an identical one only comes from the caller', () => {
  // The generated key de-dupes a retry of the same request object. Two calls
  // are two keys, so re-running after a lost response posts a second card —
  // surviving that is the caller's job, by keeping and resending its own id.
  const a = buildChoiceRequest({ ...base, options: ['Y'] });
  const b = buildChoiceRequest({ ...base, options: ['Y'] });
  assert.match(a.client_msg_id, /^c_/);
  assert.notEqual(a.client_msg_id, b.client_msg_id);
  const k1 = buildChoiceRequest({ ...base, options: ['Y'], clientMsgId: 'k1' });
  const k2 = buildChoiceRequest({ ...base, options: ['Y'], clientMsgId: 'k1' });
  assert.equal(k1.client_msg_id, 'k1');
  assert.equal(k2.client_msg_id, 'k1');
});

test('🔴 no local length or count caps — cws-comm holds those rules', () => {
  // A local cap tighter than the server's would make a range the server accepts
  // unreachable, with an error blaming the caller. Six options and a very long
  // label must reach the wire; the server decides.
  const body = buildChoiceRequest({
    ...base,
    options: ['a', 'b', 'c', 'd', 'e', 'f'.repeat(200)],
  });
  assert.equal(body.choice.options.length, 6);
  assert.equal(body.choice.options[5].label.length, 200);
});

test('🔴 kind and fallbackText are refused, not ignored', () => {
  // Both were arguments of the old card verb. Ignoring an unknown key is the
  // same silent drop replyTo and mentions are refused for.
  for (const field of ['kind', 'fallbackText']) {
    assert.throws(
      () => buildChoiceRequest({ ...base, options: ['Y'], [field]: 'x' }),
      (e) => e instanceof InteractionRequestError && e.field === field,
      field,
    );
  }
});

test('🔴 a question-level argument named like a card field must not reach the builder', () => {
  // `comm.ask_card` takes its own `kind` (what the question is for) while the
  // old card API used `kind` for something else, and the builder refuses it.
  // Passing the verb's arguments straight through made that verb throw on its
  // own required argument — every call, before any request went out.
  assert.throws(
    () => buildChoiceRequest({ ...base, options: ['Y'], kind: 'component-upgrade' }),
    (e) => e instanceof InteractionRequestError && e.field === 'kind',
  );
  const { kind, askedOf, meta, ...cardParams } = {
    ...base, options: ['Y'], kind: 'component-upgrade', askedOf: 'm1', meta: { v: 1 },
  };
  const body = buildChoiceRequest(cardParams);
  assert.equal(body.interaction_type, 'choice');
  assert.equal('kind' in body.choice, false);
  assert.equal('askedOf' in body.choice, false);
  assert.equal('meta' in body.choice, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-option confirm (cws-comm !521)
//
// The card-level confirm is applied to EVERY option, so a card mixing a
// destructive choice with a safe one put the destructive wording on the safe
// button too. An option may now carry its own.
// ─────────────────────────────────────────────────────────────────────────────

test("🔴 an option's own confirm reaches the body instead of being dropped", () => {
  // This is the anti-silent-drop cell. `normalizeOption` builds its result from
  // scratch, so any key it does not name is discarded WITHOUT an error — the
  // card still sends and the caller sees nothing wrong. That failure mode is
  // the reason this assertion exists.
  const body = buildChoiceRequest({
    ...base,
    options: [{ label: 'Stop it', style: 'danger', confirm: { text: 'The channel goes offline' } }],
  });
  assert.deepEqual(body.choice.options, [
    { label: 'Stop it', style: 'danger', confirm: { text: 'The channel goes offline' } },
  ]);
});

test('a mixed card leaves the safe option with no confirm at all', () => {
  const body = buildChoiceRequest({
    ...base,
    options: [
      { label: 'Stop lark', style: 'danger', confirm: { text: 'Webhooks stop being handled', label: 'Stop it' } },
      { label: 'Leave it, I will fix the credentials' },
    ],
  });
  assert.deepEqual(body.choice.options, [
    {
      label: 'Stop lark',
      style: 'danger',
      confirm: { text: 'Webhooks stop being handled', label: 'Stop it' },
    },
    // No `confirm` key: absent means "inherit the card's", and this card sets
    // none. Emitting an empty one here would make "inherits" and "asks nothing"
    // indistinguishable on the wire.
    { label: 'Leave it, I will fix the credentials' },
  ]);
});

test('an option without a confirm gains no confirm key, so inheritance stays expressible', () => {
  const body = buildChoiceRequest({
    ...base,
    options: ['Yes', 'No'],
    confirm: { text: 'Are you sure?' },
  });
  // The card-level confirm is NOT copied onto the options here — cws-comm does
  // that. Copying it on this side would hard-code today's fan-out and defeat
  // the per-option override.
  assert.deepEqual(body.choice.options, [{ label: 'Yes' }, { label: 'No' }]);
  assert.deepEqual(body.choice.confirm, { text: 'Are you sure?' });
});

test("an option's confirm is validated like the card-level one, naming the option", () => {
  assert.throws(
    () => buildChoiceRequest({ ...base, options: [{ label: 'Go', confirm: { label: 'only a label' } }] }),
    (err) => err instanceof InteractionRequestError && err.field === 'options[0].confirm.text',
  );
  assert.throws(
    () => buildChoiceRequest({ ...base, options: [{ label: 'Go', confirm: 'not an object' }] }),
    (err) => err instanceof InteractionRequestError && err.field === 'options[0].confirm',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Unknown top-level keys
//
// The builder constructs its result from scratch, so a key it does not name is
// neither used nor reported. The deny-list that used to guard this could only
// name keys somebody had already thought of — and the one that cost a card its
// content was `fields`, which nobody had.
// ─────────────────────────────────────────────────────────────────────────────

/** The thrown InteractionRequestError, so a test can read its message. */
function refusal(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return assert.fail('expected buildChoiceRequest to refuse, but it returned a body');
}

test('🔴 a top-level `fields` is refused and told where it belongs, not dropped', () => {
  // The real failure: an upgrade card passed one row per component as top-level
  // `fields`. The request went out with the prose body and nothing else, the
  // reader saw no versions, and NOTHING reported a problem.
  const err = refusal(() => buildChoiceRequest({
    ...base,
    options: ['Yes'],
    fields: [{ label: 'core', value: '0.7.1 → 0.8.1' }],
  }));
  assert.ok(err instanceof InteractionRequestError);
  assert.equal(err.field, 'fields');
  // Naming the key is not enough to act on — the message has to say where it
  // goes, or the caller reads source to find out.
  assert.match(err.message, /blocks/);
  assert.match(err.message, /"type":"fields"/);
});

test('every block type refused at the top level names `blocks` as its destination', () => {
  for (const type of ['markdown', 'divider', 'image', 'quote', 'artifact_list']) {
    const err = refusal(() => buildChoiceRequest({ ...base, options: ['Yes'], [type]: 'x' }));
    assert.equal(err.field, type);
    assert.match(err.message, new RegExp(`"type":"${type}"`), type);
  }
});

test('an unknown key that is not a block type is still refused, without the block hint', () => {
  const err = refusal(() => buildChoiceRequest({ ...base, options: ['Yes'], urgency: 'high' }));
  assert.ok(err instanceof InteractionRequestError);
  assert.equal(err.field, 'urgency');
  assert.doesNotMatch(err.message, /BLOCK type/);
});

test('an unknown key is reported before a missing required one', () => {
  // The caller who mistyped a key has a key to fix; leading with `title` would
  // send them after a field they merely also omitted.
  assert.throws(
    () => buildChoiceRequest({ conversationId: 'c1', fields: [] }),
    (e) => e.field === 'fields',
  );
});

test('🔴 the CLI arguments that ride along on the same params object still pass', () => {
  // `comm.send_card` hands its WHOLE parsed params object to the builder, so
  // conversationId and the org-routing keys arrive here. Rejecting them would
  // break every real call — this is the cell that catches a whitelist written
  // from the card schema alone.
  for (const routing of [{}, { org: 'acme' }, { orgSlug: 'acme' }, { orgId: 'o-1' }, { org_id: 'o-1' }]) {
    const body = buildChoiceRequest({ ...base, options: ['Yes'], ...routing });
    assert.equal(body.interaction_type, 'choice');
    // Routing is not card content: it must not leak into the request body.
    for (const key of Object.keys(routing)) assert.equal(key in body.choice, false, key);
  }
  assert.equal('conversationId' in buildChoiceRequest({ ...base, options: ['Y'] }).choice, false);
});

test('🔴 comm.ask_card is not caught by the whitelist — it strips its own arguments first', () => {
  // ask_card's legitimate arguments differ from send_card's. It removes them
  // before calling, and the whitelist must not be what forces that: this asserts
  // the verb's real call shape builds, AND that the arguments would otherwise be
  // refused — so a future edit that stops stripping them fails loudly here
  // rather than dropping a question's `kind` on the floor.
  const askParams = {
    ...base, options: ['Yes'], kind: 'component-upgrade', askedOf: 'm-1', meta: { v: 1 },
  };
  const { kind, askedOf, meta, ...cardParams } = askParams;
  const body = buildChoiceRequest(cardParams);
  assert.equal(body.interaction_type, 'choice');
  for (const field of ['kind', 'askedOf', 'meta']) {
    assert.throws(
      () => buildChoiceRequest({ ...cardParams, [field]: askParams[field] }),
      (e) => e instanceof InteractionRequestError && e.field === field,
      field,
    );
  }
});

test('🔴 a fields block inside `blocks` reaches the request body untouched', () => {
  // The other half of the fix: refusing the misplaced key is only useful if the
  // documented destination actually works. Blocks are passed through verbatim —
  // cws-comm owns the block vocabulary — so this pins that nothing local
  // reshapes, reorders or filters them.
  const blocks = [
    { type: 'text', text: '确认升级以下组件?' },
    {
      type: 'fields',
      items: [
        { label: 'core', value: '0.7.1 → 0.8.1' },
        { label: 'openmax', value: '2.20.0 → 2.21.0' },
      ],
    },
  ];
  const { text, ...noText } = base;
  const body = buildChoiceRequest({ ...noText, blocks, options: ['Yes', 'No'] });
  assert.deepEqual(body.choice.blocks, blocks);
});

test('🔴 an unknown key inside an option is refused, not dropped', () => {
  // The top-level whitelist stopped at the top level. One level down the same
  // silent drop was still reachable, and `confirm` is the field it costs most:
  // a misspelled one removes the second step in front of an irreversible act
  // and says nothing.
  const err = refusal(() => buildChoiceRequest({
    ...base,
    options: [{ label: '清空', confirm_text: '确定?' }],
  }));
  assert.equal(err.field, 'options[0].confirm_text');
  assert.match(err.message, /confirm/);
});

test('a misspelled `style` is refused rather than quietly rendering secondary', () => {
  const err = refusal(() => buildChoiceRequest({
    ...base,
    options: [{ label: '升级', stye: 'primary' }],
  }));
  assert.equal(err.field, 'options[0].stye');
});

test('🔴 an unknown key inside a confirm is refused, at both levels it can appear', () => {
  const card = refusal(() => buildChoiceRequest({
    ...base,
    options: ['Yes'],
    confirm: { text: '会重启服务', buttonLabel: '确认' },
  }));
  assert.equal(card.field, 'confirm.buttonLabel');

  const perOption = refusal(() => buildChoiceRequest({
    ...base,
    options: [{ label: '停服', confirm: { text: '会中断', labe: '确认' } }],
  }));
  assert.equal(perOption.field, 'options[0].confirm.labe');
});

test('every key an option and a confirm DO accept still builds', () => {
  // The negative control for the three refusals above: a whitelist that refused
  // a legitimate key would fail exactly the callers it exists to protect, and
  // the refusal tests alone cannot tell the two apart.
  const body = buildChoiceRequest({
    ...base,
    options: [
      { label: '停服', style: 'danger', confirm: { text: '会中断 5 分钟', label: '确认停服' } },
      { text: '先不停' },
    ],
    confirm: { text: '卡片级', label: '继续' },
  });
  assert.deepEqual(body.choice.options, [
    { label: '停服', style: 'danger', confirm: { text: '会中断 5 分钟', label: '确认停服' } },
    { label: '先不停' },
  ]);
  assert.deepEqual(body.choice.confirm, { text: '卡片级', label: '继续' });
});
