import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cloudAgents from "../index.ts";
import { SUBAGENT_RUN_ID_ENV } from "../../shared/subagent-protocol.ts";
import { applyCodex, fetchCodexPatch } from "./apply.ts";
import type { CliRunner } from "./cli.ts";

let failures = 0;
function check(label: string, value: boolean) {
	if (value) console.log(`  ok  ${label}`);
	else { failures++; console.error(`FAIL  ${label}`); }
}
async function errorOf(run: () => Promise<unknown>) {
	try { await run(); return ""; } catch (error) { return String(error); }
}

async function main() {
	const temp = await mkdtemp(join(tmpdir(), "pi-codex-apply-test-"));
	const oldPath = process.env.PATH;
	const oldPatch = process.env.PI_FAKE_PATCH;
	const oldArgs = process.env.PI_FAKE_ARGS_LOG;
	const oldCwd = process.env.PI_FAKE_CWD_LOG;
	const oldSubagent = process.env[SUBAGENT_RUN_ID_ENV];
	try {
		delete process.env[SUBAGENT_RUN_ID_ENV];
		const root = join(temp, "checkout");
		const patchFile = join(temp, "patch");
		const argsFile = join(temp, "args");
		const cwdFile = join(temp, "cwd");
		const bin = join(temp, "codex");
		await mkdir(root);
		const patch = "diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n";
		await writeFile(patchFile, patch);
		await writeFile(bin, '#!/bin/sh\nprintf "%s\\n" "$PWD" > "$PI_FAKE_CWD_LOG"\nprintf "%s\\n" "$@" > "$PI_FAKE_ARGS_LOG"\ntouch error.log\ncat "$PI_FAKE_PATCH"\n', { mode: 0o700 });
		await chmod(bin, 0o700);
		process.env.PATH = `${temp}:${oldPath ?? ""}`;
		process.env.PI_FAKE_PATCH = patchFile;
		process.env.PI_FAKE_ARGS_LOG = argsFile;
		process.env.PI_FAKE_CWD_LOG = cwdFile;
		let dirty = false;
		let state = "READY";
		let gitCalls = 0;
		let codexCalls = 0;
		const result = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });
		const pi = {
			async exec(command: string, args: string[]) {
				gitCalls++;
				if (command !== "git") throw new Error("unexpected command");
				switch (args.join(" ")) {
					case "rev-parse --is-inside-work-tree": return result("true\n");
					case "remote": return result("origin\n");
					case "remote get-url origin": return result("git@github.com:example/project.git\n");
					case "rev-parse --show-toplevel": return result(`${root}\n`);
					case "status --porcelain=v1 --untracked-files=all": return result(dirty ? "?? existing.txt\n" : "");
					default: throw new Error(`unexpected git: ${args.join(" ")}`);
				}
			},
		} as unknown as ExtensionAPI;
		const ctx = { cwd: root } as any;
		const run: CliRunner = async (args) => {
			codexCalls++;
			return { code: args[0] === "login" || state === "READY" ? 0 : 1, stdout: args[0] === "login" ? "Logged in using ChatGPT" : `[${state}] task`, stderr: "", truncated: false, interrupted: false };
		};
		const deps = { run };
		const invalid = await errorOf(() => applyCodex(pi, ctx, "-bad", undefined, undefined, deps));
		check("invalid task IDs fail before Git or cloud calls", invalid.includes("Invalid Codex task ID") && gitCalls === 0 && codexCalls === 0);
		dirty = true;
		const notClean = await errorOf(() => applyCodex(pi, ctx, "task_123", undefined, undefined, deps));
		check("dirty checkout fails before downloading a patch", notClean.includes("must be clean") && codexCalls === 0);
		dirty = false;
		state = "PENDING";
		const pending = await errorOf(() => applyCodex(pi, ctx, "task_123", undefined, undefined, deps));
		check("pending task is rejected before downloading", pending.includes("PENDING") && await errorOf(() => readFile(argsFile)) !== "");
		state = "READY";
		const changedWhileDownloading = await errorOf(() => applyCodex(pi, ctx, "task_123", undefined, undefined, {
			run,
			fetchPatch: async () => { dirty = true; return Buffer.from(patch); },
		}));
		check("edits made while downloading prevent application", changedWhileDownloading.includes("must be clean") && (await errorOf(() => stat(join(root, "new.txt")))).includes("ENOENT"));
		dirty = false;
		const applied = await applyCodex(pi, ctx, "task_123", 1, undefined, deps);
		const privateCwd = (await readFile(cwdFile, "utf8")).trim();
		check("the exact fetched bytes are applied to the current checkout", (await readFile(join(root, "new.txt"), "utf8")) === "hello\n" && applied.details.repository === "https://github.com/example/project");
		check("diff fetch uses an explicit attempt, private cwd, and cleans up CLI side effects",
			(await readFile(argsFile, "utf8")).trim().split("\n").join(" ") === "cloud diff --attempt 1 task_123" &&
			privateCwd.includes("pi-codex-diff-") && !privateCwd.startsWith(root) && (await errorOf(() => stat(privateCwd))).includes("ENOENT"));
		check("the tool reports patched paths and uncommitted changes", applied.content[0]?.text.includes("new.txt") === true && applied.content[0]?.text.includes("unstaged and uncommitted") === true);
		const second = await errorOf(() => applyCodex(pi, ctx, "task_123", undefined, undefined, deps));
		check("a second application fails without altering existing edits", second.includes("does not apply cleanly") && (await readFile(join(root, "new.txt"), "utf8")) === "hello\n");
		await rm(join(root, "new.txt"));
		await writeFile(join(root, "new.txt"), "different\n");
		const conflict = await errorOf(() => applyCodex(pi, ctx, "task_123", undefined, undefined, deps));
		check("failed applicability check preserves the checkout", conflict.includes("does not apply cleanly") && (await readFile(join(root, "new.txt"), "utf8")) === "different\n");
		await rm(join(root, "new.txt"));
		const longLine = "x".repeat(2000) + " ";
		const whitespacePatch = `diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,10 @@\n${Array(10).fill(`+${longLine}`).join("\n")}\n`;
		await writeFile(patchFile, whitespacePatch);
		const whitespaceResult = await applyCodex(pi, ctx, "task_123", undefined, undefined, deps);
		check("whitespace warnings cannot interrupt application or change patch bytes", whitespaceResult.details.files === 1 && (await readFile(join(root, "new.txt"), "utf8")) === `${Array(10).fill(longLine).join("\n")}\n`);
		await rm(join(root, "new.txt"));
		await writeFile(patchFile, "diff --git a/new.txt b/new.txt\n" + "x".repeat(5 * 1024 * 1024));
		const oversized = await errorOf(() => fetchCodexPatch("task_123"));
		check("oversized diffs are refused", oversized.includes("output limit"));
		const tools = new Map<string, any>();
		const register = { ...pi, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => undefined } as ExtensionAPI;
		cloudAgents(register);
		check("apply tool has a Codex-only schema and sequential execution", tools.get("cloud_agent_apply")?.parameters?.properties?.provider?.const === "codex" && tools.get("cloud_agent_apply")?.executionMode === "sequential");
		const approval = JSON.parse(await readFile(new URL("../../auto-approve/defaults.json", import.meta.url), "utf8"));
		check("apply tool is explicitly auto-approved", approval.allow.some((rule: { tool?: string }) => rule.tool === "cloud_agent_apply"));
		process.env[SUBAGENT_RUN_ID_ENV] = "child";
		tools.clear();
		cloudAgents(register);
		check("subagents cannot apply cloud tasks", !tools.has("cloud_agent_apply"));
	} finally {
		if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
		if (oldPatch === undefined) delete process.env.PI_FAKE_PATCH; else process.env.PI_FAKE_PATCH = oldPatch;
		if (oldArgs === undefined) delete process.env.PI_FAKE_ARGS_LOG; else process.env.PI_FAKE_ARGS_LOG = oldArgs;
		if (oldCwd === undefined) delete process.env.PI_FAKE_CWD_LOG; else process.env.PI_FAKE_CWD_LOG = oldCwd;
		if (oldSubagent === undefined) delete process.env[SUBAGENT_RUN_ID_ENV]; else process.env[SUBAGENT_RUN_ID_ENV] = oldSubagent;
		await rm(temp, { recursive: true, force: true });
	}
	if (failures) process.exitCode = 1;
	else console.log("\nall checks passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
