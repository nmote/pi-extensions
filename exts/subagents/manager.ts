import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import {
	type AutoApproveStat,
	isQuestionTitle,
	parseApprovalTitle,
	parseAutoApproveStat,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_TOKEN_ENV,
} from "../shared/subagent-protocol.ts";
import type { ResolvedSubagentTask } from "./agents.ts";
import { type PiInvocation, resolvePiInvocation, RpcProcess } from "./rpc.ts";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MAX_ACTIVITY_ITEMS = 50;
const MAX_RETAINED_RUNS = 32;
const SESSION_ENV_VARS = new Set([
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
]);

export type SubagentStatus = "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface SubagentActivity {
	at: number;
	message: string;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface SupervisorQuestion {
	question: string;
	context?: string;
	options?: string[];
}

export interface SubagentSnapshot {
	id: string;
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	status: SubagentStatus;
	phase: string;
	startedAt: number;
	updatedAt: number;
	question?: SupervisorQuestion;
	output?: string;
	error?: string;
	activity: SubagentActivity[];
	usage: UsageTotals;
}

interface OperationHooks {
	ctx: ExtensionContext;
	onUpdate?: () => void;
}

interface PendingQuestion {
	requestId: string;
	question: SupervisorQuestion;
}

function emptyUsage(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(target: UsageTotals, source: Partial<UsageTotals> | undefined): void {
	if (!source) return;
	target.input += source.input ?? 0;
	target.output += source.output ?? 0;
	target.cacheRead += source.cacheRead ?? 0;
	target.cacheWrite += source.cacheWrite ?? 0;
	target.totalTokens += source.totalTokens ?? 0;
	const cost = source.cost;
	if (!cost) return;
	target.cost.input += cost.input ?? 0;
	target.cost.output += cost.output ?? 0;
	target.cost.cacheRead += cost.cacheRead ?? 0;
	target.cost.cacheWrite += cost.cacheWrite ?? 0;
	target.cost.total += cost.total ?? 0;
}

export function sumUsage(usages: UsageTotals[]): UsageTotals {
	const total = emptyUsage();
	for (const usage of usages) addUsage(total, usage);
	return total;
}

function usageDifference(total: UsageTotals, accounted: UsageTotals): UsageTotals {
	return {
		input: Math.max(0, total.input - accounted.input),
		output: Math.max(0, total.output - accounted.output),
		cacheRead: Math.max(0, total.cacheRead - accounted.cacheRead),
		cacheWrite: Math.max(0, total.cacheWrite - accounted.cacheWrite),
		totalTokens: Math.max(0, total.totalTokens - accounted.totalTokens),
		cost: {
			input: Math.max(0, total.cost.input - accounted.cost.input),
			output: Math.max(0, total.cost.output - accounted.cost.output),
			cacheRead: Math.max(0, total.cost.cacheRead - accounted.cost.cacheRead),
			cacheWrite: Math.max(0, total.cost.cacheWrite - accounted.cost.cacheWrite),
			total: Math.max(0, total.cost.total - accounted.cost.total),
		},
	};
}

function assistantText(message: Record<string, any>): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: Record<string, any>) => part?.type === "text" && typeof part.text === "string")
		.map((part: Record<string, any>) => part.text)
		.join("\n");
}

function createChildEnvironment(runId: string, token: string, cwd: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!SESSION_ENV_VARS.has(key) && value !== undefined) env[key] = value;
	}
	env.PWD = cwd;
	env[SUBAGENT_RUN_ID_ENV] = runId;
	env[SUBAGENT_TOKEN_ENV] = token;
	return env;
}

async function canonicalDirectory(path: string, base: string): Promise<string> {
	const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	const candidate = resolve(base, expanded);
	const info = await stat(candidate).catch(() => undefined);
	if (!info?.isDirectory()) throw new Error(`Subagent working directory is not a directory: ${candidate}`);
	return realpath(candidate);
}

async function verifyCanonicalDirectories(paths: string[], base: string): Promise<void> {
	await Promise.all([...new Set(paths)].map(async (path) => {
		const verified = await canonicalDirectory(path, base);
		if (verified !== path) {
			throw new Error(
				`Working directory changed while starting: ${JSON.stringify(path)} became ${JSON.stringify(verified)}`,
			);
		}
	}));
}

