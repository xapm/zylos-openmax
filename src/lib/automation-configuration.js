// Preserve the form's REST fields without forwarding DM envelope metadata.
export function automationConfiguration(params, sourceKind) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  const nested = Object.hasOwn(params, 'configuration');
  if (nested && !Object.hasOwn(params, 'source_kind')) fail('source_kind is required with configuration');
  if (params.source_kind !== undefined && params.source_kind !== sourceKind) {
    fail(`source_kind must be ${sourceKind} for this command`);
  }
  const input = nested ? params.configuration : params;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('configuration must be an object'), { status: 400 });
  }
  const spec = Object.hasOwn(input, 'spec') ? input.spec : {
    project_id: input.projectId,
    title: input.title,
    description: input.description,
  };
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('spec must be an object');
  const body = {
    lead_member_id: input.lead_member_id ?? input.leadMemberId,
    owner_member_id: input.owner_member_id ?? input.ownerMemberId,
    spec: { project_id: spec.project_id, title: spec.title, description: spec.description },
  };
  const fields = sourceKind === 'webhook'
    ? [['event_filter', 'eventFilter']]
    : [['schedule_kind', 'scheduleKind'], ['cron_expr', 'cronExpr'],
      ['timezone', 'timezone'], ['run_at', 'runAt'],
      ['interval_seconds', 'intervalSeconds'], ['anchor_at', 'anchorAt']];
  const allowed = new Set(['lead_member_id', 'owner_member_id', 'spec', ...fields.map(([wire]) => wire)]);
  if (!nested) {
    for (const key of ['org', 'orgId', 'org_id', 'source_kind', 'leadMemberId', 'ownerMemberId',
      'projectId', 'title', 'description', ...fields.map(([, alias]) => alias)]) allowed.add(key);
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail(`unsupported ${sourceKind} configuration field: ${key}`);
  }
  for (const key of Object.keys(spec)) {
    if (!['project_id', 'title', 'description'].includes(key)) fail(`unsupported spec field: ${key}`);
  }
  if (nested) return input;
  for (const [wire, alias] of fields) {
    const value = input[wire] ?? input[alias];
    if (value !== undefined) body[wire] = value;
  }
  return body;
}

export function automationAuthorizationPreview(params) {
  if (!['timer', 'webhook'].includes(params.source_kind)) {
    throw Object.assign(new Error('source_kind must be timer or webhook'), { status: 400 });
  }
  if (!['create', 'update'].includes(params.operation)) {
    throw Object.assign(new Error('operation must be create or update'), { status: 400 });
  }
  const target = params.target_binding_id ?? '';
  const version = params.expected_version ?? 0;
  if (typeof target !== 'string' || !Number.isSafeInteger(version)
    || (params.operation === 'create' && (target !== '' || version !== 0))
    || (params.operation === 'update' && (!target.trim() || version < 1))) {
    throw Object.assign(new Error('preview requires create without a target/version or update with a target and positive expected_version'), { status: 400 });
  }
  return {
    source_kind: params.source_kind,
    operation: params.operation,
    target_binding_id: target,
    expected_version: version,
    configuration: automationConfiguration(params, params.source_kind),
  };
}

export function automationAuthorizationProposal(params) {
  if (typeof params.request_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.request_id)
    || params.request_id === '00000000-0000-0000-0000-000000000000') {
    throw Object.assign(new Error('request_id must be a UUID for this exact proposal revision'), { status: 400 });
  }
  const plan = automationAuthorizationPreview(params);
  if (plan.source_kind === 'timer'
    && (typeof plan.configuration.timezone !== 'string' || !plan.configuration.timezone.trim())) {
    throw Object.assign(new Error('choose an explicit timezone before confirming the schedule'), { status: 400 });
  }
  if (plan.operation === 'create') {
    delete plan.target_binding_id;
    delete plan.expected_version;
  }
  const replacement = params.replaces_proposal_message_id;
  if (replacement !== undefined && (typeof replacement !== 'string'
    || replacement.length > 128 || !/^[1-9][0-9]*$/.test(replacement))) {
    throw Object.assign(new Error('replaces_proposal_message_id must be a canonical decimal message ID string'), { status: 400 });
  }
  return { ...plan, request_id: params.request_id,
    ...(replacement === undefined ? {} : { replaces_proposal_message_id: replacement }) };
}

export function automationMutation(params, sourceKind, operation = 'create') {
  const { authorization_proposal_message_id: proposalID,
    authorization_confirmation_message_id: confirmationID,
    authorization_card_interaction_id: interactionID,
    expected_version: expectedVersion, id, ...configurationParams } = params;
  const body = { ...automationConfiguration(configurationParams, sourceKind) };
  if ((operation === 'update' || proposalID !== undefined || confirmationID !== undefined || interactionID !== undefined)
    && (proposalID === undefined || (confirmationID === undefined) === (interactionID === undefined))) {
    throw Object.assign(new Error(`${operation} requires both authorization_proposal_message_id and exactly one confirmation message or card interaction ID`), { status: 400 });
  }
  if (interactionID !== undefined) {
    if (typeof interactionID !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(interactionID)
      || interactionID === '00000000-0000-0000-0000-000000000000') {
      throw Object.assign(new Error('authorization_card_interaction_id must be a canonical nonzero UUID'), { status: 400 });
    }
    body.authorization_card_interaction_id = interactionID;
  }
  for (const field of ['authorization_proposal_message_id', 'authorization_confirmation_message_id']) {
    if (params[field] !== undefined) {
      if (typeof params[field] !== 'string' || params[field].length > 128 || !/^[1-9][0-9]*$/.test(params[field])) {
        throw Object.assign(new Error(`${field} must be a canonical decimal message ID string`), { status: 400 });
      }
      body[field] = params[field];
    }
  }
  if (operation === 'update') {
    if (typeof id !== 'string' || !id.trim() || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw Object.assign(new Error('update requires id and a positive expected_version'), { status: 400 });
    }
    body.expected_version = expectedVersion;
  }
  return body;
}
