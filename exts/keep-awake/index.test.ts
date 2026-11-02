import assert from "node:assert/strict";
import { type ChildProcess, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { registerKeepAwake } from "./index.ts";

function harness(platform = "darwin") {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const children: Array<EventEmitter & { kill: (signal?: string) => boolean }> = [];
	const signals: string[] = [];
	const warnings: string[] = [];
	let spawnError = false;
	let autoExit = true;
	registerKeepAwake({ on: (event: string, handler: any) => handlers.set(event, handler) } as any, platform,
		((command: string, args: string[], options: unknown) => {
			assert.equal(command, "/usr/bin/caffeinate");
			assert.deepEqual(args, ["-i", "-w", String(process.pid)]);
			assert.deepEqual(options, { stdio: "ignore" });
			if (spawnError) throw new Error("spawn failed");
			const child = Object.assign(new EventEmitter(), {
				kill(signal = "SIGTERM") {
					signals.push(signal);
					if (autoExit) queueMicrotask(() => child.emit("exit", null, signal));
					return true;
				},
			});
			children.push(child);
			return child as unknown as ChildProcess;
		}) as typeof spawn);
	return {
		children, signals, warnings,
		set spawnError(value: boolean) { spawnError = value; },
		set autoExit(value: boolean) { autoExit = value; },
		async emit(event: string, data = {}) {
			await handlers.get(event)?.(data, {
				hasUI: true,
				ui: { notify: (message: string) => warnings.push(message) },
			});
		},
	};
}

// Low-level run boundaries retain one inhibitor until settlement, including aborts.
const lifecycle = harness();
await lifecycle.emit("session_start");
assert.equal(lifecycle.children.length, 0);
for (const aborted of [false, true]) {
	await lifecycle.emit("agent_start");
	const count: number = lifecycle.children.length;
	await lifecycle.emit("agent_end");
	await lifecycle.emit("agent_start");
	assert.equal(lifecycle.children.length, count);
	await lifecycle.emit("agent_settled", { aborted });
	await lifecycle.emit("agent_settled");
}
await lifecycle.emit("agent_start");
await lifecycle.emit("session_shutdown");
await lifecycle.emit("session_shutdown");
await lifecycle.emit("agent_start");
assert.equal(lifecycle.children.length, 3);
assert.deepEqual(lifecycle.signals, ["SIGTERM", "SIGTERM", "SIGTERM"]);
assert.deepEqual(lifecycle.warnings, []);

// A subsequent run waits for the old process to exit.
const delayed = harness();
delayed.autoExit = false;
await delayed.emit("agent_start");
const stopping = delayed.emit("agent_settled");
const restarting = delayed.emit("agent_start");
await Promise.resolve();
assert.equal(delayed.children.length, 1);
delayed.children[0].emit("exit", 0);
await Promise.all([stopping, restarting]);
assert.equal(delayed.children.length, 2);
delayed.autoExit = true;
await delayed.emit("session_shutdown");
assert.deepEqual(delayed.warnings, []);

// Both spawn failures and unexpected exits clear state; warnings are session-scoped.
const failures = harness();
failures.spawnError = true;
await failures.emit("agent_start");
failures.spawnError = false;
await failures.emit("agent_start");
failures.children[0].emit("error", new Error("ENOENT"));
await failures.emit("agent_start");
failures.children[1].emit("exit", 1);
assert.equal(failures.warnings.length, 1);
await failures.emit("session_shutdown");
await failures.emit("session_start");
await failures.emit("agent_start");
failures.children[2].emit("exit", 1);
assert.equal(failures.warnings.length, 2);

for (const platform of ["linux", "win32"]) {
	const unsupported = harness(platform);
	await unsupported.emit("agent_start");
	await unsupported.emit("agent_settled");
	await unsupported.emit("session_shutdown");
	assert.equal(unsupported.children.length, 0);
	assert.deepEqual(unsupported.warnings, []);
}