function parseQuestion(prefill: unknown): SupervisorQuestion {
	if (typeof prefill !== "string") return { question: "Subagent requested guidance without a question." };
	try {
		const value = JSON.parse(prefill) as Record<string, unknown>;
		const question = typeof value.question === "string" ? value.question.trim() : "";
		return {
			question: question || "Subagent requested guidance without a question.",
			context: typeof value.context === "string" && value.context.trim() ? value.context.trim() : undefined,
			options: Array.isArray(value.options)
				? value.options.filter((option): option is string => typeof option === "string" && option.trim().length > 0)
				: undefined,
		};
	} catch {
		return { question: prefill };
	}
}

function isDialogRequest(request: RpcExtensionUIRequest): boolean {
	return request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor";
}

function compactPreview(value: unknown, maxLength = 120): string | undefined {
	if (typeof value !== "string") return undefined;
	const compact = value.replace(/\s+/g, " ").trim();
	if (!compact) return undefined;
	return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function formatTaskForApproval(task: string): string {
	return task.split("\n").map((line) => `    ${line}`).join("\n");
}

function toolPhase(toolName: string, args: Record<string, unknown> | undefined): string {
	const subject =
		compactPreview(args?.command) ??
		compactPreview(args?.path) ??
		compactPreview(args?.query) ??
		compactPreview(args?.pattern);
	return subject ? `running ${toolName}: ${subject}` : `running ${toolName}`;
}

class SubagentRun {
	readonly id: string;
	readonly token = randomUUID();
	private rpc?: RpcProcess;
	private promptDir?: string;
	private hooks?: OperationHooks;
	private pendingQuestion?: PendingQuestion;
	private checkpoint?: { promise: Promise<SubagentSnapshot>; resolve: (snapshot: SubagentSnapshot) => void };
	private status: SubagentStatus = "starting";
	private phase = "launching Pi";
	private readonly startedAt = Date.now();
	private updatedAt = this.startedAt;
	private output?: string;
	private error?: string;
	private readonly messages: Record<string, any>[] = [];
	private readonly activity: SubagentActivity[] = [];
	private readonly usage = emptyUsage();
	private accountedUsage = emptyUsage();

	constructor(
		id: string,
		private readonly task: ResolvedSubagentTask,
		private readonly parentCwd: string,
		private readonly invocation: PiInvocation,
		private readonly routeUi: (run: SubagentRun, request: RpcExtensionUIRequest) => Promise<void>,
	) {
		this.id = id;
		this.pushActivity(this.phase);
	}

	get displayName(): string {
		return `${this.task.agent} ${this.id} in ${this.task.cwd}`;
	}

	setHooks(hooks: OperationHooks | undefined): void {
		this.hooks = hooks;
	}

	snapshot(): SubagentSnapshot {
		return {
			id: this.id,
			agent: this.task.agent,
			task: this.task.task,
			cwd: this.task.cwd,
			model: this.task.model,
			thinkingLevel: this.task.thinkingLevel,
			status: this.status,
			phase: this.phase,
			startedAt: this.startedAt,
			updatedAt: this.updatedAt,
			question: this.pendingQuestion?.question,
			output: this.output,
			error: this.error,
			activity: this.activity.map((entry) => ({ ...entry })),
			usage: structuredClone(this.usage),
		};
	}

	consumeUsage(): UsageTotals {
		const delta = usageDifference(this.usage, this.accountedUsage);
		this.accountedUsage = structuredClone(this.usage);
		return delta;
	}

	async start(): Promise<SubagentSnapshot> {
		const checkpoint = this.armCheckpoint();
		try {
			await this.preparePrompt();
			if (this.isCancelled()) {
				await this.cleanupPrompt();
				return checkpoint;
			}
			await verifyCanonicalDirectories([this.parentCwd, this.task.cwd], this.parentCwd);
			if (this.isCancelled()) {
				await this.cleanupPrompt();
				return checkpoint;
			}
			this.rpc = new RpcProcess(
				this.invocation,
				this.task.cwd,
				createChildEnvironment(this.id, this.token, this.task.cwd),
				(event) => this.handleEvent(event),
				(error) => this.handleExit(error),
			);
			await this.rpc.start(this.buildArguments());
			if (this.isCancelled()) {
				await this.rpc.stop();
				await this.cleanupPrompt();
				return checkpoint;
			}
			this.status = "running";
			this.setPhase("starting model");
			this.emitUpdate();
			await this.rpc.send({ type: "prompt", message: `Task: ${this.task.task}` });
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
		}
		return checkpoint;
	}

	async reply(answer: string): Promise<SubagentSnapshot> {
		if (this.status !== "waiting" || !this.pendingQuestion || !this.rpc) {
			throw new Error(`Subagent ${this.id} is not waiting for a supervisor reply`);
		}
		const requestId = this.pendingQuestion.requestId;
		try {
			this.rpc.sendUiResponse({ type: "extension_ui_response", id: requestId, value: answer });
		} catch (error) {
			this.hooks = undefined;
			throw error;
		}
		this.pendingQuestion = undefined;
		this.status = "running";
		this.setPhase("resuming with supervisor answer");
		const checkpoint = this.armCheckpoint();
		this.emitUpdate();
		return checkpoint;
	}

	async cancel(): Promise<SubagentSnapshot> {
		if (!TERMINAL_STATUSES.has(this.status)) {
			this.status = "cancelled";
			this.error = "Cancelled by supervisor";
			this.setPhase("cancelled");
			this.pendingQuestion = undefined;
			this.settleCheckpoint();
		}
		await this.rpc?.stop();
		await this.cleanupPrompt();
		return this.snapshot();
	}

	sendUiResponse(response: Record<string, unknown>): void {
		if (TERMINAL_STATUSES.has(this.status)) return;
		if (!this.rpc) throw new Error("Subagent process is not running");
		try {
			this.rpc.sendUiResponse(response);
		} catch (error) {
			if (!TERMINAL_STATUSES.has(this.status)) throw error;
		}
	}

	currentContext(): ExtensionContext | undefined {
		return this.hooks?.ctx;
	}

	private isCancelled(): boolean {
		return this.status === "cancelled";
	}

	private buildArguments(): string[] {
		const args = ["--mode", "rpc", "--no-session"];
		if (this.task.model) args.push("--model", this.task.model);
		if (this.task.thinkingLevel) args.push("--thinking", this.task.thinkingLevel);
		if (this.task.tools) args.push("--tools", this.task.tools.join(","));
		if (this.task.autoApproveMode) args.push("--auto", this.task.autoApproveMode);
		if (this.promptDir) args.push("--append-system-prompt", join(this.promptDir, "prompt.md"));
		return args;
	}

	private async preparePrompt(): Promise<void> {
		this.promptDir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
		const promptPath = join(this.promptDir, "prompt.md");
		await writeFile(promptPath, this.task.systemPrompt, { mode: 0o600 });
	}

	private async cleanupPrompt(): Promise<void> {
		if (!this.promptDir) return;
		const directory = this.promptDir;
		this.promptDir = undefined;
		await rm(directory, { recursive: true, force: true }).catch(() => {});
	}

	private armCheckpoint(): Promise<SubagentSnapshot> {
		if (this.checkpoint) throw new Error(`Subagent ${this.id} already has a pending checkpoint`);
		let resolveCheckpoint!: (snapshot: SubagentSnapshot) => void;
		const promise = new Promise<SubagentSnapshot>((resolve) => {
			resolveCheckpoint = resolve;
		});
		this.checkpoint = { promise, resolve: resolveCheckpoint };
		return promise;
	}

	private settleCheckpoint(): void {
		const checkpoint = this.checkpoint;
		if (!checkpoint) return;
		this.checkpoint = undefined;
		this.hooks = undefined;
		checkpoint.resolve(this.snapshot());
	}

	private touch(): void {
		this.updatedAt = Date.now();
	}

	private setPhase(phase: string): void {
		this.touch();
		if (this.phase === phase) return;
		this.phase = phase;
		this.pushActivity(phase);
	}

	private pushActivity(message: string): void {
		this.touch();
		this.activity.push({ at: this.updatedAt, message });
		if (this.activity.length > MAX_ACTIVITY_ITEMS) this.activity.shift();
	}

	private emitUpdate(): void {
		this.hooks?.onUpdate?.();
	}

	private async handleEvent(event: Record<string, any>): Promise<void> {
		if (event.type === "extension_ui_request") {
			const request = event as RpcExtensionUIRequest;
			if (request.method === "editor" && isQuestionTitle(request.title, this.token)) {
				this.pendingQuestion = { requestId: request.id, question: parseQuestion(request.prefill) };
				this.status = "waiting";
				this.setPhase("waiting for supervisor");
				this.emitUpdate();
				this.settleCheckpoint();
				return;
			}

			// Only ask_supervisor's exact run-token marker may become model-visible.
			// Every other blocking UI request, including every command approval,
			// is handled directly by the parent user's UI.
			if (isDialogRequest(request)) {
				const approval = "title" in request && parseApprovalTitle(request.title, this.token) !== undefined;
				this.setPhase(approval ? "waiting for user approval" : "waiting for user input");
				this.emitUpdate();
			}
			try {
				await this.routeUi(this, request);
			} finally {
				if (isDialogRequest(request) && this.status === "running") {
					this.setPhase("resuming after user input");
					this.emitUpdate();
				}
			}
			return;
		}

		switch (event.type) {
			case "agent_start":
				this.setPhase("model working");
				break;
			case "turn_start":
				this.setPhase("model thinking");
				break;
			case "message_start":
				if (event.message?.role === "assistant") this.setPhase("model responding");
				else this.touch();
				break;
			case "message_update": {
				const previousPhase = this.phase;
				const streamType = String(event.assistantMessageEvent?.type ?? "");
				if (streamType.startsWith("thinking")) this.setPhase("model thinking");
				else if (streamType.startsWith("toolcall")) this.setPhase("preparing tool call");
				else if (streamType.startsWith("text")) this.setPhase("drafting response");
				else this.touch();
				if (this.phase === previousPhase) return;
				break;
			}
			case "message_end":
				if (event.message) {
					this.messages.push(event.message);
					if (event.message.role === "assistant" || event.message.role === "toolResult") {
						addUsage(this.usage, event.message.usage);
					}
					if (event.message.role === "assistant") {
						const text = assistantText(event.message);
						if (text) this.output = text;
					}
				}
				this.touch();
				break;
			case "tool_execution_start":
				this.setPhase(toolPhase(String(event.toolName), event.args));
				break;
			case "tool_execution_update":
				this.touch();
				return;
			case "tool_execution_end":
				this.setPhase(`${event.isError ? "failed" : "finished"} ${String(event.toolName)}`);
				break;
			case "turn_end":
				this.setPhase(Array.isArray(event.toolResults) && event.toolResults.length ? "processing tool results" : "finishing");
				break;
			case "agent_end":
				this.setPhase("finalizing");
				break;
			case "extension_error":
				this.pushActivity(`extension error: ${String(event.error ?? "unknown")}`);
				break;
			case "agent_settled": {
				const lastAssistant = [...this.messages].reverse().find((message) => message.role === "assistant");
				if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") {
					this.fail(lastAssistant.errorMessage || `Subagent stopped: ${lastAssistant.stopReason}`);
				} else {
					this.status = "completed";
					this.setPhase("completed");
					this.settleCheckpoint();
					void this.rpc?.stop().finally(() => this.cleanupPrompt());
				}
				return;
			}
			default:
				this.touch();
		}
		this.emitUpdate();
	}

	private handleExit(error: Error | undefined): void {
		if (TERMINAL_STATUSES.has(this.status)) return;
		this.fail(error?.message ?? "Subagent process exited before completing");
	}

	private fail(message: string): void {
		if (TERMINAL_STATUSES.has(this.status)) return;
		this.status = "failed";
		this.error = message;
		this.setPhase("failed");
		this.pushActivity(message);
		this.settleCheckpoint();
		const stop = this.rpc?.stop() ?? Promise.resolve();
		void stop.finally(() => this.cleanupPrompt());
	}
}

