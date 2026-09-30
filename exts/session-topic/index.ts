import type { Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { referencedItems, type ItemReference } from "../backlog/store.ts";
import {
	availableModels,
	loadSmallModel,
	pickSmallModel,
	saveSmallModel,
	type SmallModelConfig,
} from "../shared/small-model.ts";
import {
	generatePromptSummary,
	generateTopic,
	isSubstantivePrompt,
	promptSummaryFallback,
	type CompletedWork,
	type MetadataFailure,
	type PromptSummaryInput,
	type PromptSummaryResult,
	type TopicInput,
	type TopicResult,
} from "./topic.ts";
import { addUsage, addUsageCost, isUsage } from "./usage.ts";

const STATE_ENTRY = "session-topic-state";
const WARNING_ENTRY = "session-topic-warning";
const PROMPT_WIDGET = "session-topic-latest-prompt";

interface TopicState {
	auto: boolean;
	generatedTopic?: string;
	latestPromptSummary?: string;
	latestPromptId?: string;
	workSummary?: string;
	lastCompletedEntryId?: string;
	pendingUsage?: Usage;
}

interface PersistedTopicState extends Partial<TopicState> {
	lastProcessedUserId?: string;
}

interface UpdateRequest {
	ctx: ExtensionContext;
	input: TopicInput;
	signal: AbortSignal;
}

interface CompletedMetadata {
	result: TopicResult;
	force: boolean;
	nameRevision: number;
}

export interface CompletedWorkContext {
	latestPrompt: string;
	latestUserId: string;
	completedWork: CompletedWork;
}

export interface SessionTopicDependencies {
	loadConfig: () => SmallModelConfig;
	saveModel: (provider: string, model: string) => void;
	generatePromptSummary: (
		model: Model<any>,
		ctx: ExtensionContext,
		input: PromptSummaryInput,
		signal: AbortSignal,
	) => Promise<PromptSummaryResult>;
	generateTopic: (
		model: Model<any>,
		ctx: ExtensionContext,
		input: TopicInput,
		signal: AbortSignal,
	) => Promise<TopicResult>;
	/** Backlog items whose IDs appear in `texts`. */
	backlogReferences: (texts: readonly string[]) => Promise<ItemReference[]>;
}

const DEFAULT_DEPENDENCIES: SessionTopicDependencies = {
	loadConfig: loadSmallModel,
	saveModel: saveSmallModel,
	generatePromptSummary,
	generateTopic,
	backlogReferences: (texts) => referencedItems(texts),
};

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function diagnosticText(text: string): string {
	const normalized = text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
	return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
}

function metadataFailureMessage(subject: string, failure: MetadataFailure | undefined): string {
	if (!failure) return `session-topic: model did not return a valid ${subject}`;
	const context = [
		`stop=${failure.stopReason}`,
		failure.errorMessage ? `error=${diagnosticText(failure.errorMessage)}` : undefined,
	]
		.filter((value): value is string => !!value)
		.join(", ");
	if (failure.kind === "timeout") {
		return `session-topic: ${subject} generation timed out after ${failure.timeoutMs / 1_000}s [${context}]`;
	}
	if (failure.kind === "provider") {
		return `session-topic: ${subject} generation failed [${context}]`;
	}
	if (failure.kind === "truncated") {
		return `session-topic: ${subject} response was truncated [${context}]`;
	}
	return `session-topic: model returned invalid metadata: ${diagnosticText(failure.detail)} [${context}]`;
}

function stateFrom(value: unknown): TopicState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const state = value as PersistedTopicState;
	if (typeof state.auto !== "boolean") return undefined;

	return {
		auto: state.auto,
		generatedTopic: optionalString(state.generatedTopic),
		latestPromptSummary: optionalString(state.latestPromptSummary),
		latestPromptId: optionalString(state.latestPromptId) ?? optionalString(state.lastProcessedUserId),
		workSummary: optionalString(state.workSummary),
		lastCompletedEntryId: optionalString(state.lastCompletedEntryId),
		pendingUsage: isUsage(state.pendingUsage) ? state.pendingUsage : undefined,
	};
}

