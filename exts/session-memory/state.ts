import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const SESSION_MEMORY_VERSION = 1;
export const MAX_BATCH_SIZE = 20;
export const MAX_KEY_BYTES = 160;
export const MAX_NOTE_BYTES = 12_000;
export const MAX_NOTES = 200;
export const MAX_TODO_BYTES = 1_000;
export const MAX_TODOS = 100;

export const TODO_STATUSES = ["pending", "in_progress", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface SessionTodo {
	id: string;
	text: string;
	status: TodoStatus;
}

export interface NoteWriteMutation {
	action: "write";
	key: string;
	text: string;
}

export interface NoteDeleteMutation {
	action: "delete";
	key: string;
}

export type NoteMutation = NoteWriteMutation | NoteDeleteMutation;

export interface TodoAddMutation {
	action: "add";
	todo: SessionTodo;
}

export interface TodoUpdateMutation {
	action: "update";
	id: string;
	text?: string;
	status?: TodoStatus;
}

export interface TodoDeleteMutation {
	action: "delete";
	id: string;
}

export type TodoMutation = TodoAddMutation | TodoUpdateMutation | TodoDeleteMutation;

export interface SessionMemoryDetails {
	kind: "session-memory";
	version: typeof SESSION_MEMORY_VERSION;
	store: "notes" | "todos";
	mutations: NoteMutation[] | TodoMutation[];
}

export interface SessionMemoryState {
	notes: Map<string, string>;
	todos: Map<string, SessionTodo>;
	nextTodoId: number;
}

export function createSessionMemoryState(): SessionMemoryState {
	return { notes: new Map(), todos: new Map(), nextTodoId: 1 };
}

export function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

export function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function isValidKey(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.trim().length > 0 &&
		value === value.trim() &&
		byteLength(value) <= MAX_KEY_BYTES &&
		!/\p{Cc}|\p{Cf}/u.test(value)
	);
}

function isValidNoteText(value: unknown): value is string {
	return typeof value === "string" && byteLength(value) <= MAX_NOTE_BYTES;
}

function isValidTodoText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && byteLength(value) <= MAX_TODO_BYTES;
}

function asTodoId(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^todo-([1-9]\d*)$/.exec(value);
	if (!match) return undefined;
	const id = Number(match[1]);
	return Number.isSafeInteger(id) ? id : undefined;
}

function cloneTodo(todo: SessionTodo): SessionTodo {
	return { ...todo };
}

function validNoteMutation(value: unknown): value is NoteMutation {
	if (!value || typeof value !== "object") return false;
	const mutation = value as Partial<NoteMutation>;
	return (
		(mutation.action === "write" && isValidKey(mutation.key) && isValidNoteText(mutation.text)) ||
		(mutation.action === "delete" && isValidKey(mutation.key))
	);
}

function validTodoMutation(value: unknown): value is TodoMutation {
	if (!value || typeof value !== "object") return false;
	const mutation = value as Partial<TodoMutation>;
	if (mutation.action === "add") {
		const todo = mutation.todo;
		return !!todo && asTodoId(todo.id) !== undefined && isValidTodoText(todo.text) && isTodoStatus(todo.status);
	}
	if (mutation.action === "update") {
		return (
			asTodoId(mutation.id) !== undefined &&
			(mutation.text === undefined || isValidTodoText(mutation.text)) &&
			(mutation.status === undefined || isTodoStatus(mutation.status)) &&
			(mutation.text !== undefined || mutation.status !== undefined)
		);
	}
	return mutation.action === "delete" && asTodoId(mutation.id) !== undefined;
}

function memoryDetails(entry: SessionEntry): SessionMemoryDetails | undefined {
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) return undefined;
	const details = entry.message.details;
	if (!details || typeof details !== "object") return undefined;
	const candidate = details as Partial<SessionMemoryDetails>;
	if (
		candidate.kind !== "session-memory" ||
		candidate.version !== SESSION_MEMORY_VERSION ||
		(candidate.store !== "notes" && candidate.store !== "todos") ||
		!Array.isArray(candidate.mutations)
	) {
		return undefined;
	}
	if (candidate.store === "notes") {
		if (entry.message.toolName !== "session_notes" || !candidate.mutations.every(validNoteMutation)) return undefined;
	} else if (entry.message.toolName !== "session_todos" || !candidate.mutations.every(validTodoMutation)) {
		return undefined;
	}
	return candidate as SessionMemoryDetails;
}

function applyNoteMutation(notes: Map<string, string>, mutation: NoteMutation): void {
	if (mutation.action === "write") {
		if (notes.has(mutation.key) || notes.size < MAX_NOTES) notes.set(mutation.key, mutation.text);
		return;
	}
	notes.delete(mutation.key);
}

