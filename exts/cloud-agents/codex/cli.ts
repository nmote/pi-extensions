import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_OUTPUT = 8192;
const TIMEOUT_MS = 30_000;

export interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	interrupted: boolean;
}
export type CliRunner = (args: string[], input?: string, signal?: AbortSignal) => Promise<CliResult>;

function redact(text: string, input?: string): string {
	let clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ");
	if (input) clean = clean.split(input).join("[redacted plan]");
	return clean.replace(/(authorization\s*[:=]\s*(?:Bearer\s+)?|Bearer\s+|["']?(?:access[_-]?token|api[_-]?key|token)["']?\s*[:=]\s*["']?)[^\s,;"']+/gi, "$1[redacted]");
}

// Every invocation has a private cwd: the CLI may write error.log even on read-only operations.
export const runCodex: CliRunner = async (args, input, signal) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-codex-cloud-"));
	try {
		return await new Promise<CliResult>((resolve, reject) => {
			if (signal?.aborted) { reject(new Error("Codex command cancelled.")); return; }
			const child = spawn("codex", args, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: true, env: process.env });
			let stdout = "", stderr = "", truncated = false, interrupted = false, settled = false;
			const collect = (which: "stdout" | "stderr", chunk: Buffer) => {
				const value = which === "stdout" ? stdout : stderr;
				const remaining = MAX_OUTPUT - value.length;
				if (chunk.length > remaining) truncated = true;
				if (which === "stdout") stdout += chunk.toString("utf8", 0, Math.max(0, remaining));
				else stderr += chunk.toString("utf8", 0, Math.max(0, remaining));
			};
			child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
			child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const killGroup = (signal: NodeJS.Signals) => {
				if (!child.pid) return;
				try { process.kill(-child.pid, signal); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal); }
			};
			const stop = () => {
				if (interrupted) return;
				interrupted = true;
				killGroup("SIGTERM");
				killTimer = setTimeout(() => killGroup("SIGKILL"), 1000);
			};
			const timer = setTimeout(stop, TIMEOUT_MS);
			const abort = () => stop();
			signal?.addEventListener("abort", abort, { once: true });
			const finish = (error?: Error, code: number | null = null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (killTimer) clearTimeout(killTimer);
				signal?.removeEventListener("abort", abort);
				if (error) reject(error);
				else resolve({ code, stdout: redact(stdout, input), stderr: redact(stderr, input), truncated, interrupted });
			};
			child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT"
				? new Error("Codex CLI is unavailable. Install codex and run codex login outside Pi.")
				: new Error("Could not start Codex CLI.")));
			child.on("close", (code) => finish(undefined, code));
			child.stdin.on("error", () => { /* The process may exit before consuming its input. */ });
			child.stdin.end(input ?? "");
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
};

export function cliFailure(result: CliResult, operation: string): never {
	if (result.interrupted) throw new Error(`${operation} timed out or was cancelled.`);
	if (result.truncated) throw new Error(`${operation} produced too much output.`);
	const diagnostic = (result.stderr || result.stdout).slice(0, 500);
	throw new Error(`${operation} failed${diagnostic ? `: ${diagnostic}` : "."} Check Codex cloud access; run codex login outside Pi if needed.`);
}

export async function checkCodexReady(run: CliRunner, signal?: AbortSignal): Promise<void> {
	const login = await run(["login", "status"], undefined, signal);
	if (login.code !== 0 || login.interrupted || login.truncated || !/logged in using chatgpt/i.test(`${login.stdout}\n${login.stderr}`)) {
		throw new Error("Codex cloud requires ChatGPT sign-in. Run codex login outside Pi (API-key-only sign-in does not grant cloud access).");
	}
}

export async function validateEnvironment(run: CliRunner, environment: string, signal?: AbortSignal): Promise<void> {
	if (!environment || environment.length > 200 || /[\x00-\x1f\x7f]/.test(environment) || environment.startsWith("-")) {
		throw new Error("Enter an environment ID or unique label from codex cloud (press o).");
	}
	const result = await run(["cloud", "list", "--env", environment, "--json", "--limit", "1"], undefined, signal);
	if (result.code !== 0 || result.interrupted || result.truncated) cliFailure(result, "Codex environment lookup");
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		if (!Array.isArray(parsed) && (!parsed || typeof parsed !== "object")) throw new Error("invalid");
	} catch {
		throw new Error("Codex environment lookup returned invalid JSON. Confirm the environment ID or unique label in codex cloud (press o).");
	}
}
