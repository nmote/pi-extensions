/** Formats captured request ids as a block to paste into a provider report. */

import type { ProviderRequestRecord } from "./capture.ts";

/** Request ids listed by default; older ones stay in the session entries. */
export const DEFAULT_LIMIT = 10;

export interface ReportInput {
	sessionId: string;
	records: readonly ProviderRequestRecord[];
	/** Number of ids to list, or `all`. */
	limit?: number | "all";
}

function second(at: string): string {
	return at.replace(/\.\d+(?=Z$)/, "");
}

function modelLabel(record: ProviderRequestRecord): string {
	const model = record.model ?? "unknown";
	return record.provider ? `${record.provider}/${model}` : model;
}

function countedLabels(records: readonly ProviderRequestRecord[]): string {
	const counts = new Map<string, number>();
	for (const record of records) {
		const label = modelLabel(record);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	const labels = [...counts].sort((a, b) => b[1] - a[1]);
	if (labels.length === 1) return labels[0]![0];
	return labels.map(([label, count]) => `${label} (${count})`).join(", ");
}

function line(record: ProviderRequestRecord): string {
	const fields = [second(record.at), String(record.status), record.requestId, record.messageId ?? "(no message)"];
	if (record.retryAfter) fields.push(`retry-after=${record.retryAfter}`);
	return `  ${fields.join("  ")}`;
}

export function formatReport({ sessionId, records, limit = DEFAULT_LIMIT }: ReportInput): string {
	if (records.length === 0) {
		return [
			"No provider request ids captured in this session.",
			"Capture needs a provider that exposes response headers, and only covers requests whose HTTP response arrived.",
		].join("\n");
	}

	const organizations = [...new Set(records.map((record) => record.organizationId).filter((id) => id !== undefined))];
	const failures = records.filter((record) => record.status !== 200);
	const listed = limit === "all" ? records : records.slice(-limit);

	const lines = [
		"Provider request identifiers",
		`- Pi session:    ${sessionId}`,
		`- Model:         ${countedLabels(records)}`,
	];
	if (organizations.length > 0) lines.push(`- Organization:  ${organizations.join(", ")}`);
	lines.push(
		`- Window (UTC):  ${second(records[0]!.at)} -> ${second(records[records.length - 1]!.at)}`,
		`- Requests:      ${records.length} captured${failures.length > 0 ? `, ${failures.length} non-200` : ""}`,
		"",
		`request ids (newest last, ${listed.length} of ${records.length}):`,
		...listed.map(line),
	);
	if (failures.length > 0) {
		lines.push("", "non-200 responses:", ...failures.map(line));
	}
	return lines.join("\n");
}
