import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { OPENAI_LIMITS_STATUS_KEY } from "../shared/footer-status.ts";
import { createClock, systemClock, type Clock } from "./clock.ts";
import { loadConfig, saveConfig, type LimitsConfig } from "./config.ts";
import { allowance, isQuotaError, mergeUsage, parseHeaders, parseStream, parseUsage, type UsageSnapshot } from "./usage.ts";

const WIDGET = "openai-limits-pause";
const POLL_MS = 60_000;
const RETRY_MS = 120_000;
const RESET_MARGIN_MS = 15_000;
const WRAP_UP = "OpenAI subscription usage is nearly exhausted. Finish only what is necessary to leave the current operation safe, then stop. Briefly summarize completed work, unfinished work, and the next action. Do not start new work. This is an automatic usage pause, not permission to commit or perform other unauthorized actions.";
const RESUME = "OpenAI subscription usage is available again. Resume the interrupted task from the session history and any wrap-up summary. Do not repeat completed actions. If an operation was interrupted, inspect its state before retrying it.";

type Phase = "ready" | "wrapping" | "paused" | "override";

export interface LimitsDependencies {
	now(): number;
	fetchUsage(ctx: ExtensionContext, signal: AbortSignal): Promise<UsageSnapshot>;
	loadConfig(): LimitsConfig;
	saveConfig(config: LimitsConfig): void;
	clock(): Clock;
	startTimer(tick: () => void): () => void;
}

export class UsageCheckError extends Error {}

export async function fetchUsage(ctx: ExtensionContext, signal: AbortSignal, fetchRequest: typeof fetch = fetch): Promise<UsageSnapshot> {
	const model = ctx.model;
	if (!model) throw new UsageCheckError("No model selected");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model).catch(() => {
		throw new UsageCheckError("OpenAI authentication refresh failed; try /login openai-codex.");
	});
	signal.throwIfAborted();
	if (!auth.ok || !auth.apiKey) throw new UsageCheckError("OpenAI authentication unavailable; try /login openai-codex.");
	if (new URL(auth.baseUrl ?? model.baseUrl).origin !== "https://chatgpt.com") throw new UsageCheckError("Unsupported OpenAI endpoint");
	let accountId: unknown;
	try {
		const claims = JSON.parse(Buffer.from(auth.apiKey.split(".")[1], "base64url").toString("utf8"));
		accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch { /* Invalid tokens are rejected without exposing credentials. */ }
	if (typeof accountId !== "string" || !accountId) throw new UsageCheckError("OpenAI account ID unavailable; try /login openai-codex.");
	const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
	let response: Response;
	try {
		response = await fetchRequest("https://chatgpt.com/backend-api/wham/usage", {
			headers: { Authorization: `Bearer ${auth.apiKey}`, "ChatGPT-Account-Id": accountId, "User-Agent": "pi-openai-limits" },
			signal: requestSignal,
			redirect: "error",
		});
	} catch (error) {
		if (requestSignal.aborted) throw new UsageCheckError("OpenAI usage request timed out or was canceled.");
		const code = (error as { cause?: { code?: unknown } })?.cause?.code;
		const knownCode = typeof code === "string" && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code) ? ` (${code})` : "";
		throw new UsageCheckError(`OpenAI usage request failed${knownCode}; check network or proxy settings.`);
	}
	if (!response.ok) throw new UsageCheckError(`OpenAI usage endpoint returned HTTP ${response.status}.`);
	try {
		return parseUsage(await response.json(), Date.now());
	} catch {
		if (requestSignal.aborted) throw new UsageCheckError("OpenAI usage response timed out or was canceled.");
		throw new UsageCheckError("OpenAI returned an unrecognized usage response.");
	}
}

const defaults: LimitsDependencies = {
	now: Date.now,
	fetchUsage,
	loadConfig,
	saveConfig,
	clock: systemClock,
	startTimer(tick) {
		const timer = setInterval(tick, 1000);
		timer.unref();
		return () => clearInterval(timer);
	},
};

