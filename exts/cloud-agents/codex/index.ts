import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkCodexReady, cliFailure, runCodex, validateEnvironment, type CliRunner } from "./cli.ts";
import { CodexEnvironmentStore } from "./config.ts";
import { inspectCodexRepository } from "./repository.ts";
import { inspectCursorRepository } from "../cursor/repository.ts";

export interface CodexDependencies {
	run?: CliRunner;
	store?: CodexEnvironmentStore;
}

async function bindEnvironment(ctx: ExtensionContext, repository: string, run: CliRunner, store: CodexEnvironmentStore, signal?: AbortSignal): Promise<string> {
	if (!ctx.hasUI || ctx.mode !== "tui") throw new Error(`No Codex environment bound to ${repository}. Run /cloud-agent-setup in an interactive Pi session, or pass an explicit environment.`);
	if (!await ctx.ui.confirm("Find your Codex environment", `Repository: ${repository}\n\nIn another terminal:\n1. Run codex cloud.\n2. Press o to open the environment picker.\n3. Find the environment whose repository hint matches this repository.\n4. Copy its ID or unique label, then return here.\n\nReady to enter it?`)) {
		throw new Error("Codex environment setup cancelled.");
	}
	const environment = (await ctx.ui.input(`Codex environment for ${repository}`, "Paste the environment ID or unique label"))?.trim();
	if (!environment) throw new Error("Codex environment setup cancelled.");
	await validateEnvironment(run, environment, signal);
	if (!await ctx.ui.confirm(`Bind ${environment} to ${repository}?`, "Confirm in codex cloud that this environment clones this repository. Task history alone does not prove the mapping.")) {
		throw new Error("Codex environment binding cancelled.");
	}
	await store.set(repository, environment);
	ctx.ui.notify(`Codex environment saved for ${repository}.`, "info");
	return environment;
}

export async function setupCodex(pi: ExtensionAPI, ctx: ExtensionContext, deps: CodexDependencies = {}): Promise<void> {
	const run = deps.run ?? runCodex;
	const store = deps.store ?? new CodexEnvironmentStore();
	await checkCodexReady(run, ctx.signal);
	const { repositoryUrl } = await inspectCursorRepository(pi, ctx.cwd, ctx.signal);
	const saved = await store.load(repositoryUrl);
	const action = await ctx.ui.select(`Codex: ${repositoryUrl}${saved ? ` (${saved})` : " (not bound)"}`, ["Set or change environment", "Clear environment"]);
	if (action === "Set or change environment") await bindEnvironment(ctx, repositoryUrl, run, store, ctx.signal);
	if (action === "Clear environment") {
		if (!saved || !await ctx.ui.confirm(`Clear Codex environment for ${repositoryUrl}?`, "The next dispatch will require a new binding or explicit environment.")) return;
		await store.set(repositoryUrl);
		ctx.ui.notify(`Codex environment cleared for ${repositoryUrl}.`, "info");
	}
}

export async function dispatchCodex(
	pi: ExtensionAPI, ctx: ExtensionContext, plan: string, override?: string, signal?: AbortSignal, deps: CodexDependencies = {},
) {
	if (!plan.trim()) throw new Error("The Codex Cloud implementation plan cannot be blank.");
	const run = deps.run ?? runCodex;
	const store = deps.store ?? new CodexEnvironmentStore();
	await checkCodexReady(run, signal);
	const { repositoryUrl, branch } = await inspectCodexRepository(pi, ctx.cwd, signal);
	const saved = override === undefined ? await store.load(repositoryUrl) : undefined;
	if (override !== undefined && !override.trim()) throw new Error("Codex environment override cannot be blank.");
	const environment = override?.trim() || saved || await bindEnvironment(ctx, repositoryUrl, run, store, signal);
	await validateEnvironment(run, environment, signal);
	// No retry: a failed or interrupted CLI call may have submitted a task.
	let result;
	try {
		result = await run(["cloud", "exec", "--env", environment, "--branch", branch, "-"], plan.trim(), signal);
	} catch {
		throw new Error("Codex launch outcome is uncertain. Inspect Codex cloud tasks before retrying; do not infer the ID from the latest task.");
	}
	const urls = result.stdout.match(/https?:\/\/\S+/g) ?? [];
	const url = urls.length === 1 && /^https:\/\/chatgpt\.com\/codex\/tasks\/[A-Za-z0-9_-]+$/.test(urls[0]) ? urls[0] : undefined;
	if (result.code !== 0 || result.interrupted || result.truncated || !url) {
		throw new Error("Codex launch outcome is uncertain. Inspect Codex cloud tasks before retrying; do not infer the ID from the latest task.");
	}
	const taskId = url.slice(url.lastIndexOf("/") + 1);
	return {
		content: [{ type: "text" as const, text: `Codex Cloud task submitted; work is not complete. Check cloud_agent_status.\nTask: ${taskId}\nURL: ${url}\nSelected remote: ${repositoryUrl}\nRemote default branch: ${branch}\nConfirm the Codex environment clones this remote; the CLI lookup cannot verify its repository. Codex presents a diff for review; PR creation is separate.` }],
		details: { provider: "codex" as const, taskId, url, repository: repositoryUrl, branch, environment },
	};
}

export async function statusCodex(taskId: string, signal?: AbortSignal, run: CliRunner = runCodex) {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) throw new Error("Invalid Codex task ID.");
	await checkCodexReady(run, signal);
	const result = await run(["cloud", "status", taskId], undefined, signal);
	const match = !result.interrupted && !result.truncated ? /^\[(PENDING|READY|APPLIED|ERROR)\](?=\s|$)/m.exec(result.stdout) : null;
	const status = match && (match[1] !== "READY" || result.code === 0) ? match[1] : "UNKNOWN";
	// Non-READY statuses exit nonzero. Unknown output is never interpreted as success.
	if (result.interrupted) cliFailure(result, "Codex status lookup");
	return {
		content: [{ type: "text" as const, text: `Codex task ${taskId}: ${status}${status === "READY" ? " (diff ready for review; no PR implied)" : ""}${status === "UNKNOWN" ? ". Check codex cloud directly; CLI output was unrecognized." : ""}\nURL: https://chatgpt.com/codex/tasks/${taskId}` }],
		details: { provider: "codex" as const, taskId, status, url: `https://chatgpt.com/codex/tasks/${taskId}` },
	};
}
