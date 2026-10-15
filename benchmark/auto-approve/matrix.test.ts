import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { main, loadMatrix, loadBindings, resolveEntry, matrixOptions, formatMatrix } from "./matrix.ts";
import { isRunResult, loadCases, type Outcome, type RunResult } from "./contracts.ts";
import { calculateAggregates, summarizeLatency, summarizeUsage } from "./metrics.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-matrix-"));
const runner = join(directory, "runner.mjs");
const originalCreate = ModelRuntime.create;
const originalOut = process.stdout.write;
const originalErr = process.stderr.write;
const originalMode = process.env.MATRIX_TEST_MODE;
const originalDir = process.env.MATRIX_TEST_DIR;
let stdout = "";
let stderr = "";
process.stdout.write = ((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof process.stdout.write;
process.stderr.write = ((chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; }) as typeof process.stderr.write;
ModelRuntime.create = async () => { throw new Error("No auth initialization allowed in offline tests"); };
process.env.MATRIX_TEST_DIR = directory;
try {
	assert.throws(() => loadMatrix([]), /nonempty/);
	assert.throws(() => loadMatrix([{ provider: "p", model: "m", effort: "invalid" }]), /Invalid/);
	const entry = { id: "fixture", kind: "chat" as const, effort: "low" as const,
		candidates: [{ provider: "p", model: "m" }, { provider: "q", model: "other" }] };
	assert.throws(() => loadMatrix([entry, entry]), /Duplicate/);
	assert.throws(() => loadMatrix([{ ...entry, candidates: [entry.candidates[0], entry.candidates[0]] }]), /Duplicate/);
	assert.throws(() => loadBindings({ unknown: entry.candidates[0] }, [entry]), /Invalid/);
	assert.throws(() => loadBindings({ fixture: { provider: "p" } }, [entry]), /Invalid/);
	const binding = loadBindings({ fixture: { provider: "local", model: "exact" } }, [entry]).fixture;
	const candidates: string[] = [];
	const selected = await resolveEntry(entry, undefined, async (candidate) => {
		candidates.push(candidate.provider);
		return candidate.provider === "q";
	});
	assert.deepEqual(candidates, ["p", "q"]);
	assert.equal(selected?.model, "other");
	assert.equal((await resolveEntry(entry, binding, async () => true))?.provider, "local");
	await assert.rejects(resolveEntry(entry, binding, async () => false), /Explicit binding unavailable/);
	assert.equal(await resolveEntry(entry, undefined, async () => false), undefined);
	assert.throws(() => matrixOptions(["--dry-run", "--resolve-only"]), /mutually exclusive/);
	assert.throws(() => matrixOptions(["--repetitions", "0"]), /positive/);
	assert.equal(matrixOptions([]).repetitions, 3);
	assert.equal(matrixOptions([]).timeoutMs, 30000);

	// Exercise the real runner's reconstruction, with nonexistent credentials and no log directory.
	const dryLogs = join(directory, "dry-logs");
	assert.equal(await main(["--dry-run", "--auth-path", join(directory, "absent-auth"), "--log-dir", dryLogs]), 0);
	assert.equal(stdout.split("planned evaluations").length - 1, 7);
	await assert.rejects(stat(dryLogs), { code: "ENOENT" });
	const invalid = join(directory, "invalid.jsonl");
	await writeFile(invalid, "{}\n");
	await assert.rejects(main(["--dry-run", "--cases", invalid]), /preflight/);

	const cases = loadCases(await readFile(resolve("benchmark/auto-approve/cases.jsonl"), "utf8")).slice(0, 1);
	const outcomes: Outcome[] = [1, 2].map((repetition) => ({ caseId: cases[0].id, repetition, elapsedMs: 1,
		usage: null, estimatedCostUsd: null, responseModel: null, providerThinkingLevel: null, stopReason: "stop",
		result: { kind: "verdict", verdict: "review", reason: "private fixture reason" } }));
	const report: RunResult = {
		schemaVersion: 2, datasetIdentity: { caseIds: [cases[0].id], count: 1, contentHash: "fixture" },
		evaluatorPolicyIdentity: { extensionVersion: "fixture", sourcesHash: "fixture", substitution: "fixture" },
		provider: "fixture", model: "fixture", effort: "low", timeoutMs: 30, repetitions: 2, startedAt: 0, finishedAt: 1,
		modelIdentity: { piCodingAgentVersion: "fixture", piAiVersion: "fixture", api: "fixture", reasoning: false,
			input: ["text"], contextWindow: 1, maxTokens: 1, pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, catalogHash: "fixture" },
		outcomes, aggregates: calculateAggregates(cases, outcomes, 2), usage: summarizeUsage(outcomes), latency: summarizeLatency(outcomes),
	};
	assert.ok(isRunResult(report));
	const failedOutcomes: Outcome[] = outcomes.map((outcome) => ({ ...outcome,
		estimatedCostUsd: outcome.repetition === 1 ? 0.000123 : null,
		result: { kind: "failure", failure: "error", detail: "private failure" } }));
	const failedReport = { ...report, outcomes: failedOutcomes, aggregates: calculateAggregates(cases, failedOutcomes, 2),
		usage: summarizeUsage(failedOutcomes), latency: summarizeLatency(failedOutcomes) };
	await writeFile(join(directory, "report.json"), JSON.stringify(report));
	await writeFile(join(directory, "failed.json"), JSON.stringify(failedReport));
	await writeFile(runner, `
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
const option = (name) => args[args.lastIndexOf(name) + 1];
const dir = process.env.MATRIX_TEST_DIR;
if (args.includes('--dry-run')) {
 console.log(JSON.stringify({ plannedRequests: 2 }));
} else {
 const provider = option('--provider');
 const mode = process.env.MATRIX_TEST_MODE;
 const deepseek = option('--model').includes('deepseek');
 await writeFile(join(dir, provider + '-args.json'), JSON.stringify(args));
 if (deepseek && mode === 'interrupt') {
  await writeFile(join(dir, 'active'), 'yes');
  setInterval(() => {}, 1000);
 } else if (deepseek && mode === 'missing') {
  console.error('private execution error');
  process.exitCode = 1;
 } else {
  const failed = provider === 'openai' && mode === 'reports';
  const report = JSON.parse(await readFile(join(dir, failed ? 'failed.json' : 'report.json'), 'utf8'));
  report.provider = provider;
  report.model = option('--model');
  report.effort = option('--effort');
  if (option('--type') === 'classifier') {
   report.modelIdentity = { api: 'typesafe-system-one', piAiVersion: 'fixture', piCodingAgentVersion: 'fixture',
    pricing: report.modelIdentity.pricing, questionSchemaHash: 'fixture',
    hybrid: { confidenceThreshold: 0.25, provider: option('--chat-provider'), model: option('--chat-model'),
     effort: report.effort, identity: report.modelIdentity } };
  }
  const logs = join(option('--log-dir'), 'run');
  await mkdir(logs, { mode: 0o700 });
  await writeFile(join(logs, 'results.json'), JSON.stringify(report), { mode: 0o600 });
  if (!(deepseek && mode === 'reports')) await writeFile(join(logs, 'report.txt'), 'private fixture reason', { mode: 0o600 });
  console.log(JSON.stringify(report));
  console.error('private fixture stderr');
  process.exitCode = failed ? 1 : 0;
 }
}
`);
	const logDir = join(directory, "logs");
	const args = ["--cases", join(directory, "custom cases.jsonl"), "--repetitions", "2", "--timeout-ms", "42",
		"--auth-path", join(directory, "custom auth.json"), "--log-dir", logDir];
	process.env.MATRIX_TEST_MODE = "missing";
	stdout = stderr = "";
	const checked: string[] = [];
	assert.equal(await main(args, { runner, available: async (entry) => { checked.push(entry.provider); return entry.provider !== "openai" && entry.provider !== "openai-codex"; } }), 1);
	assert.deepEqual(checked, ["openai", "openai-codex", "fireworks", "anthropic", "fireworks", "typesafe", "typesafe", "typesafe"]);
	const first = join(logDir, (await readdir(logDir))[0]);
	const manifest = JSON.parse(await readFile(join(first, "manifest.json"), "utf8"));
	assert.equal(manifest.schemaVersion, 2);
	assert.equal(manifest.entries[0].id, "luna");
	assert.equal(manifest.entries[0].provider, undefined);
	assert.deepEqual(manifest.entries.map((row: { status: string }) => row.status), ["unavailable", "failed", "completed", "completed", "completed", "completed", "completed"]);
	assert.equal(stdout, `${await readFile(join(first, "summary.txt"), "utf8")}`);
	assert.match(stdout, /n\/a/);
	assert.match(stdout, /1\/0\/0\s+n\/a/);
	assert.match(stdout, /Prec\s+Recall\s+F2\s+U\/M\/I\s+\$\/eval\s+\$run\s+Lat ms\s+Chat %/);
	assert.match(stdout, /1\/0\/0\s+n\/a\s+n\/a\s+1\s+—$/m);
	assert.match(stdout, /^Total\s+n\/a$/m, "No known run costs yields an n/a grand total");
	assert.equal(manifest.entries[2].averageEstimatedCostUsd, null);
	assert.equal(manifest.entries[2].totalEstimatedCostUsd, null);
	assert.equal(manifest.entries[2].averageLatencyMs, 1);
	assert.doesNotMatch(stdout, /private|schemaVersion|safeCase|Completion/);
	assert.match(stderr, /Unavailable/);
	assert.match(stderr, /Failed/);
	const forwarded = JSON.parse(await readFile(join(directory, "anthropic-args.json"), "utf8"));
	for (const name of ["--cases", "--repetitions", "--timeout-ms", "--auth-path"]) {
		assert.equal(forwarded[forwarded.lastIndexOf(name) + 1], args[args.indexOf(name) + 1]);
	}
	assert.equal(forwarded[forwarded.indexOf("--effort") + 1], "medium");
	assert.equal(forwarded[forwarded.lastIndexOf("--log-dir") + 1], join(first, "3"));
	for (const row of manifest.entries.slice(1)) {
		assert.equal((await stat(row.stdout)).mode & 0o777, 0o600);
		assert.equal((await stat(row.stderr)).mode & 0o777, 0o600);
	}
	assert.match(await readFile(manifest.entries[2].report, "utf8"), /private fixture reason/);
	assert.equal((await stat(first)).mode & 0o777, 0o700);

	process.env.MATRIX_TEST_MODE = "reports";
	stdout = stderr = "";
	let initialized = 0;
	const catalogChecks: string[] = [];
	ModelRuntime.create = async (options) => {
		initialized++;
		assert.equal(options?.modelsPath, null);
		assert.equal(options?.refreshOnCreate, false);
		assert.equal(options?.allowModelNetwork, false);
		assert.equal(options?.authPath, join(directory, "custom auth.json"));
		return { getPhysicalModel: () => ({}),
			getAvailableOfType: async (type: string, provider: string) => {
				const entries = loadMatrix(JSON.parse(await readFile(resolve("benchmark/auto-approve/matrix.json"), "utf8")));
				const models = entries.filter((entry) => entry.kind === type).flatMap((entry) => entry.candidates)
					.filter((candidate) => candidate.provider === provider).map((candidate) => ({ id: candidate.model }));
				catalogChecks.push(`${type}:${provider}`);
				return models;
			} } as unknown as ModelRuntime;
	};
	assert.equal(await main(args, { runner }), 1);
	assert.equal(initialized, 1);
	assert.equal(catalogChecks.length, 7);
	assert.equal(catalogChecks[3], "chat:fireworks");
	assert.equal(catalogChecks[4], "classifier:typesafe");
	const second = (await readdir(logDir)).find((name) => join(logDir, name) !== first)!;
	const retained = JSON.parse(await readFile(join(logDir, second, "manifest.json"), "utf8"));
	assert.deepEqual(retained.entries.map((row: { status: string }) => row.status), ["failed", "failed", "completed", "completed", "completed", "completed", "completed"]);
	assert.ok(retained.entries[0].aggregates);
	assert.ok(retained.entries[1].aggregates, "JSON scores survive missing text report");
	assert.match(stderr, /scores exclude 2 failed attempts/);
	assert.match(stdout, /^luna\s+n\/a\s+n\/a\s+n\/a\s+0\/0\/1\s+\$0\.000123\s+n\/a/m);
	assert.equal(retained.entries[0].averageEstimatedCostUsd, 0.000123, "Average uses priced attempts, including failures");
	assert.equal(retained.entries[0].totalEstimatedCostUsd, null, "Full run cost is unknown when any attempt lacks cost");
	assert.equal(retained.entries[0].averageLatencyMs, 1, "Latency includes failed attempts");
	const costTable = formatMatrix([
		{ ...entry, id: "missing", provider: "p", model: "missing", status: "failed" },
		{ ...entry, id: "zero", provider: "p", model: "zero", status: "completed", averageEstimatedCostUsd: 0, totalEstimatedCostUsd: 0, averageLatencyMs: 0 },
		{ ...entry, id: "priced", provider: "p", model: "priced", status: "completed", totalEstimatedCostUsd: 1.25, averageLatencyMs: 12.6 },
		{ ...entry, id: "unknown", kind: "classifier", status: "completed", fallbackRate: null },
		{ ...entry, id: "hybrid-zero", kind: "classifier", status: "completed", fallbackRate: 0 },
		{ ...entry, id: "hybrid", kind: "classifier", status: "completed", fallbackRate: 0.125 },
	]);
	assert.match(costTable, /^missing.*n\/a\s+—$/m);
	assert.match(costTable, /^zero.*\$0\.000000\s+\$0\.0000\s+0\s+—$/m);
	assert.match(costTable, /^priced.*\$1\.2500\s+13\s+—$/m);
	assert.match(costTable, /^unknown.*n\/a$/m);
	assert.match(costTable, /^hybrid-zero.*\s0\.0%$/m);
	assert.match(costTable, /^hybrid .*\s12\.5%$/m);
	assert.ok(costTable.split("\n").every((line) => line.length <= 100));
	assert.match(costTable, /Model identities and effort: manifest\.json/);
	assert.match(costTable, /^Total\s+\$1\.2500\+$/m, "Grand total sums known run costs and marks partial totals");

	process.env.MATRIX_TEST_MODE = "success";
	assert.equal(await main(args, { runner }), 0, "Scores do not determine exit status");
	assert.equal((await readdir(logDir)).length, 3, "Runs do not overwrite logs");

	const bindingsPath = join(directory, "bindings.json");
	await writeFile(bindingsPath, JSON.stringify({ "jev-haiku": { provider: "cloudflare-workers-ai", model: "typesafe/jev" }, "jev-deepseek": { provider: "cloudflare-workers-ai", model: "typesafe/jev" } }));
	const resolvedLogs = join(directory, "resolve-logs");
	stdout = "";
	const portable = async (candidate: { provider: string }) => candidate.provider === "cloudflare-workers-ai" || candidate.provider === "openai-codex" || candidate.provider === "anthropic";
	assert.equal(await main(["--resolve-only", "--bindings", bindingsPath, "--log-dir", resolvedLogs], { runner, available: portable }), 0);
	assert.match(stdout, /luna: openai-codex\/gpt-6-luna/);
	assert.match(stdout, /deepseek: cloudflare-workers-ai\/@cf\/deepseek-ai\/deepseek-v4-flash-0731/);
	assert.match(stdout, /jev-haiku: cloudflare-workers-ai\/typesafe\/jev \+ anthropic\/claude-haiku-5-5 \(classifier, medium\)/);
	await assert.rejects(stat(resolvedLogs), { code: "ENOENT" });
	assert.equal(await main(["--bindings", bindingsPath, "--log-dir", resolvedLogs], { runner, available: portable }), 0);
	const portableManifest = JSON.parse(await readFile(join(resolvedLogs, (await readdir(resolvedLogs))[0], "manifest.json"), "utf8"));
	assert.equal(portableManifest.entries[0].provider, "openai-codex");
	assert.equal(portableManifest.entries[4].kind, "classifier");
	const jevForwarded = JSON.parse(await readFile(join(directory, "cloudflare-workers-ai-args.json"), "utf8"));
	assert.equal(jevForwarded[jevForwarded.indexOf("--type") + 1], "classifier");
	assert.equal(jevForwarded[jevForwarded.indexOf("--chat-provider") + 1], "cloudflare-workers-ai");
	assert.equal(jevForwarded[jevForwarded.indexOf("--chat-model") + 1], "@cf/zai-org/glm-5.3-flash");
	assert.equal(jevForwarded[jevForwarded.indexOf("--effort") + 1], "medium");
	await assert.rejects(main(["--bindings", bindingsPath, "--resolve-only"], { runner, available: async () => false }), /Explicit binding unavailable/);

	stdout = "";
	assert.equal(await main(["--resolve-only"], { runner, available: async (candidate) => candidate.provider !== "anthropic" }), 1);
	assert.match(stdout, /jev-haiku: unavailable/);
	assert.match(stdout, /jev-deepseek: typesafe\/jev-latest \+ fireworks\//);
	assert.match(stdout, /jev-glm: typesafe\/jev-latest \+ fireworks\/accounts\/fireworks\/models\/glm-5p3-flash \(classifier, medium\)/);

	assert.equal(await main(["--resolve-only"], { runner, available: async (_entry, signal) => {
		process.emit("SIGINT");
		signal.throwIfAborted();
		return true;
	} }), 130, "Cancellation during model resolution exits 130");

	process.env.MATRIX_TEST_MODE = "interrupt";
	let signaled = false;
	const poll = async () => {
		for (let i = 0; i < 400; i++) {
			try { await stat(join(directory, "active")); } catch { await delay(25); continue; }
			signaled = true;
			process.emit("SIGINT");
			return;
		}
		throw new Error("Child did not start");
	};
	const interruptedLogs = join(directory, "interrupted");
	assert.equal((await Promise.all([main(["--log-dir", interruptedLogs], { runner, available: async () => true }), poll()]))[0], 130);
	assert.ok(signaled);
	const interruptedDir = join(interruptedLogs, (await readdir(interruptedLogs))[0]);
	const interrupted = JSON.parse(await readFile(join(interruptedDir, "manifest.json"), "utf8"));
	assert.equal(interrupted.interrupted, true);
	assert.deepEqual(interrupted.entries.map((row: { status: string }) => row.status), ["completed", "interrupted", "interrupted", "interrupted", "interrupted", "interrupted", "interrupted"]);
	assert.ok(isRunResult(JSON.parse(await readFile(interrupted.entries[0].results, "utf8"))));
	assert.equal(interrupted.entries[2].stdout, undefined);
} finally {
	ModelRuntime.create = originalCreate;
	process.stdout.write = originalOut;
	process.stderr.write = originalErr;
	if (originalMode === undefined) delete process.env.MATRIX_TEST_MODE; else process.env.MATRIX_TEST_MODE = originalMode;
	if (originalDir === undefined) delete process.env.MATRIX_TEST_DIR; else process.env.MATRIX_TEST_DIR = originalDir;
	await rm(directory, { recursive: true, force: true });
}
console.log("Matrix offline checks passed");
