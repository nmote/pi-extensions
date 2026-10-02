/**
 * Auto-Approve Extension ("auto mode")
 *
 * Reduces approval fatigue by classifying each tool call at the single control
 * point pi exposes (the `tool_call` event) into: auto-approve, block, or prompt.
 *
 * Modes (govern only calls that match NEITHER the allow nor the deny list):
 *   - manual : prompt the user
 *   - auto   : evaluate with a small configurable model; "allow" runs, while
 *              "review" rejects the call and offers explicit human escalation
 *   - yolo   : auto-approve (the deny list still blocks)
 *
 * Precedence (all modes): deny list > global skill read / in-scope file access
 * > allow list > mode. Matching context rules only supplement model evaluation;
 * they never override allow or deny decisions. Session guidance supersedes
 * conflicting evaluator policy within its scope and is shared with subagents.
 * The deny list always wins, including in yolo.
 *
 * Fail-closed: in non-interactive contexts (no UI), anything that would prompt
 * the user is blocked instead. Evaluator failures are never allowed; their
 * rejection invites a retry, a different approach, or escalation.
 *
 * The evaluator uses the shared small model (shared/small-model.ts, managed
 * via /small-model). There is no default: the first time auto mode needs to
 * evaluate a command, you are asked to pick one.
 *
 * Config: ~/.pi/agent/extensions/auto-approve.json (global only).
 */

import { AUTO_APPROVE_STATUS_KEY, AUTO_APPROVE_EVAL_STATUS_KEY } from "../shared/footer-status.ts";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { EVALUATOR_CACHE_ENTRY, EvaluatorCache } from "./cache.ts";
import { ApprovalQueue } from "./approval-queue.ts";
import { type AutoApproveConfig, EFFORTS, isEffort, isMode, loadConfig, type Mode, MODES, saveEvaluatorEffort } from "./config.ts";
import {
	absoluteToolPath,
	buildMatchInput,
	exactCallSignature,
	isAgentSkillRead,
	isPathWithinRoots,
	isVersionControlMetadataPath,
	type MatchInput,
	matchesAny,
	matchesAnyDeny,
	matchingInstructions,
	scopeInstruction,
} from "./rules.ts";
import { evaluateSafety } from "./evaluator.ts";
import { realPathOf } from "./realpath.ts";
import {
	AUTO_APPROVE_STATE_CHANNEL,
	AUTO_APPROVE_STAT_CHANNEL,
	AUTO_APPROVE_TASK_CHANNEL,
	SUBAGENT_TOKEN_ENV,
	type AutoApproveStat,
	isAutoApproveStat,
	tagApprovalTitle,
	tagAutoApproveStat,
} from "../shared/subagent-protocol.ts";
import { ensureSmallModel, loadSmallModel } from "../shared/small-model.ts";
import {
	APPROVAL_DIALOG_CHANNEL, APPROVAL_GUIDANCE_CHANNEL, type ApprovalDialogRequest,
	type ApprovalGuidance, type GuidanceRequest,
	guidanceTitle, isApprovalGuidance, parseGuidanceRequest,
} from "../shared/approval-guidance.ts";

const WRITE_TOOLS = new Set(["write", "edit"]);
const APPROVAL_TOOL = "request_tool_approval";
const INLINE_SCRIPT_GUIDELINE = "Run small ad-hoc scripts inline using a quoted heredoc (e.g. `python3 - <<'EOF'`) rather than writing and executing a temporary script, so the approval evaluator can inspect the full body. Prefer `edit` for small, targeted file changes.";
const APPROVAL_REQUEST_TTL_MS = 10 * 60 * 1000;
const MEMO_ENTRY = "auto-approve-memo";
const HUMAN_DENY_ENTRY = "auto-approve-human-deny";
const MODE_ENTRY = "auto-approve-mode";
const STATS_ENTRY = "auto-approve-stats";
const GUIDANCE_ENTRY = "auto-approve-guidance";
const EDIT_GUIDANCE_CHOICE = "Approve once + edit session guidance…";

type Stats = Record<AutoApproveStat, number>;

interface PendingApproval {
	key: string;
	toolName: string;
	input: MatchInput;
	cwd: string;
	reason: string;
	expiresAt: number;
}

