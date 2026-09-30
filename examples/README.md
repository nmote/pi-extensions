# Optional examples

Copy `agents/inspector.md` to `<agent-dir>/agents/` to add a named inspection
agent. Alternatively, copy `agent-config.json` to
`<agent-dir>/extensions/agent-config.json` and keep definitions in
`<agent-dir>/agents/`; `../agents` resolves relative to the JSON file.

Copy both `AGENT_CONFIG.md` and `instructions.md` to `<agent-dir>` to enable the
optional instruction import. Edit these examples to suit your workflow, preserve
existing files, and run `/reload`. These files are not automatically loaded.
