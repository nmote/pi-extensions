import { repoLabel } from "./repo.ts";
import {
	BACKLOG_STATUSES,
	type BacklogItem,
	type BacklogStatus,
	type BacklogStore,
	formatItem,
	isBacklogStatus,
	isItemId,
	newItemId,
	revisionOf,
	type StoredItem,
	type StoreSnapshot,
	timestamp,
} from "./store.ts";

export const MAX_BATCH_SIZE = 20;
export const MAX_TITLE_BYTES = 240;
export const MAX_BODY_BYTES = 50_000;
export const MAX_REPOS = 10;
export const MAX_DEPENDENCIES = 20;
export const ALL_REPOS = "all";
export const ACTIVE_STATUSES: readonly BacklogStatus[] = ["open", "approved", "in_progress"];
const TERMINAL_STATUSES: readonly BacklogStatus[] = ["done", "dropped"];

export interface BacklogOperation {
	action: unknown;
	id?: unknown;
	title?: unknown;
	body?: unknown;
	text?: unknown;
	status?: unknown;
	statuses?: unknown;
	repos?: unknown;
	repo?: unknown;
	query?: unknown;
	revision?: unknown;
	parent?: unknown;
	dependsOn?: unknown;
	blocked?: unknown;
}

export interface OperationContext {
	cwd: string;
	sessionId?: string;
	/** Subagents cannot approve items: a supervisor's task is not user approval. */
	subagent?: boolean;
	now?: Date;
	home?: string;
}

const FIELDS: Record<string, readonly string[]> = {
	list: ["repo", "statuses", "query", "parent", "blocked"],
	read: ["id"],
	add: ["title", "body", "repos", "status", "parent", "dependsOn"],
	update: ["id", "title", "body", "status", "repos", "parent", "dependsOn", "revision"],
	append: ["id", "text"],
	delete: ["id"],
};

const STATUS_ORDER: Record<BacklogStatus, number> = { in_progress: 0, approved: 1, open: 2, done: 3, dropped: 4 };

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function validateTitle(title: unknown): void {
	assert(
		typeof title === "string" && title.trim() && !/[\r\n]/.test(title) && bytes(title) <= MAX_TITLE_BYTES,
		`title must be a single non-empty line of at most ${MAX_TITLE_BYTES} bytes`,
	);
}

function validateBody(body: unknown, label: string): void {
	assert(typeof body === "string" && bytes(body) <= MAX_BODY_BYTES, `${label} must be at most ${MAX_BODY_BYTES} bytes`);
}

function validateStatus(status: unknown): void {
	assert(isBacklogStatus(status), `status must be one of ${BACKLOG_STATUSES.join(", ")}`);
}

