import { Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExtensionAPI,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { matchingModelIds } from "./models.ts";

export const listModelsTool = defineTool({
	name: "list_models",
	label: "List Models",
	description:
		"List models available to Pi, optionally filtered by a case-insensitive substring. Returns exact provider/model identifiers suitable for subagent model selection.",
	promptSnippet: "List available model identifiers for subagent selection",
	parameters: Type.Object({
		query: Type.Optional(
			Type.String({ description: "Optional substring matched against provider, model ID, or model name" }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const models = matchingModelIds(ctx.modelRegistry.getAvailable(), params.query);

		if (models.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: params.query?.trim()
							? `No available models match ${JSON.stringify(params.query.trim())}.`
							: "No models are available.",
					},
				],
				details: { count: 0 },
			};
		}

		const output = [
			`Available models (${models.length}). Use an exact provider/model identifier for subagent.model:`,
			...models,
		].join("\n");
		const truncated = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		const text = truncated.truncated
			? `${truncated.content}\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES} bytes. Refine the query to narrow the list.]`
			: truncated.content;

		return {
			content: [{ type: "text", text }],
			details: { count: models.length, truncated: truncated.truncated },
		};
	},
});

export default function modelList(pi: ExtensionAPI): void {
	pi.registerTool(listModelsTool);
}
