import { SUBAGENTS_STATUS_KEY } from "../shared/footer-status.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	type Theme,
	type ToolRenderResultOptions,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	AUTO_APPROVE_STATE_CHANNEL,
	AUTO_APPROVE_STAT_CHANNEL,
	AUTO_APPROVE_TASK_CHANNEL,
	SUBAGENT_TASK_COMMAND,
	taskPolicyAck,
	questionTitle,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_TOKEN_ENV,
} from "../shared/subagent-protocol.ts";
import { requestApprovalDialog, requestGuidance } from "../shared/approval-guidance.ts";
import {
	discoverNamedAgents,
	type DispatchDefaults,
	formatNamedAgentCatalog,
	resolveSubagentTask,
	type SubagentTaskInput,
} from "./agents.ts";
import { SubagentManager, type SubagentSnapshot, type UsageTotals } from "./manager.ts";
import { restoreSubagents, SUBAGENT_STATE_ENTRY, subagentState } from "./state.ts";
import {
	clearSubagentModel,
	describeSubagentModelPolicy,
	formatModelRef,
	loadSubagentModels,
	pickSubagentModel,
	type SubagentModelsConfig,
} from "./model-config.ts";
import { createProgressReporter, type SubagentDetails } from "./progress.ts";
import { formatSpawnCall } from "./purpose.ts";
import {
	formatActivity,
	formatExpandedMetadata,
	formatResultHeading,
	formatRunStatus,
	progressText,
} from "./status.ts";

const MAX_PARALLEL_TASKS = 8;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const TaskFields = {
	task: Type.String({ minLength: 1, description: "Specific task to delegate" }),
	agent: Type.Optional(Type.String({ description: "Named agent to use; omit for a general subagent" })),
	cwd: Type.Optional(Type.String({ description: "Working directory; relative paths resolve from the parent cwd; a different cwd requires user approval" })),
	model: Type.Optional(Type.String({ description: "Model as provider/id or an unambiguous model pattern" })),
	thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Subagent thinking level" })),
};

const TaskItem = Type.Object(TaskFields);
const SpawnParams = Type.Object({
	task: Type.Optional(TaskFields.task),
	agent: TaskFields.agent,
	cwd: TaskFields.cwd,
	model: TaskFields.model,
	thinkingLevel: TaskFields.thinkingLevel,
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			minItems: 1,
			maxItems: MAX_PARALLEL_TASKS,
			description: `Tasks to run concurrently (maximum ${MAX_PARALLEL_TASKS})`,
		}),
	),
});

const SupervisorQuestionParams = Type.Object({
	question: Type.String({ minLength: 1, description: "The concrete question blocking progress" }),
	context: Type.Optional(Type.String({ description: "Brief context the supervisor needs to answer" })),
	options: Type.Optional(Type.Array(Type.String(), { description: "Viable choices, when there are discrete options" })),
});

function usageIsEmpty(usage: UsageTotals): boolean {
	return usage.totalTokens === 0 && usage.cost.total === 0;
}

function truncateOutput(output: string): string {
	const result = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!result.truncated) return result.content;
	return `${result.content}\n\n[Subagent output truncated to ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES} bytes.]`;
}

function questionText(result: SubagentSnapshot): string {
	if (!result.question) return "Subagent requested supervisor input.";
	const lines = [`Question: ${result.question.question}`];
	if (result.question.context) lines.push(`Context: ${result.question.context}`);
	if (result.question.options?.length) lines.push(`Options: ${result.question.options.join(" | ")}`);
	return lines.join("\n");
}

