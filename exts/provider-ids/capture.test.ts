import { payloadModel, RequestIdCapture } from "./capture.ts";
import { formatReport } from "./report.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const AT = "2026-09-20T10:00:00.000Z";

function message(responseId?: string) {
	return { provider: "anthropic", model: "claude-sonnet-5-20250929", responseId };
}

function main(): void {
	const capture = new RequestIdCapture();
	capture.onRequest({ model: "claude-sonnet-5", stream: true });
	capture.onResponse(200, { "Request-Id": "req_1", "anthropic-organization-id": "org_9" }, AT);
	const [paired] = capture.onAssistantMessage(message("msg_1"));
	check(
		"pairs the request id with the message and organization",
		paired?.requestId === "req_1" &&
			paired.messageId === "msg_1" &&
			paired.organizationId === "org_9" &&
			// The message reports the resolved model; the payload only had the alias.
			paired.model === "claude-sonnet-5-20250929" &&
			paired.provider === "anthropic",
	);
	check("consumes pending responses once", capture.onAssistantMessage(message("msg_2")).length === 0);

	// A mid-stream failure retries on a new HTTP request, so one message can follow
	// several responses; only the last produced it.
	const retried = new RequestIdCapture();
	retried.onRequest({ model: "claude-sonnet-5" });
	retried.onResponse(200, { "request-id": "req_lost" }, AT);
	retried.onRequest({ model: "claude-sonnet-5" });
	retried.onResponse(200, { "request-id": "req_kept" }, AT);
	const records = retried.onAssistantMessage(message("msg_3"));
	check(
		"keeps a record per response and attributes the message to the last",
		records.length === 2 &&
			records[0]?.requestId === "req_lost" &&
			records[0].messageId === undefined &&
			records[1]?.requestId === "req_kept" &&
			records[1].messageId === "msg_3",
	);

	const failed = new RequestIdCapture();
	// A request dropped before its headers arrive must not shift later models.
	failed.onRequest({ model: "claude-sonnet-5" });
	failed.onRequest({ model: "claude-opus-5" });
	failed.onResponse(429, { "request-id": "req_429", "retry-after": "31" }, AT);
	failed.onResponse(200, { "request-id": "req_ok", "retry-after": "31" }, AT);
	const flushed = failed.flush();
	check(
		"flushes unattributed responses and keeps retry-after only when the call failed",
		flushed.length === 2 &&
			flushed[0]?.retryAfter === "31" &&
			flushed[0].model === "claude-opus-5" &&
			flushed[1]?.model === undefined &&
			flushed[1]?.retryAfter === undefined,
	);
	check("flushing clears pending state", failed.flush().length === 0);

	const headerless = new RequestIdCapture();
	headerless.onRequest({ model: "claude-sonnet-5" });
	headerless.onResponse(200, { "content-type": "text/event-stream" }, AT);
	check("skips responses without a request id", headerless.onAssistantMessage(message("msg_4")).length === 0);

	check("reads the model from an opaque payload", payloadModel({ model: "m" }) === "m" && payloadModel("x") === undefined);

	const report = formatReport({
		sessionId: "session-1",
		records: [
			{ requestId: "req_1", messageId: "msg_1", model: "claude-sonnet-5", provider: "anthropic", status: 200, at: AT },
			{ requestId: "req_2", model: "claude-sonnet-5", provider: "anthropic", status: 429, retryAfter: "31", at: AT },
		],
		limit: 1,
	});
	check(
		"report lists identifiers, counts failures, and limits the listing",
		report.includes("- Pi session:    session-1") &&
			report.includes("anthropic/claude-sonnet-5") &&
			report.includes("2 captured, 1 non-200") &&
			report.includes("request ids (newest last, 1 of 2):") &&
			!report.includes("  req_1  ") &&
			report.includes("non-200 responses:") &&
			report.includes("retry-after=31") &&
			report.includes("(no message)"),
	);
	check(
		"report explains an empty capture",
		formatReport({ sessionId: "session-1", records: [] }).startsWith("No provider request ids captured"),
	);
}

main();

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
