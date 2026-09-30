import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CliRunner, runCodex } from "./cli.ts";
import { inspectCursorRepository } from "../cursor/repository.ts";
import { statusCodex } from "./index.ts";

const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4096;

type ProcessResult = { code: number | null; stdout: Buffer; interrupted: boolean; truncated: boolean };

async function runProcess(command: string, args: string[], cwd: string, input: Buffer | undefined, maxOutput: number, signal?: AbortSignal, outputLimitFatal = true): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(new Error(`${command} cancelled.`)); return; }
		const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: true });
		const chunks: Buffer[] = [];
		let size = 0, truncated = false, interrupted = false, settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const killGroup = (sig: NodeJS.Signals) => {
			if (!child.pid) return;
			try { process.kill(-child.pid, sig); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(sig); }
		};
		const stop = () => {
			if (interrupted) return;
			interrupted = true;
			killGroup("SIGTERM");
			killTimer = setTimeout(() => killGroup("SIGKILL"), 1000);
		};
		const timer = setTimeout(stop, command === "git" ? 10_000 : 30_000);
		const abort = () => stop();
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			if (size + chunk.length > maxOutput) {
				if (outputLimitFatal) { truncated = true; stop(); }
				return;
			}
			size += chunk.length;
			chunks.push(chunk);
		});
		// Drain diagnostics without terminating a Git command that may be writing files.
		child.stderr.on("data", () => {});
		const finish = (error?: Error, code: number | null = null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve({ code, stdout: Buffer.concat(chunks), truncated, interrupted });
		};
		child.on("error", (error: NodeJS.ErrnoException) => finish(new Error(error.code === "ENOENT" ? `${command} is not installed.` : `Could not start ${command}.`)));
		child.on("close", (code) => finish(undefined, code));
		child.stdin.on("error", () => { /* An early exit may close stdin. */ });
		child.stdin.end(input);
	});
}

export async function fetchCodexPatch(taskId: string, attempt?: number, signal?: AbortSignal): Promise<Buffer> {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) throw new Error("Invalid Codex task ID.");
	if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) throw new Error("Codex attempt must be a positive integer.");
	const cwd = await mkdtemp(join(tmpdir(), "pi-codex-diff-"));
	try {
		const args = ["cloud", "diff", ...(attempt === undefined ? [] : ["--attempt", String(attempt)]), taskId];
		const result = await runProcess("codex", args, cwd, undefined, MAX_DIFF_BYTES, signal);
		if (result.truncated) throw new Error("Codex diff exceeds the supported output limit.");
		if (result.interrupted) throw new Error("Codex diff lookup timed out or was cancelled.");
		if (result.code !== 0 || !result.stdout.subarray(0, 11).equals(Buffer.from("diff --git "))) {
			throw new Error("Could not retrieve a Git patch for this Codex task and attempt.");
		}
		return result.stdout;
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

export interface ApplyDependencies {
	run?: CliRunner;
	fetchPatch?: typeof fetchCodexPatch;
}

export async function applyCodex(pi: ExtensionAPI, ctx: ExtensionContext, taskId: string, attempt?: number, signal?: AbortSignal, deps: ApplyDependencies = {}) {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) throw new Error("Invalid Codex task ID.");
	if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) throw new Error("Codex attempt must be a positive integer.");
	const { repositoryUrl } = await inspectCursorRepository(pi, ctx.cwd, signal);
	const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, signal, timeout: 10_000 });
	if (root.code !== 0 || root.killed || !root.stdout.trim()) throw new Error("Could not identify the Git worktree root.");
	const cwd = root.stdout.trim();
	const verifyClean = async () => {
		const clean = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, signal, timeout: 10_000 });
		if (clean.code !== 0 || clean.killed || signal?.aborted) throw new Error("Could not verify that the Git worktree is clean.");
		if (clean.stdout.trim()) throw new Error("The Git worktree must be clean before applying a Codex patch.");
	};
	await verifyClean();
	const status = await statusCodex(taskId, signal, deps.run ?? runCodex);
	if (status.details.status !== "READY") throw new Error(`Codex task ${taskId} is ${status.details.status}; a READY task is required to apply its patch.`);
	const patch = await (deps.fetchPatch ?? fetchCodexPatch)(taskId, attempt, signal);
	await verifyClean();
	const checked = await runProcess("git", ["apply", "--whitespace=nowarn", "--check", "--"], cwd, patch, MAX_DIAGNOSTIC_BYTES, signal);
	if (checked.interrupted || checked.truncated || checked.code !== 0) throw new Error("Codex patch does not apply cleanly; the worktree was not changed.");
	const stats = await runProcess("git", ["apply", "--numstat", "--"], cwd, patch, MAX_DIAGNOSTIC_BYTES, signal);
	if (stats.interrupted || stats.truncated || stats.code !== 0) throw new Error("Could not summarize the Codex patch; the worktree was not changed.");
	const paths = stats.stdout.toString("utf8").trim().split("\n").filter(Boolean).map((line) => line.split("\t").slice(2).join("\t"));
	if (!paths.length || paths.some((path) => !path)) throw new Error("Codex patch has no identifiable files.");
	if (signal?.aborted) throw new Error("Codex patch application cancelled before changing the worktree.");
	const applied = await runProcess("git", ["apply", "--whitespace=nowarn", "--"], cwd, patch, MAX_DIAGNOSTIC_BYTES, undefined, false);
	if (applied.interrupted || applied.truncated || applied.code !== 0) throw new Error("Git apply did not complete successfully. Inspect the worktree before retrying.");
	const files = paths.length;
	const sha256 = createHash("sha256").update(patch).digest("hex");
	return {
		content: [{ type: "text" as const, text: `Applied Codex task ${taskId}${attempt === undefined ? " (CLI default attempt)" : ` (attempt ${attempt})`} to the current worktree.\nRepository: ${repositoryUrl}\nFiles in patch: ${paths.join(", ")}\nPatch SHA-256: ${sha256}\nChanges are unstaged and uncommitted. Review these files (including any ignored paths) and run validation before committing or opening a PR.` }],
		details: { provider: "codex" as const, taskId, attempt, repository: repositoryUrl, files, sha256 },
	};
}
