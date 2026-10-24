import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BacklogStatus, BacklogStore, StoreSnapshot } from "./store.ts";
import type { GraphTheme } from "./config.ts";

const execFile = promisify(execFileCallback);
export const MAX_GRAPH_NODES = 200;
export type GraphFormat = "svg" | "png" | "html";

type Theme = {
	bg: string;
	graphFg: string;
	nodeFg: string;
	nodeBorder: string;
	edge: string;
	edgeFg: string;
	clusterBorder: string;
	clusterFg: string;
	missing: string;
	statuses: Record<BacklogStatus, { leaf: string; parents: [string, string] }>;
};

const LIGHT: Theme = {
	bg: "white",
	graphFg: "black",
	nodeFg: "black",
	nodeBorder: "#888888",
	edge: "black",
	edgeFg: "black",
	clusterBorder: "#888888",
	clusterFg: "black",
	missing: "#ffcccc",
	statuses: {
		open: { leaf: "#e6f2ff", parents: ["#dcecff", "#ecf5ff"] },
		approved: { leaf: "#d6f5db", parents: ["#c9efcf", "#e0f8e4"] },
		in_progress: { leaf: "#fff1c2", parents: ["#ffecad", "#fff4cf"] },
		done: { leaf: "#e8e8e8", parents: ["#dedede", "#eeeeee"] },
		dropped: { leaf: "#f7dddd", parents: ["#f2d0d0", "#fae5e5"] },
	},
};

const DARK: Theme = {
	bg: "black",
	graphFg: "#e8e8e8",
	nodeFg: "#f0f0f0",
	nodeBorder: "#aaaaaa",
	edge: "#cccccc",
	edgeFg: "#e8e8e8",
	clusterBorder: "#aaaaaa",
	clusterFg: "#f0f0f0",
	missing: "#5c2a2a",
	statuses: {
		open: { leaf: "#1e3a5f", parents: ["#1a2f4a", "#243b5e"] },
		approved: { leaf: "#1e3d2a", parents: ["#183222", "#244a32"] },
		in_progress: { leaf: "#3b2e5a", parents: ["#30264a", "#4a3d6b"] },
		done: { leaf: "#333333", parents: ["#2b2b2b", "#3a3a3a"] },
		dropped: { leaf: "#4a2020", parents: ["#3d1a1a", "#552525"] },
	},
};

export const THEMES: Record<GraphTheme, Theme> = { light: LIGHT, dark: DARK };

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

export interface GraphOptions {
	only?: boolean;
	depth?: number;
}

