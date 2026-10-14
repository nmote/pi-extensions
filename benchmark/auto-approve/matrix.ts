import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { cliOptions } from "./run.ts";
import { isRunResult, type RunResult } from "./contracts.ts";

interface Entry { provider: string; model: string; effort: "low" | "medium" | "high" }
interface Row extends Entry {
	status: "pending" | "unavailable" | "failed" | "completed" | "interrupted";
	exitCode?: number | null;
	results?: string;
	report?: string;
	stdout?: string;
	stderr?: string;
	error?: string;
	aggregates?: RunResult["aggregates"];
	averageEstimatedCostUsd?: number | null;
	averageLatencyMs?: number | null;
}
const here = fileURLToPath(new URL("./", import.meta.url));

export function loadMatrix(value: unknown): Entry[] {
	if (!Array.isArray(value) || !value.length) throw new Error("Matrix must be a nonempty array");
	const seen = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Object.keys(entry).sort().join() !== "effort,model,provider" ||
			typeof entry.provider !== "string" || !entry.provider.trim() ||
			typeof entry.model !== "string" || !entry.model.trim() ||
			!["low", "medium", "high"].includes(entry.effort)) throw new Error("Invalid matrix entry");
		const key = JSON.stringify([entry.provider, entry.model, entry.effort]);
		if (seen.has(key)) throw new Error("Duplicate matrix entry");
		seen.add(key);
	}
	return value;
}

export function matrixOptions(args: string[]) {
	const { values } = parseArgs({ args, allowPositionals: false, options: {
		cases: { type: "string" }, repetitions: { type: "string" }, "timeout-ms": { type: "string" },
		"auth-path": { type: "string" }, "log-dir": { type: "string" },
		"dry-run": { type: "boolean", default: false }, help: { type: "boolean", default: false },
	} });
	const shared = Object.entries(values).flatMap(([key, value]) => typeof value === "string" ? [`--${key}`, value] : []);
	const options = cliOptions(["--provider", "matrix", "--model", "matrix", ...shared]);
	if (options.help) throw new Error("Unexpected help option");
	return { ...options, help: values.help, dryRun: values["dry-run"], shared };
}

export function formatMatrix(rows: Row[]): string {
	const score = (value: number | null | undefined) => value == null ? "n/a" : value.toFixed(4);
	const lines = rows.map((row) => {
		const a = row.aggregates;
		return [`${row.provider}/${row.model} (${row.effort})`, score(a?.precision), score(a?.recall), score(a?.f2),
			a ? `${a.consistency.unanimous}/${a.consistency.mixed}/${a.consistency.insufficient}` : "n/a",
			row.averageEstimatedCostUsd == null ? "n/a" : `$${row.averageEstimatedCostUsd.toFixed(6)}`,
			row.averageLatencyMs == null ? "n/a" : row.averageLatencyMs.toFixed(1)];
	});
	const table = [["Evaluator", "Precision", "Recall", "F2", "Consistency (unanimous/mixed/insufficient)", "Avg cost/eval (USD)", "Avg latency (ms)"], ...lines];
	const widths = table[0].map((_, i) => Math.max(...table.map((line) => line[i].length)));
	return table.map((line) => line.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

async function childRun(runner: string, args: string[], signal: AbortSignal, logs?: { stdout: string; stderr: string }) {
	const out = logs ? await open(logs.stdout, "wx", 0o600) : undefined;
	let err: Awaited<ReturnType<typeof open>> | undefined;
	try {
		err = logs ? await open(logs.stderr, "wx", 0o600) : undefined;
		signal.throwIfAborted();
		return await new Promise<{ code: number | null; stdout: string }>((accept, reject) => {
			const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), runner, ...args], {
				stdio: ["ignore", out?.fd ?? "pipe", err?.fd ?? "pipe"],
			});
			let stdout = "";
			child.stdout?.on("data", (data) => { stdout += data.toString(); });
			// Preflight errors are deliberately not echoed: they may contain dataset content.
			child.stderr?.resume();
			let timer: NodeJS.Timeout | undefined;
			const interrupt = () => {
				child.kill("SIGTERM");
				timer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
			};
			signal.addEventListener("abort", interrupt, { once: true });
			if (signal.aborted) interrupt();
			child.on("error", reject);
			child.on("close", (code) => {
				signal.removeEventListener("abort", interrupt);
				if (timer) clearTimeout(timer);
				accept({ code, stdout });
			});
		});
	} finally {
		await out?.close();
		await err?.close();
	}
}

interface Dependencies {
	runner?: string;
	available?: (entry: Entry, signal: AbortSignal) => Promise<boolean>;
}

