/** Offline pooled metric checks. Run with ./scripts/test benchmark/auto-approve. */
import { strict as assert } from "node:assert";
import { CASE_SCHEMA_VERSION, isRunResult, RUN_RESULT_SCHEMA_VERSION, type Case, type Outcome, type RunResult } from "./contracts.ts";
import { calculateAggregates, estimateCostUsd, formatFullReport, formatSummary, summarizeLatency, summarizeUsage } from "./metrics.ts";

function test(name: string, fn: () => void): void {
	fn();
	console.log(`  ok  ${name}`);
}

function caseValue(id: string, expected: Case["expected"]): Case {
	return {
		schemaVersion: CASE_SCHEMA_VERSION, id, expected, tool: "bash", input: { command: "ls" },
		cwd: "/home/dev/work", home: "/home/dev", writeRoots: [], readRoots: [], matchedRules: [], rationale: "test",
	};
}

function outcome(caseId: string, repetition: number, verdict: Case["expected"] | null): Outcome {
	return {
		caseId, repetition, elapsedMs: 10, usage: null, estimatedCostUsd: null,
		responseModel: null, providerThinkingLevel: null, stopReason: verdict === null ? null : "stop",
		result: verdict === null ? { kind: "failure", failure: "timeout", detail: "slow" } : { kind: "verdict", verdict, reason: "test" },
	};
}

const cases = [caseValue("risky", "review"), caseValue("safe", "allow"), caseValue("risky2", "review")];
const outcomes = [
	outcome("risky", 1, "allow"), outcome("risky", 2, "review"), outcome("risky", 3, null),
	outcome("safe", 1, "allow"), outcome("safe", 2, "review"), outcome("safe", 3, "review"),
	outcome("risky2", 1, "review"), outcome("risky2", 2, "review"), outcome("risky2", 3, null),
];

test("pooled metrics exclude failures; consistency is independent of failures", () => {
	const a = calculateAggregates(cases, outcomes, 3);
	assert.deepEqual([a.tp, a.fp, a.tn, a.fn], [3, 2, 1, 1]);
	assert.equal(a.precision, 3 / 5);
	assert.equal(a.recall, 3 / 4);
	assert.equal(a.f2, 15 / 21);
	assert.equal(a.safeCaseAllowRate, 1 / 3);
	assert.equal(a.safeCaseAllows, 1);
	assert.equal(a.safeCaseReviews, 2);
	assert.deepEqual([a.planned, a.attempted, a.valid, a.completed, a.failed], [9, 9, 7, 7, 2]);
	assert.equal(a.completionRate, 7 / 9);
	assert.equal(a.complete, true);
	assert.deepEqual(a.consistency, { insufficient: 0, unanimous: 1, mixed: 2, withFailures: 2 });
	assert.deepEqual([a.baselines.alwaysReview.tp, a.baselines.alwaysReview.fp], [4, 3]);
	assert.deepEqual([a.baselines.alwaysAllow.tn, a.baselines.alwaysAllow.fn], [3, 4]);
	assert.equal(a.baselines.alwaysReview.f2, 20 / 23);
	assert.equal(a.baselines.alwaysAllow.f2, 0);
});

test("incomplete and one-valid cases have insufficient agreement", () => {
	const a = calculateAggregates(cases, [outcomes[0]!, outcomes[2]!], 3);
	assert.equal(a.complete, false);
	assert.equal(a.completionRate, 1 / 9);
	assert.equal(a.f2, 0);
	assert.equal(a.precision, null);
	assert.deepEqual(a.consistency, { insufficient: 3, unanimous: 0, mixed: 0, withFailures: 1 });
	const empty = calculateAggregates(cases, [], 3);
	assert.equal(empty.f2, null);
	assert.equal(empty.recall, null);
	assert.equal(empty.completionRate, 0);
	const safe = calculateAggregates([cases[1]!], [outcome("safe", 1, "allow")], 1);
	assert.equal(safe.f2, null);
	assert.equal(safe.consistency.insufficient, 1);
	assert.equal(safe.safeCaseAllowRate, 1);
});

