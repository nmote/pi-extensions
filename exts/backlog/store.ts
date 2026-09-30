import { createHash, randomBytes, randomInt } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./repo.ts";

export const BACKLOG_STATUSES = ["open", "approved", "in_progress", "done", "dropped"] as const;
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number];

export interface BacklogItem {
	id: string;
	title: string;
	status: BacklogStatus;
	repos: string[];
	created: string;
	updated: string;
	createdInSession?: string;
	parent?: string;
	dependsOn?: string[];
	body: string;
}

export interface ItemReference {
	id: string;
	title: string;
}

export interface StoredItem {
	item: BacklogItem;
	revision: string;
}

export interface StoreSnapshot {
	items: Map<string, StoredItem>;
	/** Unparseable item files by ID. */
	errors: Map<string, string>;
}

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_LENGTH = 6;
const ITEM_FILE = /^([0-9a-hjkmnp-tv-z]{6})\.md$/;
const ID_MENTION = /(?<![\p{L}\p{N}_])[0-9a-hjkmnp-tv-z]{6}(?![\p{L}\p{N}_])/gu;
const LOCK_DIR = ".lock";
const STALE_LOCK_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;

export function backlogDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_BACKLOG_DIR ? resolve(expandHome(env.PI_BACKLOG_DIR)) : join(getAgentDir(), "backlog");
}

export function isBacklogStatus(value: unknown): value is BacklogStatus {
	return typeof value === "string" && (BACKLOG_STATUSES as readonly string[]).includes(value);
}

export function isItemId(value: unknown): value is string {
	return typeof value === "string" && ITEM_FILE.test(`${value}.md`);
}

/** Existing items whose IDs appear in `texts`, in first-mention order. */
export async function referencedItems(
	texts: readonly string[],
	store = new BacklogStore(backlogDir()),
): Promise<ItemReference[]> {
	const ids = new Set(texts.flatMap((text) => text.match(ID_MENTION) ?? []));
	if (ids.size === 0) return [];
	const { items } = await store.load(ids);
	return [...ids].flatMap((id) => {
		const stored = items.get(id);
		return stored ? [{ id, title: stored.item.title }] : [];
	});
}

export function newItemId(taken: (id: string) => boolean): string {
	for (;;) {
		const id = Array.from({ length: ID_LENGTH }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");
		if (!taken(id)) return id;
	}
}

export function timestamp(date = new Date()): string {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function revisionOf(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/** Frontmatter strings are JSON-quoted, which YAML parses verbatim. */
export function formatItem(item: BacklogItem): string {
	const lines = [
		"---",
		`title: ${JSON.stringify(item.title)}`,
		`status: ${item.status}`,
		"repos:",
		...item.repos.map((repo) => `  - ${JSON.stringify(repo)}`),
		`created: ${JSON.stringify(item.created)}`,
		`updated: ${JSON.stringify(item.updated)}`,
	];
	if (item.createdInSession) lines.push(`createdInSession: ${JSON.stringify(item.createdInSession)}`);
	if (item.parent) lines.push(`parent: ${JSON.stringify(item.parent)}`);
	if (item.dependsOn?.length) lines.push("dependsOn:", ...item.dependsOn.map((id) => `  - ${JSON.stringify(id)}`));
	lines.push("---", "");
	const frontmatter = lines.join("\n");
	return item.body ? `${frontmatter}\n${item.body}\n` : frontmatter;
}

export function parseItem(id: string, content: string): BacklogItem {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const { title, status, repos, created, updated, createdInSession, parent, dependsOn } = frontmatter;
	if (typeof title !== "string" || !title.trim()) throw new Error("title must be a non-empty string");
	if (!isBacklogStatus(status)) throw new Error(`status must be one of ${BACKLOG_STATUSES.join(", ")}`);
	if (!Array.isArray(repos) || repos.length === 0 || !repos.every((repo) => typeof repo === "string" && repo)) {
		throw new Error("repos must be a non-empty list of strings");
	}
	if (typeof created !== "string" || typeof updated !== "string") throw new Error("created and updated must be strings");
	if (createdInSession !== undefined && typeof createdInSession !== "string") {
		throw new Error("createdInSession must be a string");
	}
	if (parent !== undefined && !isItemId(parent)) throw new Error("parent must be a backlog item ID");
	if (dependsOn !== undefined && !(Array.isArray(dependsOn) && dependsOn.every(isItemId))) {
		throw new Error("dependsOn must be a list of backlog item IDs");
	}
	return {
		id,
		title,
		status,
		repos,
		created,
		updated,
		...(createdInSession ? { createdInSession } : {}),
		...(parent ? { parent } : {}),
		...(dependsOn?.length ? { dependsOn } : {}),
		body,
	};
}

export class BacklogStore {
	constructor(readonly dir: string) {}

	itemPath(id: string): string {
		return join(this.dir, `${id}.md`);
	}

	/** Loads every item, or only the IDs in `only`. */
	async load(only?: ReadonlySet<string>): Promise<StoreSnapshot> {
		const items = new Map<string, StoredItem>();
		const errors = new Map<string, string>();
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items, errors };
			throw error;
		}
		for (const name of names.sort()) {
			const id = ITEM_FILE.exec(name)?.[1];
			if (!id || (only && !only.has(id))) continue;
			let content: string;
			try {
				content = await readFile(this.itemPath(id), "utf8");
			} catch (error) {
				// Deleted by another process after readdir.
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			try {
				items.set(id, { item: parseItem(id, content), revision: revisionOf(content) });
			} catch (error) {
				errors.set(id, error instanceof Error ? error.message : String(error));
			}
		}
		return { items, errors };
	}

	/** Replaces each item file atomically, then removes deleted items. */
	async commit(writes: ReadonlyMap<string, string>, deletes: Iterable<string>): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		for (const [id, content] of writes) {
			const temporary = join(this.dir, `.${id}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
			try {
				await writeFile(temporary, content, { flag: "wx" });
				await rename(temporary, this.itemPath(id));
			} catch (error) {
				await rm(temporary, { force: true });
				throw error;
			}
		}
		for (const id of deletes) await unlink(this.itemPath(id)).catch(ignoreMissing);
	}

	/** Serializes mutations across processes with a directory lock. */
	async withLock<T>(fn: () => Promise<T>): Promise<T> {
		await mkdir(this.dir, { recursive: true });
		const lock = join(this.dir, LOCK_DIR);
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			try {
				await mkdir(lock);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const stats = await stat(lock).catch(() => undefined);
			// Mutations hold the lock for milliseconds, so an old lock belongs to a crashed process.
			if (stats && Date.now() - stats.mtimeMs > STALE_LOCK_MS) {
				await rm(lock, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(`backlog store is locked: ${lock}`);
			await new Promise((resolve) => setTimeout(resolve, 20 + randomInt(30)));
		}
		try {
			return await fn();
		} finally {
			await rm(lock, { recursive: true, force: true });
		}
	}
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
	if (error.code !== "ENOENT") throw error;
}
