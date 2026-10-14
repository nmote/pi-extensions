import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { main, loadMatrix, matrixOptions, formatMatrix } from "./matrix.ts";
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
	const entry = { provider: "p", model: "m", effort: "low" };
	assert.throws(() => loadMatrix([entry, entry]), /Duplicate/);
	assert.throws(() => matrixOptions(["--repetitions", "0"]), /positive/);
	assert.equal(matrixOptions([]).repetitions, 3);
	assert.equal(matrixOptions([]).timeoutMs, 30000);

	// Exercise the real runner's reconstruction, with nonexistent credentials and no log directory.
	const dryLogs = join(directory, "dry-logs");
	assert.equal(await main(["--dry-run", "--auth-path", join(directory, "absent-auth"), "--log-dir", dryLogs]), 0);
	assert.equal(stdout.split("planned requests").length - 1, 4);
	await assert.rejects(stat(dryLogs), { code: "ENOENT" });
	const invalid = join(directory, "invalid.jsonl");
	await writeFile(invalid, "{}\n");
	await assert.rejects(main(["--dry-run", "--cases", invalid]), /preflight/);

	const cases = loadCases(await readFile(resolve("benchmark/auto-approve/cases.jsonl"), "utf8")).slice(0, 1);
	const outcomes: Outcome[] = [1, 2].map((repetition) => ({ caseId: cases[0].id, repetition, elapsedMs: 1,
		usage: null, estimatedCostUsd: null, responseModel: null, providerThinkingLevel: null, stopReason: "stop",
		result: { kind: "verdict", verdict: "review", reason: "private fixture reason" } }));
	const report: RunResult = {
		schemaVersion: 1, datasetIdentity: { caseIds: [cases[0].id], count: 1, contentHash: "fixture" },
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
	assert.equal(await main(args, { runner, available: async (entry) => { checked.push(entry.provider); return entry.provider !== "openai"; } }), 1);
	assert.deepEqual(checked, ["openai", "fireworks", "anthropic", "fireworks"]);
	const first = join(logDir, (await readdir(logDir))[0]);
	const manifest = JSON.parse(await readFile(join(first, "manifest.json"), "utf8"));
	assert.deepEqual(manifest.entries.map((row: { status: string }) => row.status), ["unavailable", "failed", "completed", "completed"]);
	assert.equal(stdout, `${await readFile(join(first, "summary.txt"), "utf8")}`);
	assert.match(stdout, /n\/a/);
	assert.match(stdout, /1\/0\/0\s+n\/a/);
	assert.match(stdout, /Avg cost\/eval \(USD\)/);
	assert.match(stdout, /Run cost \(USD\)/);
	assert.match(stdout, /Avg latency \(ms\)/);
	assert.match(stdout, /1\/0\/0\s+n\/a\s+n\/a\s+1\.0$/m);
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
		return { getPhysicalModel: (provider: string, model: string) => {
			catalogChecks.push(`${provider}/${model}`);
			return {};
		} } as unknown as ModelRuntime;
	};
	assert.equal(await main(args, { runner }), 1);
	assert.equal(initialized, 1);
	assert.equal(catalogChecks.length, 4);
	assert.equal(catalogChecks[3], "fireworks/accounts/fireworks/models/glm-5p3-flash");
	const second = (await readdir(logDir)).find((name) => join(logDir, name) !== first)!;
	const retained = JSON.parse(await readFile(join(logDir, second, "manifest.json"), "utf8"));
	assert.deepEqual(retained.entries.map((row: { status: string }) => row.status), ["failed", "failed", "completed", "completed"]);
	assert.ok(retained.entries[0].aggregates);
	assert.ok(retained.entries[1].aggregates, "JSON scores survive missing text report");
	assert.match(stderr, /scores exclude 2 failed attempts/);
	assert.match(stdout, /openai\/gpt-6-luna \(medium\)\s+n\/a\s+n\/a\s+n\/a\s+0\/0\/1\s+\$0\.000123\s+n\/a/);
	assert.equal(retained.entries[0].averageEstimatedCostUsd, 0.000123, "Average uses priced attempts, including failures");
	assert.equal(retained.entries[0].totalEstimatedCostUsd, null, "Full run cost is unknown when any attempt lacks cost");
	assert.equal(retained.entries[0].averageLatencyMs, 1, "Latency includes failed attempts");
	const costTable = formatMatrix([
		{ provider: "p", model: "missing", effort: "low", status: "failed" },
		{ provider: "p", model: "zero", effort: "low", status: "completed", averageEstimatedCostUsd: 0, totalEstimatedCostUsd: 0, averageLatencyMs: 0 },
		{ provider: "p", model: "priced", effort: "low", status: "completed", totalEstimatedCostUsd: 1.25, averageLatencyMs: null },
		{ provider: "p", model: "unknown", effort: "low", status: "completed", averageLatencyMs: null },
	]);
	assert.match(costTable, /missing.*n\/a$/m);
	assert.match(costTable, /zero.*\$0\.000000\s+\$0\.0000\s+0\.0$/m);
	assert.match(costTable, /priced.*\$1\.2500\s+n\/a$/m);
	assert.match(costTable, /unknown.*n\/a$/m);
	assert.match(costTable, /^Total\s+\$1\.2500\+$/m, "Grand total sums known run costs and marks partial totals");

	process.env.MATRIX_TEST_MODE = "success";
	assert.equal(await main(args, { runner }), 0, "Scores do not determine exit status");
	assert.equal((await readdir(logDir)).length, 3, "Runs do not overwrite logs");

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
	assert.deepEqual(interrupted.entries.map((row: { status: string }) => row.status), ["completed", "interrupted", "interrupted", "interrupted"]);
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
