import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export class ImportResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImportResolutionError";
	}
}

/**
 * Expand an import specifier declared by `importingFile`.
 *
 * `~` names the home directory, `~/...` is home-relative, absolute paths are
 * used as-is, and anything else resolves against the importing file's directory.
 */
export function expandImportPath(specifier: string, importingFile: string, homeDir: string): string {
	if (specifier === "~") return homeDir;
	if (specifier.startsWith("~/")) return resolve(homeDir, specifier.slice(2));
	if (specifier.startsWith("~")) {
		throw new ImportResolutionError(`Unsupported home-relative import "${specifier}" in ${importingFile}`);
	}
	return isAbsolute(specifier) ? resolve(specifier) : resolve(dirname(importingFile), specifier);
}

/** Validate that `path` names a readable file and return its canonical path. */
export function canonicalImportFile(path: string): string {
	let stats;
	try {
		stats = statSync(path);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new ImportResolutionError(`Cannot read imported file ${path}: ${detail}`);
	}

	if (!stats.isFile()) {
		throw new ImportResolutionError(`Imported path is not a file: ${path}`);
	}

	try {
		return realpathSync(path);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new ImportResolutionError(`Cannot resolve imported file ${path}: ${detail}`);
	}
}
