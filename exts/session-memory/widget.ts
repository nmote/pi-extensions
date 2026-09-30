import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SessionTodo } from "./state.ts";

export const MAX_WIDGET_TODOS = 5;

export interface TodoSummary {
	activeCount: number;
	doneCount: number;
	orderedTodos: readonly SessionTodo[];
}

export interface TodoWidgetSummary extends TodoSummary {
	shown: readonly SessionTodo[];
	hiddenCount: number;
}

export function summarizeTodos(todos: readonly SessionTodo[]): TodoSummary | undefined {
	if (todos.length === 0) return undefined;
	const doneCount = todos.filter((todo) => todo.status === "done").length;
	return { activeCount: todos.length - doneCount, doneCount, orderedTodos: [...todos] };
}

export function summarizeTodosForWidget(todos: readonly SessionTodo[]): TodoWidgetSummary | undefined {
	const summary = summarizeTodos(todos);
	if (!summary) return undefined;
	const hiddenCount = Math.max(0, todos.length - MAX_WIDGET_TODOS);
	const omissionOrder = [
		...summary.orderedTodos.filter((todo) => todo.status === "done"),
		...summary.orderedTodos.filter((todo) => todo.status !== "done"),
	];
	const hiddenIds = new Set(omissionOrder.slice(0, hiddenCount).map((todo) => todo.id));
	return {
		...summary,
		shown: summary.orderedTodos.filter((todo) => !hiddenIds.has(todo.id)),
		hiddenCount,
	};
}

export function formatTodoSummary(summary: TodoSummary, theme: Theme): string {
	return theme.fg("muted", `Todos: ${summary.activeCount} active · ${summary.doneCount} done`);
}

export function todoNumberWidth(todos: readonly SessionTodo[]): number {
	return Math.max(1, ...todos.map((todo) => todo.id.slice("todo-".length).length));
}

export function formatTodo(todo: SessionTodo, theme: Theme, numberWidth?: number): string {
	const marker =
		todo.status === "done"
			? theme.fg("success", "✓")
			: todo.status === "in_progress"
				? theme.fg("accent", "◐")
				: theme.fg("dim", "○");
	const color = todo.status === "done" ? "muted" : "text";
	const number = todo.id.slice("todo-".length);
	return `${marker} ${theme.fg("accent", `#${number.padStart(numberWidth ?? number.length)}`)} ${theme.fg(color, todo.text.replace(/\s+/gu, " ").trim())}`;
}
