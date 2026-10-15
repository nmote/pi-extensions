# Auto-approve

Controls tool permissions using explicit rules, human approval, or a background-model evaluator. **This is not an OS sandbox.**

## Slash commands

- `/auto` — Show the mode, evaluator backend, effort, and policy settings.
  - `/auto manual|auto|yolo` — Choose prompting, model evaluation, or automatic permission for unmatched calls; deny rules always apply.
  - `/auto guidance [clear]` — View/edit session evaluator guidance, or clear it.
  - `/auto effort [low|medium|high]` — Pick or set evaluator reasoning effort (`evaluator.reasoningEffort` in configuration; applies to chat, including Jev fallback).
  - `/auto evaluator [chat|jev]` — Pick or set the evaluator backend (`evaluator.backend` in configuration). Jev then offers authenticated TypeSafe and Workers AI providers, skipping the provider picker when only one is available. Cancellation preserves settings.
  - `/auto stats` — Show evaluation, Jev chat-fallback, and human-approval counters.
  - `/auto test <bash command>` or `/auto test <tool> <json object>` — Ask the evaluator for a verdict without executing the call.

Ctrl+Alt+A cycles modes; `--auto` overrides the startup mode.

## Agent tools

- `request_tool_approval` — Ask the user to approve an exact rejected call using its returned `requestId`, when no safer approach works.

## Configuration

Configuration lives in `<agent-dir>/extensions/auto-approve.json`. First startup creates a policy importing `builtin:defaults`; package updates therefore update its permissions. An explicit `{}` inherits evaluator settings but grants no imported permissions. Invalid configuration falls back to manual approval with empty policy lists.

Imports concatenate permission lists; empty local lists do not clear imported entries. Local `defaultMode` overrides imports, evaluator fields merge individually, and deny rules always win. To customize bundled permissions, copy [defaults.json](defaults.json) into your own configuration and import that instead. The bundled policy allows most extension tools and a few other operations.

Session-local tools and file access within cwd or configured roots are permitted by the base policy, excluding direct writes/edits to Git/Hg metadata; in-scope metadata reads are permitted; global skill reads and the running Pi installation's bundled documentation and examples (README, docs, examples, CHANGELOG) are also permitted, read-only. Unmatched calls prompt in `manual`, use the selected small model in `auto`, and proceed in `yolo`.

The default `chat` backend uses the shared small model: choose an authenticated one with [`/small-model`](../small-model/README.md). There is no default, and calls may incur costs.

The `jev` backend requires both Jev and an authenticated small model. Jev defaults to `typesafe/jev-latest`; override with `evaluator.jev.provider` and `evaluator.jev.model`. Confidence below **0.25** routes either Jev choice to the small model for the final verdict; at or above 0.25 Jev's choice stands. This routing threshold is not configurable. Classifier failures block execution rather than falling back. Each stage has its own evaluator timeout; chat fallback receives the same policy, tool input, and session guidance.

Confident Jev reviews receive a best-effort independent explanation from the small model without changing the verdict. Failed explanations retain Jev's probability/confidence reason. Fallback verdicts already have a rationale and need no extra explanation call. Decision-only hybrid benchmarks exclude optional explanations but include both decision stages' costs and latency. Evaluations cache verdicts and default to a 20-second timeout per stage and `medium` chat reasoning effort. Changing the hybrid's chat model or routing policy invalidates its cache. Failures never grant access; required prompts without a usable UI block execution.

### Jev authentication

Direct: set `TYPESAFE_API_KEY` or run `/login typesafe`; Pi's normal credential precedence applies.

Cloudflare Workers AI: run `/login cloudflare-workers-ai` and supply the API token and account ID, or set `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` before starting Pi. Run `/auto evaluator jev` to select it and save the provider/model pair. The equivalent `evaluator` override in `<agent-dir>/extensions/auto-approve.json` is:

```json
{"evaluator": {"backend": "jev", "jev": {"provider": "cloudflare-workers-ai", "model": "typesafe/jev"}}}
```

Cloudflare AI Gateway is a proxy for TypeSafe, not Workers AI; keep `evaluator.jev.provider` set to `typesafe` for this setup.

Cloudflare AI Gateway (one-time manual setup): create a Custom Provider with slug `typesafe` and base URL `https://api.typesafe.ai` (optionally with BYOK), then point the built-in provider at the gateway with a `~/.pi/agent/models.json` override, which preserves the built-in model:

```json
{"providers": {"typesafe": {"baseUrl": "https://gateway.ai.cloudflare.com/v1/ACCOUNT/GATEWAY/custom-typesafe/v1/", "headers": {"cf-aig-authorization": "Bearer $CF_AIG_TOKEN"}}}}
```

Approval dialogs offer **Approve once + edit session guidance…**. Like `/auto guidance`, this supplies session-scoped evaluator instructions. Name operations and targets explicitly: the evaluator cannot see your conversation. Guidance persists across resume/reload and applies to subagents; a footer indicator marks it active. It overrides conflicting evaluator defaults/context within its scope, but cannot override deny rules, explicit denials, or injection safeguards. It affects evaluated calls only, not allowlisted calls or manual/yolo behavior. Editing or clearing it invalidates cached and pending verdicts, but does not revoke calls already authorized by the final main-session policy check or separate exact-call approvals.

## Evaluation logging

Set `"logEvaluations": true` in configuration to append every real evaluator invocation to `<agent-dir>/auto-approve-logs/evaluations.jsonl` (private: directory 0700, file 0600), one JSON record per line. Records exist for benchmark case curation: they capture the tool call, working directory, configured context, session-guidance snapshot, model, effort, verdict, hybrid routing/model identities when applicable, and whether the verdict was applied (`accepted`) or unused after a mid-flight policy change (`discarded`). Cache hits, allow/deny-list matches, human approvals, and `/auto test` probes are never logged, and rendered prompts are never recorded.

**Records contain raw tool-call input, which may include private code, and session guidance; accidental secrets are rare but possible.** Logs are never uploaded; delete the directory to discard them. Curating cases for the public benchmark is the boundary where sensitive data must be excluded — the raw log makes no sanitization guarantees. Logging is best-effort: a write failure disables it (with one notification) and never affects approval behavior.

`<agent-dir>` defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it.
