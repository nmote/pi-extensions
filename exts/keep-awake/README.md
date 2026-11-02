# Keep awake

Prevents macOS idle system sleep while Pi is working, using the system
`/usr/bin/caffeinate` utility. No commands or configuration are required.

Inhibition begins at `agent_start` and lasts through tools, retries, compaction
between runs, and queued follow-ups until `agent_settled`. Cancellation, errors,
and session shutdown release it. Reload and session replacement also clean up.
The assertion is tied to Pi's PID so it is released if Pi exits unexpectedly.

The display can still sleep. Lid-close and explicit sleep are not prevented.
Linux and other platforms are unaffected. If caffeinate fails, work continues;
UI sessions receive at most one warning per session.

Each Pi process loading this extension manages its own assertion, including
local supervised agents. Remote cloud-agent work is not tracked.
