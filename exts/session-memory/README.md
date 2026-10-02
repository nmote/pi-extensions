# Session memory

Gives the agent branch-aware notes and todos within a Pi session. Use these for session-local context and task tracking, and [backlog](../backlog/README.md) for work spanning sessions.

## Slash commands

- `/notes [prefix]` — List note keys on the current session branch, optionally filtered by prefix.
- `/todos` — List todos on the current session branch.

## Agent tools

- `session_notes` — List, read, write, or delete keyed text notes in batches of up to 20 operations.
- `session_todos` — List, add, update, or delete tasks in batches of up to 20 operations, with `pending`, `in_progress`, or `done` status.
