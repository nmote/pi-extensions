# Backlog

Tracks repository-labeled work across sessions, with parent/child plans, dependencies, and approval status. Ask the agent to record longer-lived work here rather than in session notes or todos.

## Slash commands

- `/backlog [repository path|all|item ID]` — List active items for the current repository, another repository, or all repositories; an item ID shows its full contents.
- `/backlog-graph <item ID> [--only] [--depth n] [--html|--svg|--png]` — Save and open the item's connected graph (HTML wrapper with themed background by default, or raw SVG/PNG with `--svg`/`--png`; flags may precede the ID). Requires Graphviz `dot` and macOS `open` or Linux `xdg-open`; the notification reports the saved path even if opening fails.

## Agent tools

- `backlog` — List, read, add, update, append to, or delete items in atomic batches of up to 20 operations. Supports repository/status/text filters, parent links, dependencies, and revision-checked updates; `approved` requires your explicit approval of the current plan.

Setting a child to `approved`, `in_progress`, or `done` automatically moves every `open` ancestor to `in_progress` and logs the triggering descendant. Other ancestor statuses are preserved. This tracks progress without approving additional work. Parent completion remains manual; the tool prompts a Done-criteria check when all children are `done` or `dropped`.

## Repository labels

Worktrees share their main repository's label. Local filesystem remotes (paths or `file://` URLs) are followed recursively; network and invalid targets are ignored. All local remotes must converge on one repository. A cycle, conflicting destinations, or the 100-repository traversal limit falls back to the original shared worktree root. Existing item labels are not migrated.

## Storage and graphs

Items live under `<agent-dir>/backlog` by default; `PI_BACKLOG_DIR` overrides it. `<agent-dir>` defaults to `~/.pi/agent`, or `PI_CODING_AGENT_DIR`.

`--only` selects the item and its descendants, excluding ancestors and external dependencies. `--depth n` displays the first n hierarchy levels (a positive integer), starting at the connected component's top-level parents, or at the given item with `--only`. Depth 1 shows only those roots. Dependencies on hidden descendants attach to their nearest displayed ancestors; duplicate arrows and self-loops are omitted, but cycles between distinct items are retained. The 200-item limit applies after filtering.

Graph boxes nest parents and children; dashed arrows point from prerequisite to dependent, excluding ancestor/descendant dependencies. Labels show IDs, titles, statuses, and repositories. Graphs default to a light theme (white background); set `{"graphTheme":"dark"}` (or `"theme":"dark"`) in `<agent-dir>/extensions/backlog.json` for the dark theme (black background, violet `in_progress`).