export function restoreTopicState(entries: readonly SessionEntry[]): TopicState | undefined {
	let latest: TopicState | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		const state = stateFrom(entry.data);
		if (state) latest = state;
	}
	return latest;
}

function contentText(content: unknown, includeAttachments: boolean): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const text = content
		.filter((part): part is { type: "text"; text: string } => {
			return !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string";
		})
		.map((part) => part.text)
		.join("\n");
	if (!includeAttachments) return text;
	const imageCount = content.filter(
		(part) => !!part && typeof part === "object" && "type" in part && part.type === "image",
	).length;
	if (imageCount === 0) return text;
	const attachment = imageCount === 1 ? "User attached an image" : `User attached ${imageCount} images`;
	return text ? `${text}\n${attachment}` : attachment;
}

interface UserPrompt {
	id: string;
	index: number;
	text: string;
}

interface SubmittedPrompt {
	message: object;
	text: string;
	revision: number;
}

export function substantiveUserPrompts(entries: readonly SessionEntry[]): UserPrompt[] {
	const prompts: UserPrompt[] = [];
	for (const [index, entry] of entries.entries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = contentText(entry.message.content, true);
		if (isSubstantivePrompt(text)) prompts.push({ id: entry.id, index, text });
	}
	return prompts;
}

function toolActivity(entries: readonly SessionEntry[]): string[] {
	const counts = new Map<string, { succeeded: number; failed: number }>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const count = counts.get(entry.message.toolName) ?? { succeeded: 0, failed: 0 };
		if (entry.message.isError) count.failed++;
		else count.succeeded++;
		counts.set(entry.message.toolName, count);
	}
	return [...counts].map(([name, count]) => {
		const parts = [];
		if (count.succeeded > 0) parts.push(`${count.succeeded} succeeded`);
		if (count.failed > 0) parts.push(`${count.failed} failed`);
		return `${name}: ${parts.join(", ")}`;
	});
}

export function completedWorkSince(
	entries: readonly SessionEntry[],
	finalAssistant: { content: unknown },
	lastCompletedEntryId: string | undefined,
	backfill: boolean,
): CompletedWorkContext | undefined {
	const prompts = substantiveUserPrompts(entries);
	const latest = prompts.at(-1);
	if (!latest) return undefined;

	const checkpointIndex = lastCompletedEntryId
		? entries.findIndex((entry) => entry.id === lastCompletedEntryId)
		: -1;
	const uncheckedRange = entries.slice(backfill || checkpointIndex < 0 ? 0 : checkpointIndex + 1);
	const firstPromptIndex = substantiveUserPrompts(uncheckedRange)[0]?.index;
	if (!backfill && firstPromptIndex === undefined) return undefined;
	const range = uncheckedRange.slice(backfill ? 0 : firstPromptIndex);
	const requests = substantiveUserPrompts(range).map((prompt) => prompt.text);
	const outcomes = uncheckedRange.slice(0, backfill ? 0 : firstPromptIndex).flatMap((entry) => {
		return entry.type === "compaction" || entry.type === "branch_summary" ? [entry.summary] : [];
	});
	for (const entry of range) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			if (entry.message.stopReason === "toolUse") continue;
			const text = contentText(entry.message.content, false).trim();
			if (entry.message.stopReason === "stop") {
				if (text) outcomes.push(text);
			} else {
				const detail = text || entry.message.errorMessage || "No result was produced";
				outcomes.push(`Unsuccessful assistant response (${entry.message.stopReason}): ${detail}`);
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (entry.summary.trim()) outcomes.push(entry.summary);
		}
	}
	const finalText = contentText(finalAssistant.content, false).trim();
	if (finalText) outcomes.push(finalText);

	return {
		latestPrompt: latest.text,
		latestUserId: latest.id,
		completedWork: {
			requests,
			outcomes,
			toolActivity: toolActivity(range),
		},
	};
}

function branchSessionName(entries: readonly SessionEntry[]): { known: boolean; name?: string } {
	let known = false;
	let name: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "session_info") continue;
		known = true;
		name = entry.name;
	}
	return { known, name };
}

function messageEntryId(entries: readonly SessionEntry[], message: object): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "message" && entry.message === message) return entry.id;
	}
	return undefined;
}

