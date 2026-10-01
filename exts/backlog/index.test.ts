import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import backlog, { parseGraphArgs } from "./index.ts";

for (const args of ["aa0001", "  aa0001\n"]) {
	assert.deepEqual(parseGraphArgs(args), { id: "aa0001", format: "svg" });
}
for (const args of ["aa0001 --png", " --png\t aa0001 "]) {
	assert.deepEqual(parseGraphArgs(args), { id: "aa0001", format: "png" });
}
for (const args of ["", "--png", "invalid", "aa0001 --svg", "aa0001 --png --png", "aa0001 bb0002", "aa0001 --png extra"]) {
	assert.equal(parseGraphArgs(args), undefined, args);
}

const temp = mkdtempSync(join(tmpdir(), "pi-backlog-footer-"));
const previous = process.env.PI_BACKLOG_DIR;
try {
	process.env.PI_BACKLOG_DIR = join(temp, "backlog");
	const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
	let tool: any;
	const statuses: Array<{ color: string; text: string } | undefined> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	backlog({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerTool: (value: any) => { tool = value; },
		registerCommand: (name: string, command: any) => handlers.set(name, command.handler),
	} as any);
	const ctx = {
		cwd: temp,
		hasUI: true,
		sessionManager: { getSessionId: () => "test" },
		ui: {
			theme: { fg: (color: string, text: string) => ({ color, text }) },
			setStatus: (_key: string, value: any) => statuses.push(value),
			notify: (message: string, level: string) => notifications.push({ message, level }),
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
	await handlers.get("backlog-graph")!("aa0001 --unknown", ctx);
	assert.deepEqual(notifications.at(-1), { message: "Usage: /backlog-graph <item ID> [--png]", level: "error" });
} finally {
	if (previous === undefined) delete process.env.PI_BACKLOG_DIR;
	else process.env.PI_BACKLOG_DIR = previous;
	rmSync(temp, { recursive: true, force: true });
}
