# Backlog

Tracks repository-labeled work across sessions, with parent/child plans, dependencies, and approval status. Ask the agent to record longer-lived work here rather than in session notes or todos.

## Slash commands

- `/backlog [repository path|all|item ID]` — List active items for the current repository, another repository, or all repositories; an item ID shows its full contents.
- `/backlog-graph <item ID> [--png]` — Save and open the item's connected graph as SVG or PNG (`--png` may also precede the ID). Requires Graphviz `dot` and macOS `open` or Linux `xdg-open`; the notification reports the saved path even if opening fails.

## Agent tools

- `backlog` — List, read, add, update, append to, or delete items in atomic batches of up to 20 operations. Supports repository/status/text filters, parent links, dependencies, and revision-checked updates; `approved` requires your explicit approval of the current plan.

Setting a child to `approved`, `in_progress`, or `done` automatically moves every `open` ancestor to `in_progress` and logs the triggering descendant. Other ancestor statuses are preserved. This tracks progress without approving additional work. Parent completion remains manual; the tool prompts a Done-criteria check when all children are `done` or `dropped`.

## Storage and graphs

Items live under `<agent-dir>/backlog` by default; `PI_BACKLOG_DIR` overrides it. `<agent-dir>` defaults to `~/.pi/agent`, or `PI_CODING_AGENT_DIR`.

Graph boxes nest parents and children; dashed arrows point from prerequisite to dependent, excluding ancestor/descendant dependencies. Labels show IDs, titles, statuses, and repositories.
