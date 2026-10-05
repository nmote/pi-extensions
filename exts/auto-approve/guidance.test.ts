import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SubagentManager } from "../subagents/manager.ts";
import autoApprove from "./index.ts";
import { requestApprovalDialog, requestGuidance, guidanceFailure, decodeGuidanceResponse, GuidanceError } from "../shared/approval-guidance.ts";
import { SUBAGENT_TOKEN_ENV } from "../shared/subagent-protocol.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else { failures++; console.error(`FAIL  ${name}`); }
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const verdict = (decision: "allow" | "review") => ({
	stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ decision, reason: "test policy" }) }],
});
type Entry = { type: string; customType: string; data: any };

function harness(entries: Entry[] = [], parent?: { pi: any; ctx: any }, token = "child") {
	const handlers = new Map<string, any>();
	const events = new Map<string, any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const prompts: string[] = [];
	const statuses: string[] = [];
	const notices: string[] = [];
	const selections: string[] = [];
	const editors: string[] = [];
	const controls = {
		stopped: false,
		choice: "Approve once + edit session guidance…" as string | undefined,
		editor: async (_prefill: string): Promise<string | undefined> => "Allow Linear updates in project X",
		evaluate: async (prompt: string) => verdict(prompt.includes("Session guidance (trusted user authorization)") ? "allow" : "review"),
	};
	const pi = {
		events: {
			on: (name: string, fn: any) => events.set(name, fn),
			emit: (name: string, value: any) => events.get(name)?.(value),
		},
		on: (name: string, fn: any) => handlers.set(name, fn),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerFlag() {}, registerShortcut() {}, getFlag() {},
		getAllTools: () => [{ name: "linear_update" }],
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	};
	const ctx = {
		cwd: "/workspace", hasUI: true, signal: undefined as AbortSignal | undefined,
		shutdown: () => { controls.stopped = true; },
		sessionManager: { getEntries: () => entries },
		modelRegistry: {
			getAvailable: () => [{ provider: "test", id: "small" }], hasConfiguredAuth: () => true,
			streamSimple: (_model: unknown, request: { systemPrompt: string }) => {
				prompts.push(request.systemPrompt);
				return { result: () => controls.evaluate(request.systemPrompt) };
			},
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (_key: string, text: string) => statuses.push(text), setWidget() {},
			notify: (text: string) => notices.push(text),
			select: async (title: string) => { selections.push(title); return controls.choice; },
			editor: async (title: string, prefill: string) => { editors.push(title); return controls.editor(prefill); },
			input: async (title: string, request: string): Promise<string | undefined> => {
				if (!parent || title !== `[[pi-subagent-guidance:${token}]]`) return undefined;
				try { return JSON.stringify({ ok: true, guidance: await requestGuidance(parent.pi as any, parent.ctx as any, JSON.parse(request)) }); }
				catch (error) { return JSON.stringify(guidanceFailure(error)); }
			},
		},
	};
	const previousToken = process.env[SUBAGENT_TOKEN_ENV];
	if (parent) process.env[SUBAGENT_TOKEN_ENV] = token;
	else delete process.env[SUBAGENT_TOKEN_ENV];
	try { autoApprove(pi as any); }
	finally {
		if (previousToken === undefined) delete process.env[SUBAGENT_TOKEN_ENV];
		else process.env[SUBAGENT_TOKEN_ENV] = previousToken;
	}
	return {
		pi, ctx, entries, controls, prompts, notices, statuses, selections, editors,
		start: () => handlers.get("session_start")({}, ctx),
		gate: (id: string, toolName = "linear_update") => handlers.get("tool_call")({ toolName, input: { id } }, ctx),
		command: (args: string) => commands.get("auto").handler(args, ctx),
		policy: () => requestGuidance(pi as any, ctx as any, { action: "get" }),
		escalate: async (id: string, signal?: AbortSignal) => {
			const rejection = await handlers.get("tool_call")({ toolName: "linear_update", input: { id } }, ctx);
			const requestId = /requestId "([^"]+)"/.exec(rejection.reason)?.[1];
			return tools.get("request_tool_approval").execute("approval", { requestId, justification: "needed" }, signal, undefined, ctx);
		},
	};
}

