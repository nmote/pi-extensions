import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { EvaluatorConfig } from "./config.ts";
import { evaluateSafety } from "./evaluator.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) {
		console.log(`  ok  ${name}`);
	} else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const model = {} as Model<any>;
const config: EvaluatorConfig = { reasoningEffort: "low", timeoutMs: 1000, memoize: true };

function context(
	stopReason: string,
	decision: "allow" | "review" = "allow",
	onSystemPrompt?: (prompt: string) => void,
	onOptions?: (options: { reasoning?: string }) => void,
): ExtensionContext {
	const verdict = JSON.stringify({ decision, reason: decision === "allow" ? "safe" : "needs confirmation" });
	return {
		cwd: "/workspace",
		modelRegistry: {
			streamSimple: (_model: unknown, request: { systemPrompt: string }, options: { reasoning?: string }) => {
				onSystemPrompt?.(request.systemPrompt);
				onOptions?.(options);
				return { result: async () => ({ stopReason, content: [{ type: "text", text: verdict }] }) };
			},
		},
	} as unknown as ExtensionContext;
}

async function main(): Promise<void> {
	let reasoning: string | undefined;
	const completed = await evaluateSafety(
		model,
		context("stop", "allow", undefined, (options) => {
			reasoning = options.reasoning;
		}),
		"bash",
		{ command: "git status" },
		config,
	);
	check("accepts an allow verdict", completed.decision === "allow" && completed.cacheable !== false);
	check("requests the configured reasoning effort", reasoning === "low");

	const review = await evaluateSafety(model, context("stop", "review"), "bash", { command: "git status" }, config);
	check("accepts a review verdict", review.decision === "review" && review.reason === "needs confirmation");

	let systemPrompt = "";
	await evaluateSafety(
		model,
		context("stop", "allow", (prompt) => {
			systemPrompt = prompt;
		}),
		"pup_run",
		{ args: ["monitors", "list"] },
		config,
		["Approve only read-only pup commands"],
	);
	check(
		"adds matching context to the evaluator system prompt",
		systemPrompt.includes('"Approve only read-only pup commands"') &&
			systemPrompt.includes("trusted, user-configured") &&
			systemPrompt.includes("judge the entire tool call"),
	);

	const failed = await evaluateSafety(model, context("error"), "bash", { command: "git status" }, config);
	check("rejects partial output from failed evaluations", failed.decision === "review" && failed.cacheable === false);

	const aborted = await evaluateSafety(model, context("aborted"), "bash", { command: "git status" }, config);
	check("rejects partial output from aborted evaluations", aborted.decision === "review" && aborted.cacheable === false);

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