function applyTodoMutation(state: SessionMemoryState, mutation: TodoMutation): void {
	if (mutation.action === "add") {
		if (!state.todos.has(mutation.todo.id) && state.todos.size >= MAX_TODOS) return;
		state.todos.set(mutation.todo.id, cloneTodo(mutation.todo));
		const number = asTodoId(mutation.todo.id);
		if (number !== undefined) state.nextTodoId = Math.max(state.nextTodoId, number + 1);
		return;
	}
	if (mutation.action === "update") {
		const todo = state.todos.get(mutation.id);
		if (!todo) return;
		if (mutation.text !== undefined) todo.text = mutation.text;
		if (mutation.status !== undefined) todo.status = mutation.status;
		return;
	}
	state.todos.delete(mutation.id);
}

/** Replays successful session-memory tool-result deltas on the active branch. */
export function restoreSessionMemory(entries: readonly SessionEntry[]): SessionMemoryState {
	const state = createSessionMemoryState();
	for (const entry of entries) {
		const details = memoryDetails(entry);
		if (!details) continue;
		if (details.store === "notes") {
			for (const mutation of details.mutations as NoteMutation[]) applyNoteMutation(state.notes, mutation);
		} else {
			for (const mutation of details.mutations as TodoMutation[]) applyTodoMutation(state, mutation);
		}
	}
	return state;
}

export interface NoteOperation {
	action: unknown;
	key?: unknown;
	text?: unknown;
	prefix?: unknown;
}

