import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type ProviderRequestRecord, RequestIdCapture } from "./capture.ts";
import { DEFAULT_LIMIT, formatReport } from "./report.ts";

const RECORD_ENTRY = "provider-request-id";

function isRecord(data: unknown): data is ProviderRequestRecord {
	if (typeof data !== "object" || data === null) return false;
	const candidate = data as Partial<ProviderRequestRecord>;
	return typeof candidate.requestId === "string" && typeof candidate.at === "string";
}

export function persistedRecords(entries: readonly SessionEntry[]): ProviderRequestRecord[] {
	const records: ProviderRequestRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== RECORD_ENTRY) continue;
		if (isRecord(entry.data)) records.push(entry.data);
	}
	return records;
}

function parseLimit(args: string): number | "all" {
	const trimmed = args.trim();
	if (trimmed === "all") return "all";
	const count = Number.parseInt(trimmed, 10);
	return Number.isInteger(count) && count > 0 ? count : DEFAULT_LIMIT;
}

export function registerProviderIds(pi: ExtensionAPI): void {
	const capture = new RequestIdCapture();

	pi.on("before_provider_request", (event) => {
		capture.onRequest(event.payload);
	});

	pi.on("after_provider_response", (event) => {
		capture.onResponse(event.status, event.headers, new Date().toISOString());
	});

	// Fires before the assistant message entry is persisted, so each record lands
	// just ahead of the message it identifies.
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		for (const record of capture.onAssistantMessage(event.message)) pi.appendEntry(RECORD_ENTRY, record);
	});

	pi.on("agent_end", () => {
		for (const record of capture.flush()) pi.appendEntry(RECORD_ENTRY, record);
	});

	pi.registerCommand("provider-ids", {
		description: "Show provider request ids for this session (args: count, or 'all')",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const report = formatReport({
				sessionId: ctx.sessionManager.getSessionId(),
				records: persistedRecords(ctx.sessionManager.getEntries()),
				limit: parseLimit(args),
			});
			ctx.ui.notify(report, "info");
		},
	});
}

export default function providerIds(pi: ExtensionAPI): void {
	registerProviderIds(pi);
}
