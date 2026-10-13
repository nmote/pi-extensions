import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "../../../../benchmark/auto-approve/contracts.ts";
import { type EvalLogRecord } from "../../../../exts/auto-approve/eval-log.ts";
import { batch, fictionalize, fictionalizeCases, fingerprint, mark, readState, reset } from "./curation.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const record: EvalLogRecord = {
	schemaVersion: 1, timestamp: 1, tool: "bash", input: { command: "ls", nested: { z: 2, a: 1 } },
	cwd: "/example/work", structuredContext: { writeRoots: ["."], readRoots: ["~/docs"], instructions: ["Only list files."] },
	guidance: { text: "Allow directory listings.", revision: 2 }, model: { provider: "test", model: "fixture" },
	effort: "low", decision: "allow", reason: "fixture reason", status: "accepted",
};
const guided = { ...record, guidance: { text: "Review all calls.", revision: 2 } };
const context = { ...record, structuredContext: { ...record.structuredContext, instructions: ["Do not list files."] } };
const jsonl = (...records: unknown[]) => records.map(value => JSON.stringify(value)).join("\n") + "\n";
const publicCase = {
	schemaVersion: 1, id: "fixture-list", tool: "bash", input: { command: "ls" }, cwd: "/home/dev/work", home: "/home/dev",
	writeRoots: ["."], readRoots: [], matchedRules: [], expected: "allow", rationale: "Lists a fictional directory.",
};
const temp = await mkdtemp(join(tmpdir(), "pi-curation-test-"));
let count = 0;
async function test(name: string, run: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(temp, "fixture-"));
	await run(dir);
	count++;
	console.log(`  ok  ${name}`);
}
function runCli(args: string[], input?: string, env?: NodeJS.ProcessEnv) {
	return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8", input, env: env ?? process.env });
}
async function concurrent(args: string[]): Promise<void> {
	const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
	let error = "";
	child.stderr.on("data", chunk => { error += chunk; });
	child.stdout.resume();
	await new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("exit", code => code === 0 ? resolve() : reject(new Error(error)));
	});
}