function validateOperation(operation: BacklogOperation): void {
	assert(operation && typeof operation === "object", "operation must be an object");
	const action = operation.action;
	assert(typeof action === "string" && action in FIELDS, `unknown backlog action: ${String(action)}`);
	for (const field of Object.keys(operation)) {
		assert(field === "action" || FIELDS[action]!.includes(field), `${action} does not accept ${field}`);
	}
	if (FIELDS[action]!.includes("id")) assert(isItemId(operation.id), "id must be a backlog item ID");
	if (operation.title !== undefined || action === "add") validateTitle(operation.title);
	if (operation.body !== undefined) validateBody(operation.body, "body");
	if (operation.status !== undefined) validateStatus(operation.status);
	if (operation.repos !== undefined) {
		assert(
			Array.isArray(operation.repos) &&
				operation.repos.length > 0 &&
				operation.repos.length <= MAX_REPOS &&
				operation.repos.every((repo) => typeof repo === "string" && repo.trim()),
			`repos must list 1-${MAX_REPOS} repository paths`,
		);
	}
	if (operation.revision !== undefined) assert(typeof operation.revision === "string", "revision must be a string");
	if (operation.parent !== undefined) {
		const clearable = action === "update";
		assert(
			isItemId(operation.parent) || (clearable && operation.parent === ""),
			`parent must be a backlog item ID${clearable ? ' or "" to clear it' : ""}`,
		);
	}
	if (operation.dependsOn !== undefined) {
		const clearable = action === "update";
		assert(
			Array.isArray(operation.dependsOn) &&
				(clearable || operation.dependsOn.length > 0) &&
				operation.dependsOn.length <= MAX_DEPENDENCIES &&
				operation.dependsOn.every(isItemId),
			`dependsOn must list 1-${MAX_DEPENDENCIES} backlog item IDs${clearable ? ", or [] to clear it" : ""}`,
		);
	}
	switch (action) {
		case "list":
			assert(operation.repo === undefined || (typeof operation.repo === "string" && operation.repo.trim()), "repo must be a path");
			assert(
				operation.statuses === undefined ||
					(Array.isArray(operation.statuses) && operation.statuses.length > 0 && operation.statuses.every(isBacklogStatus)),
				`statuses must list values from ${BACKLOG_STATUSES.join(", ")}`,
			);
			assert(operation.query === undefined || typeof operation.query === "string", "query must be a string");
			assert(operation.blocked === undefined || typeof operation.blocked === "boolean", "blocked must be a boolean");
			return;
		case "update":
			assert(
				operation.title !== undefined ||
					operation.body !== undefined ||
					operation.status !== undefined ||
					operation.repos !== undefined ||
					operation.parent !== undefined ||
					operation.dependsOn !== undefined,
				"update requires title, body, status, repos, parent, or dependsOn",
			);
			assert(operation.body === undefined || operation.revision !== undefined, "replacing body requires revision from read");
			return;
		case "append":
			assert(typeof operation.text === "string" && operation.text.trim(), "text must be non-empty");
			validateBody(operation.text, "text");
			return;
	}
}

/** Resolves repository paths to labels; filesystem lookups happen here, outside the store lock. */
function resolveRepos(operation: BacklogOperation, context: OperationContext): BacklogOperation {
	const label = (repo: string) => repoLabel(repo, context.cwd, context.home);
	if (operation.action === "list") {
		const repo = operation.repo as string | undefined;
		return { ...operation, repo: repo === ALL_REPOS ? ALL_REPOS : label(repo ?? context.cwd) };
	}
	if (operation.repos === undefined) return operation;
	return { ...operation, repos: [...new Set((operation.repos as string[]).map(label))] };
}

export function currentRepo(context: OperationContext): string {
	return repoLabel(context.cwd, context.cwd, context.home);
}

/** Dependencies that are not done, including missing ones; only active items are blocked. */
function blockers(snapshot: StoreSnapshot, item: BacklogItem): string[] {
	if (!ACTIVE_STATUSES.includes(item.status)) return [];
	return (item.dependsOn ?? []).filter((id) => snapshot.items.get(id)?.item.status !== "done");
}

