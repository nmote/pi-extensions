import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AutoApproveStat, SUBAGENT_RUN_ID_ENV, SUBAGENT_TOKEN_ENV, SUBAGENT_PROTOCOL_ENV, SUBAGENT_HANDSHAKE_COMMAND, protocolAck } from "../shared/subagent-protocol.ts";
import {
	discoverNamedAgents,
	formatNamedAgentCatalog,
	resolveSubagentTask,
	type ResolvedSubagentTask,
} from "./agents.ts";
import { formatSpawnCall, summarizePurpose } from "./purpose.ts";
import subagents from "./index.ts";
import { SubagentManager, type SubagentManagerOptions } from "./manager.ts";
import { RpcProcess } from "./rpc.ts";
import { restoreSubagents, SUBAGENT_STATE_ENTRY } from "./state.ts";
import { createProgressReporter, type SubagentDetails } from "./progress.ts";
import {
	formatCost,
	formatDuration,
	formatExpandedMetadata,
	formatResultHeading,
	formatRunStatus,
} from "./status.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const testDir = dirname(fileURLToPath(import.meta.url));
const fixture = join(testDir, "fixtures/fake-rpc-child.mjs");
const childStopped = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
const task = (text: string): ResolvedSubagentTask => ({
	task: text,
	agent: "general",
	cwd: process.cwd(),
	model: "fake/fake-model",
	thinkingLevel: "off",
	systemPrompt: "test prompt",
});

function context(options: {
	hasUI?: boolean;
	select?: (title: string, choices: string[]) => Promise<string | undefined>;
	confirm?: (title: string, message: string) => Promise<boolean>;
	notify?: (message: string) => void;
	setStatus?: (key: string, value: string | undefined) => void;
} = {}) {
	return {
		hasUI: options.hasUI ?? true,
		signal: undefined,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: options.setStatus ?? (() => {}),
			select: options.select ?? (async () => "Approve once"),
			confirm: options.confirm ?? (async () => true),
			input: async () => "input",
			editor: async () => "edited",
			notify: options.notify ?? (() => {}),
		},
	} as unknown as ExtensionContext;
}

function approvalGate() {
	let markOpen!: () => void;
	let respond!: (value: boolean) => void;
	return {
		opened: new Promise<void>((resolve) => { markOpen = resolve; }),
		confirm: async () => {
			markOpen();
			return new Promise<boolean>((resolve) => { respond = resolve; });
		},
		respond: (value: boolean) => respond(value),
	};
}

async function errorMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

const childEnvKeys = [SUBAGENT_RUN_ID_ENV, SUBAGENT_TOKEN_ENV, SUBAGENT_PROTOCOL_ENV];
const savedChildEnv = childEnvKeys.map((key) => process.env[key]);
try {
	process.env[SUBAGENT_RUN_ID_ENV] = "test-child";
	process.env[SUBAGENT_TOKEN_ENV] = "test-token";
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	subagents({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool() {},
	} as unknown as ExtensionAPI);
	const notices: string[] = [];
	const ctx = { ...context({ notify: (message) => notices.push(message) }), mode: "rpc" };
	const legacyEnv = { ...process.env };
	delete legacyEnv[SUBAGENT_PROTOCOL_ENV];
	const legacyChild = new RpcProcess(
		{ command: process.execPath, argsPrefix: ["--import", "tsx", join(testDir, "fixtures/protocol-startup-child.ts")] },
		process.cwd(), legacyEnv, () => {}, () => {},
	);
	try {
		const message = await errorMessage(legacyChild.start([]));
		check("legacy parent receives a failed exit with reload guidance", message.includes("code=1") && message.includes("parent=legacy, child=1") && message.includes("/reload"));
	} finally {
		await legacyChild.stop();
	}
	process.env[SUBAGENT_PROTOCOL_ENV] = "1";
	handlers.get("session_start")({}, ctx);
	await commands.get(SUBAGENT_HANDSHAKE_COMMAND).handler("test-token 1", ctx);
	check("matching child acknowledges the loaded protocol", notices.at(-1) === protocolAck("test-token", "1"));
	check("handshake rejects a different token", (await errorMessage(commands.get(SUBAGENT_HANDSHAKE_COMMAND).handler("wrong-token 1", ctx))).includes("Invalid subagent handshake"));
} finally {
	childEnvKeys.forEach((key, index) => {
		if (savedChildEnv[index] === undefined) delete process.env[key];
		else process.env[key] = savedChildEnv[index];
	});
}

const managers: SubagentManager[] = [];
const makeManager = (onAutoApproveStat?: (stat: AutoApproveStat, runId: string) => void, onLiveCountChange?: (count: number) => void, onGuidanceRequest?: SubagentManagerOptions["onGuidanceRequest"]) => {
	const manager = new SubagentManager({
		invocation: { command: process.execPath, argsPrefix: [fixture] },
		onAutoApproveStat,
		onLiveCountChange,
		onGuidanceRequest,
	});
	managers.push(manager);
	return manager;
};

