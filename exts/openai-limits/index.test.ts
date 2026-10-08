import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OPENAI_LIMITS_STATUS_KEY } from "../shared/footer-status.ts";
import { duration, fetchUsage, registerOpenAILimits, UsageCheckError } from "./index.ts";
import { createClock } from "./clock.ts";
import type { LimitsConfig } from "./config.ts";
import type { UsageSnapshot } from "./usage.ts";

const START = 1_700_000_000_000;
const RESET = START + 3600_000;
const WAKE = RESET + 15_000;
const drain = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

function usage(remaining: number, at = START): UsageSnapshot {
	return { at, limits: [{ id: "codex", windows: [{ name: "primary", usedPercent: 100 - remaining, resetAt: RESET, minutes: 300 }] }] };
}

function harness(options: { autoPause?: boolean; mode?: string } = {}) {
	let now = START;
	let idle = true;
	let pending = false;
	let leaf = "initial";
	let config: LimitsConfig = { autoPause: options.autoPause ?? true, pauseAtPercent: 10 };
	let response = usage(5);
	let tick: (() => void) | undefined;
	let stopped = 0;
	let requests = 0;
	let fetcher: (signal: AbortSignal) => Promise<UsageSnapshot> = async () => response;
	const messages: Array<{ text: string; options: unknown }> = [];
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, any>();
	const notifications: string[] = [];
	const context = {
		mode: options.mode ?? "tui",
		hasUI: true,
		model: { provider: "openai-codex", id: "main", baseUrl: "https://chatgpt.com/backend-api" },
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		sessionManager: { getLeafId: () => leaf },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			setWidget: (key: string, value: any) => { if (value === undefined) widgets.delete(key); else widgets.set(key, value); },
			notify: (text: string) => notifications.push(text),
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...handlers.get(event) ?? [], handler]);
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		sendMessage: (message: { content: string }, options: unknown) => messages.push({ text: message.content, options }),
	} as unknown as ExtensionAPI;
	registerOpenAILimits(pi, {
		now: () => now,
		loadConfig: () => ({ ...config }),
		saveConfig: (value) => { config = value; },
		clock: () => createClock("en-US", false),
		fetchUsage: async (_ctx, signal) => { requests++; return fetcher(signal); },
		startTimer: (callback) => { tick = callback; return () => { stopped++; tick = undefined; }; },
	});
	async function emit(event: string, data: unknown = {}) {
		for (const handler of handlers.get(event) ?? []) await handler(data, context);
		await drain();
	}
	return {
		context, messages, notifications,
		emit,
		async start() { await emit("session_start"); },
		async run() { idle = false; await emit("agent_start"); },
		async settle(boundary = true, aborted = false) {
			if (boundary) await emit("agent_before_settle", { outcome: "completed" });
			idle = true;
			leaf = "checkpoint";
			await emit("agent_settled", { aborted });
		},
		async advance(at: number) { now = at; tick?.(); await drain(); },
		async command(args: string) { await commands.get("openai-limits")!.handler(args, context); await drain(); },
		setResponse(value: UsageSnapshot) { response = value; },
		setFetcher(value: typeof fetcher) { fetcher = value; },
		setLeaf(value: string) { leaf = value; },
		setPending(value: boolean) { pending = value; },
		get status() { return statuses.get(OPENAI_LIMITS_STATUS_KEY); },
		get line(): string | undefined {
			const widget = widgets.get("openai-limits-pause");
			return typeof widget === "function" ? widget({}, context.ui.theme).render(200)[0] : widget?.join("\n");
		},
		get requests() { return requests; },
		get stopped() { return stopped; },
		get config() { return config; },
	};
}

