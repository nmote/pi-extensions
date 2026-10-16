# Session topic

Automatically generates session titles and summaries of your latest request and completed work. Select an authenticated background model with [`/small-model`](../small-model/README.md); model calls may incur costs.

Metadata requests use a tool schema with provider-enforced validation where supported, and ordinary tool calls otherwise. Text responses fall back to JSON parsing. Local field constraints still apply; invalid responses are reported without retries.

## Slash commands

- `/topic [auto|off|refresh]` — Show the topic, latest-request summary, and model; enable/disable automatic updates; or request a topic refresh after the next completed agent turn.

## Agent tools

None.
