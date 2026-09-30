import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BacklogStatus, BacklogStore, StoreSnapshot } from "./store.ts";

const execFile = promisify(execFileCallback);
export const MAX_GRAPH_NODES = 200;

const STATUS_COLORS: Record<BacklogStatus, string> = {
	open: "#e6f2ff",
	approved: "#d6f5db",
	in_progress: "#fff1c2",
	done: "#e8e8e8",
	dropped: "#f7dddd",
};

function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n").replace(/[\x00-\x1f\x7f]/g, " ")}"`;
}

export interface BacklogGraph {
	dot: string;
	count: number;
	unreadable: string[];
}

/** Select the whole weakly connected component, then draw the original directed relationships. */
export function backlogGraph(snapshot: StoreSnapshot, root: string): BacklogGraph {
	if (snapshot.errors.has(root)) throw new Error(`backlog item ${root} is malformed: ${snapshot.errors.get(root)}`);
	if (!snapshot.items.has(root)) throw new Error(`backlog item not found: ${root}`);

	const neighbors = new Map<string, Set<string>>();
	const edges = new Set<string>();
	const link = (from: string, to: string, kind: "parent" | "dependency") => {
		if (!neighbors.has(from)) neighbors.set(from, new Set());
		if (!neighbors.has(to)) neighbors.set(to, new Set());
		neighbors.get(from)!.add(to);
		neighbors.get(to)!.add(from);
		edges.add(`${kind}:${from}:${to}`);
	};
	for (const { item } of snapshot.items.values()) {
		if (item.parent) link(item.parent, item.id, "parent");
		for (const prerequisite of item.dependsOn ?? []) link(prerequisite, item.id, "dependency");
	}

	const selected = new Set<string>();
	const pending = [root];
	while (pending.length) {
		const id = pending.pop()!;
		if (selected.has(id)) continue;
		selected.add(id);
		if (selected.size > MAX_GRAPH_NODES) {
			throw new Error(`connected component exceeds ${MAX_GRAPH_NODES} items; cannot render backlog graph`);
		}
		pending.push(...(neighbors.get(id) ?? []));
	}

	const unreadable: string[] = [];
	const lines = [
		"digraph backlog {",
		"  graph [rankdir=LR, labelloc=b, label=\"Solid: parent to child    Dashed: prerequisite to dependent\"];",
		"  node [shape=box, style=filled, fontname=Helvetica];",
	];
	for (const id of [...selected].sort()) {
		const item = snapshot.items.get(id)?.item;
		if (!item) unreadable.push(id);
		const label = item ? `${id}\n${item.title}\n[${item.status}]` : `${id}\n(${snapshot.errors.has(id) ? "malformed" : "missing"})`;
		const fill = item ? STATUS_COLORS[item.status] : "#ffcccc";
		lines.push(`  ${quote(id)} [label=${quote(label)}, fillcolor=${quote(fill)}];`);
	}
	for (const edge of [...edges].sort()) {
		const [kind, from, to] = edge.split(":");
		if (selected.has(from!) && selected.has(to!)) {
			lines.push(`  ${quote(from!)} -> ${quote(to!)} [style=${kind === "parent" ? "solid" : "dashed"}];`);
		}
	}
	lines.push("}");
	return { dot: lines.join("\n") + "\n", count: selected.size, unreadable };
}

/** Keep the output in a private temp directory so a browser can read it after the command finishes. */
export async function renderGraphSvg(dot: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-backlog-graph-"));
	const input = join(dir, "graph.dot");
	const output = join(dir, "graph.svg");
	try {
		await writeFile(input, dot, { mode: 0o600 });
		try {
			await execFile("dot", ["-Tsvg", "-o", output, input], { timeout: 10_000, maxBuffer: 1024 * 1024 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error("Graphviz `dot` is not installed (install graphviz to render backlog graphs)");
			}
			throw error;
		}
		await chmod(output, 0o600);
		return output;
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

export async function openGraphSvg(path: string): Promise<void> {
	const opener = process.platform === "darwin" ? "open" : "xdg-open";
	await execFile(opener, [path], { timeout: 5_000, maxBuffer: 1024 * 1024 });
}

export async function openBacklogGraph(
	store: BacklogStore,
	id: string,
	render: (dot: string) => Promise<string> = renderGraphSvg,
	open: (path: string) => Promise<void> = openGraphSvg,
): Promise<{ path: string; count: number; unreadable: string[]; openError?: string }> {
	const graph = backlogGraph(await store.load(), id);
	const path = await render(graph.dot);
	try {
		await open(path);
		return { path, count: graph.count, unreadable: graph.unreadable };
	} catch (error) {
		return { path, count: graph.count, unreadable: graph.unreadable, openError: error instanceof Error ? error.message : String(error) };
	}
}