{
	const h = harness();
	h.setFetcher(async () => { throw new Error("offline"); });
	await h.start();
	assert.equal(h.status, "[OA unknown]");
	let resolve!: (snapshot: UsageSnapshot) => void;
	h.setFetcher(() => new Promise((done) => { resolve = done; }));
	await h.advance(START + 120_000);
	const command = h.command("");
	await drain();
	assert.equal(h.requests, 2);
	assert.equal(h.notifications.length, 0);
	resolve(usage(67, START + 120_000));
	await command;
	assert.equal(h.status, "[OA 67%]");
	assert.match(h.notifications.at(-1)!, /67% remaining/);
	assert.ok(h.notifications.at(-1)!.includes(createClock("en-US", false).dateTime(RESET)));
	h.setFetcher(async () => { throw new UsageCheckError("OpenAI usage endpoint returned HTTP 403."); });
	await h.command("check");
	assert.equal(h.status, "[OA 67%?]");
	assert.match(h.notifications.at(-1)!, /cached usage \(refresh unavailable\)/);
	assert.match(h.notifications.at(-1)!, /Check failed: OpenAI usage endpoint returned HTTP 403/);
	h.setFetcher(async () => { throw new Error("sensitive credential"); });
	await h.command("check");
	assert.match(h.notifications.at(-1)!, /Check failed: Usage check failed/);
	assert.ok(!h.notifications.at(-1)!.includes("sensitive credential"));
	h.setResponse(usage(88));
	h.setFetcher(async () => usage(88));
	await h.command("");
	assert.equal(h.status, "[OA 88%]");
	await h.emit("session_shutdown");
	console.log("PASS: slash command waits for shared refresh, updates the footer, and labels cached values on failure");
}

{
	const h = harness();
	await h.start();
	assert.equal(h.status, "[OA 5%]");
	assert.equal(h.messages.length, 0);
	await h.run();
	assert.equal(h.status, "[OA wrapping]");
	assert.deepEqual(h.messages[0].options, { deliverAs: "steer", triggerTurn: true });
	await h.emit("provider_stream_event", { provider: "openai-codex", model: "main", data: {
		type: "codex.rate_limits", rate_limits: { primary: { used_percent: 99, reset_at: RESET / 1000 } },
	} });
	assert.equal(h.messages.length, 1);
	await h.settle();
	assert.equal(h.status, "[OA paused]");
	assert.match(h.line!, /resumes in 1h 1m/);
	assert.match(h.line!, new RegExp(`at ${createClock("en-US", false).time(WAKE)}$`));
	h.setResponse(usage(80, WAKE));
	await h.advance(WAKE - 1);
	assert.equal(h.messages.length, 1);
	await h.advance(WAKE);
	assert.equal(h.messages.length, 2);
	assert.match(h.messages[1].text, /Resume the interrupted task/);
	assert.equal(h.status, "[OA 80%]");
	assert.equal(h.line, undefined);
	await h.advance(WAKE + 60_000);
	assert.equal(h.messages.length, 2);
	await h.emit("session_shutdown");
	assert.equal(h.stopped, 1);
	console.log("PASS: one cooperative pause, settle, verified reset, and exactly one resume");
}

for (const settled of [false, true]) {
	const h = harness();
	await h.start();
	await h.run();
	if (settled) await h.settle();
	await h.emit("input", { text: "Continue anyway", source: "interactive" });
	assert.equal(h.status, "[OA override]");
	assert.equal(h.line, undefined);
	if (settled) {
		(h.context.model as any).id = "new-model";
		await h.emit("model_select");
		assert.equal(h.status, "[OA override]");
	}
	h.setResponse(usage(90, WAKE));
	await h.advance(WAKE);
	assert.equal(h.messages.length, 1);
	assert.equal(h.status, "[OA 90%]");
	if (settled) await h.run();
	h.setResponse(usage(4, WAKE + 60_000));
	await h.advance(WAKE + 60_000);
	assert.equal(h.messages.length, 2);
	await h.emit("session_shutdown");
}
console.log("PASS: user prompts override both wrapping and paused work, without a later resume prompt");

{
	const h = harness({ autoPause: false });
	await h.start();
	await h.run();
	assert.equal(h.status, "[OA 5% · off]");
	assert.equal(h.messages.length, 0);
	assert.equal(h.line, undefined);
	h.setResponse(usage(90, WAKE));
	await h.advance(WAKE);
	assert.equal(h.status, "[OA 90% · off]");
	assert.equal(h.config.autoPause, false);
	await h.command("on");
	assert.equal(h.config.autoPause, true);
	await h.command("off");
	assert.equal(h.config.autoPause, false);
	await h.emit("session_shutdown");
	console.log("PASS: persistent off mode monitors usage without steering or resuming");
}

