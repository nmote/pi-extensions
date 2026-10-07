import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface LimitsConfig {
	autoPause: boolean;
	pauseAtPercent: number;
}

export const DEFAULT_CONFIG: LimitsConfig = { autoPause: true, pauseAtPercent: 3 };

export function configPath(): string {
	return join(getAgentDir(), "extensions", "openai-limits.json");
}

export function loadConfig(path = configPath()): LimitsConfig {
	try {
		const data = JSON.parse(readFileSync(path, "utf8"));
		if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected an object");
		return {
			autoPause: typeof data.autoPause === "boolean" ? data.autoPause : DEFAULT_CONFIG.autoPause,
			pauseAtPercent: typeof data.pauseAtPercent === "number" && Number.isFinite(data.pauseAtPercent)
				&& data.pauseAtPercent >= 0 && data.pauseAtPercent < 100 ? data.pauseAtPercent : DEFAULT_CONFIG.pauseAtPercent,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`openai-limits: could not read ${path}`);
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: LimitsConfig, path = configPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
