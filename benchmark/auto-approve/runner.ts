import { performance } from "node:perf_hooks";
import type { ClassifierApi, ClassifierModel, Model } from "@earendil-works/pi-ai";
import type { ApprovalGuidance } from "../../exts/shared/approval-guidance.ts";
import type { EvaluatorConfig } from "../../exts/auto-approve/config.ts";
import { evaluateSafety, type EvaluationResult, type EvaluatorContext } from "../../exts/auto-approve/evaluator.ts";
import { buildMatchInput, evaluatorInstructions } from "../../exts/auto-approve/rules.ts";
import { INSTALL_READ_ROOTS, sparseRealPath, type Case, type ModelIdentity, type Outcome, type TokenUsage } from "./contracts.ts";
import { loadBuiltinRoots } from "../../exts/auto-approve/builtin-roots.ts";
import { estimateCostUsd } from "./metrics.ts";

const builtinRoots = loadBuiltinRoots();

export function instructionsFor(value: Case): string[] {
	return evaluatorInstructions(buildMatchInput(value.tool, value.input), value.cwd, {
		writeRoots: [...builtinRoots.writeRoots, ...value.writeRoots],
		readRoots: [...INSTALL_READ_ROOTS, ...builtinRoots.readRoots, ...value.readRoots],
		matchedInstructions: value.matchedRules.map((rule) => rule.instructions),
		homeDir: value.home,
		realPath: sparseRealPath(value.realPaths ?? {}),
	});
}

/** All-zero SDK usage can mean an unreported/default-initialized response. */
export function tokenUsage(result: EvaluationResult): TokenUsage | null {
	const usage = result.attempt?.usage;
	if (!usage) return null;
	const number = (value: number): number | null => Number.isFinite(value) && value >= 0 ? value : null;
	const tokens = {
		input: number(usage.input), output: number(usage.output), cacheRead: number(usage.cacheRead),
		cacheWrite: number(usage.cacheWrite), totalTokens: number(usage.totalTokens),
	};
	return Object.values(tokens).some((value) => value !== null && value > 0) ? tokens : null;
}

/** Injectable evaluator; run.ts supplies a Jev closure for classifier runs. */
export type EvaluateFn = (
	model: Model<any> | ClassifierModel<ClassifierApi>,
	ctx: EvaluatorContext,
	toolName: string,
	input: Record<string, unknown>,
	config: EvaluatorConfig,
	instructions?: readonly string[],
	guidance?: ApprovalGuidance,
) => Promise<EvaluationResult>;

export interface RunOptions {
	cases: Case[];
	model: Model<any> | ClassifierModel<ClassifierApi>;
	modelRegistry: EvaluatorContext["modelRegistry"];
	effort: "low" | "medium" | "high";
	timeoutMs: number;
	repetitions: number;
	pricing: ModelIdentity["pricing"];
	signal?: AbortSignal;
	evaluate?: EvaluateFn;
	onProgress?: (caseId: string, repetition: number) => void;
}

/** Serial repetition-major scheduling, with no retries or verdict memoization. */
export async function runEvaluations(options: RunOptions): Promise<Outcome[]> {
	const outcomes: Outcome[] = [];
	const evaluate: EvaluateFn = options.evaluate ?? (evaluateSafety as EvaluateFn);
	const instructions = options.cases.map(instructionsFor);
	for (let repetition = 1; repetition <= options.repetitions; repetition++) {
		for (const [index, value] of options.cases.entries()) {
			options.signal?.throwIfAborted();
			options.onProgress?.(value.id, repetition);
			const start = performance.now();
			const result = await evaluate(options.model, {
				cwd: value.cwd, signal: options.signal, modelRegistry: options.modelRegistry,
			}, value.tool, value.input, {
				reasoningEffort: options.effort, timeoutMs: options.timeoutMs, memoize: false,
				backend: "chat", jev: { provider: "typesafe", model: "jev-latest" },
			}, instructions[index], value.sessionGuidance);
			options.signal?.throwIfAborted();
			const usage = tokenUsage(result);
			const failure = result.attempt?.failure;
			if (failure === "cancelled") throw new Error("benchmark cancelled");
			outcomes.push({
				caseId: value.id, repetition,
				elapsedMs: performance.now() - start,
				usage, estimatedCostUsd: estimateCostUsd(usage, options.pricing),
				responseModel: result.attempt?.responseModel ?? null,
				providerThinkingLevel: result.attempt?.providerThinkingLevel ?? null,
				stopReason: result.attempt?.stopReason ?? null,
				result: failure || result.cacheable === false
					? { kind: "failure", failure: failure ?? "error", detail: failureDetail(failure ?? "error") }
					: { kind: "verdict", verdict: result.decision, reason: result.reason },
			});
		}
	}
	return outcomes;
}

// Provider errors can contain credentials or request bodies; report typed categories only.
function failureDetail(kind: "timeout" | "parse" | "non-stop" | "error"): string {
	return {
		timeout: "Evaluation timed out", parse: "Evaluator returned an unparseable response",
		"non-stop": "Evaluator did not finish normally", error: "Evaluation request failed",
	}[kind];
}