{
	const h = harness({ autoPause: false });
	await h.start();
	await h.command("threshold 3%");
	assert.deepEqual(h.config, { autoPause: false, pauseAtPercent: 3 });
	assert.match(h.notifications.at(-1)!, /at 3% remaining/);
	await h.emit("session_start");
	assert.equal(h.config.pauseAtPercent, 3);
	await h.command("on");
	await h.run();
	assert.equal(h.messages.length, 0);
	for (const value of ["", "%", "-1", "100", "NaN", "Infinity", "3 extra"]) {
		await h.command(`threshold ${value}`);
		assert.equal(h.config.pauseAtPercent, 3);
		assert.match(h.notifications.at(-1)!, /Usage:/);
	}
	await h.command("threshold 0");
	assert.equal(h.config.pauseAtPercent, 0);
	await h.command("threshold 6.5");
	assert.equal(h.config.pauseAtPercent, 6.5);
	assert.equal(h.messages.length, 1);
	assert.equal(h.status, "[OA wrapping]");
	await h.settle();
	await h.emit("input", { text: "continue", source: "interactive" });
	await h.command("threshold 4");
	assert.equal(h.status, "[OA override]");
	assert.equal(h.messages.length, 1);
	await h.emit("session_shutdown");
	console.log("PASS: threshold command persists, validates percentages, applies to running work, and preserves manual override");
}

{
	const h = harness();
	await h.start();
	await h.run();
	await h.settle();
	await h.command("");
	await h.emit("input", { text: "background", source: "extension" });
	assert.equal(h.status, "[OA paused]");
	h.setFetcher(async () => { throw new Error("offline"); });
	await h.advance(WAKE);
	assert.match(h.line!, /availability unknown · checking again in 2m/);
	assert.equal(h.messages.length, 1);
	h.setFetcher(async () => usage(5, WAKE));
	await h.advance(WAKE + 120_000);
	assert.equal(h.messages.length, 1);
	assert.match(h.line!, /checks again/);
	h.setFetcher(async () => usage(85, WAKE));
	await h.advance(WAKE + 180_000);
	assert.equal(h.messages.length, 2);
	await h.emit("session_shutdown");
	console.log("PASS: commands and extension input do not override; network failures and stale resets cannot resume work");
}

