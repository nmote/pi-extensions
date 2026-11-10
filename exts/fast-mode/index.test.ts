import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import { calculateCost, normalizeContext, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FAST_MODE_STATUS_KEY } from "../shared/footer-status.ts";
import { FAST_MODE_STATE_CHANNEL, SUBAGENT_FAST_COMMAND, fastModeAck } from "../shared/subagent-protocol.ts";
import { priceCodexFast, supportsCodexFast } from "./codex.ts";
import { registerFastMode } from "./index.ts";

const model: Model<Api> = {
	type: "chat", provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6.1-sol", name: "Sol",
	baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"], contextWindow: 500000, maxTokens: 128000,
	cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
		tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] },
};

function assistant(responseId = "resp-1"): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, responseId,
		content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.now(),
		usage: { input: 250000, cacheRead: 50000, cacheWrite: 0, output: 100, totalTokens: 300100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function harness(childToken?: string) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const commands = new Map<string, any>();
	const events = createEventBus();
	let session = SessionManager.inMemory();
	const notices: Array<{ message: string; type: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	let endpoint: string | undefined;
	let idle = false;
	let authReads = 0;
	const ctx = {
		mode: childToken ? "rpc" : "tui", hasUI: true, model: { ...model },
		get sessionManager() { return session; },
		isIdle: () => idle,
		modelRegistry: { getApiKeyAndHeaders: async () => { authReads++; return { ok: true, baseUrl: endpoint }; } },
		ui: {
			notify: (message: string, type: string) => notices.push({ message, type }),
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			setWidget: (key: string, value: string[] | undefined) => widgets.set(key, value),
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		},
	} as unknown as ExtensionContext;
	registerFastMode({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry: (name: string, data: unknown) => session.appendCustomEntry(name, data), events,
	} as unknown as ExtensionAPI, { childToken });
	return {
		ctx, events, notices, statuses, widgets,
		get session() { return session; },
		get authReads() { return authReads; },
		set endpoint(value: string | undefined) { endpoint = value; },
		set idle(value: boolean) { idle = value; },
		set session(value: SessionManager) { session = value; },
		emit: async (name: string, event: any = {}) => handlers.get(name)?.(event, ctx),
		command: async (args: string, name = "fast") => commands.get(name).handler(args, ctx),
		enabled: () => {
			let enabled: boolean | undefined;
			events.emit(FAST_MODE_STATE_CHANNEL, { respond: (state: { enabled: boolean }) => { enabled = state.enabled; } });
			return enabled;
		},
	};
}

// Commands and restoration follow the active branch rather than abandoned toggles.
const parent = harness();
await parent.emit("session_start");
assert.equal(parent.enabled(), false);
assert.equal(await parent.emit("before_provider_request", { payload: { model: model.id } }), undefined);
assert.equal(parent.authReads, 0);
await parent.command("on");
const onEntry = parent.session.getLeafId()!;
assert.equal(parent.enabled(), true);
assert.deepEqual(await parent.emit("cache_warming_decision"), { action: "stop" });
await parent.command("status");
assert.match(parent.notices.at(-1)!.message, /2×.*purchased credits/);
await parent.command("invalid");
assert.equal(parent.enabled(), true);
await parent.command("off");
assert.equal(await parent.emit("cache_warming_decision"), undefined);
parent.session.branch(onEntry);
await parent.emit("session_tree");
assert.equal(parent.enabled(), true);
const reloaded = harness();
reloaded.session = parent.session;
await reloaded.emit("session_start");
assert.equal(reloaded.enabled(), true);
reloaded.session = SessionManager.inMemory();
await reloaded.emit("session_start");
assert.equal(reloaded.enabled(), false);

// Unsupported selections warn once, remain unchanged, and retain the preference.
parent.ctx.model = { ...model, provider: "anthropic", api: "anthropic-messages" };
await parent.emit("model_select");
const warnings = () => parent.notices.filter((notice) => notice.type === "warning");
assert.match(warnings().at(-1)!.message, /FAST MODE NOT APPLIED.*anthropic/);
assert.match([...parent.widgets.values()].flat().join(""), /FAST MODE NOT APPLIED/);
const warningCount = warnings().length;
await parent.command("status");
await parent.emit("before_provider_request", { payload: { model: model.id } });
assert.equal(warnings().length, warningCount);
assert.equal(parent.enabled(), true);
parent.ctx.model = { ...model };
await parent.emit("model_select");
assert.equal([...parent.widgets.values()].filter(Boolean).length, 0);
await parent.emit("turn_start");
parent.endpoint = "https://gateway.example/v1";
assert.equal(await parent.emit("before_provider_request", { payload: { model: model.id } }), undefined);
assert.match(warnings().at(-1)!.message, /endpoint/);
parent.endpoint = undefined;
for (const unsupported of [
	{ ...model, provider: "openai" }, { ...model, id: "gpt-unknown" }, { ...model, api: "virtual" },
	{ ...model, baseUrl: "https://chatgpt.com.evil.example/backend-api" },
]) assert.equal(supportsCodexFast(unsupported), false);
assert.equal(supportsCodexFast({ ...model, id: "gpt-6.1-terra" }), true);
assert.equal(await parent.emit("before_provider_request", { payload: { model: "routed-elsewhere" } }), undefined);
parent.idle = true;
assert.equal(await parent.emit("before_provider_request", { payload: { model: model.id } }), undefined);
parent.idle = false;

// Pricing is request-attributed, includes long-context/cache rates, and is never compounded.
const payload = { model: model.id, input: ["keep"], reasoning: { effort: "high" } };
const patched = await parent.emit("before_provider_request", { payload });
assert.deepEqual(patched, { ...payload, service_tier: "priority" });
assert.equal("service_tier" in payload, false);
await parent.emit("provider_stream_event", {
	provider: model.provider, api: model.api, model: model.id,
	data: { type: "response.done", response: { id: "resp-1", service_tier: "fast" } },
});
await parent.command("off");
parent.ctx.model = { ...model, id: "gpt-6.1-terra" };
await parent.emit("model_select");
const original = assistant();
calculateCost(model, original.usage);
for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) original.usage.cost[key] *= 2;
const corrected = (await parent.emit("message_end", { message: original })).message as AssistantMessage;
assert.equal(corrected.usage.cost.total, 2.023);
assert.equal(corrected.usage.totalTokens, original.usage.totalTokens);
assert.equal(original.usage.cost.total, 2.023);
parent.session.appendMessage(corrected);
const persisted = parent.session.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant");
assert.equal((persisted[0] as any).message.usage.cost.total, 2.023);
assert.equal(await parent.emit("message_end", { message: original }), undefined);
const authoritative = assistant();
authoritative.usage.cost = { ...authoritative.usage.cost, total: 123, totalFromProvider: true };
assert.equal(priceCodexFast(authoritative, model), authoritative);