export interface TodoOperation {
	action: unknown;
	id?: unknown;
	text?: unknown;
	status?: unknown;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertFields(operation: object, allowed: readonly string[], action: string): void {
	for (const field of Object.keys(operation)) {
		assert(allowed.includes(field), `${action} does not accept ${field}`);
	}
}

function validateKey(key: unknown, label = "key"): asserts key is string {
	assert(isValidKey(key), `${label} must be a non-empty key of at most ${MAX_KEY_BYTES} bytes`);
}

function validatePrefix(prefix: unknown): asserts prefix is string | undefined {
	assert(prefix === undefined || (typeof prefix === "string" && byteLength(prefix) <= MAX_KEY_BYTES), "prefix is too long");
}

function validateNoteText(text: unknown): asserts text is string {
	assert(typeof text === "string" && isValidNoteText(text), `text must be at most ${MAX_NOTE_BYTES} bytes`);
}

function validateTodoText(text: unknown): asserts text is string {
	assert(isValidTodoText(text), `text must be non-empty and at most ${MAX_TODO_BYTES} bytes`);
}

function validateTodoId(id: unknown): asserts id is string {
	assert(asTodoId(id) !== undefined, "id must be a todo ID");
}

function validateNoteOperation(operation: NoteOperation): void {
	assert(operation && typeof operation === "object", "operation must be an object");
	assert(typeof operation.action === "string", "operation action is required");
	switch (operation.action) {
		case "list":
			assertFields(operation, ["action", "prefix"], operation.action);
			validatePrefix(operation.prefix);
			return;
		case "read":
			assertFields(operation, ["action", "key"], operation.action);
			validateKey(operation.key);
			return;
		case "write":
			assertFields(operation, ["action", "key", "text"], operation.action);
			validateKey(operation.key);
			validateNoteText(operation.text);
			return;
		case "delete":
			assertFields(operation, ["action", "key"], operation.action);
			validateKey(operation.key);
			return;
		default:
			throw new Error(`unknown note action: ${operation.action}`);
	}
}

function validateTodoOperation(operation: TodoOperation): void {
	assert(operation && typeof operation === "object", "operation must be an object");
	assert(typeof operation.action === "string", "operation action is required");
	switch (operation.action) {
		case "list":
			assertFields(operation, ["action", "status"], operation.action);
			assert(operation.status === undefined || isTodoStatus(operation.status), "status must be pending, in_progress, or done");
			return;
		case "add":
			assertFields(operation, ["action", "text", "status"], operation.action);
			validateTodoText(operation.text);
			assert(operation.status === undefined || isTodoStatus(operation.status), "status must be pending, in_progress, or done");
			return;
		case "update":
			assertFields(operation, ["action", "id", "text", "status"], operation.action);
			validateTodoId(operation.id);
			assert(operation.text !== undefined || operation.status !== undefined, "update requires text or status");
			if (operation.text !== undefined) validateTodoText(operation.text);
			assert(operation.status === undefined || isTodoStatus(operation.status), "status must be pending, in_progress, or done");
			return;
		case "delete":
			assertFields(operation, ["action", "id"], operation.action);
			validateTodoId(operation.id);
			return;
		default:
			throw new Error(`unknown todo action: ${operation.action}`);
	}
}

export interface NoteOperationResult {
	state: SessionMemoryState;
	lines: string[];
	mutations: NoteMutation[];
}

export function applyNoteOperations(state: SessionMemoryState, operations: readonly NoteOperation[]): NoteOperationResult {
	assert(operations.length > 0 && operations.length <= MAX_BATCH_SIZE, `operations must contain 1-${MAX_BATCH_SIZE} items`);
	for (const operation of operations) validateNoteOperation(operation);

	const next: SessionMemoryState = {
		notes: new Map(state.notes),
		todos: new Map(state.todos),
		nextTodoId: state.nextTodoId,
	};
	const lines: string[] = [];
	const mutations: NoteMutation[] = [];
	for (const operation of operations) {
		switch (operation.action) {
			case "list": {
				const prefix = operation.prefix as string | undefined;
				const keys = [...next.notes.keys()].filter((key) => !prefix || key.startsWith(prefix)).sort();
				lines.push(keys.length ? `notes (${keys.length}):\n${keys.join("\n")}` : "no matching notes");
				break;
			}
			case "read": {
				const key = operation.key as string;
				const text = next.notes.get(key);
				lines.push(text === undefined ? `${key}: not found` : `${key}:\n${text}`);
				break;
			}
			case "write": {
				const key = operation.key as string;
				assert(next.notes.has(key) || next.notes.size < MAX_NOTES, `note limit is ${MAX_NOTES}`);
				const mutation: NoteWriteMutation = { action: "write", key, text: operation.text as string };
				applyNoteMutation(next.notes, mutation);
				mutations.push(mutation);
				lines.push(`wrote ${key}`);
				break;
			}
			case "delete": {
				const key = operation.key as string;
				assert(next.notes.has(key), `note not found: ${key}`);
				const mutation: NoteDeleteMutation = { action: "delete", key };
				applyNoteMutation(next.notes, mutation);
				mutations.push(mutation);
				lines.push(`deleted ${key}`);
				break;
			}
		}
	}
	return { state: next, lines, mutations };
}

export interface TodoOperationResult {
	state: SessionMemoryState;
	lines: string[];
	mutations: TodoMutation[];
}

function todoLine(todo: SessionTodo): string {
	return `${todo.id} [${todo.status}] ${todo.text}`;
}

export function applyTodoOperations(state: SessionMemoryState, operations: readonly TodoOperation[]): TodoOperationResult {
	assert(operations.length > 0 && operations.length <= MAX_BATCH_SIZE, `operations must contain 1-${MAX_BATCH_SIZE} items`);
	for (const operation of operations) validateTodoOperation(operation);

	const next: SessionMemoryState = {
		notes: new Map(state.notes),
		todos: new Map([...state.todos].map(([id, todo]) => [id, cloneTodo(todo)])),
		nextTodoId: state.nextTodoId,
	};
	const lines: string[] = [];
	const mutations: TodoMutation[] = [];
	for (const operation of operations) {
		switch (operation.action) {
			case "list": {
				const status = operation.status as TodoStatus | undefined;
				const todos = [...next.todos.values()].filter((todo) => !status || todo.status === status);
				lines.push(todos.length ? `todos (${todos.length}):\n${todos.map(todoLine).join("\n")}` : "no matching todos");
				break;
			}
			case "add": {
				assert(next.todos.size < MAX_TODOS, `todo limit is ${MAX_TODOS}`);
				const todo: SessionTodo = {
					id: `todo-${next.nextTodoId++}`,
					text: operation.text as string,
					status: (operation.status as TodoStatus | undefined) ?? "pending",
				};
				const mutation: TodoAddMutation = { action: "add", todo };
				applyTodoMutation(next, mutation);
				mutations.push(mutation);
				lines.push(`added ${todo.id}`);
				break;
			}
			case "update": {
				const id = operation.id as string;
				assert(next.todos.has(id), `todo not found: ${id}`);
				const mutation: TodoUpdateMutation = { action: "update", id };
				if (operation.text !== undefined) mutation.text = operation.text as string;
				if (operation.status !== undefined) mutation.status = operation.status as TodoStatus;
				applyTodoMutation(next, mutation);
				mutations.push(mutation);
				lines.push(`updated ${id}`);
				break;
			}
			case "delete": {
				const id = operation.id as string;
				assert(next.todos.has(id), `todo not found: ${id}`);
				const mutation: TodoDeleteMutation = { action: "delete", id };
				applyTodoMutation(next, mutation);
				mutations.push(mutation);
				lines.push(`deleted ${id}`);
				break;
			}
		}
	}
	return { state: next, lines, mutations };
}
