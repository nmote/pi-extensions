# Auto-approve

Controls tool permissions using explicit rules, human approval, or a background-model evaluator. **This is not an OS sandbox.**

## Slash commands

- `/auto` — Show the mode, evaluator model, effort, and policy settings.
  - `/auto manual|auto|yolo` — Choose prompting, model evaluation, or automatic permission for unmatched calls; deny rules always apply.
  - `/auto guidance [clear]` — View/edit session evaluator guidance, or clear it.
  - `/auto effort [low|medium|high]` — Pick or set evaluator reasoning effort (`evaluator.reasoningEffort` in configuration).
  - `/auto stats` — Show evaluation and human-approval counters.
  - `/auto test <bash command>` or `/auto test <tool> <json object>` — Ask the evaluator for a verdict without executing the call.

Ctrl+Alt+A cycles modes; `--auto` overrides the startup mode.

## Agent tools

- `request_tool_approval` — Ask the user to approve an exact rejected call using its returned `requestId`, when no safer approach works.

## Configuration

Configuration lives in `<agent-dir>/extensions/auto-approve.json`. First startup creates a policy importing `builtin:defaults`; package updates therefore update its permissions. An explicit `{}` inherits evaluator settings but grants no imported permissions. Invalid configuration falls back to manual approval with empty policy lists.

Imports concatenate permission lists; empty local lists do not clear imported entries. Local `defaultMode` overrides imports, evaluator fields merge individually, and deny rules always win. To customize bundled permissions, copy [defaults.json](defaults.json) into your own configuration and import that instead. The bundled policy allows most extension tools and a few other operations.

Session-local tools and file access within cwd or configured roots are permitted by the base policy, excluding Git/Hg metadata; global skill reads are also permitted. Unmatched calls prompt in `manual`, use the selected small model in `auto`, and proceed in `yolo`.

Choose an authenticated evaluator with [`/small-model`](../small-model/README.md); there is no default, and calls may incur costs. Evaluations cache verdicts and default to a 20-second timeout and `medium` reasoning effort. Failures never grant access; required prompts without a usable UI block execution.

Approval dialogs offer **Approve once + edit session guidance…**. Like `/auto guidance`, this supplies session-scoped evaluator instructions. Name operations and targets explicitly: the evaluator cannot see your conversation. Guidance persists across resume/reload and applies to subagents; a footer indicator marks it active. It overrides conflicting evaluator defaults/context within its scope, but cannot override deny rules, explicit denials, or injection safeguards. It affects evaluated calls only, not allowlisted calls or manual/yolo behavior. Editing or clearing it invalidates cached and pending verdicts, but does not revoke calls already authorized by the final main-session policy check or separate exact-call approvals.

`<agent-dir>` defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it.
