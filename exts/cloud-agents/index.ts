import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_RUN_ID_ENV } from "../shared/subagent-protocol.ts";
import { applyCodex } from "./codex/apply.ts";
import { dispatchCodex, setupCodex, statusCodex } from "./codex/index.ts";
import { FileCursorApiKeyStore, replaceCursorCredential } from "./cursor/auth.ts";
import { cursorDispatchTool, cursorStatusTool } from "./cursor/index.ts";

export const CLOUD_AGENT_TOOL = "cloud_agent";
export const CLOUD_STATUS_TOOL = "cloud_agent_status";
export const CLOUD_APPLY_TOOL = "cloud_agent_apply";
export const CLOUD_SETUP_COMMAND = "cloud-agent-setup";

function requireFields(input: Record<string, unknown>, required: string[], allowed: string[]): void {
	if (required.some((key) => typeof input[key] !== "string") ||
		Object.keys(input).some((key) => !allowed.includes(key))) {
		throw new Error("Invalid fields for the selected cloud provider.");
	}
}

export default function cloudAgents(pi: ExtensionAPI): void {
	// A supervisor's task is not a user instruction to dispatch externally.
	const cursorDispatch = cursorDispatchTool(pi);
	const cursorStatus = cursorStatusTool();
	if (!process.env[SUBAGENT_RUN_ID_ENV]) {
		pi.registerTool({
			...cursorDispatch,
			label: "Cloud Agent",
			promptSnippet: "Dispatch an approved, self-contained implementation plan to Cursor or Codex Cloud",
			description: "Use this tool, not bash or a direct codex cloud exec command, when the user explicitly asks you to dispatch a complete approved plan to Cursor or Codex Cloud. External, billable, write-capable operation. Cursor creates a branch and PR; Codex returns a task and reviewable diff, not a PR.",
			parameters: Type.Object({
				provider: Type.String({ enum: ["cursor", "codex"], description: "Cloud provider; select explicitly" }),
				plan: Type.String({ minLength: 1, description: "Complete, approved, self-contained plan" }),
				name: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Cursor agent name only" })),
				model: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Cursor model only" })),
				effort: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Cursor model effort only; requires model" })),
				environment: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Codex only; one-call environment ID or unique label override" })),
			}, { additionalProperties: false }),
			async execute(id, params, signal, update, ctx) {
				const input = params as { provider: string; plan: string; environment?: string; name?: string; model?: string; effort?: string };
				if (input.provider === "codex") {
					requireFields(input, ["provider", "plan"], ["provider", "plan", "environment"]);
					return dispatchCodex(pi, ctx, input.plan, input.environment, signal);
				}
				if (input.provider !== "cursor") throw new Error("Unsupported cloud provider.");
				requireFields(input, ["provider", "plan"], ["provider", "plan", "name", "model", "effort"]);
				return cursorDispatch.execute(id, input as Parameters<typeof cursorDispatch.execute>[1], signal, update, ctx);
			},
			promptGuidelines: [
				"Call cloud_agent only when the user explicitly instructs you to dispatch work to a cloud provider; never dispatch on your own initiative.",
				"Pass a complete, approved, self-contained implementation plan; the cloud agent receives no Pi conversation context.",
				"Before launch, ensure the plan can run from the selected remote's default-branch contents and the plan alone. Inspect relevant remote code when local context could affect that decision.",
				"Treat uncommitted files, unpushed commits, branch-only changes, and unmerged PRs as unavailable to cloud agents. A dirty or feature-branch checkout alone does not block independent work.",
				"If required prerequisites are unavailable or independence cannot be established, do not launch. Ask for prerequisites to land or for a separately approved standalone plan.",
				"Do not use cloud_agent for planning, brainstorming, or work the user asked you to perform locally.",
				"Do not automatically retry an uncertain launch failure because the first request may have created an agent.",
				"Dispatching with cloud_agent does not complete a backlog item; set it to in_progress and append its provider, IDs, and URL.",
				"For Cursor, mark a dispatched backlog item done only after cloud_agent_status shows its run FINISHED with a pull request. If it fails or finishes without a PR, append the outcome without marking done.",
				"For Codex, pass only an approved plan independent of local files and choose a verified environment for the selected GitHub remote. READY means a diff is ready, not a PR; do not claim completion or create a PR automatically.",
				"For Codex, record the task ID and URL in the backlog item. Do not mark done merely on READY; review and PR creation are separate work requiring authorization.",
			],
		});
	}
	pi.registerTool({
		...cursorStatus,
		label: "Cloud Agent Status",
		promptSnippet: "Check a Cursor run or Codex Cloud task",
		description: "Read Cursor agent/run status or Codex Cloud task status. Read-only; Codex READY indicates a diff for review, not a PR.",
		parameters: Type.Object({
			provider: Type.String({ enum: ["cursor", "codex"], description: "Cloud provider; select explicitly" }),
			agentId: Type.Optional(Type.String({ pattern: "^bc-[A-Za-z0-9-]+$", description: "Cursor agent ID" })),
			runId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]+$", description: "Cursor run ID (defaults to latest)" })),
			taskId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", description: "Codex task ID" })),
		}, { additionalProperties: false }),
		promptGuidelines: [
			"Use cloud_agent_status to verify Cursor agents; Cursor's web agent list omits API-launched agents.",
			"Codex READY indicates a diff to review, not a PR. For Codex, use the task ID returned by launch, not a recent-task guess.",
		],
		async execute(id, params, signal, update, ctx) {
			const input = params as { provider: string; taskId?: string; agentId?: string; runId?: string };
			if (input.provider === "codex") {
				requireFields(input, ["provider", "taskId"], ["provider", "taskId"]);
				return statusCodex(input.taskId!, signal);
			}
			if (input.provider !== "cursor") throw new Error("Unsupported cloud provider.");
			requireFields(input, ["provider", "agentId"], ["provider", "agentId", "runId"]);
			return cursorStatus.execute(id, input as Parameters<typeof cursorStatus.execute>[1], signal, update, ctx);
		},
	});

	// Applying a cloud patch is not an instruction for a subagent to modify its supervisor's repository.
	if (!process.env[SUBAGENT_RUN_ID_ENV]) {
		pi.registerTool({
			name: CLOUD_APPLY_TOOL,
			label: "Apply Codex Cloud Task",
			description: "Apply a READY Codex Cloud task's patch to the current clean Git worktree. Use only when the user requested local application or the approved plan includes it; confirm the task belongs to this repository because Codex does not expose a verifiable repository binding. This tool is write-capable and auto-approved. It does not create a branch, commit, push, or open a PR.",
			promptSnippet: "Apply a READY Codex task to the current clean checkout when authorized",
			promptGuidelines: [
				"Use cloud_agent_apply only when the user requested local handoff or an approved plan includes it. A READY status alone is not permission to apply.",
				"Prepare the appropriate checkout first. The tool requires a clean Git worktree, applies the task's diff there, and leaves edits unstaged and uncommitted; it cannot verify that the task came from that repository.",
				"After applying, inspect the diff and run validation. Commit, push, and PR creation remain separate authorized actions; do not mark a backlog item done merely because a patch applied.",
			],
			parameters: Type.Object({
				provider: Type.Literal("codex"),
				taskId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", description: "Codex Cloud task ID" }),
				attempt: Type.Optional(Type.Integer({ minimum: 1, description: "1-based attempt number; omit for the CLI's default attempt" })),
			}, { additionalProperties: false }),
			executionMode: "sequential",
			async execute(_id, params, signal, _update, ctx) {
				if (params.provider !== "codex") throw new Error("Unsupported cloud provider.");
				return applyCodex(pi, ctx, params.taskId, params.attempt, signal);
			},
		});
	}

	pi.registerCommand(CLOUD_SETUP_COMMAND, {
		description: "Configure a cloud agent provider",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("Run /cloud-agent-setup in an interactive Pi session.", "warning");
				return;
			}
			const provider = await ctx.ui.select("Cloud agent provider", ["Cursor", "Codex"]);
			if (provider === "Codex") {
				try { await setupCodex(pi, ctx); }
				catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Codex setup failed.", "error"); }
				return;
			}
			if (provider !== "Cursor") return;
			const action = await ctx.ui.select("Cursor Cloud API key", ["Set or replace", "Clear"]);
			try {
				if (action === "Set or replace") await replaceCursorCredential(ctx, ctx.signal);
				if (action === "Clear") {
					if (!await ctx.ui.confirm("Clear Cursor Cloud API key?", "A new key will be required before the next dispatch.")) return;
					await new FileCursorApiKeyStore().clear();
					ctx.ui.notify("Cursor Cloud API key cleared.", "info");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Cursor setup failed.", "error");
			}
		},
	});
}