function formatResult(result: SubagentSnapshot): string {
	const total = result.totalUsage ?? result.usage;
	const heading = `${formatResultHeading(result)}\n\nUsage: ${result.usage.totalTokens} tokens this task; ${total.totalTokens} tokens / $${total.cost.total.toFixed(3)} lifetime.`;
	switch (result.status) {
		case "waiting":
			return `${heading}\n\n${questionText(result)}\n\nUse subagent_reply with id ${result.id} after deciding the answer.`;
		case "idle":
			return `${heading}\n\n${truncateOutput(result.output || "(no output)")}\n\nUse subagent_continue with id ${result.id} for related work, or subagent_cancel to end it.`;
		case "completed":
			return `${heading}\n\n${truncateOutput(result.output || "(no output)")}`;
		case "failed":
			return `${heading}\n\n${result.error || "Unknown failure"}`;
		case "cancelled":
			return `${heading}\n\n${result.error || "Cancelled"}`;
		default:
			return `${heading}\n\n${formatExpandedMetadata(result)}`;
	}
}

function formatResults(results: SubagentSnapshot[]): string {
	if (results.length === 0) return "No subagents.";
	return results.map(formatResult).join("\n\n---\n\n");
}

function formatExpandedResult(result: SubagentSnapshot): string {
	const metadata = formatExpandedMetadata(result);
	const activity = formatActivity(result) || "(no activity yet)";
	let outcome = "";
	if (result.status === "waiting") outcome = `${questionText(result)}\n\nUse subagent_reply with id ${result.id} after deciding the answer.`;
	else if (result.status === "idle" || result.status === "completed") outcome = `#### Output\n\n${truncateOutput(result.output || "(no output)")}`;
	else if (result.error) outcome = `#### Error\n\n${result.error}`;
	return `### ${result.agent} (${result.id}) — ${result.status}\n\n${metadata}\n\n#### Recent activity\n\n\`\`\`text\n${activity}\n\`\`\`${outcome ? `\n\n${outcome}` : ""}`;
}

function formatExpandedResults(results: SubagentSnapshot[]): string {
	if (results.length === 0) return "No subagents.";
	return results.map(formatExpandedResult).join("\n\n---\n\n");
}

function renderSubagentResult(
	result: AgentToolResult<SubagentDetails>,
	{ expanded }: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const details = result.details;
	if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
	if (!expanded) {
		let text = details.results.map((item) => formatRunStatus(item)).join("\n");
		if (details.results.some((item) => item.status === "waiting")) {
			text += `\n${theme.fg("warning", "Supervisor reply required")}`;
		}
		return new Text(text, 0, 0);
	}
	const container = new Container();
	container.addChild(new Text(theme.fg("toolTitle", theme.bold(`subagents · ${progressText(details.results)}`)), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(formatExpandedResults(details.results), 0, 0, getMarkdownTheme()));
	return container;
}

function formatStatusResults(results: SubagentSnapshot[]): string {
	if (results.length === 0) return "No subagents.";
	return results
		.map((result) => {
			const formattedActivity = formatActivity(result);
			const activity = formattedActivity
				? formattedActivity.split("\n").slice(-10).map((line) => `  ${line}`).join("\n")
				: "";
			const details = [formatRunStatus(result), `  cwd: ${result.cwd}`];
			if (result.question) details.push(`  ${questionText(result).replace(/\n/g, "\n  ")}`);
			if (activity) details.push(activity);
			return details.join("\n");
		})
		.join("\n\n");
}

function resultWithUsage(operation: SubagentDetails["operation"], results: SubagentSnapshot[], usage?: UsageTotals) {
	return {
		content: [{ type: "text" as const, text: formatResults(results) }],
		details: { operation, results } satisfies SubagentDetails,
		...(usage && !usageIsEmpty(usage) ? { usage } : {}),
	};
}

function getAutoApproveMode(pi: ExtensionAPI): string {
	let mode: string | undefined;
	pi.events.emit(AUTO_APPROVE_STATE_CHANNEL, {
		respond: (state: { mode?: unknown }) => {
			if (state.mode === "manual" || state.mode === "auto" || state.mode === "yolo") mode = state.mode;
		},
	});
	return mode ?? "manual";
}

function registerChildTool(pi: ExtensionAPI, token: string): void {
	pi.on("cache_warming_decision", () => ({ action: "stop" }));
	pi.registerCommand(SUBAGENT_TASK_COMMAND, {
		description: "Internal managed-subagent task policy update",
		handler: async (args, ctx) => {
			const [providedToken, mode, extra] = args.trim().split(/\s+/);
			if (ctx.mode !== "rpc" || providedToken !== token || extra || !["manual", "auto", "yolo"].includes(mode)) {
				throw new Error("Invalid subagent policy update");
			}
			let applied = false;
			pi.events.emit(AUTO_APPROVE_TASK_CHANNEL, { token, mode, ctx, respond: () => { applied = true; } });
			if (!applied) throw new Error("Subagent approval policy is unavailable");
			ctx.ui.notify(taskPolicyAck(token, mode), "info");
		},
	});
	pi.registerTool({
		name: "ask_supervisor",
		label: "Ask Supervisor",
		description:
			"Pause and ask the parent agent for guidance. Use only when blocked by missing context or a consequential choice. Never use this to request command approval; policy extensions route those requests directly to the user.",
		parameters: SupervisorQuestionParams,
		// Blocking parallel tools prevents another dialog after the parent detaches at this checkpoint.
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "rpc") throw new Error("ask_supervisor is available only in a managed subagent");
			const answer = await ctx.ui.editor(questionTitle(token), JSON.stringify(params));
			if (answer === undefined) throw new Error("Supervisor cancelled the subagent question");
			return {
				content: [{ type: "text", text: `Supervisor replied:\n${answer}` }],
				details: { question: params.question, answer },
			};
		},
	});
}

