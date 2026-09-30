import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import {
	applyNoteOperations,
	applyTodoOperations,
	createSessionMemoryState,
	restoreSessionMemory,
	type SessionMemoryDetails,
	type SessionTodo,
	type TodoStatus,
} from "./state.ts";
import { formatTodo, summarizeTodos, summarizeTodosForWidget, todoNumberWidth } from "./widget.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

function toolResult(
	id: string,
	toolName: "session_notes" | "session_todos",
	details: SessionMemoryDetails,
	isError = false,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName,
			content: [{ type: "text", text: "ok" }],
			details,
			isError,
			timestamp: Date.now(),
		},
	} as unknown as SessionEntry;
}

function details(store: "notes" | "todos", mutations: SessionMemoryDetails["mutations"]): SessionMemoryDetails {
	return { kind: "session-memory", version: 1, store, mutations } as SessionMemoryDetails;
}

function todo(id: number, status: TodoStatus): SessionTodo {
	return { id: `todo-${id}`, text: `Task ${id}`, status };
}

function main(): void {
	const initial = createSessionMemoryState();
	const write = applyNoteOperations(initial, [{ action: "write", key: "review/finding-1", text: "private investigation" }]);
	check(
		"note mutations persist only the write delta",
		write.mutations.length === 1 && write.mutations[0]?.action === "write" && !("notes" in (write.mutations[0] ?? {})),
	);
	check("note writes confirm without echoing bodies", write.lines[0] === "wrote review/finding-1");
	let atomic = false;
	try {
		applyNoteOperations(write.state, [
			{ action: "write", key: "review/finding-2", text: "would be lost" },
			{ action: "delete", key: "missing" },
		]);
	} catch {
		atomic = !write.state.notes.has("review/finding-2") && write.state.notes.has("review/finding-1");
	}
	check("invalid note batches leave state unchanged", atomic);

	const todos = applyTodoOperations(createSessionMemoryState(), [{ action: "add", text: "Investigate parser" }]);
	const updated = applyTodoOperations(todos.state, [{ action: "update", id: "todo-1", status: "in_progress" }]);
	check(
		"todo deltas retain stable IDs and statuses",
		updated.state.todos.get("todo-1")?.status === "in_progress" && updated.mutations[0]?.action === "update",
	);

	const widgetSummary = summarizeTodosForWidget([
		todo(1, "done"),
		todo(2, "pending"),
		todo(3, "done"),
		todo(4, "in_progress"),
		todo(5, "pending"),
		todo(6, "done"),
		todo(7, "done"),
	]);
	check(
		"todo widget omits oldest completed items without reordering the rest",
		widgetSummary?.activeCount === 3 &&
			widgetSummary.doneCount === 4 &&
			widgetSummary.hiddenCount === 2 &&
			widgetSummary.shown.map(({ id }) => id).join(",") === "todo-2,todo-4,todo-5,todo-6,todo-7",
	);
	const outstandingOverflow = summarizeTodosForWidget([
		todo(1, "done"),
		...Array.from({ length: 6 }, (_, index) => todo(index + 2, "pending")),
	]);
	check(
		"todo widget next omits oldest outstanding items",
		outstandingOverflow?.hiddenCount === 2 &&
			outstandingOverflow.shown.map(({ id }) => id).join(",") === "todo-3,todo-4,todo-5,todo-6,todo-7",
	);
	const allSummary = summarizeTodos([
		todo(1, "done"),
		todo(2, "pending"),
		todo(3, "done"),
		todo(4, "in_progress"),
		todo(5, "pending"),
		todo(6, "done"),
		todo(7, "done"),
	]);
	check(
		"todo command summary preserves every todo in original order",
		allSummary?.activeCount === 3 &&
			allSummary.doneCount === 4 &&
			allSummary.orderedTodos.map(({ id }) => id).join(",") === "todo-1,todo-2,todo-3,todo-4,todo-5,todo-6,todo-7",
	);
	const plainTheme = { fg: (_color: string, text: string) => text } as Theme;
	const visibleTodos = [todo(2, "pending"), todo(10, "pending")];
	check(
		"todo display includes padded numeric IDs",
		todoNumberWidth(visibleTodos) === 2 &&
			formatTodo(visibleTodos[0]!, plainTheme, todoNumberWidth(visibleTodos)) === "○ # 2 Task 2" &&
			formatTodo(visibleTodos[1]!, plainTheme, todoNumberWidth(visibleTodos)) === "○ #10 Task 10",
	);

	const completedSummary = summarizeTodosForWidget([todo(1, "done")]);
	check(
		"todo widget remains visible with only completed items",
		completedSummary?.activeCount === 0 && completedSummary.doneCount === 1 && completedSummary.shown.length === 1,
	);

	const noteDelta = details("notes", [{ action: "write", key: "shared", text: "from common ancestor" }]);
	const todoDelta = details("todos", [
		{ action: "add", todo: { id: "todo-1", text: "Restore me", status: "pending" } },
		{ action: "update", id: "todo-1", status: "done" },
	]);
	const ignoredDelta = details("notes", [{ action: "write", key: "ignored", text: "failed" }]);
	const restoredEntries = [
		toolResult("notes", "session_notes", noteDelta),
		{
			type: "compaction",
			id: "compact",
			parentId: "notes",
			timestamp: new Date().toISOString(),
			summary: "compacted",
			firstKeptEntryId: "notes",
			tokensBefore: 1,
		},
		toolResult("todos", "session_todos", todoDelta),
		toolResult("failed", "session_notes", ignoredDelta, true),
	] as SessionEntry[];
	const restored = restoreSessionMemory(restoredEntries);
	check(
		"replay restores successful deltas through compaction",
		restored.notes.get("shared") === "from common ancestor" &&
			restored.todos.get("todo-1")?.status === "done" &&
			!restored.notes.has("ignored"),
	);

	const branchA = [
		...restoredEntries,
		toolResult("a", "session_notes", details("notes", [{ action: "write", key: "branch", text: "A" }])),
	];
	const branchB = [
		...restoredEntries,
		toolResult("b", "session_notes", details("notes", [{ action: "write", key: "branch", text: "B" }])),
	];
	check(
		"each branch replays only its own deltas",
		restoreSessionMemory(branchA).notes.get("branch") === "A" && restoreSessionMemory(branchB).notes.get("branch") === "B",
	);
	check(
		"fork-style replay retains todo ID allocation",
		restoreSessionMemory(branchA).nextTodoId === 2 && restoreSessionMemory(branchB).nextTodoId === 2,
	);

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall checks passed");
}

main();