/** Counts of `repo`'s active items, e.g. "2 open · 1 blocked"; blocked items count only as blocked. */
export function statusSummary(snapshot: StoreSnapshot, repo: string): string | undefined {
	const counts = new Map<string, number>(["open", "approved", "in progress", "blocked"].map((label) => [label, 0]));
	for (const { item } of snapshot.items.values()) {
		if (!ACTIVE_STATUSES.includes(item.status) || !item.repos.includes(repo)) continue;
		const label = blockers(snapshot, item).length ? "blocked" : item.status.replace("_", " ");
		counts.set(label, counts.get(label)! + 1);
	}
	const parts = [...counts].filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}`);
	return parts.length ? parts.join(" · ") : undefined;
}

function summary(snapshot: StoreSnapshot, item: BacklogItem): string {
	const blocking = blockers(snapshot, item);
	const status = blocking.length ? `${item.status}, blocked by ${blocking.join(", ")}` : item.status;
	return `${item.id} [${status}] ${item.title}`;
}

function itemLine(snapshot: StoreSnapshot, item: BacklogItem, showRepos: boolean): string {
	const line = item.parent ? `${summary(snapshot, item)} · parent ${item.parent}` : summary(snapshot, item);
	return showRepos ? `${line} · ${item.repos.join(", ")}` : line;
}

function compareItems(left: BacklogItem, right: BacklogItem): number {
	return (
		STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
		left.created.localeCompare(right.created) ||
		left.id.localeCompare(right.id)
	);
}

function findItems(snapshot: StoreSnapshot, predicate: (item: BacklogItem) => boolean): BacklogItem[] {
	return [...snapshot.items.values()].map(({ item }) => item).filter(predicate);
}

function childrenOf(snapshot: StoreSnapshot, id: string): BacklogItem[] {
	return findItems(snapshot, (item) => item.parent === id);
}

function isTerminal(item: BacklogItem): boolean {
	return TERMINAL_STATUSES.includes(item.status);
}

function dependentsOf(snapshot: StoreSnapshot, id: string): BacklogItem[] {
	return findItems(snapshot, (item) => item.dependsOn?.includes(id) === true);
}

/** Whether following `edges` from `start` reaches `target`; tolerates missing items and cycles from hand-edited files. */
function reaches(start: readonly string[], target: string, edges: (id: string) => readonly string[]): boolean {
	const seen = new Set<string>();
	const pending = [...start];
	for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
		if (id === target) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		pending.push(...edges(id));
	}
	return false;
}

function listItems(snapshot: StoreSnapshot, operation: BacklogOperation): string {
	const allRepos = operation.repo === ALL_REPOS;
	const repo = allRepos ? undefined : (operation.repo as string);
	const statuses = (operation.statuses as BacklogStatus[] | undefined) ?? ACTIVE_STATUSES;
	const query = (operation.query as string | undefined)?.toLowerCase();
	const parent = operation.parent as string | undefined;
	const blocked = operation.blocked as boolean | undefined;
	const items = findItems(
		snapshot,
		(item) =>
			(!repo || item.repos.includes(repo)) &&
			statuses.includes(item.status) &&
			(!parent || item.parent === parent) &&
			(blocked === undefined || (blockers(snapshot, item).length > 0) === blocked) &&
			(!query || item.title.toLowerCase().includes(query) || item.body.toLowerCase().includes(query)),
	).sort(compareItems);
	const scope = repo ?? "all repositories";
	const lines = items.length
		? [
				`backlog items for ${scope} (${items.length}):`,
				...items.map((item) => itemLine(snapshot, item, allRepos || item.repos.length > 1)),
			]
		: [`no matching backlog items for ${scope}`];
	for (const [id, error] of snapshot.errors) lines.push(`malformed backlog item ${id}: ${error}`);
	return lines.join("\n");
}

function readItem(snapshot: StoreSnapshot, stored: StoredItem): string {
	const { item, revision } = stored;
	const describe = (id: string) => {
		const found = snapshot.items.get(id)?.item;
		return found ? summary(snapshot, found) : `${id} (not found)`;
	};
	const lines = [summary(snapshot, item)];
	if (item.parent) lines.push(`parent: ${describe(item.parent)}`);
	lines.push(`repos: ${item.repos.join(", ")}`, `created: ${item.created} · updated: ${item.updated}`);
	if (item.createdInSession) lines.push(`created in session: ${item.createdInSession}`);
	lines.push(`revision: ${revision}`);
	const ids = (items: BacklogItem[]) => items.sort(compareItems).map((found) => found.id);
	const sections: [string, readonly string[]][] = [
		["children", ids(childrenOf(snapshot, item.id))],
		["depends on", item.dependsOn ?? []],
		["dependents", ids(dependentsOf(snapshot, item.id))],
	];
	for (const [heading, related] of sections) {
		if (related.length) lines.push(`${heading} (${related.length}):`, ...related.map((id) => `  ${describe(id)}`));
	}
	return item.body ? `${lines.join("\n")}\n\n${item.body}` : lines.join("\n");
}

function appendLog(body: string, text: string, now: string, sessionId: string | undefined): string {
	const log = /^## Log$/m.test(body) ? body : `${body}${body ? "\n\n" : ""}## Log`;
	const heading = `### ${now}${sessionId ? ` (session ${sessionId})` : ""}`;
	return `${log}\n\n${heading}\n\n${text.trim()}`;
}

