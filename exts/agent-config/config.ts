import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentDiscovery } from "./agents.ts";

export interface AgentConfigPaths {
	root: string;
	agentsConfig: string;
	defaultAgents: string;
}

export interface ConfiguredAgentDiscovery extends AgentDiscovery {
	directory: string | undefined;
}

export function agentConfigPaths(agentDir = getAgentDir()): AgentConfigPaths {
	return {
		root: resolve(agentDir, "AGENT_CONFIG.md"),
		agentsConfig: resolve(agentDir, "extensions", "agent-config.json"),
		defaultAgents: resolve(agentDir, "agents"),
	};
}

// A dangling symlink is a present, broken configuration, not an absent optional file.
export function optionalFileExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function discoverConfiguredAgents(
	paths = agentConfigPaths(),
	homeDir = homedir(),
): ConfiguredAgentDiscovery {
	let directory: string | undefined;
	try {
		let configured = false;
		if (optionalFileExists(paths.agentsConfig)) {
			const settings: unknown = JSON.parse(readFileSync(paths.agentsConfig, "utf8").replace(/^\uFEFF/, ""));
			if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
				Object.keys(settings).some((key) => key !== "agents")) {
				throw new Error('expected an object with only the optional "agents" directory');
			}
			if ("agents" in settings) {
				const value = settings.agents;
				if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
					throw new Error('"agents" must be a non-empty directory path');
				}
				if (value === "~") directory = homeDir;
				else if (value.startsWith("~/")) directory = resolve(homeDir, value.slice(2));
				else if (value.startsWith("~")) throw new Error(`unsupported home-relative path ${JSON.stringify(value)}`);
				else directory = resolve(dirname(paths.agentsConfig), value);
				configured = true;
			}
		}
		directory ??= paths.defaultAgents;
		return { directory, ...discoverAgents(directory, { allowMissing: !configured }) };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { directory, names: [], definitions: [], errors: [`${paths.agentsConfig}: ${detail}`] };
	}
}