// Only authenticated managed children accept inheritance, including explicit off over saved on.
const child = harness("child-secret");
child.session.appendCustomEntry("fast-mode", { enabled: true });
child.ctx.model = { ...model, provider: "anthropic", api: "anthropic-messages" };
await child.emit("session_start");
assert.equal(child.notices.length, 0);
await assert.rejects(child.command("wrong on", SUBAGENT_FAST_COMMAND), /Invalid/);
await assert.rejects(child.command("child-secret on extra", SUBAGENT_FAST_COMMAND), /Invalid/);
await child.command("child-secret off", SUBAGENT_FAST_COMMAND);
assert.equal(child.enabled(), false);
assert.equal(child.notices.at(-1)!.message, fastModeAck("child-secret", false));
await child.emit("session_tree");
assert.equal(child.enabled(), false);
await child.command("child-secret on", SUBAGENT_FAST_COMMAND);
assert.equal(child.enabled(), true);
assert.equal(child.notices.filter((notice) => notice.type === "warning").length, 0);
assert.equal(await child.emit("before_provider_request", { payload: { model: model.id } }), undefined);
assert.equal(child.session.getEntries().filter((entry) => entry.type === "custom").length, 1);
child.ctx.model = { ...model };
await child.emit("model_select");
await child.emit("turn_start");
assert.equal((await child.emit("before_provider_request", { payload: { model: model.id } })).service_tier, "priority");
await child.emit("session_shutdown");
assert.equal(child.enabled(), undefined);
assert.equal(child.statuses.get(FAST_MODE_STATUS_KEY), undefined);
// A same-ID provider switch during preflight must not apply Codex fields to another transport.
const raced = harness();
raced.ctx.model = { ...model, provider: "openai", api: "openai-responses" };
await raced.emit("session_start");
await raced.command("on");
await raced.emit("turn_start");
raced.ctx.model = { ...model };
await raced.emit("model_select");
assert.equal(await raced.emit("before_provider_request", { payload: { model: model.id } }), undefined);
assert.equal(raced.authReads, 0);
await raced.emit("turn_start");
assert.equal((await raced.emit("before_provider_request", { payload: { model: model.id } })).service_tier, "priority");
await raced.emit("provider_stream_event", { provider: model.provider, api: model.api, model: model.id,
	data: { type: "response.done", response: { id: "resp-1", service_tier: "priority" } } });