export function duration(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.ceil(seconds / 60);
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function registerOpenAILimits(pi: ExtensionAPI, dependencies: Partial<LimitsDependencies> = {}): void {
	const deps = { ...defaults, ...dependencies };
	let config = deps.loadConfig();
	let ctx: ExtensionContext | undefined;
	let snapshot: UsageSnapshot | undefined;
	let clock = createClock();
	let clockReady = false;
	let refreshPromise: Promise<void> | undefined;
	let phase: Phase = "ready";
	let running = false;
	let settledNormally = false;
	let nextCheck = 0;
	let resumeAt: number | undefined;
	let notBefore = 0;
	let pauseLeaf: string | null | undefined;
	let checking = false;
	let unavailable = false;
	let failure: string | undefined;
	let epoch = 0;
	let request: AbortController | undefined;
	let stopTimer: (() => void) | undefined;
	let lastStatus: string | undefined;
	let lastLine: string | undefined;

	function selected(context: ExtensionContext): boolean {
		if (context.model?.provider !== "openai-codex") return false;
		try { return new URL(context.model.baseUrl).origin === "https://chatgpt.com"; } catch { return false; }
	}

	function canPause(): boolean {
		return config.autoPause && (ctx?.mode === "tui" || ctx?.mode === "rpc");
	}

	function budget() {
		return allowance(snapshot, ctx?.model?.id ?? "", config.pauseAtPercent);
	}

	function render(): void {
		if (!ctx) return;
		const { remaining } = budget();
		const low = remaining !== undefined && remaining <= config.pauseAtPercent;
		const label = phase === "wrapping" ? "wrapping" : phase === "paused" ? "paused" : phase === "override" ? "override"
			: remaining === undefined ? "unknown" : `${Math.floor(remaining)}%${unavailable ? "?" : ""}`;
		const status = `[OA ${label}${config.autoPause ? "" : " · off"}]`;
		if (status !== lastStatus) {
			ctx.ui.setStatus(OPENAI_LIMITS_STATUS_KEY, ctx.ui.theme.fg(phase !== "ready" || low && !unavailable ? "warning" : "dim", status));
			lastStatus = status;
		}
		let line: string | undefined;
		if (phase === "wrapping") line = "OpenAI allowance low · wrapping up before pause";
		if (phase === "paused") {
			if (checking) line = "OpenAI paused · checking availability";
			else if (unavailable) line = `OpenAI paused · availability unknown · checking again in ${duration(nextCheck - deps.now())}`;
			else if (resumeAt !== undefined && Math.max(resumeAt, notBefore) > deps.now()) {
				const wakeAt = Math.max(resumeAt, notBefore);
				const time = clock.time(wakeAt);
				line = `OpenAI paused · resumes in ${duration(wakeAt - deps.now())} · at ${time}`;
			} else line = `OpenAI paused · checks again in ${duration(nextCheck - deps.now())}`;
		}
		if (line !== lastLine) {
			if (ctx.mode === "tui") {
				const text = line;
				ctx.ui.setWidget(WIDGET, text === undefined ? undefined : (_tui, theme) => ({
					invalidate() {},
					render: (width) => [truncateToWidth(theme.fg("warning", text), width, "…")],
				}), { placement: "belowEditor" });
			} else if (ctx.hasUI) ctx.ui.setWidget(WIDGET, line === undefined ? undefined : [line]);
			lastLine = line;
		}
	}

	function invalidateRequest(): void {
		epoch++;
		request?.abort();
		request = undefined;
		refreshPromise = undefined;
		checking = false;
	}

	function clearPause(): void {
		phase = "ready";
		resumeAt = undefined;
		notBefore = 0;
		pauseLeaf = undefined;
	}

	function override(): void {
		invalidateRequest();
		phase = "override";
		pauseLeaf = undefined;
		nextCheck = notBefore > deps.now() ? notBefore : deps.now() + POLL_MS;
		render();
	}

	function maybeWrap(): void {
		if (!ctx || !running || !canPause() || phase !== "ready" || unavailable) return;
		const { remaining, resetAt } = budget();
		if (remaining === undefined || remaining > config.pauseAtPercent) return;
		phase = "wrapping";
		resumeAt = resetAt === undefined ? undefined : resetAt + RESET_MARGIN_MS;
		notBefore = resumeAt !== undefined && resumeAt > deps.now() ? resumeAt : deps.now() + POLL_MS;
		pi.sendMessage({ customType: "openai-limits-pause", content: WRAP_UP, display: true }, { deliverAs: "steer", triggerTurn: true });
		render();
	}

	function apply(update: UsageSnapshot, authoritative: boolean): void {
		if (!ctx) return;
		snapshot = authoritative ? update : mergeUsage(snapshot, update);
		unavailable = false;
		failure = undefined;
		const { remaining, resetAt } = budget();
		if (phase === "paused" || phase === "override") {
			if (resetAt !== undefined) {
				resumeAt = resetAt + RESET_MARGIN_MS;
				notBefore = Math.max(notBefore, resumeAt);
			}
			if (authoritative && deps.now() >= notBefore && remaining !== undefined && remaining > config.pauseAtPercent) {
				if (phase === "override") clearPause();
				else if (!running && ctx.isIdle() && !ctx.hasPendingMessages()) {
					if (ctx.sessionManager.getLeafId() !== pauseLeaf) clearPause();
					else {
						clearPause();
						pi.sendMessage({ customType: "openai-limits-resume", content: RESUME, display: true }, { triggerTurn: true });
					}
				}
			}
		}
		maybeWrap();
		render();
	}

	function refresh(): Promise<void> {
		if (!ctx) return Promise.resolve();
		if (refreshPromise) return refreshPromise;
		const context = ctx;
		const version = epoch;
		const controller = new AbortController();
		request = controller;
		checking = true;
		render();
		refreshPromise = Promise.resolve().then(async () => {
			try {
				if (version !== epoch) return;
				const update = await deps.fetchUsage(context, controller.signal);
				if (version !== epoch) return;
				nextCheck = deps.now() + POLL_MS;
				apply(update, true);
			} catch (error) {
				if (version !== epoch) return;
				unavailable = true;
				failure = error instanceof UsageCheckError ? error.message : "Usage check failed.";
				nextCheck = deps.now() + RETRY_MS;
			} finally {
				if (version === epoch) {
					request = undefined;
					refreshPromise = undefined;
					checking = false;
					if ((phase === "paused" || phase === "override") && notBefore > deps.now() && !unavailable) nextCheck = notBefore;
					render();
				}
			}
		});
		return refreshPromise;
	}

	function reset(context?: ExtensionContext, preserveRun = false): void {
		const keepOverride = preserveRun && phase === "override";
		const overrideDeadline = notBefore;
		const overrideReset = resumeAt;
		invalidateRequest();
		stopTimer?.();
		stopTimer = undefined;
		ctx?.ui.setStatus(OPENAI_LIMITS_STATUS_KEY, undefined);
		ctx?.ui.setWidget(WIDGET, undefined);
		ctx = context && selected(context) ? context : undefined;
		snapshot = undefined;
		if (!preserveRun) running = false;
		settledNormally = false;
		unavailable = false;
		failure = undefined;
		lastStatus = lastLine = undefined;
		clearPause();
		if (keepOverride) {
			phase = "override";
			notBefore = overrideDeadline;
			resumeAt = overrideReset;
		}
		if (!ctx) return;
		if (!clockReady) {
			clock = deps.clock();
			clockReady = true;
		}
		nextCheck = deps.now();
		render();
		stopTimer = deps.startTimer(() => {
			if (!ctx) return;
			if (deps.now() >= nextCheck) void refresh();
			render();
		});
		void refresh();
	}

	pi.on("session_start", (_event, context) => { config = deps.loadConfig(); reset(context); });
	pi.on("model_select", (_event, context) => reset(context, true));
	pi.on("session_tree", (_event, context) => reset(context));
	pi.on("session_shutdown", () => reset());

	pi.on("input", (event) => {
		// Registered commands bypass input; skills and templates reach it before expansion.
		if (ctx && event.source !== "extension" && (phase === "wrapping" || phase === "paused")) override();
	});
	pi.on("agent_start", (_event, context) => {
		running = true;
		settledNormally = false;
		if (!ctx) return;
		ctx = context;
		maybeWrap();
	});
	pi.on("after_provider_response", (event) => {
		if (!ctx) return;
		const update = parseHeaders(event.headers, deps.now());
		if (update) apply(update, false);
	});
	pi.on("provider_stream_event", (event) => {
		if (!ctx || event.provider !== "openai-codex") return;
		const update = parseStream(event.data, event.model, deps.now());
		if (update) apply(update, false);
	});
	pi.on("message_end", (event) => {
		if (!ctx || event.message.role !== "assistant" || event.message.provider !== "openai-codex" || event.message.model !== ctx.model?.id) return;
		if (event.message.stopReason === "aborted" && (phase === "wrapping" || phase === "paused")) override();
		else if (event.message.stopReason === "error" && isQuotaError(event.message.errorMessage ?? "") && canPause() && phase === "ready") {
			invalidateRequest();
			phase = "wrapping";
			resumeAt = undefined;
			notBefore = deps.now() + POLL_MS;
			unavailable = true;
			nextCheck = deps.now();
			render();
		}
	});
	pi.on("agent_before_settle", (event) => {
		settledNormally = event.outcome !== "aborted";
		if (!settledNormally && (phase === "wrapping" || phase === "paused")) override();
	});
	pi.on("session_before_compact", (event) => {
		if (!ctx || phase !== "wrapping") return;
		const version = epoch;
		event.signal.addEventListener("abort", () => {
			if (version === epoch && phase === "wrapping") override();
		}, { once: true });
	});
	pi.on("agent_settled", (_event, context) => {
		running = false;
		if (!ctx) return;
		ctx = context;
		if (phase === "wrapping" && !settledNormally) override();
		if (phase === "wrapping") {
			invalidateRequest();
			phase = "paused";
			pauseLeaf = ctx.sessionManager.getLeafId();
			nextCheck = deps.now();
			void refresh();
		}
		render();
	});

	pi.registerCommand("openai-limits", {
		description: "Show OpenAI subscription usage (on, off, check, cancel, threshold <percent>)",
		handler: async (args, context) => {
			const action = args.trim();
			if (action === "on" || action === "off") {
				const next = { ...config, autoPause: action === "on" };
				deps.saveConfig(next);
				config = next;
				invalidateRequest();
				clearPause();
				nextCheck = deps.now();
				maybeWrap();
			} else if (/^threshold(?:\s|$)/.test(action)) {
				const parts = action.split(/\s+/);
				const raw = parts[1] ?? "";
				const percent = Number(raw.replace(/%$/, ""));
				if (parts.length !== 2 || !/^(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(raw) || !Number.isFinite(percent) || percent < 0 || percent >= 100) {
					context.ui.notify("Usage: /openai-limits threshold <percent> (0 to less than 100)", "warning");
					return;
				}
				const next = { ...config, pauseAtPercent: percent };
				deps.saveConfig(next);
				config = next;
				lastStatus = undefined;
				maybeWrap();
			} else if (action === "cancel") {
				if (phase === "paused" || phase === "wrapping") override();
			} else if (action !== "" && action !== "check") {
				context.ui.notify("Usage: /openai-limits [on|off|check|cancel|threshold <percent>]", "warning");
				return;
			}
			if (ctx && (action === "" || action === "check")) await refresh();
			render();
			const lines = [`Automatic pausing: ${config.autoPause ? "on" : "off"} (at ${config.pauseAtPercent}% remaining)`];
			if (!ctx) lines.push("Select an openai-codex model on chatgpt.com to monitor subscription usage.");
			else {
				lines.push(`Status: ${phase}${unavailable ? snapshot ? " · cached usage (refresh unavailable)" : " · usage unavailable" : ""}`);
				if (failure) lines.push(`Check failed: ${failure}`);
				for (const item of snapshot?.limits ?? []) {
					for (const window of item.windows) {
						const reset = window.resetAt === undefined ? "" : ` · resets ${clock.dateTime(window.resetAt)}`;
						lines.push(`${item.model ?? item.id}${window.minutes === undefined ? "" : ` (${duration(window.minutes * 60_000)})`}: ${Math.floor(100 - window.usedPercent)}% remaining${reset}`);
					}
				}
			}
			context.ui.notify(lines.join("\n"), "info");
		},
	});
}

export default function openaiLimits(pi: ExtensionAPI): void {
	registerOpenAILimits(pi);
}
