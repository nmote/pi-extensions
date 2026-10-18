import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function directory(): string {
	return join(getAgentDir(), "extensions", "auto-approve-guidance");
}

export function validatePresetName(name: string): void {
	if (!NAME.test(name)) throw new Error("Preset names must be 1–64 letters, digits, underscores, or hyphens, starting with a letter or digit");
}

function presetPath(name: string): string {
	validatePresetName(name);
	return join(directory(), `${name}.txt`);
}

export function listGuidancePresets(): string[] {
	try {
		return readdirSync(directory()).filter((file) => file.endsWith(".txt") && NAME.test(file.slice(0, -4)))
			.map((file) => file.slice(0, -4)).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export function loadGuidancePreset(name: string): string {
	return readFileSync(presetPath(name), "utf8");
}

export function saveGuidancePreset(name: string, text: string): void {
	const path = presetPath(name);
	if (!text.trim()) throw new Error("Cannot save empty guidance as a preset");
	mkdirSync(directory(), { recursive: true, mode: 0o700 });
	const temp = join(directory(), `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

export function deleteGuidancePreset(name: string): void {
	rmSync(presetPath(name));
}
