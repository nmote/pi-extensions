/**
 * Smoke tests for auto-approve config import resolution and merging. Run with:
 *   ./scripts/test exts/auto-approve
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, FIRST_TIME_CONFIG, loadConfig, mergeRaw, resolveConfig, saveEvaluatorEffort, seedConfig } from "./config.ts";
import type { RawConfig } from "./config.ts";

let failures = 0;
function check(name: string, cond: boolean): void {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

function expectError(name: string, run: () => unknown, expected: string): void {
	try {
		run();
		check(name, false);
	} catch (error) {
		check(name, error instanceof Error && error.message.includes(expected));
	}
}

const temp = mkdtempSync(join(tmpdir(), "pi-auto-approve-config-test-"));
const home = join(temp, "home");
const files = join(temp, "files");
mkdirSync(home, { recursive: true });
mkdirSync(files, { recursive: true });

const file = (name: string, content: string): string => {
	const path = join(files, name);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	return path;
};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

try {
	const seeded = join(files, "seeded", "auto-approve.json");
	seedConfig(seeded);
	check("first-time template contains only the import and empty overrides", readFileSync(seeded, "utf8") === `${JSON.stringify(FIRST_TIME_CONFIG, null, 2)}\n` && !("defaultMode" in FIRST_TIME_CONFIG));
	const preset = JSON.parse(readFileSync(new URL("./defaults.json", import.meta.url), "utf8"));
	const inherited = resolveConfig(seeded, home);
	check("empty local collections inherit the bundled policy", JSON.stringify(inherited) === JSON.stringify(mergeRaw({}, preset)));
	const presetPath = fileURLToPath(new URL("./defaults.json", import.meta.url));
	const duplicate = file("duplicate-builtin.json", JSON.stringify({ imports: ["builtin:defaults", presetPath], defaultMode: "manual", evaluator: { memoize: false } }));
	const deduplicated = resolveConfig(duplicate, home);
	check("symbolic and file imports share canonical identity and local overrides", list(deduplicated.allow).length === preset.allow.length && deduplicated.defaultMode === "manual" && (deduplicated.evaluator as Record<string, unknown>).timeoutMs === 20000 && (deduplicated.evaluator as Record<string, unknown>).memoize === false);
	writeFileSync(seeded, "{}\n");
	seedConfig(seeded);
	check("existing config and preset omission are preserved", readFileSync(seeded, "utf8") === "{}\n" && JSON.stringify(resolveConfig(seeded, home)) === "{}");
	const brokenLink = join(files, "dangling.json");
	symlinkSync(join(files, "absent-target.json"), brokenLink);
	seedConfig(brokenLink);
	expectError("dangling existing config is preserved", () => resolveConfig(brokenLink, home), "Cannot read imported file");
	expectError("unknown builtin imports are rejected", () => resolveConfig(file("unknown-builtin.json", '{"imports":["builtin:other"]}'), home), "unknown builtin import");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(files, "agent");
		const localConfig = join(process.env.PI_CODING_AGENT_DIR, "extensions", "auto-approve.json");
		check("loading without a session does not seed policy", JSON.stringify(loadConfig()) === JSON.stringify(DEFAULTS));
		loadConfig({ seed: true });
		check("session loading seeds and loads policy", loadConfig().allow.length === preset.allow.length);
		writeFileSync(localConfig, "{}");
		check("intentionally empty policy uses only engine defaults", JSON.stringify(loadConfig({ seed: true })) === JSON.stringify(DEFAULTS));
		writeFileSync(localConfig, '{"imports":["builtin:defaults","builtin:bad"],"allow":[{"tool":"bash","pattern":".*"}]}');
		const failed = loadConfig({ seed: true });
		check("bad import fails closed without partially granting the preset", failed.defaultMode === "manual" && failed.allow.length === 0 && failed.context.length === 0 && failed.writeRoots.length === 0);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}

	// Merge precedence
	const base: RawConfig = {
		defaultMode: "yolo",
		allow: [{ tool: "read" }],
		deny: [{ tool: "bash", pattern: "^rm\\b" }],
		writeRoots: ["/tmp"],
		readRoots: ["/shared"],
		evaluator: { timeoutMs: 1000, memoize: true },
	};
	const overlay: RawConfig = {
		defaultMode: "manual",
		allow: [{ tool: "write" }],
		context: [{ tool: "pup_run", instructions: "be careful" }],
		writeRoots: ["~/scratch"],
		readRoots: ["~/repos"],
		evaluator: { memoize: false },
	};
	const merged = mergeRaw(base, overlay);
	check("scalar defaultMode is overridden", merged.defaultMode === "manual");
	check(
		"allow list concatenates in order",
		JSON.stringify(merged.allow) === JSON.stringify([{ tool: "read" }, { tool: "write" }]),
	);
	check("deny list from base is preserved", JSON.stringify(merged.deny) === JSON.stringify([{ tool: "bash", pattern: "^rm\\b" }]));
	check("context list merges from overlay", list(merged.context).length === 1);
	check(
		"writeRoots and readRoots concatenate",
		JSON.stringify(merged.writeRoots) === JSON.stringify(["/tmp", "~/scratch"]) &&
			JSON.stringify(merged.readRoots) === JSON.stringify(["/shared", "~/repos"]),
	);
	const evalObj = merged.evaluator as { timeoutMs?: number; memoize?: boolean };
	check("evaluator deep-merges per field", evalObj.timeoutMs === 1000 && evalObj.memoize === false);
	check("imports directive is dropped", !("imports" in merged));

	const fresh = join(files, "new", "auto-approve.json");
	saveEvaluatorEffort("medium", fresh);
	check("saving effort creates a local config", JSON.parse(readFileSync(fresh, "utf8")).evaluator.reasoningEffort === "medium");
	const malformed = file("malformed.json", "{oops");
	expectError("saving effort rejects invalid config", () => saveEvaluatorEffort("high", malformed), "could not parse");
	check("invalid config is not overwritten", readFileSync(malformed, "utf8") === "{oops");

	// Import resolution
	const standard = file("standard.json", JSON.stringify({ defaultMode: "auto", allow: [{ tool: "read" }], writeRoots: ["/tmp"] }));
	const local = file("local.json", JSON.stringify({ imports: ["./standard.json"], defaultMode: "manual", allow: [{ tool: "write" }] }));
	const resolved = resolveConfig(local, home);
	check(
		"imports merge under local values",
		resolved.defaultMode === "manual" && JSON.stringify(resolved.allow) === JSON.stringify([{ tool: "read" }, { tool: "write" }]),
	);
	check("imported writeRoots survive", JSON.stringify(resolved.writeRoots) === JSON.stringify(["/tmp"]));

	// Home-relative import
	writeFileSync(join(home, "home-config.json"), JSON.stringify({ deny: [{ tool: "edit" }] }));
	const homeRoot = file("home-root.json", JSON.stringify({ imports: ["~/home-config.json"] }));
	check("home-relative import resolves", list(resolveConfig(homeRoot, home).deny).length === 1);

	// Nested imports
	file("nested/leaf.json", JSON.stringify({ allow: [{ tool: "leaf" }] }));
	file("nested/middle.json", JSON.stringify({ imports: ["./leaf.json"] }));
	const nestedRoot = file("nested-root.json", JSON.stringify({ imports: ["./nested/middle.json"] }));
	check("nested imports resolve", list(resolveConfig(nestedRoot, home).allow).length === 1);

	// Diamond dedup: d imported by both b and c merges once
	file("diamond/d.json", JSON.stringify({ allow: [{ tool: "d" }] }));
	file("diamond/b.json", JSON.stringify({ imports: ["./d.json"] }));
	file("diamond/c.json", JSON.stringify({ imports: ["./d.json"] }));
	const diamond = file("diamond/a.json", JSON.stringify({ imports: ["./b.json", "./c.json"] }));
	check("diamond imports merge once", list(resolveConfig(diamond, home).allow).length === 1);

	expectError("direct cycle", () => resolveConfig(file("cycle-a.json", JSON.stringify({ imports: ["./cycle-a.json"] })), home), "cycle detected");
	file("cycle-b.json", JSON.stringify({ imports: ["./cycle-a.json"] }));
	expectError("indirect cycle", () => resolveConfig(file("cycle-a.json", JSON.stringify({ imports: ["./cycle-b.json"] })), home), "cycle detected");

	expectError("missing import", () => resolveConfig(file("missing.json", JSON.stringify({ imports: ["./absent.json"] })), home), "Cannot read imported file");
	file("broken.json", "{oops");
	expectError("invalid JSON import", () => resolveConfig(file("imports-broken.json", JSON.stringify({ imports: ["./broken.json"] })), home), "could not parse");
	expectError("imports must be an array", () => resolveConfig(file("not-array.json", JSON.stringify({ imports: "x.json" })), home), "array of path strings");
	expectError("import entries must be strings", () => resolveConfig(file("not-string.json", JSON.stringify({ imports: [42] })), home), "array of path strings");
	expectError("non-object config", () => resolveConfig(file("non-object.json", "[1,2,3]"), home), "JSON object");

	// Depth limit
	const depthRoot = file("depth/d0.json", JSON.stringify({ imports: ["./d1.json"] }));
	for (let i = 1; i <= 10; i++) {
		file(`depth/d${i}.json`, JSON.stringify({ imports: [`./d${i + 1}.json`] }));
	}
	expectError("maximum depth", () => resolveConfig(depthRoot, home), "maximum depth");
} finally {
	rmSync(temp, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
