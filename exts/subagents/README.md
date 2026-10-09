# Subagents

Delegates focused work to isolated Pi children that can ask their parent for guidance and retain context for follow-up tasks. Children can run concurrently, but write-capable tasks sharing a worktree need explicitly partitioned changes; model calls may incur costs.

## Slash commands

- `/subagents` — Show child status and named-agent discovery errors; `/subagents cancel <id|all>` ends children.
- `/subagent-models [basic|routine|complex [clear]]` — Show model preferences, pick a model for a task tier, or clear that preference. Unset tiers inherit the session model.
- `/_subagent-task` — Internal child-only approval-policy update; not for manual use.
- `/_subagent-handshake` — Internal child-only protocol check; not for manual use.

## Agent tools

- `list_subagents` — List named-agent definitions and discovery errors without a model call; the parent must read this result before selecting a named agent. Configure definitions through [agent-config](../agent-config/README.md).
- `subagent` — Start one task or up to eight concurrent tasks, optionally choosing a named agent, model, thinking level, and cwd. A different cwd requires your direct approval.
- `subagent_continue` — Give an idle or recoverable provider-failed child a related task while retaining its context.
- `subagent_reply` — Answer a waiting child's question and resume it.
- `subagent_status` — Inspect a child by ID, or omit the ID to inspect all children.
- `subagent_cancel` — End a child and release its process/context, or omit the ID to end all live children.
- `ask_supervisor` — Child-only tool to pause for missing context or a consequential choice; tool-approval requests instead go directly to you.

## Lifecycle

Each child process must match the parent's loaded protocol version and acknowledge a handshake before model execution, including after resume. A mismatch stops the child: run `/reload` in the parent, then restart the child. Handshake timeouts and missing acknowledgements are reported separately. Protocol versions change only for incompatible wire-format or approval-policy changes.

Successful children remain idle for related follow-up work, retaining their conversation (subject to Pi compaction), instructions, model, thinking level, cwd, and tools. Each follow-up inherits the parent's current approval mode and guidance. Exact-call approvals persist; one-shot approvals expire between tasks. Cwd approval lasts for the child's lifetime.

Parent shutdown stops child processes. Resume and `/reload` preserve reusable children through saved sessions under `<agent-dir>/subagents`; processes reopen on continuation. Interrupted tasks—including pending supervisor questions—need explicit continuation rather than a reply. Provider-failed children with saved sessions can recover through an explicit `subagent_continue` after the provider error is resolved. Recovery reopens the session with the current parent approval policy; it does not retry automatically or switch models. Status reports recovery eligibility and the saved session path. Cancelled children, other failures, and children without saved sessions cannot be reused. Historical failures are eligible only when their saved terminal assistant error matches the recorded failure.

Status reports latest-task and lifetime usage. The footer counts active and retained idle children, disappearing when none remain.

`<agent-dir>` defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it.
