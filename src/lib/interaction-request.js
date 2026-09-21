/**
 * Build the body for `POST /conversations/{id}/interaction-requests`
 * (interaction_type=choice) from the arguments `comm.send_card` accepts.
 *
 * This replaces building a `cws.card.v1` body locally. The agent now states
 * what it wants — a title, a body, the choices — and cws-comm builds the card,
 * which is why nothing here names an operation, a URL, a handler or an option
 * id.
 *
 * 🔴 Option ids are NOT ours to choose any more. cws-comm generates them and
 * returns them in `action_ids`, positionally aligned with the options sent. A
 * caller that used to pass `id` and match on it later is rejected loudly here
 * rather than having that binding silently dropped — losing it would make the
 * answer unreadable at exactly the moment it arrives.
 *
 * 🔴 No length or count caps here, deliberately, and this reverses what
 * buildDisplayCard did. Every such rule already exists in cws-comm — the block
 * allowlist, the option cap, the label length, the duplicate-label check — and
 * restating one locally creates a second ruling point that drifts. The
 * stricter direction is the worse one: a local cap tighter than cws-comm's
 * makes a range the server accepts unreachable, with an error that blames the
 * caller. The cws-core edge made the same call for the same reason.
 */
export class InteractionRequestError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'InteractionRequestError';
    this.field = field;
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InteractionRequestError(field, 'is required and must be a non-empty string');
  }
  return value;
}

/**
 * Normalize one option. Accepts a bare string as shorthand for its label.
 * `text` is accepted as an alias because that is what the old card API called
 * this field — under the old model it was the reply text a settlement matched
 * on, and matching is gone, so the two collapse into one.
 */
function normalizeOption(option, index) {
  const at = `options[${index}]`;
  if (typeof option === 'string') return { label: requireText(option, at) };
  if (!option || typeof option !== 'object') {
    throw new InteractionRequestError(at, 'must be a string or an object');
  }
  if (option.id !== undefined) {
    throw new InteractionRequestError(`${at}.id`, 'cannot be set: cws-comm generates option ids and returns them as action_ids');
  }
  const label = requireText(option.label ?? option.text, `${at}.label`);
  const out = { label };
  if (option.style !== undefined) out.style = String(option.style);
  return out;
}

/** A single text block, the shape `text` collapses into when no blocks are given. */
function textBlock(text) {
  return { type: 'text', text };
}

export function buildChoiceRequest(params = {}) {
  const title = requireText(params.title, 'title');
  // summary is also the plain-text projection clients that cannot render a
  // card fall back to, so it is required rather than derived from the body.
  const summary = requireText(params.summary, 'summary');

  let blocks;
  if (params.blocks !== undefined) {
    if (!Array.isArray(params.blocks) || params.blocks.length === 0) {
      throw new InteractionRequestError('blocks', 'must be a non-empty array');
    }
    blocks = params.blocks;
  } else {
    blocks = [textBlock(params.text === undefined ? summary : requireText(params.text, 'text'))];
  }

  // Options are required now. A zero-button card is not something this path can
  // produce any more — the protocol has no interaction type for it.
  if (!Array.isArray(params.options) || params.options.length === 0) {
    throw new InteractionRequestError('options', 'must be a non-empty array: a choice card without options has no interaction to request');
  }
  const options = params.options.map(normalizeOption);

  const choice = { title, summary, blocks, options };
  if (params.confirm !== undefined) {
    if (!params.confirm || typeof params.confirm !== 'object') {
      throw new InteractionRequestError('confirm', 'must be an object');
    }
    const confirm = { text: requireText(params.confirm.text, 'confirm.text') };
    if (params.confirm.label !== undefined) confirm.label = requireText(params.confirm.label, 'confirm.label');
    choice.confirm = confirm;
  }

  // 🔴 Refuse the send-level arguments the old card path accepted. The new
  // endpoint has no field for either, so passing them through would drop them
  // in silence — and a reply-to that vanishes looks identical to one that was
  // never asked for.
  for (const [key, field] of [['replyTo', 'replyTo'], ['mentions', 'mentions']]) {
    if (params[key] !== undefined) {
      throw new InteractionRequestError(field, 'is not supported by interaction-requests; the endpoint has no field for it');
    }
  }

  const body = { interaction_type: 'choice', choice };
  if (params.clientMsgId !== undefined) body.client_msg_id = requireText(params.clientMsgId, 'clientMsgId');
  return body;
}
