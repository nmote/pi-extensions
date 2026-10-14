import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { loadCases, isRunResult, INSTALL_READ_ROOTS, sparseRealPath } from "./contracts.ts";
import { loadBuiltinRoots } from "../../exts/auto-approve/builtin-roots.ts";
import { buildMatchInput, evaluatorInstructions } from "../../exts/auto-approve/rules.ts";
import { calculateAggregates, summarizeUsage, summarizeLatency } from "./metrics.ts";
import { instructionsFor, runEvaluations, tokenUsage } from "./runner.ts";
import { cliOptions } from "./run.ts";
import { buildSystemPrompt, evaluateSafety, type EvaluatorContext } from "../../exts/auto-approve/evaluator.ts";

const cases = loadCases(await readFile(new URL("./cases.jsonl", import.meta.url), "utf8"));
const builtin = loadBuiltinRoots();
const scopeCase = { ...cases[0], writeRoots: ["../scratch/", "~/output/"],
	readRoots: ["../reference/", "~/.cargo/registry/"] };
const scope = instructionsFor(scopeCase)[0];
for (const root of [...INSTALL_READ_ROOTS, ...builtin.writeRoots, ...builtin.readRoots]) {
	assert.equal(scope.split(root).length - 1, 1, `baseline root appears once: ${root}`);
}
assert.ok(scope.includes("Writable roots: /home/dev/work/webapp, /tmp, /home/dev/work/scratch, /home/dev/output."));
assert.ok(scope.includes("/home/dev/work/reference, /home/dev/.cargo/registry."));
assert.ok(!scope.includes("../scratch") && !scope.includes("~/.cargo"));

const cleaned = cases.find((value) => value.id === "bash-repo-relative-check")!;
assert.deepEqual(cleaned.writeRoots, []);
assert.deepEqual(cleaned.readRoots, ["/home/dev/.local/share/runtime/", "~/repos/", "~/.cargo/registry/"]);
// Installation-only replay of the full-root fixture.
const originalInstructions = evaluatorInstructions(buildMatchInput(cleaned.tool, cleaned.input), cleaned.cwd, {
	writeRoots: ["/tmp"],
	readRoots: [...INSTALL_READ_ROOTS, "/home/dev/.pi/agent/skills", "/home/dev/.pi/agent/README.md",
		"/home/dev/.pi/agent/docs", "/home/dev/.pi/agent/examples", "/home/dev/.pi/agent/CHANGELOG.md",
		"/home/dev/.local/share/runtime/", "~/repos/", "~/.cargo/registry/"],
	matchedInstructions: cleaned.matchedRules.map((rule) => rule.instructions),
	homeDir: cleaned.home, realPath: sparseRealPath(cleaned.realPaths ?? {}),
});
assert.equal(buildSystemPrompt(instructionsFor(cleaned), cleaned.sessionGuidance),
	buildSystemPrompt(originalInstructions, cleaned.sessionGuidance));

const pricing = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 };
const model = {} as Parameters<typeof evaluateSafety>[0];
const config = { timeoutMs: 10, reasoningEffort: "low" as const, memoize: false, backend: "chat" as const, jev: { model: "jev-latest" } };
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function context(text: string, stopReason = "stop"): EvaluatorContext {
	return { cwd: "/workspace", modelRegistry: { streamSimple: () => ({
		result: async () => ({ stopReason, content: [{ type: "text", text }], usage,
			responseModel: "reported-model", providerThinkingLevel: "minimal" }),
	}) } } as unknown as EvaluatorContext;
}
const parsed = await evaluateSafety(model, context('{"decision":"allow","reason":"safe"}'), "bash", {}, config);
assert.equal(parsed.decision, "allow");
assert.equal(parsed.attempt?.usage, usage);
assert.equal(parsed.attempt?.providerThinkingLevel, "minimal");
assert.equal((await evaluateSafety(model, context("bad"), "bash", {}, config)).attempt?.failure, "parse");
assert.equal((await evaluateSafety(model, context("{}", "length"), "bash", {}, config)).attempt?.failure, "non-stop");

let requests = 0;
const aborted = new AbortController();
aborted.abort();
const neverRequest: EvaluatorContext = { cwd: "/workspace", signal: aborted.signal,
	modelRegistry: { streamSimple: () => { requests++; throw new Error("secret credential"); } } };
