# Conversation-only reader

Press **Ctrl+Alt+O** or run `/conversation-only` to open a read-only snapshot,
even while Pi is working. Requires regular terminal mode; fullscreen produces an
error.

Scroll with your terminal's normal scrollback controls. Press **Ctrl+Alt+O**,
**Escape**, or **Ctrl+C** to close and restore the editor, including its draft.
These keys close the reader rather than interrupting Pi. Approval dialogs
temporarily replace the reader; answering them restores the frozen snapshot.
New messages appear only after reopening.

The snapshot includes user and assistant text from the active branch, including
history before compaction. It omits thinking, tool calls/results, summaries, and
extension notices. User images appear as `[Image attachment]` placeholders.

This appends a separate view below the normal transcript; it does not filter the
original transcript. Reopening builds a fresh snapshot. Closing rebuilds terminal
scrollback to restore the normal transcript and editor position. Resizing may
also rebuild scrollback. Session history and model context are unchanged.
