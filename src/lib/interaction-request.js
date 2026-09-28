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
import { newClientMsgId } from './message.js';

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
/**
 * Keys an option and a confirm may carry. Closed sets, and refused the same way
 * the top-level params are.
 *
 * 🔴 The top-level whitelist stops at the top level, and every failure it
 * exists to prevent is just as reachable one level down. `{"label":"清空",
 * "confirm_text":"确定?"}` builds, sends and renders — with no second step and
 * no word about the key that was dropped, and that key was the one standing in
 * front of an irreversible action. `stye` for `style` costs the card its
 * primary button just as quietly. A misspelled key inside an option is not a
 * smaller version of the top-level bug; for `confirm` it is the more expensive
 * one.
 *
 * Whitelists for the same reason as above: the key that needs refusing is the
 * one nobody thought of.
 */
const OPTION_KEYS = new Set(['label', 'text', 'style', 'confirm']);
const CONFIRM_KEYS = new Set(['text', 'label']);

function rejectUnknownKeys(obj, allowed, path, carries) {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) continue;
    throw new InteractionRequestError(`${path}.${key}`, `is not supported here; ${carries}`);
  }
}

/**
 * Normalize a confirm into `{text, label?}`. One expression, used for both the
 * card-level confirm and an option's own, so the two cannot drift into slightly
 * different shapes for the same thing.
 */
function normalizeConfirm(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InteractionRequestError(path, 'must be an object');
  }
  rejectUnknownKeys(value, CONFIRM_KEYS, path, 'a confirm carries `text` and an optional `label`');
  const confirm = { text: requireText(value.text, `${path}.text`) };
  if (value.label !== undefined) confirm.label = requireText(value.label, `${path}.label`);
  return confirm;
}

function normalizeOption(option, index) {
  const at = `options[${index}]`;
  if (typeof option === 'string') return { label: requireText(option, at) };
  if (!option || typeof option !== 'object') {
    throw new InteractionRequestError(at, 'must be a string or an object');
  }
  if (option.id !== undefined) {
    throw new InteractionRequestError(`${at}.id`, 'cannot be set: cws-comm generates option ids and returns them as action_ids');
  }
  rejectUnknownKeys(option, OPTION_KEYS, at, 'an option carries `label` (or the `text` alias), `style` and `confirm`');
  const label = requireText(option.label ?? option.text, `${at}.label`);
  const out = { label };
  if (option.style !== undefined) out.style = String(option.style);
  // An option's own confirm overrides the card-level one for this option only.
  // Omitting it means "inherit the card's", NOT "ask nothing" — the card-level
  // confirm is applied to every option that declares none.
  //
  // It exists because the card-level one is applied uniformly, and a card that
  // mixes a destructive choice with a safe one then puts the destructive
  // wording on the safe button too: "leave it running" ends up asking the
  // reader to confirm that the service will go down.
  if (option.confirm !== undefined) out.confirm = normalizeConfirm(option.confirm, `${at}.confirm`);
  return out;
}

/** A single text block, the shape `text` collapses into when no blocks are given. */
function textBlock(text) {
  return { type: 'text', text };
}

/**
 * Every top-level key this builder knows.
 *
 * 🔴 It is a WHITELIST, not a deny-list, because the builder constructs its
 * result from scratch: a key it does not name is neither used nor reported, so
 * a caller that passes one gets a card that sends successfully and is missing
 * what they asked for. That happened — an upgrade card carried a top-level
 * `fields` with one row per component, and what arrived had the prose body and
 * nothing else. A deny-list cannot catch that, because the key you need to deny
 * is the one nobody thought of.
 *
 * `conversationId` and the org-routing keys are here because they are NOT card
 * fields: `comm.send_card` hands its whole parsed params object to this
 * function, so the CLI's own arguments arrive alongside the card's. Dropping
 * them from this set would reject every real call.
 *
 * One flat set covers both callers because `comm.ask_card` strips its own three
 * arguments (`kind`, `askedOf`, `meta`) before calling — and must keep doing so.
 * `kind` in particular means something different to each verb, and this builder
 * has to keep refusing it: the old card API's `kind` has no field on the
 * interaction-requests endpoint. If a future verb needs to pass an argument
 * through instead of stripping it, split this into a per-caller set rather than
 * widening the shared one, or the widened key becomes silently droppable again
 * for the other verb.
 */
const KNOWN_PARAMS = new Set([
  // card fields
  'title', 'summary', 'text', 'blocks', 'options', 'confirm', 'clientMsgId',
  // CLI arguments that ride along on the same params object
  'conversationId', 'org', 'orgSlug', 'orgId', 'org_id',
]);

