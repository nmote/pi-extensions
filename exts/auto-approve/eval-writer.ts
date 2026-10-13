/**
 * Best-effort JSONL writer for auto-approve evaluator log records.
 *
 * Appends to <agent-dir>/auto-approve-logs/evaluations.jsonl (dir 0700, file
 * 0600). O_APPEND line writes do not interleave between processes on
 * macOS/Linux local filesystems, so one shared file serves concurrent
 * sessions. Logging never affects approval behavior: the first serialization
 * or write failure permanently disables the writer and surfaces a single
 * notification that excludes record content.
 */

import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isEvalLogRecord, type EvalLogRecord } from "./eval-log.ts";

export class EvalLogWriter {
	private readonly dir: string;
	private readonly file: string;
	private initialized = false;
	private disabled = false;
	private notified = false;

	constructor(agentDir: string) {
		this.dir = join(agentDir, "auto-approve-logs");
		this.file = join(this.dir, "evaluations.jsonl");
	}

	private initialize(): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		chmodSync(this.dir, 0o700);
		appendFileSync(this.file, "", { mode: 0o600 });
		chmodSync(this.file, 0o600);
		this.initialized = true;
	}

	log(record: EvalLogRecord, notify: (message: string) => void): void {
		if (this.disabled) return;
		try {
			if (!isEvalLogRecord(record)) throw new Error("record does not match the eval-log schema");
			if (!this.initialized) this.initialize();
			appendFileSync(this.file, `${JSON.stringify(record)}\n`);
		} catch (error) {
			this.disabled = true;
			if (!this.notified) {
				this.notified = true;
				notify(`Auto-approve: evaluation logging disabled (${error instanceof Error ? error.message : error})`);
			}
		}
	}
}
