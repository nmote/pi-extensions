import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUTO_APPROVE_STAT_CHANNEL,
	AUTO_APPROVE_STATE_CHANNEL,
	AUTO_APPROVE_TASK_CHANNEL,
	parseAutoApproveStat,
	SUBAGENT_TOKEN_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_TASK_COMMAND,
	taskPolicyAck,
} from "../shared/subagent-protocol.ts";
import { saveEvaluatorEffort } from "./config.ts";
import autoApprove from "./index.ts";
import subagents from "../subagents/index.ts";
import { scopeInstruction } from "./rules.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

async function bounded<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error("Concurrent approval test timed out")), 3000);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer!);
	}
}

function deferredDialogs() {
	let active = 0;
	let maxActive = 0;
	const opened: Array<{
		title: string;
		signal?: AbortSignal;
		answer(choice?: string): void;
		fail(): void;
	}> = [];
	return {
		opened,
		get maxActive() { return maxActive; },
		select(title: string, _choices: string[], options?: { signal?: AbortSignal }): Promise<string | undefined> {
			return new Promise((resolve, reject) => {
				active++;
				maxActive = Math.max(maxActive, active);
				let closed = false;
				const close = () => {
					if (!closed) active--;
					closed = true;
					options?.signal?.removeEventListener("abort", close);
				};
				options?.signal?.addEventListener("abort", close, { once: true });
				opened.push({
					title,
					signal: options?.signal,
					// Responses can arrive after cancellation, as with RPC clients.
					answer(choice) { close(); resolve(choice); },
					fail() { close(); reject(new Error("Dialog failed")); },
				});
			});
		},
	};
}

const flushDialogs = () => new Promise<void>((resolve) => setImmediate(resolve));

