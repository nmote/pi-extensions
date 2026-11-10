import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { FAST_MODE_STATUS_KEY } from "../shared/footer-status.ts";
import {
	FAST_MODE_STATE_CHANNEL, SUBAGENT_FAST_COMMAND, SUBAGENT_RUN_ID_ENV, SUBAGENT_TOKEN_ENV, fastModeAck,
} from "../shared/subagent-protocol.ts";
import { codexConfirmation, codexTier, priceCodexFast, record, supportsCodexFast, type CodexTier } from "./codex.ts";

const STATE_ENTRY = "fast-mode";
const WARNING_WIDGET = "fast-mode-warning";
const PRICE_BASIS = "Estimates use 2× standard prices (purchased credits/PAYG), not subscription allowance.";

export function restoreFastMode(entries: readonly SessionEntry[]): boolean {
	let enabled = false;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === STATE_ENTRY && record(entry.data) && typeof entry.data.enabled === "boolean") {
			enabled = entry.data.enabled;
		}
	}
	return enabled;
}

interface FastRequest extends CodexTier {
	model: Model<Api>;
}

export function registerFastMode(pi: ExtensionAPI, options: { childToken?: string } = {
	childToken: process.env[SUBAGENT_RUN_ID_ENV] ? process.env[SUBAGENT_TOKEN_ENV] : undefined,
}): void {
	const childToken = options.childToken;
	let saved = false;
	let inherited: boolean | undefined;
	let selectionVersion = 0;
	let turn: { model: Model<Api> | undefined; version: number } | undefined;
	let pending: FastRequest | undefined;
	let last: FastRequest | undefined;
	let routeWarning: string | undefined;
	let shownWarning: string | undefined;
	const enabled = () => inherited ?? saved;

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, type);
		else console.error(message);
	}

	function refresh(ctx: ExtensionContext): void {
		const supported = supportsCodexFast(ctx.model);
		const warning = enabled() && (!supported || routeWarning)
			? `FAST MODE NOT APPLIED: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no selected model"}. ${routeWarning ?? "This selection is unsupported."}`
			: undefined;
		if (!childToken && warning && warning !== shownWarning) notify(ctx, warning, "warning");
		shownWarning = warning;
		if (!ctx.hasUI) return;
		const result = last && last.model.id === ctx.model?.id && last.model.provider === ctx.model?.provider ? last : undefined;
		const state = warning ? "unavailable" : result ? codexConfirmation(result.tier) : "requested";
		ctx.ui.setStatus(FAST_MODE_STATUS_KEY, enabled()
			? ctx.ui.theme.fg(warning ? "warning" : "accent", `[fast: ${state}${state === "not-fast" ? "" : " · 2× est."}]`) : undefined);
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(WARNING_WIDGET, !childToken && warning
				? [ctx.ui.theme.fg("warning", ctx.ui.theme.bold(warning))] : undefined);
		}
	}

	function restore(ctx: ExtensionContext): void {
		saved = restoreFastMode(ctx.sessionManager.getBranch());
		pending = last = undefined;
		turn = undefined;
		routeWarning = shownWarning = undefined;
		refresh(ctx);
	}

	const unsubscribe = pi.events.on(FAST_MODE_STATE_CHANNEL, (data) => {
		const request = data as { respond?: (state: { enabled: boolean }) => void } | undefined;
		if (typeof request?.respond === "function") request.respond({ enabled: enabled() });
	});
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("turn_start", (_event, ctx) => {
		turn = { model: ctx.model, version: selectionVersion };
	});
	pi.on("model_select", (_event, ctx) => {
		selectionVersion++;
		last = undefined;
		routeWarning = undefined;
		refresh(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribe();
		pending = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(FAST_MODE_STATUS_KEY, undefined);
		if (ctx.mode === "tui") ctx.ui.setWidget(WARNING_WIDGET, undefined);
	});

	if (childToken) pi.registerCommand(SUBAGENT_FAST_COMMAND, {
		description: "Internal managed-subagent Fast preference update",
		handler: async (args, ctx) => {
			const [token, mode, extra] = args.trim().split(/\s+/);
			if (ctx.mode !== "rpc" || token !== childToken || extra || !["on", "off"].includes(mode)) {
				throw new Error("Invalid subagent Fast mode update");
			}
			inherited = mode === "on";
			last = undefined;
			routeWarning = undefined;
			refresh(ctx);
			ctx.ui.notify(fastModeAck(childToken, inherited), "info");
		},
	});

	pi.registerCommand("fast", {
		description: "Toggle premium Fast inference (on, off, status); estimates use 2× purchased-credit prices",
		getArgumentCompletions: (prefix) => ["on", "off", "status"].filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!["", "on", "off", "status"].includes(command)) {
				notify(ctx, "Usage: /fast [on|off|status]", "warning");
				return;
			}
			if (command !== "status") {
				const next = command === "" ? !enabled() : command === "on";
				if (childToken) inherited = next;
				else {
					pi.appendEntry(STATE_ENTRY, { enabled: next });
					saved = next;
				}
				routeWarning = undefined;
			}
			refresh(ctx);
			const result = last ? ` Last request: ${codexConfirmation(last.tier)} (response tier: ${last.tier ?? "absent"}).` : "";
			notify(ctx, `Fast ${enabled() ? "on" : "off"}. ${PRICE_BASIS}${result}${!enabled() ? " Provider defaults are unchanged." : ""}`);
		},
	});

	pi.on("cache_warming_decision", () => enabled() ? { action: "stop" } : undefined);
	pi.on("before_provider_request", async (event, ctx) => {
		if (ctx.isIdle()) return;
		pending = last = undefined;
		refresh(ctx);
		if (!enabled() || !supportsCodexFast(ctx.model)) return;
		const model = turn?.model;
		if (!turn || turn.version !== selectionVersion) {
			routeWarning = "The model changed during request preparation; Fast was not applied.";
			refresh(ctx);
			return;
		}
		if (!supportsCodexFast(model)) return;
		if (!record(event.payload) || event.payload.model !== model.id) {
			routeWarning = "The request does not match the selected model.";
			refresh(ctx);
			return;
		}
		// Auth may override the catalog endpoint; do not send provider-specific fields to a gateway.
		const version = turn.version;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (version !== selectionVersion) {
			routeWarning = "The model changed during request preparation; Fast was not applied.";
			refresh(ctx);
			return;
		}
		if (!auth.ok || !supportsCodexFast(model, auth.baseUrl ?? model.baseUrl)) {
			routeWarning = "The request endpoint could not be verified as direct Codex.";
			refresh(ctx);
			return;
		}
		pending = { model: { ...model, cost: structuredClone(model.cost) } };
		last = undefined;
		routeWarning = undefined;
		refresh(ctx);
		return { ...event.payload, service_tier: "priority" };
	});
	pi.on("provider_stream_event", (event) => {
		if (!pending || event.provider !== pending.model.provider || event.api !== pending.model.api || event.model !== pending.model.id) return;
		const tier = codexTier(event.data);
		if (tier) Object.assign(pending, tier);
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const request = pending;
		pending = undefined;
		if (!request || event.message.provider !== request.model.provider || event.message.api !== request.model.api ||
			event.message.model !== request.model.id || (request.responseId && request.responseId !== event.message.responseId)) return;
		last = request;
		refresh(ctx);
		return { message: priceCodexFast(event.message, request.model, request.tier) };
	});
}

export default registerFastMode;
