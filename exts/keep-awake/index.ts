import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function registerKeepAwake(pi: ExtensionAPI, platform: string, spawnProcess: typeof spawn): void {
	let child: ChildProcess | undefined;
	let finished: Promise<void> = Promise.resolve();
	let stopping: Promise<void> = Promise.resolve();
	let warned = false;
	let shutdown = false;

	function warn(ctx: ExtensionContext): void {
		if (warned) return;
		warned = true;
		if (ctx.hasUI) ctx.ui.notify("Keep-awake: caffeinate is unavailable; idle sleep is not inhibited.", "warning");
	}

	async function start(ctx: ExtensionContext): Promise<void> {
		if (platform !== "darwin") return;
		await stopping;
		if (shutdown || child) return;
		try {
			const inhibitor = spawnProcess("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
				stdio: "ignore",
			});
			child = inhibitor;
			finished = new Promise<void>((resolve) => {
				const finish = () => {
					if (child === inhibitor) {
						child = undefined;
						warn(ctx);
					}
					resolve();
				};
				inhibitor.once("error", finish);
				inhibitor.once("exit", finish);
			});
		} catch {
			warn(ctx);
		}
	}

	function stop(): Promise<void> {
		if (!child) return stopping;
		const inhibitor = child;
		child = undefined;
		const exited = finished;
		inhibitor.kill();
		// Escalate if the child does not respond to SIGTERM.
		const timeout = setTimeout(() => inhibitor.kill("SIGKILL"), 1_000);
		stopping = exited.finally(() => clearTimeout(timeout));
		return stopping;
	}

	pi.on("session_start", () => {
		warned = false;
		shutdown = false;
	});
	pi.on("agent_start", (_event, ctx) => start(ctx));
	pi.on("agent_settled", () => stop());
	pi.on("session_shutdown", () => {
		shutdown = true;
		return stop();
	});
}

export default function keepAwake(pi: ExtensionAPI): void {
	registerKeepAwake(pi, process.platform, spawn);
}
