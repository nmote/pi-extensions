import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backlogGraph, MAX_GRAPH_NODES, openBacklogGraph } from "./graph.ts";
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
	"draws both directed relationship types even when their union has a cycle",
	graph.dot.includes('"aa0001" -> "bb0002" [style=solid]') &&
		graph.dot.includes('"bb0002" -> "aa0001" [style=dashed]') &&
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

const dir = mkdtempSync(join(tmpdir(), "backlog-graph-test-"));
try {
	const store = new BacklogStore(dir);
	const original = formatItem(item("aa0001"));
	writeFileSync(store.itemPath("aa0001"), original);
	let rendered = "";
	const result = await openBacklogGraph(
		store,
		"aa0001",
		async (dot) => {
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
} finally {
	rmSync(dir, { recursive: true, force: true });
}

if (failures) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
