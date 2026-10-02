# Small model

Selects the shared background model used by [auto-approve](../auto-approve/README.md) and [session-topic](../session-topic/README.md). There is no default; model calls may incur costs.

## Slash commands

- `/small-model` — Show the current choice and open a picker of authenticated models; the selection persists in `<agent-dir>/extensions/small-model.json`.

## Agent tools

None.

`<agent-dir>` defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides it.
