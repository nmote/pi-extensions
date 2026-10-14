import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { main, sourceHash } from "./run.ts";
import { isRunResult } from "./contracts.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-benchmark-"));
const output = join(directory, "result.json");
const originalCreate = ModelRuntime.create;
const originalWrite = process.stdout.write;
let stdout = "";
process.stdout.write = ((chunk: string | Uint8Array) => {
	stdout += chunk.toString();
	return true;
}) as typeof process.stdout.write;
let initialized = 0;
let requests = 0;
const model = { id: "offline", provider: "offline", api: "offline", reasoning: false,
	input: ["text"], contextWindow: 1000, maxTokens: 100,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0,
		tiers: [{ inputTokensAbove: 10, input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }] } };
ModelRuntime.create = async (options) => {
	initialized++;
	assert.equal(options?.modelsPath, null);
	assert.equal(options?.refreshOnCreate, false);
	assert.equal(options?.allowModelNetwork, false);
	return { getPhysicalModel: (provider: string) => provider === "offline" ? model : undefined,
		getModelOfType: (type: string, provider: string, id: string) =>
			type === "classifier" && ["typesafe", "cloudflare-workers-ai"].includes(provider)
				? { id, provider, api: "typesafe-system-one", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : undefined,
		classify: async () => {
			requests++;
			return { stopReason: "stop", model: "jev-latest",
				answers: { verdict: { type: "choice", choice: "allow", probabilities: { allow: 0.97 }, confidence: 0.91 } },
				usage: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 50,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		},
		streamSimple: () => ({ result: async () => {
			requests++;
			return { stopReason: "stop", content: [{ type: "text", text: '{"decision":"allow","reason":"offline fixture"}' }],
				usage: { input: 20, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 21 } };
		} }),
	} as unknown as ModelRuntime;
};
const logDir = join(directory, "logs");
const args = ["--provider", "offline", "--model", "offline", "--log-dir", logDir];
try {
	const sources = ["exts/auto-approve/nested/rules.ts", "exts/auto-approve/index.ts",
		"exts/auto-approve/defaults.json", "benchmark/auto-approve/runner.ts",
		"benchmark/auto-approve/contracts.ts"];
	const fixtures = [join(directory, "sources-a"), join(directory, "sources-b")];
	for (const [index, fixture] of fixtures.entries()) {
		await mkdir(join(fixture, "exts/auto-approve/nested"), { recursive: true });
		await mkdir(join(fixture, "benchmark/auto-approve"), { recursive: true });
		for (const source of index === 0 ? sources : [...sources].reverse()) {
			await writeFile(join(fixture, source), source);
		}
	}
	const baseline = await sourceHash(fixtures[0]);
	assert.equal(await sourceHash(fixtures[0]), baseline);
	assert.equal(await sourceHash(fixtures[1]), baseline);
	await writeFile(join(fixtures[0], "exts/auto-approve/ignored.json"), "ignored");
	assert.equal(await sourceHash(fixtures[0]), baseline);
	for (const source of sources) {
		await writeFile(join(fixtures[0], source), `${source} changed`);
		assert.notEqual(await sourceHash(fixtures[0]), baseline, source);
		await writeFile(join(fixtures[0], source), source);
		assert.equal(await sourceHash(fixtures[0]), baseline);
	}
	const invalid = join(directory, "invalid.jsonl");
	await writeFile(invalid, "{}\n");
	await assert.rejects(main([...args, "--cases", invalid]), /case schema/);
	assert.equal(initialized, 0);
	const dangling = join(directory, "dangling");
	await symlink(join(directory, "missing"), dangling);
	await assert.rejects(main([...args, "--output", dangling]), /already exists/);
	assert.equal(initialized, 0);
	assert.equal(await main([...args, "--output", output]), 0);
	const report: unknown = JSON.parse(await readFile(output, "utf8"));
	assert.ok(isRunResult(report));
	assert.equal(report.aggregates.planned, report.datasetIdentity.count * 3);
	assert.equal(requests, report.aggregates.planned);
	assert.equal(initialized, 1);
	assert.deepEqual(report.modelIdentity.pricing.tiers, model.cost.tiers);
	assert.equal(report.outcomes[0].estimatedCostUsd, 0.000044);
	assert.equal(report.aggregates.consistency.unanimous, report.datasetIdentity.count);
	assert.match(stdout, /Pooled scores/);
	assert.doesNotMatch(stdout, /offline fixture|#1|"schemaVersion"/);
	const runs = await readdir(logDir);
	assert.equal(runs.length, 1);
	const loggedJson = await readFile(join(logDir, runs[0], "results.json"), "utf8");
	assert.deepEqual(JSON.parse(loggedJson), report);
	const full = await readFile(join(logDir, runs[0], "report.txt"), "utf8");
	assert.match(full, /#1 allow: "offline fixture"/);
	assert.match(full, /Pooled scores/);
	await assert.rejects(main([...args, "--output", output]), /already exists/);
	assert.equal(initialized, 1);
	stdout = "";
	assert.equal(await main([...args, "--json", "--repetitions", "1"]), 0);
	assert.ok(isRunResult(JSON.parse(stdout)));
	assert.equal((await readdir(logDir)).length, 2);

	// Classifiers use the same evaluation policy across providers.
	stdout = "";
	const jevArgs = ["--provider", "typesafe", "--model", "jev-latest", "--log-dir", logDir, "--repetitions", "1", "--json"];
	assert.equal(await main(jevArgs), 0);
	const jevReport = JSON.parse(stdout);
	assert.ok(isRunResult(jevReport));
	const jevIdentity = jevReport.modelIdentity as Record<string, unknown>;
	assert.equal(typeof jevIdentity.questionSchemaHash, "string");
	assert.equal(jevReport.modelIdentity.pricing.input, 0.042);
	const jevOutcome = jevReport.outcomes[0];
	assert.ok(jevOutcome.result.kind === "verdict");
	assert.equal(jevOutcome.result.verdict, "allow");
	assert.equal(jevOutcome.result.reason, "allow (p=0.97, confidence=0.91)");
	assert.equal(jevOutcome.estimatedCostUsd, 50 * 0.042 / 1e6);
	stdout = "";
	assert.equal(await main(["--provider", "cloudflare-workers-ai", "--model", "typesafe/jev", "--type", "classifier",
		"--log-dir", logDir, "--repetitions", "1", "--json"]), 0);
	const cloudflareReport = JSON.parse(stdout);
	assert.ok(isRunResult(cloudflareReport));
	assert.deepEqual(cloudflareReport.modelIdentity.pricing, jevReport.modelIdentity.pricing);
	assert.equal(cloudflareReport.outcomes[0].estimatedCostUsd, 50 * 0.042 / 1e6);
	assert.equal(cloudflareReport.usage.averageEstimatedCostUsd, 50 * 0.042 / 1e6);
	assert.equal((cloudflareReport.modelIdentity as Record<string, unknown>).questionSchemaHash, jevIdentity.questionSchemaHash);
	assert.deepEqual(cloudflareReport.outcomes[0].result, jevOutcome.result);
} finally {
	ModelRuntime.create = originalCreate;
	process.stdout.write = originalWrite;
	await rm(directory, { recursive: true, force: true });
}
console.log("CLI preflight and offline report checks passed");