try {
	await test("canonical fingerprints preserve authorization/context, ignoring attempt metadata", async () => {
		const reordered = { ...record, input: { nested: { a: 1, z: 2 }, command: "ls" }, timestamp: 900,
			guidance: { text: record.guidance!.text, revision: 90 }, decision: "review" as const,
			reason: "different incidental verdict", status: "discarded" as const, effort: "high" as const,
			model: { provider: "other", model: "other" } };
		assert.equal(fingerprint(record), fingerprint(reordered));
		assert.notEqual(fingerprint(record), fingerprint(guided));
		assert.notEqual(fingerprint(record), fingerprint(context));
		assert.notEqual(fingerprint(record), fingerprint({ ...record, guidance: null }));
		assert.notEqual(fingerprint(record), fingerprint({ ...record, input: { command: "pwd" } }));
		assert.notEqual(fingerprint(record), fingerprint({ ...record, cwd: "/example/elsewhere" }));
	});

	await test("batch is bounded, deduplicated and read-only, with content-free diagnostics", async dir => {
		await writeFile(join(dir, "evaluations.jsonl"), jsonl(record, record, guided, context) +
			Array.from({ length: 15 }, () => "DO_NOT_ECHO_PRIVATE_CONTENT\n").join("") + jsonl({ schemaVersion: 99 }));
		const result = await batch(dir, 2);
		assert.equal(result.examples.length, 2);
		assert.equal(result.diagnostics.invalidRecords, 16);
		assert.equal(result.diagnostics.samples.length, 8);
		assert(!JSON.stringify(result).includes("DO_NOT_ECHO_PRIVATE_CONTENT"));
		assert(!JSON.stringify(result).includes("fixture reason"));
		assert(JSON.stringify(await batch(dir, 2, false, true)).includes("fixture reason"));
		assert.deepEqual(await readdir(dir), ["evaluations.jsonl"]);
		assert.equal((await batch(dir, 20)).examples.length, 3);
		await assert.rejects(batch(dir, 0));
	});

	await test("explicit dispositions resume and pending records are available or reported missing", async dir => {
		const source = join(dir, "evaluations.jsonl");
		await writeFile(source, jsonl(record, guided, context));
		await assert.rejects(mark(dir, ["0".repeat(64)], { disposition: "excluded" }, "unused"));
		assert.deepEqual(await readdir(dir), ["evaluations.jsonl"]);
		await mark(dir, [fingerprint(record)], { disposition: "excluded", reason: "Covered by a seed." }, "unused");
		await mark(dir, [fingerprint(guided)], { disposition: "proposed", caseIds: ["candidate-1"] }, "unused");
		const pending = await batch(dir, 20, true);
		assert.equal(pending.examples.length, 1);
		assert.equal((pending.examples[0] as { id: string }).id, fingerprint(guided));
		assert.equal((await batch(dir, 20)).examples.length, 2);
		assert.equal((await stat(join(dir, "curation-state.json"))).mode & 0o777, 0o600);
		assert(!(await readFile(join(dir, "curation-state.json"), "utf8")).includes("Allow directory listings"));
		await writeFile(source, jsonl(context));
		assert.equal((await batch(dir, 20, true)).examples.length, 0);
		assert.deepEqual((await batch(dir, 20)).unavailablePending.map(value => value.id), [fingerprint(guided)]);
		await assert.rejects(reset(dir, [fingerprint(guided), "0".repeat(64)]));
		await reset(dir, [fingerprint(guided)]);
		await writeFile(source, jsonl(record, guided, context));
		await reset(dir, [fingerprint(record)]);
		assert.equal((await batch(dir, 20)).examples.length, 3);
		assert.deepEqual((await readdir(dir)).sort(), ["curation-state.json", "evaluations.jsonl"]);
	});

	await test("partial appends, rotation, truncation and oversized lines do not hide later records", async dir => {
		const source = join(dir, "evaluations.jsonl");
		const text = JSON.stringify(guided);
		await writeFile(source, jsonl(null) + "undefined\n" + jsonl(record) + text.slice(0, text.length - 10));
		const partial = await batch(dir, 20);
		assert.equal(partial.examples.length, 1);
		assert.deepEqual(partial.diagnostics.samples.map(value => value.kind), ["schema", "json", "json"]);
		await appendFile(source, text.slice(-10) + "\nnull");
		const completed = await batch(dir, 20);
		assert.equal(completed.examples.length, 2);
		assert.deepEqual(completed.diagnostics.samples.map(value => value.kind), ["schema", "json", "schema"]);
		await mark(dir, [fingerprint(record)], { disposition: "redundant" }, "unused");
		assert.equal((await batch(dir, 20)).examples.length, 1);
		await rename(source, source + ".1");
		await writeFile(source, "x".repeat(4 * 1024 * 1024 + 1) + "\n" + jsonl(context, guided));
		const rotated = await batch(dir, 20);
		assert.equal(rotated.examples.length, 2);
		assert.equal(rotated.diagnostics.samples[0].kind, "oversized");
		await writeFile(source + ".1", "");
		assert.equal((await batch(dir, 20)).examples.length, 2);
	});

	await test("added validates the current dataset and requires existing public case IDs", async dir => {
		await writeFile(join(dir, "evaluations.jsonl"), jsonl(record));
		const dataset = join(dir, "cases.fixture");
		await writeFile(dataset, jsonl(publicCase));
		await assert.rejects(mark(dir, [fingerprint(record)], { disposition: "added" }, dataset));
		await assert.rejects(mark(dir, [fingerprint(record)], { disposition: "added", caseIds: ["missing"] }, dataset));
		await writeFile(dataset, jsonl({ ...publicCase, cwd: "relative" }));
		await assert.rejects(mark(dir, [fingerprint(record)], { disposition: "added", caseIds: [publicCase.id] }, dataset));
		await writeFile(dataset, jsonl(publicCase));
		await mark(dir, [fingerprint(record)], { disposition: "added", caseIds: [publicCase.id] }, dataset);
		assert.equal((await batch(dir, 20)).examples.length, 0);
		assert.equal(await readFile(dataset, "utf8"), jsonl(publicCase));
	});

	await test("state corruption and unsafe paths fail closed without modifying targets", async dir => {
		await writeFile(join(dir, "evaluations.jsonl"), jsonl(record));
		const state = join(dir, "curation-state.json");
		for (const contents of ["not JSON", '{"schemaVersion":2,"entries":{}}', '{"schemaVersion":1,"entries":{"bad":{}}}']) {
			await writeFile(state, contents, { mode: 0o600 });
			await assert.rejects(batch(dir, 1));
			await assert.rejects(mark(dir, [fingerprint(record)], { disposition: "excluded" }, "unused"));
			assert.equal(await readFile(state, "utf8"), contents);
		}
		await writeFile(state, '{"schemaVersion":1,"entries":{}}');
		await chmod(state, 0o644);
		await assert.rejects(readState(dir));
		await rm(state);
		const target = join(temp, "outside-state");
		await writeFile(target, "DO_NOT_READ_OR_OVERWRITE", { mode: 0o600 });
		await symlink(target, state);
		await assert.rejects(readState(dir));
		await assert.rejects(mark(dir, [fingerprint(record)], { disposition: "excluded" }, "unused"));
		assert.equal(await readFile(target, "utf8"), "DO_NOT_READ_OR_OVERWRITE");
		await rm(state);
		await symlink(target, state + ".lock");
		await assert.rejects(mark(dir, [fingerprint(record)], { disposition: "excluded" }, "unused"));
		assert.equal(await readFile(target, "utf8"), "DO_NOT_READ_OR_OVERWRITE");
		assert.equal((await readdir(dir)).filter(name => name.endsWith(".tmp")).length, 0);
	});

	await test("stat failures close source, state, lock and temporary handles without committing", async dir => {
		await writeFile(join(dir, "evaluations.jsonl"), jsonl(record));
		const probe = await open(join(dir, "probe"), "w");
		const prototype = Object.getPrototypeOf(probe);
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "stat")!;
		await probe.close();
		await rm(join(dir, "probe"));
		async function failStatAt(call: number, operation: () => Promise<unknown>) {
			let failedHandle: FileHandle | undefined;
			Object.defineProperty(prototype, "stat", { ...descriptor, value: function(this: FileHandle, ...args: unknown[]) {
				if (--call === 0) {
					failedHandle = this;
					return Promise.reject(Object.assign(new Error("Synthetic stat failure"), { code: "ENOENT" }));
				}
				return Reflect.apply(descriptor.value, this, args);
			} });
			try {
				await assert.rejects(operation());
				assert(failedHandle, "fault must be reached");
				assert.equal(failedHandle.fd, -1, "failed handle must be closed");
			} finally { Object.defineProperty(prototype, "stat", descriptor); }
		}
		await failStatAt(1, () => batch(dir, 1));
		await failStatAt(1, () => mark(dir, [fingerprint(record)], { disposition: "excluded" }, "unused"));
		// An unidentified lock stays fail-closed until an idle writer is verified.
		assert.deepEqual((await readdir(dir)).sort(), ["curation-state.json.lock", "evaluations.jsonl"]);
		await rm(join(dir, "curation-state.json.lock"));
		await failStatAt(3, () => mark(dir, [fingerprint(record)], { disposition: "excluded" }, "unused"));
		const files = await readdir(dir);
		assert(!files.includes("curation-state.json") && !files.includes("curation-state.json.lock"));
		assert.equal(files.filter(name => name.endsWith(".tmp")).length, 1);
		await writeFile(join(dir, "curation-state.json"), '{"schemaVersion":1,"entries":{}}', { mode: 0o600 });
		await failStatAt(1, () => readState(dir));
		await failStatAt(2, () => readState(dir));
		assert.equal(await readFile(join(dir, "evaluations.jsonl"), "utf8"), jsonl(record));
	});

	await test("concurrent library and independent CLI writers retain both updates", async dir => {
		await writeFile(join(dir, "evaluations.jsonl"), jsonl(record, guided));
		await Promise.all([record, guided].map(value => mark(dir, [fingerprint(value)], { disposition: "excluded" }, "unused")));
		assert.equal(Object.keys((await readState(dir)).entries).length, 2);
		await reset(dir, [fingerprint(record), fingerprint(guided)]);
		await Promise.all([record, guided].map(value => concurrent([
			"mark", "--log-dir", dir, "--id", fingerprint(value), "--disposition", "excluded",
		])));
		assert.deepEqual(Object.keys((await readState(dir)).entries).sort(), [fingerprint(record), fingerprint(guided)].sort());
		assert.deepEqual((await readdir(dir)).sort(), ["curation-state.json", "evaluations.jsonl"]);
	});

	await test("fictionalization is consistent, overlap-safe, literal and non-cascading, including keys", async () => {
		const candidate = { ...publicCase, id: "mapped-list", cwd: "/source/projects/app", home: "/source",
			input: { command: "ls /source/projects/app && echo /source", nested: ["/source/projects/app", { "/source/link": "/source/projects/app" }] },
			readRoots: ["~/docs", "../other", "/source/docs"], writeRoots: ["/source/projects"],
			matchedRules: [{ instructions: "List /source/projects/app." }],
			realPaths: { "/source/link": "/source/projects/app", "/source/missing": null },
			sessionGuidance: { text: "Only list /source/projects/app.", revision: 0 } };
		const mapping = { "/source": "/home/dev", "/source/projects": "/home/dev/work", "/home/dev": "/wrong-cascade" };
		const text = fictionalizeCases(jsonl(candidate), mapping, jsonl(publicCase));
		const mapped = loadCases(text)[0];
		assert.equal(mapped.cwd, "/home/dev/work/app");
		assert.equal(mapped.home, "/home/dev");
		assert.deepEqual(mapped.readRoots, ["~/docs", "../other", "/home/dev/docs"]);
		assert.deepEqual(mapped.realPaths, { "/home/dev/link": "/home/dev/work/app", "/home/dev/missing": null });
		assert(!text.includes("/source") && !text.includes("wrong-cascade"));
		assert.equal(mapped.sessionGuidance!.text, "Only list /home/dev/work/app.");
		assert.deepEqual(fictionalize(["a.b", "aXb", "aba"], { "a.b": "$&", ab: "x", a: "y" }), ["$&", "yXb", "xy"]);
		assert.throws(() => fictionalize({ a: 1, b: 2 }, { a: "b" }), /collision/);
		assert.throws(() => fictionalize("x", { "": "y" }));
		assert.throws(() => fictionalizeCases(jsonl(candidate), { "/source": "relative" }, ""), /validation/);
		assert.throws(() => fictionalizeCases(jsonl(publicCase), mapping, jsonl(publicCase)), /validation/);
	});

	await test("CLI help, explicit IDs, stdin transformation and agent-dir default work without implicit writes", async dir => {
		const help = runCli(["--help"]);
		assert.equal(help.status, 0);
		assert(help.stdout.includes("unavailablePending") && help.stdout.includes("--map-file"));
		const missing = runCli(["mark", "--log-dir", dir, "--disposition", "excluded"]);
		assert.equal(missing.status, 1);
		assert.deepEqual(await readdir(dir), []);
		const dataset = join(dir, "cases.fixture");
		await writeFile(dataset, jsonl(publicCase));
		const candidate = { ...publicCase, id: "from-stdin", cwd: "/source/work" };
		const transformed = runCli(["fictionalize", "--map", '{"/source":"/home/dev"}', "--dataset", dataset], jsonl(candidate));
		assert.equal(transformed.status, 0, transformed.stderr);
		assert.equal(loadCases(transformed.stdout)[0].cwd, "/home/dev/work");
		const invalid = runCli(["fictionalize", "--map", '{"/source":"/home/dev"}', "--dataset", dataset], "DO_NOT_ECHO_CANDIDATE");
		assert.equal(invalid.status, 1);
		assert(!invalid.stderr.includes("DO_NOT_ECHO_CANDIDATE"));
		const logs = join(dir, "auto-approve-logs");
		// Create only synthetic fixture logs; no real agent directories are read.
		await mkdir(logs);
		await writeFile(join(logs, "evaluations.jsonl"), jsonl(record));
		const defaultBatch = runCli(["batch", "--limit", "1"], undefined, { ...process.env, PI_CODING_AGENT_DIR: dir });
		assert.equal(defaultBatch.status, 0, defaultBatch.stderr);
		assert.equal(JSON.parse(defaultBatch.stdout).examples.length, 1);
		assert.deepEqual(await readdir(logs), ["evaluations.jsonl"]);
		assert.equal(await readFile(dataset, "utf8"), jsonl(publicCase));
	});
	console.log(`\n${count} focused checks passed`);
} finally {
	await rm(temp, { recursive: true, force: true });
}