/** Select a component or subtree, then project dependencies onto the displayed hierarchy. */
export function backlogGraph(snapshot: StoreSnapshot, root: string, theme: GraphTheme = "light", options: GraphOptions = {}): BacklogGraph {
	if (options.depth !== undefined && (!Number.isSafeInteger(options.depth) || options.depth < 1)) {
		throw new Error("graph depth must be a positive safe integer");
	}
	if (snapshot.errors.has(root)) throw new Error(`backlog item ${root} is malformed: ${snapshot.errors.get(root)}`);
	if (!snapshot.items.has(root)) throw new Error(`backlog item not found: ${root}`);

	const t = THEMES[theme] ?? LIGHT;

	const descendants = new Map<string, string[]>();
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
		if (item.parent) {
			link(item.parent, item.id, "parent");
			if (!descendants.has(item.parent)) descendants.set(item.parent, []);
			descendants.get(item.parent)!.push(item.id);
		}
		for (const prerequisite of item.dependsOn ?? []) link(prerequisite, item.id, "dependency");
	}

	const selected = new Set<string>();
	const pending = [root];
	while (pending.length) {
		const id = pending.pop()!;
		if (selected.has(id)) continue;
		selected.add(id);
		pending.push(...((options.only ? descendants.get(id) : neighbors.get(id)) ?? []));
	}

	const ancestors = (id: string): Set<string> => {
		const seen = new Set<string>([id]);
		let parent = snapshot.items.get(id)?.item.parent;
		while (parent && selected.has(parent)) {
			if (seen.has(parent)) throw new Error(`parent cycle involving backlog item ${parent}; cannot render containment`);
			seen.add(parent);
			parent = snapshot.items.get(parent)?.item.parent;
		}
		return seen;
	};
	const lineage = new Map([...selected].map((id) => [id, ancestors(id)]));
	const displayed = new Set([...selected].filter((id) => options.depth === undefined || lineage.get(id)!.size <= options.depth));
	if (displayed.size > MAX_GRAPH_NODES) {
		throw new Error(`displayed graph exceeds ${MAX_GRAPH_NODES} items; cannot render backlog graph`);
	}
	const ids = [...displayed].sort();
	const children = new Map<string, string[]>();
	for (const id of ids) {
		const parent = snapshot.items.get(id)?.item.parent;
		if (parent && displayed.has(parent)) {
			if (!children.has(parent)) children.set(parent, []);
			children.get(parent)!.push(id);
		}
	}
	const representative = new Map([...lineage].map(([id, ancestors]) => [id, [...ancestors].find((ancestor) => displayed.has(ancestor))!]));
	const promoted = new Set<string>();
	for (const edge of edges) {
		if (!edge.startsWith("dependency:")) continue;
		const [, from, to] = edge.split(":");
		if (!selected.has(from) || !selected.has(to)) continue;
		const source = representative.get(from)!;
		const target = representative.get(to)!;
		if (lineage.get(target)!.has(source) || lineage.get(source)!.has(target)) continue;
		promoted.add(`${source}:${target}`);
	}
	const dependencyEdges = [...promoted].sort().map((edge) => edge.split(":") as [string, string]);
	const endpoints = new Set(dependencyEdges.flat());
	const unreadable: string[] = [];
	const lines = [
		"digraph backlog {",
		`  graph [rankdir=LR, ranksep=1, compound=true, fontname=Helvetica, labelloc=b, label="Boxes: parent contains children    Dashed: prerequisite to dependent", bgcolor=${quote(t.bg)}, fontcolor=${quote(t.graphFg)}];`,
		`  node [shape=box, style="rounded,filled", fontname=Helvetica, margin="0.25,0.12", color=${quote(t.nodeBorder)}, fontcolor=${quote(t.nodeFg)}];`,
		`  edge [color=${quote(t.edge)}, fontcolor=${quote(t.edgeFg)}];`,
	];
	const emit = (id: string, indent: string, depth: number): void => {
		const item = snapshot.items.get(id)?.item;
		const label = item ? `${id} [${item.status}]\n${wrapLabel(item.title)}\n${wrapLabel(`Repos: ${item.repos.join(", ")}`)}` : `${id}\n(${snapshot.errors.has(id) ? "malformed" : "missing"})`;
		const colors = item ? t.statuses[item.status] : undefined;
		const fill = colors ? (children.has(id) ? colors.parents[depth % 2] : colors.leaf) : t.missing;
		if (children.has(id)) {
			lines.push(`${indent}subgraph ${quote(`cluster_${id}`)} {`);
			lines.push(`${indent}  graph [label=${quote(label)}, labelloc=t, style="rounded,filled", fillcolor=${quote(fill)}, color=${quote(t.clusterBorder)}, fontcolor=${quote(t.clusterFg)}, margin=16];`);
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
		const parent = snapshot.items.get(id)?.item.parent;
		if (!parent || !displayed.has(parent)) emit(id, "  ", 0);
	}
	for (const [from, to] of dependencyEdges) {
		const attributes = ["style=dashed"];
		if (children.has(from)) attributes.push(`ltail=${quote(`cluster_${from}`)}`);
		if (children.has(to)) attributes.push(`lhead=${quote(`cluster_${to}`)}`);
		lines.push(`  ${quote(from)} -> ${quote(to)} [${attributes.join(", ")}];`);
	}
	lines.push("}");
	return { dot: lines.join("\n") + "\n", count: displayed.size, unreadable };
}

export function htmlWrapper(svgContent: string, bg: string): string {
	// svgContent is the raw SVG file; extract the <svg> element so it can be
	// inlined (selectable text) — the XML prolog/doctype is not valid inside HTML.
	const start = svgContent.indexOf("<svg");
	const svg = start >= 0 ? svgContent.slice(start) : svgContent;
	return `<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>backlog graph</title>\n<style>\n  html, body { margin:0; background:${bg}; }\n  html { min-height:100vh; }\n  body { padding:24px; overflow:auto; }\n  .wrap { display:inline-block; min-width:100%; text-align:center; }\n  .wrap svg { display:inline-block; width:auto; height:auto; max-width:none; background:${bg}; vertical-align:top; }\n</style>\n<body>\n  <div class="wrap">${svg}</div>\n</body>\n`;
}

/** Keep the output in a private temp directory so a viewer can read it after the command finishes. */
export async function renderGraph(dot: string, format: GraphFormat = "html"): Promise<string> {
	if (format === "html") {
		const svgPath = await renderGraph(dot, "svg");
		const dir = join(svgPath, "..");
		const htmlPath = join(dir, "index.html");
		const bg = dot.includes('bgcolor="black"') ? "black" : "white";
		try {
			const svgContent = await readFile(svgPath, "utf8");
			await writeFile(htmlPath, htmlWrapper(svgContent, bg), { mode: 0o600 });
			await chmod(htmlPath, 0o600);
			return htmlPath;
		} catch (error) {
			await rm(dir, { recursive: true, force: true });
			throw error;
		}
	}
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
	format: GraphFormat = "html",
	theme: GraphTheme = "light",
	options: GraphOptions = {},
	render: (dot: string, format: GraphFormat) => Promise<string> = renderGraph,
	open: (path: string) => Promise<void> = openGraph,
): Promise<{ path: string; count: number; unreadable: string[]; openError?: string }> {
	const graph = backlogGraph(await store.load(), id, theme, options);
	const path = await render(graph.dot, format);
	try {
		await open(path);
		return { path, count: graph.count, unreadable: graph.unreadable };
	} catch (error) {
		return { path, count: graph.count, unreadable: graph.unreadable, openError: error instanceof Error ? error.message : String(error) };
	}
}
