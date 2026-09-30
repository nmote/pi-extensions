import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cloudAgents from "../index.ts";
import { runCodex, validateEnvironment, type CliResult, type CliRunner } from "./cli.ts";
import { CodexEnvironmentStore } from "./config.ts";
import { dispatchCodex, setupCodex, statusCodex } from "./index.ts";

let failures = 0;
function check(label: string, ok: boolean) {
	if (ok) console.log(`  ok  ${label}`);
	else { failures++; console.error(`FAIL  ${label}`); }
}
async function errorOf(fn: () => Promise<unknown>): Promise<string> {
	try { await fn(); return ""; } catch (error) { return String(error); }
}
const response = (stdout: string, code = 0, stderr = ""): CliResult => ({ stdout, stderr, code, truncated: false, interrupted: false });

async function main() {
	const temp = await mkdtemp(join(tmpdir(), "pi-codex-test-"));
	const originalPath = process.env.PATH;
	try {
		const store = new CodexEnvironmentStore(join(temp, "config", "codex-cloud.json"));
		const calls: Array<{ args: string[]; input?: string }> = [];
		let listResult = response("[]");
		let launchResult = response("Task submitted: https://chatgpt.com/codex/tasks/task_123\n");
		let loginResult = response("Logged in using ChatGPT\n");
		let statusResult = response("[PENDING] pending\n", 1);
		const run: CliRunner = async (args, input) => {
			calls.push({ args, input });
			if (args.join(" ") === "login status") return loginResult;
			if (args[1] === "list") return listResult;
			if (args[1] === "exec") return launchResult;
			if (args[1] === "status") return statusResult;
			throw new Error(`unexpected CLI args: ${args}`);
		};
		const gitCalls: string[] = [];
		let invalidBranch = false;
		let remote = "git@github.com:example/one.git";
		const pi = {
			async exec(command: string, args: string[]) {
				const key = args.join(" "); gitCalls.push(key);
				if (command !== "git") throw new Error("unexpected command");
				if (key === "rev-parse --is-inside-work-tree") return { stdout: "true\n", code: 0 };
				if (key === "remote") return { stdout: "origin\n", code: 0 };
				if (key === "remote get-url origin") return { stdout: remote + "\n", code: 0 };
				if (key.startsWith("ls-remote --symref")) return { stdout: invalidBranch ? "abc\tHEAD\n" : "ref: refs/heads/main\tHEAD\nabc\tHEAD\n", code: 0 };
				if (key.startsWith("ls-remote --exit-code")) return { stdout: `${"a".repeat(40)}\trefs/heads/main\n`, code: 0 };
				throw new Error(`unexpected git: ${key}`);
			},
		} as unknown as ExtensionAPI;
		const dialogs: Array<{ title: string; message?: string }> = [];
		let confirm = true;
		let choice = "env-one";
		let action = "Set or change environment";
		const ctx = {
			cwd: "/workspace", mode: "tui", hasUI: true, signal: undefined,
			ui: {
				notify: () => undefined,
				select: async () => action,
				input: async (title: string, placeholder: string) => { dialogs.push({ title, message: placeholder }); return choice; },
				confirm: async (title: string, message: string) => { dialogs.push({ title, message }); return confirm; },
			},
		} as any;
		const deps = { run, store };
		const repository = "https://github.com/example/one";
		await setupCodex(pi, ctx, deps);
		check("empty task history validates an environment and saves a per-remote binding", await store.load(repository) === choice && calls.some(({ args }) => args.join(" ") === "cloud list --env env-one --json --limit 1"));
		check("setup dialog explains how to find the environment before prompting for it",
			dialogs[0]?.title === "Find your Codex environment" &&
			[repository, "codex cloud", "Press o", "repository hint"].every((text) => dialogs[0]?.message?.includes(text)) &&
			dialogs[1]?.title.startsWith("Codex environment for") === true &&
			dialogs[1]?.message?.includes("ID or unique label") === true);
		check("mapping is private and atomic", (await stat(store.path)).mode & 0o777 ? ((await stat(store.path)).mode & 0o777) === 0o600 && (await readdir(join(temp, "config"))).length === 1 : false);
		const launched = await dispatchCodex(pi, ctx, "Approved plan\nwith details", undefined, undefined, deps);
		check("launch passes explicit remote default branch, environment and complete plan via stdin", calls.some(({ args, input }) => args.join(" ") === "cloud exec --env env-one --branch main -" && input === "Approved plan\nwith details") && launched.details.taskId === "task_123");
		check("remote selection and branch validation use only read-only Git", gitCalls.some((c) => c === "ls-remote --symref -- origin HEAD") && gitCalls.some((c) => c.endsWith("refs/heads/main")));
		remote = "https://github.com/example/two.git";
		const nonTui = { ...ctx, mode: "print", hasUI: false };
		const missing = await errorOf(() => dispatchCodex(pi, nonTui, "plan", undefined, undefined, deps));
		check("unbound remote fails in non-TUI mode without launching", missing.includes("/cloud-agent-setup") && !calls.some(({ args }) => args[1] === "exec" && args.includes("two")));
		const override = await dispatchCodex(pi, nonTui, "override plan", "one-off", undefined, deps);
		check("one-call override is not saved", override.details.environment === "one-off" && await store.load("https://github.com/example/two") === undefined);
		remote = "git@github.com:example/one.git";
		action = "Clear environment"; confirm = false;
		await setupCodex(pi, ctx, deps);
		check("cancelled clear preserves mapping", await store.load(repository) === "env-one");
		confirm = true; await setupCodex(pi, ctx, deps);
		check("confirmed clear removes only current remote binding", await store.load(repository) === undefined);
		listResult = response("", 1, "Ambiguous environment label");
		action = "Set or change environment";
		const ambiguous = await errorOf(() => setupCodex(pi, ctx, deps));
		check("ambiguous labels do not bind", ambiguous.includes("Ambiguous") && await store.load(repository) === undefined);
		listResult = response("[]");
		loginResult = response("Logged in using an API key\n");
		const auth = await errorOf(() => dispatchCodex(pi, ctx, "plan", undefined, undefined, deps));
		check("API-key-only login is rejected with ChatGPT login instructions", auth.includes("codex login") && auth.includes("ChatGPT"));
		loginResult = response("", 0, "Logged in using ChatGPT\n");
		invalidBranch = true;
		const badBranch = await errorOf(() => dispatchCodex(pi, ctx, "plan", "override", undefined, deps));
		check("unknown default branch fails closed before launch", badBranch.includes("default branch is unknown"));
		invalidBranch = false;
		launchResult = response("no task URL\n");
		const uncertain = await errorOf(() => dispatchCodex(pi, ctx, "plan", "override", undefined, deps));
		check("missing URL reports uncertain launch without guessing", uncertain.includes("uncertain") && uncertain.includes("do not infer"));
		launchResult = response("https://chatgpt.com/codex/tasks/abc https://chatgpt.com/codex/tasks/def");
		check("multiple URLs are uncertain", (await errorOf(() => dispatchCodex(pi, ctx, "plan", "override", undefined, deps))).includes("uncertain"));
		for (const [value, code] of [["PENDING", 1], ["READY", 0], ["APPLIED", 1], ["ERROR", 1]] as const) {
			statusResult = response(`[${value}] task\n`, code);
			const result = await statusCodex("task_123", undefined, run);
			check(`direct task status recognizes ${value} with exit ${code}`, result.details.status === value && calls.at(-1)?.args.join(" ") === "cloud status task_123");
		}
		statusResult = response("other output", 1);
		check("unrecognized status is UNKNOWN", (await statusCodex("task_123", undefined, run)).details.status === "UNKNOWN");
		statusResult = response("[READY] task", 1);
		check("nonzero READY is not treated as ready", (await statusCodex("task_123", undefined, run)).details.status === "UNKNOWN");
		check("invalid task IDs fail before CLI call", (await errorOf(() => statusCodex("-bad", undefined, run))).includes("Invalid"));
		check("invalid environment fails before CLI call", (await errorOf(() => validateEnvironment(run, "--branch"))).includes("Enter an environment"));
		const tools = new Map<string, any>();
		const commands = new Map<string, any>();
		cloudAgents({ ...pi, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command) } as ExtensionAPI);
		check("generic tools expose both providers in top-level object schemas", tools.get("cloud_agent")?.parameters?.properties?.environment && tools.get("cloud_agent_status")?.parameters?.properties?.taskId && tools.get("cloud_agent")?.parameters?.type === "object" && !!commands.get("cloud-agent-setup"));
		check("mixed-provider dispatch fields are rejected before CLI calls", (await errorOf(() => tools.get("cloud_agent").execute("bad", { provider: "codex", plan: "plan", model: "x" }, undefined, undefined, ctx))).includes("Invalid fields"));
		check("mixed-provider status fields are rejected", (await errorOf(() => tools.get("cloud_agent_status").execute("bad", { provider: "codex", taskId: "task_123", agentId: "bc-123" }, undefined, undefined, ctx))).includes("Invalid fields"));

		const bin = join(temp, "codex");
		await writeFile(bin, '#!/bin/sh\nprintf "%s\\n" "$PWD"\nprintf "%s\\n" "$(cat)"\ntouch error.log\n', { mode: 0o700 });
		await chmod(bin, 0o700);
		process.env.PATH = `${temp}:${originalPath ?? ""}`;
		const actual = await runCodex(["cloud", "exec", "--env", "env", "--branch", "main", "-"], "secret-plan");
		const cwd = actual.stdout.split("\n")[0];
		check("CLI uses private temporary cwd, redacts echoed plan, and cleans side effects", cwd.includes("pi-codex-cloud-") && actual.stdout.includes("[redacted plan]") && !actual.stdout.includes("secret-plan") && (await errorOf(() => stat(cwd))).includes("ENOENT"));
		await writeFile(bin, '#!/bin/sh\ni=0; while [ "$i" -lt 10000 ]; do printf x; i=$((i+1)); done\n', { mode: 0o700 });
		const bounded = await runCodex(["cloud", "status", "task_123"]);
		check("CLI stdout is bounded and reports truncation", bounded.truncated && bounded.stdout.length <= 8192);
		await writeFile(bin, '#!/bin/sh\nprintf "Authorization: Bearer secret-token\\n" >&2\nprintf "\\"access_token\\":\\"hidden-secret\\"\\n" >&2\n', { mode: 0o700 });
		const redacted = await runCodex(["cloud", "list"]);
		check("CLI diagnostics redact bearer and JSON tokens", !redacted.stderr.includes("secret-token") && !redacted.stderr.includes("hidden-secret"));
		await writeFile(bin, '#!/bin/sh\nsleep 60 &\nwait\n', { mode: 0o700 });
		const controller = new AbortController();
		const start = Date.now();
		setTimeout(() => controller.abort(), 50);
		const stopped = await runCodex(["cloud", "exec"], "plan", controller.signal);
		check("abort terminates wrapper and child process group promptly", stopped.interrupted && Date.now() - start < 4000);
		process.env.PATH = join(temp, "missing");
		check("missing CLI is actionable", (await errorOf(() => runCodex(["login", "status"]))).includes("Install codex"));
	} finally {
		if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
		await rm(temp, { recursive: true, force: true });
	}
	if (failures) process.exitCode = 1;
	else console.log("\nall checks passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
