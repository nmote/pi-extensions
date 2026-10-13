/**
 * Smoke tests for the auto-approve evaluation log writer. Run with:
 *   ./scripts/test exts/auto-approve
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_LOG_SCHEMA_VERSION, type EvalLogRecord, isEvalLogRecord } from "./eval-log.ts";
import { EvalLogWriter } from "./eval-writer.ts";

let failures = 0;
function check(name: string, cond: boolean): void {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const temp = mkdtempSync(join(tmpdir(), "pi-auto-approve-eval-writer-test-"));

const record: EvalLogRecord = {
	schemaVersion: EVAL_LOG_SCHEMA_VERSION,
	timestamp: 1,
	tool: "bash",
	input: { command: "ls" },
	cwd: "/work",
	structuredContext: { writeRoots: [], readRoots: ["/shared"], instructions: ["scope"] },
	guidance: { text: "allow builds", revision: 2 },
	model: { provider: "p", model: "m" },
	effort: "low",
	decision: "allow",
	reason: "safe",
	status: "accepted",
};

try {
	const writer = new EvalLogWriter(temp);
	const notices: string[] = [];
	const notify = (message: string) => notices.push(message);

	writer.log(record, notify);
	writer.log({ ...record, status: "discarded", guidance: null }, notify);
	const file = join(temp, "auto-approve-logs", "evaluations.jsonl");
	const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	check(
		"writes schema-conforming JSONL records",
		lines.length === 2 && lines.every(isEvalLogRecord) && lines[1].status === "discarded" && lines[1].guidance === null,
	);
	check("log directory is private", (statSync(join(temp, "auto-approve-logs")).mode & 0o777) === 0o700);
	check("log file is private", (statSync(file).mode & 0o777) === 0o600);
	check("successful writes never notify", notices.length === 0);

	const invalid = new EvalLogWriter(temp);
	invalid.log({ ...record, status: "applied" } as unknown as EvalLogRecord, notify);
	invalid.log(record, notify);
	check(
		"invalid records disable the writer with a single content-free notice",
		notices.length === 1 && !notices[0]!.includes("ls") && readFileSync(file, "utf8").trim().split("\n").length === 2,
	);

	// A file where the log directory belongs forces write failures.
	const blocked = join(temp, "blocked");
	mkdirSync(blocked, { recursive: true });
	writeFileSync(join(blocked, "auto-approve-logs"), "not a directory");
	const failing = new EvalLogWriter(blocked);
	const failureNotices: string[] = [];
	failing.log(record, (message) => failureNotices.push(message));
	failing.log(record, (message) => failureNotices.push(message));
	check("write failures disable the writer after one notice", failureNotices.length === 1);
	check("write failures do not throw", true);
} finally {
	rmSync(temp, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
