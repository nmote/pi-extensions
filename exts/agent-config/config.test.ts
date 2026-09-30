import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentConfig, { formatDiagnostics, loadAgentConfig } from "./index.ts";
import { agentConfigPaths, discoverConfiguredAgents } from "./config.ts";

const temp = mkdtempSync(join(tmpdir(), "pi-agent-paths-"));
const home = join(temp, "home");
const previousHome = process.env.HOME;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.HOME = home;
delete process.env.PI_CODING_AGENT_DIR;

try {
	const paths = agentConfigPaths();
	assert.equal(paths.root, join(home, ".pi/agent/AGENT_CONFIG.md"));
	assert.equal(paths.defaultAgents, join(home, ".pi/agent/agents"));
	assert.deepEqual(discoverConfiguredAgents(paths), { directory: paths.defaultAgents, names: [], definitions: [], errors: [] });

	process.env.PI_CODING_AGENT_DIR = "~/.pi-alt";
	assert.equal(agentConfigPaths().agentsConfig, join(home, ".pi-alt/extensions/agent-config.json"));
	process.env.PI_CODING_AGENT_DIR = "~";
	assert.equal(agentConfigPaths().root, join(home, "AGENT_CONFIG.md"));
	process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
	const alternate = agentConfigPaths();
	assert.equal(alternate.root, join(temp, "agent/AGENT_CONFIG.md"));

	const custom = join(home, "custom-agents");
	for (const directory of [paths.defaultAgents, custom]) {
		mkdirSync(directory, { recursive: true });
		const name = directory === custom ? "custom" : "default";
		writeFileSync(join(directory, `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\n---\nWork\n`);
	}
	assert.deepEqual(discoverConfiguredAgents(paths).names, ["default"]);
	mkdirSync(join(temp, "agent/extensions"), { recursive: true });
	const configure = (value: unknown) => writeFileSync(alternate.agentsConfig, JSON.stringify(value));
	for (const value of [custom, "~/custom-agents", "../../home/custom-agents"]) {
		configure({ agents: value });
		const discovery = discoverConfiguredAgents(alternate);
		assert.equal(discovery.directory, custom);
		assert.deepEqual(discovery.names, ["custom"]);
		assert.deepEqual(discovery.errors, []);
	}
	configure({});
	assert.equal(discoverConfiguredAgents(alternate).directory, alternate.defaultAgents);
	assert.deepEqual(discoverConfiguredAgents(alternate).errors, []);
	configure({ agents: "~" });
	assert.equal(discoverConfiguredAgents(alternate).directory, home);

	// A valid default definition cannot mask a broken override.
	mkdirSync(alternate.defaultAgents);
	writeFileSync(join(alternate.defaultAgents, "default.md"), "---\nname: default\ndescription: Default agent\n---\nWork\n");
	for (const invalid of [null, [], { agents: [] }, { agents: "" }, { agents: "~other/agents" }, { agent: custom }]) {
		configure(invalid);
		const discovery = discoverConfiguredAgents(alternate);
		assert.deepEqual(discovery.names, []);
		assert.equal(discovery.directory, undefined);
		assert.match(discovery.errors[0], /agent-config\.json/);
	}
	writeFileSync(alternate.agentsConfig, "{");
	assert.match(discoverConfiguredAgents(alternate).errors[0], /agent-config\.json/);
	for (const invalidPath of [join(temp, "missing"), alternate.agentsConfig]) {
		configure({ agents: invalidPath });
		const discovery = discoverConfiguredAgents(alternate);
		assert.equal(discovery.directory, invalidPath);
		assert.deepEqual(discovery.names, []);
		assert.match(discovery.errors[0], /Cannot read agent directory/);
	}
	if (typeof process.getuid !== "function" || process.getuid() !== 0) {
		configure({ agents: custom });
		chmodSync(custom, 0o000);
		assert.match(discoverConfiguredAgents(alternate).errors[0], /Cannot read agent directory/);
		chmodSync(custom, 0o700);
		chmodSync(alternate.agentsConfig, 0o000);
		assert.match(discoverConfiguredAgents(alternate).errors[0], /agent-config\.json/);
		chmodSync(alternate.agentsConfig, 0o600);
	}
	rmSync(alternate.agentsConfig);
	symlinkSync(join(temp, "absent.json"), alternate.agentsConfig);
	assert.match(discoverConfiguredAgents(alternate).errors[0], /agent-config\.json/);
	rmSync(alternate.agentsConfig);

	configure({ agents: custom });
	const handlers = new Map<string, Function>();
	let command: any;
	agentConfig({
		on(event: string, handler: Function) { handlers.set(event, handler); },
		registerCommand(_name: string, definition: unknown) { command = definition; },
	} as unknown as ExtensionAPI);
	const ctx = { hasUI: true, ui: { notify(message: string) { diagnostics = message; } } };
	let diagnostics = "";
	assert.deepEqual(handlers.get("input")!({}, ctx), { action: "continue" });
	assert.equal(handlers.get("before_agent_start")!({ systemPrompt: "base" }).systemPrompt, "base");
	configure({ agents: paths.defaultAgents });
	await command.handler("", ctx);
	assert.match(diagnostics, /agents \(subagents\): custom/);
	assert.ok(diagnostics.includes(`agent directory: ${custom}`));
	assert.deepEqual(discoverConfiguredAgents(alternate).names, ["default"]);

	writeFileSync(alternate.root, "@./missing.md\n");
	assert.deepEqual(handlers.get("input")!({}, ctx), { action: "handled" });
	assert.match(diagnostics, /Agent config blocked/);
	rmSync(alternate.root);
	configure({ agents: join(temp, "missing") });
	const state = loadAgentConfig(alternate, home);
	assert.equal(state.ok, true);
	assert.ok(formatDiagnostics(alternate, state).includes(`agent directory: ${resolve(temp, "missing")}`));
	assert.match(formatDiagnostics(alternate, state), /agent errors:/);
	console.log("all agent configuration path checks passed");
} finally {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(temp, { recursive: true, force: true });
}
