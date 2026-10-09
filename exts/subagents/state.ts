import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ResolvedSubagentTask } from "./agents.ts";
import type { SubagentSnapshot, UsageTotals } from "./manager.ts";

export const SUBAGENT_STATE_ENTRY = "subagents-state";
const VERSION = 1;

export interface PersistedSubagentRun {
	snapshot: SubagentSnapshot;
	task: ResolvedSubagentTask;
	parentCwd: string;
	sessionId: string;
	sessionDir: string;
	accountedUsage: UsageTotals;
}

const thinking = Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)));
const count = Type.Number({ minimum: 0 });
const failureKind = Type.Union(["provider", "aborted", "process", "protocol", "policy"].map((kind) => Type.Literal(kind)));
const usage = Type.Object({
	input: count, output: count, cacheRead: count, cacheWrite: count, totalTokens: count,
	cost: Type.Object({ input: count, output: count, cacheRead: count, cacheWrite: count, total: count }),
});
const schema = Type.Object({
	version: Type.Literal(VERSION),
	runs: Type.Array(Type.Object({
		sessionId: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" }),
		sessionDir: Type.String({ minLength: 1 }),
		parentCwd: Type.String({ minLength: 1 }),
		accountedUsage: usage,
		task: Type.Object({
			task: Type.String(), agent: Type.String(), cwd: Type.String({ minLength: 1 }),
			model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(thinking),
			autoApproveMode: Type.Optional(Type.String()), systemPrompt: Type.String(),
			tools: Type.Optional(Type.Array(Type.String())),
		}),
		snapshot: Type.Object({
			id: Type.String({ minLength: 1 }), agent: Type.String(), task: Type.String(),
			taskNumber: Type.Integer({ minimum: 1 }), cwd: Type.String(),
			model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(thinking),
			status: Type.Union(["starting", "running", "waiting", "idle", "completed", "failed", "cancelled"].map((status) => Type.Literal(status))),
			phase: Type.String(), startedAt: count, updatedAt: count, taskEndedAt: Type.Optional(count),
			question: Type.Optional(Type.Object({
				question: Type.String(), context: Type.Optional(Type.String()), options: Type.Optional(Type.Array(Type.String())),
			})),
			output: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
			failureKind: Type.Optional(failureKind),
			previousFailure: Type.Optional(Type.Object({ kind: failureKind, message: Type.String() })),
			sessionFile: Type.Optional(Type.String()), recoverable: Type.Optional(Type.Boolean()),
			activity: Type.Array(Type.Object({ at: count, message: Type.String() })),
			usage, totalUsage: usage,
		}),
	})),
});

export function subagentState(runs: PersistedSubagentRun[]) {
	return { version: VERSION, runs };
}

export function restoreSubagents(entries: readonly SessionEntry[]): PersistedSubagentRun[] {
	const entry = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_STATE_ENTRY);
	if (!entry || entry.type !== "custom") return [];
	if (!Value.Check(schema, entry.data)) throw new Error("Invalid or unsupported saved subagent state");
	return structuredClone((entry.data as { runs: PersistedSubagentRun[] }).runs);
}
