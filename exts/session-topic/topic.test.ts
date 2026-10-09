import type { Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildPromptSummaryPrompt,
	buildTopicPrompt,
	generatePromptSummary,
	generateTopic,
	isSubstantivePrompt,
	METADATA_TIMEOUT_MS,
	parsePromptSummary,
	parsePromptSummaryResponse,
	parseTopic,
	parseTopicResponse,
	parseWorkSummary,
	promptSummaryFallback,
	type TopicInput,
} from "./topic.ts";
import { addUsage, addUsageCost, isUsage } from "./usage.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const usage = (input: number, output: number, cost: number): Usage => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

const topicInput: TopicInput = {
	currentTopic: "Improve Pi session metadata",
	workSummary: "Added automatic session names and a latest-request widget.",
	latestPrompt: "Make topics reflect all completed work",
	completedWork: {
		requests: ["Make topics reflect all completed work"],
		outcomes: ["Implemented a cumulative completed-work summary."],
		toolActivity: ["edit: 2 succeeded", "bash: 1 succeeded"],
	},
};

async function main(): Promise<void> {
	check("accepts substantive prompts", isSubstantivePrompt("fix tests"));
	check("ignores acknowledgements", !isSubstantivePrompt("Sounds good!"));
	check(
		"ignores terse acknowledgement variants",
		["LGTM", "great", "👍", "done ✅️", "great 👍🏻", "looks good, thanks"].every(
			(text) => !isSubstantivePrompt(text),
		),
	);
	check("keeps acknowledgements with new instructions", isSubstantivePrompt("Looks good, but fix the parser"));
	check(
		"keeps action continuations as requests",
		["go ahead", "do it", "continue", "proceed"].every(isSubstantivePrompt),
	);
	check("ignores slash commands", !isSubstantivePrompt("/name manual title"));

	check("parses a valid topic", parseTopic("Add automatic Pi session topics") === "Add automatic Pi session topics");
	check("strips a plain topic prefix", parseTopic("Topic: Add automatic Pi session topics.") === "Add automatic Pi session topics");
	check("rejects short topics", parseTopic("Pi topics") === undefined);
	check("rejects long topics", parseTopic("one two three four five six seven eight nine") === undefined);
	check("rejects multiline output", parseTopic("Good session topic\nextra text") === undefined);
	check("parses a bounded prompt summary", parsePromptSummary("Add a persistent latest-request widget") !== undefined);
	check("normalizes multiline prompt summaries", parsePromptSummary("first line\nsecond line") === "first line second line");
	const fullLineSummary = "x".repeat(200);
	check("keeps prompt summaries long enough for wide widgets", parsePromptSummary(fullLineSummary) === fullLineSummary);
	check("normalizes cumulative work summaries", parseWorkSummary("first task\nsecond task") === "first task second task");
	const metadata = parseTopicResponse(
		'{"topic":"Generate concise session topics","workSummary":"Added session topics and request summaries."}',
	);
	check(
		"parses topic metadata fields independently",
		metadata.topic === "Generate concise session topics" &&
			metadata.workSummary === "Added session topics and request summaries.",
	);
	const partialMetadata = parseTopicResponse(
		'{"topic":"too short","workSummary":"Retained all completed work."}',
	);
	check(
		"keeps a valid work summary when the topic is invalid",
		partialMetadata.topic === undefined && partialMetadata.workSummary === "Retained all completed work.",
	);
	const fencedMetadata = parseTopicResponse(
		'```json\n{"topic":"Parse fenced metadata","workSummary":"Added session topics and request summaries."}\n```',
	);
	check(
		"parses metadata wrapped in a markdown fence",
		fencedMetadata.topic === "Parse fenced metadata" &&
			fencedMetadata.workSummary === "Added session topics and request summaries.",
	);
	const proseMetadata = parseTopicResponse(
		'Here is the result:\n{"topic":"Tolerate surrounding prose","workSummary":"Kept the summary."}\nHope this helps!',
	);
	check(
		"parses metadata surrounded by prose",
		proseMetadata.topic === "Tolerate surrounding prose" &&
			proseMetadata.workSummary === "Kept the summary.",
	);
	const promptMetadata = parsePromptSummaryResponse(
		'{"promptSummary":"Keep the valid request summary"}',
	);
	check("parses prompt summaries separately", promptMetadata.promptSummary === "Keep the valid request summary");
	const nonJsonTopic = parseTopicResponse("Generate concise session topics");
	const nonJsonPrompt = parsePromptSummaryResponse("Keep the valid request summary");
	check(
		"rejects non-JSON metadata",
		nonJsonTopic.topic === undefined &&
			nonJsonTopic.workSummary === undefined &&
			nonJsonPrompt.promptSummary === undefined,
	);
	check(
		"fallback summaries normalize and retain prompt endings",
		promptSummaryFallback(`  Add\n${"persistent ".repeat(400)}final instruction `)?.includes("…") === true &&
			promptSummaryFallback(`  Add\n${"persistent ".repeat(400)}final instruction `)?.endsWith("final instruction") === true,
	);
	const promptSummaryInput = JSON.parse(buildPromptSummaryPrompt({ latestPrompt: `${"detail ".repeat(400)}final instruction` })) as {
		latestPrompt: string;
	};
	check(
		"prompt-summary requests are bounded and retain prompt endings",
		Array.from(promptSummaryInput.latestPrompt).length <= 2_000 &&
			promptSummaryInput.latestPrompt.endsWith("final instruction"),
	);

	const builtPrompt = JSON.parse(buildTopicPrompt(topicInput)) as {
		currentTopic: string;
		workSummary: string;
		latestPrompt: string;
		workSinceLastSummary: { requests: string[]; outcomes: string[]; toolActivity: string[] };
	};
	check("prompt includes the current topic", builtPrompt.currentTopic === topicInput.currentTopic);
	check("prompt includes the cumulative work summary", builtPrompt.workSummary === topicInput.workSummary);
	check("prompt separates the latest request", builtPrompt.latestPrompt === topicInput.latestPrompt);
	check(
		"prompt includes completed outcomes and tool activity",
		builtPrompt.workSinceLastSummary.outcomes[0]?.includes("cumulative") === true &&
			builtPrompt.workSinceLastSummary.toolActivity.includes("edit: 2 succeeded"),
	);

	const longTail = "Only fix the parser";
	const boundedPrompt = buildTopicPrompt({
		...topicInput,
		currentTopic: "🧪".repeat(400),
		workSummary: 'summary \\ " 🧪 '.repeat(1_000),
		latestPrompt: `${'log \\ " 🧪 '.repeat(1_000)}${longTail}`,
		completedWork: {
			requests: Array.from({ length: 20 }, (_, index) => `request ${index} ${'detail \\ " 🧪 '.repeat(300)}`),
			outcomes: Array.from({ length: 20 }, (_, index) => `outcome ${index} ${'detail \\ " 🧪 '.repeat(300)}`),
			toolActivity: Array.from({ length: 20 }, (_, index) => `tool-${index}: ${'success \\ " 🧪 '.repeat(100)}`),
		},
	});
	const boundedValue = JSON.parse(boundedPrompt) as {
		currentTopic: string;
		latestPrompt: string;
		workSummary: string;
		workSinceLastSummary: { requests: string[]; outcomes: string[]; toolActivity: string[] };
	};
	const pointLength = (text: string) => Array.from(text).length;
	const totalPoints = (items: string[]) => items.reduce((total, item) => total + pointLength(item), 0);
	check("model context retains long-prompt endings", boundedValue.latestPrompt.endsWith(longTail));
	check("current topics are bounded by code point", pointLength(boundedValue.currentTopic) <= 200);
	check("latest prompts are bounded by code point", pointLength(boundedValue.latestPrompt) <= 2_000);
	check("persisted work summaries are bounded", pointLength(boundedValue.workSummary) <= 1_200);
	check(
		"completed-work sections respect their aggregate bounds",
		totalPoints(boundedValue.workSinceLastSummary.requests) <= 4_000 &&
			totalPoints(boundedValue.workSinceLastSummary.outcomes) <= 5_000 &&
			totalPoints(boundedValue.workSinceLastSummary.toolActivity) <= 800,
	);
	check(
		"completed-work sections retain first and latest items",
		boundedValue.workSinceLastSummary.requests[0]?.startsWith("request 0") === true &&
			boundedValue.workSinceLastSummary.requests.at(-1)?.startsWith("request 19") === true &&
			boundedValue.workSinceLastSummary.outcomes[0]?.startsWith("outcome 0") === true &&
			boundedValue.workSinceLastSummary.outcomes.at(-1)?.startsWith("outcome 19") === true,
	);
	check("serialized cumulative metadata remains bounded", boundedPrompt.length < 30_000);

	const backlogItems = Array.from({ length: 12 }, (_, index) => ({
		id: `abc${100 + index}`,
		title: `Title ${index}\n${"x".repeat(300)}`,
	}));
	const backlogPayloads = [
		JSON.parse(buildTopicPrompt({ ...topicInput, backlogItems })),
		JSON.parse(buildPromptSummaryPrompt({ latestPrompt: "Work on abc100", backlogItems })),
	] as Array<{ backlogItems?: Array<{ id: string; title: string }> }>;
	check(
		"both prompts include bounded backlog titles",
		backlogPayloads.every(
			(payload) =>
				payload.backlogItems?.length === 10 &&
				payload.backlogItems[0]?.id === "abc100" &&
				payload.backlogItems.every((item) => !item.title.includes("\n") && Array.from(item.title).length <= 240),
		),
	);

	let options: Record<string, unknown> | undefined;
	let requestContext: any;
	let emptyWorkInstructions = false;
	const model = { provider: "test", id: "tiny" } as Model<any>;
	const ctx = {
		modelRegistry: {
			streamSimple: (_model: unknown, context: any, requestOptions: Record<string, unknown>) => {
				requestContext = context;
				options = requestOptions;
				const payload = JSON.parse(context.messages[0].content[0].text);
				const emptyWork =
					requestOptions.maxTokens !== 512 &&
					payload.workSinceLastSummary.requests.length === 0 &&
					payload.workSinceLastSummary.outcomes.length === 0 &&
					payload.workSinceLastSummary.toolActivity.length === 0;
				if (emptyWork) {
					emptyWorkInstructions =
						context.systemPrompt.includes("use latestPrompt as the subject") &&
						context.systemPrompt.includes("workSinceLastSummary is empty");
				}
				return {
					result: async () => ({
						stopReason: "stop",
						content: [
							{
								type: "text",
								text:
									requestOptions.maxTokens === 512
										? '{"promptSummary":"Make topics reflect completed work"}'
										: emptyWork
											? '{"topic":"Summarize initial session request","workSummary":""}'
											: '{"topic":"Improve Pi session metadata","workSummary":"Added cumulative summaries for completed work."}',
							},
						],
						usage: usage(10, 4, 0.01),
					}),
				};
			},
		},
	} as unknown as ExtensionContext;
	const result = await generateTopic(model, ctx, topicInput, new AbortController().signal);
	check("model response becomes a topic", result.topic === "Improve Pi session metadata");
	check("model response updates cumulative work", result.workSummary === "Added cumulative summaries for completed work.");
	check("topic metadata call omits reasoning", options !== undefined && !("reasoning" in options));
	check(
		"work-summary guidance uses a word target and prioritizes important work",
		requestContext.systemPrompt.includes("aim for 100–150 words") &&
			requestContext.systemPrompt.includes("prioritizing important tasks, decisions, and outcomes") &&
			requestContext.systemPrompt.includes("omitting secondary details") &&
			!requestContext.systemPrompt.includes("1200 characters"),
	);
	check(
		"topic guidance retains its limits and preserves representative topics",
		requestContext.systemPrompt.includes("contain 3 to 8 words and at most 48 characters") &&
			requestContext.systemPrompt.includes(
				"preserve the current topic exactly whenever it still represents the cumulative body of work",
			),
	);
	check("topic model call limits output", options?.maxTokens === 4096);
	const sentPayload = JSON.parse(requestContext?.messages?.[0]?.content?.[0]?.text) as {
		workSinceLastSummary: TopicInput["completedWork"];
	};
	check(
		"model call receives completed work",
		JSON.stringify(sentPayload.workSinceLastSummary) === JSON.stringify(topicInput.completedWork),
	);
	check("topic model usage is returned", result.usage.cost.total === 0.01);
	check("metadata requests allow 20 seconds for transient latency", METADATA_TIMEOUT_MS === 20_000);

	const providerFailureContext = {
		modelRegistry: {
			streamSimple: () => ({
				result: async () => ({
					stopReason: "error",
					errorMessage: "backend unavailable",
					content: [],
					usage: usage(2, 1, 0.01),
				}),
			}),
		},
	} as unknown as ExtensionContext;
	const providerFailure = await generateTopic(
		model,
		providerFailureContext,
		topicInput,
		new AbortController().signal,
	);
	check(
		"provider failures preserve their stop reason and message",
		providerFailure.failure?.kind === "provider" &&
			providerFailure.failure.stopReason === "error" &&
			providerFailure.failure.errorMessage === "backend unavailable" &&
			providerFailure.usage.cost.total === 0.01,
	);

	const rejectedProviderContext = {
		modelRegistry: {
			streamSimple: () => ({ result: async () => Promise.reject(new Error("socket closed")) }),
		},
	} as unknown as ExtensionContext;
	const rejectedProvider = await generateTopic(
		model,
		rejectedProviderContext,
		topicInput,
		new AbortController().signal,
	);
	check(
		"rejected provider requests become structured failures",
		rejectedProvider.failure?.kind === "provider" &&
			rejectedProvider.failure.stopReason === "error" &&
			rejectedProvider.failure.errorMessage === "socket closed",
	);

	const parseFailureContext = {
		modelRegistry: {
			streamSimple: () => ({
				result: async () => ({
					stopReason: "stop",
					content: [{ type: "text", text: "not JSON" }],
					usage: usage(10, 4, 0.01),
				}),
			}),
		},
	} as unknown as ExtensionContext;
	const parseFailure = await generateTopic(model, parseFailureContext, topicInput, new AbortController().signal);
	check(
		"parse failures retain usage and identify malformed metadata",
		parseFailure.failure?.kind === "parse" &&
			parseFailure.failure.stopReason === "stop" &&
			parseFailure.failure.detail === "response was not a JSON object" &&
			parseFailure.usage.cost.total === 0.01,
	);

	const truncatedContext = {
		modelRegistry: {
			streamSimple: () => ({
				result: async () => ({
					stopReason: "length",
					content: [{ type: "text", text: '{"topic":"Cut off topic","workSummary":' }],
					usage: usage(10, 4, 0.01),
				}),
			}),
		},
	} as unknown as ExtensionContext;
	const truncated = await generateTopic(model, truncatedContext, topicInput, new AbortController().signal);
	check(
		"truncated responses are reported distinctly",
		truncated.failure?.kind === "truncated" &&
			truncated.failure.stopReason === "length" &&
			truncated.usage.cost.total === 0.01,
	);

	let timeoutSignal: AbortSignal | undefined;
	const timeoutContext = {
		modelRegistry: {
			streamSimple: (_model: unknown, _context: unknown, requestOptions: { signal: AbortSignal }) => {
				timeoutSignal = requestOptions.signal;
				return {
					result: () =>
						new Promise((resolve) => {
							requestOptions.signal.addEventListener(
								"abort",
								() =>
									resolve({
										stopReason: "aborted",
										errorMessage: "request aborted",
										content: [],
										usage: usage(2, 1, 0.01),
									}),
								{ once: true },
							);
						}),
				};
			},
		},
	} as unknown as ExtensionContext;
	const timeoutFailure = await generateTopic(
		model,
		timeoutContext,
		topicInput,
		new AbortController().signal,
		5,
	);
	check(
		"timeouts are distinct from caller cancellation",
		timeoutSignal?.aborted === true &&
			timeoutFailure.failure?.kind === "timeout" &&
			timeoutFailure.failure.timeoutMs === 5 &&
			timeoutFailure.failure.stopReason === "aborted" &&
			timeoutFailure.failure.errorMessage === "request aborted" &&
			timeoutFailure.usage.cost.total === 0.01,
	);

	const emptySummaryContext = {
		modelRegistry: {
			streamSimple: () => ({
				result: async () => ({
					stopReason: "stop",
					content: [{ type: "text", text: '{"topic":"Keep a valid session topic","workSummary":""}' }],
					usage: usage(10, 4, 0.01),
				}),
			}),
		},
	} as unknown as ExtensionContext;
	const emptyRequiredSummary = await generateTopic(
		model,
		emptySummaryContext,
		topicInput,
		new AbortController().signal,
	);
	check(
		"completed work requires a nonempty work summary",
		emptyRequiredSummary.failure?.kind === "parse" &&
			emptyRequiredSummary.failure.detail === 'field "workSummary" was empty',
	);

	const emptyWorkInput: TopicInput = {
		latestPrompt: "Name the session from its first request",
		completedWork: { requests: [], outcomes: [], toolActivity: [] },
	};
	const emptyWorkResult = await generateTopic(model, ctx, emptyWorkInput, new AbortController().signal);
	const emptyWorkPayload = JSON.parse(requestContext?.messages?.[0]?.content?.[0]?.text);
	check(
		"topic generation supports empty completed work",
		emptyWorkResult.topic === "Summarize initial session request" &&
			emptyWorkResult.workSummary === undefined &&
			emptyWorkResult.failure === undefined &&
			emptyWorkInstructions &&
			emptyWorkPayload.latestPrompt === emptyWorkInput.latestPrompt &&
			emptyWorkPayload.workSinceLastSummary.requests.length === 0,
	);

	const summary = await generatePromptSummary(
		model,
		ctx,
		{ latestPrompt: topicInput.latestPrompt },
		new AbortController().signal,
	);
	check("prompt-summary response is parsed separately", summary.promptSummary === "Make topics reflect completed work");
	check("prompt-summary metadata call omits reasoning", options !== undefined && !("reasoning" in options));
	check("prompt-summary model call limits output", options?.maxTokens === 512);
	check(
		"prompt-summary guidance retains its scope and limits",
		requestContext.systemPrompt.includes("summarize only latestPrompt as an action or request") &&
			requestContext.systemPrompt.includes("contain at most 20 words") &&
			requestContext.systemPrompt.includes("use one plain-text sentence"),
	);
	check(
		"prompt-summary call sends its system prompt",
		requestContext?.systemPrompt?.includes('string field named "promptSummary"') === true,
	);
	check(
		"prompt-summary call receives only the latest prompt",
		JSON.stringify(JSON.parse(requestContext?.messages?.[0]?.content?.[0]?.text)) ===
			JSON.stringify({ latestPrompt: topicInput.latestPrompt }),
	);
	check("prompt-summary usage is returned", summary.usage.cost.total === 0.01);

	let providerSignal: AbortSignal | undefined;
	let resolveProvider: ((response: object) => void) | undefined;
	const cancellableContext = {
		modelRegistry: {
			streamSimple: (_model: unknown, _context: unknown, requestOptions: { signal: AbortSignal }) => {
				providerSignal = requestOptions.signal;
				return {
					result: () =>
						new Promise((resolve) => {
							resolveProvider = resolve;
						}),
				};
			},
		},
	} as unknown as ExtensionContext;
	const callerController = new AbortController();
	const cancelled = generateTopic(model, cancellableContext, topicInput, callerController.signal);
	for (let index = 0; index < 10 && !resolveProvider; index++) await Promise.resolve();
	callerController.abort();
	check("caller cancellation immediately reaches the provider request", providerSignal?.aborted === true);
	resolveProvider?.({ stopReason: "aborted", content: [], usage: usage(0, 0, 0) });
	const cancelledResult = await cancelled;
	check("caller cancellation is not reported as a metadata failure", cancelledResult.failure === undefined);

	const combined = addUsage(usage(10, 2, 0.01), usage(5, 3, 0.02));
	check("usage totals include topic calls", combined.totalTokens === 20 && combined.cost.total === 0.03);
	const costOnly = addUsageCost(usage(10, 2, 0.01), usage(5, 3, 0.02));
	check("cost accounting does not inflate context tokens", costOnly.totalTokens === 12 && costOnly.cost.total === 0.03);
	check("validates persisted usage", isUsage(usage(1, 1, 0.01)) && !isUsage({ totalTokens: 2 }));

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