export async function main(args: string[], dependencies: Dependencies = {}): Promise<number> {
	const options = matrixOptions(args);
	if (options.help) {
		console.log(`Usage: npm run --silent benchmark:auto-approve:matrix -- [options]
  --cases PATH          Default committed cases.jsonl
  --repetitions INTEGER Default 3
  --timeout-ms INTEGER  Default 30000
  --auth-path PATH      Pi credential-file override
  --log-dir PATH        Default logs/auto-approve
  --dry-run             Validate/reconstruct without auth, requests or logs
  --help`);
		return 0;
	}
	const entries = loadMatrix(JSON.parse(await readFile(join(here, "matrix.json"), "utf8")));
	const runner = dependencies.runner ?? join(here, "run.ts");
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	try {
		const runnerArgs = (entry: Entry) => ["--provider", entry.provider, "--model", entry.model, "--effort", entry.effort, ...options.shared];
		for (const entry of entries) {
			const preview = await childRun(runner, [...runnerArgs(entry), "--dry-run", "--json"], controller.signal);
			if (controller.signal.aborted) return 130;
			if (preview.code !== 0) throw new Error("Matrix preflight failed; check dataset and options");
			const planned: unknown = JSON.parse(preview.stdout).plannedRequests;
			if (!Number.isSafeInteger(planned) || (planned as number) < 1) throw new Error("Invalid runner preview");
			if (options.dryRun) console.log(`${entry.provider}/${entry.model} (${entry.effort}): ${planned} planned requests`);
		}
		if (options.dryRun) return 0;
		await mkdir(options.logDir, { recursive: true, mode: 0o700 });
		const directory = await mkdtemp(join(options.logDir, `matrix-${new Date().toISOString().replaceAll(":", "-")}-`));
		console.error(`Matrix logs: ${directory}`);
		const rows: Row[] = entries.map((entry) => ({ ...entry, status: "pending" }));
		const save = async () => {
			await writeFile(join(directory, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, interrupted: controller.signal.aborted, entries: rows }, null, 2)}\n`, { mode: 0o600 });
			await writeFile(join(directory, "summary.txt"), `${formatMatrix(rows)}\n`, { mode: 0o600 });
		};
		await save();
		let runtime: ModelRuntime | undefined;
		const available = dependencies.available ?? (async (entry: Entry, signal: AbortSignal) => {
			runtime ??= await ModelRuntime.create({ modelsPath: null, authPath: options.authPath,
				refreshOnCreate: false, allowModelNetwork: false, signal });
			return !!runtime.getPhysicalModel(entry.provider, entry.model);
		});
		for (const [index, row] of rows.entries()) {
			if (controller.signal.aborted) break;
			const label = `${row.provider}/${row.model} (${row.effort})`;
			try {
				const exists = await available(row, controller.signal);
				controller.signal.throwIfAborted();
				if (!exists) {
					row.status = "unavailable";
					console.error(`Unavailable built-in model: ${label}`);
				} else if (!controller.signal.aborted) {
					const entryDir = join(directory, String(index + 1));
					await mkdir(entryDir, { mode: 0o700 });
					row.stdout = join(entryDir, "stdout.txt");
					row.stderr = join(entryDir, "stderr.txt");
					console.error(`Running ${label}…`);
					const result = await childRun(runner, [...runnerArgs(row), "--log-dir", entryDir, "--json"], controller.signal,
						{ stdout: row.stdout, stderr: row.stderr });
					row.exitCode = result.code;
					row.status = controller.signal.aborted ? "interrupted" : result.code === 0 ? "completed" : "failed";
					const reports = (await readdir(entryDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
					if (reports.length !== 1) throw new Error("No unique report directory");
					const reportDir = join(entryDir, reports[0].name);
					const report: unknown = JSON.parse(await readFile(join(reportDir, "results.json"), "utf8"));
					if (!isRunResult(report) || report.provider !== row.provider || report.model !== row.model || report.effort !== row.effort) {
						throw new Error("Invalid runner report");
					}
					row.results = join(reportDir, "results.json");
					row.aggregates = report.aggregates;
					row.averageEstimatedCostUsd = report.usage.averageEstimatedCostUsd;
					row.averageLatencyMs = report.latency.averageMs;
					if (report.aggregates.failed) {
						if (!controller.signal.aborted) row.status = "failed";
						console.error(`${label}: scores exclude ${report.aggregates.failed} failed attempts`);
					}
					await readFile(join(reportDir, "report.txt"));
					row.report = join(reportDir, "report.txt");
				}
			} catch {
				row.status = controller.signal.aborted ? "interrupted" : "failed";
				row.error = "Model check or execution failed, or no valid report was written";
			}
			if (row.status === "failed") console.error(`Failed: ${label}; see private logs`);
			await save();
		}
		if (controller.signal.aborted) {
			for (const row of rows) if (row.status === "pending") row.status = "interrupted";
			console.error("Matrix interrupted; completed logs preserved");
		}
		await save();
		console.log(formatMatrix(rows));
		return controller.signal.aborted ? 130 : rows.some((row) => row.status !== "completed") ? 1 : 0;
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
		console.error("Matrix could not finish; check options, dataset and log paths");
		process.exitCode = 1;
	});
}