export default function subagents(pi: ExtensionAPI): void {
	const childRunId = process.env[SUBAGENT_RUN_ID_ENV];
	const childToken = process.env[SUBAGENT_TOKEN_ENV];
	if (childRunId && childToken) {
		registerChildTool(pi, childToken);
		return;
	}

	const discovery = discoverNamedAgents();
	const namedAgents = discovery.agents;
	let catalogListed = false;
	let catalogAvailable = false;
	// Tool calls in one turn can run concurrently; the parent must see the catalog result first.
	pi.on("turn_start", () => { catalogAvailable = catalogListed; });
	let statusContext: ExtensionContext | undefined;
	function refreshStatus(count: number): void {
		if (!statusContext?.hasUI) return;
		statusContext.ui.setStatus(SUBAGENTS_STATUS_KEY, count ? statusContext.ui.theme.fg("dim", `[subagents: ${count} live]`) : undefined);
	}
	const manager = new SubagentManager({
		onLiveCountChange: refreshStatus,
		onAutoApproveStat: (stat) => pi.events.emit(AUTO_APPROVE_STAT_CHANNEL, { stat }),
		onGuidanceRequest: (request, ctx) => requestGuidance(pi, ctx, request),
		onApprovalRequest: (ctx, title, choices) => requestApprovalDialog(pi, ctx, title, choices),
		onStateChange: (runs) => {
			try {
				pi.appendEntry(SUBAGENT_STATE_ENTRY, subagentState(runs));
			} catch (error) {
				// Persistence failures must not prevent child process cleanup.
				const message = `Could not save subagent state: ${error instanceof Error ? error.message : String(error)}`;
				if (statusContext?.hasUI) statusContext.ui.notify(message, "error");
				else console.error(message);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		statusContext = ctx;
		manager.restore(restoreSubagents(ctx.sessionManager.getBranch()));
		refreshStatus(manager.liveCount());
	});

	pi.registerTool({
		name: "list_subagents",
		label: "List Subagents",
		description: "List every discovered named subagent with its full frontmatter description and any discovery errors. Read-only; no model call.",
		promptSnippet: "List named subagents and their selection guidance on demand",
		parameters: Type.Object({}),
		async execute() {
			catalogListed = true;
			return { content: [{ type: "text", text: formatNamedAgentCatalog(discovery) }], details: {} };
		},
	});

	function registerSubagentTool(config: SubagentModelsConfig): void {
		const policy = describeSubagentModelPolicy(config);
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description: `Delegate one task or a concurrent batch to isolated, supervised Pi agents. Call list_subagents before selecting a named agent; general delegation needs no lookup. Each task may select its own cwd, model, and thinking level. The tool returns when each child finishes its task (remaining idle with its context) or asks its supervisor a question. Use subagent_continue for related follow-up tasks and subagent_cancel to end a child. ${policy.text}`,
			promptSnippet: "Delegate substantial, focused work to isolated supervised agents",
			promptGuidelines: [
				"Use subagent only when independent investigation has clear value over startup and context-transfer cost. Work directly on trivial, mechanical, narrowly scoped, or directly verifiable tasks.",
				"Before using subagent for review, inspect the change, identify a concrete risk, and select only specialties that match it. Treat delegation as one checkpoint per logical change.",
				"Call list_subagents before setting subagent.agent or any subagent.tasks[].agent; use the returned descriptions to choose a named agent. General subagents do not need this lookup.",
				"Do not use subagent to repeat a review unless later work materially changes the behavior or risk reviewed. Scope each task to the concrete question and relevant files or functions.",
				"Reuse an idle subagent with subagent_continue for related work so it retains context; use subagent_cancel to end it when finished.",
				"When subagent reports a supervisor question, answer it yourself when existing context is sufficient; otherwise ask the user, then call subagent_reply with their answer.",
				"Subagent runs with a different working directory require direct user approval.",
				"Do not run parallel write-capable subagent tasks in the same worktree unless their changes are explicitly partitioned.",
				...policy.guidelines,
			],
			parameters: SpawnParams,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const hasSingle = typeof params.task === "string";
				const hasBatch = Array.isArray(params.tasks) && params.tasks.length > 0;
				if (Number(hasSingle) + Number(hasBatch) !== 1) {
					throw new Error("Provide exactly one task or one non-empty tasks array");
				}

				const defaults: DispatchDefaults = {
					cwd: ctx.cwd,
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					thinkingLevel: ctx.thinkingLevel,
					autoApproveMode: getAutoApproveMode(pi),
				};
				const inputs: SubagentTaskInput[] = hasBatch
					? params.tasks!
					: [
							{
								task: params.task!,
								agent: params.agent,
								cwd: params.cwd,
								model: params.model,
								thinkingLevel: params.thinkingLevel,
							},
						];
				if (!catalogAvailable && inputs.some((input) => input.agent)) {
					throw new Error("Call list_subagents and read its result before delegating to a named subagent");
				}
				const tasks = inputs.map((input) => resolveSubagentTask(input, defaults, namedAgents));
				const reporter = createProgressReporter(ctx.mode === "tui", "spawn", onUpdate);
				let results: SubagentSnapshot[];
				try {
					results = await manager.start(tasks, ctx.cwd, ctx, reporter.publish, signal);
				} finally {
					reporter.stop();
				}
				return resultWithUsage("spawn", results, manager.consumeUsage(results.map((result) => result.id)));
			},
			renderCall(args, theme) {
				return new Text(
					formatSpawnCall(args, {
						title: (text) => theme.fg("toolTitle", theme.bold(text)),
						accent: (text) => theme.fg("accent", text),
						muted: (text) => theme.fg("muted", text),
					}),
					0,
					0,
				);
			},
			renderResult: renderSubagentResult,
		});
	}
	registerSubagentTool(loadSubagentModels());

	pi.registerTool({
		name: "subagent_continue",
		label: "Continue Subagent",
		description: "Assign a related task to an idle subagent, retaining its process and conversation context. Reuses its agent, model, thinking level, cwd, and tools; inherits the parent's current approval mode and session guidance. Returns at task completion or a supervisor question. Use subagent_reply for waiting questions; ended agents cannot be reused.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, description: "Idle subagent ID" }),
			task: TaskFields.task,
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const reporter = createProgressReporter(ctx.mode === "tui", "continue", onUpdate);
			let result: SubagentSnapshot;
			try {
				result = await manager.continue(params.id, params.task, () => getAutoApproveMode(pi), ctx, reporter.publish, signal);
			} finally {
				reporter.stop();
			}
			return resultWithUsage("continue", [result], manager.consumeUsage([result.id]));
		},
		renderResult: renderSubagentResult,
	});

	pi.registerTool({
		name: "subagent_reply",
		label: "Reply to Subagent",
		description: "Answer a waiting subagent question and run it until completion or its next supervisor question.",
		promptSnippet: "Reply to a waiting supervised subagent",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, description: "Subagent run ID" }),
			answer: Type.String({ minLength: 1, description: "Supervisor's answer" }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const reporter = createProgressReporter(ctx.mode === "tui", "reply", onUpdate);
			let result: SubagentSnapshot;
			try {
				result = await manager.reply(params.id, params.answer, ctx, reporter.publish, signal);
			} finally {
				reporter.stop();
			}
			return resultWithUsage("reply", [result], manager.consumeUsage([result.id]));
		},
		renderResult: renderSubagentResult,
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Inspect one subagent or all agents in the current parent session, including latest-task output, task usage, and lifetime usage totals.",
		parameters: Type.Object({ id: Type.Optional(Type.String({ description: "Run ID; omit to list all" })) }),
		async execute(_toolCallId, params) {
			return resultWithUsage("status", manager.status(params.id));
		},
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Cancel Subagent",
		description: "End one subagent, including an idle one, releasing its process and context. Omit id to end all live subagents. Ended agents cannot be reused.",
		parameters: Type.Object({ id: Type.Optional(Type.String({ description: "Subagent ID; omit to end all live subagents" })) }),
		async execute(_toolCallId, params) {
			return resultWithUsage("cancel", await manager.cancel(params.id));
		},
	});

	pi.registerCommand("subagents", {
		description: "Show subagent status, or /subagents cancel <id|all>",
		handler: async (args, ctx) => {
			const [action, id] = (args ?? "").trim().split(/\s+/, 2);
			if (action === "cancel") {
				const results = await manager.cancel(id && id !== "all" ? id : undefined);
				ctx.ui.notify(formatStatusResults(results), "info");
				return;
			}
			const diagnostics = discovery.errors.length ? `\n\nNamed agent errors:\n${discovery.errors.join("\n")}` : "";
			ctx.ui.notify(`${formatStatusResults(manager.status())}${diagnostics}`, discovery.errors.length ? "warning" : "info");
		},
	});

	pi.registerCommand("subagent-models", {
		description: "Show or set the preferred subagent models for routine, basic, and complex tasks",
		handler: async (args, ctx) => {
			const [slotRaw, action] = (args ?? "").trim().split(/\s+/, 2);
			if (!slotRaw) {
				const config = loadSubagentModels();
				const routine = config.routine ? formatModelRef(config.routine) : "not set (session model)";
				const basic = config.basic ? formatModelRef(config.basic) : "not set (session model)";
				const complex = config.complex ? formatModelRef(config.complex) : "not set (session model)";
				ctx.ui.notify(
					[
						`Basic subagent model: ${basic}`,
						`Routine subagent model: ${routine}`,
						`Complex subagent model: ${complex}`,
						"Use /subagent-models basic|routine|complex to set, /subagent-models basic|routine|complex clear to unset.",
					].join("\n"),
					"info",
				);
				return;
			}
			if (slotRaw !== "routine" && slotRaw !== "basic" && slotRaw !== "complex") {
				ctx.ui.notify("usage: /subagent-models [basic|routine|complex [clear]]", "error");
				return;
			}
			const slot = slotRaw;
			if (action === "clear") {
				clearSubagentModel(slot);
				registerSubagentTool(loadSubagentModels());
				ctx.ui.notify(`subagent-models: ${slot} model cleared`, "info");
				return;
			}
			if (action !== undefined) {
				ctx.ui.notify("usage: /subagent-models [basic|routine|complex [clear]]", "error");
				return;
			}
			const model = await pickSubagentModel(ctx, slot);
			if (!model) return;
			registerSubagentTool(loadSubagentModels());
			ctx.ui.notify(`subagent-models: ${slot} set to ${model.provider}/${model.id}`, "info");
		},
	});

	pi.on("session_shutdown", async () => {
		refreshStatus(0);
		statusContext = undefined;
		await manager.shutdown();
	});
}