{
	const h = harness();
	h.setResponse(usage(80));
	await h.start();
	await h.run();
	await h.emit("message_end", { message: { role: "assistant", provider: "openai-codex", model: "main", stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit. Try again in ~60 min." } });
	h.setResponse(usage(0));
	await h.settle();
	assert.equal(h.status, "[OA paused]");
	assert.equal(h.messages.length, 0);
	h.setResponse(usage(90, WAKE));
	await h.advance(WAKE);
	assert.equal(h.messages.length, 1);
	assert.match(h.messages[0].text, /inspect its state before retrying/);
	await h.emit("session_shutdown");
	console.log("PASS: actual quota exhaustion resumes from history without requiring a wrap-up summary");
}

{
	const h = harness();
	h.setResponse(usage(80));
	await h.start();
	await h.run();
	await h.emit("message_end", { message: { role: "assistant", provider: "openai-codex", model: "main", stopReason: "error", errorMessage: "usage_limit_reached" } });
	await h.settle();
	assert.equal(h.messages.length, 0);
	await h.advance(START + 59_000);
	assert.equal(h.messages.length, 0);
	await h.advance(START + 60_000);
	assert.equal(h.messages.length, 1);
	await h.emit("session_shutdown");
	console.log("PASS: a quota error cannot create a tight resume loop when usage reporting lags");
}

{
	const h = harness();
	await h.start();
	await h.run();
	await h.settle();
	let resolve!: (snapshot: UsageSnapshot) => void;
	let signal!: AbortSignal;
	h.setFetcher((value) => { signal = value; return new Promise((done) => { resolve = done; }); });
	await h.advance(WAKE);
	assert.match(h.line!, /checking availability/);
	await h.emit("input", { text: "Use my credits", source: "rpc" });
	assert.equal(signal.aborted, true);
	resolve(usage(90, WAKE));
	await drain();
	assert.equal(h.status, "[OA override]");
	assert.equal(h.messages.length, 1);
	await h.emit("session_shutdown");
	console.log("PASS: a late availability response cannot undo a manual override or send a resume");
}

for (const change of ["leaf", "model", "shutdown", "abort", "settled-abort", "compaction", "pending"]) {
	const h = harness();
	await h.start();
	await h.run();
	if (change === "abort") await h.emit("agent_before_settle", { outcome: "aborted" });
	if (change === "compaction") {
		const controller = new AbortController();
		await h.emit("session_before_compact", { signal: controller.signal });
		controller.abort();
	}
	await h.settle(true, change === "settled-abort");
	if (change === "settled-abort") assert.equal(h.status, "[OA override]");
	if (change === "leaf") h.setLeaf("different-task");
	if (change === "model") {
		(h.context as any).model = { provider: "anthropic", id: "other", baseUrl: "https://api.anthropic.com" };
		await h.emit("model_select");
		assert.equal(h.status, undefined);
	}
	if (change === "shutdown") await h.emit("session_shutdown");
	if (change === "pending") h.setPending(true);
	h.setResponse(usage(90, WAKE));
	await h.advance(WAKE);
	assert.equal(h.messages.length, 1, change);
	await h.emit("session_shutdown");
}
console.log("PASS: navigation, model changes, shutdown, cancellation, and queued work prevent stale resumes");

{
	const h = harness();
	await h.start();
	await h.run();
	await h.emit("input", { text: "/skill:my-task continue", source: "interactive" });
	assert.equal(h.status, "[OA override]");
	await h.settle();
	h.setResponse(usage(90, WAKE));
	await h.advance(WAKE);
	assert.equal(h.messages.length, 1);
	await h.emit("session_shutdown");
	console.log("PASS: manual skill/template prompts override before expansion");
}

{
	const h = harness();
	await h.start();
	await h.run();
	await h.settle(false);
	assert.equal(h.status, "[OA override]");
	h.setResponse(usage(90, WAKE));
	await h.advance(WAKE);
	assert.equal(h.messages.length, 1);
	await h.emit("session_shutdown");
	console.log("PASS: cancellation that skips the settlement boundary cannot arm a resume");
}

{
	const h = harness();
	h.setResponse(usage(80));
	await h.start();
	await h.run();
	(h.context as any).model.id = "new-model";
	h.setResponse(usage(5));
	await h.emit("model_select");
	assert.equal(h.messages.length, 1);
	assert.equal(h.status, "[OA wrapping]");
	await h.emit("session_shutdown");
	console.log("PASS: switching Codex models mid-run preserves proactive pausing");
}

{
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url");
	const token = `e30.${claims}.signature`;
	let calls = 0;
	const context = {
		model: { baseUrl: "https://chatgpt.com/backend-api" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) },
	} as unknown as ExtensionContext;
	const request: typeof fetch = async (url, options) => {
		calls++;
		assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
		assert.equal(options?.redirect, "error");
		assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${token}`);
		assert.equal(new Headers(options?.headers).get("ChatGPT-Account-Id"), "test-account");
		assert.ok(options?.signal);
		return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 30 } } }));
	};
	assert.equal((await fetchUsage(context, new AbortController().signal, request)).limits[0].windows[0].usedPercent, 30);
	(context.model as any).baseUrl = "https://custom.example";
	await assert.rejects(fetchUsage(context, new AbortController().signal, request), /Unsupported OpenAI endpoint/);
	assert.equal(calls, 1);
	const canceled = new AbortController();
	canceled.abort();
	await assert.rejects(fetchUsage(context, canceled.signal, request));
	assert.equal(calls, 1);
	(context.model as any).baseUrl = "https://chatgpt.com/backend-api";
	for (const [request, expected] of [
		[async () => new Response(token, { status: 403 }), "OpenAI usage endpoint returned HTTP 403."],
		[async () => new Response(token), "OpenAI returned an unrecognized usage response."],
		[async () => { throw new Error(token, { cause: { code: "ENOTFOUND" } }); }, "OpenAI usage request failed (ENOTFOUND); check network or proxy settings."],
	] as const) {
		await assert.rejects(fetchUsage(context, new AbortController().signal, request), (error: unknown) => {
			assert.ok(error instanceof UsageCheckError);
			assert.equal(error.message, expected);
			assert.ok(!error.message.includes(token));
			return true;
		});
	}
	console.log("PASS: usage fetch guards credentials and exposes safe HTTP, network, and schema diagnostics");
}

{
	const h = harness({ mode: "print" });
	await h.start();
	await h.run();
	assert.equal(h.messages.length, 0);
	await h.emit("session_shutdown");
	assert.equal(duration(1000), "1s");
	assert.equal(duration(60_000), "1m");
	assert.equal(duration(83 * 60_000), "1h 23m");
	console.log("PASS: one-shot modes do not auto-pause; countdown uses deadline-relative units");
}
