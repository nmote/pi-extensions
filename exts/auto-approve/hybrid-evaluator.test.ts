import assert from "node:assert/strict";
import type { ClassifierApi, ClassifierModel, Model } from "@earendil-works/pi-ai";
import type { EvaluatorConfig } from "./config.ts";
import { evaluateSafetyHybrid, HYBRID_CONFIDENCE_THRESHOLD } from "./hybrid-evaluator.ts";

const classifier = { provider: "test", id: "jev" } as ClassifierModel<ClassifierApi>;
const chat = { provider: "test", id: "chat" } as Model<any>;
const config: EvaluatorConfig = {
	backend: "jev", jev: { provider: "test", model: "jev" },
	reasoningEffort: "medium", timeoutMs: 1000, memoize: false,
};

async function main(): Promise<void> {
	for (const choice of ["allow", "review"] as const) {
		for (const confidence of [0, HYBRID_CONFIDENCE_THRESHOLD - 0.001, HYBRID_CONFIDENCE_THRESHOLD, 1]) {
			let chatCalls = 0;
			const fallback = choice === "allow" ? "review" : "allow";
			const instructions = ["Approve authorized inspection"];
			const guidance = { text: "Allow test calls", revision: 1 };
			const ctx = {
				cwd: "/workspace",
				modelRegistry: {
					classify: async (_model: unknown, request: any) => {
						assert.deepEqual(request.state.matchedInstructions, instructions);
						assert.equal(request.state.sessionGuidance, guidance.text);
						return { stopReason: "stop", answers: { verdict: { type: "choice", choice, confidence, probabilities: { [choice]: 0.6 } } } };
					},
					streamSimple: (_model: unknown, request: any, options: any) => {
						chatCalls++;
						assert.ok(request.systemPrompt.includes(instructions[0]) && request.systemPrompt.includes(guidance.text));
						assert.ok(request.messages[0].content[0].text.includes("git status"));
						assert.equal(options.reasoning, "medium");
						return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ decision: fallback, reason: "chat rationale" }) }] }) };
					},
				},
			};
			const result = await evaluateSafetyHybrid(classifier, chat, ctx as any, "bash", { command: "git status" }, config, instructions, guidance);
			const routed = confidence < HYBRID_CONFIDENCE_THRESHOLD;
			assert.equal(result.decision, routed ? fallback : choice);
			assert.equal(chatCalls, routed ? 1 : 0);
			assert.equal(result.routing?.fallbackUsed, routed);
			assert.equal(result.routing?.confidence, confidence);
			assert.equal(result.routing?.classifierChoice, choice);
			assert.equal(!!result.routing?.chatAttempt, routed);
			if (routed) assert.equal(result.reason, "chat rationale");
		}
	}

	for (const failure of ["classifier", "chat", "cancelled"] as const) {
		let chatCalls = 0;
		const controller = new AbortController();
		const ctx = {
			cwd: "/workspace", signal: controller.signal,
			modelRegistry: {
				classify: async () => {
					if (failure === "classifier") throw new Error("classifier unavailable");
					if (failure === "cancelled") controller.abort();
					return { stopReason: "stop", answers: { verdict: { type: "choice", choice: "allow", confidence: 0.1, probabilities: { allow: 0.55 } } } };
				},
				streamSimple: () => { chatCalls++; throw new Error("chat unavailable"); },
			},
		};
		const result = await evaluateSafetyHybrid(classifier, chat, ctx as any, "bash", { command: "git status" }, config);
		assert.equal(result.decision, "review");
		assert.equal(result.cacheable, false);
		assert.equal(chatCalls, failure === "chat" ? 1 : 0);
		assert.equal(result.routing?.fallbackUsed, failure === "chat");
	}
	console.log("Hybrid routing and fail-closed checks passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
