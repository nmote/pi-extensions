import type { Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	completedWorkSince,
	registerSessionTopic,
	restoreTopicState,
	substantiveUserPrompts,
	type SessionTopicDependencies,
} from "./index.ts";
import type { SmallModelConfig } from "../shared/small-model.ts";
import type {
	MetadataFailure,
	PromptSummaryInput,
	PromptSummaryResult,
	TopicInput,
	TopicResult,
} from "./topic.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const topicUsage: Usage = {
	input: 10,
	output: 3,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 13,
	cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};
const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const mainUsage: Usage = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0.05, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
};

interface HarnessOptions {
	config?: SmallModelConfig;
	entries?: SessionEntry[];
	sessionName?: string;
	generate?: SessionTopicDependencies["generateTopic"];
	generateInitialTopic?: SessionTopicDependencies["generateTopic"];
	generatePromptSummary?: SessionTopicDependencies["generatePromptSummary"];
	backlogReferences?: SessionTopicDependencies["backlogReferences"];
	picker?: string | undefined;
	availableModels?: Model<any>[];
	scopedModels?: Model<any>[];
}

function createHarness(options: HarnessOptions = {}) {
	type Handler = (event: any, ctx: ExtensionContext) => any;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const entries = options.entries ?? [];
	const allEntries = [...entries];
	const appended: Array<{ customType: string; data: any }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];
	const widgets = new Map<string, { value: unknown; options?: { placement?: string } }>();
	const generationInputs: TopicInput[] = [];
	const initialTopicInputs: TopicInput[] = [];
	const promptSummaryInputs: PromptSummaryInput[] = [];
	const model = { provider: "test", id: "tiny" } as Model<any>;
	const availableModels = options.availableModels ?? [model];
	let sessionName = options.sessionName;
	const pickerChoices: string[][] = [];
	let pickerCalls = 0;
	let savedModel = "";
	let currentConfig: SmallModelConfig = options.config ?? {};
	let generationCalls = 0;
	let initialTopicCalls = 0;
	let promptSummaryCalls = 0;
	let id = entries.length;
	let ctx: ExtensionContext;

	function pushEntry(entry: SessionEntry): void {
		entries.push(entry);
		if (!allEntries.some((candidate) => candidate.id === entry.id)) allEntries.push(entry);
	}

	async function emit(event: string, value: any): Promise<any> {
		if (event === "turn_end") {
			const entry = entries.find((candidate) => candidate.type === "message" && candidate.message === value.message);
			value = { ...value, messageEntryId: entry?.id, toolResultEntryIds: [] };
		}
		let result: any;
		for (const handler of handlers.get(event) ?? []) {
			const next = await handler(value, ctx);
			if (next !== undefined) result = next;
		}
		if (event === "message_end" && value.message) {
			if (result?.message && result.message !== value.message) {
				for (const key of Object.keys(value.message)) delete value.message[key];
				Object.assign(value.message, result.message);
				result = { ...result, message: value.message };
			}
			pushEntry({
				type: "message",
				id: `message-${++id}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: value.message,
			} as SessionEntry);
		}
		return result;
	}

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, command.handler);
		},
		appendEntry(customType: string, data: any) {
			appended.push({ customType, data });
			pushEntry({
				type: "custom",
				id: `custom-${++id}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				customType,
				data,
			} as SessionEntry);
		},
		getSessionName: () => sessionName,
		setSessionName(name: string) {
			sessionName = name.trim() || undefined;
			pushEntry({
				type: "session_info",
				id: `session-info-${++id}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				name: sessionName,
			} as SessionEntry);
			void emit("session_info_changed", { type: "session_info_changed", name: sessionName });
		},
	} as unknown as ExtensionAPI;

	const dependencies: SessionTopicDependencies = {
		loadConfig: () => currentConfig,
		saveModel: (provider, modelId) => {
			savedModel = `${provider}/${modelId}`;
			currentConfig = { provider, model: modelId };
		},
		generatePromptSummary: async (...args) => {
			promptSummaryCalls++;
			promptSummaryInputs.push(args[2]);
			if (options.generatePromptSummary) return options.generatePromptSummary(...args);
			return {
				promptSummary: `Generated request summary ${promptSummaryCalls}`,
				usage: zeroUsage,
			};
		},
		generateTopic: async (...args) => {
			const input = JSON.parse(JSON.stringify(args[2])) as TopicInput;
			const isInitial =
				input.completedWork.requests.length === 0 &&
				input.completedWork.outcomes.length === 0 &&
				input.completedWork.toolActivity.length === 0;
			if (isInitial) {
				initialTopicCalls++;
				initialTopicInputs.push(input);
				if (options.generateInitialTopic) return options.generateInitialTopic(...args);
				return { topic: "Generated initial topic", usage: zeroUsage };
			}
			generationCalls++;
			generationInputs.push(input);
			if (options.generate) return options.generate(...args);
			return {
				topic: `Generated topic number ${generationCalls}`,
				workSummary: `Cumulative work summary ${generationCalls}`,
				usage: topicUsage,
			};
		},
		backlogReferences: options.backlogReferences ?? (async () => []),
	};

	ctx = {
		mode: "tui",
		hasUI: true,
		scopedModels: (options.scopedModels ?? []).map((scopedModel) => ({ model: scopedModel })),
		ui: {
			select: async (_title: string, choices: string[]) => {
				pickerCalls++;
				pickerChoices.push([...choices]);
				return options.picker === undefined ? "test/tiny" : options.picker;
			},
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			setWidget: (key: string, value: unknown, widgetOptions?: { placement?: string }) => {
				if (value === undefined) widgets.delete(key);
				else widgets.set(key, { value, options: widgetOptions });
			},
			theme: { fg: (_color: string, text: string) => text },
		},
		modelRegistry: {
			getAvailable: () => availableModels,
			hasConfiguredAuth: () => true,
		},
		sessionManager: {
			getEntries: () => allEntries,
			getBranch: () => entries,
			getLeafEntry: () => entries.at(-1),
		},
	} as unknown as ExtensionContext;

	registerSessionTopic(pi, dependencies);

	function renderPromptWidget(width: number): string[] | undefined {
		const widget = widgets.get("session-topic-latest-prompt")?.value;
		if (Array.isArray(widget)) return widget;
		if (typeof widget !== "function") return undefined;
		const factory = widget as (_tui: unknown, theme: unknown) => { render(width: number): string[] };
		return factory({}, ctx.ui.theme).render(width);
	}

	return {
		appended,
		commands,
		ctx,
		emit,
		entries,
		replaceEntries(nextEntries: readonly SessionEntry[]): void {
			entries.splice(0, entries.length, ...nextEntries);
			for (const entry of nextEntries) {
				if (!allEntries.some((candidate) => candidate.id === entry.id)) allEntries.push(entry);
			}
		},
		setSignal(signal: AbortSignal | undefined): void {
			(ctx as { signal?: AbortSignal }).signal = signal;
		},
		setConfig(next: SmallModelConfig): void {
			currentConfig = next;
		},
		generationInputs,
		initialTopicInputs,
		promptSummaryInputs,
		model,
		pickerChoices,
		notifications,
		statuses,
		widgets,
		renderPromptWidget,
		get promptWidgetText() {
			return renderPromptWidget(10_000)?.join("\n");
		},
		get generationCalls() {
			return generationCalls;
		},
		get initialTopicCalls() {
			return initialTopicCalls;
		},
		get promptSummaryCalls() {
			return promptSummaryCalls;
		},
		get pickerCalls() {
			return pickerCalls;
		},
		get savedModel() {
			return savedModel;
		},
		get sessionName() {
			return sessionName;
		},
		async submitUser(text: string): Promise<void> {
			await emit("turn_start", { type: "turn_start", turnIndex: 0 });
			const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
			await emit("message_start", { type: "message_start", message });
			await emit("message_end", { type: "message_end", message });
			await emit("context", { type: "context", messages: [] });
		},
		addToolResult(toolName: string, isError = false): void {
			pushEntry({
				type: "message",
				id: `tool-${++id}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: `call-${id}`,
					toolName,
					content: [{ type: "text", text: isError ? "failed" : "ok" }],
					isError,
					timestamp: Date.now(),
				},
			} as SessionEntry);
		},
		async finishAssistant(
			text: string,
			stopReason: "stop" | "toolUse" | "error" | "aborted" = "stop",
			settle = true,
		) {
			const message = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text }],
				api: "test",
				provider: "main",
				model: "large",
				usage: mainUsage,
				stopReason,
				timestamp: Date.now(),
			};
			const result = await emit("message_end", { type: "message_end", message });
			const finalized = result?.message ?? message;
			if (stopReason !== "toolUse") {
				await emit("turn_end", { type: "turn_end", turnIndex: 0, message: finalized, toolResults: [] });
				if (settle) {
					await emit("agent_settled", { type: "agent_settled" });
					await flushAsync();
				}
			}
			return finalized;
		},
		endTurn(message: object) {
			return emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });
		},
		setManualName(name: string) {
			sessionName = name.trim() || undefined;
			pushEntry({
				type: "session_info",
				id: `session-info-${++id}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				name: sessionName,
			} as SessionEntry);
			return emit("session_info_changed", { type: "session_info_changed", name: sessionName });
		},
	};
}

function stateEntries(harness: ReturnType<typeof createHarness>): any[] {
	return harness.appended.filter((entry) => entry.customType === "session-topic-state").map((entry) => entry.data);
}

async function flushAsync(): Promise<void> {
	for (let index = 0; index < 10; index++) await Promise.resolve();
}

async function expectNonblocking<T>(promise: Promise<T>, label: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error(`${label} blocked on metadata generation`)), 250);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function main(): Promise<void> {
	const imagePrompt = substantiveUserPrompts([
		{
			type: "message",
			id: "image-user",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "user",
				content: [{ type: "image", data: "ignored", mimeType: "image/png" }],
				timestamp: Date.now(),
			},
		} as SessionEntry,
	]);
	check("image-only prompts get a useful summary fallback", imagePrompt[0]?.text === "User attached an image");

	const fullLineWidget = createHarness({
		config: { provider: "test", model: "tiny" },
		generatePromptSummary: () => new Promise<PromptSummaryResult>(() => {}),
	});
	await fullLineWidget.emit("session_start", { type: "session_start", reason: "startup" });
	await fullLineWidget.submitUser(`Use the whole available line before truncating ${"details ".repeat(40)}`);
	const narrowWidget = fullLineWidget.renderPromptWidget(80);
	const wideWidget = fullLineWidget.renderPromptWidget(160);
	check(
		"latest-request truncation uses the full widget width",
		narrowWidget?.length === 1 &&
			wideWidget?.length === 1 &&
			visibleWidth(narrowWidget[0]!) === 80 &&
			visibleWidth(wideWidget[0]!) === 160,
	);

	const completedEntries = [
		{
			type: "message",
			id: "completed-user",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "Implement the parser", timestamp: Date.now() },
		},
		{
			type: "message",
			id: "completed-tool",
			parentId: "completed-user",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "edit",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
		},
	] as SessionEntry[];
	const completed = completedWorkSince(
		completedEntries,
		{ content: [{ type: "text", text: "Implemented and tested the parser." }] },
		undefined,
		false,
	);
	check(
		"completed work includes requests, outcomes, and tool status",
		completed?.completedWork.requests[0] === "Implement the parser" &&
			completed.completedWork.outcomes[0]?.includes("tested") === true &&
			completed.completedWork.toolActivity[0] === "edit: 1 succeeded",
	);
	check(
		"completed checkpoints suppress already summarized work",
		completedWorkSince(completedEntries, { content: "Already done" }, "completed-user", false) === undefined,
	);

	const bridgeEntries = [
		...completedEntries,
		{
			type: "message",
			id: "completed-assistant",
			parentId: "completed-tool",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Implemented and tested the old parser." }],
				api: "test",
				provider: "test",
				model: "test",
				usage: mainUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
		},
		{
			type: "branch_summary",
			id: "branch-summary",
			parentId: "completed-tool",
			timestamp: new Date().toISOString(),
			fromId: "abandoned-branch",
			summary: "The abandoned branch completed a parser experiment.",
		},
		{
			type: "message",
			id: "next-user",
			parentId: "branch-summary",
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "Continue on the selected branch", timestamp: Date.now() },
		},
	] as SessionEntry[];
	const bridged = completedWorkSince(
		bridgeEntries,
		{ content: "Continued on the selected branch." },
		"completed-assistant",
		false,
	);
	check(
		"branch summaries bridge completed-work checkpoints",
		bridged?.completedWork.outcomes.includes("The abandoned branch completed a parser experiment.") === true &&
			bridged.completedWork.outcomes.every((outcome) => !outcome.includes("Implemented and tested")),
	);

	let releasePromptSummary: ((result: PromptSummaryResult) => void) | undefined;
	let releaseAsyncInitialTopic: ((result: TopicResult) => void) | undefined;
	const asynchronousPrompt = createHarness({
		config: { provider: "test", model: "tiny" },
		generateInitialTopic: () =>
			new Promise((resolve) => {
				releaseAsyncInitialTopic = resolve;
			}),
		generatePromptSummary: () =>
			new Promise((resolve) => {
				releasePromptSummary = resolve;
			}),
	});
	await asynchronousPrompt.emit("session_start", { type: "session_start", reason: "startup" });
	await expectNonblocking(
		asynchronousPrompt.submitUser("Summarize this request without delaying the main work"),
		"prompt submission",
	);
	await flushAsync();
	check(
		"prompt submission keeps the fallback while request summarization runs",
		asynchronousPrompt.promptWidgetText?.includes("Summarize this request without delaying") === true,
	);
	check(
		"initial topic generation runs concurrently with request summarization",
		asynchronousPrompt.initialTopicCalls === 1 &&
			releaseAsyncInitialTopic !== undefined &&
			releasePromptSummary !== undefined,
	);
	releaseAsyncInitialTopic?.({ topic: "Immediate empty-work topic", usage: topicUsage });
	await flushAsync();
	check(
		"the initial topic can finish while request summarization remains pending",
		asynchronousPrompt.sessionName === "Immediate empty-work topic" &&
			asynchronousPrompt.promptWidgetText?.includes("Summarize this request without delaying") === true,
	);
	releasePromptSummary?.({ promptSummary: "Summarize requests without delaying work", usage: topicUsage });
	await flushAsync();
	check(
		"asynchronous request summaries replace the fallback",
		asynchronousPrompt.promptWidgetText?.includes("Summarize requests without delaying work") === true,
	);
	const asynchronousAssistant = await asynchronousPrompt.finishAssistant("Completed the asynchronous work.");
	check(
		"prompt metadata usage is charged to the completed response",
		Math.abs(asynchronousAssistant.usage.cost.total - 0.07) < 1e-9 &&
			Math.abs((stateEntries(asynchronousPrompt).at(-1)?.pendingUsage?.cost.total ?? 0) - 0.01) < 1e-9,
	);

	let releaseLateSummary: ((result: PromptSummaryResult) => void) | undefined;
	const lateSummary = createHarness({
		config: { provider: "test", model: "tiny" },
		generatePromptSummary: () =>
			new Promise((resolve) => {
				releaseLateSummary = resolve;
			}),
	});
	await lateSummary.emit("session_start", { type: "session_start", reason: "startup" });
	await expectNonblocking(
		lateSummary.submitUser("Finish before this request summary returns"),
		"late-summary prompt submission",
	);
	await flushAsync();
	const beforeLateSummary = await lateSummary.finishAssistant("Finished before the request summary.");
	check("unfinished request summaries do not delay completion", Math.abs(beforeLateSummary.usage.cost.total - 0.05) < 1e-9);
	releaseLateSummary?.({ promptSummary: "Finish before request summarization completes", usage: topicUsage });
	await flushAsync();
	check(
		"late request summaries and their usage are persisted",
		lateSummary.promptWidgetText?.includes("Finish before request summarization completes") === true &&
			stateEntries(lateSummary).at(-1)?.pendingUsage !== undefined,
	);
	await lateSummary.submitUser("Thanks");
	const chargedLateSummary = await lateSummary.finishAssistant("You're welcome.");
	const afterLateSummary = await lateSummary.finishAssistant("No additional charge.");
	check(
		"late request-summary usage is charged exactly once",
		Math.abs(chargedLateSummary.usage.cost.total - 0.07) < 1e-9 &&
			Math.abs(afterLateSummary.usage.cost.total - 0.05) < 1e-9,
	);

	const summaryResolvers = new Map<string, (result: PromptSummaryResult) => void>();
	let releaseInitialTopic: ((result: TopicResult) => void) | undefined;
	const outOfOrder = createHarness({
		config: { provider: "test", model: "tiny" },
		generateInitialTopic: () =>
			new Promise((resolve) => {
				releaseInitialTopic = resolve;
			}),
		generatePromptSummary: (_model, _ctx, input) =>
			new Promise((resolve) => {
				summaryResolvers.set(input.latestPrompt, resolve);
			}),
	});
	await outOfOrder.emit("session_start", { type: "session_start", reason: "startup" });
	await expectNonblocking(
		outOfOrder.submitUser("First request whose summary finishes last"),
		"first out-of-order prompt submission",
	);
	await expectNonblocking(
		outOfOrder.submitUser("Second request whose summary finishes first"),
		"second out-of-order prompt submission",
	);
	await flushAsync();
	releaseInitialTopic?.({ topic: "Stale first request topic", usage: topicUsage });
	summaryResolvers.get("Second request whose summary finishes first")?.({
		promptSummary: "Handle the second request first",
		usage: topicUsage,
	});
	await flushAsync();
	summaryResolvers.get("First request whose summary finishes last")?.({
		promptSummary: "Handle the first request last",
		usage: topicUsage,
	});
	await flushAsync();
	check(
		"stale first-prompt metadata cannot replace newer request state",
		outOfOrder.sessionName === undefined &&
			outOfOrder.promptWidgetText?.includes("Handle the second request first") === true,
	);
	const outOfOrderAssistant = await outOfOrder.finishAssistant("Completed both queued requests.");
	check(
		"canceled stale metadata is not charged",
		Math.abs(outOfOrderAssistant.usage.cost.total - 0.06) < 1e-9,
	);

	let branchSummarySignal: AbortSignal | undefined;
	let branchTopicSignal: AbortSignal | undefined;
	let releaseBranchSummary: ((result: PromptSummaryResult) => void) | undefined;
	let releaseBranchTopic: ((result: TopicResult) => void) | undefined;
	const branchCancellation = createHarness({
		config: { provider: "test", model: "tiny" },
		generatePromptSummary: (_model, _ctx, _prompt, signal) => {
			branchSummarySignal = signal;
			return new Promise((resolve) => {
				releaseBranchSummary = resolve;
			});
		},
		generateInitialTopic: (_model, _ctx, _input, signal) => {
			branchTopicSignal = signal;
			return new Promise((resolve) => {
				releaseBranchTopic = resolve;
			});
		},
	});
	await branchCancellation.emit("session_start", { type: "session_start", reason: "startup" });
	await expectNonblocking(
		branchCancellation.submitUser("Start metadata on the old branch"),
		"old-branch prompt submission",
	);
	await flushAsync();
	branchCancellation.replaceEntries([]);
	await branchCancellation.emit("session_tree", { type: "session_tree" });
	check(
		"tree navigation immediately aborts old-branch metadata",
		branchSummarySignal?.aborted === true && branchTopicSignal?.aborted === true,
	);
	releaseBranchSummary?.({ promptSummary: "Stale old-branch summary", usage: topicUsage });
	releaseBranchTopic?.({ topic: "Stale old branch topic", usage: topicUsage });
	await flushAsync();
	check(
		"tree navigation cancels asynchronous metadata from the old branch",
		branchSummarySignal?.aborted === true &&
			branchTopicSignal?.aborted === true &&
			branchCancellation.sessionName === undefined &&
			branchCancellation.promptWidgetText === undefined &&
			stateEntries(branchCancellation).at(-1)?.pendingUsage === undefined,
	);

	let abortedSummarySignal: AbortSignal | undefined;
	let abortedTopicSignal: AbortSignal | undefined;
	let releaseAbortedSummary: ((result: PromptSummaryResult) => void) | undefined;
	let releaseAbortedTopic: ((result: TopicResult) => void) | undefined;
	const abortedMetadata = createHarness({
		config: { provider: "test", model: "tiny" },
		generatePromptSummary: (_model, _ctx, _prompt, signal) => {
			abortedSummarySignal = signal;
			return new Promise((resolve) => {
				releaseAbortedSummary = resolve;
			});
		},
		generateInitialTopic: (_model, _ctx, _input, signal) => {
			abortedTopicSignal = signal;
			return new Promise((resolve) => {
				releaseAbortedTopic = resolve;
			});
		},
	});
	const agentAbort = new AbortController();
	abortedMetadata.setSignal(agentAbort.signal);
	await abortedMetadata.emit("session_start", { type: "session_start", reason: "startup" });
	await expectNonblocking(
		abortedMetadata.submitUser("Cancel metadata with the active agent turn"),
		"aborted prompt submission",
	);
	await flushAsync();
	agentAbort.abort();
	check(
		"agent cancellation immediately aborts prompt metadata",
		abortedSummarySignal?.aborted === true && abortedTopicSignal?.aborted === true,
	);
	releaseAbortedSummary?.({ promptSummary: "Stale aborted summary", usage: topicUsage });
	releaseAbortedTopic?.({ topic: "Stale aborted topic", usage: topicUsage });
	await flushAsync();
	check(
		"agent cancellation aborts asynchronous prompt metadata",
		abortedSummarySignal?.aborted === true &&
			abortedTopicSignal?.aborted === true &&
			abortedMetadata.sessionName === undefined &&
			abortedMetadata.promptWidgetText?.includes("Cancel metadata with the active") === true &&
			abortedMetadata.statuses.at(-1) === undefined &&
			stateEntries(abortedMetadata).at(-1)?.pendingUsage === undefined,
	);

	let retrySummarySignal: AbortSignal | undefined;
	let retryTopicSignal: AbortSignal | undefined;
	let releaseRetrySummary: ((result: PromptSummaryResult) => void) | undefined;
	let releaseRetryTopic: ((result: TopicResult) => void) | undefined;
	const retryAbort = createHarness({
		config: { provider: "test", model: "tiny" },
		generatePromptSummary: (_model, _ctx, _prompt, signal) => {
			retrySummarySignal = signal;
			return new Promise((resolve) => {
				releaseRetrySummary = resolve;
			});
		},
		generateInitialTopic: (_model, _ctx, _input, signal) => {
			retryTopicSignal = signal;
			return new Promise((resolve) => {
				releaseRetryTopic = resolve;
			});
		},
	});
	const firstAttempt = new AbortController();
	retryAbort.setSignal(firstAttempt.signal);
	await retryAbort.emit("session_start", { type: "session_start", reason: "startup" });
	await expectNonblocking(
		retryAbort.submitUser("Keep metadata associated with every retry attempt"),
		"retried prompt submission",
	);
	await flushAsync();
	const retryAttempt = new AbortController();
	retryAbort.setSignal(retryAttempt.signal);
	await retryAbort.emit("agent_start", { type: "agent_start" });
	retryAttempt.abort();
	check(
		"canceling a retry immediately aborts original prompt metadata",
		retrySummarySignal?.aborted === true && retryTopicSignal?.aborted === true,
	);
	releaseRetrySummary?.({ promptSummary: "Stale retry summary", usage: topicUsage });
	releaseRetryTopic?.({ topic: "Stale retry topic", usage: topicUsage });
	await flushAsync();
	check(
		"metadata from an aborted retry cannot change session state",
		retryAbort.sessionName === undefined && stateEntries(retryAbort).at(-1)?.pendingUsage === undefined,
	);

	let settledSummarySignal: AbortSignal | undefined;
	let settledTopicSignal: AbortSignal | undefined;
	let releaseSettledSummary: ((result: PromptSummaryResult) => void) | undefined;
	let releaseSettledTopic: ((result: TopicResult) => void) | undefined;
	const settledAbort = createHarness({
		config: { provider: "test", model: "tiny" },
		generatePromptSummary: (_model, _ctx, _prompt, signal) => {
			settledSummarySignal = signal;
			return new Promise((resolve) => {
				releaseSettledSummary = resolve;
			});
		},
		generateInitialTopic: (_model, _ctx, _input, signal) => {
			settledTopicSignal = signal;
			return new Promise((resolve) => {
				releaseSettledTopic = resolve;
			});
		},
	});
	await settledAbort.emit("session_start", { type: "session_start", reason: "startup" });
	await expectNonblocking(
		settledAbort.submitUser("Keep metadata pending through a retryable attempt"),
		"retryable prompt submission",
	);
	await flushAsync();
	await settledAbort.finishAssistant("The retried task was canceled.", "aborted");
	check(
		"settlement immediately aborts metadata for a canceled run",
		settledSummarySignal?.aborted === true && settledTopicSignal?.aborted === true,
	);
	releaseSettledSummary?.({ promptSummary: "Stale retried summary", usage: topicUsage });
	releaseSettledTopic?.({ topic: "Stale retried topic", usage: topicUsage });
	await flushAsync();
	check(
		"settled aborted runs cancel metadata started by an earlier attempt",
		settledSummarySignal?.aborted === true &&
			settledTopicSignal?.aborted === true &&
			settledAbort.sessionName === undefined &&
			settledAbort.statuses.at(-1) === undefined &&
			stateEntries(settledAbort).at(-1)?.pendingUsage === undefined,
	);

	const cancelledPicker = createHarness({ picker: "" });
	await cancelledPicker.emit("session_start", { type: "session_start", reason: "startup" });
	await cancelledPicker.submitUser("Cancel metadata model selection once");
	await flushAsync();
	await cancelledPicker.finishAssistant("Completed without a metadata model.");
	check("a canceled picker is not reopened after the same task", cancelledPicker.pickerCalls === 1);
	await cancelledPicker.submitUser("Retry model selection for a later request");
	await flushAsync();
	check("a later request may reopen the canceled picker", cancelledPicker.pickerCalls === 2);

	const queuedFollowup = createHarness({ config: { provider: "test", model: "tiny" } });
	await queuedFollowup.emit("session_start", { type: "session_start", reason: "startup" });
	await queuedFollowup.submitUser("Complete the first queued request");
	await queuedFollowup.finishAssistant("Completed the first queued request.", "stop", false);
	check("queued follow-ups do not roll up intermediate turns", queuedFollowup.generationCalls === 0);
	await queuedFollowup.submitUser("Complete the second queued request");
	await queuedFollowup.emit("agent_start", { type: "agent_start" });
	await queuedFollowup.finishAssistant("Completed the second queued request.");
	check(
		"settlement rolls up every queued turn together",
		queuedFollowup.generationCalls === 1 &&
			JSON.stringify(queuedFollowup.generationInputs[0]?.completedWork.requests) ===
				JSON.stringify(["Complete the first queued request", "Complete the second queued request"]) &&
			JSON.stringify(queuedFollowup.generationInputs[0]?.completedWork.outcomes) ===
				JSON.stringify(["Completed the first queued request.", "Completed the second queued request."]),
	);

	const abortedFollowup = createHarness({ config: { provider: "test", model: "tiny" } });
	await abortedFollowup.emit("session_start", { type: "session_start", reason: "startup" });
	await abortedFollowup.submitUser("Complete work before the queued abort");
	await abortedFollowup.finishAssistant("Completed work before the queued abort.", "stop", false);
	await abortedFollowup.submitUser("Abort the queued continuation");
	await abortedFollowup.emit("agent_start", { type: "agent_start" });
	await abortedFollowup.finishAssistant("The queued continuation was aborted.", "aborted");
	const abortedFollowupLatestUser = abortedFollowup.entries
		.filter((entry) => entry.type === "message" && entry.message.role === "user")
		.at(-1);
	check(
		"an aborted queued continuation still rolls up earlier completed work",
		abortedFollowup.generationCalls === 1 &&
			JSON.stringify(abortedFollowup.generationInputs[0]?.completedWork.requests) ===
				JSON.stringify(["Complete work before the queued abort"]) &&
			JSON.stringify(abortedFollowup.generationInputs[0]?.completedWork.outcomes) ===
				JSON.stringify(["Completed work before the queued abort."]) &&
			stateEntries(abortedFollowup).at(-1)?.latestPromptId === abortedFollowupLatestUser?.id,
	);

	const terminalFollowup = createHarness({ config: { provider: "test", model: "tiny" } });
	await terminalFollowup.emit("session_start", { type: "session_start", reason: "startup" });
	await terminalFollowup.submitUser("Complete work with a terminating tool");
	const queuedTerminalAssistant = await terminalFollowup.finishAssistant("Applying the completed change.", "toolUse");
	terminalFollowup.addToolResult("edit");
	await terminalFollowup.endTurn(queuedTerminalAssistant);
	const queuedTerminalResult = terminalFollowup.entries.at(-1);
	await terminalFollowup.emit("agent_end", {
		type: "agent_end",
		messages: [
			queuedTerminalAssistant,
			...(queuedTerminalResult?.type === "message" ? [queuedTerminalResult.message] : []),
		],
	});
	await terminalFollowup.submitUser("Abort the continuation after the terminating tool");
	await terminalFollowup.emit("agent_start", { type: "agent_start" });
	await terminalFollowup.finishAssistant("The continuation was aborted.", "aborted");
	check(
		"an aborted continuation retains earlier terminating-tool work",
		terminalFollowup.generationCalls === 1 &&
			JSON.stringify(terminalFollowup.generationInputs[0]?.completedWork.requests) ===
				JSON.stringify(["Complete work with a terminating tool"]) &&
			JSON.stringify(terminalFollowup.generationInputs[0]?.completedWork.toolActivity) ===
				JSON.stringify(["edit: 1 succeeded"]),
	);

	const lifecycle = createHarness();
	await lifecycle.emit("session_start", { type: "session_start", reason: "startup" });
	await lifecycle.submitUser("Add automatic session topics to Pi");
	check(
		"prompt submission immediately shows a request fallback",
		lifecycle.promptWidgetText?.includes("Add automatic session topics") === true,
	);
	await flushAsync();
	check(
		"the first prompt starts request-summary and empty-work topic generation",
		lifecycle.promptSummaryCalls === 1 &&
			lifecycle.initialTopicCalls === 1 &&
			lifecycle.initialTopicInputs[0]?.workSummary === undefined &&
			lifecycle.initialTopicInputs[0]?.latestPrompt === "Add automatic session topics to Pi" &&
			lifecycle.initialTopicInputs[0]?.completedWork.requests.length === 0,
	);
	check("the first topic is applied before work completes", lifecycle.sessionName === "Generated initial topic");
	check("concurrent first-prompt requests share one model picker", lifecycle.pickerCalls === 1);
	check("selected model is persisted", lifecycle.savedModel === "test/tiny");
	const firstAssistant = await lifecycle.finishAssistant("Implemented automatic topics and verified their tests.");
	check("completed work updates the initial topic", lifecycle.sessionName === "Generated topic number 1");
	check(
		"generated request summary appears below the editor",
		lifecycle.promptWidgetText?.includes("Generated request summary 1") === true &&
			lifecycle.widgets.get("session-topic-latest-prompt")?.options?.placement === "belowEditor",
	);
	check(
		"cumulative work and completion checkpoint are persisted",
		stateEntries(lifecycle).some(
			(state) =>
				state.workSummary === "Cumulative work summary 1" &&
				state.lastCompletedEntryId?.startsWith("message-"),
		),
	);
	const completedAssistantIndex = lifecycle.entries.findIndex(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			JSON.stringify(entry.message.content).includes("Implemented automatic topics"),
	);
	const completedStateIndex = lifecycle.entries.findIndex(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "session-topic-state" &&
			(entry.data as any)?.workSummary === "Cumulative work summary 1",
	);
	check(
		"completed-work state follows the assistant entry it summarizes",
		completedAssistantIndex >= 0 && completedStateIndex > completedAssistantIndex,
	);
	check("completed metadata cost is deferred", Math.abs(firstAssistant.usage.cost.total - 0.05) < 1e-9);
	check("topic tokens do not inflate main context usage", firstAssistant.usage.totalTokens === 120);
	check("completed metadata leaves deferred usage", stateEntries(lifecycle).at(-1)?.pendingUsage !== undefined);

	await lifecycle.submitUser("Looks good");
	const acknowledgement = await lifecycle.finishAssistant("Thanks.");
	check(
		"acknowledgements retain the latest substantive request and charge deferred usage once",
		lifecycle.generationCalls === 1 &&
			lifecycle.promptWidgetText?.includes("Generated request summary 1") === true &&
			Math.abs(acknowledgement.usage.cost.total - 0.06) < 1e-9 &&
			stateEntries(lifecycle).at(-1)?.pendingUsage === undefined,
	);

	await lifecycle.submitUser("Review the automatic topic behavior in detail");
	await lifecycle.finishAssistant("Reviewed the lifecycle and identified the relevant behavior.");
	check("later completed work updates the topic without a confirmation gate", lifecycle.sessionName === "Generated topic number 2");
	check(
		"later generation receives the prior cumulative summary",
		lifecycle.generationInputs[1]?.workSummary === "Cumulative work summary 1",
	);
	check(
		"later generation excludes outcomes before its completion checkpoint",
		lifecycle.generationInputs[1]?.completedWork.outcomes.length === 1 &&
			lifecycle.generationInputs[1]?.completedWork.outcomes[0]?.startsWith("Reviewed"),
	);

	await lifecycle.submitUser("Edit the implementation and run its checks");
	const toolUseAssistant = await lifecycle.finishAssistant("Calling tools", "toolUse");
	lifecycle.addToolResult("edit");
	lifecycle.addToolResult("bash", true);
	await lifecycle.endTurn(toolUseAssistant);
	check("tool-use assistant messages do not generate metadata", lifecycle.generationCalls === 2);
	await lifecycle.finishAssistant("Updated the implementation; the first check exposed a failure.");
	check(
		"final completion includes tool outcomes",
		lifecycle.generationCalls === 3 &&
			lifecycle.generationInputs[2]?.completedWork.toolActivity.includes("edit: 1 succeeded") === true &&
			lifecycle.generationInputs[2]?.completedWork.toolActivity.includes("bash: 1 failed") === true,
	);

	const terminalTool = createHarness({ config: { provider: "test", model: "tiny" } });
	await terminalTool.emit("session_start", { type: "session_start", reason: "startup" });
	await terminalTool.submitUser("Proceed with the implementation");
	const terminalAssistant = await terminalTool.finishAssistant("Applying the change", "toolUse");
	terminalTool.addToolResult("edit");
	await terminalTool.endTurn(terminalAssistant);
	await terminalTool.emit("agent_settled", { type: "agent_settled" });
	await flushAsync();
	check(
		"terminating tool turns update cumulative metadata after settling",
		terminalTool.generationCalls === 1 &&
			terminalTool.sessionName === "Generated topic number 1" &&
			JSON.stringify(terminalTool.generationInputs[0]?.completedWork.toolActivity) ===
				JSON.stringify(["edit: 1 succeeded"]) &&
			stateEntries(terminalTool).at(-1)?.lastCompletedEntryId?.startsWith("tool-"),
	);
	check("terminating tool metadata cost is deferred", stateEntries(terminalTool).at(-1)?.pendingUsage !== undefined);
	await terminalTool.submitUser("Thanks");
	const chargedAfterTerminal = await terminalTool.finishAssistant("You're welcome.");
	check(
		"deferred terminating-tool cost is charged once",
		Math.abs(chargedAfterTerminal.usage.cost.total - 0.06) < 1e-9 &&
			stateEntries(terminalTool).at(-1)?.pendingUsage === undefined,
	);

	await lifecycle.setManualName("Manual session name");
	await lifecycle.submitUser("Change the implementation approach substantially");
	await lifecycle.finishAssistant("Changed the implementation approach and updated tests.");
	check(
		"manual names disable topic updates but retain cumulative metadata",
		lifecycle.generationCalls === 4 &&
			lifecycle.sessionName === "Manual session name" &&
			lifecycle.promptWidgetText?.includes("Generated request summary 4") === true &&
			stateEntries(lifecycle).at(-1)?.workSummary === "Cumulative work summary 4",
	);

	await lifecycle.commands.get("topic")!("auto", lifecycle.ctx);
	await lifecycle.submitUser("Review the revised topic implementation");
	await lifecycle.finishAssistant("Reviewed the revised implementation.");
	check("topic auto resumes updates", lifecycle.sessionName === "Generated topic number 5");

	await lifecycle.commands.get("topic")!("refresh", lifecycle.ctx);
	check("refresh waits for a completed turn", lifecycle.generationCalls === 5);
	await lifecycle.submitUser("Refresh the topic from the whole session");
	check("refresh still waits after prompt submission", lifecycle.generationCalls === 5);
	await lifecycle.finishAssistant("Refreshed the session metadata design.");
	check("scheduled refresh runs after completion", lifecycle.generationCalls === 6);
	check(
		"refresh backfills the whole session",
		lifecycle.generationInputs[5]?.completedWork.requests[0]?.startsWith("Add automatic") === true &&
			lifecycle.generationInputs[5]!.completedWork.requests.length > 2,
	);
	check("normal operation emits no warnings or errors", lifecycle.notifications.every(({ level }) => level === "info"));

	const refreshEntries = [
		{
			type: "message",
			id: "refresh-user-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "Earlier completed refresh work", timestamp: Date.now() },
		},
		{
			type: "message",
			id: "refresh-assistant-1",
			parentId: "refresh-user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Completed the earlier refresh work." }],
				api: "test",
				provider: "test",
				model: "test",
				usage: mainUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
		},
		{
			type: "custom",
			id: "refresh-state-1",
			parentId: "refresh-assistant-1",
			timestamp: new Date().toISOString(),
			customType: "session-topic-state",
			data: {
				auto: true,
				generatedTopic: "Existing refresh topic",
				latestPromptId: "refresh-user-1",
				lastCompletedEntryId: "refresh-assistant-1",
				latestPromptSummary: "Complete earlier refresh work",
				workSummary: "Completed earlier refresh work.",
			},
		},
	] as SessionEntry[];
	let refreshAttempts = 0;
	const refreshRetry = createHarness({
		entries: refreshEntries,
		sessionName: "Existing refresh topic",
		config: { provider: "test", model: "tiny" },
		generate: async () => {
			refreshAttempts++;
			if (refreshAttempts === 1) return { topic: "Invalid refresh result topic", usage: topicUsage };
			return {
				topic: "Recovered whole session refresh",
				workSummary: "Rebuilt the summary from the whole session.",
				usage: topicUsage,
			};
		},
	});
	await refreshRetry.emit("session_start", { type: "session_start", reason: "resume" });
	await refreshRetry.commands.get("topic")!("refresh", refreshRetry.ctx);
	await refreshRetry.submitUser("First refresh attempt");
	await refreshRetry.finishAssistant("The first metadata response was invalid.");
	await refreshRetry.submitUser("Retry the requested refresh");
	await refreshRetry.finishAssistant("The whole-session refresh succeeded.");
	check(
		"failed refreshes retain whole-session behavior for the next attempt",
		refreshRetry.generationInputs[1]?.completedWork.requests[0] === "Earlier completed refresh work" &&
			refreshRetry.sessionName === "Recovered whole session refresh",
	);

	let canceledRefreshAttempt = 0;
	let releaseCanceledRefresh: ((result: TopicResult) => void) | undefined;
	const canceledRefresh = createHarness({
		entries: refreshEntries.slice(0, 3),
		sessionName: "Existing refresh topic",
		config: { provider: "test", model: "tiny" },
		generate: () => {
			canceledRefreshAttempt++;
			if (canceledRefreshAttempt === 1) {
				return new Promise((resolve) => {
					releaseCanceledRefresh = resolve;
				});
			}
			return Promise.resolve({
				topic: "Recovered canceled refresh",
				workSummary: "Recovered the canceled whole-session refresh.",
				usage: topicUsage,
			});
		},
	});
	await canceledRefresh.emit("session_start", { type: "session_start", reason: "resume" });
	await canceledRefresh.commands.get("topic")!("refresh", canceledRefresh.ctx);
	await canceledRefresh.submitUser("Start the refresh that will be canceled");
	await canceledRefresh.finishAssistant("Completed work before refresh cancellation.");
	await canceledRefresh.submitUser("Replace the canceled refresh");
	await canceledRefresh.emit("agent_start", { type: "agent_start" });
	await canceledRefresh.finishAssistant("Completed the replacement refresh.");
	check(
		"a replacement preserves whole-session refresh scope",
		JSON.stringify(canceledRefresh.generationInputs[1]?.completedWork.requests) ===
			JSON.stringify([
				"Earlier completed refresh work",
				"Start the refresh that will be canceled",
				"Replace the canceled refresh",
			]) && canceledRefresh.sessionName === "Recovered canceled refresh",
	);
	releaseCanceledRefresh?.({
		topic: "Stale canceled refresh",
		workSummary: "Stale canceled refresh summary.",
		usage: topicUsage,
	});
	await flushAsync();
	await canceledRefresh.submitUser("Resume incremental updates");
	await canceledRefresh.emit("agent_start", { type: "agent_start" });
	await canceledRefresh.finishAssistant("Completed the incremental update.");
	check(
		"successful replacement clears refresh scope",
		JSON.stringify(canceledRefresh.generationInputs[2]?.completedWork.requests) ===
			JSON.stringify(["Resume incremental updates"]),
	);

	const scopedModel = { provider: "test", id: "scoped" } as Model<any>;
	const unscopedModel = { provider: "other", id: "unscoped" } as Model<any>;
	const unrestrictedPicker = createHarness({
		availableModels: [scopedModel, unscopedModel],
		scopedModels: [scopedModel],
		picker: "other/unscoped",
	});
	await unrestrictedPicker.emit("session_start", { type: "session_start", reason: "startup" });
	await unrestrictedPicker.submitUser("Choose a topic model outside the main session scope");
	await unrestrictedPicker.finishAssistant("Selected an independently scoped metadata model.");
	check(
		"topic picker includes models outside the session scope",
		unrestrictedPicker.pickerChoices[0]?.includes("other/unscoped") === true &&
			unrestrictedPicker.savedModel === "other/unscoped",
	);

	const summaryModels: string[] = [];
	const externalChange = createHarness({
		availableModels: [
			{ provider: "test", id: "tiny" } as Model<any>,
			{ provider: "other", id: "unscoped" } as Model<any>,
		],
		config: { provider: "other", model: "unscoped" },
		generatePromptSummary: async (model) => {
			summaryModels.push(`${model.provider}/${model.id}`);
			return { promptSummary: "summary", usage: zeroUsage };
		},
	});
	await externalChange.emit("session_start", { type: "session_start", reason: "startup" });
	await externalChange.submitUser("Summarize with the initially loaded model");
	await flushAsync();
	externalChange.setConfig({ provider: "test", model: "tiny" });
	await externalChange.submitUser("Summarize after another consumer changed the model");
	await flushAsync();
	check(
		"a mid-session model change is picked up without re-prompting",
		externalChange.pickerCalls === 0 && summaryModels.join(",") === "other/unscoped,test/tiny",
	);

	const historicalEntries = [
		{
			type: "message",
			id: "history-user-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "First historical task", timestamp: Date.now() },
		},
		{
			type: "message",
			id: "history-assistant-1",
			parentId: "history-user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Completed the first historical task." }],
				api: "test",
				provider: "test",
				model: "test",
				usage: mainUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
		},
		{
			type: "custom",
			id: "legacy-state",
			parentId: "history-assistant-1",
			timestamp: new Date().toISOString(),
			customType: "session-topic-state",
			data: {
				auto: true,
				generatedTopic: "Existing generated topic",
				latestPromptSummary: "Complete the first historical task",
				lastProcessedUserId: "history-user-1",
			},
		},
	] as SessionEntry[];
	const backfill = createHarness({
		entries: historicalEntries,
		sessionName: "Existing generated topic",
		config: { provider: "test", model: "tiny" },
	});
	await backfill.emit("session_start", { type: "session_start", reason: "resume" });
	await backfill.submitUser("Complete the latest task after resume");
	await backfill.finishAssistant("Completed the latest resumed task.");
	check(
		"legacy states bootstrap cumulative completed work",
		backfill.generationInputs[0]?.completedWork.requests.length === 2 &&
			backfill.generationInputs[0]?.completedWork.outcomes.some((outcome) => outcome.includes("first historical")) === true,
	);
	check("persisted model bypasses the picker", backfill.pickerCalls === 0);
	check("migrated snapshots contain cumulative state", stateEntries(backfill).at(-1)?.workSummary === "Cumulative work summary 1");

	const legacyPendingEntries = [
		{
			type: "custom",
			id: "state-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "session-topic-state",
			data: { auto: true, generatedTopic: "Existing generated topic", pendingUsage: topicUsage },
		},
	] as SessionEntry[];
	const resumed = createHarness({ entries: legacyPendingEntries, sessionName: "Existing generated topic" });
	await resumed.emit("session_start", { type: "session_start", reason: "resume" });
	const resumedAssistant = await resumed.finishAssistant("No new task to summarize.");
	const secondAssistant = await resumed.finishAssistant("Still no new task.");
	check(
		"legacy pending cost is restored and accounted once",
		Math.abs(resumedAssistant.usage.cost.total - 0.06) < 1e-9 && Math.abs(secondAssistant.usage.cost.total - 0.05) < 1e-9,
	);
	check("legacy pending usage is cleared in current state", restoreTopicState(resumed.entries)?.pendingUsage === undefined);

	const combinedUsageEntries = [
		{
			type: "message",
			id: "pending-user",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "Summarize pending completed work", timestamp: Date.now() },
		},
		{
			type: "custom",
			id: "pending-state",
			parentId: "pending-user",
			timestamp: new Date().toISOString(),
			customType: "session-topic-state",
			data: { auto: true, pendingUsage: topicUsage },
		},
	] as SessionEntry[];
	const combinedUsage = createHarness({
		entries: combinedUsageEntries,
		config: { provider: "test", model: "tiny" },
	});
	await combinedUsage.emit("session_start", { type: "session_start", reason: "resume" });
	const combinedAssistant = await combinedUsage.finishAssistant("Completed the pending work.");
	check(
		"legacy usage is charged before current metadata is deferred",
		Math.abs(combinedAssistant.usage.cost.total - 0.06) < 1e-9 &&
			combinedAssistant.usage.totalTokens === 120 &&
			Math.abs((restoreTopicState(combinedUsage.entries)?.pendingUsage?.cost.total ?? 0) - 0.01) < 1e-9,
	);

	let canceledRollupSignal: AbortSignal | undefined;
	let releaseCanceledRollup: ((result: TopicResult) => void) | undefined;
	let rollupAttempt = 0;
	const recomputedRollup = createHarness({
		config: { provider: "test", model: "tiny" },
		generate: (_model, _ctx, _input, signal) => {
			rollupAttempt++;
			if (rollupAttempt === 1) {
				canceledRollupSignal = signal;
				return new Promise((resolve) => {
					releaseCanceledRollup = resolve;
				});
			}
			return Promise.resolve({
				topic: "Recomputed background topic",
				workSummary: "Recomputed both completed requests.",
				usage: topicUsage,
			});
		},
	});
	await recomputedRollup.emit("session_start", { type: "session_start", reason: "startup" });
	await recomputedRollup.submitUser("Complete the first background task");
	const firstBackgroundCompletion = recomputedRollup.finishAssistant("Completed the first background task.");
	await expectNonblocking(firstBackgroundCompletion, "completed-work rollup");
	check(
		"completed-work generation does not delay turn finalization",
		recomputedRollup.generationCalls === 1 &&
			canceledRollupSignal?.aborted === false &&
			recomputedRollup.statuses.at(-1) === "[summarizing…]",
	);
	await recomputedRollup.submitUser("Complete a newer task before the rollup finishes");
	await recomputedRollup.emit("agent_start", { type: "agent_start" });
	check("a newer agent run cancels the unfinished rollup", canceledRollupSignal?.aborted === true);
	await recomputedRollup.finishAssistant("Completed the newer task too.");
	check(
		"the next rollup recomputes all work since the checkpoint",
		JSON.stringify(recomputedRollup.generationInputs[1]?.completedWork.requests) ===
			JSON.stringify([
				"Complete the first background task",
				"Complete a newer task before the rollup finishes",
			]) &&
			JSON.stringify(recomputedRollup.generationInputs[1]?.completedWork.outcomes) ===
				JSON.stringify(["Completed the first background task.", "Completed the newer task too."]) &&
			recomputedRollup.sessionName === "Recomputed background topic",
	);
	releaseCanceledRollup?.({
		topic: "Stale canceled topic",
		workSummary: "Stale canceled summary.",
		usage: topicUsage,
	});
	await flushAsync();
	check(
		"late canceled rollups cannot change state or usage",
		recomputedRollup.sessionName === "Recomputed background topic" &&
			stateEntries(recomputedRollup).at(-1)?.workSummary === "Recomputed both completed requests." &&
			Math.abs((stateEntries(recomputedRollup).at(-1)?.pendingUsage?.cost.total ?? 0) - 0.01) < 1e-9 &&
			recomputedRollup.statuses.at(-1) === undefined,
	);
	await recomputedRollup.submitUser("Thanks");
	await recomputedRollup.emit("agent_start", { type: "agent_start" });
	const recomputedUsage = await recomputedRollup.finishAssistant("You're welcome.");
	check(
		"background rollup usage is charged exactly once",
		Math.abs(recomputedUsage.usage.cost.total - 0.06) < 1e-9 &&
			stateEntries(recomputedRollup).at(-1)?.pendingUsage === undefined,
	);

	let releaseInterruptedRollup: ((result: TopicResult) => void) | undefined;
	let interruptedAttempt = 0;
	const interruptedRollup = createHarness({
		config: { provider: "test", model: "tiny" },
		generate: () => {
			interruptedAttempt++;
			if (interruptedAttempt === 1) {
				return new Promise((resolve) => {
					releaseInterruptedRollup = resolve;
				});
			}
			return Promise.resolve({
				topic: "Recovered interrupted topic",
				workSummary: "Recovered the earlier completed task.",
				usage: topicUsage,
			});
		},
	});
	await interruptedRollup.emit("session_start", { type: "session_start", reason: "startup" });
	await interruptedRollup.submitUser("Complete work before an interrupted run");
	await interruptedRollup.finishAssistant("Completed work before the interruption.");
	await interruptedRollup.submitUser("Abort this newer run");
	await interruptedRollup.emit("agent_start", { type: "agent_start" });
	await interruptedRollup.finishAssistant("The newer run was aborted.", "aborted");
	check(
		"an unsuccessful newer run restarts the canceled rollup",
		interruptedRollup.generationCalls === 2 &&
			interruptedRollup.generationInputs[1]?.completedWork.requests.length === 1 &&
			interruptedRollup.generationInputs[1]?.latestPrompt === "Complete work before an interrupted run" &&
			interruptedRollup.sessionName === "Recovered interrupted topic",
	);
	releaseInterruptedRollup?.({
		topic: "Stale interrupted topic",
		workSummary: "Stale interrupted summary.",
		usage: topicUsage,
	});
	await flushAsync();
	check(
		"the original interrupted result remains stale",
		interruptedRollup.sessionName === "Recovered interrupted topic" &&
			stateEntries(interruptedRollup).at(-1)?.workSummary === "Recovered the earlier completed task." &&
			Math.abs((stateEntries(interruptedRollup).at(-1)?.pendingUsage?.cost.total ?? 0) - 0.01) < 1e-9,
	);

	let release: ((result: TopicResult) => void) | undefined;
	const concurrent = createHarness({
		config: { provider: "test", model: "tiny" },
		generate: () =>
			new Promise((resolve) => {
				release = resolve;
			}),
	});
	await concurrent.emit("session_start", { type: "session_start", reason: "startup" });
	await concurrent.commands.get("topic")!("refresh", concurrent.ctx);
	await concurrent.submitUser("Generate metadata while I rename the session");
	const pendingCompletion = concurrent.finishAssistant("Completed the requested metadata work.");
	await expectNonblocking(pendingCompletion, "manual-name rollup");
	await flushAsync();
	await concurrent.setManualName("Manual title wins");
	release?.({
		topic: "Stale generated topic",
		workSummary: "Completed metadata work.",
		usage: topicUsage,
	});
	await pendingCompletion;
	await flushAsync();
	check("manual names win over in-flight generation", concurrent.sessionName === "Manual title wins");
	check("in-flight generation still updates completed work", stateEntries(concurrent).at(-1)?.workSummary === "Completed metadata work.");

	let releaseAfterOff: ((result: TopicResult) => void) | undefined;
	const disabledDuringUpdate = createHarness({
		config: { provider: "test", model: "tiny" },
		generate: () =>
			new Promise((resolve) => {
				releaseAfterOff = resolve;
			}),
	});
	await disabledDuringUpdate.emit("session_start", { type: "session_start", reason: "startup" });
	await disabledDuringUpdate.commands.get("topic")!("refresh", disabledDuringUpdate.ctx);
	await disabledDuringUpdate.submitUser("Generate metadata while automatic naming is disabled");
	const completionAfterOff = disabledDuringUpdate.finishAssistant("Completed work before naming was disabled.");
	await flushAsync();
	await disabledDuringUpdate.commands.get("topic")!("off", disabledDuringUpdate.ctx);
	releaseAfterOff?.({
		topic: "Stale disabled automatic topic",
		workSummary: "Completed work while automatic naming was disabled.",
		usage: topicUsage,
	});
	await completionAfterOff;
	await flushAsync();
	check(
		"disabling auto blocks in-flight renames but keeps completed work",
		disabledDuringUpdate.sessionName === "Generated initial topic" &&
			stateEntries(disabledDuringUpdate).at(-1)?.workSummary ===
				"Completed work while automatic naming was disabled.",
	);

	let reloadSignal: AbortSignal | undefined;
	let finishAfterReload: ((result: TopicResult) => void) | undefined;
	const reloading = createHarness({
		config: { provider: "test", model: "tiny" },
		generate: (_model, _ctx, _input, signal) => {
			reloadSignal = signal;
			return new Promise((resolve) => {
				finishAfterReload = resolve;
			});
		},
	});
	await reloading.emit("session_start", { type: "session_start", reason: "startup" });
	await reloading.submitUser("Do not apply metadata across a reload");
	await reloading.finishAssistant("Completed before the reload.");
	await reloading.emit("session_start", { type: "session_start", reason: "reload" });
	check(
		"reload immediately invalidates background generation",
		reloadSignal?.aborted === true && reloading.statuses.at(-1) === undefined,
	);
	finishAfterReload?.({
		topic: "Late reloaded topic",
		workSummary: "Late reloaded summary.",
		usage: topicUsage,
	});
	await flushAsync();
	check(
		"late pre-reload results cannot change restored state",
		reloading.sessionName === "Generated initial topic" &&
			stateEntries(reloading).at(-1)?.workSummary === undefined &&
			stateEntries(reloading).at(-1)?.pendingUsage === undefined,
	);

	let shutdownSignal: AbortSignal | undefined;
	let finishAfterShutdown: ((result: TopicResult) => void) | undefined;
	const shuttingDown = createHarness({
		config: { provider: "test", model: "tiny" },
		generate: (_model, _ctx, _input, signal) => {
			shutdownSignal = signal;
			return new Promise((resolve) => {
				finishAfterShutdown = resolve;
			});
		},
	});
	await shuttingDown.emit("session_start", { type: "session_start", reason: "startup" });
	await shuttingDown.submitUser("Do not apply metadata after shutdown");
	const shuttingDownCompletion = shuttingDown.finishAssistant("Completed too late.");
	await flushAsync();
	await shuttingDown.emit("session_shutdown", { type: "session_shutdown" });
	check("shutdown immediately aborts in-flight generation", shutdownSignal?.aborted === true);
	finishAfterShutdown?.({
		topic: "Late generated topic",
		workSummary: "Late work summary.",
		usage: topicUsage,
	});
	await shuttingDownCompletion;
	await flushAsync();
	check(
		"late shutdown completions do not change metadata",
		shuttingDown.sessionName === "Generated initial topic" &&
			stateEntries(shuttingDown).at(-1)?.workSummary === undefined &&
			stateEntries(shuttingDown).at(-1)?.pendingUsage === undefined,
	);
	check("shutdown clears the naming status", shuttingDown.statuses.at(-1) === undefined);
	check("shutdown clears the latest-request widget", !shuttingDown.widgets.has("session-topic-latest-prompt"));

	let invalidCalls = 0;
	const invalid = createHarness({
		config: { provider: "test", model: "tiny" },
		generate: async () => {
			invalidCalls++;
			if (invalidCalls === 1) {
				return {
					topic: "Premature invalid summary topic",
					failure: {
						kind: "parse",
						stopReason: "stop",
						detail: 'missing string field "workSummary"',
					},
					usage: topicUsage,
				};
			}
			return {
				topic: "Recovered cumulative metadata topic",
				workSummary: "Retained both tasks after retrying invalid metadata.",
				usage: topicUsage,
			};
		},
	});
	await invalid.emit("session_start", { type: "session_start", reason: "startup" });
	await invalid.submitUser("Generate an invalid response but count its cost");
	const invalidAssistant = await invalid.finishAssistant("Completed despite invalid metadata.");
	check(
		"invalid work summaries defer their cost",
		Math.abs(invalidAssistant.usage.cost.total - 0.05) < 1e-9 &&
			Math.abs((stateEntries(invalid).at(-1)?.pendingUsage?.cost.total ?? 0) - 0.01) < 1e-9,
	);
	check(
		"topics without a cumulative summary do not replace the initial topic",
		invalid.sessionName === "Generated initial topic",
	);
	check("invalid work summaries do not advance the completion checkpoint", stateEntries(invalid).at(-1)?.lastCompletedEntryId === undefined);
	check(
		"parse warnings identify the invalid field and response stop",
		invalid.notifications.some(
			({ message }) =>
				message ===
				'session-topic: model returned invalid metadata: missing string field "workSummary" [stop=stop]',
		),
	);
	await invalid.submitUser("Retry cumulative metadata without losing earlier work");
	await invalid.finishAssistant("Recovered the cumulative summary.");
	check(
		"the next valid rollup includes work skipped after invalid metadata",
		invalid.generationInputs[1]?.completedWork.requests.length === 2 &&
			stateEntries(invalid).at(-1)?.lastCompletedEntryId !== undefined,
	);

	const failedRequestSummary = createHarness({
		config: { provider: "test", model: "tiny" },
		generatePromptSummary: async () => ({
			failure: { kind: "provider", stopReason: "error", errorMessage: "summary backend unavailable" },
			usage: topicUsage,
		}),
	});
	await failedRequestSummary.emit("session_start", { type: "session_start", reason: "startup" });
	await failedRequestSummary.submitUser("Keep the fallback after request summarization fails");
	await flushAsync();
	check(
		"request-summary failures warn without replacing the fallback",
		failedRequestSummary.notifications.some(
			({ message }) =>
				message ===
				"session-topic: request summary generation failed [stop=error, error=summary backend unavailable]",
		) && failedRequestSummary.promptWidgetText?.includes("Keep the fallback") === true,
	);
	const failedRequestAssistant = await failedRequestSummary.finishAssistant("Completed despite the summary failure.");
	await failedRequestSummary.submitUser("Thanks");
	const failedRequestDeferred = await failedRequestSummary.finishAssistant("You're welcome.");
	const failedRequestUncharged = await failedRequestSummary.finishAssistant("No additional charge.");
	check(
		"failed request-summary and deferred rollup usage are each charged once",
		Math.abs(failedRequestAssistant.usage.cost.total - 0.06) < 1e-9 &&
			Math.abs(failedRequestDeferred.usage.cost.total - 0.06) < 1e-9 &&
			Math.abs(failedRequestUncharged.usage.cost.total - 0.05) < 1e-9,
	);

	const invalidTopic = createHarness({
		config: { provider: "test", model: "tiny" },
		generate: async () => ({
			workSummary: "Completed work with an invalid generated topic.",
			failure: {
				kind: "parse",
				stopReason: "stop",
				detail: 'field "topic" did not meet its constraints',
			},
			usage: topicUsage,
		}),
	});
	await invalidTopic.emit("session_start", { type: "session_start", reason: "startup" });
	await invalidTopic.submitUser("Keep completed work when only the topic is invalid");
	await invalidTopic.finishAssistant("Completed work before topic parsing failed.");
	check(
		"invalid topics warn while completed work advances",
		invalidTopic.notifications.some(
			({ message }) =>
				message ===
				'session-topic: model returned invalid metadata: field "topic" did not meet its constraints [stop=stop]',
		) && stateEntries(invalidTopic).at(-1)?.lastCompletedEntryId !== undefined,
	);

	const diagnosticFailures: Array<{ name: string; failure: MetadataFailure; warning: string }> = [
		{
			name: "timeout warnings include the limit and provider response",
			failure: {
				kind: "timeout",
				timeoutMs: 20_000,
				stopReason: "aborted",
				errorMessage: "request aborted",
			},
			warning: "session-topic: work summary generation timed out after 20s [stop=aborted, error=request aborted]",
		},
		{
			name: "provider warnings include the stop reason and error",
			failure: { kind: "provider", stopReason: "error", errorMessage: "backend unavailable" },
			warning: "session-topic: work summary generation failed [stop=error, error=backend unavailable]",
		},
	];
	for (const diagnostic of diagnosticFailures) {
		const failed = createHarness({
			config: { provider: "test", model: "tiny" },
			generate: async () => ({ failure: diagnostic.failure, usage: zeroUsage }),
		});
		await failed.emit("session_start", { type: "session_start", reason: "startup" });
		await failed.submitUser("Exercise metadata failure diagnostics");
		await failed.finishAssistant("Completed work before metadata failed.");
		check(
			diagnostic.name,
			failed.notifications.some(({ message }) => message === diagnostic.warning),
		);
		check(
			`${diagnostic.name}, and the warning is appended to the session log`,
			failed.appended.some(
				(entry) =>
					entry.customType === "session-topic-warning" &&
					entry.data?.message === diagnostic.warning &&
					entry.data?.kind === diagnostic.failure.kind &&
					entry.data?.stopReason === diagnostic.failure.stopReason,
			),
		);
	}

	let throwCalls = 0;
	const retry = createHarness({
		config: { provider: "test", model: "tiny" },
		generate: async () => {
			throwCalls++;
			if (throwCalls === 1) throw new Error("temporary failure");
			return {
				topic: "Recover failed metadata generation",
				workSummary: "Recovered both completed tasks after a metadata failure.",
				usage: topicUsage,
			};
		},
	});
	await retry.emit("session_start", { type: "session_start", reason: "startup" });
	await retry.submitUser("Keep this task after metadata generation fails");
	await retry.finishAssistant("Completed the task before metadata failed.");
	await retry.submitUser("Retry metadata generation");
	await retry.finishAssistant("Completed the retry.");
	check(
		"generation failures do not drop completed work",
		retry.generationInputs[1]?.completedWork.requests.length === 2 &&
			retry.generationInputs[1]?.completedWork.outcomes.some((outcome) => outcome.includes("before metadata failed")) === true,
	);

	const skipped = createHarness({ config: { provider: "test", model: "tiny" } });
	await skipped.emit("session_start", { type: "session_start", reason: "startup" });
	await skipped.submitUser("Attempt work that will not complete");
	await skipped.finishAssistant("Request failed", "error");
	await skipped.finishAssistant("Request aborted", "aborted");
	check("error and aborted responses do not trigger generation", skipped.generationCalls === 0);
	await skipped.submitUser("Complete a different task afterward");
	await skipped.finishAssistant("Completed the different task.");
	check(
		"later rollups identify earlier unsuccessful work",
		skipped.generationInputs[0]?.completedWork.outcomes.filter((outcome) => outcome.startsWith("Unsuccessful")).length === 2,
	);

	const firstBranch = [
		{
			type: "message",
			id: "branch-user-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "First branch request", timestamp: Date.now() },
		},
		{
			type: "message",
			id: "branch-assistant-1",
			parentId: "branch-user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Completed work on the first branch." }],
				api: "test",
				provider: "test",
				model: "test",
				usage: mainUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
		},
		{
			type: "custom",
			id: "branch-state-1",
			parentId: "branch-assistant-1",
			timestamp: new Date().toISOString(),
			customType: "session-topic-state",
			data: {
				auto: true,
				generatedTopic: "First generated branch topic",
				latestPromptId: "branch-user-1",
				lastCompletedEntryId: "branch-assistant-1",
				latestPromptSummary: "Summarize the first branch request",
				workSummary: "Completed work on the first branch.",
			},
		},
	] as SessionEntry[];
	const secondBranch = [
		{
			type: "message",
			id: "branch-user-2",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "Second branch request", timestamp: Date.now() },
		},
		{
			type: "message",
			id: "branch-assistant-2",
			parentId: "branch-user-2",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Completed work on the second branch." }],
				api: "test",
				provider: "test",
				model: "test",
				usage: mainUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
		},
		{
			type: "custom",
			id: "branch-state-2",
			parentId: "branch-assistant-2",
			timestamp: new Date().toISOString(),
			customType: "session-topic-state",
			data: {
				auto: true,
				generatedTopic: "Second generated branch topic",
				latestPromptId: "branch-user-2",
				lastCompletedEntryId: "branch-assistant-2",
				latestPromptSummary: "Summarize the second branch request",
				workSummary: "Completed work on the second branch.",
			},
		},
	] as SessionEntry[];
	const manualBranch = [
		{
			type: "message",
			id: "manual-user",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "Work on the manual branch", timestamp: Date.now() },
		},
		{
			type: "message",
			id: "manual-assistant",
			parentId: "manual-user",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Completed work on the manual branch." }],
				api: "test",
				provider: "test",
				model: "test",
				usage: mainUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
		},
		{
			type: "session_info",
			id: "manual-name",
			parentId: "manual-assistant",
			timestamp: new Date().toISOString(),
			name: "Manual branch title",
		},
		{
			type: "custom",
			id: "manual-state",
			parentId: "manual-name",
			timestamp: new Date().toISOString(),
			customType: "session-topic-state",
			data: {
				auto: false,
				latestPromptId: "manual-user",
				lastCompletedEntryId: "manual-assistant",
				latestPromptSummary: "Work on the manual branch",
				workSummary: "Completed work on the manual branch.",
			},
		},
	] as SessionEntry[];
	const unnamedBranch = [
		{
			type: "message",
			id: "unnamed-user",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "Start work on an unnamed branch", timestamp: Date.now() },
		},
	] as SessionEntry[];
	const tree = createHarness({
		entries: [...firstBranch],
		sessionName: "Other branch global topic",
		config: { provider: "test", model: "tiny" },
	});
	await tree.emit("session_start", { type: "session_start", reason: "resume" });
	check(
		"resume restores generated names and request summaries from the active branch",
		tree.sessionName === "First generated branch topic" && tree.promptWidgetText?.includes("first branch") === true,
	);
	tree.replaceEntries(secondBranch);
	await tree.emit("session_tree", { type: "session_tree" });
	check(
		"tree navigation restores generated names and request summaries",
		tree.sessionName === "Second generated branch topic" && tree.promptWidgetText?.includes("second branch") === true,
	);
	await tree.submitUser("Continue after tree navigation");
	await tree.finishAssistant("Continued work on the selected branch.");
	check(
		"tree navigation restores automatic mode, cumulative summary, and checkpoint",
		tree.sessionName === "Generated topic number 1" &&
			tree.generationInputs[0]?.workSummary === "Completed work on the second branch." &&
			tree.generationInputs[0]?.completedWork.requests.length === 1,
	);
	tree.replaceEntries(manualBranch);
	await tree.emit("session_tree", { type: "session_tree" });
	check("tree navigation restores manual branch names", tree.sessionName === "Manual branch title");
	await tree.submitUser("Continue work without renaming the manual branch");
	await tree.finishAssistant("Continued the manually named branch.");
	check(
		"manual branch state keeps automatic naming disabled",
		tree.sessionName === "Manual branch title" &&
			tree.generationInputs[1]?.workSummary === "Completed work on the manual branch.",
	);
	tree.replaceEntries(unnamedBranch);
	await tree.emit("session_tree", { type: "session_tree" });
	check("tree navigation clears sibling names from an unnamed branch", tree.sessionName === undefined);
	await tree.submitUser("Complete work on the unnamed branch");
	await tree.finishAssistant("Completed work on the unnamed branch.");
	check("unnamed branches default to automatic naming", tree.sessionName === "Generated topic number 3");
	tree.replaceEntries(firstBranch);
	await tree.emit("session_tree", { type: "session_tree" });
	check(
		"switching back restores the sibling topic and request summary",
		tree.sessionName === "First generated branch topic" && tree.promptWidgetText?.includes("first branch") === true,
	);
	await tree.submitUser("Continue automatic work after returning to the first branch");
	await tree.finishAssistant("Continued automatic work on the first branch.");
	check("switching back restores automatic naming", tree.sessionName === "Generated topic number 4");

	const backlog = createHarness({
		config: { provider: "test", model: "tiny" },
		backlogReferences: async (texts) =>
			texts.some((text) => text.includes("abc123")) ? [{ id: "abc123", title: "Resolve backlog titles" }] : [],
	});
	await backlog.emit("session_start", { type: "session_start", reason: "startup" });
	await backlog.submitUser("Work on abc123");
	await flushAsync();
	await backlog.finishAssistant("Implemented the backlog item.");
	const hasTitle = (input: { backlogItems?: TopicInput["backlogItems"] } | undefined) =>
		input?.backlogItems?.[0]?.title === "Resolve backlog titles";
	check(
		"backlog titles for IDs in prompts reach every metadata request",
		hasTitle(backlog.promptSummaryInputs[0]) &&
			hasTitle(backlog.initialTopicInputs[0]) &&
			hasTitle(backlog.generationInputs[0]),
	);

	const unreadableBacklog = createHarness({
		config: { provider: "test", model: "tiny" },
		backlogReferences: async () => {
			throw new Error("unreadable store");
		},
	});
	await unreadableBacklog.emit("session_start", { type: "session_start", reason: "startup" });
	await unreadableBacklog.submitUser("Work on abc123");
	await flushAsync();
	await unreadableBacklog.finishAssistant("Implemented the backlog item.");
	check(
		"backlog lookup failures do not block metadata",
		unreadableBacklog.promptSummaryCalls === 1 && unreadableBacklog.generationCalls === 1,
	);

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall checks passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
