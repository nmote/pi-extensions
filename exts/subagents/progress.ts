import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { SubagentSnapshot } from "./manager.ts";
import { progressText } from "./status.ts";

const DEFAULT_HEARTBEAT_MS = 1_000;

export type SubagentOperation = "spawn" | "reply" | "status" | "cancel";

export interface SubagentDetails {
	operation: SubagentOperation;
	results: SubagentSnapshot[];
}

export function createProgressReporter(
	enableHeartbeat: boolean,
	operation: SubagentOperation,
	onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
	heartbeatMs = DEFAULT_HEARTBEAT_MS,
) {
	let latest: SubagentSnapshot[] = [];
	let stopped = false;

	const publish = (results: SubagentSnapshot[]) => {
		if (stopped) return;
		latest = results;
		onUpdate?.({
			content: [{ type: "text", text: `Subagents: ${progressText(results)}` }],
			details: { operation, results },
		});
	};

	const heartbeat = enableHeartbeat && onUpdate
		? setInterval(() => {
				if (latest.length) publish(latest);
			}, heartbeatMs)
		: undefined;
	heartbeat?.unref();

	return {
		publish,
		stop: () => {
			if (stopped) return;
			stopped = true;
			if (heartbeat) clearInterval(heartbeat);
		},
	};
}