assert.equal((await evaluateSafety(model, neverRequest, "bash", {}, config)).attempt?.failure, "cancelled");
assert.equal(requests, 0);
const timeoutContext = { cwd: "/workspace", modelRegistry: {
	streamSimple: (_model: unknown, _request: unknown, options: { signal: AbortSignal }) => ({
		result: () => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("abort")))),
	}),
} } as unknown as EvaluatorContext;
assert.equal((await evaluateSafety(model, timeoutContext, "bash", {}, config)).attempt?.failure, "timeout");

const guided = cases.find((value) => value.sessionGuidance?.text)!;
const unguided = cases.find((value) => value.id === guided.pairWith)!;
const base = buildSystemPrompt(instructionsFor(unguided), unguided.sessionGuidance);
const withGuidance = buildSystemPrompt(instructionsFor(guided), guided.sessionGuidance);
assert.ok(!base.includes("Session guidance (trusted user authorization)"));
assert.ok(withGuidance.includes(JSON.stringify(guided.sessionGuidance!.text)));
assert.deepEqual(instructionsFor(guided), instructionsFor(unguided));
const symlink = { ...cases[0], input: { path: "src/link.ts" }, matchedRules: [{ instructions: "matched instruction" }],
	realPaths: { [`${cases[0].cwd}/src`]: "/outside" } };
const instructions = instructionsFor(symlink);
assert.ok(instructions[0].includes("Read-only roots:"));
assert.equal(instructions[1], "matched instruction");
assert.ok(instructions[2].includes("/outside/link.ts"));

let active = 0;
let maxActive = 0;
const seen: string[] = [];
const outcomes = await runEvaluations({ cases, model, modelRegistry: context("{}").modelRegistry,
	effort: "low", timeoutMs: 1000, repetitions: 2, pricing,
	evaluate: async (_model, ctx, tool, input, options, passedInstructions, guidance) => {
		active++;
		maxActive = Math.max(active, maxActive);
		const index = seen.length % cases.length;
		const value = cases[index];
		seen.push(value.id);
		assert.equal(ctx.cwd, value.cwd);
		assert.equal(tool, value.tool);
		assert.equal(input, value.input);
		assert.equal(options.memoize, false);
		assert.deepEqual(passedInstructions, instructionsFor(value));
		assert.equal(guidance, value.sessionGuidance);
		await Promise.resolve();
		active--;
		return index === 0 ? { decision: "review", cacheable: false, reason: "secret credential",
			attempt: { failure: "error", usage, stopReason: null, responseModel: null, providerThinkingLevel: null } }
			: { decision: value.expected, reason: "fixture", attempt: parsed.attempt };
	},
});
assert.equal(maxActive, 1);
assert.deepEqual(seen, [...cases, ...cases].map((value) => value.id));
assert.equal(outcomes.length, cases.length * 2);
assert.ok(!JSON.stringify(outcomes).includes("secret credential"));
assert.equal(summarizeUsage(outcomes).pricedAttempts, outcomes.length);
assert.equal(calculateAggregates(cases, outcomes, 2).failed, 2);
assert.equal(summarizeLatency(outcomes).attempts, outcomes.length);
assert.equal(tokenUsage({ decision: "allow", reason: "", attempt: { ...parsed.attempt!, usage: { ...usage,
	input: 0, output: 0, totalTokens: 0 } } }), null);

const stop = new AbortController();
let attempts = 0;
await assert.rejects(runEvaluations({ cases, model, modelRegistry: context("{}").modelRegistry,
	effort: "low", timeoutMs: 1000, repetitions: 3, pricing, signal: stop.signal,
	evaluate: async () => { attempts++; stop.abort(); return parsed; },
}));
assert.equal(attempts, 1);

const options = cliOptions(["--provider", "test", "--model", "a/b"]);
assert.equal(options.help, false);
if (!options.help) assert.equal(options.repetitions, 3);
assert.throws(() => cliOptions(["--provider", "test", "--model", "test", "--timeout-ms", "2147483648"]));
assert.throws(() => cliOptions(["--provider", "test", "--model", "test", "--repetitions", "0"]));
const dry = spawnSync(process.execPath, ["--import", "tsx", "benchmark/auto-approve/run.ts",
	"--provider", "test", "--model", "a/b", "--dry-run", "--json", "--auth-path", "/nonexistent/auth.json"],
	{ encoding: "utf8" });
assert.equal(dry.status, 0, dry.stderr);
const report = JSON.parse(dry.stdout);
assert.equal(report.plannedRequests, cases.length * 3);
assert.equal(report.dryRun, true);
assert.equal(isRunResult(report), false);
console.log("runner checks passed");
