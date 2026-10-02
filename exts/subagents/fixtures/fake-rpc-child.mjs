import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
const sessionFile = args.includes("--session") ? args[args.indexOf("--session") + 1] : join(sessionDir, `fake_${args[args.indexOf("--session-id") + 1]}.jsonl`);
const sessionId = args.includes("--session") ? JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]).id : args[args.indexOf("--session-id") + 1];
const token = process.env.PI_SUBAGENT_TOKEN;
let pending;
let guidanceDialog;
let mode;
let acknowledgePolicy = true;
let slowDiscovery = false;
let slowPolicy = false;
let straySettlement = false;
const history = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, "utf8").trim().split("\n")[1]).data : [];

function persist() {
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() })}\n${JSON.stringify({ type: "custom", id: "history", parentId: null, timestamp: new Date().toISOString(), customType: "fake-history", data: history })}\n`);
}

function send(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function reportAutoApproveStat(stat) {
	send({
		type: "extension_ui_request",
		id: `stat-${stat}-${Date.now()}`,
		method: "notify",
		message: `[[pi-subagent-auto-approve-stat:${token}]]${stat}`,
		notifyType: "info",
	});
}

function assistant(text, stopReason = "stop") {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		provider: "fake",
		model: "fake-model",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 18,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function finish(text) {
	history.push({ role: "assistant", text });
	persist();
	send({ type: "message_end", message: assistant(text) });
	send({ type: "agent_settled" });
}

function processLine(line) {
	const command = JSON.parse(line);
	if (command.type === "get_state") {
		send({ id: command.id, type: "response", command: "get_state", success: true, data: { model: { provider: "fake", id: "fake-model" } } });
		return;
	}
	if (command.type === "get_commands") {
		const respond = () => send({ id: command.id, type: "response", command: "get_commands", success: true, data: { commands: [{ name: "_subagent-task" }] } });
		if (slowDiscovery) {
			send({ type: "extension_ui_request", id: "discovery-pause", method: "notify", message: "discovering task policy" });
			setTimeout(respond, 25);
		} else respond();
		return;
	}
	if (command.type === "prompt") {
		if (command.message.startsWith("/_subagent-task ")) {
			const [, suppliedToken, requestedMode] = command.message.split(" ");
			const respond = () => {
				if (straySettlement) send({ type: "agent_settled" });
				if (acknowledgePolicy && suppliedToken === token) {
					mode = requestedMode;
					send({ type: "extension_ui_request", id: "policy-ack", method: "notify", message: `[[pi-subagent-task-policy:${token}]]${mode}` });
				}
				send({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
			};
			if (slowPolicy) {
				send({ type: "extension_ui_request", id: "policy-pause", method: "notify", message: "updating task policy" });
				setTimeout(respond, 50);
			} else respond();
			return;
		}
		if (command.message.includes("slow discovery")) slowDiscovery = true;
		if (command.message.includes("slow policy")) slowPolicy = true;
		if (command.message.includes("stray settlement")) straySettlement = true;
		history.push({ role: "user", text: command.message });
		persist();
		send({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
		send({ type: "agent_start" });
		send({ type: "turn_start" });
		send({ type: "message_start", message: assistant("") });
		send({ type: "message_update", message: assistant(""), assistantMessageEvent: { type: "thinking_start" } });
		if (command.message.startsWith("Task: hang")) return;
		if (command.message.startsWith("Task: recall")) {
			finish(JSON.stringify({ pid: process.pid, history, cwd: process.cwd(), args: process.argv.slice(2), mode }));
			return;
		}
		if (command.message.startsWith("Task: unsolicited idle")) {
			finish("will start unassigned work");
			setTimeout(() => send({ type: "agent_start" }), 25);
			return;
		}
		if (command.message.startsWith("Task: crash idle")) {
			finish("will exit");
			setTimeout(() => process.exit(1), 25);
			return;
		}
		if (command.message.startsWith("Task: compact")) {
			send({ type: "compaction_start", reason: "threshold" });
			send({ type: "compaction_end", result: { usage: assistant("").usage }, aborted: false });
			finish("compacted");
			return;
		}
		if (command.message.startsWith("Task: fail")) {
			send({ type: "message_end", message: assistant("failure", "error") });
			send({ type: "agent_settled" });
			return;
		}
		if (command.message.startsWith("Task: no policy")) acknowledgePolicy = false;
		if (command.message.startsWith("Task: cwd")) {
			finish(process.cwd());
			return;
		}
		if (command.message.startsWith("Task: guidance")) {
			const dialog = command.message === "Task: guidance dialog";
			guidanceDialog = dialog ? {} : undefined;
			if (dialog) send({
				type: "extension_ui_request", id: "guidance-approval", method: "select",
				title: `[[pi-subagent-approval:${token}]]Approve a Linear update`,
				options: ["Approve once", "Deny", "Approve once + edit session guidance…"],
			});
			send({
				type: "extension_ui_request", id: "guidance-state", method: "input",
				title: `[[pi-subagent-guidance:${command.message.includes("wrong token") ? `${token}-wrong` : token}]]`,
				placeholder: command.message.includes("invalid") ? "not JSON" : JSON.stringify({ action: "get" }),
			});
			return;
		}
		if (command.message.startsWith("Task: approval")) {
			pending = "approval";
			reportAutoApproveStat("softRejections");
			reportAutoApproveStat("escalations");
			send({
				type: "extension_ui_request",
				id: "approval-1",
				method: "select",
				title: `[[pi-subagent-approval:${token}]]Approve tool call?\n\n  bash: risky-command`,
				options: ["Approve once", "Deny"],
			});
			return;
		}
		if (command.message.startsWith("Task: notify")) {
			send({
				type: "extension_ui_request",
				id: "notify-1",
				method: "notify",
				message: "child notification",
				notifyType: "info",
			});
			finish("notified");
			return;
		}
		if (command.message.startsWith("Task: malformed notify")) {
			send({
				type: "extension_ui_request",
				id: "malformed-notify-1",
				method: "notify",
				message: null,
				notifyType: "info",
			});
			finish("ignored malformed notification");
			return;
		}
		if (command.message.startsWith("Task: permission")) {
			pending = "approval";
			send({
				type: "extension_ui_request",
				id: "permission-1",
				method: "select",
				title: "A different extension needs command approval",
				options: ["Approve once", "Deny"],
			});
			return;
		}
		if (command.message.startsWith("Task: tool")) {
			send({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "git diff --cached --stat" } });
			setTimeout(() => {
				send({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: {}, isError: false });
				finish("tool done");
			}, 25);
			return;
		}
		if (command.message.startsWith("Task: ask")) {
			send({ type: "message_end", message: assistant("") });
			reportAutoApproveStat("evaluatorAllows");
			pending = "question";
			send({
				type: "extension_ui_request",
				id: "question-1",
				method: "editor",
				title: `[[pi-subagent-question:${token}]]`,
				prefill: JSON.stringify({ question: "Which option?", context: "A test question", options: ["one", "two"] }),
			});
			return;
		}
		finish("done");
		return;
	}
	if (command.type === "extension_ui_response") {
		if (command.id.startsWith("guidance-")) {
			if (guidanceDialog) {
				if (command.id === "guidance-approval" && command.value?.startsWith("{")) {
					send({ type: "extension_ui_request", id: "guidance-commit", method: "input",
						title: `[[pi-subagent-guidance:${token}]]`, placeholder: command.value });
					return;
				}
				if (command.id === "guidance-commit") guidanceDialog["guidance-approval"] = command.cancelled ? "cancelled" : "Approve once";
				else guidanceDialog[command.id] = command.value ?? "cancelled";
				if (Object.keys(guidanceDialog).length === 2) finish(JSON.stringify(guidanceDialog));
			} else finish(command.value ?? "cancelled");
			return;
		}
		if (pending === "question") finish(`answer: ${command.value ?? "cancelled"}`);
		else if (pending === "approval") {
			if (typeof command.value === "string" && command.value.startsWith("Approve")) {
				reportAutoApproveStat("humanApprovals");
			} else if (command.value === "Deny") {
				reportAutoApproveStat("humanDenials");
			}
			finish(`user decision: ${command.value ?? "cancelled"}`);
		}
		pending = undefined;
		return;
	}
	if (command.type === "abort") {
		send({ id: command.id, type: "response", command: "abort", success: true });
		finish("aborted");
		return;
	}
	send({ id: command.id, type: "response", command: command.type, success: false, error: "unsupported" });
}

process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => {
	input += chunk;
	while (true) {
		const newline = input.indexOf("\n");
		if (newline === -1) break;
		processLine(input.slice(0, newline).replace(/\r$/, ""));
		input = input.slice(newline + 1);
	}
});
process.stdin.on("end", () => {
	if (input) processLine(input.replace(/\r$/, ""));
});