/** Validates the whole batch, applies it in memory, and writes only if every operation succeeds. */
export async function runBacklogOperations(
	store: BacklogStore,
	operations: readonly BacklogOperation[],
	context: OperationContext,
): Promise<string[]> {
	assert(operations.length > 0 && operations.length <= MAX_BATCH_SIZE, `operations must contain 1-${MAX_BATCH_SIZE} items`);
	for (const operation of operations) validateOperation(operation);
	assert(
		!context.subagent || !operations.some((operation) => operation.status === "approved"),
		"subagents cannot set approved; only the user can approve a plan",
	);
	const resolved = operations.map((operation) => resolveRepos(operation, context));
	const current = currentRepo(context);
	const mutating = operations.some((operation) => operation.action !== "list" && operation.action !== "read");

	const run = async (): Promise<string[]> => {
		const snapshot = await store.load();
		const writes = new Map<string, string>();
		const deletes = new Set<string>();
		const now = timestamp(context.now);
		const lines: string[] = [];
		const terminalTransitions = new Set<string>();

		const existing = (id: string) => {
			const error = snapshot.errors.get(id);
			assert(error === undefined, `backlog item ${id} is malformed: ${error}`);
			const stored = snapshot.items.get(id);
			assert(stored, `backlog item not found: ${id}`);
			return stored;
		};
		const save = (item: BacklogItem): string => {
			const content = formatItem(item);
			const revision = revisionOf(content);
			snapshot.items.set(item.id, { item, revision });
			writes.set(item.id, content);
			deletes.delete(item.id);
			return revision;
		};
		const setParent = (item: BacklogItem, parent: string): void => {
			if (!parent) {
				delete item.parent;
				return;
			}
			existing(parent);
			const parentOf = (id: string) => {
				const found = snapshot.items.get(id)?.item.parent;
				return found ? [found] : [];
			};
			assert(!reaches([parent], item.id, parentOf), `parent of ${item.id} cannot be itself or one of its descendants`);
			item.parent = parent;
		};
		const setDependsOn = (item: BacklogItem, dependsOn: readonly string[]): void => {
			const ids = [...new Set(dependsOn)];
			if (!ids.length) {
				delete item.dependsOn;
				return;
			}
			for (const id of ids) existing(id);
			const dependenciesOf = (id: string) => snapshot.items.get(id)?.item.dependsOn ?? [];
			assert(!reaches(ids, item.id, dependenciesOf), `${item.id} cannot depend on itself or on items that depend on it`);
			item.dependsOn = ids;
		};
		const logApproval = (item: BacklogItem): void => {
			item.body = appendLog(item.body, "Marked approved.", now, context.sessionId);
			assert(bytes(item.body) <= MAX_BODY_BYTES, `backlog item body would exceed ${MAX_BODY_BYTES} bytes`);
		};

		for (const operation of resolved) {
			switch (operation.action) {
				case "list":
					lines.push(listItems(snapshot, operation));
					break;
				case "read":
					lines.push(readItem(snapshot, existing(operation.id as string)));
					break;
				case "add": {
					const id = newItemId((candidate) => snapshot.items.has(candidate) || snapshot.errors.has(candidate) || deletes.has(candidate));
					const item: BacklogItem = {
						id,
						title: (operation.title as string).trim(),
						status: (operation.status as BacklogStatus | undefined) ?? "open",
						repos: (operation.repos as string[] | undefined) ?? [current],
						created: now,
						updated: now,
						...(context.sessionId ? { createdInSession: context.sessionId } : {}),
						body: ((operation.body as string | undefined) ?? "").trim(),
					};
					if (operation.parent !== undefined) setParent(item, operation.parent as string);
					if (operation.dependsOn !== undefined) setDependsOn(item, operation.dependsOn as string[]);
					if (item.status === "approved") logApproval(item);
					if (isTerminal(item)) terminalTransitions.add(id);
					lines.push(`added ${id} (revision ${save(item)})`);
					break;
				}
				case "update": {
					const stored = existing(operation.id as string);
					assert(
						operation.revision === undefined || operation.revision === stored.revision,
						`backlog item ${stored.item.id} changed since revision ${String(operation.revision)}; read it again`,
					);
					const item = { ...stored.item, updated: now };
					if (operation.title !== undefined) item.title = (operation.title as string).trim();
					if (operation.body !== undefined) item.body = (operation.body as string).trim();
					const planChanged = item.title !== stored.item.title || item.body !== stored.item.body;
					const unapproved = operation.status === undefined && item.status === "approved" && planChanged;
					if (operation.status !== undefined) item.status = operation.status as BacklogStatus;
					if (unapproved) item.status = "open";
					if (operation.repos !== undefined) item.repos = operation.repos as string[];
					if (operation.parent !== undefined) setParent(item, operation.parent as string);
					if (operation.dependsOn !== undefined) setDependsOn(item, operation.dependsOn as string[]);
					if (stored.item.status !== "approved" && item.status === "approved") logApproval(item);
					if (!isTerminal(stored.item) && isTerminal(item)) terminalTransitions.add(item.id);
					lines.push(`updated ${item.id} (revision ${save(item)})`);
					if (unapproved) {
						lines.push(
							`${item.id} was approved, but its plan changed, so it is now open. Set it to approved only after the user approves the revised plan.`,
						);
					}
					break;
				}
				case "append": {
					const stored = existing(operation.id as string);
					const body = appendLog(stored.item.body, operation.text as string, now, context.sessionId);
					assert(bytes(body) <= MAX_BODY_BYTES, `backlog item body would exceed ${MAX_BODY_BYTES} bytes`);
					lines.push(`appended to ${stored.item.id} (revision ${save({ ...stored.item, body, updated: now })})`);
					break;
				}
				case "delete": {
					const id = operation.id as string;
					assert(snapshot.items.has(id) || snapshot.errors.has(id), `backlog item not found: ${id}`);
					const children = childrenOf(snapshot, id).map((child) => child.id);
					assert(!children.length, `backlog item ${id} has children (${children.join(", ")}); delete them or clear their parent first`);
					const dependents = dependentsOf(snapshot, id).map((dependent) => dependent.id);
					assert(
						!dependents.length,
						`backlog item ${id} has dependents (${dependents.join(", ")}); delete them or remove ${id} from their dependsOn first`,
					);
					snapshot.items.delete(id);
					snapshot.errors.delete(id);
					writes.delete(id);
					deletes.add(id);
					lines.push(`deleted ${id}`);
					break;
				}
			}
		}

		const parents = new Set(
			[...terminalTransitions]
				.map((id) => snapshot.items.get(id)?.item.parent)
				.filter((id): id is string => id !== undefined),
		);
		for (const id of parents) {
			const parent = snapshot.items.get(id)?.item;
			if (!parent || !ACTIVE_STATUSES.includes(parent.status)) continue;
			const children = childrenOf(snapshot, id);
			if (!children.length || !children.every(isTerminal)) continue;
			lines.push(
				`Review parent ${parent.id} [${parent.status}] ${parent.title}: all children are done or dropped. Check its Done criteria and any remaining parent-level work before marking it done.`,
			);
		}

		if (mutating) await store.commit(writes, deletes);
		return lines;
	};

	return mutating ? store.withLock(run) : run();
}