function emptyStats(): Stats {
	return {
		evaluatorAllows: 0,
		softRejections: 0,
		evaluatorFailures: 0,
		escalations: 0,
		humanApprovals: 0,
		humanDenials: 0,
	};
}

function restoredStats(value: unknown): Stats | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<Record<AutoApproveStat, unknown>>;
	const result = emptyStats();
	for (const key of Object.keys(result) as AutoApproveStat[]) {
		if (typeof candidate[key] !== "number" || candidate[key] < 0 || !Number.isInteger(candidate[key])) return undefined;
		result[key] = candidate[key];
	}
	return result;
}

function modeLabel(mode: Mode): string {
	return { manual: "✋ manual", auto: "🤖 auto", yolo: "☠️  yolo" }[mode];
}

export default function autoApprove(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const skillsDir = resolve(agentDir, "skills");
	const homeDir = homedir();
	const childToken = process.env[SUBAGENT_TOKEN_ENV];
	let config: AutoApproveConfig = loadConfig();
	let mode: Mode = config.defaultMode;
	// Session-scoped exact calls the user explicitly allowed or denied.
	const alwaysAllow = new Set<string>();
	const humanDenied = new Set<string>();
	const oneShotAllow = new Map<string, number>();
	// Evaluator outputs and counters persist as custom session entries.
	const evaluatorCache = new EvaluatorCache();
	const pendingApprovals = new Map<string, PendingApproval>();
	const approvalQueue = new ApprovalQueue();
	let stats = emptyStats();
	let guidance: ApprovalGuidance = { text: "", revision: 0 };

	function adoptGuidance(next: ApprovalGuidance, ctx: ExtensionContext): void {
		if (next.revision !== guidance.revision || next.text !== guidance.text) evaluatorCache.clear();
		guidance = { ...next };
		updateStatus(ctx);
	}

	async function exchangeGuidance(request: GuidanceRequest, ctx: ExtensionContext): Promise<ApprovalGuidance> {
		if (ctx.signal?.aborted) throw new Error("Session guidance request cancelled");
		if (childToken) {
			// Managed children route this exact token-marked request to their parent, not the user.
			const response = await ctx.ui.input(guidanceTitle(childToken), JSON.stringify(request), {
				signal: ctx.signal, timeout: 10000,
			});
			const value: unknown = JSON.parse(response ?? "null");
			if (!isApprovalGuidance(value)) throw new Error("Parent session guidance is unavailable or changed while editing");
			adoptGuidance(value, ctx);
			return { ...value };
		}
		if (request.action === "set") {
			if (request.expectedRevision !== guidance.revision) throw new Error("Session guidance changed while editing; reopen the editor");
			const next = { text: request.text, revision: guidance.revision + 1 };
			pi.appendEntry(GUIDANCE_ENTRY, next);
			adoptGuidance(next, ctx);
		}
		return { ...guidance };
	}

	pi.events.on(APPROVAL_GUIDANCE_CHANNEL, (data) => {
		const event = data as {
			request: GuidanceRequest; ctx: ExtensionContext; respond: (value: Promise<ApprovalGuidance>) => void;
		};
		event.respond(exchangeGuidance(event.request, event.ctx));
	});

	pi.events.on(APPROVAL_DIALOG_CHANNEL, (data) => {
		const request = data as ApprovalDialogRequest;
		request.respond(selectApproval(request.ctx, request.title, request.choices, undefined, true).then(
			(result) => result.signal.aborted ? undefined : result.choice,
		));
	});

	async function collectGuidance(ctx: ExtensionContext, signal: AbortSignal): Promise<GuidanceRequest | undefined> {
		const current = await exchangeGuidance({ action: "get" }, ctx);
		if (signal.aborted) return undefined;
		const text = await ctx.ui.editor(
			tagApprovalTitle("Session approval guidance — main agent and all subagents, including future resumes"),
			current.text,
		);
		return text === undefined || signal.aborted ? undefined : { action: "set", text, expectedRevision: current.revision };
	}

	async function editGuidance(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
		try {
			const edit = await collectGuidance(ctx, signal);
			if (edit) await exchangeGuidance(edit, ctx);
		} catch (error) {
			ctx.ui.notify(`Auto-approve: ${error instanceof Error ? error.message : error}`, "warning");
		}
	}

	async function selectApproval(
		ctx: ExtensionContext, title: string, choices: string[], signal?: AbortSignal, forward = false,
	): Promise<{ choice: string | undefined; signal: AbortSignal }> {
		return approvalQueue.select(async (dialogSignal) => {
			const dialogCtx = { ...ctx, signal: dialogSignal };
			const options = [...choices.filter((choice) => choice !== EDIT_GUIDANCE_CHOICE), EDIT_GUIDANCE_CHOICE];
			const choice = await ctx.ui.select(tagApprovalTitle(title), options, { signal: dialogSignal });
			try {
				const edit = choice === EDIT_GUIDANCE_CHOICE
					? await collectGuidance(dialogCtx, dialogSignal)
					: parseGuidanceRequest(choice);
				if (choice !== EDIT_GUIDANCE_CHOICE && edit?.action !== "set") return choice;
				if (!edit || dialogSignal.aborted) return undefined;
				// Only the originating agent commits, after its own cancellation check.
				// Intermediate parents forward the edit without authorizing a cancelled descendant.
				if (forward) return JSON.stringify(edit);
				await exchangeGuidance(edit, dialogCtx);
				return "Approve once";
			} catch (error) {
				ctx.ui.notify(`Auto-approve: ${error instanceof Error ? error.message : error}`, "warning");
				return undefined;
			}
		}, signal ?? ctx.signal);
	}

	function resetApprovals(): void {
		approvalQueue.reset();
		oneShotAllow.clear();
		pendingApprovals.clear();
	}

	pi.events.on(AUTO_APPROVE_STATE_CHANNEL, (data) => {
		const request = data as { respond?: (state: { mode: Mode }) => void } | undefined;
		request?.respond?.({ mode });
	});

	pi.events.on(AUTO_APPROVE_TASK_CHANNEL, (data) => {
		const request = data as { token?: string; mode?: unknown; ctx: ExtensionContext; respond: () => void };
		const token = process.env[SUBAGENT_TOKEN_ENV];
		if (!token || request?.token !== token || !isMode(request.mode)) return;
		resetApprovals();
		setMode(request.mode, request.ctx, false);
		request.respond();
	});

	pi.events.on(AUTO_APPROVE_STAT_CHANNEL, (data) => {
		const stat = (data as { stat?: unknown } | undefined)?.stat;
		if (isAutoApproveStat(stat)) record(stat);
	});

	pi.registerFlag("auto", {
		description: "Auto-approval mode: manual | auto | yolo",
		type: "string",
	});

	function updateStatus(ctx: ExtensionContext): void {
		const color = mode === "yolo" ? "error" : mode === "auto" ? "accent" : "warning";
		ctx.ui.setStatus(AUTO_APPROVE_STATUS_KEY, ctx.ui.theme.fg(color, `[${modeLabel(mode)}${guidance.text ? " · session guidance" : ""}]`));
		if (mode === "yolo") {
			ctx.ui.setWidget("auto-approve", [
				ctx.ui.theme.fg("error", "☠️  YOLO MODE — tool calls auto-approved (deny list still blocks)"),
			]);
		} else {
			ctx.ui.setWidget("auto-approve", undefined);
		}
	}

	function setMode(next: Mode, ctx: ExtensionContext, announce = true): void {
		mode = next;
		pi.appendEntry(MODE_ENTRY, { mode });
		updateStatus(ctx);
		if (announce) ctx.ui.notify(`Auto-approve mode: ${modeLabel(mode)}`, mode === "yolo" ? "warning" : "info");
	}

	function setEffort(effort: AutoApproveConfig["evaluator"]["reasoningEffort"], ctx: ExtensionContext): void {
		try {
			saveEvaluatorEffort(effort);
		} catch (error) {
			ctx.ui.notify(`Auto-approve: could not save evaluator effort: ${error}`, "error");
			return;
		}
		config.evaluator.reasoningEffort = effort;
		evaluatorCache.clear();
		ctx.ui.notify(`Auto-approve evaluator effort: ${effort}`, "info");
	}

	function preview(toolName: string, input: MatchInput, cwd: string): string {
		let details = input.subject;
		try {
			details = JSON.stringify(input.raw, null, 2);
		} catch {
			// The primary subject is still useful when arguments are not serializable.
		}
		return `cwd: ${cwd}\ntool: ${toolName}\ninput:\n${details}`;
	}

	function freezeValue(value: unknown, seen = new Set<object>()): void {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		for (const child of Object.values(value as Record<string, unknown>)) freezeValue(child, seen);
		Object.freeze(value);
	}

	function lockToolInput(event: { input: Record<string, unknown> }): void {
		freezeValue(event.input);
		Object.defineProperty(event, "input", {
			value: event.input,
			writable: false,
			configurable: false,
			enumerable: true,
		});
	}

	function record(stat: AutoApproveStat, ctx?: ExtensionContext): void {
		stats[stat]++;
		pi.appendEntry(STATS_ENTRY, { ...stats });
		if (ctx) {
			const notification = tagAutoApproveStat(stat);
			if (notification) ctx.ui.notify(notification, "info");
		}
	}

	/** Lexical absolute and symlink-resolved forms of a tool path. */
	function toolPaths(path: unknown, cwd: string): { abs: string; real: string | undefined } | undefined {
		if (typeof path !== "string") return undefined;
		const abs = absoluteToolPath(path, cwd, homeDir);
		return abs === undefined ? undefined : { abs, real: realPathOf(abs) };
	}

	/**
	 * Where the call's `path` resolves through symlinks, when that differs from
	 * its lexical path. Omits the untrusted literal path since this is trusted text.
	 */
	function symlinkNote(input: MatchInput, cwd: string): string | undefined {
		const paths = toolPaths(input.raw.path, cwd);
		if (!paths || paths.real === paths.abs) return undefined;
		return paths.real === undefined
			? "the tool call's `path` could not be resolved through symlinks"
			: `the tool call's \`path\` resolves through symlinks to \`${paths.real}\``;
	}

	/** Trusted evaluator instructions: the path scope, matching context rules, then any symlink note. */
	function evaluatorInstructions(input: MatchInput, cwd: string): string[] {
		// The skills dir is read-only here so bash can inspect what the read tool may.
		const scope = scopeInstruction(cwd, config.writeRoots, [skillsDir, ...config.readRoots], homeDir);
		const note = symlinkNote(input, cwd);
		return [
			...(scope ? [scope] : []),
			...matchingInstructions(config.context, input),
			...(note ? [`Note: ${note}.`] : []),
		];
	}

	function approvalKey(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
		return exactCallSignature(toolName, input, cwd);
	}

	function softReject(
		ctx: ExtensionContext,
		toolName: string,
		rawInput: Record<string, unknown>,
		input: MatchInput,
		reason: string,
		evaluatorFailure = false,
	): { block: true; reason: string } {
		record("softRejections", ctx);
		if (evaluatorFailure) record("evaluatorFailures", ctx);

		const now = Date.now();
		for (const [id, pending] of pendingApprovals) {
			if (pending.expiresAt <= now) pendingApprovals.delete(id);
		}

		const key = approvalKey(toolName, rawInput, ctx.cwd);
		let id: string | undefined;
		if (key) {
			const requestId = randomUUID();
			pendingApprovals.set(requestId, {
				key,
				toolName,
				input: { ...input, raw: structuredClone(rawInput) },
				cwd: ctx.cwd,
				reason,
				expiresAt: now + APPROVAL_REQUEST_TTL_MS,
			});
			id = JSON.stringify(requestId);
		}
		const unescalable = "this call cannot be escalated because its arguments could not be identified exactly.";

		if (evaluatorFailure) {
			const guidance = id
				? `Retry this exact call, try a different approach, or, if this exact call is essential, use ${APPROVAL_TOOL} with requestId ${id} to ask the user.`
				: `Retry this exact call or try a different approach; ${unescalable}`;
			return {
				block: true,
				reason: `Auto-approve: evaluation failed — ${reason}\n\nThis is not a safety decision. ${guidance}`,
			};
		}

		const guidance = id
			? `Pursue a safer approach. If this exact call is essential, use ${APPROVAL_TOOL} with requestId ${id} and explain why no safer alternative works.`
			: `Pursue a safer approach; ${unescalable}`;
		return { block: true, reason: `Auto-approve: rejected automatically — ${reason}\n\n${guidance}` };
	}

	/** Prompt the user to approve/deny a single call. Returns a block result or undefined (approve). */
	async function ask(
		ctx: ExtensionContext,
		toolName: string,
		input: MatchInput,
		key: string | undefined,
		reason: string,
	): Promise<{ block: true; reason: string } | undefined> {
		if (!ctx.hasUI) {
			return { block: true, reason: `Auto-approve: blocked (no UI to confirm). ${reason}. It's fine to pursue a safer path that wouldn't need approval. Do not circumvent or retry this specific action. If you can't proceed safely, stop and tell the user what you need.` };
		}
		const choices = key
			? ["Approve once", "Approve (always this exact call this session)", "Deny"]
			: ["Approve once", "Deny"];
		const decision = await selectApproval(
			ctx, `Approve tool call?\n\n${preview(toolName, input, ctx.cwd)}\n\n(${reason})`, choices,
		);
		const choice = decision.signal.aborted ? undefined : decision.choice;
		if (choice === "Approve (always this exact call this session)" && key) {
			alwaysAllow.add(key);
			pi.appendEntry(MEMO_ENTRY, { key });
			record("humanApprovals", ctx);
			return undefined;
		}
		if (choice === "Approve once") {
			record("humanApprovals", ctx);
			return undefined;
		}
		if (choice === "Deny") {
			record("humanDenials", ctx);
			return { block: true, reason: `Auto-approve: denied by user. ${reason}. Take a different approach, or ask the user before trying anything similar.` };
		}
		return { block: true, reason: `Auto-approve: approval cancelled. ${reason}. Take a different approach or tell the user what is blocked.` };
	}

	pi.registerTool({
		name: APPROVAL_TOOL,
		label: "Request Tool Approval",
		description: "Ask the user to approve one exact tool call that auto-approve rejected. Use only the requestId from that rejection, and only when no safer approach works.",
		promptSnippet: "Request human approval for an exact tool call rejected by auto-approve",
		promptGuidelines: [
			"Use request_tool_approval only after auto-approve returns a requestId and only when no safer approach can complete the task.",
		],
		parameters: Type.Object({
			requestId: Type.String({ description: "Request ID from the automatic rejection" }),
			justification: Type.String({ description: "Why the exact rejected call is necessary and safer alternatives will not work" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const pending = pendingApprovals.get(params.requestId);
			if (!pending || pending.expiresAt <= Date.now()) {
				pendingApprovals.delete(params.requestId);
				return {
					content: [{ type: "text", text: "This approval request is invalid or expired. Reconsider the action before attempting it again." }],
					details: {},
				};
			}
			pendingApprovals.delete(params.requestId);
			record("escalations", ctx);

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Human approval is unavailable. Pursue a safer approach or tell the user what is blocked." }],
					details: {},
				};
			}

			const justification = params.justification.length > 2000
				? `${params.justification.slice(0, 2000)}…`
				: params.justification;
			const decision = await selectApproval(
				ctx,
				`Approve escalated tool call?\n\n${preview(pending.toolName, pending.input, pending.cwd)}\n\nAgent justification:\n${justification}\n\n(Evaluator: ${pending.reason})`,
				["Approve once", "Approve (always this exact call this session)", "Deny"], signal,
			);
			const choice = decision.signal.aborted ? undefined : decision.choice;

			if (choice === "Approve once") {
				oneShotAllow.set(pending.key, (oneShotAllow.get(pending.key) ?? 0) + 1);
				record("humanApprovals", ctx);
				return {
					content: [{ type: "text", text: "Approved once. Retry the exact original tool call; changing its arguments requires a new evaluation." }],
					details: {},
				};
			}
			if (choice === "Approve (always this exact call this session)") {
				alwaysAllow.add(pending.key);
				pi.appendEntry(MEMO_ENTRY, { key: pending.key });
				record("humanApprovals", ctx);
				return {
					content: [{ type: "text", text: "Approved for this exact call for the rest of the session. Retry the original tool call." }],
					details: {},
				};
			}

			if (choice === "Deny") {
				humanDenied.add(pending.key);
				pi.appendEntry(HUMAN_DENY_ENTRY, { key: pending.key });
				record("humanDenials", ctx);
				return {
					content: [{ type: "text", text: "Denied by the user. Do not retry this call during the session; pursue a safer approach." }],
					details: {},
				};
			}
			return {
				content: [{ type: "text", text: "Approval was cancelled. Pursue a safer approach or tell the user what is blocked." }],
				details: {},
			};
		},
	});

	pi.on("before_agent_start", (event) => {
		const guidelines = event.systemPromptOptions.promptGuidelines;
		if (!guidelines.includes(INLINE_SCRIPT_GUIDELINE)) guidelines.push(INLINE_SCRIPT_GUIDELINE);
	});

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName;
		const rawInput = (event.input ?? {}) as Record<string, unknown>;
		const input = buildMatchInput(toolName, rawInput);
		const key = approvalKey(toolName, rawInput, ctx.cwd);

		// Deny list wins in every mode, including yolo and human approval.
		if (matchesAnyDeny(config.deny, input)) {
			return { block: true, reason: "Auto-approve: matched deny list" };
		}

		// The escalation tool only asks the user; it cannot execute the rejected call.
		if (toolName === APPROVAL_TOOL) return undefined;

		if (key && humanDenied.has(key)) {
			return { block: true, reason: "Auto-approve: the user denied this exact call for the session. Pursue a safer approach." };
		}
		const oneShotCount = key ? (oneShotAllow.get(key) ?? 0) : 0;
		if (key && oneShotCount > 0) {
			if (oneShotCount === 1) oneShotAllow.delete(key);
			else oneShotAllow.set(key, oneShotCount - 1);
			lockToolInput(event);
			return undefined;
		}
		if (key && alwaysAllow.has(key)) {
			lockToolInput(event);
			return undefined;
		}

		const path = typeof rawInput.path === "string" ? rawInput.path : "";
		const realPath = toolPaths(path, ctx.cwd)?.real;
		if (
			!isVersionControlMetadataPath(path, ctx.cwd, homeDir) &&
			!(realPath !== undefined && isVersionControlMetadataPath(realPath, ctx.cwd))
		) {
			// Global skills load without requiring a machine-specific allow-list entry.
			// Lexical, since skill installers may symlink into the skills directory.
			if (isAgentSkillRead(input, agentDir, ctx.cwd, homeDir)) return undefined;

			// Scope checks require both the literal and symlink-resolved paths to be in scope.
			// Relative configured roots resolve against the tool event's cwd.
			const inWriteScope = isPathWithinRoots(path, ctx.cwd, config.writeRoots, ctx.cwd, homeDir, realPathOf);

			// Reads within cwd, the write scope, or readRoots are auto-approved.
			if (
				toolName === "read" &&
				(inWriteScope || isPathWithinRoots(path, ctx.cwd, config.readRoots, ctx.cwd, homeDir, realPathOf))
			) {
				return undefined;
			}

			// Writes/edits within the write scope are auto-approved.
			if (WRITE_TOOLS.has(toolName) && inWriteScope) return undefined;
		}

		// User allow list.
		if (matchesAny(config.allow, input)) return undefined;

		// Unmatched — mode decides.
		if (mode === "yolo") return undefined;

		if (mode === "manual") {
			const note = symlinkNote(input, ctx.cwd);
			const decision = await ask(ctx, toolName, input, key, `not in allow/deny list${note ? `; ${note}` : ""}`);
			if (!decision) lockToolInput(event);
			return decision;
		}

		// Recheck the authoritative policy before accepting cached or in-flight verdicts.
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				const policy = await exchangeGuidance({ action: "get" }, ctx);
				const instructions = evaluatorInstructions(input, ctx.cwd);
				const effort = config.evaluator.reasoningEffort;
				let result = config.evaluator.memoize ? evaluatorCache.get(input, instructions, policy) : undefined;
				const cached = !!result;
				if (!result) {
					const model = await ensureSmallModel(ctx);
					if (!model) return softReject(ctx, toolName, rawInput, input, "no evaluator model available", true);
					ctx.ui.setStatus(AUTO_APPROVE_EVAL_STATUS_KEY, ctx.ui.theme.fg("muted", "[evaluating…]"));
					try {
						result = await evaluateSafety(model, ctx, toolName, rawInput, config.evaluator, instructions, policy);
					} finally {
						ctx.ui.setStatus(AUTO_APPROVE_EVAL_STATUS_KEY, undefined);
					}
				}
				// The final authoritative read is the authorization boundary, even if its RPC response is buffered.
				const current = await exchangeGuidance({ action: "get" }, ctx);
				if (current.revision !== policy.revision || current.text !== policy.text || config.evaluator.reasoningEffort !== effort) continue;
				if (!cached && config.evaluator.memoize) {
					const entry = evaluatorCache.remember(input, result, instructions, policy);
					if (entry) pi.appendEntry(EVALUATOR_CACHE_ENTRY, { ...entry, effort });
				}
				if (result.decision === "allow") {
					record("evaluatorAllows", ctx);
					return undefined;
				}
				const failed = result.cacheable === false;
				return softReject(ctx, toolName, rawInput, input,
					failed ? result.reason : `evaluator requested review — ${result.reason}`, failed);
			}
			return softReject(ctx, toolName, rawInput, input, "session policy kept changing during evaluation; retry", true);
		} catch (error) {
			return softReject(ctx, toolName, rawInput, input, error instanceof Error ? error.message : String(error), true);
		}
	});

	/** `/auto test` target: a registered tool followed by a JSON object, else a bash command. */
	function parseTestCall(text: string): { toolName: string; input: Record<string, unknown> } | string {
		const match = /^(\S+)\s+(\{[\s\S]*\})$/.exec(text);
		if (!match || !pi.getAllTools().some((tool) => tool.name === match[1])) {
			return { toolName: "bash", input: { command: text } };
		}
		try {
			const input: unknown = JSON.parse(match[2]);
			if (input && typeof input === "object" && !Array.isArray(input)) {
				return { toolName: match[1], input: input as Record<string, unknown> };
			}
		} catch {
			// Reported below.
		}
		return `auto-approve: invalid JSON arguments for ${match[1]}`;
	}

	pi.registerCommand("auto", {
		description: "Auto-approval: /auto [manual|auto|yolo|guidance [clear]|effort [low|medium|high]|stats|test <cmd>]",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();

			if (trimmed === "") {
				const small = loadSmallModel();
				const evalModel =
					small.provider && small.model
						? `${small.provider}/${small.model}`
						: "(not set — pick one with /small-model)";
				ctx.ui.notify(
					`Auto-approve\n  mode: ${modeLabel(mode)}\n  small model: ${evalModel}\n  evaluator effort: ${config.evaluator.reasoningEffort}\n  allow: ${config.allow.length} rule(s), deny: ${config.deny.length} rule(s), context: ${config.context.length} rule(s)\n  writeRoots: ${["<cwd>", ...config.writeRoots].join(", ")}\n  readRoots: ${["<cwd>", "<writeRoots>", skillsDir, ...config.readRoots].join(", ")}`,
					"info",
				);
				return;
			}

			if (isMode(trimmed)) {
				setMode(trimmed, ctx);
				return;
			}

			if (trimmed === "guidance" || trimmed === "guidance clear") {
				if (!ctx.hasUI) {
					ctx.ui.notify("Session guidance requires a user UI", "warning");
					return;
				}
				await approvalQueue.select(async (signal) => {
					if (trimmed === "guidance") {
						await editGuidance({ ...ctx, signal }, signal);
					} else {
						try {
							const current = await exchangeGuidance({ action: "get" }, ctx);
							if (!signal.aborted) await exchangeGuidance({ action: "set", text: "", expectedRevision: current.revision }, ctx);
						} catch (error) {
							ctx.ui.notify(`Auto-approve: ${error instanceof Error ? error.message : error}`, "warning");
						}
					}
					return undefined;
				}, ctx.signal);
				return;
			}

			if (trimmed === "effort" || trimmed.startsWith("effort ")) {
				const requested = trimmed.slice("effort".length).trim();
				if (requested && !isEffort(requested)) {
					ctx.ui.notify("Usage: /auto effort [low|medium|high]", "warning");
					return;
				}
				if (!requested && !ctx.hasUI) {
					ctx.ui.notify("Usage: /auto effort [low|medium|high]", "warning");
					return;
				}
				const effort = requested || await ctx.ui.select(
					`Evaluator effort (current: ${config.evaluator.reasoningEffort}):`, EFFORTS,
				);
				if (isEffort(effort)) setEffort(effort, ctx);
				return;
			}

			if (trimmed === "stats") {
				ctx.ui.notify(
					`Auto-approve stats\n  evaluator allows: ${stats.evaluatorAllows}\n  soft rejections: ${stats.softRejections}\n  evaluator failures: ${stats.evaluatorFailures}\n  escalations: ${stats.escalations}\n  human approvals: ${stats.humanApprovals}\n  human denials: ${stats.humanDenials}`,
					"info",
				);
				return;
			}

			if (trimmed === "test" || trimmed.startsWith("test ")) {
				const text = trimmed.slice(4).trim();
				if (!text) {
					ctx.ui.notify("Usage: /auto test <bash command> | /auto test <tool> <json object>", "warning");
					return;
				}
				const call = parseTestCall(text);
				if (typeof call === "string") {
					ctx.ui.notify(call, "warning");
					return;
				}
				const model = await ensureSmallModel(ctx);
				if (!model) {
					ctx.ui.notify("auto-approve: no evaluator model available", "warning");
					return;
				}
				let policy: ApprovalGuidance;
				try {
					policy = await exchangeGuidance({ action: "get" }, ctx);
				} catch (error) {
					ctx.ui.notify(`Auto-approve: ${error instanceof Error ? error.message : error}`, "warning");
					return;
				}
				const instructions = evaluatorInstructions(buildMatchInput(call.toolName, call.input), ctx.cwd);
				ctx.ui.setStatus(AUTO_APPROVE_EVAL_STATUS_KEY, ctx.ui.theme.fg("muted", "[evaluating…]"));
				let result: Awaited<ReturnType<typeof evaluateSafety>>;
				try {
					result = await evaluateSafety(model, ctx, call.toolName, call.input, config.evaluator, instructions, policy);
				} finally {
					ctx.ui.setStatus(AUTO_APPROVE_EVAL_STATUS_KEY, undefined);
				}
				ctx.ui.notify(`Evaluator verdict (${call.toolName}): ${result.decision.toUpperCase()}\n${result.reason}`, "info");
				return;
			}

			ctx.ui.notify(`Unknown: /auto ${trimmed}\nUse: manual | auto | yolo | guidance [clear] | effort [low|medium|high] | stats | test <cmd> | test <tool> <json>`, "warning");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "Cycle auto-approval mode (manual → auto → yolo)",
		handler: (ctx) => {
			const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
			setMode(next, ctx);
		},
	});

	pi.on("session_shutdown", () => resetApprovals());

	pi.on("session_start", async (_event, ctx) => {
		resetApprovals();
		config = loadConfig({ seed: true });

		// Restore persisted session state, then apply the CLI flag override if present.
		const entries = ctx.sessionManager.getEntries() as Array<{
			type: string;
			customType?: string;
			data?: { mode?: unknown; effort?: unknown; key?: unknown };
		}>;
		mode = config.defaultMode;
		guidance = { text: "", revision: 0 };
		alwaysAllow.clear();
		humanDenied.clear();
		evaluatorCache.clear();
		stats = emptyStats();
		for (const e of entries) {
			if (e.type !== "custom") continue;
			const data = e.data as { mode?: unknown; effort?: unknown; key?: unknown } | undefined;
			if (e.customType === GUIDANCE_ENTRY && isApprovalGuidance(e.data)) guidance = { ...e.data };
			if (e.customType === MODE_ENTRY && isMode(data?.mode)) mode = data.mode;
			if (e.customType === MEMO_ENTRY && typeof data?.key === "string") alwaysAllow.add(data.key);
			if (e.customType === HUMAN_DENY_ENTRY && typeof data?.key === "string") humanDenied.add(data.key);
			if (e.customType === EVALUATOR_CACHE_ENTRY && data?.effort === config.evaluator.reasoningEffort) {
				evaluatorCache.restore(e.data);
			}
			if (e.customType === STATS_ENTRY) stats = restoredStats(e.data) ?? stats;
		}
		const flag = pi.getFlag("auto");
		if (typeof flag === "string" && isMode(flag)) mode = flag;

		updateStatus(ctx);
	});
}
