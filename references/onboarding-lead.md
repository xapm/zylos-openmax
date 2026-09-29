# Onboarding Lead Reference (guide cards, sent by you)

CLI: `node src/cli/core.js <command> '<json>'` (session / preset / events), `node src/cli/comm.js` (DM), card send = see PLACEHOLDERS below

## Purpose

Walk a new Agent's owner through their first minutes with you: a self-introduction + 3 task cards, the first real task done in the DM, then at most one IM card (plus one second push) and one teammate card. **You decide when each card is due and you send it; cws-core only wakes you, keeps the records and serves the data; the cards themselves (types, rendering, click handling, click results) belong to cws-comm.**

## When to load this document

- A system message (scheduler / 调度中心 DM) whose text contains `ref: event=onboarding.start` — the onboarding wake.
- A message from your owner in the owner ↔ you DM while `core.onboarding_session` returns a record for you that is not finished, including after a restart.
- An onboarding card click result (see "都不用").

## Out of scope

- Defining, rendering or repairing cards, and handling clicks — cws-comm's. Never imitate a card with text or with `comm.send_card` / `comm.ask_card` / `[CARD]` (those only produce `interaction.choice` cards).
- Issue / Project / Blueprint work — onboarding creates none (see "First task").
- `d7_first_delivery` — server-side only; never self-report it, never accept anything on the user's behalf.

## Prerequisites

`core.onboarding_session {}` returns **your own** onboarding record. 404 → you have no onboarding (e.g. an Agent created without a preset role): handle every message normally and stop reading here. Fields used below:

| Field | Meaning |
| --- | --- |
| `owner_member_id` | The person being onboarded; the DM is `comm.create_dm {participantId: owner_member_id}` (idempotent) |
| `role_key` / `role_custom` | Your preset role; `role_custom` = the 「其它」 free text (only with `role_key:"assistant"`) |
| `industry` | Org industry key (only the `ops` role uses it) |
| `user_has_im_channel` | `true` when the **owner** (the user, across all their Agents) has any IM channel connected. <<USER_HAS_IM_CHANNEL: field pending cws-core plan-B session response>> |
| `events` | Push events already recorded for you / your owner / your org — **the only source of "already sent / already declined"**. <<SESSION_EVENTS_FIELD: exact field name and shape pending cws-core plan-B session response>> |

## PLACEHOLDERS (pending cws-comm, do not guess an API)

