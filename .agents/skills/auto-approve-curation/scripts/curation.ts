import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadCases } from "../../../../benchmark/auto-approve/contracts.ts";
import { isEvalLogRecord, type EvalLogRecord } from "../../../../exts/auto-approve/eval-log.ts";

export class CurationError extends Error {}
function fail(message: string): never { throw new CurationError(message); }
const STATE = "curation-state.json";
const MAX_LINE = 4 * 1024 * 1024;
const MAX_STATE = 8 * 1024 * 1024;
const ID = /^[a-f0-9]{64}$/;
export const dispositions = ["excluded", "redundant", "proposed", "added"] as const;
export type Disposition = typeof dispositions[number];
export interface Entry { disposition: Disposition; reason?: string; caseIds?: string[] }
export interface State { schemaVersion: 1; entries: Record<string, Entry> }

function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, item) => item !== null && typeof item === "object" && !Array.isArray(item)
		? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}

export function example(record: EvalLogRecord) {
	return {
		tool: record.tool, input: record.input, cwd: record.cwd,
		structuredContext: record.structuredContext,
		guidance: record.guidance === null ? null : { text: record.guidance.text, revision: 0 },
	};
}

export function fingerprint(record: EvalLogRecord): string {
	return createHash("sha256").update(canonical(example(record))).digest("hex");
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function shortText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
export function validateEntry(value: unknown): asserts value is Entry {
	if (!object(value) || Object.keys(value).some(key => !["disposition", "reason", "caseIds"].includes(key)) ||
		!dispositions.includes(value.disposition as Disposition) ||
		(value.reason !== undefined && !shortText(value.reason, 240)) ||
		(value.caseIds !== undefined && (!Array.isArray(value.caseIds) || value.caseIds.length === 0 ||
			!value.caseIds.every(id => shortText(id, 120)) || new Set(value.caseIds).size !== value.caseIds.length)) ||
		(value.disposition === "added" && value.caseIds === undefined)) fail("Invalid disposition metadata.");
}

/** O_NOFOLLOW also closes the lstat/open race for a replaced state or log path. */
async function regularFile(path: string) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1) fail("Expected a regular private file with one link (no symlinks or hard links).");
		return file;
	} catch (error) {
		await file.close();
		if (error instanceof CurationError) throw error;
		fail("Could not validate an opened private file.");
	}
}

export async function readState(dir: string): Promise<State> {
	let file;
	try { file = await regularFile(join(dir, STATE)); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, entries: {} };
		fail("Cannot safely read curation state; symlinks are not allowed.");
	}
	try {
		const stat = await file.stat();
		if (stat.size > MAX_STATE || (stat.mode & 0o077) !== 0) fail("State must be private (0600) and within the size limit.");
		const value: unknown = JSON.parse(await file.readFile("utf8"));
		if (!object(value) || Object.keys(value).sort().join(",") !== "entries,schemaVersion" ||
			value.schemaVersion !== 1 || !object(value.entries)) fail("Corrupt or unsupported curation state.");
		for (const [id, entry] of Object.entries(value.entries)) {
			if (!ID.test(id)) fail("Corrupt curation state fingerprint.");
			validateEntry(entry);
		}
		return value as unknown as State;
	} catch (error) {
		if (error instanceof CurationError) throw error;
		return fail("Corrupt or unreadable curation state; nothing was reset.");
	} finally { await file.close(); }
}

export interface Diagnostics {
	invalidRecords: number;
	samples: { file: number; line: number; kind: "json" | "schema" | "oversized" }[];
}

/** Whole rescans survive rotation, truncation, and completion of a partial final append. */
export async function scan(dir: string, visit: (id: string, record: EvalLogRecord) => void): Promise<Diagnostics> {
	const diagnostics: Diagnostics = { invalidRecords: 0, samples: [] };
	const files = (await readdir(dir)).filter(name => name.endsWith(".jsonl") || /^evaluations\.jsonl\.\d+$/.test(name)).sort();
	for (const [index, name] of files.entries()) {
		const file = await regularFile(join(dir, name));
		let line = 0;
		let bytes = 0;
		let parts: Buffer[] = [];
		const invalid = (kind: "json" | "schema" | "oversized") => {
			diagnostics.invalidRecords++;
			if (diagnostics.samples.length < 8) diagnostics.samples.push({ file: index + 1, line, kind });
		};
		const consume = (text: string) => {
			let record: unknown;
			try { record = JSON.parse(text); } catch { invalid("json"); return; }
			if (!isEvalLogRecord(record)) invalid("schema");
			else visit(fingerprint(record), record);
		};
		const finish = () => {
			line++;
			if (bytes > MAX_LINE) invalid("oversized");
			else {
				const text = Buffer.concat(parts).toString("utf8").trim();
				if (text) consume(text);
			}
			bytes = 0; parts = [];
		};
		try {
			for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
				const buffer = chunk as Buffer;
				let start = 0;
				for (let end = buffer.indexOf(10); ; end = buffer.indexOf(10, start)) {
					const piece = buffer.subarray(start, end === -1 ? buffer.length : end);
					bytes += piece.length;
					if (bytes <= MAX_LINE) parts.push(piece);
					else parts = [];
					if (end === -1) break;
					finish(); start = end + 1;
				}
			}
			if (bytes > 0) finish();
		} finally { await file.close(); }
	}
	return diagnostics;
}

