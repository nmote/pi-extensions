import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveImports, type ResolvedImports } from "./imports.ts";
import {
	agentConfigPaths,
	discoverConfiguredAgents,
	optionalFileExists,
	type AgentConfigPaths,
	type ConfiguredAgentDiscovery,
} from "./config.ts";

export type AgentConfigState =
	| ({ ok: true; agents: ConfiguredAgentDiscovery } & ResolvedImports)
	| { ok: false; error: string; agents: ConfiguredAgentDiscovery };

const PROMPT_START = "<global_user_instructions>";
const PROMPT_END = "</global_user_instructions>";

export function loadAgentConfig(
	paths: AgentConfigPaths,
	homeDir: string,
	agents = discoverConfiguredAgents(paths, homeDir),
): AgentConfigState {
	try {
		if (!optionalFileExists(paths.root)) return { ok: true, content: "", files: [], agents };
		return { ok: true, ...resolveImports(paths.root, { homeDir }), agents };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			agents,
		};
	}
}

export function appendAgentConfig(systemPrompt: string, state: AgentConfigState): string | undefined {
	if (!state.ok) return undefined;
	if (!state.content) return systemPrompt;
	const trailingNewline = state.content.endsWith("\n") || state.content.endsWith("\r") ? "" : "\n";
	return `${systemPrompt}\n\n${PROMPT_START}\n${state.content}${trailingNewline}${PROMPT_END}`;
}

export function formatDiagnostics(paths: AgentConfigPaths, state: AgentConfigState): string {
	const lines = [
		`root: ${paths.root}`,
		`status: ${state.ok ? state.files.length ? "loaded" : "absent (optional)" : "blocked"}`,
		`agent settings: ${paths.agentsConfig}`,
		`agent directory: ${state.agents.directory ?? "invalid configuration"}`,
		`agents (subagents): ${state.agents.names.length ? state.agents.names.join(", ") : "none"}`,
	];

	if (state.ok && state.files.length) lines.splice(2, 0, `imports:\n${state.files.map((file) => `  - ${file}`).join("\n")}`);
	else if (!state.ok) lines.splice(2, 0, `error: ${state.error}`);
	if (state.agents.errors.length) {
		lines.push(`agent errors:\n${state.agents.errors.map((error) => `  - ${error}`).join("\n")}`);
	}
	return lines.join("\n");
}

export default function agentConfigExtension(pi: ExtensionAPI): void {
	const home = homedir();
	const paths = agentConfigPaths();
	const agents = discoverConfiguredAgents(paths, home);
	let state = loadAgentConfig(paths, home, agents);

	const reload = (): AgentConfigState => {
		state = loadAgentConfig(paths, home, agents);
		return state;
	};

	pi.on("session_start", (_event, ctx) => {
		const loaded = reload();
		if (!loaded.ok && ctx.hasUI) ctx.ui.notify(`Agent config blocked: ${loaded.error}`, "error");
	});

	pi.on("input", (_event, ctx) => {
		const loaded = reload();
		if (loaded.ok) return { action: "continue" as const };

		const message = `Agent config blocked: ${loaded.error}`;
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		else process.stderr.write(`${message}\n`);
		return { action: "handled" as const };
	});

	pi.on("before_agent_start", (event) => {
		const systemPrompt = appendAgentConfig(event.systemPrompt, state);
		return systemPrompt === undefined ? undefined : { systemPrompt };
	});

	pi.registerCommand("agent-config", {
		description: "Show shared agent configuration status",
		handler: async (_args, ctx) => {
			const diagnostics = formatDiagnostics(paths, reload());
			const level = !state.ok ? "error" : state.agents.errors.length ? "warning" : "info";
			if (ctx.hasUI) ctx.ui.notify(diagnostics, level);
			else process.stdout.write(`${diagnostics}\n`);
		},
	});
}