await raced.emit("message_end", { message: assistant() });
assert.equal(raced.statuses.get(FAST_MODE_STATUS_KEY), "[fast: confirmed · 2× est.]");
await raced.command("off");
await raced.emit("turn_start");
assert.equal(await raced.emit("before_provider_request", { payload: { model: model.id } }), undefined);
await raced.command("on");
await raced.emit("message_end", { message: assistant("ordinary") });
assert.equal(raced.statuses.get(FAST_MODE_STATUS_KEY), "[fast: requested · 2× est.]");
await raced.emit("turn_start");
raced.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
	raced.ctx.model = { ...model, provider: "openai", api: "openai-responses" };
	await raced.emit("model_select");
	return { ok: true };
};
assert.equal(await raced.emit("before_provider_request", { payload: { model: model.id } }), undefined);
console.log("Fast commands, warnings, persistence, attribution, and managed-child inheritance passed");

// Exercise Pi's native serializers/pricing with fake credentials and network-free transports.
const api = openAICodexResponsesApi();
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64url")}.fake`;
const context = normalizeContext({ systemPrompt: "test", messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });
const transportSession = SessionManager.inMemory();
let total = 0;
let socketPayload: Record<string, unknown> | undefined;
function completion(tier?: string) {
	return { type: "response.done", response: { id: "resp-native", status: "completed", output: [], service_tier: tier,
		usage: { input_tokens: 300000, input_tokens_details: { cached_tokens: 50000 }, output_tokens: 100, total_tokens: 300100 } } };
}
class FakeWebSocket extends EventTarget {
	readyState = 1;
	constructor(_url: string, _options: unknown) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
	send(data: string): void {
		socketPayload = JSON.parse(data);
		queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(completion("fast")) })));
	}
	close(): void { this.readyState = 3; }
}
const originalWebSocket = globalThis.WebSocket;
try {
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	for (const [transport, tier, multiplier, confirmation] of [
		["sse", "priority", 2, "confirmed"], ["sse", "fast", 2, "confirmed"],
		["sse", "default", 2, "unconfirmed"], ["sse", undefined, 2, "unconfirmed"],
		["sse", "flex", 0.5, "not-fast"], ["websocket", "fast", 2, "confirmed"],
	] as const) {
		const runtime = harness();
		await runtime.emit("session_start");
		await runtime.command("on");
		await runtime.emit("turn_start");
		let sentPayload: any;
		const message = await api.streamSimple(model, context, {
			apiKey: token, transport, maxRetries: 0,
			onPayload: (payload) => runtime.emit("before_provider_request", { payload }),
			onProviderStreamEvent: (data, requestModel) => runtime.emit("provider_stream_event", {
				provider: requestModel.provider, api: requestModel.api, model: requestModel.id, data,
			}),
			fetch: async (_url, init) => {
				assert.equal(transport, "sse", "WebSocket must not fall back to HTTP");
				const headers = new Headers(init?.headers);
				const bytes = Buffer.from(init?.body as Uint8Array);
				sentPayload = JSON.parse(headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes).toString() : bytes.toString());
				return new Response(`data: ${JSON.stringify(completion(tier))}\n\n`, { headers: { "content-type": "text/event-stream" } });
			},
		}).result();
		assert.equal(message.stopReason, "stop", message.errorMessage);
		assert.equal((transport === "websocket" ? socketPayload : sentPayload)?.service_tier, "priority");
		const replacement = await runtime.emit("message_end", { message });
		const priced = replacement.message as AssistantMessage;
		assert.equal(priced.usage.cost.total, 1.0115 * multiplier);
		assert.equal(runtime.statuses.get(FAST_MODE_STATUS_KEY), `[fast: ${confirmation}${confirmation === "not-fast" ? "" : " · 2× est."}]`);
		transportSession.appendMessage(priced);
		total += 1.0115 * multiplier;
	}
} finally {
	globalThis.WebSocket = originalWebSocket;
}
const persistedTotal = transportSession.getEntries().reduce((sum, entry) =>
	sum + (entry.type === "message" && entry.message.role === "assistant" ? entry.message.usage.cost.total : 0), 0);
assert.equal(persistedTotal, total);
console.log("Native Codex SSE/WebSocket payloads, tier pricing, and persisted totals passed");