export async function batch(dir: string, limit: number, pendingOnly = false, inspectDecision = false) {
	if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail("Batch limit must be 1–200.");
	const state = await readState(dir);
	const pending = new Set(Object.keys(state.entries).filter(id => state.entries[id].disposition === "proposed"));
	const selected = new Set<string>();
	const examples: unknown[] = [];
	const diagnostics = await scan(dir, (id, record) => {
		pending.delete(id);
		const entry = state.entries[id];
		if (entry && entry.disposition !== "proposed") return;
		if (pendingOnly && !entry) return;
		if (examples.length >= limit || selected.has(id)) return;
		selected.add(id);
		examples.push({ id, ...example(record), ...(entry ? { disposition: entry } : {}),
			...(inspectDecision ? { loggedDecision: { decision: record.decision, reason: record.reason, status: record.status } } : {}) });
	});
	return { schemaVersion: 1, private: true, examples,
		unavailablePending: [...pending].sort().map(id => ({ id, ...state.entries[id] })), diagnostics };
}

function validateIds(ids: string[]): void {
	if (ids.length === 0 || ids.some(id => !ID.test(id)) || new Set(ids).size !== ids.length) {
		fail("Supply one or more unique, full fingerprint IDs with --id.");
	}
}

async function removeOwned(path: string, identity: { dev: number; ino: number }): Promise<void> {
	try {
		const stat = await lstat(path);
		if (stat.dev === identity.dev && stat.ino === identity.ino && !stat.isSymbolicLink()) await unlink(path);
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Cooperating writers share a lock in a stable, trusted directory; stale locks fail closed. */
async function updateState(dir: string, change: (state: State) => Promise<void>): Promise<void> {
	const lockPath = join(dir, `${STATE}.lock`);
	const tempPath = join(dir, `${STATE}.${randomUUID()}.tmp`);
	let lock;
	const deadline = Date.now() + 5000;
	for (;;) {
		try {
			lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const stat = await lstat(lockPath).catch(() => undefined);
			if (stat && !stat.isFile()) fail("Unsafe state lock; symlinks are not allowed.");
			if (Date.now() >= deadline) fail("State is locked. Verify no writer is running before manually removing a stale lock.");
			await new Promise(resolve => setTimeout(resolve, 25));
		}
	}
	let lockIdentity: { dev: number; ino: number } | undefined;
	let tempIdentity;
	try {
		lockIdentity = await lock.stat();
		const state = await readState(dir);
		await change(state);
		const text = canonical(state) + "\n";
		if (Buffer.byteLength(text) > MAX_STATE) fail("State exceeds the size limit.");
		const temp = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try { tempIdentity = await temp.stat(); await temp.writeFile(text); await temp.sync(); }
		finally { await temp.close(); }
		const existing = await lstat(join(dir, STATE)).catch(error => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (existing && (!existing.isFile() || existing.nlink !== 1)) fail("Unsafe state file; nothing was replaced.");
		await rename(tempPath, join(dir, STATE));
	} finally {
		// Unknown identities stay on disk rather than risking removal of a replacement.
		try { if (tempIdentity) await removeOwned(tempPath, tempIdentity); }
		finally {
			try { await lock.close(); }
			finally { if (lockIdentity) await removeOwned(lockPath, lockIdentity); }
		}
	}
}

export async function mark(dir: string, ids: string[], entry: Entry, dataset: string): Promise<void> {
	validateIds(ids); validateEntry(entry);
	await updateState(dir, async state => {
		const missing = new Set(ids);
		await scan(dir, id => { missing.delete(id); });
		if (missing.size > 0) fail("A requested fingerprint is absent from valid source logs; nothing was marked.");
		if (entry.disposition === "added") {
			let cases;
			try { cases = loadCases(await readFile(dataset, "utf8")); }
			catch { return fail("Current dataset could not be loaded and validated; nothing was marked."); }
			const publicIds = new Set(cases.map(value => value.id));
			if (entry.caseIds!.some(id => !publicIds.has(id))) fail("An added case ID is absent from the validated dataset.");
		}
		for (const id of ids) state.entries[id] = { ...entry };
	});
}

export async function reset(dir: string, ids: string[]): Promise<void> {
	validateIds(ids);
	await updateState(dir, async state => {
		if (ids.some(id => !Object.hasOwn(state.entries, id))) fail("A requested fingerprint has no disposition; nothing was reset.");
		for (const id of ids) delete state.entries[id];
	});
}

/** Literal leftmost-longest replacement on original strings, including object keys. */
export function fictionalize(value: unknown, mapping: unknown): unknown {
	if (!object(mapping) || Object.keys(mapping).length === 0 ||
		Object.entries(mapping).some(([from, to]) => from.length === 0 || typeof to !== "string")) {
		fail("Mapping must be a nonempty JSON object of nonempty source strings to replacement strings.");
	}
	const keys = Object.keys(mapping).sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
	const pattern = new RegExp(keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
	const replace = (text: string) => text.replace(pattern, match => mapping[match] as string);
	const walk = (item: unknown): unknown => {
		if (typeof item === "string") return replace(item);
		if (Array.isArray(item)) return item.map(walk);
		if (!object(item)) return item;
		const entries = Object.entries(item).map(([key, nested]) => [replace(key), walk(nested)] as const);
		if (new Set(entries.map(([key]) => key)).size !== entries.length) fail("Mapping creates an object-key collision.");
		return Object.fromEntries(entries);
	};
	return walk(value);
}

export function fictionalizeCases(text: string, mapping: unknown, dataset: string): string {
	let values: unknown[];
	try { values = text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line)); }
	catch { return fail("Candidate JSONL is invalid; source content is not shown."); }
	if (values.length === 0) fail("Candidate JSONL is empty.");
	const transformed = values.map(value => JSON.stringify(fictionalize(value, mapping))).join("\n") + "\n";
	try { loadCases(dataset + "\n" + transformed); }
	catch { return fail("Assembled dataset failed loadCases validation; source content is not shown."); }
	return transformed;
}
