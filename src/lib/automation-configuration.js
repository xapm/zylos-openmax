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
