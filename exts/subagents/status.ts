import type { SubagentSnapshot, SubagentStatus } from "./manager.ts";

const STATUS_ORDER: SubagentStatus[] = ["starting", "running", "waiting", "completed", "failed", "cancelled"];
const TERMINAL_STATUSES = new Set<SubagentStatus>(["completed", "failed", "cancelled"]);

export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export function progressText(results: SubagentSnapshot[]): string {
	const counts = new Map<SubagentStatus, number>();
	for (const result of results) counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
	return STATUS_ORDER.filter((status) => counts.has(status))
		.map((status) => `${counts.get(status)} ${status}`)
		.join(" · ");
}

export function statusIcon(status: SubagentStatus): string {
	return {
		starting: "◐",
		running: "◐",
		waiting: "?",
		completed: "✓",
		failed: "✗",
		cancelled: "×",
	}[status];
}

export function formatElapsedTime(result: SubagentSnapshot, now = Date.now()): string {
	const end = TERMINAL_STATUSES.has(result.status) ? result.updatedAt : now;
	return formatDuration(end - result.startedAt);
}

export function formatCost(result: SubagentSnapshot): string {
	return `$${result.usage.cost.total.toFixed(3)}`;
}

function formatModel(result: SubagentSnapshot): string {
	return `${result.model ?? "default"}${result.thinkingLevel ? ` (${result.thinkingLevel})` : ""}`;
}

export function formatResultHeading(result: SubagentSnapshot): string {
	const status = result.status === "waiting" ? "waiting for supervisor" : result.status;
	return `### ${result.agent} (${result.id}) — ${status} · ${formatCost(result)}`;
}

export function formatExpandedMetadata(result: SubagentSnapshot): string {
	return [
		`- Phase: ${result.phase}`,
		`- Elapsed: ${formatElapsedTime(result)}`,
		`- Cost: ${formatCost(result)}`,
		`- Model: ${formatModel(result)}`,
		`- Working directory: ${result.cwd}`,
	].join("\n");
}

export function formatRunStatus(result: SubagentSnapshot, now = Date.now()): string {
	return `${statusIcon(result.status)} ${result.agent} ${result.id} · ${formatModel(result)} · ${formatElapsedTime(result, now)} · ${formatCost(result)} · ${result.phase}`;
}

export function formatActivity(result: SubagentSnapshot): string {
	return result.activity
		.map((entry) => `+${formatDuration(entry.at - result.startedAt)}  ${entry.message.replace(/\s+/g, " ").trim()}`)
		.join("\n");
}