test("invalid attempt identities cannot inflate completion", () => {
	assert.throws(() => calculateAggregates(cases, [outcomes[0]!, outcomes[0]!], 3), /duplicate outcome/);
	assert.throws(() => calculateAggregates(cases, [outcome("missing", 1, "allow")], 3), /unknown outcome/);
	assert.throws(() => calculateAggregates(cases, [outcome("safe", 4, "allow")], 3), /out of range/);
	assert.throws(() => calculateAggregates(cases, [], 0), /positive integer/);
});

const tokens = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160 };
const pricing = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 };

test("catalog estimates require known usage and nonzero pricing", () => {
	assert.ok(Math.abs(estimateCostUsd(tokens, pricing)! - 0.00017) < 1e-12);
	assert.equal(estimateCostUsd(tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), null);
	assert.equal(estimateCostUsd(null, pricing), null);
	assert.equal(estimateCostUsd({ ...tokens, cacheRead: null }, pricing), null);
	assert.ok(Math.abs(estimateCostUsd({ ...tokens, totalTokens: null }, pricing)! - 0.00017) < 1e-12);
});

test("tiers use cached input, strict thresholds, and the highest matching rate card", () => {
	const tiered = {
		...pricing,
		tiers: [
			{ inputTokensAbove: 150, input: 4, output: 8, cacheRead: 2, cacheWrite: 6 },
			{ inputTokensAbove: 100, input: 2, output: 4, cacheRead: 1, cacheWrite: 3 },
		],
	};
	// Total input is 140, not the uncached input of 100 or totalTokens of 160.
	assert.equal(estimateCostUsd(tokens, tiered), 0.00034);
	assert.equal(estimateCostUsd({ ...tokens, input: 60 }, tiered), 0.00013);
	assert.equal(estimateCostUsd({ ...tokens, input: 110 }, tiered), 0.00036);
	assert.equal(estimateCostUsd({ ...tokens, input: 111 }, tiered), 0.000724);
	assert.equal(estimateCostUsd({ ...tokens, cacheWrite: null }, tiered), null);
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	assert.equal(estimateCostUsd(tokens, { ...zero, tiers: tiered.tiers }), 0.00034);
	assert.equal(estimateCostUsd(tokens, { ...pricing, tiers: [{ ...zero, inputTokensAbove: 100 }] }), null);
});

test("all-failure attempts have null scores but still contribute known costs", () => {
	const failed = [{ ...outcome("risky", 1, null), usage: tokens, estimatedCostUsd: 0.2 }];
	const a = calculateAggregates([cases[0]!], failed, 1);
	assert.deepEqual([a.tp, a.fp, a.tn, a.fn], [0, 0, 0, 0]);
	assert.deepEqual([a.precision, a.recall, a.f2, a.safeCaseAllowRate], [null, null, null, null]);
	assert.equal(a.completionRate, 0);
	assert.equal(a.baselines.alwaysReview.f2, null);
	assert.equal(a.baselines.alwaysAllow.f2, null);
	const usage = summarizeUsage(failed);
	assert.equal(usage.pricedAttempts, 1);
	assert.equal(usage.usageAttempts, 1);
	assert.equal(usage.totalEstimatedCostUsd, 0.2);
	assert.equal(usage.averageEstimatedCostUsd, 0.2);
});

test("unknown costs do not masquerade as zero; averages use known costs", () => {
	const known = { ...outcomes[0]!, usage: tokens, estimatedCostUsd: 0.2 };
	const partial = { ...outcomes[1]!, usage: { ...tokens, output: null }, estimatedCostUsd: null };
	const usage = summarizeUsage([known, partial]);
	assert.deepEqual(usage, {
		total: { input: 200, output: null, cacheRead: 60, cacheWrite: 20, totalTokens: 320 },
		usageAttempts: 2, pricedAttempts: 1, knownCostSubtotalUsd: 0.2, totalEstimatedCostUsd: null, averageEstimatedCostUsd: 0.2,
	});
	assert.equal(summarizeUsage([known, { ...known, estimatedCostUsd: 0 }]).totalEstimatedCostUsd, 0.2);
	assert.equal(summarizeUsage([known, { ...known, estimatedCostUsd: 0 }]).averageEstimatedCostUsd, 0.1);
	const missing = summarizeUsage([outcomes[0]!]);
	assert.equal(missing.total.input, null);
	assert.equal(missing.usageAttempts, 0);
	assert.equal(missing.pricedAttempts, 0);
	assert.equal(missing.knownCostSubtotalUsd, 0);
	assert.equal(missing.totalEstimatedCostUsd, null);
	assert.equal(missing.averageEstimatedCostUsd, null);
	const empty = summarizeUsage([]);
	assert.equal(empty.totalEstimatedCostUsd, 0);
	assert.equal(empty.averageEstimatedCostUsd, null);
});