class OtherExtensionGuidanceError extends Error {
	constructor(readonly code: "GUIDANCE_UNAVAILABLE" | "GUIDANCE_REVISION_CONFLICT" | "REQUEST_CANCELLED", message: string) { super(message); }
}
for (const code of ["GUIDANCE_UNAVAILABLE", "GUIDANCE_REVISION_CONFLICT", "REQUEST_CANCELLED"] as const) {
	try {
		decodeGuidanceResponse(JSON.stringify(guidanceFailure(new OtherExtensionGuidanceError(code, `specific ${code}`))));
		check(`${code} crosses extension class boundaries`, false);
	} catch (error) {
		check(`${code} crosses extension class boundaries`, error instanceof GuidanceError && error.code === code && error.message === `specific ${code}`);
	}
}
for (const response of ['{"text":"legacy","revision":0}', "not json"]) {
	try { decodeGuidanceResponse(response); check("invalid protocol response fails closed", false); }
	catch (error) { check("invalid protocol response fails closed", error instanceof GuidanceError && error.code === "PROTOCOL_MISMATCH" && error.message.includes("/reload")); }
}

const temp = mkdtempSync(join(tmpdir(), "pi-guidance-test-"));
const previousDir = process.env.PI_CODING_AGENT_DIR;
try {
	process.env.PI_CODING_AGENT_DIR = temp;
	mkdirSync(join(temp, "extensions"));
	writeFileSync(join(temp, "extensions/small-model.json"), JSON.stringify({ provider: "test", model: "small" }));
	writeFileSync(join(temp, "extensions/auto-approve.json"), JSON.stringify({
		defaultMode: "auto", deny: [{ tool: "forbidden" }],
		context: [{ tool: "linear_update", instructions: "External writes require review" }],
	}));

	const root = harness();
	await root.start();
	await root.escalate("first");
	check("approval editing saves session guidance and approves the exact call once",
		(await root.policy()).revision === 1 && (await root.gate("first")) === undefined && root.editors[0].includes("future resumes"));
	await root.gate("next");
	const count = root.prompts.length;
	await root.gate("next");
	check("guidance is separate trusted authorization with explicit precedence",
		root.prompts.at(-1)!.includes("supersedes conflicting safety guidance") && root.prompts.at(-1)!.includes("External writes require review"));
	check("unchanged guidance permits cache reuse and has a visible indicator", root.prompts.length === count && root.statuses.some((text) => text?.includes("session guidance")));
	await root.command('test linear_update {"id":"dry-run"}');
	check("dry-run evaluation receives session guidance", root.prompts.at(-1)!.includes("Allow Linear updates in project X"));

	const resumed = harness(root.entries);
	await resumed.start();
	await resumed.gate("next");
	check("resumption restores both guidance and its matching cache", (await resumed.policy()).revision === 1 && resumed.prompts.length === 0);
	const unrelated = harness();
	await unrelated.start();
	check("unrelated sessions have no guidance", (await unrelated.policy()).text === "");
	unrelated.controls.evaluate = async () => verdict("review");
	await unrelated.escalate("guidance-once");
	check("guidance approval grants one retry without a session-wide memo",
		(await unrelated.policy()).revision === 1 && (await unrelated.gate("guidance-once")) === undefined &&
		(await unrelated.gate("guidance-once"))?.block === true &&
		!unrelated.entries.some((entry) => entry.customType === "auto-approve-memo"));

	const child = harness([], root, "child");
	const sibling = harness([], root, "sibling");
	const nested = harness([], child, "nested");
	await Promise.all([child.start(), sibling.start(), nested.start()]);
	await Promise.all([child.gate("child"), sibling.gate("sibling"), nested.gate("nested")]);
	check("children and descendants consult the main session", [child, sibling, nested].every((agent) => agent.prompts[0].includes("Allow Linear updates in project X")));
	child.controls.editor = async () => "Allow Linear updates in project Y";
	await child.command("guidance");
	await sibling.gate("sibling");
	check("child-originated edits persist only in the main session and reach existing siblings",
		(await root.policy()).text.includes("project Y") && !child.entries.some((entry) => entry.customType === "auto-approve-guidance") && sibling.prompts.at(-1)!.includes("project Y"));
	await root.command("guidance clear");
	check("clearing invalidates previously allowed child cache entries", (await sibling.gate("sibling"))?.block === true);
	const cleared = harness(root.entries);
	await cleared.start();
	check("clearing persists across resumes", (await cleared.policy()).text === "" && (await cleared.policy()).revision === 3);

	await root.command("guidance");
	const pending = deferred<ReturnType<typeof verdict>>();
	root.controls.evaluate = async () => pending.promise;
	const inflight = root.gate("inflight");
	await flush();
	await root.command("guidance clear");
	root.controls.evaluate = async () => verdict("review");
	pending.resolve(verdict("allow"));
	check("revocation discards an in-flight allow and reevaluates", (await inflight)?.block === true && !root.entries.some((entry) =>
		entry.customType === "auto-approve-evaluation" && entry.data.input.id === "inflight" && entry.data.output.decision === "allow"));

	const cancel = harness();
	await cancel.start();
	cancel.controls.editor = async () => undefined;
	await cancel.escalate("cancelled");
	check("cancelling the guidance editor neither saves nor approves", (await cancel.policy()).revision === 0 && (await cancel.gate("cancelled"))?.block === true);

	const editor = deferred<string | undefined>();
	cancel.controls.editor = async () => editor.promise;
	const first = cancel.escalate("queued-first");
	await flush();
	const selectionsBefore = cancel.selections.length;
	const second = cancel.escalate("queued-second");
	await flush();
	check("the editor holds the approval queue through the complete interaction", cancel.selections.length === selectionsBefore);
	cancel.controls.choice = "Deny";
	editor.resolve("Allow Linear updates in project Z");
	await Promise.all([first, second]);
	check("session guidance cannot override an explicit human denial", (await cancel.gate("queued-second"))?.reason.includes("user denied"));

	const late = deferred<string | undefined>();
	cancel.controls.choice = "Approve once + edit session guidance…";
	cancel.controls.editor = async () => late.promise;
	cancel.controls.evaluate = async () => verdict("review");
	const controller = new AbortController();
	const revisionBefore = (await cancel.policy()).revision;
	const aborted = cancel.escalate("aborted", controller.signal);
	await flush();
	controller.abort();
	await aborted;
	late.resolve("Allow everything");
	await flush();
	check("a late editor response cannot save guidance after cancellation", (await cancel.policy()).revision === revisionBefore);

	// A disconnected child cannot fall back to its last known authorization.
	await root.command("guidance");
	await sibling.gate("sibling");
	sibling.ctx.ui.input = async () => undefined;
	check("policy exchange failure blocks even a previously cached allow", (await sibling.gate("sibling"))?.block === true);
	sibling.ctx.ui.input = async () => '{"text":"legacy","revision":0}';
	await sibling.gate("sibling");
	check("invalid guidance protocol stops the child with a diagnostic", sibling.controls.stopped && sibling.notices.some((notice) => notice.startsWith("Subagent protocol failure:") && notice.includes("/reload")));
	check("guidance cannot override hard denies", (await root.gate("forbidden", "forbidden"))?.reason.includes("deny list"));
	check("guidance is stored as ordinary Pi session entries", root.entries.some((entry) => entry.type === "custom" && entry.customType === "auto-approve-guidance"));

	const forwardingRoot = harness();
	const origin = harness([], forwardingRoot);
	await Promise.all([forwardingRoot.start(), origin.start()]);
	origin.ctx.ui.select = (title: string) => requestApprovalDialog(forwardingRoot.pi as any, forwardingRoot.ctx as any, title, ["Approve once", "Deny"]);
	await origin.escalate("forwarded");
	check("the originating child commits a forwarded edit before granting its one-shot retry",
		(await forwardingRoot.policy()).revision === 1 && (await origin.gate("forwarded")) === undefined);
	const nestedEditorOpened = deferred<void>();
	const nestedEditorAnswer = deferred<string | undefined>();
	forwardingRoot.controls.editor = async () => { nestedEditorOpened.resolve(); return nestedEditorAnswer.promise; };
	origin.controls.evaluate = async () => verdict("review");
	const originAbort = new AbortController();
	const nestedApproval = origin.escalate("nested-cancel", originAbort.signal);
	await nestedEditorOpened.promise;
	originAbort.abort();
	await nestedApproval;
	nestedEditorAnswer.resolve("Allow everything");
	await flush();
	check("a cancelled descendant cannot commit a late editor response while its parents remain running", (await forwardingRoot.policy()).revision === 1);

	const rpcRoot = harness();
	await rpcRoot.start();
	const editorOpened = deferred<void>();
	const editorAnswer = deferred<string | undefined>();
	rpcRoot.controls.editor = async () => { editorOpened.resolve(); return editorAnswer.promise; };
	let policyReads = 0;
	const firstPolicyRead = deferred<void>();
	const manager = new SubagentManager({
		invocation: { command: process.execPath, argsPrefix: [fileURLToPath(new URL("../subagents/fixtures/fake-rpc-child.mjs", import.meta.url))] },
		onGuidanceRequest: (request, ctx) => {
			policyReads++;
			firstPolicyRead.resolve();
			return requestGuidance(rpcRoot.pi as any, ctx, request);
		},
		onApprovalRequest: (ctx, title, choices) => requestApprovalDialog(rpcRoot.pi as any, ctx, title, choices),
	});
	try {
		const running = manager.start([{ task: "guidance dialog", agent: "general", cwd: process.cwd(), systemPrompt: "test" }], process.cwd(), rpcRoot.ctx as any);
		await editorOpened.promise;
		const readTimeout = setTimeout(() => firstPolicyRead.resolve(), 2000);
		await firstPolicyRead.promise;
		clearTimeout(readTimeout);
		check("RPC policy reads bypass an open approval editor in the same child", policyReads === 1);
		editorAnswer.resolve("Allow Linear updates in project RPC");
		const [completed] = await running;
		const result = JSON.parse(completed.output!);
		check("child approval editing uses the main session's editor and returns a one-shot approval",
			result["guidance-approval"] === "Approve once" && (await rpcRoot.policy()).text.includes("project RPC") && rpcRoot.editors.length === 1);
		const followup = await manager.continue(completed.id, "guidance get", () => "auto", rpcRoot.ctx as any);
		check("retained children read current authoritative guidance over RPC", JSON.parse(followup.output!).revision === 1);
		const malformed = await manager.continue(completed.id, "guidance invalid", () => "auto", rpcRoot.ctx as any);
		check("malformed internal requests fail closed without a user dialog", malformed.output === "GUIDANCE_UNAVAILABLE" && rpcRoot.selections.length === 1);
		const beforeCounterfeit = policyReads;
		const counterfeit = await manager.continue(completed.id, "guidance wrong token", () => "auto", rpcRoot.ctx as any);
		check("a different token cannot access the internal policy bridge", counterfeit.output === "cancelled" && policyReads === beforeCounterfeit);
		const cancelledEditorOpened = deferred<void>();
		const cancelledEditorAnswer = deferred<string | undefined>();
		rpcRoot.controls.editor = async () => { cancelledEditorOpened.resolve(); return cancelledEditorAnswer.promise; };
		const cancelledApproval = manager.continue(completed.id, "guidance dialog", () => "auto", rpcRoot.ctx as any);
		await cancelledEditorOpened.promise;
		await manager.cancel(completed.id);
		await cancelledApproval;
		cancelledEditorAnswer.resolve("Allow everything");
		await flush();
		check("cancelling a child prevents its late editor response from changing main-session guidance", (await rpcRoot.policy()).revision === 1);
	} finally {
		await manager.shutdown();
	}
} finally {
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousDir;
	rmSync(temp, { recursive: true, force: true });
}
if (failures) process.exit(1);
console.log("\nall checks passed");
