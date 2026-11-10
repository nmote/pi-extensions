import { calculateCost, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

const MODELS = new Set(["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
const ENDPOINTS = new Set(["/backend-api", "/backend-api/codex", "/backend-api/codex/responses"]);

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsCodexFast(model: Model<Api> | undefined, baseUrl = model?.baseUrl): model is Model<Api> {
	if (model?.provider !== "openai-codex" || model.api !== "openai-codex-responses" || !MODELS.has(model.id)) return false;
	try {
		const url = new URL(baseUrl ?? "");
		return url.origin === "https://chatgpt.com" && !url.username && !url.password && !url.search && !url.hash &&
			ENDPOINTS.has(url.pathname.replace(/\/+$/, ""));
	} catch {
		return false;
	}
}

export interface CodexTier {
	responseId?: string;
	tier?: string;
}

export function codexTier(data: unknown): CodexTier | undefined {
	if (!record(data) || !["response.completed", "response.done", "response.incomplete"].includes(String(data.type))) return;
	if (!record(data.response)) return;
	return {
		responseId: typeof data.response.id === "string" ? data.response.id : undefined,
		tier: typeof data.response.service_tier === "string" ? data.response.service_tier : undefined,
	};
}

export type FastConfirmation = "confirmed" | "unconfirmed" | "not-fast";

export function codexConfirmation(tier?: string): FastConfirmation {
	if (tier === "priority" || tier === "fast") return "confirmed";
	if (tier === "flex") return "not-fast";
	// Codex can report "default" even for a requested priority tier.
	return "unconfirmed";
}

export function priceCodexFast(message: AssistantMessage, model: Model<Api>, tier?: string): AssistantMessage {
	if (message.usage.cost.totalFromProvider || codexConfirmation(tier) === "not-fast") return message;
	const usage = { ...message.usage, cost: { ...message.usage.cost } };
	calculateCost(model, usage);
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) usage.cost[key] *= 2;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return { ...message, usage };
}