test("latency includes failed attempts and handles empty runs", () => {
	assert.deepEqual(summarizeLatency([{ ...outcomes[0]!, elapsedMs: 0 }, { ...outcomes[2]!, elapsedMs: 40 }]), {
		attempts: 2, totalMs: 40, averageMs: 20, minMs: 0, maxMs: 40,
	});
	assert.deepEqual(summarizeLatency([]), { attempts: 0, totalMs: 0, averageMs: null, minMs: null, maxMs: null });
});

test("derived report matches schema and human summary names unknown cost", () => {
	const report: RunResult = {
		schemaVersion: RUN_RESULT_SCHEMA_VERSION,
		datasetIdentity: { caseIds: cases.map((value) => value.id), count: cases.length, contentHash: "cases" },
		evaluatorPolicyIdentity: { extensionVersion: "0.1.0", sourcesHash: "sources", substitution: "fictional-install-v1" },
		provider: "test", model: "offline", effort: "low", timeoutMs: 1000, repetitions: 3, startedAt: 0, finishedAt: 90,
		modelIdentity: {
			piCodingAgentVersion: "1.1.0", piAiVersion: "1.1.0", api: "test", reasoning: true, input: ["text"],
			contextWindow: 10000, maxTokens: 1000, pricing, catalogHash: "catalog",
		},
		outcomes, aggregates: calculateAggregates(cases, outcomes, 3), usage: summarizeUsage(outcomes), latency: summarizeLatency(outcomes),
	};
	assert.equal(isRunResult(report), true);
	const table = formatSummary(report, cases);
	assert.match(table, /Pooled scores\s+│ Precision\s+│ Recall\s+│ F2/);
	assert.match(table, /Evaluator\s+│ 60\.0%\s+│ 75\.0%\s+│ 71\.4%/);
	assert.match(table, /Estimated total\s+│ unknown/);
	assert.doesNotMatch(table, /#1|risky2:/);
	const summary = formatFullReport(report, cases);
	assert.match(summary, /7\/9 valid/);
	assert.match(summary, /Estimated cost unknown; known subtotal \$0\.000000 \(0\/9 priced\)/);
	assert.match(summary, /risky2: unanimous \(2 valid, 1 failed\)/);
	assert.match(summary, /risky: mixed \(2 valid, 1 failed\)/);
	assert.match(summary, /^=== FAILED: 2 evaluator failure\(s\)/);
	assert.match(summary, /all attempts recorded/);
	assert.match(summary, /Cases: 3 unique \(1 allow, 2 review\)/);
	assert.match(summary, /Review-positive: TP\/FP\/TN\/FN 3\/2\/1\/1; precision 60\.0%, recall 75\.0%, F2 71\.4%, safe-case allow 33\.3%/);
	assert.match(summary, /Baseline always-review: TP\/FP\/TN\/FN 4\/3\/0\/0; precision 57\.1%, recall 100\.0%, F2 87\.0%, safe-case allow 0\.0%/);
	assert.match(summary, /Baseline always-allow: TP\/FP\/TN\/FN 0\/0\/3\/4; precision n\/a, recall 0\.0%, F2 0\.0%, safe-case allow 100\.0%/);
	assert.match(summary, /Failures: timeout 2, parse 0, non-stop 0, error 0/);
	const reordered = formatFullReport({ ...report, outcomes: [...outcomes].reverse() }, cases);
	assert.equal(reordered, summary);
	assert.match(summary, /#1 allow: "test"\n    #2 review: "test"\n    #3 FAILED timeout: "slow"/);
	const successful = outcomes.filter((value) => value.result.kind === "verdict");
	assert.doesNotMatch(formatFullReport({ ...report, outcomes: successful, aggregates: calculateAggregates(cases, successful, 3) }, cases), /=== FAILED/);
});

console.log("\nall checks passed");
