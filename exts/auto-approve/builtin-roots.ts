import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface Roots {
	writeRoots: string[];
	readRoots: string[];
}

/** Bundled grants must not depend on installation, cwd, home, or inherited config. */
export function loadBuiltinRoots(path: string | URL = new URL("./defaults.json", import.meta.url)): Roots {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("builtin roots: preset must be an object");
	}
	const preset = value as Record<string, unknown>;
	if ("imports" in preset) throw new Error("builtin roots: preset imports are unsupported");
	const roots = (field: keyof Roots): string[] => {
		if (!(field in preset)) return [];
		const entries = preset[field];
		if (!Array.isArray(entries) || !entries.every((root) => typeof root === "string")) {
			throw new Error(`builtin roots: ${field} must be an array of strings`);
		}
		for (const root of entries) {
			if (!isAbsolute(root) || resolve(root) !== root) {
				throw new Error(`builtin roots: ${field} must contain normalized absolute paths: ${root}`);
			}
		}
		return entries;
	};
	return { writeRoots: roots("writeRoots"), readRoots: roots("readRoots") };
}

/** Exact baseline subtraction preserves raw supplemental roots and their order. */
export function supplementalRoots(full: Roots, installReadRoots: string[], builtin: Roots): Roots {
	const writes = new Set(builtin.writeRoots);
	const reads = new Set([...installReadRoots, ...builtin.readRoots, ...builtin.writeRoots]);
	return {
		writeRoots: full.writeRoots.filter((root) => !writes.has(root)),
		readRoots: full.readRoots.filter((root) => !reads.has(root)),
	};
}
