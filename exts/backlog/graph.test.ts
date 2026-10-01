import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { backlogGraph, MAX_GRAPH_NODES, openBacklogGraph, renderGraph, type GraphFormat } from "./graph.ts";
import { BacklogStore, formatItem, type BacklogItem, type StoreSnapshot } from "./store.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

function item(id: string, fields: Partial<BacklogItem> = {}): BacklogItem {
	return {
		id,
		title: id,
		status: "open",
		repos: ["~/one"],
		created: "2026-01-01T00:00:00Z",
		updated: "2026-01-01T00:00:00Z",
		body: "",
		...fields,
	};
}

function snapshot(items: BacklogItem[], errors: [string, string][] = []): StoreSnapshot {
	return {
		items: new Map(items.map((entry) => [entry.id, { item: entry, revision: "test" }])),
		errors: new Map(errors),
	};
}

function errorOf(fn: () => unknown): string {
	try {
		fn();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

const connected = snapshot(
	[
		item("aa0001", { dependsOn: ["bb0002"] }),
		item("bb0002", { parent: "aa0001", status: "approved", dependsOn: ["cc0003", "gg0007"] }),
		item("cc0003", { title: 'Quote "hello" \\N <x>', status: "done", repos: ["~/two"] }),
		item("dd0004", { dependsOn: ["bb0002", "jj0009"], status: "in_progress", repos: ["~/one", "~/two"] }),
		item("ee0005", { dependsOn: ["cc0003"], status: "dropped" }),
		item("hh0008"),
	],
	[["jj0009", "bad frontmatter"]],
);
const graph = backlogGraph(connected, "aa0001");
check(
	"selects the whole component through reverse links across statuses and repositories",
	graph.count === 7 && !graph.dot.includes("hh0008") && graph.dot.includes("ee0005") && graph.dot.includes("cc0003"),
);
check(
	"uses containment and omits ancestor dependencies without changing selection",
	graph.dot.includes('subgraph "cluster_aa0001" {') &&
		!graph.dot.includes('"aa0001" -> "bb0002"') &&
		!graph.dot.includes("style=solid") &&
		!graph.dot.includes('"bb0002" -> "aa0001"') &&
		!graph.dot.includes("Dots:") &&
		graph.dot.includes('"cc0003" -> "ee0005" [style=dashed]'),
);
check(
	"quotes title text instead of accepting DOT syntax or Graphviz escapes",
	graph.dot.includes('label="cc0003\\nQuote \\"hello\\" \\\\N <x>\\n[done]\\nRepos: ~/two"') &&
		graph.dot.includes('fillcolor="#e8e8e8"'),
);
check(
	"shows every repository associated with each item",
	graph.dot.includes('label="aa0001\\naa0001\\n[open]\\nRepos: ~/one"') &&
		graph.dot.includes('label="dd0004\\ndd0004\\n[in_progress]\\nRepos: ~/one, ~/two"'),
);
check(
	"shows missing and malformed linked nodes without inventing details",
	graph.unreadable.join() === "gg0007,jj0009" &&
		graph.dot.includes('label="gg0007\\n(missing)"') &&
		graph.dot.includes('label="jj0009\\n(malformed)"'),
);
check(
	"rejects absent or malformed roots",
	/not found/.test(errorOf(() => backlogGraph(connected, "zz0000"))) &&
		/malformed: bad frontmatter/.test(errorOf(() => backlogGraph(connected, "jj0009"))),
);
const longChain = Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, index) =>
	item(String(index + 1).padStart(6, "0"), index ? { parent: String(index).padStart(6, "0") } : {}),
);
check(
	"refuses an oversized component instead of silently truncating it",
	/exceeds 200 items/.test(errorOf(() => backlogGraph(snapshot(longChain), "000001"))),
);