export interface SubagentManagerOptions {
	invocation?: PiInvocation;
	onAutoApproveStat?: (stat: AutoApproveStat, runId: string) => void;
}

export class SubagentManager {
	private readonly runs = new Map<string, SubagentRun>();
	private readonly invocation: PiInvocation;
	private readonly onAutoApproveStat?: (stat: AutoApproveStat, runId: string) => void;
	private readonly shutdownController = new AbortController();
	private dialogQueue = Promise.resolve();

	constructor(options: SubagentManagerOptions = {}) {
		this.invocation = options.invocation ?? resolvePiInvocation();
		this.onAutoApproveStat = options.onAutoApproveStat;
	}

	async start(
		tasks: ResolvedSubagentTask[],
		parentCwd: string,
		ctx: ExtensionContext,
		onUpdate?: (snapshots: SubagentSnapshot[]) => void,
		signal?: AbortSignal,
	): Promise<SubagentSnapshot[]> {
		const startSignal = signal
			? AbortSignal.any([signal, this.shutdownController.signal])
			: this.shutdownController.signal;
		this.ensureCanStart(startSignal);
		this.pruneRuns();
		const [canonicalParentCwd, canonicalTasks] = await Promise.all([
			canonicalDirectory(parentCwd, parentCwd),
			Promise.all(tasks.map(async (task) => ({ ...task, cwd: await canonicalDirectory(task.cwd, parentCwd) }))),
		]);
		this.ensureCanStart(startSignal);
		await this.approveDifferentWorkingDirectories(canonicalTasks, canonicalParentCwd, ctx, startSignal);
		this.ensureCanStart(startSignal);
		const runs = canonicalTasks.map((task) => {
			const run = new SubagentRun(this.createRunId(), task, canonicalParentCwd, this.invocation, (current, request) =>
				this.enqueueUserUi(current, request),
			);
			this.runs.set(run.id, run);
			return run;
		});
		const update = () => onUpdate?.(runs.map((run) => run.snapshot()));
		for (const run of runs) run.setHooks({ ctx, onUpdate: update });
		update();
		const checkpoints = Promise.all(runs.map((run) => run.start()));
		const abort = () => {
			for (const run of runs) void run.cancel();
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		try {
			return await checkpoints;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	async reply(
		id: string,
		answer: string,
		ctx: ExtensionContext,
		onUpdate?: (snapshots: SubagentSnapshot[]) => void,
		signal?: AbortSignal,
	): Promise<SubagentSnapshot> {
		const run = this.requireRun(id);
		if (signal?.aborted) return run.cancel();
		run.setHooks({ ctx, onUpdate: () => onUpdate?.([run.snapshot()]) });
		const abort = () => void run.cancel();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			return await run.reply(answer);
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	status(id?: string): SubagentSnapshot[] {
		return id ? [this.requireRun(id).snapshot()] : [...this.runs.values()].map((run) => run.snapshot());
	}

	consumeUsage(ids: string[]): UsageTotals {
		return sumUsage(ids.flatMap((id) => {
			const run = this.runs.get(id);
			return run ? [run.consumeUsage()] : [];
		}));
	}

	async cancel(id?: string): Promise<SubagentSnapshot[]> {
		const runs = id ? [this.requireRun(id)] : [...this.runs.values()].filter((run) => !TERMINAL_STATUSES.has(run.snapshot().status));
		return Promise.all(runs.map((run) => run.cancel()));
	}

	async shutdown(): Promise<void> {
		this.shutdownController.abort();
		await Promise.all([...this.runs.values()].map((run) => run.cancel()));
		this.runs.clear();
	}

	private requireRun(id: string): SubagentRun {
		const run = this.runs.get(id);
		if (!run) throw new Error(`Unknown subagent run: ${id}`);
		return run;
	}

	private createRunId(): string {
		let id: string;
		do id = randomUUID().slice(0, 8);
		while (this.runs.has(id));
		return id;
	}

	private pruneRuns(): void {
		const terminal = [...this.runs.entries()].filter(([, run]) => TERMINAL_STATUSES.has(run.snapshot().status));
		for (const [id] of terminal.slice(0, Math.max(0, this.runs.size - MAX_RETAINED_RUNS))) this.runs.delete(id);
	}

	private ensureCanStart(signal: AbortSignal): void {
		if (signal.aborted) throw new Error("Subagent start was cancelled");
	}

	private async approveDifferentWorkingDirectories(
		tasks: ResolvedSubagentTask[],
		parentCwd: string,
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<void> {
		const differentCwdTasks = tasks.filter((task) => task.cwd !== parentCwd);
		if (!differentCwdTasks.length) return;

		const directories = [...new Set(differentCwdTasks.map((task) => task.cwd))];
		const directoryList = directories.map((path) => JSON.stringify(path)).join(", ");
		if (!ctx.hasUI) {
			throw new Error(`Subagent working directory requires user approval, but no user UI is available: ${directoryList}`);
		}

		const requestedRuns = differentCwdTasks
			.map((task) => `- ${task.agent}: ${JSON.stringify(task.cwd)}\n  Task:\n${formatTaskForApproval(task.task)}`)
			.join("\n");
		const confirmed = await this.enqueueDialog(
			() => ctx.ui.confirm(
				"Subagent working directory approval required",
				`Allow ${differentCwdTasks.length === 1 ? "this subagent" : "these subagents"} to use a working directory different from the parent?\n\nParent working directory:\n${JSON.stringify(parentCwd)}\n\nRequested runs:\n${requestedRuns}`,
				{ signal },
			),
			signal,
		);
		if (!confirmed) {
			this.ensureCanStart(signal);
			throw new Error(`Subagent working directory was not approved: ${directoryList}`);
		}
	}

	private async enqueueDialog<T>(open: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) throw new Error("Subagent start was cancelled");
		const route = this.dialogQueue.then(() => {
			if (signal?.aborted) throw new Error("Subagent start was cancelled");
			return open();
		});
		this.dialogQueue = route.then(() => undefined, () => undefined);
		if (!signal) return route;

		let abort!: () => void;
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("Subagent start was cancelled"));
			signal.addEventListener("abort", abort, { once: true });
		});
		try {
			return await Promise.race([route, cancelled]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}

	private async enqueueUserUi(run: SubagentRun, request: RpcExtensionUIRequest): Promise<void> {
		if (!isDialogRequest(request)) return this.routeUserUi(run, request);
		await this.enqueueDialog(() => this.routeUserUi(run, request));
	}

	private async routeUserUi(run: SubagentRun, request: RpcExtensionUIRequest): Promise<void> {
		const ctx = run.currentContext();
		if (!isDialogRequest(request)) {
			if (request.method === "notify") {
				if (typeof request.message !== "string") return;
				const stat = parseAutoApproveStat(request.message, run.token);
				if (stat) {
					this.onAutoApproveStat?.(stat, run.id);
					return;
				}
				if (ctx?.hasUI) {
					ctx.ui.notify(`[subagent ${run.displayName}] ${request.message}`, request.notifyType ?? "info");
				}
			}
			return;
		}

		if (!ctx?.hasUI) {
			run.sendUiResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
			return;
		}

		const rawTitle = "title" in request ? request.title : "Subagent request";
		const approvalTitle = parseApprovalTitle(rawTitle, run.token);
		const title = approvalTitle === undefined
			? `[subagent ${run.displayName}] ${rawTitle}`
			: `[subagent ${run.displayName}] approval required\n\n${approvalTitle}`;
		const uiOptions = {
			...(ctx.signal ? { signal: ctx.signal } : {}),
			...("timeout" in request && request.timeout !== undefined ? { timeout: request.timeout } : {}),
		};

		if (request.method === "select") {
			const value = await ctx.ui.select(title, request.options, uiOptions);
			run.sendUiResponse(
				value === undefined
					? { type: "extension_ui_response", id: request.id, cancelled: true }
					: { type: "extension_ui_response", id: request.id, value },
			);
			return;
		}
		if (request.method === "confirm") {
			const confirmed = await ctx.ui.confirm(title, request.message, uiOptions);
			run.sendUiResponse({ type: "extension_ui_response", id: request.id, confirmed });
			return;
		}
		if (request.method === "input") {
			const value = await ctx.ui.input(title, request.placeholder, uiOptions);
			run.sendUiResponse(
				value === undefined
					? { type: "extension_ui_response", id: request.id, cancelled: true }
					: { type: "extension_ui_response", id: request.id, value },
			);
			return;
		}
		if (request.method !== "editor") return;
		const value = await ctx.ui.editor(title, request.prefill);
		run.sendUiResponse(
			value === undefined
				? { type: "extension_ui_response", id: request.id, cancelled: true }
				: { type: "extension_ui_response", id: request.id, value },
		);
	}
}
