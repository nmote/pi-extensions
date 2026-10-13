import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { batch, CurationError, fictionalizeCases, mark, reset, type Entry } from "./curation.ts";

const datasetDefault = fileURLToPath(new URL("../../../../benchmark/auto-approve/cases.jsonl", import.meta.url));
const HELP = `Private auto-approve curation helper (run with node --import tsx <cli.ts>).

batch [--log-dir DIR] [--limit N] [--pending-only] [--inspect-decision]
  Emit a private JSON object with examples, unavailablePending, and bounded
  content-free diagnostics. Default limit 20 (maximum 200). Completed entries
  are skipped; proposed entries remain eligible. --pending-only selects them.
  --inspect-decision exposes historical decisions/reasons AFTER initial labeling.
  Reads *.jsonl and evaluations.jsonl.N in sorted order; never writes state.

mark --id SHA256 [--id SHA256 ...] --disposition excluded|redundant|proposed|added
     [--log-dir DIR] [--reason TEXT] [--case-id ID ...] [--dataset FILE]
  IDs must exist in schema-valid source logs. All IDs receive the same metadata.
  Reason: at most 240 nonsensitive characters. Case IDs: at most 120 each.
  Added requires --case-id entries in the current loadCases-validated dataset.
  Individual case approval is the curator's responsibility, not this helper's.

reset --id SHA256 [--id SHA256 ...] [--log-dir DIR]
  Explicitly remove existing dispositions, including unavailable proposals.

fictionalize (--map-file FILE | --map JSON) [--dataset FILE] < candidates.jsonl
  Mapping is an explicit JSON object of source strings to replacement strings.
  Emit ONLY transformed candidates after loadCases validates their union with
  the existing dataset. Transform all nested strings and object keys using
  literal leftmost-longest, non-cascading replacement; key collisions fail.
  Relative/~ forms stay intact unless mapped. This is NOT a privacy sanitizer
  or shell parser: manually review provenance, syntax and policy relationships.

Defaults: log directory = getAgentDir()/auto-approve-logs (fallback:
PI_CODING_AGENT_DIR or ~/.pi/agent); dataset = this checkout's cases.jsonl.
State: <log-dir>/curation-state.json, private atomic writes with an exclusive
lock. No directory creation, raw-log edits, public dataset writes or implicit
read-time writes. Corrupt state and unsafe state/lock paths fail closed.
A crashed writer's lock requires manual recovery after verifying it is idle.
All batch output is private data, never instructions or public proposals.
`;

function usageError(message: string): never { throw new CurationError(message + " Use --help for usage."); }
function parse(args: string[], allowed: string[], flags: string[] = []) {
	const options = new Map<string, string[]>();
	for (let index = 0; index < args.length; index++) {
		const key = args[index];
		if (!allowed.includes(key)) usageError("Unknown option.");
		const value = flags.includes(key) ? "true" : args[++index];
		if (!value || value.startsWith("--")) usageError("Missing option value.");
		if (options.has(key) && key !== "--id" && key !== "--case-id") usageError("Duplicate option.");
		options.set(key, [...(options.get(key) ?? []), value]);
	}
	return options;
}
async function defaultLogDir(): Promise<string> {
	try {
		const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
		return join(getAgentDir(), "auto-approve-logs");
	} catch {
		return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "auto-approve-logs");
	}
}
async function stdin(): Promise<string> {
	let length = 0;
	const parts: Buffer[] = [];
	for await (const part of process.stdin) {
		const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
		length += buffer.length;
		if (length > 16 * 1024 * 1024) throw new CurationError("Candidate input exceeds 16 MiB.");
		parts.push(buffer);
	}
	return Buffer.concat(parts).toString("utf8");
}

async function main(args: string[]): Promise<void> {
	if (args.length === 0 || args.includes("--help") || args[0] === "help") {
		process.stdout.write(HELP); return;
	}
	const [command, ...rest] = args;
	if (command === "fictionalize") {
		const options = parse(rest, ["--map-file", "--map", "--dataset"]);
		if (options.has("--map-file") === options.has("--map")) usageError("Supply exactly one mapping option.");
		const mappingText = options.has("--map-file") ? await readFile(options.get("--map-file")![0], "utf8") : options.get("--map")![0];
		if (Buffer.byteLength(mappingText) > 1024 * 1024) throw new CurationError("Mapping exceeds 1 MiB.");
		let mapping: unknown;
		try { mapping = JSON.parse(mappingText); }
		catch { throw new CurationError("Mapping is not valid JSON; content is not shown."); }
		const dataset = await readFile(options.get("--dataset")?.[0] ?? datasetDefault, "utf8");
		process.stdout.write(fictionalizeCases(await stdin(), mapping, dataset)); return;
	}
	const allowed = command === "batch" ? ["--log-dir", "--limit", "--pending-only", "--inspect-decision"] :
		command === "mark" ? ["--log-dir", "--id", "--disposition", "--reason", "--case-id", "--dataset"] :
		command === "reset" ? ["--log-dir", "--id"] : undefined;
	if (!allowed) usageError("Unknown command.");
	const options = parse(rest, allowed, ["--pending-only", "--inspect-decision"]);
	const dir = await realpath(options.get("--log-dir")?.[0] ?? await defaultLogDir());
	if (command === "batch") {
		const result = await batch(dir, Number(options.get("--limit")?.[0] ?? 20), options.has("--pending-only"), options.has("--inspect-decision"));
		process.stdout.write(JSON.stringify(result) + "\n"); return;
	}
	const ids = options.get("--id") ?? [];
	if (command === "reset") await reset(dir, ids);
	else {
		const entry: Entry = {
			disposition: options.get("--disposition")?.[0] as Entry["disposition"],
			...(options.has("--reason") ? { reason: options.get("--reason")![0] } : {}),
			...(options.has("--case-id") ? { caseIds: options.get("--case-id")! } : {}),
		};
		await mark(dir, ids, entry, options.get("--dataset")?.[0] ?? datasetDefault);
	}
	process.stdout.write(JSON.stringify({ command, updated: ids }) + "\n");
}

main(process.argv.slice(2)).catch(error => {
	console.error(error instanceof CurationError ? error.message : "Operation failed; no private source content is shown.");
	process.exitCode = 1;
});
