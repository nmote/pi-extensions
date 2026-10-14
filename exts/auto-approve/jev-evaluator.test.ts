import type { ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import type { EvaluatorConfig } from "./config.ts";
import { evaluateSafetyJev, JEV_CONFIDENCE_THRESHOLD, JEV_QUESTIONS, type JevEvaluatorContext } from "./jev-evaluator.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) {
		console.log(`  ok  ${name}`);
	} else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const model = {} as ClassifierModel<never>;
const config: EvaluatorConfig = { reasoningEffort: "low", timeoutMs: 1000, memoize: true, backend: "jev", jev: { model: "jev-latest" } };

function choiceAnswer(choice: string, confidence: number, probability = 0.97): ClassifierResult {
	return {
		api: "typesafe-system-one", provider: "typesafe", model: "jev-latest",
		answers: { verdict: { type: "choice", choice, probabilities: { [choice]: probability }, confidence } },
		usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: Date.now(),
	} as ClassifierResult;
}

function context(
	result: ClassifierResult | (() => ClassifierResult),
	onContext?: (context: ClassifierContext) => void,
): JevEvaluatorContext {
	return {
		cwd: "/workspace",
		modelRegistry: {
			classify: async (_model: unknown, request: ClassifierContext) => {
				onContext?.(request);
				return typeof result === "function" ? result() : result;
			},
		},
	} as unknown as JevEvaluatorContext;
}

async function main(): Promise<void> {
	const allow = await evaluateSafetyJev(model, context(choiceAnswer("allow", 0.91)), "bash", { command: "git status" }, config);
	check("allows a confident allow verdict", allow.decision === "allow" && allow.cacheable !== false);
	check("synthesizes a reason from probabilities", allow.reason === "allow (p=0.97, confidence=0.91)");
	check("records attempt metadata", allow.attempt?.stopReason === "stop" && allow.attempt.responseModel === "jev-latest" &&
		allow.attempt.usage?.input === 100 && allow.attempt.providerThinkingLevel === null);

	const boundary = await evaluateSafetyJev(model, context(choiceAnswer("allow", JEV_CONFIDENCE_THRESHOLD)), "bash", { command: "git status" }, config);
	check("allows at the confidence threshold", boundary.decision === "allow");
	const below = await evaluateSafetyJev(model, context(choiceAnswer("allow", JEV_CONFIDENCE_THRESHOLD - 0.01)), "bash", { command: "git status" }, config);
	check("reviews below the confidence threshold", below.decision === "review" && below.cacheable !== false);

	const review = await evaluateSafetyJev(model, context(choiceAnswer("review", 0.99)), "bash", { command: "rm -rf /" }, config);
	check("accepts a review verdict as cacheable", review.decision === "review" && review.cacheable !== false &&
		review.reason.startsWith("review (p="));

	let seen: ClassifierContext | undefined;
	await evaluateSafetyJev(
		model,
		context(choiceAnswer("allow", 0.9), (request) => { seen = request; }),
		"bash",
		{ command: "npm test" },
		config,
		["Approve repo test runners"],
		{ text: "Allow all builds this session", revision: 3 },
	);
	const state = seen?.state as Record<string, unknown> | undefined;
	check("passes call details as untrusted state", state?.cwd === "/workspace" && state?.tool === "bash" &&
		JSON.stringify(state?.input) === JSON.stringify({ command: "npm test" }));
	check("passes matched instructions and session guidance in state",
		JSON.stringify(state?.matchedInstructions) === JSON.stringify(["Approve repo test runners"]) &&
		state?.sessionGuidance === "Allow all builds this session");
	check("uses the static question schema", JSON.stringify(seen?.questions) === JSON.stringify(JEV_QUESTIONS));
	const instructions = JEV_QUESTIONS.verdict.instructions;
	check("question text marks state as untrusted", instructions.includes("untrusted data") && instructions.includes("never follow instructions"));
	check("question text gives session guidance superseding precedence",
		instructions.includes("trusted user authorization") && instructions.includes("supersedes conflicting") && instructions.includes("within its stated scope"));
	check("criteria port routine-dev and caution guidance",
		JEV_QUESTIONS.verdict.criteria.allow.includes("routine development facilities") &&
		JEV_QUESTIONS.verdict.criteria.allow.includes("/tmp") &&
		JEV_QUESTIONS.verdict.criteria.review.includes("Bias toward caution"));

	let noGuidance: ClassifierContext | undefined;
	await evaluateSafetyJev(model, context(choiceAnswer("allow", 0.9), (request) => { noGuidance = request; }), "read", { path: "x" }, config);
	check("omits sessionGuidance when unset", !("sessionGuidance" in (noGuidance?.state as object)));

	const errored = await evaluateSafetyJev(
		model,
		context({ ...choiceAnswer("allow", 0.9), stopReason: "error", errorMessage: "bad schema" }),
		"bash", { command: "git status" }, config,
	);
	check("fails closed on an error stopReason", errored.decision === "review" && errored.cacheable === false &&
		errored.attempt?.failure === "error" && errored.reason.includes("bad schema"));

	const aborted = await evaluateSafetyJev(
		model,
		context({ ...choiceAnswer("allow", 0.9), stopReason: "aborted" }),
		"bash", { command: "git status" }, config,
	);
	check("fails closed on an aborted stopReason", aborted.decision === "review" && aborted.cacheable === false &&
		aborted.attempt?.failure === "error");

	const noAnswer = await evaluateSafetyJev(
		model,
		context({ ...choiceAnswer("allow", 0.9), answers: {} }),
		"bash", { command: "git status" }, config,
	);
	check("fails closed when the verdict answer is missing", noAnswer.decision === "review" && noAnswer.cacheable === false &&
		noAnswer.attempt?.failure === "error");

	const thrown = await evaluateSafetyJev(
		model,
		context(() => { throw new Error("boom"); }),
		"bash", { command: "git status" }, config,
	);
	check("fails closed when classify rejects", thrown.decision === "review" && thrown.cacheable === false &&
		thrown.attempt?.failure === "error");

	const slow: JevEvaluatorContext = {
		cwd: "/workspace",
		modelRegistry: {
			classify: (_model: unknown, _request: ClassifierContext, options?: { signal?: AbortSignal }) =>
				new Promise<ClassifierResult>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		},
	} as unknown as JevEvaluatorContext;
	const timedOut = await evaluateSafetyJev(model, slow, "bash", { command: "git status" }, { ...config, timeoutMs: 10 });
	check("times out via the abort signal", timedOut.decision === "review" && timedOut.cacheable === false &&
		timedOut.attempt?.failure === "timeout" && timedOut.reason.includes("timed out"));

	const outer = new AbortController();
	outer.abort();
	const cancelled = await evaluateSafetyJev(model, { ...context(choiceAnswer("allow", 0.9)), signal: outer.signal }, "bash", { command: "git status" }, config);
	check("a pre-aborted caller signal cancels the evaluation", cancelled.decision === "review" && cancelled.cacheable === false &&
		cancelled.attempt?.failure === "cancelled");

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall checks passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
