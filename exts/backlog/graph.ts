import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BacklogStatus, BacklogStore, StoreSnapshot } from "./store.ts";

const execFile = promisify(execFileCallback);
export const MAX_GRAPH_NODES = 200;
export type GraphFormat = "svg" | "png";

const STATUS_COLORS: Record<BacklogStatus, { leaf: string; parents: [string, string] }> = {
	open: { leaf: "#e6f2ff", parents: ["#dcecff", "#ecf5ff"] },
	approved: { leaf: "#d6f5db", parents: ["#c9efcf", "#e0f8e4"] },
	in_progress: { leaf: "#fff1c2", parents: ["#ffecad", "#fff4cf"] },
	done: { leaf: "#e8e8e8", parents: ["#dedede", "#eeeeee"] },
	dropped: { leaf: "#f7dddd", parents: ["#f2d0d0", "#fae5e5"] },
};

function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n").replace(/[\x00-\x1f\x7f]/g, " ")}"`;
}

/** Wrap at whitespace without splitting repository paths or Graphviz escape sequences. */
function wrapLabel(value: string): string {
	return value.split("\n").flatMap((line) => {
		const wrapped: string[] = [];
		let start = 0;
		for (const word of line.matchAll(/\S+/g)) {
			if (word.index > start && word.index + word[0].length - start > 48) {
				wrapped.push(line.slice(start, word.index).trimEnd());
				start = word.index;
			}
		}
		wrapped.push(line.slice(start));
		return wrapped;
	}).join("\n");
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

	const ids = [...selected].sort();
	const children = new Map<string, string[]>();
	for (const id of ids) {
		const parent = snapshot.items.get(id)?.item.parent;
		if (parent) {
			if (!children.has(parent)) children.set(parent, []);
			children.get(parent)!.push(id);
		}
	}
	const ancestors = (id: string): Set<string> => {
		const seen = new Set<string>([id]);
		let parent = snapshot.items.get(id)?.item.parent;
		while (parent) {
			if (seen.has(parent)) throw new Error(`parent cycle involving backlog item ${parent}; cannot render containment`);
			seen.add(parent);
			parent = snapshot.items.get(parent)?.item.parent;
		}
		return seen;
	};
	const lineage = new Map(ids.map((id) => [id, ancestors(id)]));
	const dependencyEdges = [...edges].sort().filter((edge) => edge.startsWith("dependency:"))
		.map((edge) => edge.split(":").slice(1) as [string, string])
		.filter(([from, to]) => selected.has(from) && selected.has(to))
		.filter(([from, to]) => !lineage.get(to)!.has(from) && !lineage.get(from)!.has(to));
	const endpoints = new Set(dependencyEdges.flat());
	const unreadable: string[] = [];
	const lines = [
		"digraph backlog {",
		"  graph [rankdir=LR, ranksep=1, compound=true, fontname=Helvetica, labelloc=b, label=\"Boxes: parent contains children    Dashed: prerequisite to dependent\"];",
		"  node [shape=box, style=\"rounded,filled\", fontname=Helvetica, margin=\"0.25,0.12\", color=\"#888888\"];",
	];
	const emit = (id: string, indent: string, depth: number): void => {
		const item = snapshot.items.get(id)?.item;
		const label = item ? `${id} [${item.status}]\n${wrapLabel(item.title)}\n${wrapLabel(`Repos: ${item.repos.join(", ")}`)}` : `${id}\n(${snapshot.errors.has(id) ? "malformed" : "missing"})`;
		const colors = item ? STATUS_COLORS[item.status] : undefined;
		const fill = colors ? (children.has(id) ? colors.parents[depth % 2] : colors.leaf) : "#ffcccc";
		if (children.has(id)) {
			lines.push(`${indent}subgraph ${quote(`cluster_${id}`)} {`);
			lines.push(`${indent}  graph [label=${quote(label)}, labelloc=t, style="rounded,filled", fillcolor=${quote(fill)}, color="#888888", margin=16];`);
			if (endpoints.has(id)) {
				lines.push(`${indent}  ${quote(id)} [label="", shape=point, width=0.08, style=invis];`);
			}
			for (const child of children.get(id)!) emit(child, `${indent}  `, depth + 1);
			lines.push(`${indent}}`);
		} else {
			lines.push(`${indent}${quote(id)} [label=${quote(label)}, fillcolor=${quote(fill)}];`);
		}
	};
	for (const id of ids) {
		if (!snapshot.items.has(id)) unreadable.push(id);
		if (!snapshot.items.get(id)?.item.parent) emit(id, "  ", 0);
	}
	for (const [from, to] of dependencyEdges) {
		const attributes = ["style=dashed"];
		if (children.has(from)) attributes.push(`ltail=${quote(`cluster_${from}`)}`);
		if (children.has(to)) attributes.push(`lhead=${quote(`cluster_${to}`)}`);
		lines.push(`  ${quote(from)} -> ${quote(to)} [${attributes.join(", ")}];`);
	}
	lines.push("}");
	return { dot: lines.join("\n") + "\n", count: selected.size, unreadable };
}

/** Keep the output in a private temp directory so a viewer can read it after the command finishes. */
export async function renderGraph(dot: string, format: GraphFormat = "svg"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-backlog-graph-"));
	const input = join(dir, "graph.dot");
	const output = join(dir, `graph.${format}`);
	try {
		await writeFile(input, dot, { mode: 0o600 });
		try {
			await execFile("dot", [`-T${format}`, "-o", output, input], { timeout: 10_000, maxBuffer: 1024 * 1024 });
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

export async function openGraph(path: string): Promise<void> {
	const opener = process.platform === "darwin" ? "open" : "xdg-open";
	await execFile(opener, [path], { timeout: 5_000, maxBuffer: 1024 * 1024 });
}

export async function openBacklogGraph(
	store: BacklogStore,
	id: string,
	format: GraphFormat = "svg",
	render: (dot: string, format: GraphFormat) => Promise<string> = renderGraph,
	open: (path: string) => Promise<void> = openGraph,
): Promise<{ path: string; count: number; unreadable: string[]; openError?: string }> {
	const graph = backlogGraph(await store.load(), id);
	const path = await render(graph.dot, format);
	try {
		await open(path);
		return { path, count: graph.count, unreadable: graph.unreadable };
	} catch (error) {
		return { path, count: graph.count, unreadable: graph.unreadable, openError: error instanceof Error ? error.message : String(error) };
	}
}