- `<<CARD_SEND: pending cws-comm onboarding card type>>` — the entry you use to send an onboarding card into the owner DM. Three card kinds: **task cards** (self-intro + 3 task buttons, button label = task title), **IM card** (common channels + 「都不用」, with a `trigger` of `first` / `second`), **teammate card** (one button 「加入一位搭档」). Until it exists you cannot send cards: do nothing card-related and do not report the event.
- `<<CARD_CALLBACK: pending cws-comm onboarding click-result callback>>` — how a click that sends no message (the IM card's 「都不用」) reaches you.

## Flow

### 1. Wake → self-introduction + 3 task cards

1. `core.onboarding_session {}` (404 → stop). `events` already has `task_cards_sent` → the opening is done; never send it again (restart recovery).
2. `core.onboarding_preset {role: <role_key or "assistant">, industry: <industry>}` → `cards` (3, each `id` / `title` / `prompt`, plus `title_en` / `prompt_en`), `person`, `role_label`. Use the English fields when the owner uses English and they are present. Cards are picked by role; only `ops` (运营) also uses the industry (empty / other → the 「其他」 set); a missing `role_key` falls back to `assistant` (通用) — the server applies the same fallbacks, never pick cards yourself.
3. Write **one short self-introduction** in your own voice: who you are (`person` / your display name) and what you can take off their plate as a `role_label` (use `role_custom` when present). The DM is empty — nobody has greeted the user; do not say "the platform already welcomed you".
4. Send it with the 3 task cards: <<CARD_SEND: pending cws-comm onboarding card type>> (task cards, into the owner DM).
5. `core.onboarding_event {eventType:"task_cards_sent", meta:{card_ids:[…]}}`.

The wake message itself lives in a read-only system DM — never reply there. **No interview**: do not ask for their name, company, responsibilities or goals.

### 2. The owner's messages in the DM

- **First message from the owner** (a card click counts) → `core.onboarding_event {eventType:"d1_activation"}` (idempotent, no need to query first).
- **A task-card click** arrives as an ordinary message **from the owner** whose text is that card's full prompt. It is their **first task**: do it now and deliver the result in the DM.
- **A typed message** → classify it normally: a work request becomes the first task; chat or a question gets a normal answer — do not force it into a task.
- **First task** → executed **directly in the DM**. No New-Issue intake, no Project / Issue / Blueprint — unless the owner explicitly asks for one, then the normal intake applies. Resource authorization, credentials and high-risk approvals still apply.
- **After delivering** a task, stop: deliverables go to the KnowledgeBase through the existing flow, and you **do not ask follow-up questions or suggest next steps**. Onboarding does not include setting up groups, a feature tour, or inviting members — do not offer them.
- What you learn along the way (how to address them, role, preferences) goes into that user's profile in your memory. Learn it from the work; never ask for it.

### 3. When a card is due

**Before sending any card, re-read `core.onboarding_session` and check `events`** — a decline or a teammate card may have been recorded from another Agent of the same owner / org. Report the event right after the send succeeds (it marks the card as shown). A report that comes back `recorded:false` means it was already recorded: fine, do not send again.

| Card | When | Due only if (all must hold) | Then report |
| --- | --- | --- | --- |
| IM card, first push (`trigger:first`) | the moment the **first task starts** executing (send it, then carry on with the task) | `user_has_im_channel` is `false` · `events` has neither `im_card_sent` nor `im_card_declined` | `im_card_sent` |
| IM card, second push (`trigger:second`) | after your reply, once the DM has **≥ 20** messages | `user_has_im_channel` is still `false` · `events` has neither `im_card_declined` (user-level) nor `im_card_second_sent` | `im_card_second_sent` |
| Teammate card | after your reply, once the DM has **≥ 50** messages | the org still has exactly **1** Agent (`core.member_list {kind:"agent"}`) · the owner is an org admin (`core.member_get {memberId: owner_member_id}` → `role.slug` is `org-owner` or `org-admin`) · `events` has no `partner_card_sent` (once per org) | `partner_card_sent` |

- **IM connected** = `user_has_im_channel` only (user-level, not per Agent). Never infer it from your own channels or from history.
- **Message count** = cumulative messages in the owner DM, human + Agent, no time window, from `comm.get_messages {conversationId, limit:50}`. An approximation is fine (±1–2); check it only while one of the last two rows is still due, and stop counting once both are recorded.
- **IM channel order follows your own timezone** — not the user's IP, not the deployment edition. Your timezone: `TZ` in your environment, else the `TZ=` line of `~/zylos/.env`; unset counts as `UTC`. `Asia/Shanghai` or `Asia/Urumqi` → the **CN order**; anything else, `UTC` included → the **international order**. Fetch that order's list with `core.onboarding_profile_options` → `im_channels` <<IM_ORDER_SELECT: pending cws-core — profile-options returns one list today, picked by edition / edge geo header; needs a way to request the CN or international order explicitly>>. Pass the list as given; never reorder, drop or add channels yourself. The button layout (how many channels, 「都不用」) is the card type's: <<CARD_SEND: pending cws-comm onboarding card type>>.
- Send with <<CARD_SEND: pending cws-comm onboarding card type>> (IM card with its trigger / teammate card), then `core.onboarding_event {eventType:"<event>"}`.

### 4. Card clicks

| What arrives | Do |
| --- | --- |
| 「我要接{渠道}」 / "I'd like to connect {channel}" from the owner | Feishu / Lark / DingTalk / WeCom → the in-chat connect flow (`references/channel-operations.md`, `channel.connect` with this message's `<message-context>`); on success `core.onboarding_event {eventType:"d3_im_connected"}`. Any other channel → give the link to your Agent page: `core.frontend_url {path:"/agents?id=<your member id>"}`. Do not invent another mechanism. |
| 「都不用」 click result via <<CARD_CALLBACK: pending cws-comm onboarding click-result callback>> | `core.onboarding_event {eventType:"im_card_declined"}` (applies to every Agent of this owner). Acknowledge in one short line at most — nothing if you are mid-task — and **never bring IM up again** unless the owner does. |
| Teammate card click | Nothing reaches you (it opens the "add Agent" dialog in the web app). If the owner asks, help them add a teammate. |

## Events you report

`core.onboarding_event {eventType, meta?}` — idempotent, once-only enforced server-side.

| eventType | Scope | When |
| --- | --- | --- |
| `d1_activation` | this onboarding | owner's first message in the DM |
| `task_cards_sent` | this Agent | after the opening self-intro + task cards are sent |
| `im_card_sent` | this Agent (condition is user-level) | after the IM card first push |
| `im_card_second_sent` | this Agent (condition is user-level) | after the IM card second push |
| `im_card_declined` | the owner (all their Agents) | after the 「都不用」 click result |
| `partner_card_sent` | the org | when the teammate card is sent (= shown) |
| `d3_im_connected` | this onboarding | after an IM channel is connected |
