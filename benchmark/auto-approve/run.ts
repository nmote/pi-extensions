import { createHash } from "node:crypto";
import { access, readFile, readdir, lstat, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { evaluateSafetyJev, JEV_QUESTIONS } from "../../exts/auto-approve/jev-evaluator.ts";
import { isRunResult, loadCases, RUN_RESULT_SCHEMA_VERSION, SUBSTITUTION_ID, type ModelIdentity, type RunResult } from "./contracts.ts";
import { calculateAggregates, formatSummary, formatFullReport, summarizeLatency, summarizeUsage } from "./metrics.ts";
import { instructionsFor, runEvaluations, type EvaluateFn } from "./runner.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function cliOptions(args: string[]) {
	const { values } = parseArgs({ args, options: {
		provider: { type: "string" }, model: { type: "string" }, effort: { type: "string", default: "low" },
		"timeout-ms": { type: "string", default: "30000" }, repetitions: { type: "string", default: "3" },
		cases: { type: "string", default: join(root, "benchmark/auto-approve/cases.jsonl") },
		output: { type: "string" }, "auth-path": { type: "string" },
		"log-dir": { type: "string", default: join(root, "logs/auto-approve") },
		json: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false }, help: { type: "boolean", default: false },
	}, allowPositionals: false });
	if (values.help) return { help: true as const };
	if (!values.provider?.trim() || !values.model?.trim()) throw new Error("--provider and --model are required");
	if (values.effort !== "low" && values.effort !== "medium" && values.effort !== "high") {
		throw new Error("--effort must be low, medium or high");
	}
	const effort: "low" | "medium" | "high" = values.effort;
	const positive = (value: string, name: string) => {
		const number = Number(value);
		if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
		return number;
	};
	const timeoutMs = positive(values["timeout-ms"]!, "--timeout-ms");
	if (timeoutMs > 2_147_483_647) throw new Error("--timeout-ms exceeds Node's timer limit");
	return {
		help: false as const, provider: values.provider, model: values.model,
		effort, timeoutMs, repetitions: positive(values.repetitions!, "--repetitions"),
		cases: resolve(values.cases!), output: values.output ? resolve(values.output) : undefined,
		authPath: values["auth-path"], dryRun: values["dry-run"],
		logDir: resolve(values["log-dir"]!), json: values.json,
	};
}

export async function sourceHash(repositoryRoot: string = root): Promise<string> {
	const files = ["exts/auto-approve/defaults.json", "benchmark/auto-approve/runner.ts",
		"benchmark/auto-approve/contracts.ts"];
	async function visit(dir: string): Promise<void> {
		for (const entry of await readdir(join(repositoryRoot, dir), { withFileTypes: true })) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
		}
	}
	await visit("exts/auto-approve");
	const digest = createHash("sha256");
	for (const path of files.sort()) {
		digest.update(path);
		digest.update("\0");
		digest.update(await readFile(join(repositoryRoot, path)));
		digest.update("\0");
	}
	return digest.digest("hex");
}

