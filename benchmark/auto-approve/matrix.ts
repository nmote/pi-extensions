import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { cliOptions } from "./run.ts";
import { isRunResult, type RunResult } from "./contracts.ts";

interface Binding { provider: string; model: string }
interface Entry { id: string; kind: "chat" | "classifier"; effort: "low" | "medium" | "high"; candidates: Binding[]; chat?: string }
interface ResolvedEntry extends Binding { id: string; kind: Entry["kind"]; effort: Entry["effort"]; fallback?: Binding }
interface Row extends Entry {
	provider?: string;
	model?: string;
	fallback?: Binding;
	status: "pending" | "unavailable" | "failed" | "completed" | "interrupted";
	exitCode?: number | null;
	results?: string;
	report?: string;
	stdout?: string;
	stderr?: string;
	error?: string;
	aggregates?: RunResult["aggregates"];
	fallbackCount?: number;
	fallbackRate?: number | null;
	averageEstimatedCostUsd?: number | null;
	totalEstimatedCostUsd?: number | null;
	averageLatencyMs?: number | null;
}
const here = fileURLToPath(new URL("./", import.meta.url));

export function loadMatrix(value: unknown): Entry[] {
	if (!Array.isArray(value) || !value.length) throw new Error("Matrix must be a nonempty array");
	const seen = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Object.keys(entry).sort().join() !== (entry.kind === "classifier" ? "candidates,chat,effort,id,kind" : "candidates,effort,id,kind") ||
			typeof entry.id !== "string" || !entry.id.trim() || !["chat", "classifier"].includes(entry.kind) ||
			!["low", "medium", "high"].includes(entry.effort) || !Array.isArray(entry.candidates) ||
			!entry.candidates.length || !entry.candidates.every(isBinding)) throw new Error("Invalid matrix entry");
		if (new Set(entry.candidates.map((candidate: Binding) => JSON.stringify([candidate.provider, candidate.model]))).size !== entry.candidates.length) {
			throw new Error("Duplicate matrix candidate");
		}
		const key = entry.id;
		if (seen.has(key)) throw new Error("Duplicate matrix entry");
		seen.add(key);
	}
	for (const entry of value) {
		if (entry.kind === "classifier" && !value.some((chat) => chat.id === entry.chat && chat.kind === "chat")) throw new Error("Classifier requires a chat entry");
	}
	return value;
}

function isBinding(value: unknown): value is Binding {
	if (!value || typeof value !== "object") return false;
	const binding = value as Binding;
	return Object.keys(value).sort().join() === "model,provider" &&
		typeof binding.provider === "string" && !!binding.provider.trim() &&
		typeof binding.model === "string" && !!binding.model.trim();
}

export function loadBindings(value: unknown, entries: Entry[]): Record<string, Binding> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bindings");
	for (const [id, binding] of Object.entries(value)) {
		if (!entries.some((entry) => entry.id === id) || !isBinding(binding)) throw new Error("Invalid evaluator binding");
	}
	return value as Record<string, Binding>;
}

export async function resolveEntry(entry: Entry, binding: Binding | undefined,
	available: (entry: ResolvedEntry) => Promise<boolean>): Promise<ResolvedEntry | undefined> {
	for (const candidate of binding ? [binding] : entry.candidates) {
		const resolved = { id: entry.id, kind: entry.kind, effort: entry.effort, ...candidate };
		if (await available(resolved)) return resolved;
	}
	if (binding) throw new Error(`Explicit binding unavailable: ${entry.id}`);
	return undefined;
}

export function matrixOptions(args: string[]) {
	const { values } = parseArgs({ args, allowPositionals: false, options: {
		cases: { type: "string" }, repetitions: { type: "string" }, "timeout-ms": { type: "string" },
		"auth-path": { type: "string" }, "log-dir": { type: "string" },
		bindings: { type: "string" }, "resolve-only": { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false }, help: { type: "boolean", default: false },
	} });
	if (values["dry-run"] && values["resolve-only"]) throw new Error("--dry-run and --resolve-only are mutually exclusive");
	const shared = Object.entries(values).flatMap(([key, value]) => typeof value === "string" && key !== "bindings" ? [`--${key}`, value] : []);
	const options = cliOptions(["--provider", "matrix", "--model", "matrix", ...shared]);
	if (options.help) throw new Error("Unexpected help option");
	return { ...options, help: values.help, dryRun: values["dry-run"], resolveOnly: values["resolve-only"], bindings: values.bindings, shared };
}

