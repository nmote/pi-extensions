/**
 * Configuration loading for the auto-approve extension.
 *
 * Config lives at ~/.pi/agent/extensions/auto-approve.json, outside project
 * control. Everything is optional and merged over conservative engine defaults.
 * First session startup seeds a bundled-policy import.
 *
 * A config may declare `imports` (file paths or `builtin:defaults`). Each import loads
 * first and is merged underneath this file's own values, so a machine-specific
 * config can layer local rules over a shared, version-controlled one.
 */

import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { canonicalImportFile, expandImportPath, ImportResolutionError } from "../shared/import-path.ts";

export type Mode = "manual" | "auto" | "yolo";

export const MODES: Mode[] = ["manual", "auto", "yolo"];
export const EFFORTS: EvaluatorConfig["reasoningEffort"][] = ["low", "medium", "high"];

export function isMode(value: unknown): value is Mode {
	return typeof value === "string" && (MODES as string[]).includes(value);
}

export function isEffort(value: unknown): value is EvaluatorConfig["reasoningEffort"] {
	return typeof value === "string" && (EFFORTS as string[]).includes(value);
}

/**
 * A matcher describes a tool call to allow or deny.
 *
 * - `tool`: tool name ("bash", "read", "write", "edit", ...) or "*" for any tool.
 * - `pattern`: a JavaScript regular expression (as a string). For `bash` it is
 *   REQUIRED. Allow rules match the full command; deny and context rules also
 *   match approximate commands extracted from compound shell syntax. For other
 *   tools it is optional and matched against the primary path/argument.
 * - `allowShellOperators`: bash allow-list only. By default an allow entry never
 *   matches a command containing shell operators (`;`, `&&`, `||`, `|`,
 *   backticks, `$(`, `${`, redirects, newlines). Set true to opt a specific
 *   allow entry out of that guard. Deny entries always ignore this field and
 *   continue matching commands with operators.
 */
export interface Matcher {
	tool: string;
	pattern?: string;
	allowShellOperators?: boolean;
	description?: string;
}

/** A matcher that supplies trusted instructions to the safety evaluator. */
export type ContextRule = Pick<Matcher, "tool" | "pattern" | "description"> & {
	instructions: string;
};

/**
 * Evaluator tuning. The evaluation model itself is the shared small model
 * (see shared/small-model.ts, managed via /small-model).
 */
export interface EvaluatorConfig {
	/** Reasoning effort for the evaluator call. */
	reasoningEffort: "low" | "medium" | "high";
	/** Per-evaluation timeout in milliseconds. */
	timeoutMs: number;
	/** Cache evaluator outputs for exact commands in the current session. */
	memoize: boolean;
}

export interface AutoApproveConfig {
	defaultMode: Mode;
	allow: Matcher[];
	deny: Matcher[];
	/** Matching rules whose instructions supplement the evaluator prompt. */
	context: ContextRule[];
	/** Extra roots (beyond cwd) where write/edit is auto-approved. `~` expands to the home directory. */
	writeRoots: string[];
	/** Extra roots where read is auto-approved, in addition to cwd and write roots. `~` expands. */
	readRoots: string[];
	evaluator: EvaluatorConfig;
}

const BUNDLED_DEFAULTS_PATH = fileURLToPath(new URL("./defaults.json", import.meta.url));

function engineDefaults(): Pick<AutoApproveConfig, "defaultMode" | "evaluator"> {
	const raw = readRawConfig(BUNDLED_DEFAULTS_PATH);
	const evaluator = raw.evaluator as Partial<EvaluatorConfig> | undefined;
	if (!isMode(raw.defaultMode) || !evaluator || !isEffort(evaluator.reasoningEffort) ||
		typeof evaluator.timeoutMs !== "number" || !Number.isFinite(evaluator.timeoutMs) || evaluator.timeoutMs <= 0 ||
		typeof evaluator.memoize !== "boolean") {
		throw new ImportResolutionError("auto-approve: invalid bundled engine settings");
	}
	return { defaultMode: raw.defaultMode, evaluator: evaluator as EvaluatorConfig };
}