export function registerSessionTopic(
	pi: ExtensionAPI,
	dependencies: SessionTopicDependencies = DEFAULT_DEPENDENCIES,
): void {
	let config: SmallModelConfig = {};
	let autoEnabled = true;
	let generatedTopic: string | undefined;
	let latestPromptSummary: string | undefined;
	let latestPromptId: string | undefined;
	let latestPromptMessage: object | undefined;
	let latestPromptRevision = 0;
	let promptAbort: AbortController | undefined;
	let workSummary: string | undefined;
	let lastCompletedEntryId: string | undefined;
	let pendingUsage: Usage | undefined;
	let refreshRequested = false;
	let nameRevision = 0;
	const internalNameEvents = new Set<string>();
	const activeTopicRequests = new Set<symbol>();
	let sessionAbort = new AbortController();
	let pendingModel: Promise<Model<any> | undefined> | undefined;
	let modelDeclined = false;
	let sessionRevision = 0;
	let completedGeneration = 0;
	let completedAbort: AbortController | undefined;
	let pendingCompletionEntryId: string | undefined;
	let persistAfterTurn = false;

	function setSessionName(name: string | undefined): void {
		const normalized = name?.trim() || undefined;
		if (pi.getSessionName() === normalized) return;
		internalNameEvents.add(normalized ?? "");
		pi.setSessionName(normalized ?? "");
	}

	/** Failure warnings are also recorded in the session log so incidents stay diagnosable after the TUI message scrolls away. */
	function warn(ctx: ExtensionContext, message: string, failure?: MetadataFailure): void {
		ctx.ui.notify(message, "warning");
		pi.appendEntry(WARNING_ENTRY, {
			message,
			kind: failure?.kind,
			stopReason: failure?.stopReason,
		});
	}

	function persistState(): void {
		pi.appendEntry<TopicState>(STATE_ENTRY, {
			auto: autoEnabled,
			generatedTopic,
			latestPromptSummary,
			latestPromptId,
			workSummary,
			lastCompletedEntryId,
			pendingUsage,
		});
	}

	function updatePromptWidget(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		const summary = latestPromptSummary;
		if (!summary) {
			ctx.ui.setWidget(PROMPT_WIDGET, undefined);
			return;
		}
		const line = `Latest request: ${summary}`;
		ctx.ui.setWidget(
			PROMPT_WIDGET,
			() => ({
				invalidate() {},
				render(width: number): string[] {
					return [truncateToWidth(line, width, "…")];
				},
			}),
			{ placement: "belowEditor" },
		);
	}

	function restorePromptSummary(entries: readonly SessionEntry[], restored: TopicState | undefined): void {
		const latest = substantiveUserPrompts(entries).at(-1);
		latestPromptId = latest?.id;
		latestPromptSummary =
			latest && restored?.latestPromptId === latest.id && restored.latestPromptSummary
				? restored.latestPromptSummary
				: latest
					? promptSummaryFallback(latest.text)
					: undefined;
	}

	function restoreState(ctx: ExtensionContext, clearUnnamedBranch: boolean): void {
		const branch = ctx.sessionManager.getBranch();
		const restored = restoreTopicState(branch);
		const branchName = branchSessionName(branch);
		const restoredName = restored?.generatedTopic;
		const targetName = branchName.known ? branchName.name : restoredName;
		const nameIsKnown = branchName.known || restoredName !== undefined || (!restored && clearUnnamedBranch);

		generatedTopic = restored?.generatedTopic;
		workSummary = restored?.workSummary;
		lastCompletedEntryId = restored?.lastCompletedEntryId;
		pendingUsage = restored?.pendingUsage;
		autoEnabled = restored?.auto ?? !branchName.name;
		if (nameIsKnown) setSessionName(targetName);
		restorePromptSummary(branch, restored);
		updatePromptWidget(ctx);
	}

	function addPendingUsage(usage: Usage): void {
		if (usage.totalTokens <= 0 && usage.cost.total <= 0) return;
		pendingUsage = pendingUsage ? addUsage(pendingUsage, usage) : usage;
	}

	function ensureModel(ctx: ExtensionContext, signal: AbortSignal): Promise<Model<any> | undefined> {
		if (pendingModel) return pendingModel;
		if (modelDeclined) return Promise.resolve(undefined);
		// Re-read so /small-model and other consumers' mid-session changes apply.
		config = dependencies.loadConfig();
		if (config.provider && config.model) {
			const model = availableModels(ctx).find(
				(candidate) => candidate.provider === config.provider && candidate.id === config.model,
			);
			if (model) return Promise.resolve(model);
			warn(ctx, `session-topic: ${config.provider}/${config.model} is unavailable`);
		}
		const selectionRevision = sessionRevision;
		const selection = pickSmallModel(ctx, {
			signal,
			current: config.provider && config.model ? `${config.provider}/${config.model}` : undefined,
			save: dependencies.saveModel,
		})
			.then((model) => {
				if (!model && pendingModel === selection && selectionRevision === sessionRevision) {
					modelDeclined = true;
				}
				return model;
			})
			.finally(() => {
				if (pendingModel === selection) pendingModel = undefined;
			});
		pendingModel = selection;
		return selection;
	}

	/** Backlog references in `texts`; lookup failures leave metadata without them. */
	async function backlogItems(texts: readonly string[]): Promise<ItemReference[]> {
		try {
			return await dependencies.backlogReferences(texts);
		} catch {
			return [];
		}
	}

	async function runTopicUpdate(request: UpdateRequest): Promise<TopicResult | undefined> {
		if (request.signal.aborted || request.ctx.mode !== "tui") return undefined;
		let model: Model<any> | undefined;
		try {
			model = await ensureModel(request.ctx, request.signal);
		} catch (error) {
			if (!request.signal.aborted) {
				warn(request.ctx, `session-topic: model selection failed: ${error}`);
			}
			return undefined;
		}
		if (!model || request.signal.aborted) return undefined;
		const { input } = request;
		const references = await backlogItems([...input.completedWork.requests, input.latestPrompt]);
		if (request.signal.aborted) return undefined;

		const statusRequest = Symbol();
		const requestSessionRevision = sessionRevision;
		activeTopicRequests.add(statusRequest);
		request.ctx.ui.setStatus("session-topic", request.ctx.ui.theme.fg("dim", "[summarizing…]"));
		try {
			return await dependencies.generateTopic(
				model,
				request.ctx,
				{ ...input, backlogItems: references },
				request.signal,
			);
		} catch (error) {
			if (!request.signal.aborted) {
				warn(request.ctx, `session-topic: topic generation failed: ${error}`);
			}
			return undefined;
		} finally {
			activeTopicRequests.delete(statusRequest);
			if (requestSessionRevision === sessionRevision && activeTopicRequests.size === 0) {
				request.ctx.ui.setStatus("session-topic", undefined);
			}
		}
	}

	async function runPromptSummary(
		ctx: ExtensionContext,
		prompt: string,
		signal: AbortSignal,
	): Promise<PromptSummaryResult | undefined> {
		if (signal.aborted || ctx.mode !== "tui") return undefined;
		try {
			const model = await ensureModel(ctx, signal);
			if (!model || signal.aborted) return undefined;
			const references = await backlogItems([prompt]);
			if (signal.aborted) return undefined;
			const result = await dependencies.generatePromptSummary(
				model,
				ctx,
				{ latestPrompt: prompt, backlogItems: references },
				signal,
			);
			if (result.failure && !signal.aborted) {
				warn(ctx, metadataFailureMessage("request summary", result.failure), result.failure);
			}
			return result;
		} catch (error) {
			if (!signal.aborted) {
				warn(ctx, `session-topic: request summary generation failed: ${error}`);
			}
			return undefined;
		}
	}

	function applyCompletedMetadata(update: CompletedMetadata, completionEntryId: string, ctx: ExtensionContext): void {
		const { result } = update;
		const workSummaryUpdated = !!result.workSummary;
		if (result.workSummary) {
			workSummary = result.workSummary;
			lastCompletedEntryId = completionEntryId;
		} else {
			warn(ctx, metadataFailureMessage("work summary", result.failure), result.failure);
		}

		const nameIsCurrent = update.nameRevision === nameRevision;
		const shouldUpdateTopic = update.force || autoEnabled;
		if (result.topic && workSummaryUpdated && nameIsCurrent && shouldUpdateTopic) {
			generatedTopic = result.topic;
			setSessionName(result.topic);
			if (update.force) refreshRequested = false;
		} else if (!result.topic && workSummaryUpdated && nameIsCurrent && shouldUpdateTopic) {
			warn(ctx, metadataFailureMessage("topic", result.failure), result.failure);
		}
	}

	function updateInput(completed: CompletedWorkContext): TopicInput {
		return {
			currentTopic: generatedTopic ?? pi.getSessionName(),
			workSummary,
			latestPrompt: completed.latestPrompt,
			completedWork: completed.completedWork,
		};
	}

	function requestSignal(ctx: ExtensionContext, promptSignal?: AbortSignal): AbortSignal {
		const signals = [sessionAbort.signal, ctx.signal, promptSignal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		return signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
	}

	function cancelCompletedUpdate(retry = false): void {
		completedGeneration++;
		completedAbort?.abort();
		completedAbort = undefined;
		if (!retry) pendingCompletionEntryId = undefined;
	}

	function startCompletedUpdate(
		ctx: ExtensionContext,
		completed: CompletedWorkContext,
		completionEntryId: string,
		force: boolean,
	): void {
		cancelCompletedUpdate();
		const controller = new AbortController();
		completedAbort = controller;
		pendingCompletionEntryId = completionEntryId;
		const generation = completedGeneration;
		const updateSessionRevision = sessionRevision;
		const signal = AbortSignal.any([sessionAbort.signal, controller.signal]);
		const updateNameRevision = nameRevision;
		void runTopicUpdate({ ctx, input: updateInput(completed), signal })
			.then((result) => {
				if (
					!result ||
					signal.aborted ||
					generation !== completedGeneration ||
					updateSessionRevision !== sessionRevision
				) {
					return;
				}
				addPendingUsage(result.usage);
				applyCompletedMetadata(
					{
						result,
						force,
						nameRevision: updateNameRevision,
					},
					completionEntryId,
					ctx,
				);
				persistState();
			})
			.catch((error) => {
				if (generation === completedGeneration && !signal.aborted) {
					warn(ctx, `session-topic: could not apply completed metadata: ${error}`);
				}
			})
			.finally(() => {
				if (generation === completedGeneration && completedAbort === controller) {
					completedAbort = undefined;
					pendingCompletionEntryId = undefined;
				}
			});
	}

	function syncLatestPromptEntry(ctx: ExtensionContext, submitted?: SubmittedPrompt): void {
		if (submitted && latestPromptRevision !== submitted.revision) return;
		const message = submitted?.message ?? latestPromptMessage;
		if (!message) return;
		const entryId = messageEntryId(ctx.sessionManager.getBranch(), message);
		if (entryId) latestPromptId = entryId;
	}

	function startPromptSummary(ctx: ExtensionContext, submitted: SubmittedPrompt, signal: AbortSignal): void {
		void runPromptSummary(ctx, submitted.text, signal).then((result) => {
			if (!result || signal.aborted) return;
			addPendingUsage(result.usage);
			if (result.promptSummary && latestPromptRevision === submitted.revision) {
				latestPromptSummary = result.promptSummary;
				syncLatestPromptEntry(ctx, submitted);
				updatePromptWidget(ctx);
			}
			persistState();
		});
	}

	function startInitialTopic(ctx: ExtensionContext, submitted: SubmittedPrompt, signal: AbortSignal): void {
		const updateNameRevision = nameRevision;
		void runTopicUpdate({
			ctx,
			input: {
				currentTopic: undefined,
				workSummary: undefined,
				latestPrompt: submitted.text,
				completedWork: { requests: [], outcomes: [], toolActivity: [] },
			},
			signal,
		}).then((result) => {
			if (!result || signal.aborted) return;
			addPendingUsage(result.usage);
			const canSetInitialTopic =
				updateNameRevision === nameRevision &&
				latestPromptRevision === submitted.revision &&
				autoEnabled &&
				!generatedTopic &&
				!pi.getSessionName();
			if (result.topic && canSetInitialTopic) {
				generatedTopic = result.topic;
				setSessionName(result.topic);
			} else if (!result.topic && canSetInitialTopic) {
				warn(ctx, metadataFailureMessage("topic", result.failure), result.failure);
			}
			persistState();
		});
	}

	pi.on("session_start", (_event, ctx) => {
		sessionAbort.abort();
		sessionAbort = new AbortController();
		sessionRevision++;
		cancelCompletedUpdate();
		latestPromptRevision++;
		latestPromptMessage = undefined;
		promptAbort?.abort();
		promptAbort = undefined;
		config = dependencies.loadConfig();
		internalNameEvents.clear();
		activeTopicRequests.clear();
		pendingModel = undefined;
		modelDeclined = false;
		refreshRequested = false;
		nameRevision = 0;
		persistAfterTurn = false;
		ctx.ui.setStatus("session-topic", undefined);
		restoreState(ctx, false);
	});

	pi.on("session_tree", (_event, ctx) => {
		sessionAbort.abort();
		sessionAbort = new AbortController();
		sessionRevision++;
		cancelCompletedUpdate();
		latestPromptRevision++;
		latestPromptMessage = undefined;
		promptAbort?.abort();
		promptAbort = undefined;
		nameRevision++;
		internalNameEvents.clear();
		activeTopicRequests.clear();
		pendingModel = undefined;
		modelDeclined = false;
		refreshRequested = false;
		persistAfterTurn = false;
		ctx.ui.setStatus("session-topic", undefined);
		restoreState(ctx, true);
	});

	pi.on("session_info_changed", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (internalNameEvents.delete(event.name ?? "")) return;
		nameRevision++;
		refreshRequested = false;
		autoEnabled = false;
		generatedTopic = undefined;
		persistState();
	});

	pi.on("agent_start", (_event, ctx) => {
		cancelCompletedUpdate(true);
		const controller = promptAbort;
		const signal = ctx.signal;
		if (!controller || !signal) return;
		if (signal.aborted) {
			controller.abort();
			return;
		}
		signal.addEventListener(
			"abort",
			() => {
				if (promptAbort === controller) controller.abort();
			},
			{ once: true },
		);
	});

	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui" || event.message.role !== "user") return;
		const text = contentText(event.message.content, true);
		if (!isSubstantivePrompt(text)) return;

		const isFirstPrompt = substantiveUserPrompts(ctx.sessionManager.getBranch()).length === 0;
		latestPromptRevision++;
		latestPromptMessage = event.message;
		latestPromptId = undefined;
		promptAbort?.abort();
		promptAbort = new AbortController();
		pendingModel = undefined;
		modelDeclined = false;
		latestPromptSummary = promptSummaryFallback(text);
		updatePromptWidget(ctx);

		const submitted = { message: event.message, text, revision: latestPromptRevision };
		const signal = requestSignal(ctx, promptAbort.signal);
		startPromptSummary(ctx, submitted, signal);
		if (isFirstPrompt && autoEnabled && !generatedTopic && !pi.getSessionName()) {
			startInitialTopic(ctx, submitted, signal);
		}
	});

	pi.on("context", (_event, ctx) => {
		const previousId = latestPromptId;
		syncLatestPromptEntry(ctx);
		if (latestPromptId !== previousId) persistState();
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;

		const deferredUsage = pendingUsage;
		if (deferredUsage) {
			pendingUsage = undefined;
			persistAfterTurn = true;
		}
		if (!deferredUsage) return;
		return {
			message: {
				...event.message,
				usage: addUsageCost(event.message.usage, deferredUsage),
			},
		};
	});

	pi.on("turn_end", (event, ctx) => {
		if (ctx.mode === "tui" && event.message.role === "assistant" && event.message.stopReason === "stop") {
			pendingCompletionEntryId = event.messageEntryId;
		}
		if (!persistAfterTurn) return;
		persistAfterTurn = false;
		persistState();
	});

	pi.on("agent_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		let lastAssistantIndex = -1;
		for (let index = event.messages.length - 1; index >= 0; index--) {
			if (event.messages[index]?.role === "assistant") {
				lastAssistantIndex = index;
				break;
			}
		}
		const lastAssistant = event.messages[lastAssistantIndex];
		if (lastAssistant?.role !== "assistant" || lastAssistant.stopReason !== "toolUse") return;
		const toolResult = event.messages
			.slice(lastAssistantIndex + 1)
			.filter((message) => message.role === "toolResult")
			.at(-1);
		if (toolResult) {
			pendingCompletionEntryId = messageEntryId(ctx.sessionManager.getBranch(), toolResult);
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const branch = ctx.sessionManager.getBranch();
		let lastAssistantIndex = -1;
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index]!;
			if (entry.type === "message" && entry.message.role === "assistant") {
				lastAssistantIndex = index;
				break;
			}
		}
		if (lastAssistantIndex < 0) return;
		const lastAssistant = branch[lastAssistantIndex]!;
		if (lastAssistant.type !== "message" || lastAssistant.message.role !== "assistant") return;
		if (lastAssistant.message.stopReason === "aborted") promptAbort?.abort();

		let completionEntryId: string | undefined;
		let completedBranch = branch;
		if (lastAssistant.message.stopReason === "stop") {
			completionEntryId = lastAssistant.id;
		} else if (lastAssistant.message.stopReason === "toolUse") {
			completionEntryId = branch
				.slice(lastAssistantIndex + 1)
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
				.at(-1)?.id;
		}
		if (!completionEntryId && pendingCompletionEntryId) {
			completionEntryId = pendingCompletionEntryId;
			const completionIndex = branch.findIndex((entry) => entry.id === completionEntryId);
			if (completionIndex >= 0) completedBranch = branch.slice(0, completionIndex + 1);
			else completionEntryId = undefined;
		}
		if (!completionEntryId) return;

		const force = refreshRequested;
		const completed = completedWorkSince(completedBranch, { content: "" }, lastCompletedEntryId, force);
		if (!completed) {
			pendingCompletionEntryId = undefined;
			return;
		}
		if (completedBranch === branch && latestPromptId !== completed.latestUserId) {
			latestPromptId = completed.latestUserId;
			if (!latestPromptSummary) {
				latestPromptSummary = promptSummaryFallback(completed.latestPrompt);
				updatePromptWidget(ctx);
			}
		}
		startCompletedUpdate(ctx, completed, completionEntryId, force);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionAbort.abort();
		sessionRevision++;
		cancelCompletedUpdate();
		latestPromptRevision++;
		promptAbort?.abort();
		promptAbort = undefined;
		activeTopicRequests.clear();
		ctx.ui.setStatus("session-topic", undefined);
		ctx.ui.setWidget(PROMPT_WIDGET, undefined);
	});

	pi.registerCommand("topic", {
		description: "Manage automatic session topics: /topic [auto|off|refresh]",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				const current = dependencies.loadConfig();
				const model =
					current.provider && current.model ? `${current.provider}/${current.model}` : "not selected — use /small-model";
				ctx.ui.notify(
					`Session topic\n  mode: ${autoEnabled ? "auto" : "off"}\n  topic: ${pi.getSessionName() ?? "none"}\n  latest request: ${latestPromptSummary ?? "none"}\n  model: ${model}`,
					"info",
				);
				return;
			}
			if (command === "off") {
				nameRevision++;
				autoEnabled = false;
				refreshRequested = false;
				persistState();
				ctx.ui.notify("session-topic: automatic updates disabled", "info");
				return;
			}
			if (command === "auto") {
				nameRevision++;
				autoEnabled = true;
				generatedTopic = pi.getSessionName();
				persistState();
				ctx.ui.notify("session-topic: automatic updates enabled", "info");
				return;
			}
			if (command === "refresh") {
				refreshRequested = true;
				ctx.ui.notify("session-topic: topic will refresh after the next completed agent turn", "info");
				return;
			}
			ctx.ui.notify("Usage: /topic [auto|off|refresh]", "warning");
		},
	});
}

export default function sessionTopic(pi: ExtensionAPI): void {
	registerSessionTopic(pi);
}
