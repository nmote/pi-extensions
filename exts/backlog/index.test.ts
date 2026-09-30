import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import backlog from "./index.ts";

const temp = mkdtempSync(join(tmpdir(), "pi-backlog-footer-"));
const previous = process.env.PI_BACKLOG_DIR;
try {
	process.env.PI_BACKLOG_DIR = join(temp, "backlog");
	const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
	let tool: any;
	const statuses: Array<{ color: string; text: string } | undefined> = [];
	backlog({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerTool: (value: any) => { tool = value; },
		registerCommand() {},
	} as any);
	const ctx = {
		cwd: temp,
		hasUI: true,
		sessionManager: { getSessionId: () => "test" },
		ui: {
			theme: { fg: (color: string, text: string) => ({ color, text }) },
			setStatus: (_key: string, value: any) => statuses.push(value),
		},
	};
	await handlers.get("session_start")!({}, ctx);
	assert.equal(statuses.at(-1), undefined);
	await tool.execute("add", { operations: [{ action: "add", title: "Test" }] }, undefined, undefined, ctx);
	assert.deepEqual(statuses.at(-1), { color: "dim", text: "[backlog: 1 open]" });
	rmSync(process.env.PI_BACKLOG_DIR, { recursive: true });
	writeFileSync(process.env.PI_BACKLOG_DIR, "not a directory");
	await handlers.get("agent_end")!({}, ctx);
	assert.deepEqual(statuses.at(-1), { color: "warning", text: "[backlog: unreadable]" });
} finally {
	if (previous === undefined) delete process.env.PI_BACKLOG_DIR;
	else process.env.PI_BACKLOG_DIR = previous;
	rmSync(temp, { recursive: true, force: true });
}
