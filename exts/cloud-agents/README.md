# Cloud agents

Dispatches approved implementation plans to Cursor or Codex Cloud and checks their progress. Cursor creates a branch and PR; Codex returns a task and reviewable diff, not a PR.

## Slash commands

- `/cloud-agent-setup` — In interactive Pi, set/replace/clear a Cursor API key or bind/clear a Codex environment for the selected GitHub remote. Cursor needs Cloud access; Codex needs the `codex` CLI with ChatGPT login and an environment you verify clones that repository.

## Agent tools

- `cloud_agent` — Dispatch a complete, self-contained approved plan to the explicitly selected provider, only at your request. This is external, billable, write-capable work; remote agents cannot use local uncommitted, unpushed, or unmerged changes.
- `cloud_agent_status` — Check a Cursor agent/run or Codex task using its returned ID. Cursor's web list omits API-launched agents; Codex `READY` means a diff is available for review.
- `cloud_agent_apply` — Apply an authorized `READY` Codex task's diff to the current clean worktree, leaving changes unstaged and uncommitted. Confirm it belongs to this repository; the tool cannot verify that binding and does not branch, commit, push, or create a PR.

Dispatch and apply tools are unavailable inside managed subagents. Review, validation, and any commit or PR creation after Codex application are separate steps.