async function main(): Promise<void> {
	const temp = mkdtempSync(join(tmpdir(), "pi-auto-approve-index-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousSubagentToken = process.env[SUBAGENT_TOKEN_ENV];
	try {
		process.env.PI_CODING_AGENT_DIR = temp;
		delete process.env[SUBAGENT_TOKEN_ENV];
		mkdirSync(join(temp, "extensions"), { recursive: true });
		const configFile = join(temp, "extensions", "auto-approve.json");
		const importedFile = join(temp, "extensions", "auto-approve-base.json");
		writeFileSync(importedFile, JSON.stringify({ evaluator: { reasoningEffort: "low" } }));
		writeFileSync(
			configFile,
			JSON.stringify({
				imports: ["./auto-approve-base.json"],
				defaultMode: "auto",
				context: [{ tool: "web_fetch", instructions: "web fetch policy" }],
				writeRoots: ["../configured-write"],
				readRoots: ["../configured-read", "/shared"],
			}),
		);
		writeFileSync(
			join(temp, "extensions", "small-model.json"),
			JSON.stringify({ provider: "test", model: "small" }),
		);

		const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
		const eventHandlers = new Map<string, Array<(data: any) => void>>();
		const tools = new Map<string, any>();
		const commands = new Map<string, any>();
		const entries: Array<{ customType: string; data: unknown }> = [];
		const notices: string[] = [];
		const statuses: Array<{ key: string; value: string | undefined }> = [];
		let selection: string | undefined = "Approve once";
		let select: (title: string, choices: string[], options?: { signal?: AbortSignal }) => Promise<string | undefined> = async () => selection;
		const pi = {
			events: {
				on(name: string, handler: (data: any) => void) {
					eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
				},
				emit(name: string, data: any) {
					for (const handler of eventHandlers.get(name) ?? []) handler(data);
				},
			},
			registerFlag() {},
			registerShortcut() {},
			registerTool(tool: any) { tools.set(tool.name, tool); },
			registerCommand(name: string, command: any) { commands.set(name, command); },
			on(name: string, handler: (event: any, ctx: any) => any) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
			getFlag() { return undefined; },
			getAllTools() { return [{ name: "bash" }, { name: "web_fetch" }]; },
		};
		autoApprove(pi as any);

		const promptHook = handlers.get("before_agent_start")?.[0];
		if (!promptHook) throw new Error("before_agent_start handler was not registered");
		const promptEvent = {
			systemPrompt: "base prompt",
			systemPromptOptions: {
				selectedTools: ["bash", "edit"],
				promptGuidelines: ["Existing guidance"],
				sections: { other: "Other context" },
			},
		};
		check("prompt hook does not replace the system prompt", promptHook(promptEvent, {}) === undefined);
		const guidelines = promptEvent.systemPromptOptions.promptGuidelines;
		check(
			"inline-script guidance is general even without the approval tool",
			guidelines.length === 2 && guidelines[0] === "Existing guidance" &&
				guidelines[1].includes("small ad-hoc scripts") &&
				guidelines[1].includes("python3 - <<'EOF'") &&
				guidelines[1].includes("Prefer `edit`") &&
				promptEvent.systemPrompt === "base prompt" &&
				promptEvent.systemPromptOptions.sections.other === "Other context",
		);
		promptHook(promptEvent, {});
		check("repeated prompt hooks do not accumulate guidance", guidelines.length === 2);
		const freshEvent = { systemPromptOptions: { promptGuidelines: [] as string[] } };
		promptHook(freshEvent, {});
		check("fresh turns receive the same guidance", freshEvent.systemPromptOptions.promptGuidelines[0] === guidelines[1]);

		const scope = scopeInstruction(
			"/workspace",
			["../configured-write"],
			[join(temp, "skills"), "../configured-read", "/shared"],
			homedir(),
		);
		const command = "dangerous-command";
		const cachedReview = {
			type: "custom",
			customType: "auto-approve-evaluation",
			data: {
				tool: "bash",
				command,
				input: { command },
				instructions: [scope],
				effort: "low",
				output: { decision: "review", reason: "consequential operation" },
			},
		};
		const metadataPath = ".git/config";
		const cachedMetadataReview = {
			type: "custom",
			customType: "auto-approve-evaluation",
			data: {
				tool: "read",
				command: metadataPath,
				input: { path: metadataPath },
				instructions: [scope],
				effort: "low",
				output: { decision: "review", reason: "repository metadata" },
			},
		};
		const evaluatorRequests: Array<{ systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> }> = [];
		const evaluatorEfforts: string[] = [];
		let resumedEntries: Array<{ type: string; customType: string; data: unknown }> | undefined;
		const allowResponse = { stopReason: "stop", content: [{ type: "text", text: '{"decision":"allow","reason":"ok"}' }] };
		let evaluatorResponse: { stopReason: string; content: unknown[] } = allowResponse;
		const ctx = {
			cwd: "/workspace",
			hasUI: true,
			modelRegistry: {
				getAvailable: () => [{ provider: "test", id: "small" }],
				hasConfiguredAuth: () => true,
				streamSimple: (_model: unknown, request: (typeof evaluatorRequests)[number], options: { reasoning: string }) => {
					evaluatorRequests.push(request);
					evaluatorEfforts.push(options.reasoning);
					return { result: async () => evaluatorResponse };
				},
			},
			sessionManager: { getEntries: () => resumedEntries ?? [cachedReview, cachedMetadataReview] },
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setStatus(key: string, value: string | undefined) { statuses.push({ key, value }); },
				setWidget() {},
				notify(message: string) { notices.push(message); },
				select: (title: string, choices: string[], options?: { signal?: AbortSignal }) => select(title, choices, options),
			},
		};
		await handlers.get("session_start")?.[0]?.({}, ctx);
		check("mode footer is bracketed", statuses.at(-1)?.value === "[🤖 auto]");
		const gate = handlers.get("tool_call")?.[0];
		if (!gate) throw new Error("tool_call handler was not registered");

		check(
			"read within cwd is approved without evaluation",
			(await gate({ toolName: "read", input: { path: "src/file.ts" } }, ctx)) === undefined,
		);
		check(
			"read within readRoots is approved without evaluation",
			(await gate({ toolName: "read", input: { path: "/shared/file.ts" } }, ctx)) === undefined &&
				evaluatorRequests.length === 0,
		);
		await gate({ toolName: "read", input: { path: "/shared/x/.git/config" } }, ctx);
		check("read of .git within readRoots is evaluated", evaluatorRequests.length === 1);
		check("gate brackets and clears evaluation status", statuses.at(-2)?.value === "[evaluating…]" && statuses.at(-1)?.value === undefined);
		await gate({ toolName: "write", input: { path: "/shared/file.ts", content: "" } }, ctx);
		check(
			"write within readRoots is evaluated with the path scope",
			evaluatorRequests.length === 2 &&
				!!evaluatorRequests[1]?.systemPrompt.includes(
					`Read-only roots: ${join(temp, "skills")}, /configured-read, /shared.`,
				),
		);
		process.env[SUBAGENT_TOKEN_ENV] = "child-token";
		const noticesBeforeChildStat = notices.length;
		const metadataRead = await gate({ toolName: "read", input: { path: metadataPath } }, ctx);
		delete process.env[SUBAGENT_TOKEN_ENV];
		check("read within .git falls through to evaluation", metadataRead?.reason.includes("repository metadata"));
		check(
			"child stat increments are reported to the parent",
			notices.length === noticesBeforeChildStat + 1 &&
				parseAutoApproveStat(notices.at(-1) ?? "", "child-token") === "softRejections",
		);

		const first = await gate({ toolName: "bash", input: { command } }, ctx);
		const firstId = /requestId "([^"]+)"/.exec(first?.reason ?? "")?.[1];
		check(
			"evaluator review is rejected without prompting",
			!!first?.block && !!firstId && !!first?.reason.includes("Pursue a safer approach"),
		);

		const approvalTool = tools.get("request_tool_approval");
		check("registers an explicit escalation tool", !!approvalTool);
		check(
			"escalation tool bypasses evaluation but not the original call",
			(await gate({ toolName: "request_tool_approval", input: { requestId: firstId, justification: "needed" } }, ctx)) === undefined,
		);

		const approved = await approvalTool.execute("approval-1", { requestId: firstId, justification: "No safer path" }, undefined, undefined, ctx);
		check("approved escalation tells the agent to retry", approved.content[0].text.includes("Retry"));
		const retryEvent = { toolName: "bash", input: { command } };
		check("one-shot approval permits one exact retry", (await gate(retryEvent, ctx)) === undefined);
		check(
			"approved arguments are locked against later handlers",
			Object.isFrozen(retryEvent.input) && Object.getOwnPropertyDescriptor(retryEvent, "input")?.writable === false,
		);

		const parallelA = await gate({ toolName: "bash", input: { command } }, ctx);
		const parallelB = await gate({ toolName: "bash", input: { command } }, ctx);
		const parallelIdA = /requestId "([^"]+)"/.exec(parallelA?.reason ?? "")?.[1];
		const parallelIdB = /requestId "([^"]+)"/.exec(parallelB?.reason ?? "")?.[1];
		await approvalTool.execute("approval-2", { requestId: parallelIdA, justification: "First call" }, undefined, undefined, ctx);
		await approvalTool.execute("approval-3", { requestId: parallelIdB, justification: "Second call" }, undefined, undefined, ctx);
		check("two exact approvals grant two retries", (await gate({ toolName: "bash", input: { command } }, ctx)) === undefined);
		check("exact approval count is not collapsed", (await gate({ toolName: "bash", input: { command } }, ctx)) === undefined);

		const cancellable = await gate({ toolName: "bash", input: { command } }, ctx);
		const cancellableId = /requestId "([^"]+)"/.exec(cancellable?.reason ?? "")?.[1];
		selection = undefined;
		await approvalTool.execute("approval-4", { requestId: cancellableId, justification: "Maybe needed" }, undefined, undefined, ctx);
		const afterCancel = await gate({ toolName: "bash", input: { command } }, ctx);
		const denialId = /requestId "([^"]+)"/.exec(afterCancel?.reason ?? "")?.[1];
		check("cancelling approval does not seal the call", !!denialId);

		selection = "Deny";
		await approvalTool.execute("approval-5", { requestId: denialId, justification: "Still needed" }, undefined, undefined, ctx);
		const denied = await gate({ toolName: "bash", input: { command } }, ctx);
		check("human denial seals the exact call for the session", denied?.reason.includes("user denied this exact call"));

		process.env[SUBAGENT_TOKEN_ENV] = "child-token";
		const noticesBeforeImportedStat = notices.length;
		pi.events.emit(AUTO_APPROVE_STAT_CHANNEL, { stat: "evaluatorAllows" });
		pi.events.emit(AUTO_APPROVE_STAT_CHANNEL, { stat: "unknown" });
		delete process.env[SUBAGENT_TOKEN_ENV];
		check("imported child stats are not reported back to the parent", notices.length === noticesBeforeImportedStat);

		await commands.get("auto").handler("stats", ctx);
		const stats = notices.at(-1) ?? "";
		check(
			"stats report rejection, escalation, approval, and denial counts",
			stats.includes("evaluator allows: 3") &&
				stats.includes("soft rejections: 6") &&
				stats.includes("escalations: 5") &&
				stats.includes("human approvals: 3") &&
				stats.includes("human denials: 1"),
		);
		check("stats snapshots are persisted", entries.some((entry) => entry.customType === "auto-approve-stats"));

		await commands.get("auto").handler('test web_fetch {"url":"https://example.com/"}', ctx);
		check("test command brackets and clears evaluation status", statuses.at(-2)?.value === "[evaluating…]" && statuses.at(-1)?.value === undefined);
		const toolTest = evaluatorRequests.at(-1);
		const toolTestData = toolTest?.messages[0]?.content[0]?.text ?? "";
		check(
			"test evaluates a registered tool with JSON arguments and its context",
			toolTestData.includes("tool: web_fetch") &&
				toolTestData.includes('"url": "https://example.com/"') &&
				!!toolTest?.systemPrompt.includes("web fetch policy") &&
				(notices.at(-1) ?? "").startsWith("Evaluator verdict (web_fetch): ALLOW"),
		);

		await commands.get("auto").handler('test echo {"url":1}', ctx);
		check(
			"test treats JSON after an unregistered name as a bash command",
			(evaluatorRequests.at(-1)?.messages[0]?.content[0]?.text ?? "").includes('"command": "echo {\\"url\\":1}"'),
		);

		const flakyCall = { toolName: "bash", input: { command: "flaky-evaluation" } };
		evaluatorResponse = { stopReason: "aborted", content: [] };
		const failed = await gate(flakyCall, ctx);
		check(
			"evaluator failure invites a retry or escalation",
			!!failed?.block &&
				/retry/i.test(failed.reason) &&
				/requestId "[^"]+"/.test(failed.reason) &&
				!failed.reason.includes("evaluator requested review") &&
				!failed.reason.includes("Pursue a safer approach"),
		);
		evaluatorResponse = allowResponse;
		const requestsBeforeRetry = evaluatorRequests.length;
		check(
			"identical retry after failure is evaluated afresh",
			(await gate(flakyCall, ctx)) === undefined && evaluatorRequests.length > requestsBeforeRetry,
		);

		await commands.get("auto").handler("", ctx);
		check("status shows evaluator effort", (notices.at(-1) ?? "").includes("evaluator effort: low"));
		const effortCall = { toolName: "bash", input: { command: "effort-cache-check" } };
		await gate(effortCall, ctx);
		const beforeEffortChange = evaluatorRequests.length;
		await gate(effortCall, ctx);
		check("same effort reuses a cached verdict", evaluatorRequests.length === beforeEffortChange);
		await commands.get("auto").handler("effort high", ctx);
		const savedConfig = JSON.parse(readFileSync(configFile, "utf8"));
		check(
			"effort is saved locally without changing imports or other settings",
			savedConfig.evaluator.reasoningEffort === "high" &&
				savedConfig.imports[0] === "./auto-approve-base.json" &&
				savedConfig.readRoots[1] === "/shared" &&
				JSON.parse(readFileSync(importedFile, "utf8")).evaluator.reasoningEffort === "low",
		);
		await gate(effortCall, ctx);
		check(
			"changing effort invalidates cached verdicts and passes the chosen effort",
			evaluatorRequests.length === beforeEffortChange + 1 && evaluatorEfforts.at(-1) === "high",
		);
		await commands.get("auto").handler("effort invalid", ctx);
		check("invalid effort leaves selection unchanged", (notices.at(-1) ?? "").includes("Usage: /auto effort") && evaluatorEfforts.at(-1) === "high");
		writeFileSync(configFile, "{oops");
		await commands.get("auto").handler("effort low", ctx);
		await commands.get("auto").handler("", ctx);
		check(
			"failed save leaves effort unchanged and preserves the file",
			(notices.at(-1) ?? "").includes("evaluator effort: high") && readFileSync(configFile, "utf8") === "{oops",
		);
		writeFileSync(configFile, `${JSON.stringify(savedConfig)}\n`);
		const headless = { ...ctx, hasUI: false };
		await commands.get("auto").handler("effort", headless);
		check("headless picker reports direct syntax", (notices.at(-1) ?? "").includes("Usage: /auto effort"));
		selection = "medium";
		await commands.get("auto").handler("effort", ctx);
		await commands.get("auto").handler('test printf effort', ctx);
		check("picker and test command use selected effort", evaluatorEfforts.at(-1) === "medium");
		selection = undefined;
		await commands.get("auto").handler("effort", ctx);
		await commands.get("auto").handler("", ctx);
		check("cancelled picker keeps the current effort", (notices.at(-1) ?? "").includes("evaluator effort: medium"));
		resumedEntries = [...entries.map((entry) => ({ type: "custom", ...entry }))];
		await handlers.get("session_start")?.[0]?.({}, ctx);
		await commands.get("auto").handler("", ctx);
		check("effort persists on resume", (notices.at(-1) ?? "").includes("evaluator effort: medium"));
		const beforeResumedCall = evaluatorRequests.length;
		await gate(effortCall, ctx);
		check(
			"resume excludes verdicts from older efforts",
			evaluatorRequests.length === beforeResumedCall + 1 && evaluatorEfforts.at(-1) === "medium",
		);
		const resumeEffortCall = { toolName: "bash", input: { command: "resume-cache-check" } };
		await gate(resumeEffortCall, ctx);
		resumedEntries = [...entries.map((entry) => ({ type: "custom", ...entry }))];
		saveEvaluatorEffort("high", configFile);
		await handlers.get("session_start")?.[0]?.({}, ctx);
		await commands.get("auto").handler("", ctx);
		check("resume uses the latest global setting", (notices.at(-1) ?? "").includes("evaluator effort: high"));
		const beforeExternalChange = evaluatorRequests.length;
		await gate(resumeEffortCall, ctx);
		check(
			"resume does not reuse a verdict cached at another effort",
			evaluatorRequests.length === beforeExternalChange + 1 && evaluatorEfforts.at(-1) === "high",
		);

		const childCtx = { ...ctx, cwd: "/workspace/child" };
		const requestsBeforeChildWrites = evaluatorRequests.length;
		await gate({ toolName: "write", input: { path: "src/new.ts", content: "" } }, childCtx);
		await gate({ toolName: "edit", input: { path: "src/old.ts", edits: [] } }, childCtx);
		await gate({ toolName: "write", input: { path: "../configured-write/out.ts", content: "" } }, childCtx);
		await gate({ toolName: "read", input: { path: "../configured-read/input.ts" } }, childCtx);
		check(
			"child file scope uses its cwd plus configured relative roots",
			evaluatorRequests.length === requestsBeforeChildWrites,
		);
		await gate({ toolName: "write", input: { path: "/workspace/supervisor/out.ts", content: "" } }, childCtx);
		await gate({ toolName: "edit", input: { path: "/workspace/sibling/file.ts", edits: [] } }, childCtx);
		check(
			"supervisor and sibling paths outside child scope receive normal evaluation",
			evaluatorRequests.length === requestsBeforeChildWrites + 2,
		);
		check(
			"evaluator instructions name the child cwd and configured root as writable",
			!!evaluatorRequests.at(-1)?.systemPrompt.includes(
				"Writable roots: /workspace/child, /workspace/configured-write.",
			),
		);

		// Deliberately not realpath'd: the macOS tmpdir is itself a symlink.
		const links = join(temp, "links");
		mkdirSync(join(links, "real"), { recursive: true });
		mkdirSync(join(links, "outside"));
		writeFileSync(join(links, "real", "file"), "");
		writeFileSync(join(links, "outside", "secret"), "");
		symlinkSync("real", join(links, "root"));
		symlinkSync("../outside/secret", join(links, "real", "escape"));
		symlinkSync("../outside", join(links, "real", "escdir"));
		symlinkSync("../outside/missing", join(links, "real", "dangling"));
		const linkCtx = { ...ctx, cwd: join(links, "root") };
		const evaluated = async (toolName: string, input: Record<string, unknown>) => {
			const before = evaluatorRequests.length;
			await gate({ toolName, input }, linkCtx);
			return evaluatorRequests.length > before;
		};
		check("read through a symlinked cwd is approved without evaluation", !(await evaluated("read", { path: "file" })));
		check(
			"write under missing directories is approved without evaluation",
			!(await evaluated("write", { path: "new/dir/x.txt", content: "" })),
		);
		check(
			"read through an escaping symlink is evaluated with its resolved path",
			(await evaluated("read", { path: "escape" })) &&
				!!evaluatorRequests.at(-1)?.systemPrompt.includes(realpathSync(join(links, "outside", "secret"))),
		);
		check(
			"write under an escaping symlinked directory is evaluated",
			await evaluated("write", { path: "escdir/new.txt", content: "" }),
		);
		check("write through a dangling symlink is evaluated", await evaluated("write", { path: "dangling", content: "" }));

		process.env[SUBAGENT_TOKEN_ENV] = "child-token";
		const previousRunId = process.env[SUBAGENT_RUN_ID_ENV];
		try {
			process.env[SUBAGENT_RUN_ID_ENV] = "child-id";
			subagents(pi as any);
		} finally {
			if (previousRunId === undefined) delete process.env[SUBAGENT_RUN_ID_ENV];
			else process.env[SUBAGENT_RUN_ID_ENV] = previousRunId;
		}
		check("standby children disable cache warming", handlers.get("cache_warming_decision")?.[0]?.({}, ctx)?.action === "stop");
		const noticesBeforePolicy = notices.length;
		await commands.get(SUBAGENT_TASK_COMMAND).handler("child-token yolo", { ...ctx, mode: "rpc" });
		check("child policy update emits only its internal acknowledgement", notices.length === noticesBeforePolicy + 1 && notices.at(-1) === taskPolicyAck("child-token", "yolo"));
		await commands.get("auto").handler("manual", ctx);
		check("explicit mode changes still announce", notices.at(-1) === "Auto-approve mode: ✋ manual");
		let acknowledged = false;
		const beginTask = (mode: string, token = "child-token") => {
			acknowledged = false;
			pi.events.emit(AUTO_APPROVE_TASK_CHANNEL, { token, mode, ctx, respond: () => { acknowledged = true; } });
		};
		const currentMode = () => {
			let mode: string | undefined;
			pi.events.emit(AUTO_APPROVE_STATE_CHANNEL, { respond: (state: { mode: string }) => { mode = state.mode; } });
			return mode;
		};
		beginTask("yolo");
		check("managed task synchronizes approval mode", acknowledged && currentMode() === "yolo");
		beginTask("manual", "wrong-token");
		check("policy update rejects wrong child token", !acknowledged && currentMode() === "yolo");
		beginTask("manual");
		selection = "Approve (always this exact call this session)";
		const rememberedCall = { toolName: "bash", input: { command: "remembered-across-tasks" } };
		await gate(rememberedCall, ctx);
		beginTask("manual");
		selection = "Deny";
		check("always-allow survives task boundaries", (await gate({ ...rememberedCall, input: { ...rememberedCall.input } }, ctx)) === undefined);

		beginTask("auto");
		evaluatorResponse = { stopReason: "stop", content: [{ type: "text", text: '{"decision":"review","reason":"needs approval"}' }] };
		const oneShotCall = { toolName: "bash", input: { command: "one-shot-task-boundary" } };
		const rejected = await gate(oneShotCall, ctx);
		const oneShotId = /requestId "([^"]+)"/.exec(rejected.reason)?.[1];
		selection = "Approve once";
		await approvalTool.execute("task-once", { requestId: oneShotId, justification: "needed" }, undefined, undefined, ctx);
		const pendingCall = await gate({ toolName: "bash", input: { command: "pending-task-boundary" } }, ctx);
		const pendingId = /requestId "([^"]+)"/.exec(pendingCall.reason)?.[1];
		beginTask("auto");
		check("one-shot allowance expires at task boundary", (await gate(oneShotCall, ctx))?.block === true);
		const expired = await approvalTool.execute("old-task", { requestId: pendingId, justification: "needed" }, undefined, undefined, ctx);
		check("old task approval requests expire", expired.content[0].text.includes("invalid or expired"));

		await bounded((async () => {
			const call = (command: string) => ({ toolName: "bash", input: { command } });
			const request = async (command: string) => {
				const rejection = await gate(call(command), ctx);
				const requestId = /requestId "([^"]+)"/.exec(rejection?.reason ?? "")?.[1];
				if (!requestId) throw new Error(`No approval request for ${command}`);
				return { requestId, justification: command };
			};
			const escalate = (params: { requestId: string; justification: string }, signal?: AbortSignal) =>
				approvalTool.execute(params.justification, params, signal, undefined, ctx);
			const humans = () => entries.filter((entry) => entry.customType === "auto-approve-memo" || entry.customType === "auto-approve-human-deny" ||
				(entry.customType === "auto-approve-stats" && (entry.data as any).humanApprovals > 0));

			let dialogs = deferredDialogs();
			select = dialogs.select;
			const requests = await Promise.all(["fifo-once", "fifo-deny", "fifo-always"].map(request));
			const results = requests.map((params) => escalate(params));
			await flushDialogs();
			check("concurrent escalations open only the first dialog", dialogs.opened.length === 1 && dialogs.opened[0].title.includes("fifo-once"));
			dialogs.opened[0].answer("Approve once");
			await flushDialogs();
			check("second approval follows the first", dialogs.opened.length === 2 && dialogs.opened[1].title.includes("fifo-deny"));
			dialogs.opened[1].answer("Deny");
			await flushDialogs();
			check("third approval follows denial", dialogs.opened.length === 3 && dialogs.opened[2].title.includes("fifo-always"));
			dialogs.opened[2].answer("Approve (always this exact call this session)");
			const completed = await Promise.all(results);
			check("concurrent approvals settle with their own decisions", completed[0].content[0].text.startsWith("Approved once") &&
				completed[1].content[0].text.startsWith("Denied") && completed[2].content[0].text.startsWith("Approved for") && dialogs.maxActive === 1);
			check("concurrent decisions authorize only their exact calls", (await gate(call("fifo-once"), ctx)) === undefined &&
				(await gate(call("fifo-once"), ctx))?.block && (await gate(call("fifo-deny"), ctx))?.reason.includes("user denied") &&
				(await gate(call("fifo-always"), ctx)) === undefined && (await gate(call("fifo-always"), ctx)) === undefined);

			const queuedRequest = await request("queued-cancel");
			const survivorRequest = await request("cancel-survivor");
			await commands.get("auto").handler("manual", ctx);
			dialogs = deferredDialogs();
			select = dialogs.select;
			const activeAbort = new AbortController();
			const active = gate(call("active-cancel"), { ...ctx, signal: activeAbort.signal });
			const queuedAbort = new AbortController();
			const queued = escalate(queuedRequest, queuedAbort.signal);
			const survivor = escalate(survivorRequest);
			await flushDialogs();
			queuedAbort.abort();
			check("queued cancellation settles before the active dialog", (await queued).content[0].text.includes("cancelled") && dialogs.opened.length === 1);
			activeAbort.abort();
			check("active manual approval cancels through its operation signal", (await active)?.reason.includes("cancelled") && dialogs.opened[0].signal?.aborted === true);
			await flushDialogs();
			check("manual and escalated approvals share one queue", dialogs.opened.length === 2 && dialogs.opened[1].title.includes("cancel-survivor") && dialogs.maxActive === 1);
			const beforeLateResponse = humans().length;
			dialogs.opened[0].answer("Approve (always this exact call this session)");
			await flushDialogs();
			check("late cancelled responses do not grant approval", humans().length === beforeLateResponse);
			dialogs.opened[1].answer("Approve once");
			await survivor;

			dialogs = deferredDialogs();
			select = dialogs.select;
			const failed = gate(call("dialog-failure"), ctx).catch((error: Error) => error.message);
			const afterFailure = gate(call("after-dialog-failure"), ctx);
			await flushDialogs();
			dialogs.opened[0].fail();
			check("dialog errors propagate", (await failed) === "Dialog failed");
			await flushDialogs();
			dialogs.opened[1].answer("Approve once");
			check("dialog failure does not block later approvals", (await afterFailure) === undefined && dialogs.maxActive === 1);
			const preAborted = new AbortController();
			preAborted.abort();
			check("already-aborted manual requests never open", (await gate(call("pre-aborted"), { ...ctx, signal: preAborted.signal }))?.block && dialogs.opened.length === 2);
			check("headless manual approval remains blocked", (await gate(call("headless-manual"), headless))?.block && dialogs.opened.length === 2);

			for (const boundary of ["session_shutdown", "session_start", "managed_task"]) {
				await commands.get("auto").handler("auto", ctx);
				dialogs = deferredDialogs();
				select = dialogs.select;
				const first = await request(`${boundary}-active`);
				const second = await request(`${boundary}-queued`);
				const pending = [escalate(first), escalate(second)];
				await flushDialogs();
				const beforeReset = humans().length;
				// Resolve the UI before invalidation to exercise the continuation race.
				dialogs.opened[0].answer("Approve (always this exact call this session)");
				if (boundary === "managed_task") beginTask("auto");
				else await handlers.get(boundary)?.[0]?.({}, ctx);
				const cancelled = await Promise.all(pending);
				check(`${boundary} cancels active and queued approvals without stale grants`,
					cancelled.every((result) => result.content[0].text.includes("cancelled")) && dialogs.opened.length === 1 &&
					dialogs.opened[0].signal?.aborted === true && humans().length === beforeReset);
				const fresh = escalate(await request(`${boundary}-fresh`));
				await flushDialogs();
				dialogs.opened[1].answer("Approve once");
				check(`${boundary} permits fresh approvals`, (await fresh).content[0].text.startsWith("Approved once"));
			}
		})());
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousSubagentToken === undefined) delete process.env[SUBAGENT_TOKEN_ENV];
		else process.env[SUBAGENT_TOKEN_ENV] = previousSubagentToken;
		rmSync(temp, { recursive: true, force: true });
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
