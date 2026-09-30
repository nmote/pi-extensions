import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_RUN_ID_ENV } from "../../shared/subagent-protocol.ts";
import { FileCursorApiKeyStore } from "./auth.ts";
import cloudAgents, { CLOUD_SETUP_COMMAND, CLOUD_AGENT_TOOL, CLOUD_STATUS_TOOL } from "../index.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function main(): Promise<void> {
	const temp = await mkdtemp(join(tmpdir(), "pi-cursor-index-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousSubagentRun = process.env[SUBAGENT_RUN_ID_ENV];
	const previousFetch = globalThis.fetch;
	try {
		process.env.PI_CODING_AGENT_DIR = temp;
		delete process.env[SUBAGENT_RUN_ID_ENV];
		const store = new FileCursorApiKeyStore();
		await store.save("old-secret");

		const tools = new Map<string, any>();
		const commands = new Map<string, any>();
		let inspections = 0;
		let gitCalls = 0;
		const result = (stdout = "", code = 0) => ({ stdout, stderr: "", code, killed: false });
		const pi = {
			registerTool(tool: any) { tools.set(tool.name, tool); },
			registerCommand(name: string, command: any) { commands.set(name, command); },
			async exec(command: string, args: string[]) {
				gitCalls++;
				if (command !== "git") return result("", 1);
				const joined = args.join(" ");
				if (joined === "rev-parse --is-inside-work-tree") {
					inspections++;
					return result("true\n");
				}
				if (joined === "remote") return result("fork\norigin\n");
				if (joined === "remote get-url origin") return result(inspections === 1 ? "git@github.com:example/project.git\n" : "git@github.com:example/changed.git\n");
				throw new Error(`Unexpected Git inspection: ${joined}`);
			},
		};
		cloudAgents(pi as unknown as ExtensionAPI);

		const tool = tools.get(CLOUD_AGENT_TOOL);
		const command = commands.get(CLOUD_SETUP_COMMAND);
		check("provider-specific tool and setup aliases are not registered", !tools.has("cursor_cloud_agent") && !commands.has("cursor-auth"));
		check("explicit provider required", !!tool?.parameters?.properties?.provider);
		check("registers the sequential dispatch tool and setup command", tool?.executionMode === "sequential" && !!command);
		check("dispatch schema exposes optional model and effort, but no ref override", !!tool?.parameters?.properties?.model && !!tool?.parameters?.properties?.effort && !tool?.parameters?.properties?.startingRef);
		const guidance = tool?.promptGuidelines?.join("\n") ?? "";
		check("dispatch guidelines require remote-only independence without rejecting a dirty checkout",
			["default-branch", "remote code", "uncommitted files", "unpushed commits", "branch-only changes", "unmerged PRs", "independence cannot be established", "standalone plan", "dirty"].every((term) => guidance.includes(term)));

		const notices: string[] = [];
		let confirmClear = false;
		const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text };
		const ctx = {
			cwd: "/workspace",
			hasUI: true,
			mode: "tui",
			signal: undefined,
			ui: {
				theme,
				notify(message: string) { notices.push(message); },
				confirm: async () => confirmClear,
				select: async (title: string) => title === "Cloud agent provider" ? "Cursor" : "Clear",
				custom: async <T>(factory: any): Promise<T> => new Promise<T>((resolve, reject) => {
					Promise.resolve(factory({}, theme, {}, resolve)).then((component: { handleInput?: (data: string) => void }) => {
						component.handleInput?.("replacement-secret");
						component.handleInput?.("\n");
					}).catch(reject);
				}),
			},
		};

		const wrongProvider = await rejection(tool.execute("wrong", { provider: "other", plan: "Implement it." }, undefined, undefined, ctx));
		check("unknown providers fail before side effects", wrongProvider.includes("Unsupported cloud provider") && gitCalls === 0);
		const beforeBlankGit = gitCalls;
		const blank = await rejection(tool.execute("blank", { provider: "cursor", plan: "   " }, undefined, undefined, ctx));
		check("blank plans fail before credential, Git, or network side effects", blank.includes("cannot be blank") && gitCalls === beforeBlankGit);
		const effortWithoutModel = await rejection(tool.execute("effort", { provider: "cursor", plan: "Implement it.", effort: "high" }, undefined, undefined, ctx));
		check("effort without a model fails before Git calls", effortWithoutModel.includes("requires a model") && gitCalls === beforeBlankGit);

		const postAuth: string[] = [];
		const postBodies: Array<Record<string, any>> = [];
		let modelGets = 0;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const path = new URL(String(url)).pathname;
			const auth = new Headers(init?.headers).get("authorization") ?? "";
			if (path === "/v1/me") {
				return jsonResponse(200, {
					apiKeyName: "Pi key",
					createdAt: "2026-01-01T00:00:00Z",
					userEmail: "developer@example.com",
				});
			}
			if (path === "/v1/models") {
				modelGets++;
				return jsonResponse(200, { items: [{
					id: "claude-4", displayName: "Claude 4", aliases: ["claude"],
					parameters: [{ id: "effort", values: [{ value: "low" }, { value: "high" }] }],
					variants: [{ params: [{ id: "thinking", value: "true" }, { id: "effort", value: "low" }], isDefault: true }, { params: [{ id: "thinking", value: "true" }, { id: "effort", value: "high" }] }],
				}] });
			}
			if (path === "/v1/agents") {
				postAuth.push(auth);
				const body = JSON.parse(String(init?.body)) as Record<string, any>;
				postBodies.push(body);
				if (auth === "Bearer old-secret") {
					return jsonResponse(401, { error: { code: "unauthorized", message: "expired" } });
				}
				return jsonResponse(201, {
					agent: { id: body.agentId, url: `https://cursor.com/agents/${body.agentId}`, status: "ACTIVE" },
					run: { id: "run-success", status: "CREATING" },
				});
			}
			if (path === "/v1/agents/bc-known") {
				return jsonResponse(200, { id: "bc-known", status: "IDLE", url: "https://cursor.com/agents/bc-known", latestRunId: "run-latest" });
			}
			if (path === "/v1/agents/bc-known/runs/run-latest") {
				return jsonResponse(200, {
					id: "run-latest",
					status: "FINISHED",
					git: { branches: [{ repoUrl: "github.com/example/project", prUrl: "https://github.com/example/project/pull/7" }] },
				});
			}
			if (path === "/v1/agents/bc-missing") return jsonResponse(404, { error: { code: "agent_not_found" } });
			throw new Error(`unexpected request: ${path}`);
		}) as typeof fetch;

		const launched = await tool.execute("launch", { provider: "cursor", plan: "Implement the approved change." }, undefined, undefined, ctx);
		check(
			"launch-time 401 replacement retries exactly once with the new key",
			postAuth.join(",") === "Bearer old-secret,Bearer replacement-secret" &&
				await store.load() === "replacement-secret",
		);
		check("repository is captured once before the credential retry", inspections === 1 && gitCalls === 3);
		check(
			"both launch attempts reuse the agent ID and captured remote, omitting startingRef",
			postBodies.length === 2 && postBodies[0]?.agentId === postBodies[1]?.agentId &&
				postBodies.every((body) => body.repos?.[0]?.url === "https://github.com/example/project" && !Object.hasOwn(body.repos[0], "startingRef")),
		);
		check(
			"the tool result identifies the repository and warns about local changes without claiming a base",
			launched.details?.runId === "run-success" && launched.details?.repository === "https://github.com/example/project" &&
				!Object.hasOwn(launched.details, "baseBranch") && !Object.hasOwn(launched.details, "commit") &&
				launched.content?.[0]?.text.includes("Cursor selects the starting point; the local checkout and edits are not sent.") &&
				!launched.content?.[0]?.text.includes("Base branch"),
		);
		check(
			"launch recovery notifications expose no credentials",
			!["old-secret", "replacement-secret"].some((secret) => notices.join("\n").includes(secret)),
		);
		check("dispatch without a model skips the model catalog", postBodies.length === 2 && modelGets === 0);

		const selected = await tool.execute("model", { provider: "cursor", plan: "Implement the approved change.", model: "claude", effort: "high" }, undefined, undefined, ctx);
		check(
			"dispatch resolves and posts the selected model",
			postBodies[2]?.model?.id === "claude-4" && postBodies[2]?.model?.params?.[0]?.id === "thinking" &&
			postBodies[2]?.model?.params?.[1]?.value === "high" && selected.details?.effort === "high",
		);
		const postsBeforeUnknown = postBodies.length;
		const unknown = await rejection(tool.execute("unknown", { provider: "cursor", plan: "Implement it.", model: "unknown" }, undefined, undefined, ctx));
		check("unknown models fail before POST", unknown.includes("No Cursor agent was launched") && postBodies.length === postsBeforeUnknown);

		const status = await tools.get(CLOUD_STATUS_TOOL).execute("status", { provider: "cursor", agentId: "bc-known" }, undefined, undefined, ctx);
		check(
			"status defaults to the agent's latest run and reports its pull request",
			status.details?.run?.id === "run-latest" &&
				status.content?.[0]?.text.includes("Pull request: https://github.com/example/project/pull/7"),
		);
		const missing = await rejection(tools.get(CLOUD_STATUS_TOOL).execute("missing", { provider: "cursor", agentId: "bc-missing" }, undefined, undefined, ctx));
		check("status reports agents Cursor does not know", missing === "Cursor has no agent bc-missing.");

		await command.handler("", { ...ctx, mode: "print" });
		check("setup is guarded outside the TUI", await store.load() === "replacement-secret");
		await command.handler("", ctx);
		check("canceling credential clearing preserves the key", await store.load() === "replacement-secret");
		confirmClear = true;
		await command.handler("", ctx);
		check("confirmed credential clearing removes the key", await store.load() === undefined);

		tools.clear();
		process.env[SUBAGENT_RUN_ID_ENV] = "child";
		cloudAgents(pi as unknown as ExtensionAPI);
		check("subagents cannot dispatch", !tools.has(CLOUD_AGENT_TOOL) && tools.has(CLOUD_STATUS_TOOL));
	} finally {
		if (previousSubagentRun === undefined) delete process.env[SUBAGENT_RUN_ID_ENV];
		else process.env[SUBAGENT_RUN_ID_ENV] = previousSubagentRun;
		globalThis.fetch = previousFetch;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(temp, { recursive: true, force: true });
	}

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