const hierarchy = [
	item("aa0001", { title: 'Parent "title"', status: "approved", repos: ["~/one", "~/two"], dependsOn: ["dd0004"] }),
	item("bb0002", { parent: "aa0001", dependsOn: ["aa0001", "ee0005"] }),
	item("cc0003", { parent: "bb0002", dependsOn: ["bb0002"] }),
	item("dd0004", { dependsOn: ["bb0002"] }),
	item("ee0005", { parent: "dd0004", dependsOn: ["cc0003"] }),
];
const nested = backlogGraph(snapshot(hierarchy), "cc0003");
check(
	"nests parent boxes with complete metadata and emits each item once",
	nested.dot.includes('    subgraph "cluster_bb0002" {') &&
		nested.dot.includes('      "cc0003" [label=') &&
		nested.dot.includes('label="aa0001\\nParent \\"title\\"\\n[approved]\\nRepos: ~/one, ~/two"') &&
		(nested.dot.match(/label="aa0001/g) ?? []).length === 1 &&
		nested.count === 5,
);
check(
	"clips external parent dependencies and omits ancestor dependencies",
	nested.dot.includes('"dd0004" -> "aa0001" [style=dashed, ltail="cluster_dd0004", lhead="cluster_aa0001"]') &&
		nested.dot.includes('"bb0002" -> "dd0004" [style=dashed, ltail="cluster_bb0002", lhead="cluster_dd0004"]') &&
		nested.dot.includes('"ee0005" -> "bb0002" [style=dashed, lhead="cluster_bb0002"]') &&
		!nested.dot.includes('"aa0001" -> "bb0002"') &&
		!nested.dot.includes('"bb0002" -> "cc0003"') &&
		nested.dot.includes('"cc0003" -> "ee0005" [style=dashed]') &&
		nested.dot.includes('"aa0001" [label="", shape=point, width=0.08, style=invis]') &&
		nested.dot.includes('"dd0004" [label="", shape=point, width=0.08, style=invis]') &&
		(nested.dot.match(/ -> /g) ?? []).length === 4,
);
check(
	"generates deterministic DOT regardless of snapshot order or selected root",
	nested.dot === backlogGraph(snapshot([...hierarchy].reverse()), "dd0004").dot,
);
const unreadableParents = backlogGraph(snapshot([
	item("aa0001", { parent: "bb0002", dependsOn: ["cc0003"] }),
	item("dd0004", { parent: "cc0003" }),
], [["cc0003", "bad frontmatter"]]), "aa0001");
check(
	"encloses children of missing and malformed parents without inventing metadata",
	unreadableParents.unreadable.join() === "bb0002,cc0003" &&
		unreadableParents.dot.includes('subgraph "cluster_bb0002" {\n    graph [label="bb0002\\n(missing)"') &&
		unreadableParents.dot.includes('subgraph "cluster_cc0003" {\n    graph [label="cc0003\\n(malformed)"'),
);
check(
	"rejects parent cycles in hand-edited snapshots",
	/parent cycle/.test(errorOf(() => backlogGraph(snapshot([
		item("aa0001", { parent: "bb0002" }), item("bb0002", { parent: "aa0001" }),
	]), "aa0001"))) &&
		/parent cycle/.test(errorOf(() => backlogGraph(snapshot([item("aa0001", { parent: "aa0001" })]), "aa0001"))),
);

const longTitle = 'Review workflow approval permissions and safely escape "quoted" \\N <labels>';
const longRepo = `~/repos/${"x".repeat(60)}`;
const labels = backlogGraph(snapshot([
	item("aa0001", { title: longTitle, repos: ["~/repos/first-long-repository-name", "~/repos/second-long-repository-name", longRepo] }),
	item("bb0002", { title: longTitle, parent: "aa0001" }),
	item("cc0003", { title: longTitle, parent: "bb0002" }),
]), "cc0003");
check(
	"wraps leaf and nested parent titles at word boundaries with safe DOT escaping",
	(labels.dot.match(/Review workflow approval permissions and safely\\n/g) ?? []).length === 3 &&
		(labels.dot.match(/escape \\"quoted\\" \\\\N <labels>/g) ?? []).length === 3,
);
check(
	"wraps repository lists without splitting long paths or losing metadata",
	labels.dot.includes(`Repos: ~/repos/first-long-repository-name,\\n~/repos/second-long-repository-name,\\n${longRepo}`) &&
		labels.dot.includes('margin="0.25,0.12"'),
);

const dir = mkdtempSync(join(tmpdir(), "backlog-graph-test-"));
try {
	const store = new BacklogStore(dir);
	const original = formatItem(item("aa0001"));
	writeFileSync(store.itemPath("aa0001"), original);
	let rendered = "";
	const result = await openBacklogGraph(
		store,
		"aa0001",
		undefined,
		async (dot, format) => {
			assert.equal(format, "svg");
			rendered = dot;
			return "/tmp/example.svg";
		},
		async () => { throw new Error("no graphical viewer"); },
	);
	check(
		"renders a read-only snapshot and retains the output path if opening fails",
		result.path === "/tmp/example.svg" &&
			result.count === 1 &&
			result.openError === "no graphical viewer" &&
			rendered.includes("aa0001") &&
			readFileSync(store.itemPath("aa0001"), "utf8") === original,
	);
	const png = await openBacklogGraph(store, "aa0001", "png", async (_dot, format) => {
		assert.equal(format, "png");
		return "/tmp/example.png";
	}, async (path) => { assert.equal(path, "/tmp/example.png"); });
	assert.equal(png.path, "/tmp/example.png");
	assert.equal(png.openError, undefined);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

const fixture = mkdtempSync(join(tmpdir(), "backlog-render-test-"));
const previousPath = process.env.PATH;
const previousLog = process.env.PI_GRAPH_TEST_LOG;
try {
	const log = join(fixture, "args");
	process.env.PI_GRAPH_TEST_LOG = log;
	process.env.PATH = `${fixture}:${previousPath ?? ""}`;
	writeFileSync(join(fixture, "dot"), `#!/bin/sh
printf '%s\\n' "$@" > "$PI_GRAPH_TEST_LOG"
if grep -q 'fail-render' "$4"; then exit 1; fi
cp "$4" "$3"
`, { mode: 0o700 });
	for (const format of ["svg", "png"] as GraphFormat[]) {
		const dot = "digraph { a -> b }";
		const output = await renderGraph(dot, format === "svg" ? undefined : format);
		try {
			assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
				`-T${format}`, "-o", output, join(dirname(output), "graph.dot"),
			]);
			assert.equal(output, join(dirname(output), `graph.${format}`));
			assert.equal(readFileSync(output, "utf8"), dot);
			assert.equal(statSync(output).mode & 0o777, 0o600);
			assert.equal(statSync(join(dirname(output), "graph.dot")).mode & 0o777, 0o600);
			assert.equal(statSync(dirname(output)).mode & 0o777, 0o700);
		} finally {
			rmSync(dirname(output), { recursive: true, force: true });
		}
	}
	await assert.rejects(renderGraph("fail-render", "png"));
	const failedOutput = readFileSync(log, "utf8").trim().split("\n")[2];
	assert.equal(existsSync(dirname(failedOutput)), false);
} finally {
	if (previousPath === undefined) delete process.env.PATH;
	else process.env.PATH = previousPath;
	if (previousLog === undefined) delete process.env.PI_GRAPH_TEST_LOG;
	else process.env.PI_GRAPH_TEST_LOG = previousLog;
	rmSync(fixture, { recursive: true, force: true });
}

if (failures) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