const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-config-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
	await mkdir(join(agentDir, "extensions"));
	const definitions = join(agentDir, "test-agents");
	await mkdir(definitions);
	await writeFile(join(definitions, "correctness-reviewer.md"), "---\nname: correctness-reviewer\ndescription: Inspect correctness\ntools: Read, Bash, Grep, Glob\n---\nReview the given code.\n");
	await writeFile(join(agentDir, "extensions/agent-config.json"), JSON.stringify({ agents: "../test-agents" }));
	const discovery = discoverNamedAgents();
	const namedAgents = ["correctness-reviewer"];
	check("named agents are discoverable", namedAgents.every((name) => discovery.agents.some((agent) => agent.name === name)));
	check("named agents have valid frontmatter", discovery.errors.length === 0);
	const catalogFixture = {
		directory: "/agents",
		agents: [
			{ name: "zeta", description: "Full zeta description\nwith examples", systemPrompt: "", filePath: "zeta.md" },
			{ name: "alpha", description: "Full alpha description", systemPrompt: "", filePath: "alpha.md" },
		],
		errors: ["zeta.md: invalid frontmatter", "alpha.md: missing description"],
	};
	check(
		"catalog includes full descriptions and errors in stable order",
		formatNamedAgentCatalog(catalogFixture) ===
			"Agent directory: /agents\n\nNamed subagents:\nalpha: Full alpha description\n\nzeta: Full zeta description\nwith examples\n\nDiscovery errors:\nalpha.md: missing description\nzeta.md: invalid frontmatter",
	);
	check("empty catalog is explicit", formatNamedAgentCatalog({ directory: "/agents", agents: [], errors: [] }) === "Agent directory: /agents\n\nNamed subagents:\nnone");

	const shutdowns: Array<() => Promise<void>> = [];
	const register = (entries: any[] = []) => {
		const tools = new Map<string, any>();
		let beginTurn = () => {};
		let beginSession = (_ctx: ExtensionContext) => {};
		let endSession = async () => {};
		let approvalMode = "yolo";
		let failPersistence = false;
		const pi = {
			registerTool(tool: any) { tools.set(tool.name, tool); },
			registerCommand() {},
			appendEntry(customType: string, data: unknown) {
				if (failPersistence) throw new Error("disk full");
				entries.push({ type: "custom", customType, data });
			},
			on(event: string, handler: (...args: any[]) => any) {
				if (event === "session_start") beginSession = (ctx) => handler({}, { ...ctx, sessionManager: { getBranch: () => entries } });
				if (event === "session_shutdown") {
					endSession = () => handler({}, context());
					shutdowns.push(endSession);
				}
				if (event === "turn_start") beginTurn = handler;
			},
			events: { emit(name: string, request: any) {
				if (name === "auto-approve:get-state") request.respond({ mode: approvalMode });
			} },
		};
		const originalScript = process.argv[1];
		try {
			process.argv[1] = fixture;
			subagents(pi as unknown as ExtensionAPI);
		} finally {
			process.argv[1] = originalScript;
		}
		return { tools, beginSession, shutdown: () => endSession(), beginTurn: () => beginTurn(), setMode: (mode: string) => { approvalMode = mode; }, failPersistence: () => { failPersistence = true; } };
	};
	try {
		const { tools, beginSession, beginTurn, setMode } = register();
		beginTurn();
		const spawn = tools.get("subagent");
		const list = tools.get("list_subagents");
		const footer: Array<{ key: string; value: string | undefined }> = [];
		const ctx = { ...context({ setStatus: (key, value) => footer.push({ key, value }) }), cwd: process.cwd(), mode: "json", model: { provider: "fake", id: "fake-model" }, thinkingLevel: "off" };
		beginSession(ctx as unknown as ExtensionContext);
		check("empty session omits the subagent footer", footer.at(-1)?.key === "000-pi-04-subagents" && footer.at(-1)?.value === undefined);
		check("catalog is a read-only tool with no parameters", !!list && Object.keys(list.parameters.properties).length === 0);
		check("spawn prompt omits named agent names", !spawn.description.includes("correctness-reviewer"));
		const general = await spawn.execute("general", { task: "done general" }, undefined, undefined, ctx);
		check("general delegation works before catalog lookup", general.details.results[0]?.agent === "general" && general.details.results[0]?.output === "done");
		check("idle child remains in the persistent footer", footer.at(-1)?.value === "[subagents: 1 live]");
		const footerUpdatesBeforeContinuation = footer.length;
		setMode("manual");
		const continued = await tools.get("subagent_continue").execute("continue", { id: general.details.results[0].id, task: "recall" }, undefined, undefined, ctx);
		const recalled = JSON.parse(continued.details.results[0].output);
		check("continuation does not duplicate the live count", footer.length === footerUpdatesBeforeContinuation && footer.at(-1)?.value === "[subagents: 1 live]");
		check("follow-up tool inherits current mode and reports only new usage", recalled.mode === "manual" && continued.usage.totalTokens === 18 && continued.details.results[0].totalUsage.totalTokens === 36);
		check("idle result explains reuse and ending", continued.content[0].text.includes("subagent_continue") && continued.content[0].text.includes("subagent_cancel") && continued.content[0].text.includes("36 tokens / $0.066 lifetime"));
		const namedError = await errorMessage(spawn.execute("named", { task: "done named", agent: "correctness-reviewer" }, undefined, undefined, ctx));
		const batchError = await errorMessage(spawn.execute("batch", { tasks: [
			{ task: "done general" }, { task: "done named", agent: "correctness-reviewer" },
		] }, undefined, undefined, ctx));
		const before = await tools.get("subagent_status").execute("status", {}, undefined, undefined, ctx);
		check("named delegation requires catalog lookup", namedError.includes("Call list_subagents"));
		check("mixed batches fail before starting any children", batchError.includes("Call list_subagents") && before.details.results.length === 1);
		const catalog = await list.execute("catalog", {}, undefined, undefined, ctx);
		check("catalog returns the discovered definitions", catalog.content[0]?.text === formatNamedAgentCatalog(discovery));
		const sameTurnError = await errorMessage(spawn.execute("same-turn", { task: "done named", agent: "correctness-reviewer" }, undefined, undefined, ctx));
		check("named delegation waits until the parent has seen the catalog", sameTurnError.includes("read its result"));
		beginTurn();
		const named = await spawn.execute("named", { task: "done named", agent: "correctness-reviewer" }, undefined, undefined, ctx);
		check("named delegation succeeds after catalog lookup", named.details.results[0]?.agent === "correctness-reviewer" && named.details.results[0]?.output === "done");
		const mixed = await spawn.execute("mixed", { tasks: [
			{ task: "done plain" }, { task: "done named", agent: "correctness-reviewer" },
		] }, undefined, undefined, ctx);
		check("mixed batches succeed after catalog lookup", mixed.details.results.map((result: { agent: string; output?: string }) => `${result.agent}:${result.output}`).join(",") === "general:done,correctness-reviewer:done");
		check("parallel children are counted in the footer", footer.at(-1)?.value === "[subagents: 4 live]");
		await tools.get("subagent_cancel").execute("end-one", { id: general.details.results[0].id });
		check("ending a child decrements the footer", footer.at(-1)?.value === "[subagents: 3 live]");
		await tools.get("subagent_cancel").execute("end-all", {});
		check("ending all children omits the footer", footer.at(-1)?.value === undefined);
		const { tools: anotherRuntime, beginTurn: beginNewTurn } = register();
		beginNewTurn();
		const resetError = await errorMessage(anotherRuntime.get("subagent").execute("reset", { task: "done named", agent: "correctness-reviewer" }, undefined, undefined, ctx));
		check("lookup gate resets in a new parent runtime", resetError.includes("Call list_subagents"));

		await rm(join(agentDir, "extensions/agent-config.json"));
		const unchangedCatalog = await list.execute("cached", {}, undefined, undefined, ctx);
		check("catalog changes require reload", unchangedCatalog.content[0]?.text === formatNamedAgentCatalog(discovery));
		const { tools: emptyRuntime } = register();
		const emptyCatalog = await emptyRuntime.get("list_subagents").execute("empty", {}, undefined, undefined, ctx);
		check("a new runtime discovers an absent default directory", emptyCatalog.content[0]?.text === formatNamedAgentCatalog({ directory: join(agentDir, "agents"), agents: [], errors: [] }));
		const emptyGeneral = await emptyRuntime.get("subagent").execute("general", { task: "done general" }, undefined, undefined, ctx);
		check("general delegation needs no named definitions", emptyGeneral.details.results[0]?.agent === "general" && emptyGeneral.details.results[0]?.output === "done");

		initTheme("dark", false);
		const displayEntries: any[] = [];
		const displayRuntime = register(displayEntries);
		displayRuntime.beginSession(ctx as unknown as ExtensionContext);
		const displaySpawn = displayRuntime.tools.get("subagent");
		const displayReply = displayRuntime.tools.get("subagent_reply");
		const waitingDisplay = await displaySpawn.execute("display-wait", { tasks: [{ task: "ask" }, { task: "ask" }] }, undefined, undefined, ctx);
		const displayId = waitingDisplay.details.results[0].id;
		const displayTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		let invalidations = 0;
		const renderContext = { toolCallId: "display-wait", invalidate: () => { invalidations++; } };
		const renderDisplay = (tool = displaySpawn, result = waitingDisplay, context = renderContext, expanded = false) =>
			tool.renderResult(result, { expanded, isPartial: false }, displayTheme, context).render(240).join("\n");
		check("unanswered widget requests supervisor input", renderDisplay().includes("Supervisor reply required"));
		await errorMessage(displayReply.execute("wrong", { id: "unknown", answer: "two" }, undefined, undefined, ctx));
		check("rejected reply leaves the original widget waiting", invalidations === 0 && !renderDisplay().includes("supervisor replied;"));
		let acceptedDisplay = "";
		await displayReply.execute("display-reply", { id: displayId, answer: "two" }, undefined, () => { acceptedDisplay = renderDisplay(); }, ctx);
		const displayed = renderDisplay();
		check("accepted reply invalidates and updates the original widget", invalidations === 1 && acceptedDisplay.includes("supervisor replied; continued in subagent_reply"));
		check("batch widget preserves usage and another unanswered question", displayed.includes("Supervisor reply required") && displayed.includes(`$${waitingDisplay.details.results[0].usage.cost.total.toFixed(3)}`) && displayed.includes("waiting for supervisor"));
		const repeatedQuestion = await displayRuntime.tools.get("subagent_continue").execute("display-again", { id: displayId, task: "ask again" }, undefined, undefined, ctx);
		check("a later question has its own waiting widget", renderDisplay(displayRuntime.tools.get("subagent_continue"), repeatedQuestion, { ...renderContext, toolCallId: "display-again" }).includes("Supervisor reply required") && renderDisplay().includes("supervisor replied;"));
		await displayReply.execute("display-second-reply", { id: waitingDisplay.details.results[1].id, answer: "one" }, undefined, undefined, ctx);
		check("fully answered widget removes the warning in both views", !renderDisplay().includes("Supervisor reply required") && !renderDisplay(displaySpawn, waitingDisplay, renderContext, true).includes("Use subagent_reply") && renderDisplay(displaySpawn, waitingDisplay, renderContext, true).includes("supervisor replied"));
		check("display changes leave the tool result snapshot untouched", waitingDisplay.details.results.every((item: { status: string }) => item.status === "waiting") && waitingDisplay.content[0].text.includes("Use subagent_reply"));
		await displayRuntime.shutdown();
		const restoredDisplay = register(displayEntries);
		restoredDisplay.beginSession(ctx as unknown as ExtensionContext);
		check("answered widget survives runtime restoration", renderDisplay(restoredDisplay.tools.get("subagent")).includes("supervisor replied; continued in subagent_reply"));

		const entries: any[] = [];
		let runtime = register(entries);
		runtime.beginSession(ctx as unknown as ExtensionContext);
		const initial = await runtime.tools.get("subagent").execute("persistent", { task: "recall persistent", model: "fake/fake-model", thinkingLevel: "low" }, undefined, undefined, ctx);
		const persistentId = initial.details.results[0].id;
		let previousInfo = JSON.parse(initial.details.results[0].output);
		const initialPrompt = await readFile(previousInfo.args[previousInfo.args.indexOf("--append-system-prompt") + 1], "utf8");
		for (const boundary of ["reload", "resume"]) {
			await runtime.shutdown();
			check(`${boundary} stops the old child`, childStopped(previousInfo.pid));
			runtime = register(entries);
			runtime.beginSession(ctx as unknown as ExtensionContext);
			const restoredStatus = await runtime.tools.get("subagent_status").execute("status", { id: persistentId });
			check(`${boundary} restores the original idle ID and configuration`, restoredStatus.details.results[0].status === "idle" && restoredStatus.details.results[0].thinkingLevel === "low");
			runtime.setMode("manual");
			const followup = await runtime.tools.get("subagent_continue").execute("followup", { id: persistentId, task: `recall after ${boundary}` }, undefined, undefined, ctx);
			const info = JSON.parse(followup.details.results[0].output);
			check(`${boundary} reopens retained history with current approval policy`, info.pid !== previousInfo.pid && info.mode === "manual" && info.history[0].text === "Task: recall persistent");
			check(`${boundary} retains launch settings and instructions`, info.args[info.args.indexOf("--model") + 1] === "fake/fake-model" && info.args[info.args.indexOf("--thinking") + 1] === "low" && await readFile(info.args[info.args.indexOf("--append-system-prompt") + 1], "utf8") === initialPrompt);
			check(`${boundary} accounts only new usage`, followup.usage.totalTokens === 18 && followup.details.results[0].totalUsage.totalTokens === (boundary === "reload" ? 36 : 54));
			previousInfo = info;
		}
		await runtime.tools.get("subagent_cancel").execute("cancel", { id: persistentId });
		await runtime.shutdown();
		runtime = register(entries);
		runtime.beginSession(ctx as unknown as ExtensionContext);
		check("cancellation stays permanent after restoration", (await errorMessage(runtime.tools.get("subagent_continue").execute("continue", { id: persistentId, task: "wrong" }, undefined, undefined, ctx))).includes("while cancelled"));

		const stale = await runtime.tools.get("subagent").execute("stale", { task: "done" }, undefined, undefined, ctx);
		const staleId = stale.details.results[0].id;
		await runtime.shutdown();
		const state = restoreSubagents(entries).find((run) => run.snapshot.id === staleId)!;
		await rm(state.sessionDir, { recursive: true });
		runtime = register(entries);
		runtime.beginSession(ctx as unknown as ExtensionContext);
		const missing = await runtime.tools.get("subagent_continue").execute("missing", { id: staleId, task: "do not rerun" }, undefined, undefined, ctx);
		check("missing child sessions fail instead of starting fresh", missing.details.results[0].status === "failed" && missing.details.results[0].error.includes("Saved session") && !existsSync(state.sessionDir));
		const waitingTask = await runtime.tools.get("subagent").execute("waiting", { task: "ask again" }, undefined, undefined, ctx);
		const waitingId = waitingTask.details.results[0].id;
		await runtime.shutdown();
		runtime = register(entries);
		runtime.beginSession(ctx as unknown as ExtensionContext);
		const interrupted = await runtime.tools.get("subagent_status").execute("status", { id: waitingId });
		check("restored questions require explicit continuation", interrupted.details.results[0].status === "idle" && interrupted.details.results[0].phase.includes("interrupted") && interrupted.details.results[0].question.question === "Which option?" && (await errorMessage(runtime.tools.get("subagent_reply").execute("reply", { id: waitingId, answer: "two" }, undefined, undefined, ctx))).includes("not waiting"));
		const recovered = await runtime.tools.get("subagent_continue").execute("recover", { id: waitingId, task: "recall recovery" }, undefined, undefined, ctx);
		check("interrupted questions retain context without automatic replay", recovered.details.results[0].status === "idle" && recovered.details.results[0].question === undefined && JSON.parse(recovered.details.results[0].output).history[0].text === "Task: ask again");
		check("restoration rejects incompatible registry versions", (await errorMessage(Promise.resolve().then(() => restoreSubagents([{ type: "custom", customType: SUBAGENT_STATE_ENTRY, data: { version: 999, runs: [] } }] as any)))).includes("unsupported"));
		const saveErrors: string[] = [];
		const failingRuntime = register();
		failingRuntime.beginSession(context({ notify: (message) => saveErrors.push(message) }));
		failingRuntime.failPersistence();
		const unsaved = await failingRuntime.tools.get("subagent").execute("unsaved", { task: "recall unsaved" }, undefined, undefined, ctx);
		const unsavedInfo = JSON.parse(unsaved.details.results[0].output);
		await failingRuntime.tools.get("subagent_cancel").execute("cancel", { id: unsaved.details.results[0].id });
		check("persistence failures warn without blocking checkpoints or cleanup", saveErrors.some((message) => message.includes("disk full")) && childStopped(unsavedInfo.pid) && !existsSync(unsavedInfo.args[unsavedInfo.args.indexOf("--append-system-prompt") + 1]));
	} finally {
		await Promise.all(shutdowns.map((shutdown) => shutdown()));
	}
	const reviewer = resolveSubagentTask(
		{ task: "review", agent: "correctness-reviewer" },
		{ cwd: process.cwd(), model: "parent/model", thinkingLevel: "high", autoApproveMode: "auto" },
		discovery.agents,
	);
	check("reviewer inherits parent model", reviewer.model === "parent/model" && reviewer.thinkingLevel === "high");
	check(
		"inspection agent tools exclude file-mutating built-ins",
		reviewer.tools?.join(",") === "read,bash,grep,find,ls,ask_supervisor",
	);
	const unrestricted = resolveSubagentTask(
		{ task: "implement", agent: "implementer" },
		{ cwd: process.cwd(), model: "parent/model", thinkingLevel: "high" },
		[{ name: "implementer", description: "Implement changes", systemPrompt: "Work", filePath: "/agents/implementer.md" }],
	);
	check("named agents without explicit tools inherit normal tools", unrestricted.tools === undefined);
	const editable = resolveSubagentTask(
		{ task: "implement", agent: "implementer" },
		{ cwd: process.cwd(), model: "parent/model", thinkingLevel: "high" },
		[{ name: "implementer", description: "Implement changes", systemPrompt: "Work", tools: ["read", "edit", "write"], filePath: "/agents/implementer.md" }],
	);
	check("named agents can opt into file-mutating tools", editable.tools?.join(",") === "read,edit,write,ask_supervisor");
	const override = resolveSubagentTask(
		{ task: "work", model: "other/model", thinkingLevel: "low" },
		{ cwd: process.cwd(), model: "parent/model", thinkingLevel: "high" },
		discovery.agents,
	);
	check("task can override model", override.model === "other/model" && override.thinkingLevel === "low");
	check(
		"purpose summary uses the normalized first line",
		summarizePurpose("  Review   the parser\nIgnore this detail") === "Review the parser",
	);
	const exactPurpose = "😀".repeat(100);
	check("purpose summary preserves the exact limit", summarizePurpose(exactPurpose) === exactPurpose);
	const longPurpose = summarizePurpose(`${"😀".repeat(99)}yz`);
	check("purpose summary preserves 99 code points plus an ellipsis", longPurpose === `${"😀".repeat(99)}…`);
	const identityStyles = {
		title: (text: string) => text,
		accent: (text: string) => text,
		muted: (text: string) => text,
	};
	check(
		"single spawn log includes its purpose",
		formatSpawnCall(
			{ agent: "correctness-reviewer", task: "  Review   parser\nDetails", cwd: "/repo" },
			identityStyles,
		) === "subagent correctness-reviewer · Review parser in /repo",
	);
	check(
		"batch spawn log lists each purpose and tolerates partial arguments",
		formatSpawnCall(
			{ tasks: [{ agent: "simplicity-reviewer", task: "Simplify code\nDetails" }, {}] },
			identityStyles,
		) === "subagent 2 parallel tasks\n  simplicity-reviewer · Simplify code\n  general",
	);

	const simple = makeManager();
	let sameDirectoryApprovalCalls = 0;
	const simpleResults = await simple.start(
		[{ ...task("done"), cwd: "." }],
		process.cwd(),
		context({
			confirm: async () => {
				sameDirectoryApprovalCalls++;
				return false;
			},
		}),
	);
	check("canonical aliases of the parent cwd need no approval", sameDirectoryApprovalCalls === 0);
	check("single task completes", simpleResults[0]?.status === "idle");
	check("single task returns final output", simpleResults[0]?.output === "done");
	check("run records lifecycle activity", simpleResults[0]?.activity.some((entry) => entry.message === "model thinking"));
	check("duration formatter is concise", formatDuration(65_000) === "1m 5s");
	const firstUsage = simple.consumeUsage([simpleResults[0].id]);
	check("usage is reported", firstUsage.totalTokens === 18 && firstUsage.cost.total === 0.033);
	check("usage is reported once", simple.consumeUsage([simpleResults[0].id]).totalTokens === 0);

	const liveCounts: number[] = [];
	const reusable = makeManager(undefined, (count) => liveCounts.push(count));
	const firstTask = (await reusable.start([task("recall first secret")], process.cwd(), context()))[0]!;
	const firstRecall = JSON.parse(firstTask.output!);
	reusable.consumeUsage([firstTask.id]);
	const secondTask = await reusable.continue(firstTask.id, "recall second", () => "manual", context());
	const secondRecall = JSON.parse(secondTask.output!);
	check("follow-up retains user and assistant context in the same child", firstRecall.pid === secondRecall.pid && secondRecall.history.some((entry: any) => entry.text === "Task: recall first secret") && secondRecall.history.some((entry: any) => entry.role === "assistant" && entry.text === firstTask.output));
	check("follow-up keeps its identity and launch configuration", secondTask.id === firstTask.id && secondTask.taskNumber === 2 && secondTask.task === "recall second" && secondRecall.cwd === firstRecall.cwd && JSON.stringify(secondRecall.args) === JSON.stringify(firstRecall.args));
	check("task reporting resets without changing earlier snapshots", secondTask.usage.totalTokens === 18 && secondTask.totalUsage.totalTokens === 36 && firstTask.totalUsage.totalTokens === 18 && secondTask.activity.every((entry) => entry.at >= secondTask.startedAt));
	check("follow-up usage is accounted once", reusable.consumeUsage([firstTask.id]).totalTokens === 18 && reusable.consumeUsage([firstTask.id]).totalTokens === 0);
	const wrongReply = await errorMessage(reusable.reply(firstTask.id, "invalid", context()));
	const unknownContinue = await errorMessage(reusable.continue("missing", "work", () => "manual", context()));
	check("idle reply and unknown continuation fail clearly", wrongReply.includes("not waiting") && unknownContinue.includes("Unknown subagent"));

	const followupQuestion = await reusable.continue(firstTask.id, "ask again", () => "auto", context());
	check("waiting child is live without a count change", reusable.liveCount() === 1 && liveCounts.join(",") === "1");
	check("follow-up can pause for supervision without stale output", followupQuestion.status === "waiting" && followupQuestion.question?.question === "Which option?" && followupQuestion.output === undefined);
	const waitingContinue = await errorMessage(reusable.continue(firstTask.id, "wrong", () => "auto", context()));
	const followupAnswer = await reusable.reply(firstTask.id, "two", context());
	check("waiting agent accepts only a reply within the same task", waitingContinue.includes("while waiting") && followupAnswer.status === "idle" && followupAnswer.taskNumber === 3 && followupAnswer.output === "answer: two" && followupAnswer.usage.totalTokens === 36);
	let followupApprovals = 0;
	const followupApproval = await reusable.continue(firstTask.id, "approval again", () => "manual", context({ select: async () => { followupApprovals++; return "Deny"; } }));
	check("follow-up approvals use fresh parent UI", followupApprovals === 1 && followupApproval.status === "idle" && followupApproval.output === "user decision: Deny");

	const compacted = await reusable.continue(firstTask.id, "compact", () => "manual", context());
	check("task usage includes context compaction", compacted.usage.totalTokens === 36 && compacted.activity.some((entry) => entry.message === "compacting context"));

	const followupAbort = new AbortController();
	const busy = reusable.continue(firstTask.id, "hang", () => "manual", context(), undefined, followupAbort.signal);
	const busyContinue = await errorMessage(reusable.continue(firstTask.id, "wrong", () => "manual", context()));
	followupAbort.abort();
	check("simultaneous assignment rejects without replacing active task", busyContinue.includes("while running") && (await busy).status === "cancelled");
	check("active cancellation removes the live count", reusable.liveCount() === 0 && liveCounts.join(",") === "1,0");
	check("ended child cannot be reused", (await errorMessage(reusable.continue(firstTask.id, "wrong", () => "manual", context()))).includes("while cancelled"));

	const failedAgent = makeManager();
	const failedTask = (await failedAgent.start([task("fail slow cleanup")], process.cwd(), context()))[0]!;
	failedAgent.consumeUsage([failedTask.id]);
	check("provider failure exposes saved context and explicit recovery", failedTask.status === "failed" && failedTask.failureKind === "provider" && failedTask.recoverable === true && !!failedTask.sessionFile && formatExpandedMetadata(failedTask).includes("continue explicitly"));
	const recovering = failedAgent.continue(failedTask.id, "recall after quota", () => "manual", context());
	const duplicateRecovery = await errorMessage(failedAgent.continue(failedTask.id, "wrong", () => "manual", context()));
	const recoveredTask = await recovering;
	const recoveredInfo = JSON.parse(recoveredTask.output!);
	check("recovery reserves the run and ignores late old-process events", duplicateRecovery.includes("while running") && recoveredTask.status === "idle" && recoveredTask.usage.totalTokens === 18);
	check("recovery retains identity, context, settings and lifetime accounting", recoveredTask.id === failedTask.id && recoveredTask.taskNumber === 2 && recoveredInfo.history[0].text === "Task: fail slow cleanup" && recoveredInfo.mode === "manual" && recoveredInfo.args[recoveredInfo.args.indexOf("--model") + 1] === failedTask.model && recoveredTask.totalUsage.totalTokens === 36 && failedAgent.consumeUsage([failedTask.id]).totalTokens === 18 && recoveredTask.previousFailure?.message === failedTask.error);
	const repeatedFailure = await failedAgent.continue(failedTask.id, "fail again", () => "manual", context());
	check("repeated quota failure remains explicitly recoverable", repeatedFailure.status === "failed" && repeatedFailure.recoverable === true && repeatedFailure.totalUsage.totalTokens === 54);
	const savedFailure = failedAgent.persistedState();
	await failedAgent.shutdown();
	const restoredFailure = makeManager();
	restoredFailure.restore(restoreSubagents([{ type: "custom", customType: SUBAGENT_STATE_ENTRY, data: { version: 1, runs: savedFailure } }] as any));
	const historicalFailure = structuredClone(savedFailure);
	delete historicalFailure[0].snapshot.failureKind;
	const historical = makeManager();
	historical.restore(historicalFailure);
	check("historical provider errors are verified from saved transcripts", historical.status(failedTask.id)[0].recoverable === true);
	const unverified = makeManager();
	historicalFailure[0].snapshot.error = "Unrelated protocol error";
	unverified.restore(historicalFailure);
	check("unverified historical failures cannot be recovered", !unverified.status(failedTask.id)[0].recoverable && (await errorMessage(unverified.continue(failedTask.id, "wrong", () => "manual", context()))).includes("while failed"));
	let recoveryApprovals = 0;
	const restoredApproval = await restoredFailure.continue(failedTask.id, "approval after reload", () => "manual", context({ select: async () => { recoveryApprovals++; return "Deny"; } }));
	check("provider recovery after reload rebuilds the UI lifetime", restoredApproval.status === "idle" && restoredApproval.output === "user decision: Deny" && recoveryApprovals === 1 && restoredApproval.totalUsage.totalTokens === 72);

	for (const lateReject of [false, true]) {
		let calls = 0;
		let finishOld!: () => void;
		let finishNew!: () => void;
		let newOpened!: () => void;
		const newReady = new Promise<void>((resolve) => { newOpened = resolve; });
		const guidanceRecovery = makeManager(undefined, undefined, async () => new Promise((resolve, reject) => {
			if (calls++ === 0) {
				finishOld = lateReject ? () => reject(new Error("Old guidance failed")) : () => resolve({ text: "OLD stale policy", revision: 0 });
			} else {
				finishNew = () => resolve({ text: "Current policy", revision: 1 });
				newOpened();
			}
		}));
		const [failed] = await guidanceRecovery.start([task("fail guidance")], process.cwd(), context());
		const continuation = guidanceRecovery.continue(failed.id, "guidance", () => "manual", context());
		await newReady;
		finishOld();
		await new Promise<void>((resolve) => setImmediate(resolve));
		finishNew();
		const result = await continuation;
		check(`late guidance ${lateReject ? "failure" : "success"} cannot answer the replacement process`, result.status === "idle" && result.output === JSON.stringify({ text: "Current policy", revision: 1 }));
	}

	const cancelRecovery = makeManager();
	const cancelFailure = (await cancelRecovery.start([task("fail slow cleanup")], process.cwd(), context()))[0]!;
	const recoveryAbort = new AbortController();
	const cancelledRecovery = cancelRecovery.continue(cancelFailure.id, "must not run", () => "manual", context(), undefined, recoveryAbort.signal);
	recoveryAbort.abort();
	check("cancellation during cleanup prevents reopening or model execution", (await cancelledRecovery).status === "cancelled" && cancelRecovery.status(cancelFailure.id)[0].usage.totalTokens === 0 && (await errorMessage(cancelRecovery.continue(cancelFailure.id, "wrong", () => "manual", context()))).includes("while cancelled"));
	const missingRecovery = makeManager();
	const missingFailure = (await missingRecovery.start([task("fail")], process.cwd(), context()))[0]!;
	const missingState = missingRecovery.persistedState();
	await missingRecovery.shutdown();
	await rm(missingState[0].sessionDir, { recursive: true });
	const missingRestored = makeManager();
	missingRestored.restore(missingState);
	check("missing failed sessions cannot silently start fresh", !missingRestored.status(missingFailure.id)[0].recoverable && (await errorMessage(missingRestored.continue(missingFailure.id, "wrong", () => "manual", context()))).includes("Saved session"));
	const cancelFailed = makeManager();
	const cancellable = (await cancelFailed.start([task("fail")], process.cwd(), context()))[0]!;
	await cancelFailed.cancel();
	check("cancelling failed children permanently disables recovery", cancelFailed.status(cancellable.id)[0].status === "cancelled" && (await errorMessage(cancelFailed.continue(cancellable.id, "wrong", () => "manual", context()))).includes("while cancelled"));

	const abortedAgent = makeManager();
	const abortedSettlement = (await abortedAgent.start([task("abort settlement")], process.cwd(), context()))[0]!;
	check("aborted settlement without an assistant result cannot recover", abortedSettlement.status === "failed" && abortedSettlement.failureKind === "aborted" && abortedSettlement.error === "Subagent stopped: aborted" && !abortedSettlement.recoverable && (await errorMessage(abortedAgent.continue(abortedSettlement.id, "wrong", () => "manual", context()))).includes("while failed"));
	const missingPolicy = makeManager();
	const previousProtocol = process.env.FAKE_PROTOCOL;
	try {
		for (const [version, diagnostic] of [["legacy", "parent=1, child=legacy"], ["2", "parent=1, child=2"], ["no-ack", "not acknowledged"]]) {
			process.env.FAKE_PROTOCOL = version;
			const [result] = await makeManager().start([task("must not run")], process.cwd(), context());
			check(`protocol ${version} fails before model execution`, result.status === "failed" && !!result.error?.includes(diagnostic) && result.usage.totalTokens === 0 && result.output === undefined);
		}
		delete process.env.FAKE_PROTOCOL;
		const original = makeManager();
		const [retained] = await original.start([task("fail")], process.cwd(), context());
		const state = original.persistedState();
		await original.shutdown();
		const restored = makeManager();
		restored.restore(state);
		process.env.FAKE_PROTOCOL = "2";
		const result = await restored.continue(retained.id, "must not run", () => "auto", context());
		check("provider recovery repeats the protocol handshake and fails closed", result.status === "failed" && result.failureKind === "protocol" && !result.recoverable && !!result.error?.includes("parent=1, child=2") && result.usage.totalTokens === 0 && (await errorMessage(restored.continue(retained.id, "wrong", () => "manual", context()))).includes("while failed"));
	} finally {
		if (previousProtocol === undefined) delete process.env.FAKE_PROTOCOL;
		else process.env.FAKE_PROTOCOL = previousProtocol;
	}

	const policyTask = (await missingPolicy.start([task("no policy")], process.cwd(), context()))[0]!;
	const noAck = await missingPolicy.continue(policyTask.id, "recall", () => "manual", context());
	check("missing policy acknowledgement fails closed", noAck.status === "failed" && noAck.failureKind === "policy" && !noAck.recoverable && !!noAck.error?.includes("not acknowledged") && noAck.output === undefined);
	const recoveryPolicy = makeManager();
	const policyFailure = (await recoveryPolicy.start([task("fail")], process.cwd(), context()))[0]!;
	const previousPolicy = process.env.FAKE_POLICY;
	try {
		process.env.FAKE_POLICY = "no-ack";
		const result = await recoveryPolicy.continue(policyFailure.id, "must not run", () => "manual", context());
		check("provider recovery requires current policy acknowledgement", result.status === "failed" && result.failureKind === "policy" && !result.recoverable && result.output === undefined && result.usage.totalTokens === 0);
	} finally {
		if (previousPolicy === undefined) delete process.env.FAKE_POLICY;
		else process.env.FAKE_POLICY = previousPolicy;
	}

	const delayed = makeManager();
	const delayedTask = (await delayed.start([task("recall slow discovery")], process.cwd(), context()))[0]!;
	let latestMode = "yolo";
	const latestPolicy = await delayed.continue(delayedTask.id, "recall", () => latestMode, context({ notify: (message) => { if (message.includes("discovering task policy")) latestMode = "manual"; } }));
	check("policy getter observes mode changes during preparation", JSON.parse(latestPolicy.output!).mode === "manual");

	const interrupted = makeManager();
	const interruptedTask = (await interrupted.start([task("recall slow policy")], process.cwd(), context()))[0]!;
	const handshakeAbort = new AbortController();
	const interruptedResult = await interrupted.continue(interruptedTask.id, "recall", () => "manual", context({ notify: (message) => { if (message.includes("updating task policy")) handshakeAbort.abort(); } }), undefined, handshakeAbort.signal);
	check("abort during policy handshake cannot start the task", interruptedResult.status === "cancelled" && interruptedResult.output === undefined && interruptedResult.usage.totalTokens === 0);

	const stray = makeManager();
	const strayTask = (await stray.start([task("recall stray settlement")], process.cwd(), context()))[0]!;
	const strayResult = await stray.continue(strayTask.id, "recall", () => "manual", context());
	check("stray settlement during handshake fails instead of resolving a task early", strayResult.status === "failed" && strayResult.output === undefined && !!strayResult.error?.includes("outside an assigned task"));

	const unsolicited = makeManager();
	const unsolicitedTask = (await unsolicited.start([task("unsolicited idle")], process.cwd(), context()))[0]!;
	for (let attempt = 0; attempt < 100 && unsolicited.status(unsolicitedTask.id)[0]?.status === "idle"; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	check("unsolicited work while idle fails and stops the child", unsolicited.status(unsolicitedTask.id)[0]?.status === "failed" && !!unsolicited.status(unsolicitedTask.id)[0]?.error?.includes("outside an assigned task"));

	const crashCounts: number[] = [];
	const idleCrash = makeManager(undefined, (count) => crashCounts.push(count));
	const crashingTask = (await idleCrash.start([task("crash idle")], process.cwd(), context()))[0]!;
	for (let attempt = 0; attempt < 100 && idleCrash.status(crashingTask.id)[0]?.status === "idle"; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	check("idle process exit is visible as a non-recoverable failure", idleCrash.status(crashingTask.id)[0]?.failureKind === "process" && !idleCrash.status(crashingTask.id)[0]?.recoverable && (await errorMessage(idleCrash.continue(crashingTask.id, "wrong", () => "manual", context()))).includes("while failed"));
	check("idle crash removes the live count without a tool call", idleCrash.liveCount() === 0 && crashCounts.join(",") === "1,0");

	const cleanup = makeManager();
	const cleanupTasks = await cleanup.start([task("recall one"), task("recall two")], process.cwd(), context());
	const childInfo = cleanupTasks.map((result) => JSON.parse(result.output!));
	const ended = await cleanup.cancel(cleanupTasks[0]!.id);
	const promptPath = (info: any) => info.args[info.args.indexOf("--append-system-prompt") + 1];
	check("ending idle child releases process and prompt", ended[0]?.status === "cancelled" && childStopped(childInfo[0].pid) && !existsSync(promptPath(childInfo[0])));
	check("ending standby preserves completed-task timing", ended[0]?.taskEndedAt === cleanupTasks[0]?.taskEndedAt);
	const endedAll = await cleanup.cancel();
	check("cancel-all includes idle children", endedAll.length === 1 && endedAll[0]?.status === "cancelled" && childStopped(childInfo[1].pid) && !existsSync(promptPath(childInfo[1])));
	const shutdown = makeManager();
	const shutdownTask = (await shutdown.start([task("recall shutdown")], process.cwd(), context()))[0]!;
	const shutdownInfo = JSON.parse(shutdownTask.output!);
	await shutdown.shutdown();
	await shutdown.shutdown();
	check("shutdown disposes standby resources idempotently", childStopped(shutdownInfo.pid) && !existsSync(promptPath(shutdownInfo)) && shutdown.status().length === 0);

	const toolActivity = makeManager();
	const toolActivityResult = await toolActivity.start([task("tool")], process.cwd(), context());
	const toolRun = toolActivityResult[0]!;
	check(
		"tool activity includes a safe argument preview",
		toolRun.activity.some((entry) => entry.message === "running bash: git diff --cached --stat"),
	);

	const liveResult = {
		...toolRun,
		status: "running" as const,
		phase: "model thinking",
		taskEndedAt: undefined,
		startedAt: Date.now() - 65_000,
	};
	check(
		"collapsed status includes model, thinking level, elapsed time, cost, and phase",
		formatRunStatus(liveResult).includes("fake/fake-model (off) · 1m 5s · $0.033 · model thinking"),
	);
	const withCost = (total: number) => ({
		...liveResult,
		usage: { ...liveResult.usage, cost: { ...liveResult.usage.cost, total } },
	});
	check(
		"cost is padded and rounded to three decimal places",
		formatCost(withCost(0)) === "$0.000" &&
			formatCost(withCost(0.03)) === "$0.030" &&
			formatCost(withCost(0.0326)) === "$0.033",
	);
	check("expanded metadata includes cost", formatExpandedMetadata(withCost(0.0326)).includes("- Task cost: $0.033"));
	const completedResult = {
		...liveResult,
		status: "idle" as const,
		phase: "idle",
		updatedAt: liveResult.startedAt + 65_000,
	};
	const firstCompletedStatus = formatRunStatus(completedResult, liveResult.startedAt + 70_000);
	const laterCompletedStatus = formatRunStatus(completedResult, liveResult.startedAt + 125_000);
	const firstLiveStatus = formatRunStatus(liveResult, liveResult.startedAt + 70_000);
	const laterLiveStatus = formatRunStatus(liveResult, liveResult.startedAt + 125_000);
	check(
		"completed elapsed time stops while active elapsed time advances",
		firstCompletedStatus === laterCompletedStatus && firstLiveStatus !== laterLiveStatus,
	);

	let progressUpdates = 0;
	let latestProgress: SubagentDetails | undefined;
	let latestProgressText = "";
	const reporter = createProgressReporter(
		true,
		"spawn",
		(update) => {
			progressUpdates++;
			latestProgress = update.details;
			latestProgressText = update.content[0]?.type === "text" ? update.content[0].text : "";
		},
		10,
	);
	reporter.publish([liveResult]);
	await new Promise((resolve) => setTimeout(resolve, 25));
	check("progress heartbeat refreshes the transcript during silent runs", progressUpdates >= 2);
	check(
		"progress heartbeat republishes the latest snapshot",
		latestProgress?.operation === "spawn" &&
			latestProgress.results[0]?.id === liveResult.id &&
			latestProgress.results[0]?.status === "running" &&
			latestProgressText === "Subagents: 1 running",
	);
	reporter.stop();
	reporter.stop();
	const stoppedAt = progressUpdates;
	await new Promise((resolve) => setTimeout(resolve, 15));
	check("stopping progress clears the heartbeat", progressUpdates === stoppedAt);
	let nonTuiUpdates = 0;
	const nonTuiReporter = createProgressReporter(false, "spawn", () => nonTuiUpdates++, 10);
	nonTuiReporter.publish([liveResult]);
	await new Promise((resolve) => setTimeout(resolve, 25));
	nonTuiReporter.stop();
	check("non-TUI progress does not start a heartbeat", nonTuiUpdates === 1);

	const crossRepository = makeManager();
	const canonicalHome = await realpath(homedir());
	const crossDirectoryTask = "cwd";
	let workingDirectoryApprovalCalls = 0;
	let workingDirectoryApprovalTitle = "";
	let workingDirectoryApprovalMessage = "";
	const crossRepositoryResult = await crossRepository.start(
		[{ ...task(crossDirectoryTask), cwd: "~" }],
		process.cwd(),
		context({
			confirm: async (title, message) => {
				workingDirectoryApprovalCalls++;
				workingDirectoryApprovalTitle = title;
				workingDirectoryApprovalMessage = message;
				return true;
			},
		}),
	);
	check("working directories expand home paths", crossRepositoryResult[0]?.cwd === canonicalHome);
	check("cross-directory children run in the approved canonical cwd", crossRepositoryResult[0]?.output === canonicalHome);
	check("cross-directory runs require explicit user approval", workingDirectoryApprovalCalls === 1);
	const crossDirectoryFollowup = await crossRepository.continue(crossRepositoryResult[0]!.id, "cwd follow-up", () => "manual", context({ confirm: async () => { workingDirectoryApprovalCalls++; return false; } }));
	check("approved cwd is reused without another approval", crossDirectoryFollowup.output === canonicalHome && workingDirectoryApprovalCalls === 1);
	check(
		"working-directory approval identifies the parent, child directory, and grouped task",
		workingDirectoryApprovalTitle.includes("approval required") &&
			workingDirectoryApprovalMessage.includes(JSON.stringify(process.cwd())) &&
			workingDirectoryApprovalMessage.includes(JSON.stringify(canonicalHome)) &&
			workingDirectoryApprovalMessage.includes(`- general: ${JSON.stringify(canonicalHome)}\n  Task:\n    ${crossDirectoryTask.replaceAll("\n", "\n    ")}`),
	);

	const deniedDifferentDirectory = makeManager();
	const longDeniedTask = `Inspect the nested working directory.\n${"Include every detail. ".repeat(100)}`;
	let deniedDifferentDirectoryCalls = 0;
	let deniedDifferentDirectoryMessage = "";
	const deniedDifferentDirectoryError = await errorMessage(deniedDifferentDirectory.start(
		[task("same cwd"), { ...task(longDeniedTask), cwd: join(testDir, "fixtures") }],
		process.cwd(),
		context({
			confirm: async (_title, message) => {
				deniedDifferentDirectoryCalls++;
				deniedDifferentDirectoryMessage = message;
				return false;
			},
		}),
	));
	check(
		"nested working directories also require approval",
		deniedDifferentDirectoryCalls === 1 && deniedDifferentDirectoryError.includes("was not approved"),
	);
	check(
		"working-directory approval includes complete long task prompts",
		deniedDifferentDirectoryMessage.includes(`- general: ${JSON.stringify(join(testDir, "fixtures"))}\n  Task:\n    ${longDeniedTask.replaceAll("\n", "\n    ")}`),
	);
	check("denied batch approval starts no children", deniedDifferentDirectory.status().length === 0);

	const headlessCrossDirectory = makeManager();
	const headlessCrossDirectoryError = await errorMessage(headlessCrossDirectory.start(
		[{ ...task("done"), cwd: "~" }],
		process.cwd(),
		context({ hasUI: false }),
	));
	check("cross-directory runs fail closed without a user UI", headlessCrossDirectoryError.includes("no user UI is available"));

	const abortedWorkingDirectory = makeManager();
	const abortController = new AbortController();
	const abortedApproval = approvalGate();
	const abortedStart = errorMessage(abortedWorkingDirectory.start(
		[{ ...task("done"), cwd: "~" }],
		process.cwd(),
		context({ confirm: abortedApproval.confirm }),
		undefined,
		abortController.signal,
	));
	await abortedApproval.opened;
	abortController.abort();
	abortedApproval.respond(true);
	const abortedStartError = await abortedStart;
	check("aborting working-directory approval starts no children", abortedStartError.includes("start was cancelled") && abortedWorkingDirectory.status().length === 0);

	const shutdownDuringApproval = makeManager();
	const shutdownApproval = approvalGate();
	const shutdownStart = errorMessage(shutdownDuringApproval.start(
		[{ ...task("done"), cwd: "~" }],
		process.cwd(),
		context({ confirm: shutdownApproval.confirm }),
	));
	await shutdownApproval.opened;
	await shutdownDuringApproval.shutdown();
	shutdownApproval.respond(true);
	const shutdownStartError = await shutdownStart;
	check("shutdown during approval starts no children", shutdownStartError.includes("start was cancelled") && shutdownDuringApproval.status().length === 0);

	const swappedWorkingDirectory = makeManager();
	const swapRoot = await mkdtemp(join(tmpdir(), "pi-subagent-cwd-"));
	try {
		const approvedPath = join(swapRoot, "approved");
		const movedPath = join(swapRoot, "moved");
		const replacementPath = join(swapRoot, "replacement");
		await Promise.all([mkdir(approvedPath), mkdir(replacementPath)]);
		const swapApproval = approvalGate();
		const swapStart = swappedWorkingDirectory.start(
			[{ ...task("done"), cwd: approvedPath }],
			process.cwd(),
			context({ confirm: swapApproval.confirm }),
		);
		await swapApproval.opened;
		await rename(approvedPath, movedPath);
		await symlink(replacementPath, approvedPath, "dir");
		swapApproval.respond(true);
		const swapResult = (await swapStart)[0];
		check("working-directory changes invalidate approval", swapResult?.status === "failed" && !!swapResult.error?.includes("changed while starting"));
	} finally {
		await rm(swapRoot, { recursive: true, force: true });
	}

	const supervisedStats: AutoApproveStat[] = [];
	const supervised = makeManager((stat) => supervisedStats.push(stat));
	let supervisorUiCalls = 0;
	const waiting = await supervised.start(
		[task("ask")],
		process.cwd(),
		context({ select: async () => { supervisorUiCalls++; return "Approve once"; } }),
	);
	check("supervisor question pauses the child", waiting[0]?.status === "waiting");
	check("supervisor question is structured", waiting[0]?.question?.question === "Which option?");
	check("supervisor question does not open user approval UI", supervisorUiCalls === 0);
	check("stats before a supervisor checkpoint are forwarded", supervisedStats.join(",") === "evaluatorAllows");
	const resumed = await supervised.reply(waiting[0].id, "two", context());
	check("reply resumes existing child", resumed.status === "idle" && resumed.output === "answer: two");
	check("reply does not replay forwarded stats", supervisedStats.join(",") === "evaluatorAllows");
	check(
		"reply status includes cost accumulated across checkpoints",
		resumed.usage.cost.total === 0.066 && formatRunStatus(resumed).includes("$0.066"),
	);
	check(
		"result headings include cost at each checkpoint",
		formatResultHeading(waiting[0]).endsWith("waiting for supervisor · $0.033") &&
			formatResultHeading(resumed).endsWith("idle · $0.066"),
	);

	const approvalStats: AutoApproveStat[] = [];
	const approvals = makeManager((stat) => approvalStats.push(stat));
	let approvalTitle = "";
	let approvalCalls = 0;
	let approvalNotices = 0;
	const approved = await approvals.start(
		[task("approval")],
		process.cwd(),
		context({
			select: async (title) => {
				approvalCalls++;
				approvalTitle = title;
				return "Approve once";
			},
			notify: () => approvalNotices++,
		}),
	);
	check("approval request goes directly to user UI", approvalCalls === 1);
	check(
		"approval UI identifies the subagent and cwd",
		approvalTitle.includes("approval required") && approvalTitle.includes(approved[0].id) && approvalTitle.includes(process.cwd()),
	);
	check("approval request never becomes a supervisor checkpoint", approved[0]?.status === "idle");
	check("approval wait is visible without exposing it to the supervisor", approved[0]?.activity.some((entry) => entry.message === "waiting for user approval"));
	check("user approval response returns only to child", approved[0]?.output === "user decision: Approve once");
	check(
		"approval stats are forwarded without user notifications",
		approvalStats.join(",") === "softRejections,escalations,humanApprovals" && approvalNotices === 0,
	);

	const approvalRace = makeManager();
	let releaseApproval!: (value: string) => void;
	let markDialogOpen!: () => void;
	const dialogOpen = new Promise<void>((resolve) => { markDialogOpen = resolve; });
	const raceContext = context({
		select: async () => {
			markDialogOpen();
			return new Promise<string>((resolve) => { releaseApproval = resolve; });
		},
	});
	let raceRunId = "";
	const raceStarted = approvalRace.start(
		[task("approval")],
		process.cwd(),
		raceContext,
		(results) => { raceRunId = results[0]?.id ?? raceRunId; },
	);
	await dialogOpen;
	await approvalRace.cancel(raceRunId);
	releaseApproval("Approve once");
	const raceResult = await raceStarted;
	await new Promise((resolve) => setTimeout(resolve, 0));
	check("cancelling during an approval dialog does not reject its late response", raceResult[0]?.status === "cancelled");

	const dialogIsolation = makeManager();
	let releaseBlockingDialog!: (value: string) => void;
	let markBlockingDialogOpen!: () => void;
	const blockingDialogOpen = new Promise<void>((resolve) => { markBlockingDialogOpen = resolve; });
	const blockingStart = dialogIsolation.start(
		[task("approval")],
		process.cwd(),
		context({
			select: async () => {
				markBlockingDialogOpen();
				return new Promise<string>((resolve) => { releaseBlockingDialog = resolve; });
			},
		}),
	);
	await blockingDialogOpen;
	const queuedAbortController = new AbortController();
	let queuedApprovalCalls = 0;
	const queuedStart = errorMessage(dialogIsolation.start(
		[{ ...task("done"), cwd: "~" }],
		process.cwd(),
		context({
			confirm: async () => {
				queuedApprovalCalls++;
				return true;
			},
		}),
		undefined,
		queuedAbortController.signal,
	));
	await new Promise((resolve) => setTimeout(resolve, 25));
	queuedAbortController.abort();
	const queuedStartError = await Promise.race([
		queuedStart,
		new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 500)),
	]);
	check("queued working-directory approval observes cancellation", queuedStartError.includes("start was cancelled") && queuedApprovalCalls === 0);

	const notifyingStart = dialogIsolation.start([task("notify")], process.cwd(), context());
	const notificationSettled = await Promise.race([
		notifyingStart.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
	]);
	check("non-blocking child UI events bypass another child's dialog", notificationSettled);
	releaseBlockingDialog("Approve once");
	await Promise.all([blockingStart, notifyingStart]);

	const malformedNotification = makeManager();
	let malformedNotificationCalls = 0;
	const malformedNotificationResult = await malformedNotification.start(
		[task("malformed notify")],
		process.cwd(),
		context({ notify: () => malformedNotificationCalls++ }),
	);
	check(
		"malformed child notifications do not fail the run",
		malformedNotificationResult[0]?.status === "idle" && malformedNotificationCalls === 0,
	);

	const otherGate = makeManager();
	let otherGateCalls = 0;
	const otherGateResult = await otherGate.start(
		[task("permission")],
		process.cwd(),
		context({ select: async () => { otherGateCalls++; return "Deny"; } }),
	);
	check("unmarked extension dialogs also go directly to user UI", otherGateCalls === 1);
	check("unmarked command approval is not a supervisor checkpoint", otherGateResult[0]?.status === "idle");

	const headless = makeManager();
	const denied = await headless.start([task("approval")], process.cwd(), context({ hasUI: false }));
	check("headless approval is cancelled instead of sent to supervisor", denied[0]?.status === "idle" && denied[0]?.output === "user decision: cancelled");

	const parallel = makeManager();
	const parallelResults = await parallel.start([task("done one"), task("done two"), task("done three"), task("done four"), task("done five")], process.cwd(), context());
	check("five tasks run as one concurrent batch", parallelResults.length === 5 && parallelResults.every((result) => result.status === "idle"));

	const parallelApprovalStats: AutoApproveStat[] = [];
	const parallelApprovals = makeManager((stat) => parallelApprovalStats.push(stat));
	const parallelApprovalResults = await parallelApprovals.start(
		[task("approval one"), task("approval two")],
		process.cwd(),
		context(),
	);
	const statCount = (stat: AutoApproveStat) => parallelApprovalStats.filter((candidate) => candidate === stat).length;
	check(
		"parallel child approval stats are aggregated independently",
		parallelApprovalResults.every((result) => result.status === "idle") &&
			statCount("softRejections") === 2 &&
			statCount("escalations") === 2 &&
			statCount("humanApprovals") === 2,
	);

	const abortable = makeManager();
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 20);
	const aborted = await abortable.start([task("hang")], process.cwd(), context(), undefined, controller.signal);
	check("parent abort cancels its children", aborted[0]?.status === "cancelled");
} finally {
	await Promise.all(managers.map((manager) => manager.shutdown()));
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
