import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureCursorCredential, replaceCursorCredential } from "./auth.ts";
import {
	type AgentInfo,
	createAgent,
	CursorApiError,
	getAgent,
	getRun,
	isInvalidApiKeyError,
	listModels,
	type RunInfo,
} from "./client.ts";
import { resolveModelSelection } from "./models.ts";
import { inspectCursorRepository } from "./repository.ts";

const MAX_RESULT_CHARS = 4000;

export interface CursorCloudDetails {
	agentId: string;
	runId: string;
	url: string;
	repository: string;
	status: string;
	agentStatus: string;
	model?: string;
	effort?: string;
}

export interface CursorStatusDetails {
	agent: AgentInfo;
	run?: RunInfo;
}

async function notFound<T>(request: Promise<T>, message: string): Promise<T> {
	try {
		return await request;
	} catch (error) {
		if (error instanceof CursorApiError && error.status === 404) throw new Error(message);
		throw error;
	}
}

function statusText(agent: AgentInfo, run: RunInfo | undefined): string {
	const lines = [
		`Agent: ${agent.id} (${agent.status})${agent.name ? ` ${agent.name}` : ""}`,
		`URL: ${agent.url}`,
	];
	if (!run) return [...lines, "Run: none"].join("\n");
	const duration = run.durationMs === undefined ? "" : `, ${Math.round(run.durationMs / 1000)}s`;
	lines.push(`Run: ${run.id} (${run.status}${duration})`);
	if (run.updatedAt) lines.push(`Updated: ${run.updatedAt}`);
	for (const branch of run.branches) {
		lines.push(`Branch: ${[branch.repoUrl, branch.branch].filter(Boolean).join(" ") || "unknown"}`);
		if (branch.prUrl) lines.push(`Pull request: ${branch.prUrl}`);
	}
	if (!run.branches.some((branch) => branch.prUrl)) lines.push("Pull request: none");
	if (run.result) lines.push("Result:", run.result);
	return lines.join("\n");
}

export function cursorDispatchTool(pi: ExtensionAPI) {
	return defineTool({
		name: "cloud_agent",
		label: "Cursor Cloud Agent",
		description:
			"Send a complete, approved implementation plan to a Cursor Cloud Agent, which autonomously changes the selected remote GitHub repository and creates a pull request. This is an external, billable, write-capable operation. Call it only when the user explicitly instructs you to dispatch work to a Cursor Cloud Agent.",
		promptSnippet: "Dispatch an approved, self-contained implementation plan to a Cursor Cloud Agent",
		parameters: Type.Object(
			{
				provider: Type.Literal("cursor", { description: "Cloud provider" }),
				plan: Type.String({ minLength: 1, description: "Complete, approved, self-contained implementation plan" }),
				name: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Optional Cursor agent display name" })),
				model: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Cursor model ID or unique alias; omit for Cursor's default" })),
				effort: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "That model's effort value (e.g. low, medium, high, xhigh, max), requires model, omit for the model's default; invalid choices fail before launch and list valid options" })),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.provider !== "cursor") throw new Error("Unsupported cloud provider.");
			const plan = params.plan.trim();
			const name = params.name?.trim();
			const model = params.model?.trim();
			const effort = params.effort?.trim();
			if (!plan) throw new Error("The Cursor Cloud implementation plan cannot be blank.");
			if (params.name !== undefined && !name) throw new Error("The Cursor Cloud agent name cannot be blank.");
			if (params.model !== undefined && !model) throw new Error("The Cursor model cannot be blank.");
			if (params.effort !== undefined && !effort) throw new Error("The Cursor effort cannot be blank.");
			if (effort && !model) throw new Error("Cursor effort requires a model.");

			let credential = await ensureCursorCredential(ctx, signal);
			const repository = await inspectCursorRepository(pi, ctx.cwd, signal);
			const agentId = `bc-${randomUUID()}`;
			const launch = async (apiKey: string) => {
				let selection;
				let effortParameter: string | undefined;
				if (model) {
					try {
						const resolved = resolveModelSelection(await listModels(apiKey, signal), model, effort);
						selection = resolved.selection;
						effortParameter = resolved.effortParameter;
					} catch (error) {
						if (isInvalidApiKeyError(error)) throw error;
						const message = error instanceof Error ? error.message : String(error);
						throw new Error(`No Cursor agent was launched: ${message}`);
					}
				}
				return {
					created: await createAgent(apiKey, {
						agentId, plan, name, model: selection,
						repositoryUrl: repository.repositoryUrl,
					}, signal),
					selection,
					effortParameter,
				};
			};
			let launched;
			try {
				launched = await launch(credential.apiKey);
			} catch (error) {
				if (!isInvalidApiKeyError(error)) throw error;
				ctx.ui.notify("Cursor rejected the stored API key during launch. Replace it to retry once.", "warning");
				credential = await replaceCursorCredential(ctx, signal);
				launched = await launch(credential.apiKey);
			}
			const { created, selection, effortParameter } = launched;

			const details: CursorCloudDetails = {
				agentId: created.agentId,
				runId: created.runId,
				url: created.url,
				repository: repository.repositoryUrl,
				status: created.runStatus,
				agentStatus: created.agentStatus,
				...(selection ? { model: selection.id, ...(effort ? { effort } : {}) } : {}),
			};
			const text = [
				"Cursor Cloud Agent launched; the work is not complete. Check progress with cloud_agent_status.",
				`Agent: ${created.agentId}`,
				`Run: ${created.runId}`,
				`Status: ${created.runStatus}`,
				`Repository: ${repository.repositoryUrl}`,
				"Cursor selects the starting point; the local checkout and edits are not sent.",
				...(selection ? [`Model: ${selection.id}${effortParameter ? ` (${effortParameter}=${effort})` : ""}`] : []),
				`URL: ${created.url}`,
			].join("\n");
			return { content: [{ type: "text", text }], details };
		},
	});
}

export function cursorStatusTool() {
	return defineTool({
		name: "cloud_agent_status",
		label: "Cursor Cloud Status",
		description:
			"Read the status of a Cursor Cloud Agent and one of its runs (default: latest), including pushed branches, pull requests, and the final reply. Read-only.",
		promptSnippet: "Check the status and pull request of a dispatched Cursor Cloud Agent",
		promptGuidelines: [
			"Use cloud_agent_status to verify dispatched Cursor agents; Cursor's web agent list omits API-launched agents.",
		],
		parameters: Type.Object(
			{
				provider: Type.Literal("cursor", { description: "Cloud provider" }),
				agentId: Type.String({ pattern: "^bc-[A-Za-z0-9-]+$", description: "Cursor agent ID (bc-...)" }),
				runId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]+$", description: "Run ID; defaults to the agent's latest run" })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.provider !== "cursor") throw new Error("Unsupported cloud provider.");
			const { apiKey } = await ensureCursorCredential(ctx, signal);
			const agent = await notFound(
				getAgent(apiKey, params.agentId, signal),
				`Cursor has no agent ${params.agentId}.`,
			);
			const runId = params.runId ?? agent.latestRunId;
			const run = runId
				? await notFound(getRun(apiKey, agent.id, runId, signal), `Cursor agent ${agent.id} has no run ${runId}.`)
				: undefined;
			if (run?.result && run.result.length > MAX_RESULT_CHARS) {
				run.result = `${run.result.slice(0, MAX_RESULT_CHARS)}\n[truncated]`;
			}
			const details: CursorStatusDetails = { agent, run };
			return { content: [{ type: "text", text: statusText(agent, run) }], details };
		},
	});
}
