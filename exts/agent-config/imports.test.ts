/**
 * Smoke tests for shared agent configuration. Run with:
 *   ./scripts/test exts/agent-config
 */

import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendAgentConfig,
	formatDiagnostics,
	loadAgentConfig,
} from "./index.ts";
import { resolveImports } from "./imports.ts";
import { discoverAgents } from "./agents.ts";
import { agentConfigPaths } from "./config.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
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

const temp = mkdtempSync(join(tmpdir(), "pi-agent-config-test-"));
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

try {
	const plain = file("plain.md", "plain text\n");
	check("file without imports", resolveImports(plain, { homeDir: home }).content === "plain text\n");

	file("nested/leaf.md", "leaf");
	file("nested/middle.md", "middle start\n@./leaf.md\nmiddle end\n");
	const nested = file("nested-root.md", "root start\n@./nested/middle.md\nroot end\n");
	const nestedResult = resolveImports(nested, { homeDir: home });
	check(
		"nested relative imports preserve order",
		nestedResult.content === "root start\nmiddle start\nleaf\nmiddle end\nroot end\n",
	);
	check("source list follows expansion order", nestedResult.files.map((path) => path.split("/").at(-1)).join(",") === "nested-root.md,middle.md,leaf.md");

	writeFileSync(join(home, "local.md"), "local instructions\n");
	const homeRoot = file("home-root.md", "@~/local.md\n");
	check("home-relative import", resolveImports(homeRoot, { homeDir: home }).content === "local instructions\n");
	expectError("unsupported named-home import", () => resolveImports(file("named-home.md", "@~other/x.md\n"), { homeDir: home }), "Unsupported home-relative import");

	const fenced = file("fenced.md", "```markdown\n@./missing.md\n```\n@./nested/leaf.md\n");
	check("fenced imports stay literal", resolveImports(fenced, { homeDir: home }).content === "```markdown\n@./missing.md\n```\nleaf\n");

	const shared = file("shared.md", "shared");
	const alias = join(files, "shared-alias.md");
	symlinkSync(shared, alias);
	const duplicate = file("duplicate.md", "@./shared.md\nmiddle\n@./shared-alias.md\n");
	const duplicateResult = resolveImports(duplicate, { homeDir: home });
	check("duplicate imports expand once", duplicateResult.content === "shared\nmiddle\n");
	check("symlink aliases share one source entry", duplicateResult.files.length === 2);

	const directCycle = file("direct-cycle.md", "@./direct-cycle.md\n");
	expectError("direct cycle", () => resolveImports(directCycle, { homeDir: home }), "Import cycle detected");
	file("cycle-a.md", "@./cycle-b.md\n");
	const indirectCycle = file("cycle-b.md", "@./cycle-a.md\n");
	expectError("indirect cycle", () => resolveImports(indirectCycle, { homeDir: home }), "Import cycle detected");

	expectError("missing file", () => resolveImports(file("missing-root.md", "@./absent.md\n"), { homeDir: home }), "Cannot read imported file");
	const directory = join(files, "directory");
	mkdirSync(directory);
	expectError("directory import", () => resolveImports(file("directory-root.md", "@./directory\n"), { homeDir: home }), "is not a file");

	file("depth-3.md", "bottom\n");
	file("depth-2.md", "@./depth-3.md\n");
	file("depth-1.md", "@./depth-2.md\n");
	const depthRoot = file("depth-0.md", "@./depth-1.md\n");
	expectError("maximum depth", () => resolveImports(depthRoot, { homeDir: home, maxDepth: 2 }), "maximum depth of 2");
	expectError("invalid maximum depth", () => resolveImports(depthRoot, { homeDir: home, maxDepth: -1 }), "non-negative integer");

	const crlfChild = file("crlf-child.md", "inside");
	const crlfRoot = file("crlf-root.md", "before\r\n@./crlf-child.md\r\nafter");
	check("CRLF and missing final newline", resolveImports(crlfRoot, { homeDir: home }).content === "before\r\ninside\r\nafter");
	writeFileSync(crlfChild, "inside\n");
	check("import final newline is not doubled", resolveImports(file("newline-root.md", "@./crlf-child.md\nend\n"), { homeDir: home }).content === "inside\nend\n");

	if (typeof process.getuid !== "function" || process.getuid() !== 0) {
		const unreadable = file("unreadable.md", "secret");
		chmodSync(unreadable, 0o000);
		expectError("unreadable file", () => resolveImports(unreadable, { homeDir: home }), "Cannot read imported file");
		chmodSync(unreadable, 0o600);
	}

	const repository = join(temp, "repository");
	const agentDir = join(home, ".pi/agent");
	const paths = agentConfigPaths(agentDir);
	const absent = loadAgentConfig(paths, home);
	check("absent optional instructions permit an unchanged prompt", absent.ok && absent.files.length === 0 && appendAgentConfig("base", absent) === "base");
	check("absent root diagnostics are explicit", formatDiagnostics(paths, absent).includes("status: absent (optional)"));

	mkdirSync(paths.defaultAgents, { recursive: true });
	mkdirSync(join(repository, "agent-config"), { recursive: true });
	mkdirSync(join(home, ".config/agent-config"), { recursive: true });
	writeFileSync(join(home, ".config/agent-config/local.md"), "local\n");
	writeFileSync(join(repository, "agent-config/CONTEXT.md"), "@./shared.md\n@~/.config/agent-config/local.md\n");
	writeFileSync(join(repository, "agent-config/shared.md"), "shared\n");
	writeFileSync(paths.root, `@${join(repository, "agent-config/CONTEXT.md")}\n`);
	writeFileSync(join(paths.defaultAgents, "valid.md"), "---\nname: valid\ndescription: Valid agent\nmodel: inherit\ntools: \"Read, Bash, Grep, Glob\" # inspection only\n---\nBody\n");
	writeFileSync(join(paths.defaultAgents, "editable.md"), "---\nname: editable\ndescription: Editing agent\ntools:\n  - Read # inspect\n  - Edit\n  - Write\n---\nEdit files\n");
	writeFileSync(join(paths.defaultAgents, "commented.md"), "---\nname: \"commented\" # shared\ndescription: Commented agent # purpose\ntools: [Read, Grep, WebFetch] # inspect\n---\nInspect\n");
	writeFileSync(join(paths.defaultAgents, "empty.md"), "---\nname: empty\ndescription: No tools\ntools: []\n---\nAsk\n");
	writeFileSync(join(paths.defaultAgents, "unrestricted.md"), "---\nname: unrestricted\ndescription: Unrestricted agent\n---\nWork\n");
	writeFileSync(join(paths.defaultAgents, "invalid.md"), "Body only\n");
	writeFileSync(join(paths.defaultAgents, "malformed.md"), "---\nname: \"malformed\ndescription: Bad YAML\n---\nBody\n");
	writeFileSync(join(paths.defaultAgents, "unsupported.md"), "---\nname: unsupported\ndescription: Bad tools\ntools: Read, WebSearch\n---\nBody\n");
	writeFileSync(join(paths.defaultAgents, "ignored.txt"), "not an agent\n");

	const agents = discoverAgents(paths.defaultAgents);
	check("agent discovery lists valid Markdown definitions", agents.names.join(",") === "commented,editable,empty,unrestricted,valid");
	const validAgent = agents.definitions.find((definition) => definition.name === "valid");
	check(
		"agent discovery returns executable definitions",
		validAgent?.model === "inherit" && validAgent.systemPrompt === "Body",
	);
	check(
		"agent discovery maps Claude tool names to Pi tools",
		validAgent?.tools?.join(",") === "read,bash,grep,find,ls",
	);
	check(
		"agent discovery parses tool lists and YAML comments",
		agents.definitions.find((definition) => definition.name === "editable")?.tools?.join(",") === "read,edit,write" &&
			agents.definitions.find((definition) => definition.name === "commented")?.tools?.join(",") === "read,grep,web_fetch",
	);
	check(
		"agents without a tool list inherit normal tools",
		agents.definitions.find((definition) => definition.name === "unrestricted")?.tools === undefined,
	);
	check(
		"an empty tool list remains an explicit restriction",
		agents.definitions.find((definition) => definition.name === "empty")?.tools?.length === 0,
	);
	check(
		"agent discovery isolates invalid definitions",
		agents.errors.length === 3 &&
			agents.errors.some((error) => error.includes("invalid.md")) &&
			agents.errors.some((error) => error.includes("malformed.md")) &&
			agents.errors.some((error) => error.includes("unsupported tool")),
	);

	const state = loadAgentConfig(paths, home);
	check("configuration loads", state.ok && state.content === "shared\nlocal\n");
	if (state.ok) {
		const firstPrompt = appendAgentConfig("base", state);
		const secondPrompt = appendAgentConfig("base", state);
		check("prompt section is stable", firstPrompt === secondPrompt);
		check("prompt section appears once", (firstPrompt?.match(/<global_user_instructions>/g) ?? []).length === 1);
		check("diagnostics list imports", formatDiagnostics(paths, state).includes("shared.md"));
	}

	writeFileSync(paths.root, "@./not-there.md\n");
	const blocked = loadAgentConfig(paths, home);
	check("configuration errors are blocking", !blocked.ok);
	check("blocked configuration cannot build a prompt", appendAgentConfig("base", blocked) === undefined);
	check("blocked diagnostics include the error", formatDiagnostics(paths, blocked).includes("status: blocked"));

	writeFileSync(paths.root, "@./AGENT_CONFIG.md\n");
	check("root cycles block configuration", !loadAgentConfig(paths, home).ok);
	rmSync(paths.root);
	symlinkSync(join(agentDir, "missing.md"), paths.root);
	check("a dangling root symlink is blocking", !loadAgentConfig(paths, home).ok);
	rmSync(paths.root);
	mkdirSync(paths.root);
	check("a root directory is blocking", !loadAgentConfig(paths, home).ok);
	rmSync(paths.root, { recursive: true });
	if (typeof process.getuid !== "function" || process.getuid() !== 0) {
		writeFileSync(paths.root, "instructions\n");
		chmodSync(paths.root, 0o000);
		check("an unreadable root is blocking", !loadAgentConfig(paths, home).ok);
		chmodSync(paths.root, 0o600);
	}
} finally {
	rmSync(temp, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
