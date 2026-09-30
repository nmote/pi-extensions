import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	applyNoteOperations,
	applyTodoOperations,
	MAX_BATCH_SIZE,
	MAX_KEY_BYTES,
	MAX_NOTE_BYTES,
	MAX_TODO_BYTES,
	restoreSessionMemory,
	SESSION_MEMORY_VERSION,
	type NoteMutation,
	type SessionMemoryDetails,
	type SessionMemoryState,
	type TodoMutation,
	TODO_STATUSES,
} from "./state.ts";
import { formatTodo, formatTodoSummary, summarizeTodos, summarizeTodosForWidget, todoNumberWidth } from "./widget.ts";

const TODO_WIDGET = "session-memory-todos";

const noteOperationSchema = Type.Object(
	{
		action: StringEnum(["list", "read", "write", "delete"] as const),
		key: Type.Optional(Type.String({ description: "Note key for read, write, or delete" })),
		text: Type.Optional(Type.String({ description: `Note text for write (at most ${MAX_NOTE_BYTES} bytes)` })),
		prefix: Type.Optional(Type.String({ description: "Key prefix for list" })),
	},
	{ additionalProperties: false },
);

const todoOperationSchema = Type.Object(
	{
		action: StringEnum(["list", "add", "update", "delete"] as const),
		id: Type.Optional(Type.String({ description: "Todo ID for update or delete" })),
		text: Type.Optional(Type.String({ description: `Todo text for add or update (at most ${MAX_TODO_BYTES} bytes)` })),
		status: Type.Optional(StringEnum(TODO_STATUSES)),
	},
	{ additionalProperties: false },
);

const noteParameters = Type.Object(
	{
		operations: Type.Array(noteOperationSchema, {
			minItems: 1,
			maxItems: MAX_BATCH_SIZE,
			description: "Ordered note operations",
		}),
	},
	{ additionalProperties: false },
);

const todoParameters = Type.Object(
	{
		operations: Type.Array(todoOperationSchema, {
			minItems: 1,
			maxItems: MAX_BATCH_SIZE,
			description: "Ordered todo operations",
		}),
	},
	{ additionalProperties: false },
);

function output(lines: readonly string[]): string {
	const content = lines.join("\n\n");
	const notice = `[Output truncated to ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES} bytes. Query a narrower key or prefix.]`;
	const suffix = `\n\n${notice}`;
	const truncated = truncateHead(content, {
		maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(suffix, "utf8"),
		maxLines: DEFAULT_MAX_LINES - 2,
	});
	if (!truncated.truncated) return content;
	return `${truncated.content}${suffix}`;
}

function noteDetails(mutations: NoteMutation[]): SessionMemoryDetails {
	return {
		kind: "session-memory",
		version: SESSION_MEMORY_VERSION,
		store: "notes",
		mutations,
	};
}

function todoDetails(mutations: TodoMutation[]): SessionMemoryDetails {
	return {
		kind: "session-memory",
		version: SESSION_MEMORY_VERSION,
		store: "todos",
		mutations,
	};
}

function operationSummary(operations: Array<{ action: string }>): string {
	return operations.map((operation) => operation.action).join(", ");
}

export function registerSessionMemory(pi: ExtensionAPI): void {
	let state: SessionMemoryState = restoreSessionMemory([]);

	function updateTodoWidget(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		const summary = summarizeTodosForWidget([...state.todos.values()]);
		if (!summary) {
			ctx.ui.setWidget(TODO_WIDGET, undefined);
			return;
		}
		ctx.ui.setWidget(TODO_WIDGET, (_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const lines = [formatTodoSummary(summary, theme)];
				const numberWidth = todoNumberWidth(summary.shown);
				for (const todo of summary.shown) lines.push(formatTodo(todo, theme, numberWidth));
				if (summary.hiddenCount > 0) lines.push(theme.fg("dim", `… ${summary.hiddenCount} more`));
				return lines.map((line) => truncateToWidth(line, width, "…"));
			},
		}));
	}

	function restore(ctx: ExtensionContext): void {
		state = restoreSessionMemory(ctx.sessionManager.getBranch());
		updateTodoWidget(ctx);
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setWidget(TODO_WIDGET, undefined);
	});

	pi.registerTool(
		defineTool({
			name: "session_notes",
			label: "Session Notes",
			description: `Manage transient keyed text notes for this Pi session. Batched list/read/write/delete operations; at most ${MAX_BATCH_SIZE} operations and ${MAX_KEY_BYTES}-byte keys.`,
			promptSnippet: "Store or query transient keyed notes for the current session",
			promptGuidelines: [
				"Use session_notes for transient session work that must survive this session, and query relevant notes before relying on saved state.",
			],
			parameters: noteParameters,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = applyNoteOperations(state, params.operations);
				state = result.state;
				updateTodoWidget(ctx);
				return {
					content: [{ type: "text", text: output(result.lines) }],
					details: noteDetails(result.mutations),
				};
			},
			renderCall(args, theme) {
				return new Text(
					theme.fg("toolTitle", theme.bold("session_notes ")) + theme.fg("muted", operationSummary(args.operations)),
					0,
					0,
				);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "session_todos",
			label: "Session Todos",
			description: `Manage transient session tasks with pending, in_progress, or done status. Batched list/add/update/delete operations; at most ${MAX_BATCH_SIZE} operations.`,
			promptSnippet: "Track or query transient session tasks",
			promptGuidelines: [
				"Use session_todos for transient session task tracking, and query it when task IDs or status are needed.",
			],
			parameters: todoParameters,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = applyTodoOperations(state, params.operations);
				state = result.state;
				updateTodoWidget(ctx);
				return {
					content: [{ type: "text", text: output(result.lines) }],
					details: todoDetails(result.mutations),
				};
			},
			renderCall(args, theme) {
				return new Text(
					theme.fg("toolTitle", theme.bold("session_todos ")) + theme.fg("muted", operationSummary(args.operations)),
					0,
					0,
				);
			},
		}),
	);

	pi.registerCommand("notes", {
		description: "List session note keys, optionally filtered by a prefix",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const prefix = args.trim();
			const keys = [...state.notes.keys()].filter((key) => !prefix || key.startsWith(prefix)).sort();
			ctx.ui.notify(output([keys.length ? `notes (${keys.length}):\n${keys.join("\n")}` : "no matching notes"]), "info");
		},
	});

	pi.registerCommand("todos", {
		description: "List session todos on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			const summary = summarizeTodos([...state.todos.values()]);
			const numberWidth = summary && todoNumberWidth(summary.orderedTodos);
			const message = summary
				? [
						formatTodoSummary(summary, ctx.ui.theme),
						...summary.orderedTodos.map((todo) => formatTodo(todo, ctx.ui.theme, numberWidth)),
					].join("\n")
				: "no todos";
			ctx.ui.notify(message, "info");
		},
	});
}

export default function sessionMemory(pi: ExtensionAPI): void {
	registerSessionMemory(pi);
}
