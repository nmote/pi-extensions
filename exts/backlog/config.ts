import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type GraphTheme = "light" | "dark";

export function isGraphTheme(value: unknown): value is GraphTheme {
	return value === "light" || value === "dark";
}

export function backlogConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, "extensions", "backlog.json");
}

export function loadBacklogConfig(path = backlogConfigPath()): { graphTheme: GraphTheme } {
	if (!existsSync(path)) return { graphTheme: "light" };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const candidate = raw.graphTheme ?? raw.theme;
		if (isGraphTheme(candidate)) return { graphTheme: candidate };
		if (candidate !== undefined) {
			console.error(`backlog: invalid graphTheme in ${path}, expected "light" or "dark"`);
		}
		return { graphTheme: "light" };
	} catch (error) {
		console.error(`backlog: could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return { graphTheme: "light" };
	}
}
