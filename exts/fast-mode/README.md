# Fast mode

Opt-in premium inference for direct OpenAI Codex requests. No provider or transport overrides.

## Commands

- `/fast` — Toggle Fast.
- `/fast on|off` — Set the preference.
- `/fast status` — Show preference, estimate basis, and last response tier.

Fast adds `service_tier: "priority"` without changing model, reasoning, output limits, or unrelated request fields. Off removes the extension's override; provider defaults still apply. No automatic fallback or additional retries are added.

Supported provider: `openai-codex`, API `openai-codex-responses`, direct `chatgpt.com/backend-api` endpoints. Supported models: `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-6-sol`, and `gpt-6-luna`. Other models, providers, gateways, and virtual routes are unsupported. A model change during request preparation skips Fast for that request rather than risking an override on the wrong provider. Support follows the explicit model list in [Codex's speed documentation](https://learn.chatgpt.com/codex/agent-configuration/speed.md); account availability may differ. Backend acceptance has not been tested on a live account.

When Fast is on with an unsupported selection, a conspicuous warning and persistent banner identify the mismatch. Requests remain unchanged, and the preference stays on for switching back. The footer distinguishes requested, confirmed, unconfirmed, and unavailable Fast. A response tier of `priority` or `fast` confirms Fast; missing or `default` tiers remain unconfirmed because Codex can report `default` for priority requests.

## State and scope

New sessions default off. The active branch's preference survives reload/resume; forks and clones inherit their chosen history. Model switches preserve it. Changes affect subsequent requests, not in-flight requests.

Managed subagents inherit the current preference before launch, continuation/recovery, and supervisor replies. Unsupported child models/providers silently skip Fast. Off explicitly clears inheritance, including in reused children. Changes during an assigned child task wait until its next boundary. The child must load this extension; missing update support while Fast is on stops dispatch rather than silently ignoring the preference. Inherited state is not written to child history.

Independent sessions, approval evaluators, background-model helpers, and cloud agents do not inherit Fast. Cache warming is suppressed while the preference is on to avoid hidden premium keepalive requests.

## Price estimates

Prices use the **2× standard purchased-credit/Enterprise PAYG basis**. Pi's dollar totals remain catalog-based estimates, not invoices or remaining subscription allowance. Included subscription limits have a separate 2.5× consumption multiplier; it is not used for price quotes.

For this extension's requests, completed-message estimates use actual token counts and catalog rates, including cached-input and long-context tiers, with the premium applied once. Existing Pi priority pricing is not multiplied again. Provider-reported authoritative costs are preserved. An unexpected `flex` response retains Pi's pricing and is marked not-fast. Missing or ambiguous response tiers use the requested 2× estimate without claiming confirmed processing. Token counts are unchanged.

Model prices and account billing can differ from the catalog. [Codex pricing and availability](https://learn.chatgpt.com/codex/agent-configuration/speed.md) remain authoritative.
