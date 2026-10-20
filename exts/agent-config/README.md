# Agent config

Loads shared instructions with recursive `@path` imports and locates named agents for the [subagents extension](../subagents/README.md).

## Slash commands

- `/agent-config` — Show loaded instruction files, the effective agent directory, and configuration errors.

## Agent tools

None.

## Configuration

- Optional `<agent-dir>/AGENT_CONFIG.md` supplies instructions. Missing files add nothing; a broken root or import blocks prompts.
- Named agents default to `<agent-dir>/agents/`; an absent default directory means an empty catalog. Set `{"agents":"~/my-agent-config/agents"}` in `<agent-dir>/extensions/agent-config.json` to replace it. Absolute paths, `~`, and paths relative to that config file are supported. Invalid explicit settings report errors without fallback.
- Add `MCP` to an agent definition's `tools` list (for example, `tools: Read, Bash, MCP`) to grant `tool_search` access to MCP tools. Subagents without this grant launch with MCP disabled, including general agents and definitions without a `tools` list.
- Reload after editing agent definitions. `/agent-config` and `list_subagents` report discovery errors.
- Pi also discovers native context files and skills; register additional skill paths in `settings.json.skills`. [Examples](../../examples/) provide optional configuration and a named agent; nothing is installed automatically.

`<agent-dir>` defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it.
