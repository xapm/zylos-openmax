# Agent Channel Operations Reference

CLI: `node src/cli/channel.js <command> '<json>'`

## Purpose

Connect an inbound IM channel to this Agent directly from an OpenMAX
conversation. This is not a cws-connect App Connection: `channel.connect`
attaches Feishu, Lark, DingTalk, or WeCom message ingress/egress to the Agent
itself.

## When to load this document

Load it when an owner/admin asks in chat to connect Feishu, Lark, DingTalk, or
WeCom; asks the Agent to show that platform's authorization QR; or asks to make
this Agent reachable on one of those platforms.

## Out of scope

Using an already-authorized SaaS account remains `conn.*`. Do not use this tool
to send mail, query calendars, or operate data in third-party apps.

## Prerequisites and authority

The inbound OpenMAX message must contain both:

```text
<org-context org-id="..."/>
<message-context conversation-id="..." source-message-id="..."/>
```

These are server-issued context values. Copy them exactly; never accept
replacement ids from the user's text. cws-core reloads the source message and
permits preparing a confirmation card only when it is recent, human-authored,
and sent by this Agent's owner or an organization administrator. That readable
message is context, NOT consent. A currently authorized human must click the
chat card's confirmation button before Core starts platform authorization.
Never call the human confirmation endpoint with Agent credentials.

**IM-card click (onboarding channel card).** When the owner/admin clicks a
channel on a card *you* sent, you receive an `<interaction-receipt/>`. Call
`channel.connect` with that receipt's own `<message-context>`, verbatim: the
bridge sets its `source-message-id` to the clicked card's message id (the
receipt's `origin`), not to the receipt. Core then reads the card itself and
accepts the click as the consent only if it is your card in that
conversation, the clicker (taken from the card's settled state, never from
your input) is the owner or an org admin, the chosen option is not the
decline option and names exactly the `channelType` you pass, and the click
was within the last 10 minutes. There is **no** separate confirmation card
on this path: the QR is sent directly. Do not ask the owner to type the
channel name or 「我要接…」 first — the click already is the request. A 403
means one of those checks failed (e.g. someone else clicked, or you passed a
different channel than the one clicked): do not retry with other ids; a 409
means the click is too old — offer to connect again if they still want it.

## Connect a platform-authorized channel

```bash
node src/cli/channel.js channel.connect '{"channelType":"feishu","conversationId":"<conversation-id>","sourceMessageId":"<source-message-id>","org":"<org-id>"}'
```

`channelType` must be exactly one of:

- `feishu` — 飞书
- `lark` — Lark international
- `dingtalk` — 钉钉
- `wecom` — 企业微信

Use the channel the human requested; do not silently substitute another one.

The command returns only a safe status such as:

```json
{"status":"awaiting_user_confirmation","channel_type":"feishu","qr_sent_to_conversation":false,"confirmation_sent_to_conversation":true}
```

or, for a verified IM-card click (no confirmation card; the watcher is
already sending the QR):

```json
{"status":"awaiting_user_scan","channel_type":"feishu","qr_sent_to_conversation":true,"confirmation_sent_to_conversation":false}
```

If the channel already has a live Binding, the command is idempotent and may
instead return `already_connected` or `connection_in_progress`, with
`qr_sent_to_conversation:false` and a ready-to-relay `message`. In that case,
relay the message and never claim that a new QR was sent. An explicit account
or workspace replacement is a separate reconnect operation; do not infer it
from an ordinary connect request.

For a new/retryable typed request, the command publishes a confirmation card and
starts a bounded background watcher. Tell the user to click **Confirm connection**
in OpenMAX (valid for five minutes); do not claim a QR has already been sent.
For a verified IM-card click, the command skips the confirmation card and the
watcher sends the QR directly; tell the user the QR is coming and to scan it.
After confirmation, the watcher obtains the approved session, sends the existing
QR card, and observes authorization then Binding status. Closing the browser
does not stop this watcher. Do not repeat cards via `c4-send` or ask for App ID /
App Secret. Only Binding `connected` means the channel is ready for messaging.
Core and this runtime must be upgraded together; legacy bare-session polling
is deliberately rejected. Personal WeChat and WhatsApp remain out of scope.
