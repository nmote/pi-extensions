import type { EvaluationResult } from "./evaluator.ts";
import { type MatchInput, signatureOf } from "./rules.ts";

export const EVALUATOR_CACHE_ENTRY = "auto-approve-evaluation";

export interface CachedEvaluation {
	tool: string;
	/** Exact command text for bash (or the primary subject for other tools). */
	command: string;
	/** Complete input prevents collisions between non-bash calls with the same subject. */
	input: Record<string, unknown>;
	/** Evaluator instructions used for this verdict. */
	instructions: string[];
	output: EvaluationResult;
}

function cacheKey(input: MatchInput, instructions: readonly string[]): string | undefined {
	let inputKey: string;
	if (input.tool === "bash") {
		inputKey = signatureOf(input);
	} else {
		try {
			inputKey = signatureOf({ tool: input.tool, subject: JSON.stringify(input.raw) });
		} catch {
			return undefined;
		}
	}
	return `${inputKey}\u0000${JSON.stringify(instructions)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeInstructions(value: unknown): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((instruction) => typeof instruction === "string")) return undefined;
	return value;
}

function normalizeEvaluationResult(value: unknown): EvaluationResult | undefined {
	if (!value || typeof value !== "object") return undefined;
	const output = value as { decision?: unknown; reason?: unknown; cacheable?: unknown };
	if (typeof output.reason !== "string" || output.cacheable === false) return undefined;
	if (output.decision === "allow" || output.decision === "review") {
		return { decision: output.decision, reason: output.reason };
	}
	if (output.decision === "block" || output.decision === "ask") {
		return { decision: "review", reason: output.reason };
	}
	return undefined;
}

export class EvaluatorCache {
	private readonly outputs = new Map<string, EvaluationResult>();

	get(input: MatchInput, instructions: readonly string[] = []): EvaluationResult | undefined {
		const key = cacheKey(input, instructions);
		return key === undefined ? undefined : this.outputs.get(key);
	}

	remember(
		input: MatchInput,
		output: EvaluationResult,
		instructions: readonly string[] = [],
	): CachedEvaluation | undefined {
		const key = cacheKey(input, instructions);
		if (key === undefined || output.cacheable === false) return undefined;
		this.outputs.set(key, output);
		return { tool: input.tool, command: input.subject, input: input.raw, instructions: [...instructions], output };
	}

	restore(value: unknown): boolean {
		if (!value || typeof value !== "object") return false;
		const entry = value as {
			tool?: unknown;
			command?: unknown;
			input?: unknown;
			instructions?: unknown;
			output?: unknown;
		};
		if (typeof entry.tool !== "string" || typeof entry.command !== "string" || !isRecord(entry.input)) {
			return false;
		}
		const instructions = normalizeInstructions(entry.instructions);
		const output = normalizeEvaluationResult(entry.output);
		if (!instructions || !output) return false;
		if (entry.tool === "bash" && entry.input.command !== entry.command) return false;
		const key = cacheKey({ tool: entry.tool, subject: entry.command, raw: entry.input }, instructions);
		if (key === undefined) return false;
		this.outputs.set(key, output);
		return true;
	}

	clear(): void {
		this.outputs.clear();
	}
}
