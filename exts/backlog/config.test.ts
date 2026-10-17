import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backlogConfigPath, loadBacklogConfig } from "./config.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let failures = 0;
function check(name: string, cond: boolean): void {
	if (cond) console.log(`  ok  ${name}`);
	else { failures++; console.error(`FAIL  ${name}`); }
}

check("config path respects PI_CODING_AGENT_DIR", (() => {
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "/tmp/fake-agent";
	try { return backlogConfigPath() === join("/tmp/fake-agent", "extensions", "backlog.json"); }
	finally { if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev; }
})());

check("default is light when file missing", (() => {
	const dir = mkdtempSync(join(tmpdir(), "backlog-config-"));
	try { return loadBacklogConfig(join(dir, "missing.json")).graphTheme === "light"; }
	finally { rmSync(dir, { recursive: true, force: true }); }
})());

{
	const dir = mkdtempSync(join(tmpdir(), "backlog-config-"));
	try {
		const p = join(dir, "c.json");
		writeFileSync(p, JSON.stringify({ graphTheme: "dark" }));
		check("reads graphTheme dark", loadBacklogConfig(p).graphTheme === "dark");
		writeFileSync(p, JSON.stringify({ theme: "dark" }));
		check("reads theme alias dark", loadBacklogConfig(p).graphTheme === "dark");
		writeFileSync(p, JSON.stringify({ graphTheme: "dark", theme: "light" }));
		check("graphTheme takes precedence over theme", loadBacklogConfig(p).graphTheme === "dark");
		writeFileSync(p, JSON.stringify({ graphTheme: "light" }));
		check("reads graphTheme light", loadBacklogConfig(p).graphTheme === "light");
		writeFileSync(p, JSON.stringify({ graphTheme: "invalid" }));
		check("invalid value falls back to light", loadBacklogConfig(p).graphTheme === "light");
		writeFileSync(p, "{ not json");
		check("invalid JSON falls back to light", loadBacklogConfig(p).graphTheme === "light");
		writeFileSync(p, JSON.stringify({}));
		check("empty object falls back to light", loadBacklogConfig(p).graphTheme === "light");
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

check("default path uses getAgentDir", backlogConfigPath() === join(getAgentDir(), "extensions", "backlog.json"));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
