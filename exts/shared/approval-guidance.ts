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
	if (!result) throw new Error("Session guidance is unavailable");
	return result;
}

export function guidanceTitle(token: string): string {
	return `[[pi-subagent-guidance:${token}]]`;
}

export function isGuidanceTitle(title: string, token: string): boolean {
	return title === guidanceTitle(token);
}