export function formatMatrix(rows: Row[]): string {
	const score = (value: number | null | undefined) => value == null ? "n/a" : value.toFixed(4);
	const lines = rows.map((row) => {
		const a = row.aggregates;
		return [`${row.id}: ${row.provider ? `${row.provider}/${row.model}` : "unavailable"} (${row.effort})`, score(a?.precision), score(a?.recall), score(a?.f2),
			a ? `${a.consistency.unanimous}/${a.consistency.mixed}/${a.consistency.insufficient}` : "n/a",
			row.averageEstimatedCostUsd == null ? "n/a" : `$${row.averageEstimatedCostUsd.toFixed(6)}`,
			row.totalEstimatedCostUsd == null ? "n/a" : `$${row.totalEstimatedCostUsd.toFixed(4)}`,
			row.averageLatencyMs == null ? "n/a" : row.averageLatencyMs.toFixed(1),
			row.fallbackCount == null ? "n/a" : `${row.fallbackCount} (${((row.fallbackRate ?? 0) * 100).toFixed(1)}%)`];
	});
	const known = rows.flatMap((row) => row.totalEstimatedCostUsd == null ? [] : [row.totalEstimatedCostUsd]);
	const total = known.length
		? `$${known.reduce((sum, value) => sum + value, 0).toFixed(4)}${known.length < rows.length ? "+" : ""}`
		: "n/a";
	const table = [["Evaluator", "Precision", "Recall", "F2", "Consistency (unanimous/mixed/insufficient)", "Avg cost/eval (USD)", "Run cost (USD)", "Avg latency (ms)", "Chat fallbacks"], ...lines,
		["Total", "", "", "", "", "", total, "", ""]];
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
	available?: (entry: ResolvedEntry, signal: AbortSignal) => Promise<boolean>;
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
  --bindings PATH       Local evaluator ID -> { provider, model } overrides
  --resolve-only        Resolve using local auth; no inference requests or logs
  --dry-run             Validate/reconstruct without auth, requests or logs
  --help`);
		return 0;
	}
	const entries = loadMatrix(JSON.parse(await readFile(join(here, "matrix.json"), "utf8")));
	const bindings = options.bindings ? loadBindings(JSON.parse(await readFile(resolve(options.bindings), "utf8")), entries) : {};
	const runner = dependencies.runner ?? join(here, "run.ts");
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	try {
		const runnerArgs = (entry: ResolvedEntry) => ["--provider", entry.provider, "--model", entry.model, "--type", entry.kind, "--effort", entry.effort,
			...(entry.fallback ? ["--chat-provider", entry.fallback.provider, "--chat-model", entry.fallback.model] : []), ...options.shared];
		for (const entry of entries) {
			const candidate = Object.hasOwn(bindings, entry.id) ? bindings[entry.id] : entry.candidates[0];
			const chat = entries.find((item) => item.id === entry.chat);
			const fallback = chat ? bindings[chat.id] ?? chat.candidates[0] : undefined;
			const preview = await childRun(runner, [...runnerArgs({ ...entry, ...candidate, fallback }), "--dry-run", "--json"], controller.signal);
			if (controller.signal.aborted) return 130;
			if (preview.code !== 0) throw new Error("Matrix preflight failed; check dataset and options");
			const planned: unknown = JSON.parse(preview.stdout).plannedRequests;
			if (!Number.isSafeInteger(planned) || (planned as number) < 1) throw new Error("Invalid runner preview");
			if (options.dryRun) console.log(`${entry.id} (${entry.kind}, ${entry.effort}): ${planned} planned evaluations${entry.kind === "classifier" ? " (up to two model requests each)" : ""}; provider unresolved`);
		}
		if (options.dryRun) return 0;
		let runtime: ModelRuntime | undefined;
		const available = dependencies.available ?? (async (entry: ResolvedEntry, signal: AbortSignal) => {
			runtime ??= await ModelRuntime.create({ modelsPath: null, authPath: options.authPath,
				refreshOnCreate: false, allowModelNetwork: false, signal });
			const models = await runtime.getAvailableOfType(entry.kind, entry.provider, { signal });
			return models.some((model) => model.id === entry.model && (entry.kind === "classifier" ||
				!!runtime!.getPhysicalModel(entry.provider, entry.model)));
		});
		const resolved = new Map<string, ResolvedEntry>();
		for (const entry of [...entries].sort((a, b) => Number(a.kind === "classifier") - Number(b.kind === "classifier"))) {
			const selected = await resolveEntry(entry, Object.hasOwn(bindings, entry.id) ? bindings[entry.id] : undefined,
				(candidate) => available(candidate, controller.signal));
			controller.signal.throwIfAborted();
			const fallback = entry.chat ? resolved.get(entry.chat) : undefined;
			if (selected && (entry.kind === "chat" || fallback)) {
				if (fallback) selected.fallback = { provider: fallback.provider, model: fallback.model };
				resolved.set(entry.id, selected);
			}
			if (options.resolveOnly) console.log(`${entry.id}: ${resolved.has(entry.id) ? `${selected!.provider}/${selected!.model}${fallback ? ` + ${fallback.provider}/${fallback.model}` : ""}` : "unavailable"} (${entry.kind}, ${entry.effort})`);
		}
		if (options.resolveOnly) return resolved.size === entries.length ? 0 : 1;
		await mkdir(options.logDir, { recursive: true, mode: 0o700 });
		const directory = await mkdtemp(join(options.logDir, `matrix-${new Date().toISOString().replaceAll(":", "-")}-`));
		console.error(`Matrix logs: ${directory}`);
		const rows: Row[] = entries.map((entry) => ({ ...entry, ...resolved.get(entry.id), status: "pending" }));
		const save = async () => {
			await writeFile(join(directory, "manifest.json"), `${JSON.stringify({ schemaVersion: 2, interrupted: controller.signal.aborted, entries: rows }, null, 2)}\n`, { mode: 0o600 });
			await writeFile(join(directory, "summary.txt"), `${formatMatrix(rows)}\n`, { mode: 0o600 });
		};
		await save();
		for (const [index, row] of rows.entries()) {
			if (controller.signal.aborted) break;
			const selected = resolved.get(row.id);
			const label = `${row.id}: ${selected ? `${selected.provider}/${selected.model}` : "unavailable"} (${row.effort})`;
			try {
				if (!selected) {
					row.status = "unavailable";
					console.error(`Unavailable evaluator: ${label}`);
				} else if (!controller.signal.aborted) {
					const entryDir = join(directory, String(index + 1));
					await mkdir(entryDir, { mode: 0o700 });
					row.stdout = join(entryDir, "stdout.txt");
					row.stderr = join(entryDir, "stderr.txt");
					console.error(`Running ${label}…`);
					const result = await childRun(runner, [...runnerArgs(selected), "--log-dir", entryDir, "--json"], controller.signal,
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
					if (selected.fallback && (!("hybrid" in report.modelIdentity) ||
						report.modelIdentity.hybrid?.provider !== selected.fallback.provider ||
						report.modelIdentity.hybrid?.model !== selected.fallback.model ||
						report.modelIdentity.hybrid?.effort !== selected.effort)) throw new Error("Hybrid identity mismatch");
					row.results = join(reportDir, "results.json");
					row.aggregates = report.aggregates;
					row.fallbackCount = report.outcomes.filter((outcome) => outcome.routing?.fallbackUsed).length;
					row.fallbackRate = report.outcomes.length ? row.fallbackCount / report.outcomes.length : null;
					row.averageEstimatedCostUsd = report.usage.averageEstimatedCostUsd;
					row.totalEstimatedCostUsd = report.usage.totalEstimatedCostUsd;
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
	} catch (error) {
		if (controller.signal.aborted) return 130;
		throw error;
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
