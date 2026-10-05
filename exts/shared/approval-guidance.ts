import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const APPROVAL_GUIDANCE_CHANNEL = "auto-approve:guidance";
export const APPROVAL_DIALOG_CHANNEL = "auto-approve:dialog";

export interface ApprovalDialogRequest {
	ctx: ExtensionContext;
	title: string;
	choices: string[];
	respond: (result: Promise<string | undefined>) => void;
}

export async function requestApprovalDialog(
	pi: ExtensionAPI, ctx: ExtensionContext, title: string, choices: string[],
): Promise<string | undefined> {
	let result: Promise<string | undefined> | undefined;
	pi.events.emit(APPROVAL_DIALOG_CHANNEL, {
		ctx, title, choices, respond: (value: Promise<string | undefined>) => { result = value; },
	} satisfies ApprovalDialogRequest);
	if (!result) throw new Error("Session approval dialog is unavailable");
	return result;
}

const GUIDANCE_ERROR_CODES = ["GUIDANCE_UNAVAILABLE", "GUIDANCE_REVISION_CONFLICT", "REQUEST_CANCELLED", "PROTOCOL_MISMATCH"] as const;
export type GuidanceErrorCode = (typeof GUIDANCE_ERROR_CODES)[number];

// Pi loads shared modules separately for each extension.
export function isGuidanceError(error: unknown): error is { code: GuidanceErrorCode; message: string } {
	if (!error || typeof error !== "object") return false;
	const value = error as Record<string, unknown>;
	return typeof value.code === "string" && GUIDANCE_ERROR_CODES.includes(value.code as GuidanceErrorCode) && typeof value.message === "string";
}

export class GuidanceError extends Error {
	constructor(readonly code: GuidanceErrorCode, message: string) {
		super(message);
	}
}

export type GuidanceResponse = { ok: true; guidance: ApprovalGuidance } | { ok: false; code: GuidanceErrorCode; message: string };

export function guidanceFailure(error: unknown): GuidanceResponse {
	return {
		ok: false,
		code: isGuidanceError(error) ? error.code : "GUIDANCE_UNAVAILABLE",
		message: isGuidanceError(error) || error instanceof Error ? error.message : "Session guidance is unavailable",
	};
}

export function decodeGuidanceResponse(response: string | undefined): ApprovalGuidance {
	if (response === undefined) throw new GuidanceError("REQUEST_CANCELLED", "Session guidance request cancelled or timed out");
	let parsed: unknown;
	try { parsed = JSON.parse(response); } catch { /* Reject malformed protocol responses. */ }
	if (parsed && typeof parsed === "object") {
		const value = parsed as Record<string, unknown>;
		if (value.ok === true && isApprovalGuidance(value.guidance)) return value.guidance;
		if (value.ok === false && isGuidanceError(value)) {
			throw new GuidanceError(value.code, value.message);
		}
	}
	throw new GuidanceError("PROTOCOL_MISMATCH", "Invalid session guidance response. Run /reload in the parent session, then restart the subagent.");
}

export interface ApprovalGuidance {
	text: string;
	revision: number;
}

export type GuidanceRequest = { action: "get" } | { action: "set"; text: string; expectedRevision: number };

export function isApprovalGuidance(value: unknown): value is ApprovalGuidance {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<ApprovalGuidance>;
	return typeof state.text === "string" && Number.isSafeInteger(state.revision) && state.revision! >= 0;
}

export function parseGuidanceRequest(text: string | undefined): GuidanceRequest | undefined {
	try {
		const value = JSON.parse(text ?? "") as Partial<GuidanceRequest>;
		if (value?.action === "get") return { action: "get" };
		if (value?.action === "set" && typeof value.text === "string" &&
			Number.isSafeInteger(value.expectedRevision) && value.expectedRevision! >= 0) {
			return { action: "set", text: value.text, expectedRevision: value.expectedRevision! };
		}
	} catch {
		// Invalid requests cannot modify policy.
	}
	return undefined;
}

/** Extension-only exchange; never exposed as a model-callable tool. */
export async function requestGuidance(
	pi: ExtensionAPI, ctx: ExtensionContext, request: GuidanceRequest,
): Promise<ApprovalGuidance> {
	let result: Promise<ApprovalGuidance> | undefined;
	pi.events.emit(APPROVAL_GUIDANCE_CHANNEL, {
		request, ctx, respond: (value: Promise<ApprovalGuidance>) => { result = value; },
	});
	if (!result) throw new GuidanceError("GUIDANCE_UNAVAILABLE", "Session guidance is unavailable; ensure auto-approve is loaded in the parent session");
	return result;
}

export function guidanceTitle(token: string): string {
	return `[[pi-subagent-guidance:${token}]]`;
}

export function isGuidanceTitle(title: string, token: string): boolean {
	return title === guidanceTitle(token);
}
