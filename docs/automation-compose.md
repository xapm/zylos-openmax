# Isolated Automation Drafting

The adapter polls Core's purpose-specific durable compose queue. It does not
forward drafts into C4, normal DM history, typing indicators or external IM.
Core/Comm bind the authenticated Agent and request; the worker sees only drafting
content and returns `{kind:"proposal",draft}`, `{kind:"clarification",message}`
or `{kind:"error",message}`. The adapter supplies all routing fields itself.

## Enablement

This change is disabled until an operator configures a reviewed isolated worker.
No configuration is changed by installation. In the OpenMax component config:

```json
{
  "automation_compose": {
    "enabled": true,
    "command": "/absolute/path/to/node",
    "args": ["/absolute/path/to/zylos-openmax/scripts/compose-claude-worker.js"],
    "timeout_ms": 120000
  }
}
```

Alternatively select `scripts/compose-codex-worker.js` with a compatible Codex CLI
and working Codex authentication. It uses a fresh ephemeral read-only process,
ignores user configuration and project instructions, disables shell, apps, MCP
plugin discovery, browser, image, memory and delegation features, and disables
web search. Unsupported feature/CLI versions fail closed. It never resumes a
main runtime session. This worker intentionally does not inherit custom model
provider configuration; configure another reviewed worker when that is needed.

The Claude worker requires Claude CLI supporting `--safe-mode`, `--tools`, and
`--no-session-persistence` plus its own working authentication. It starts a fresh
tool-less process per request, with no persistent session, customizations or MCP
servers. It never resumes the main agent's session. Verify it with a harmless
draft before enabling; do not assume the active Zylos runtime provides Claude
authentication. Other workers can implement the same JSON stdin/stdout protocol.
Only install operator-reviewed workers: an arbitrary executable is trusted code,
not a sandbox. User request content cannot select the command or arguments.

Enable only with the matching Core/Comm API deployed and end-to-end checked.
Before advertising capability the adapter performs a harmless isolated inference
readiness check; this uses the configured model and may incur its normal cost.
Failed checks are retried at most once per minute. The authenticated capability lease is refreshed while polling and expires after
the adapter stops. Missing configuration disables advertisement and polling.
An inference failure returns an isolated error, never a normal-message fallback.
Worker output/stderr and prompts are not written to routine logs.

## Delivery Semantics

Five-second polling is non-overlapping. Results awaiting an HTTP acknowledgement
are cached in-process; a transient submit failure retries without another model
call. A crash may repeat inference, but server-side first-valid-terminal
idempotency prevents duplicate results and there are no model-side actions.
After inference the adapter rechecks cancellation/expiry and immutable binding.
Shutdown aborts the inference process group. No raw credentials are put into the
worker input. Normal chat paths are unchanged.

The subprocess environment is allowlisted: basic runtime paths/locale, proxy and
CA settings, model configuration paths, and explicit Anthropic/OpenAI model
authentication settings. Model credentials are intentionally available to the
reviewed worker for inference. Parent messaging/session credentials, OpenMax
credentials and Node injection options are not inherited. This is input
minimization, not filesystem isolation from the same OS user's credentials.

Retry cache entries bind the complete immutable request, including requester,
conversation, revision and content. A changed binding cannot reuse an old result;
the binding and current local DM policy are rechecked before every submission.
Comm additionally rejects changed content/revision for an existing request ID.
Request inference failures return isolated errors without resetting successful
worker readiness or causing another readiness probe.

Cancellation observed after inference suppresses submission. It does not yet
interrupt inference immediately; sequential polling can delay the next request
for up to the configured inference timeout. Shutdown does interrupt the process.
The local default-probe test uses a real child process with deterministic output;
it does not establish live model authentication or successful real inference.

The backend must enforce schema and resource authorization on proposal results;
adapter JSON validation does not substitute for those checks. A `proposal` draft
never saves or executes an automation.
