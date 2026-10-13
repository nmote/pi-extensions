/**
 * Public contracts for the auto-approve evaluator benchmark: the case
 * dataset schema and loader, the run-result schema, and the deterministic
 * fictional replay environment. Shared field shapes (verdict, effort,
 * guidance snapshot) come from exts/auto-approve/eval-log.ts; replay prompt
 * construction comes from the pure functions in exts/auto-approve/rules.ts and
 * evaluator.ts. See README.md for the format, coverage boundaries, and the
 * fictional-universe convention.
 */

import { isAbsolute, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { effortSchema, guidanceSchema, verdictSchema } from "../../exts/auto-approve/eval-log.ts";
import { loadBuiltinRoots } from "../../exts/auto-approve/builtin-roots.ts";
import { resolveRoot } from "../../exts/auto-approve/rules.ts";

export const CASE_SCHEMA_VERSION = 1;
export const RUN_RESULT_SCHEMA_VERSION = 1;

/** Identifies the fictional installation mapping and bundled-root replay baseline. */
export const SUBSTITUTION_ID = "fictional-install-v2";

/**
 * Fixed fictional installation. The runner maps every installation root the
 * extension reads onto these paths; no real filesystem, local policy, home
 * directory, or live session state enters a run. The install-doc roots sit
 * under the agent dir, mirroring the production layout where the running
 * package is installed beneath the agent directory.
 */
export const FICTIONAL_INSTALL = {
	home: "/home/dev",
	agentDir: "/home/dev/.pi/agent",
	skillsDir: "/home/dev/.pi/agent/skills",
	readmePath: "/home/dev/.pi/agent/README.md",
	docsPath: "/home/dev/.pi/agent/docs",
	examplesPath: "/home/dev/.pi/agent/examples",
	changelogPath: "/home/dev/.pi/agent/CHANGELOG.md",
} as const;

export const INSTALL_READ_ROOTS = [
	FICTIONAL_INSTALL.skillsDir, FICTIONAL_INSTALL.readmePath, FICTIONAL_INSTALL.docsPath,
	FICTIONAL_INSTALL.examplesPath, FICTIONAL_INSTALL.changelogPath,
];

const builtinRoots = loadBuiltinRoots();

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** A context rule matched at curation time; instructions are data and the match is never recomputed. */
const matchedRuleSchema = Type.Object(
	{
		description: Type.Optional(Type.String()),
		instructions: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const caseSchema = Type.Object(
	{
		schemaVersion: Type.Literal(CASE_SCHEMA_VERSION),
		/** Stable identifier; never reuse an id after changing a case's meaning. */
		id: Type.String({ minLength: 1 }),
		tool: Type.String({ minLength: 1 }),
		input: Type.Record(Type.String(), Type.Unknown()),
		/** Fictional absolute working directory. */
		cwd: Type.String({ minLength: 1 }),
		/** Fictional absolute home directory. */
		home: Type.String({ minLength: 1 }),
		/** Supplemental roots; relative and `~` forms resolve against the case cwd/home at run time. */
		writeRoots: Type.Array(Type.String()),
		readRoots: Type.Array(Type.String()),
		matchedRules: Type.Array(matchedRuleSchema),
		/** Sparse symlink facts; null marks an unresolvable path. */
		realPaths: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
		/** Case-specific trusted session authorization; standard extension guidance is never stored. */
		sessionGuidance: Type.Optional(guidanceSchema),
		/** Intended policy including session authorization, not a model verdict. */
		expected: verdictSchema,
		rationale: Type.String({ minLength: 1 }),
		tags: Type.Optional(Type.Array(Type.String())),
		/** Id of the other member of a contrast pair. */
		pairWith: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export type Case = Static<typeof caseSchema>;

/** Order-independent canonical JSON, for comparing case fields structurally. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, entry) => {
		if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
			return Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort());
		}
		return entry;
	});
}

/** The replay-input fields contrast-pair members must share; everything else is free to differ. */
function sameReplayInputs(a: Case, b: Case): boolean {
	return (
		a.tool === b.tool &&
		canonical(a.input) === canonical(b.input) &&
		a.cwd === b.cwd &&
		a.home === b.home &&
		canonical(a.writeRoots) === canonical(b.writeRoots) &&
		canonical(a.readRoots) === canonical(b.readRoots) &&
		canonical(a.matchedRules) === canonical(b.matchedRules) &&
		canonical(a.realPaths ?? {}) === canonical(b.realPaths ?? {})
	);
}

/** RealPaths queries are built with resolve(), so only normalized absolute facts can ever match. */
function validateAbsoluteFields(value: Case): void {
	if (!isAbsolute(value.cwd) || resolve(value.cwd) !== value.cwd) {
		throw new Error(`case ${value.id}: cwd is not a normalized absolute path: ${value.cwd}`);
	}
	if (!isAbsolute(value.home) || resolve(value.home) !== value.home) {
		throw new Error(`case ${value.id}: home is not a normalized absolute path: ${value.home}`);
	}
	for (const [key, mapped] of Object.entries(value.realPaths ?? {})) {
		if (key === "/") throw new Error(`case ${value.id}: realPaths key cannot be the filesystem root`);
		if (!isAbsolute(key) || resolve(key) !== key) {
			throw new Error(`case ${value.id}: realPaths key is not a normalized absolute path: ${key}`);
		}
		if (mapped !== null && (!isAbsolute(mapped) || resolve(mapped) !== mapped)) {
			throw new Error(`case ${value.id}: realPaths value is not a normalized absolute path: ${mapped}`);
		}
	}
}

function validateDataset(cases: Case[]): void {
	const byId = new Map<string, Case>();
	for (const value of cases) {
		validateAbsoluteFields(value);
		for (const field of ["writeRoots", "readRoots"] as const) {
			const baseline = new Set(field === "writeRoots" ? builtinRoots.writeRoots
				: [...INSTALL_READ_ROOTS, ...builtinRoots.readRoots, ...builtinRoots.writeRoots]);
			for (const root of value[field]) {
				if (baseline.has(resolveRoot(root, value.cwd, value.home))) {
					throw new Error(`case ${value.id}: ${field} contains redundant builtin root: ${root}`);
				}
			}
		}
		if (byId.has(value.id)) throw new Error(`duplicate case id: ${value.id}`);
		byId.set(value.id, value);
	}
	for (const value of cases) {
		if (value.pairWith === undefined) continue;
		if (value.pairWith === value.id) throw new Error(`case ${value.id}: pairWith references itself`);
		const other = byId.get(value.pairWith);
		if (!other) throw new Error(`case ${value.id}: pairWith references unknown case: ${value.pairWith}`);
		if (other.pairWith !== value.id) {
			throw new Error(`case ${value.id}: pairWith is not mutual with case: ${other.id}`);
		}
		if (!sameReplayInputs(value, other)) {
			throw new Error(`contrast pair ${value.id}/${other.id}: replay inputs must be identical`);
		}
	}
}

/** Parse and validate a JSONL case dataset. Throws on any schema or invariant violation. */
export function loadCases(text: string): Case[] {
	const cases: Case[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch (error) {
			throw new Error(`cases line ${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!Value.Check(caseSchema, value)) {
			const first = [...Value.Errors(caseSchema, value)][0];
			throw new Error(
				`cases line ${index + 1}: does not match the case schema` +
				(first ? `: ${first.instancePath} ${first.message}` : ""),
			);
		}
		cases.push(value as Case);
	}
	if (cases.length === 0) throw new Error("cases: dataset is empty");
	validateDataset(cases);
	return cases;
}

// ---------------------------------------------------------------------------
// Symlink resolution from sparse facts
// ---------------------------------------------------------------------------

/** True when `ancestor` is `path` itself or a proper path-component prefix of `path`. */
function isAncestorOf(ancestor: string, path: string): boolean {
	return ancestor === path || path.startsWith(`${ancestor}/`);
}

/**
 * Symlink resolver backed by sparse case facts, mirroring realPathOf's
 * parent-recursive behavior: the longest listed ancestor (or the path itself)
 * maps the query; `null` anywhere on the chain is unresolvable; a path with no
 * listed ancestor resolves lexically to itself. A symlink cycle never resolves.
 */

/** Mirrors the kernel's symlink depth limit; realPathOf surfaces ELOOP as unresolvable. */
const MAX_SYMLINK_HOPS = 40;

export function sparseRealPath(realPaths: Record<string, string | null>): (abs: string) => string | undefined {
	const facts = new Map(Object.entries(realPaths));
	return (abs: string): string | undefined => {
		let current = abs;
		const seen = new Set<string>();
		// A mapping whose target lies under its own key grows the path forever, so the
		// hop cap bounds it just as the kernel bounds symlink chains.
		for (let hops = 0; ; hops++) {
			if (hops > MAX_SYMLINK_HOPS || seen.has(current)) return undefined;
			seen.add(current);
			let ancestor: string | undefined;
			let mapped: string | null | undefined;
			for (const [key, value] of facts) {
				if (isAncestorOf(key, current) && (ancestor === undefined || key.length > ancestor.length)) {
					ancestor = key;
					mapped = value;
				}
			}
			if (ancestor === undefined || mapped === undefined) return current;
			if (mapped === null) return undefined;
			// A proper-prefix remainder keeps its leading slash; a mapping to the
			// root `/` contributes nothing beyond that slash.
			const remainder = current.slice(ancestor.length);
			const resolved = ancestor === current ? mapped : mapped === "/" ? remainder : mapped + remainder;
			if (resolved === current) return current;
			current = resolved;
		}
	};
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

const count = Type.Number({ minimum: 0 });
const rate = Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]);

const nullableCount = Type.Union([count, Type.Null()]);
const nullableString = Type.Union([Type.String(), Type.Null()]);

export const tokenUsageSchema = Type.Object(
	{
		input: nullableCount,
		output: nullableCount,
		cacheRead: nullableCount,
		cacheWrite: nullableCount,
		totalTokens: nullableCount,
	},
	{ additionalProperties: false },
);
export type TokenUsage = Static<typeof tokenUsageSchema>;

export const modelIdentitySchema = Type.Object(
	{
		piCodingAgentVersion: Type.String({ minLength: 1 }),
		piAiVersion: Type.String({ minLength: 1 }),
		api: Type.String({ minLength: 1 }),
		reasoning: Type.Boolean(),
		input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
		contextWindow: count,
		maxTokens: count,
		/** Catalog rates in USD per million tokens; all-zero rates mean unknown pricing. */
		pricing: Type.Object(
			{
				input: count, output: count, cacheRead: count, cacheWrite: count,
				tiers: Type.Optional(Type.Array(Type.Object(
					{ inputTokensAbove: count, input: count, output: count, cacheRead: count, cacheWrite: count },
					{ additionalProperties: false },
				))),
			},
			{ additionalProperties: false },
		),
		catalogHash: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type ModelIdentity = Static<typeof modelIdentitySchema>;

/**
 * Distinct evaluator failure kinds. Failures are not model review judgments
 * and are excluded from verdict-metric denominators.
 */
export const failureKindSchema = Type.Union([
	Type.Literal("timeout"), Type.Literal("parse"), Type.Literal("non-stop"), Type.Literal("error"),
]);
export type FailureKind = Static<typeof failureKindSchema>;

/** One case × one repetition. */
export const outcomeSchema = Type.Object(
	{
		caseId: Type.String({ minLength: 1 }),
		repetition: Type.Integer({ minimum: 1 }),
		elapsedMs: count,
		usage: Type.Union([tokenUsageSchema, Type.Null()]),
		estimatedCostUsd: nullableCount,
		responseModel: nullableString,
		providerThinkingLevel: nullableString,
		stopReason: nullableString,
		result: Type.Union([
			Type.Object(
				{
					kind: Type.Literal("verdict"),
					verdict: verdictSchema,
					reason: Type.String(),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					kind: Type.Literal("failure"),
					failure: failureKindSchema,
					detail: Type.String(),
				},
				{ additionalProperties: false },
			),
		]),
	},
	{ additionalProperties: false },
);
export type Outcome = Static<typeof outcomeSchema>;

/** Metric fields shared by the aggregate and each baseline. `tp/fp/tn/fn` are review-positive. */
const metricProperties = {
	tp: count,
	fp: count,
	tn: count,
	fn: count,
	precision: rate,
	recall: rate,
	f2: rate,
	safeCaseAllowRate: rate,
};
const verdictMetrics = Type.Object(metricProperties, { additionalProperties: false });

export const runResultSchema = Type.Object(
	{
		schemaVersion: Type.Literal(RUN_RESULT_SCHEMA_VERSION),
		datasetIdentity: Type.Object(
			{
				caseIds: Type.Array(Type.String({ minLength: 1 })),
				count: Type.Integer({ minimum: 1 }),
				contentHash: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		/** Identifies the evaluator behavior under test. */
		evaluatorPolicyIdentity: Type.Object(
			{
				/** pi-extensions package version. */
				extensionVersion: Type.String({ minLength: 1 }),
				/** Hash of every .ts source under exts/auto-approve/. */
				sourcesHash: Type.String({ minLength: 1 }),
				/** Fictional substitution scheme id (SUBSTITUTION_ID). */
				substitution: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		provider: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 1 }),
		modelIdentity: modelIdentitySchema,
		effort: effortSchema,
		timeoutMs: Type.Number({ exclusiveMinimum: 0 }),
		repetitions: Type.Integer({ minimum: 1 }),
		startedAt: Type.Number({ minimum: 0 }),
		finishedAt: Type.Number({ minimum: 0 }),
		outcomes: Type.Array(outcomeSchema),
		aggregates: Type.Object(
			{
				...metricProperties,
				safeCaseAllows: count,
				safeCaseReviews: count,
				completed: count,
				failed: count,
				planned: count,
				attempted: count,
				valid: count,
				completionRate: rate,
				baselines: Type.Object(
					{
						alwaysReview: verdictMetrics,
						alwaysAllow: verdictMetrics,
					},
					{ additionalProperties: false },
				),
				/** Agreement among valid verdicts; failures are an independent case count. */
				consistency: Type.Object(
					{ insufficient: count, unanimous: count, mixed: count, withFailures: count },
					{ additionalProperties: false },
				),
				/** True when every case × repetition has an outcome. */
				complete: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
		usage: Type.Object(
			{
				/** Each token total is null if any attempt lacks that count. */
				total: tokenUsageSchema,
				usageAttempts: count,
				pricedAttempts: count,
				knownCostSubtotalUsd: count,
				totalEstimatedCostUsd: nullableCount,
				averageEstimatedCostUsd: nullableCount,
			},
			{ additionalProperties: false },
		),
		latency: Type.Object(
			{
				attempts: count,
				totalMs: count,
				averageMs: nullableCount,
				minMs: nullableCount,
				maxMs: nullableCount,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type RunResult = Static<typeof runResultSchema>;

export function isRunResult(value: unknown): value is RunResult {
	return Value.Check(runResultSchema, value);
}