async function packageVersion(name: string): Promise<string> {
	let directory = dirname(fileURLToPath(import.meta.resolve(name)));
	for (;;) {
		try {
			const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
			if (pkg.name === name) return pkg.version;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = dirname(directory);
		if (parent === directory) throw new Error("Cannot identify installed Pi version");
		directory = parent;
	}
}

async function checkOutput(path: string): Promise<void> {
	try {
		await lstat(path);
		throw new Error("Output already exists; choose a new --output path");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await access(dirname(path), constants.W_OK);
}

const help = `Usage: npm run --silent benchmark:auto-approve -- --provider PROVIDER --model MODEL [options]
  --provider typesafe runs the built-in Jev classifier; --effort is inert there
  --effort low|medium|high   Default low
  --timeout-ms INTEGER      Default 30000
  --repetitions INTEGER     Default 3
  --cases PATH              Default committed cases.jsonl
  --log-dir PATH            Report directory; default logs/auto-approve
  --json                    JSON stdout instead of summary table
  --output PATH             Additional new JSON file
  --auth-path PATH          Pi credential-file override
  --dry-run                 Validate/reconstruct without auth, requests, or availability checks
  --help`;

export async function main(args: string[]): Promise<number> {
	const options = cliOptions(args);
	if (options.help) {
		console.log(help);
		return 0;
	}
	const bytes = await readFile(options.cases);
	const cases = loadCases(bytes.toString("utf8"));
	const planned = cases.length * options.repetitions;
	if (!Number.isSafeInteger(planned)) throw new Error("Planned request count exceeds safe integer range");
	cases.forEach(instructionsFor);
	if (options.output) await checkOutput(options.output);
	const datasetIdentity = { caseIds: cases.map((value) => value.id), count: cases.length, contentHash: hash(bytes) };
	const evaluatorPolicyIdentity = {
		extensionVersion: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version as string,
		sourcesHash: await sourceHash(root), substitution: SUBSTITUTION_ID,
	};
	if (options.dryRun) {
		const preview = { dryRun: true, datasetIdentity, evaluatorPolicyIdentity,
			provider: options.provider, model: options.model, effort: options.effort,
			timeoutMs: options.timeoutMs, repetitions: options.repetitions, plannedRequests: planned };
		const json = `${JSON.stringify(preview, null, 2)}\n`;
		if (options.output) await writeFile(options.output, json, { flag: "wx", mode: 0o600 });
		if (options.json) process.stdout.write(json);
		else console.log(`Dry run: ${options.provider}/${options.model} (${options.effort})\n${cases.length} cases × ${options.repetitions} repetitions = ${planned} requests\nTimeout: ${options.timeoutMs}ms; reports: ${options.logDir}\nNo auth/network initialization or run logs written.`);
		return 0;
	}
	await mkdir(options.logDir, { recursive: true, mode: 0o700 });
	await access(options.logDir, constants.W_OK);
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	try {
		const runtime = await ModelRuntime.create({ modelsPath: null, authPath: options.authPath,
			refreshOnCreate: false, allowModelNetwork: false, signal: controller.signal });
		controller.signal.throwIfAborted();
		const versions = {
			piCodingAgentVersion: await packageVersion("@earendil-works/pi-coding-agent"),
			piAiVersion: await packageVersion("@earendil-works/pi-ai"),
		};
		let model: Parameters<typeof runEvaluations>[0]["model"];
		let modelIdentity: ModelIdentity;
		let evaluate: EvaluateFn | undefined;
		if (options.provider === "typesafe") {
			const classifier = runtime.getModelOfType("classifier", "typesafe", options.model);
			if (!classifier) throw new Error("Unknown built-in classifier model");
			model = classifier;
			modelIdentity = {
				...versions, api: classifier.api,
				questionSchemaHash: hash(JSON.stringify(JEV_QUESTIONS)),
				// The catalog prices jev-latest all-zero (unknown); record the published rate.
				pricing: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			evaluate = (_model, ctx, toolName, input, config, instructions, guidance) =>
				evaluateSafetyJev(classifier, { ...ctx, modelRegistry: runtime }, toolName, input, config, instructions, guidance);
		} else {
			const chat = runtime.getPhysicalModel(options.provider, options.model);
			if (!chat) throw new Error("Unknown built-in physical chat model");
			model = chat;
			const selected = {
				api: chat.api, reasoning: chat.reasoning, input: chat.input,
				contextWindow: chat.contextWindow, maxTokens: chat.maxTokens,
				pricing: { input: chat.cost.input, output: chat.cost.output,
					cacheRead: chat.cost.cacheRead, cacheWrite: chat.cost.cacheWrite,
					...(chat.cost.tiers ? { tiers: chat.cost.tiers } : {}) },
			};
			modelIdentity = { ...selected, catalogHash: hash(JSON.stringify({ ...selected,
				thinkingLevelMap: chat.thinkingLevelMap, samplingParams: chat.samplingParams,
				samplingParamsByThinkingLevel: chat.samplingParamsByThinkingLevel })),
				...versions };
		}
		const startedAt = Date.now();
		console.error(`Running ${planned} evaluations (${cases.length} cases × ${options.repetitions} repetitions)…`);
		const outcomes = await runEvaluations({ cases, model, modelRegistry: runtime,
			effort: options.effort, timeoutMs: options.timeoutMs, repetitions: options.repetitions,
			pricing: modelIdentity.pricing, signal: controller.signal, evaluate,
		});
		const report: RunResult = { schemaVersion: RUN_RESULT_SCHEMA_VERSION, datasetIdentity, evaluatorPolicyIdentity,
			provider: options.provider, model: options.model, modelIdentity,
			effort: options.effort, timeoutMs: options.timeoutMs, repetitions: options.repetitions,
			startedAt, finishedAt: Date.now(), outcomes,
			aggregates: calculateAggregates(cases, outcomes, options.repetitions),
			usage: summarizeUsage(outcomes), latency: summarizeLatency(outcomes) };
		if (!isRunResult(report)) throw new Error("Benchmark report failed schema validation");
		controller.signal.throwIfAborted();
		const stamp = new Date(startedAt).toISOString().replaceAll(":", "-");
		const label = `${options.provider}-${options.model}-${options.effort}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
		const directory = await mkdtemp(join(options.logDir, `${stamp}-${label}-`));
		const json = `${JSON.stringify(report, null, 2)}\n`;
		await writeFile(join(directory, "results.json"), json, { flag: "wx", mode: 0o600 });
		await writeFile(join(directory, "report.txt"), `${formatSummary(report, cases)}\n\n${formatFullReport(report, cases)}\n`,
			{ flag: "wx", mode: 0o600 });
		if (options.output) await writeFile(options.output, json, { flag: "wx", mode: 0o600 });
		if (options.json) process.stdout.write(json);
		else console.log(formatSummary(report, cases));
		console.error(`Full report: ${join(directory, "report.txt")}\nJSON results: ${join(directory, "results.json")}`);
		return report.aggregates.failed ? 1 : 0;
	} catch {
		// Provider/runtime errors can contain credentials or request bodies.
		throw new Error(controller.signal.aborted ? "Benchmark interrupted; no report written" :
			"Benchmark execution failed. Check model/auth configuration and output path.");
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
		console.error(error instanceof Error ? error.message : "Benchmark could not finish");
		process.exitCode = 1;
	});
}