export function configPath(): string {
	return join(getAgentDir(), "extensions", "auto-approve.json");
}

export const FIRST_TIME_CONFIG = {
	imports: ["builtin:defaults"],
	allow: [],
	deny: [],
	context: [],
	writeRoots: [],
	readRoots: [],
	evaluator: {},
};

function configExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Publish a complete template without replacing existing files, including symlinks. */
export function seedConfig(path = configPath()): void {
	if (configExists(path)) return;
	mkdirSync(dirname(path), { recursive: true });
	const temporary = mkdtempSync(join(dirname(path), ".auto-approve-"));
	try {
		const staged = join(temporary, "config.json");
		writeFileSync(staged, `${JSON.stringify(FIRST_TIME_CONFIG, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		try {
			linkSync(staged, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

/** Persist a local override without changing imported policy files. */
export function saveEvaluatorEffort(effort: EvaluatorConfig["reasoningEffort"], path = configPath()): void {
	const raw = existsSync(path) ? readRawConfig(path) : {};
	const evaluator = raw.evaluator && typeof raw.evaluator === "object" && !Array.isArray(raw.evaluator)
		? raw.evaluator as Record<string, unknown>
		: {};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...raw, evaluator: { ...evaluator, reasoningEffort: effort } }, null, 2)}\n`);
}

function asMatchers(value: unknown): Matcher[] {
	if (!Array.isArray(value)) return [];
	return value.filter((m): m is Matcher => !!m && typeof m === "object" && typeof (m as Matcher).tool === "string");
}

function asStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function asContextRules(value: unknown): ContextRule[] {
	return asMatchers(value).filter(
		(rule): rule is ContextRule => typeof (rule as Partial<ContextRule>).instructions === "string",
	);
}

/** A config file as parsed, before validation. Values stay `unknown` until the merged result is normalized. */
export interface RawConfig {
	imports?: unknown;
	defaultMode?: unknown;
	allow?: unknown;
	deny?: unknown;
	context?: unknown;
	writeRoots?: unknown;
	readRoots?: unknown;
	evaluator?: unknown;
}

const MAX_IMPORT_DEPTH = 10;

function readRawConfig(path: string): RawConfig {
	let source: string;
	try {
		source = readFileSync(path, "utf-8");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new ImportResolutionError(`auto-approve: cannot read ${path}: ${detail}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new ImportResolutionError(`auto-approve: could not parse ${path}: ${detail}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ImportResolutionError(`auto-approve: config must be a JSON object: ${path}`);
	}
	return parsed as RawConfig;
}

function importSpecifiers(raw: RawConfig): string[] {
	const imports = raw.imports;
	if (imports === undefined) return [];
	if (!Array.isArray(imports)) {
		throw new ImportResolutionError('auto-approve: "imports" must be an array of path strings');
	}
	const specifiers = imports.filter((entry): entry is string => typeof entry === "string");
	if (specifiers.length !== imports.length) {
		throw new ImportResolutionError('auto-approve: "imports" must be an array of path strings');
	}
	return specifiers;
}

/**
 * Merge `overlay` onto `base`. List fields concatenate (imports first, local
 * last), `defaultMode` is overridden, `evaluator` merges per field, and the
 * `imports` directive is dropped from the effective config.
 */
export function mergeRaw(base: RawConfig, overlay: RawConfig): RawConfig {
	const result: RawConfig = {};

	for (const key of ["allow", "deny", "context", "writeRoots", "readRoots"] as const) {
		const left = Array.isArray(base[key]) ? base[key] : [];
		const right = Array.isArray(overlay[key]) ? overlay[key] : [];
		if (left.length > 0 || right.length > 0) result[key] = [...left, ...right];
	}

	if (overlay.defaultMode !== undefined) result.defaultMode = overlay.defaultMode;
	else if (base.defaultMode !== undefined) result.defaultMode = base.defaultMode;

	const leftEval = base.evaluator && typeof base.evaluator === "object" ? (base.evaluator as Record<string, unknown>) : {};
	const rightEval = overlay.evaluator && typeof overlay.evaluator === "object" ? (overlay.evaluator as Record<string, unknown>) : {};
	const evaluator = { ...leftEval, ...rightEval };
	if (Object.keys(evaluator).length > 0) result.evaluator = evaluator;

	return result;
}

/**
 * Resolve one config file, merging its imports (depth-first, deduplicated,
 * cycle- and depth-checked) underneath its own values. Throws on any failure;
 * callers handle that by failing closed.
 */
function resolveRawConfig(
	path: string,
	homeDir: string,
	depth: number,
	ancestors: string[],
	seen: Set<string>,
): RawConfig {
	if (depth > MAX_IMPORT_DEPTH) {
		throw new ImportResolutionError(`auto-approve: import nesting exceeds the maximum depth of ${MAX_IMPORT_DEPTH}: ${path}`);
	}

	const file = canonicalImportFile(path);
	const cycleStart = ancestors.indexOf(file);
	if (cycleStart !== -1) {
		const cycle = [...ancestors.slice(cycleStart), file].join(" -> ");
		throw new ImportResolutionError(`auto-approve: import cycle detected: ${cycle}`);
	}
	if (seen.has(file)) return {};

	seen.add(file);
	const raw = readRawConfig(file);
	const nextAncestors = [...ancestors, file];

	let merged: RawConfig = {};
	for (const specifier of importSpecifiers(raw)) {
		let importedPath: string;
		if (specifier === "builtin:defaults") importedPath = BUNDLED_DEFAULTS_PATH;
		else if (specifier.startsWith("builtin:")) {
			throw new ImportResolutionError(`auto-approve: unknown builtin import "${specifier}" in ${file}`);
		} else importedPath = expandImportPath(specifier, file, homeDir);
		const imported = resolveRawConfig(importedPath, homeDir, depth + 1, nextAncestors, seen);
		merged = mergeRaw(merged, imported);
	}
	return mergeRaw(merged, raw);
}

/** Resolve a config file plus its import graph into a single merged raw config. */
export function resolveConfig(rootPath: string, homeDir: string): RawConfig {
	return resolveRawConfig(rootPath, homeDir, 0, [], new Set<string>());
}

export function loadConfig({ seed = false } = {}): AutoApproveConfig {
	const path = configPath();
	let raw: RawConfig;
	let defaults: Pick<AutoApproveConfig, "defaultMode" | "evaluator"> | undefined;

	try {
		defaults = engineDefaults();
		if (seed) seedConfig(path);
		raw = configExists(path) ? resolveConfig(path, homedir()) : {};
	} catch (error) {
		// A partial or unavailable policy cannot grant permissions.
		console.error(`auto-approve: configuration unavailable, failing closed to manual mode: ${error instanceof Error ? error.message : String(error)}`);
		return {
			defaultMode: "manual", allow: [], deny: [], context: [], writeRoots: [], readRoots: [],
			// Manual mode does not evaluate unmatched calls.
			evaluator: defaults?.evaluator ?? { reasoningEffort: "low", timeoutMs: 0, memoize: false },
		};
	}

	const rawEval = (raw.evaluator && typeof raw.evaluator === "object" ? raw.evaluator : {}) as Partial<EvaluatorConfig>;

	return {
		defaultMode: isMode(raw.defaultMode) ? raw.defaultMode : defaults.defaultMode,
		allow: asMatchers(raw.allow),
		deny: asMatchers(raw.deny),
		context: asContextRules(raw.context),
		writeRoots: asStrings(raw.writeRoots),
		readRoots: asStrings(raw.readRoots),
		evaluator: {
			reasoningEffort: isEffort(rawEval.reasoningEffort) ? rawEval.reasoningEffort : defaults.evaluator.reasoningEffort,
			timeoutMs: typeof rawEval.timeoutMs === "number" && Number.isFinite(rawEval.timeoutMs) && rawEval.timeoutMs > 0 ? rawEval.timeoutMs : defaults.evaluator.timeoutMs,
			memoize: typeof rawEval.memoize === "boolean" ? rawEval.memoize : defaults.evaluator.memoize,
		},
	};
}