/**
 * cws-comm's block vocabulary, used ONLY to phrase the error when one of these
 * names shows up as a TOP-LEVEL key — `fields` is where this whole class of bug
 * was found, and naming the right destination is the difference between an
 * error a caller can act on and one they have to go read source for.
 *
 * Nothing here validates a block. The block rules stay cws-comm's (see the
 * no-local-caps note at the top of this file); if the server adds a type and
 * this list lags, the only cost is a slightly less specific error message, and
 * that type still sends fine inside `blocks`.
 */
const BLOCK_TYPES = new Set([
  'text', 'markdown', 'fields', 'divider', 'image', 'quote', 'artifact_list',
]);

function rejectUnknownParams(params) {
  for (const key of Object.keys(params)) {
    if (KNOWN_PARAMS.has(key)) continue;
    const hint = BLOCK_TYPES.has(key)
      ? ` — \`${key}\` is a BLOCK type, not a top-level field: pass it inside \`blocks\`, `
        + `e.g. {"blocks":[{"type":"text","text":"…"},{"type":"${key}", …}]}`
      : '';
    throw new InteractionRequestError(
      key,
      `is not supported by interaction-requests; the endpoint has no field for it${hint}`,
    );
  }
}

export function buildChoiceRequest(params = {}) {
  // First, before any field is read: an unknown key is a caller who thinks they
  // sent something. Report it instead of building a card without it. Running
  // this ahead of the required-field checks means the report names the key they
  // got wrong, not the field they merely also omitted.
  rejectUnknownParams(params);

  const title = requireText(params.title, 'title');
  // summary is the one-line projection shown beside the title, and the text a
  // client that cannot render the card falls back to. It is required, and it is
  // NOT the card body — see the blocks check below.
  const summary = requireText(params.summary, 'summary');

  // 🔴 The body is not defaulted from `summary`. It used to be, and the card
  // then rendered the same sentence twice — once in the header beside the
  // title, once as the body — because both fields reach the client and neither
  // knows the other repeated it. A convenience default that produces a visibly
  // wrong card is worse than asking the caller for one more field.
  let blocks;
  if (params.blocks !== undefined) {
    // 🔴 Refused, not resolved by precedence. Letting `blocks` win silently is
    // the one silent drop this builder had left: a caller who passed both loses
    // the `text` paragraph without a word, which is exactly what the whitelist
    // above exists to stop. Both documents already tell callers to pass one or
    // the other, so refusing cannot break a caller who was following them.
    if (params.text !== undefined) {
      throw new InteractionRequestError(
        'text',
        'cannot be combined with `blocks`: `text` is shorthand for a single text block, so passing both means one of the two is not being shown — send the paragraph as the first entry of `blocks` instead',
      );
    }
    if (!Array.isArray(params.blocks) || params.blocks.length === 0) {
      throw new InteractionRequestError('blocks', 'must be a non-empty array');
    }
    blocks = params.blocks;
  } else if (params.text !== undefined) {
    blocks = [textBlock(requireText(params.text, 'text'))];
  } else {
    throw new InteractionRequestError('text', 'is required (or pass `blocks`): the card body is not derived from `summary`, which the client already shows beside the title');
  }

  // Options are required now. A zero-button card is not something this path can
  // produce any more — the protocol has no interaction type for it.
  if (!Array.isArray(params.options) || params.options.length === 0) {
    throw new InteractionRequestError('options', 'must be a non-empty array: a choice card without options has no interaction to request');
  }
  const options = params.options.map(normalizeOption);

  const choice = { title, summary, blocks, options };
  if (params.confirm !== undefined) {
    choice.confirm = normalizeConfirm(params.confirm, 'confirm');
  }

  // Always send a key, because the old card path did and a body without one
  // cannot be de-duplicated at all. Be precise about what the generated one
  // buys: the server de-dupes an IDENTICAL key for five minutes, and a fresh
  // uuid per call is identical only within the call that made it. So it covers
  // a retry of the same request object — nothing more.
  //
  // 🔴 It does NOT make a re-invocation safe. If the first request reached the
  // server and only the response was lost, running the same command again mints
  // a new key and posts a SECOND card: two sets of action ids, two receipts, two
  // answers to reconcile, on the one channel whose job is authorizing
  // irreversible things. A caller that wants to survive that has to keep its own
  // `clientMsgId` and pass the same one back.
  const body = { interaction_type: 'choice', choice };
  body.client_msg_id = params.clientMsgId === undefined
    ? newClientMsgId()
    : requireText(params.clientMsgId, 'clientMsgId');
  return body;
}
