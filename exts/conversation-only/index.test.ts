import assert from "node:assert/strict";
import { initTheme, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Key, Text, TuiMainScreen, visibleWidth, type Component, type Terminal } from "@earendil-works/pi-tui";
import conversationOnly, { conversationSnapshot } from "./index.ts";

initTheme("dark", false);
const session = SessionManager.inMemory();
const root = session.appendMessage({ role: "user", content: "Original question", timestamp: 0 });
session.appendMessage({ role: "user", content: "Abandoned branch", timestamp: 0 });
session.branch(root);
session.appendCompaction("Hidden summary", root, 1000);
session.appendCustomMessageEntry("notice", "Hidden notice", true);
session.appendMessage({ role: "assistant", content: [
	{ type: "thinking", thinking: "Hidden reasoning" },
	{ type: "text", text: "Progress commentary" },
	{ type: "toolCall", id: "call", name: "bash", arguments: { command: "Hidden command" } },
] } as any);
session.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "Hidden output" }], isError: false, timestamp: 0 });
session.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "Hidden reasoning-only message" }] } as any);
session.appendMessage({ role: "user", content: [
	{ type: "text", text: "Image question" }, { type: "image", data: "", mimeType: "image/png" },
], timestamp: 0 });
session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Final answer" }] } as any);
const before = JSON.stringify(session.getEntries());
assert.deepEqual(conversationSnapshot(session.getBranch()), [
	{ role: "user", text: "Original question" },
	{ role: "assistant", text: "Progress commentary" },
	{ role: "user", text: "Image question\n\n[Image attachment]" },
	{ role: "assistant", text: "Final answer" },
]);
assert.equal(JSON.stringify(session.getEntries()), before);

// Exercise the inline reader with Pi's regular renderer, not a bounded viewport.
let writes = "";
const terminal = {
	columns: 70, rows: 12, kittyProtocolActive: false,
	start() {}, stop() {}, hideCursor() {}, showCursor() {},
	write(data: string) { writes += data; },
} as unknown as Terminal;
const tui = new TuiMainScreen(terminal, false);
const editor = new Container();
editor.addChild(new Text("Unsubmitted draft", 0, 0));
tui.addChild(new Text(Array.from({ length: 30 }, (_, i) => `Normal transcript ${i}`).join("\n"), 0, 0));
tui.addChild(editor);
const commands = new Map<string, any>();
const shortcuts = new Map<string, any>();
const events = new Map<string, any>();
conversationOnly({
	registerCommand: (name: string, command: any) => commands.set(name, command),
	registerShortcut: (key: string, binding: any) => shortcuts.set(key, binding),
	on: (name: string, handler: any) => events.set(name, handler),
} as unknown as ExtensionAPI);
const notifications: string[] = [];
let reader: Component | undefined;
let mode = "regular";
let customCalls = 0;
const ctx = {
	mode: "tui", isIdle: () => false, hasPendingMessages: () => true, sessionManager: session,
	ui: {
		notify: (message: string) => notifications.push(message),
		custom: async (factory: any) => {
			customCalls++;
			await new Promise<void>((resolve, reject) => {
				try {
					reader = factory({ mode, requestRender: (force: boolean) => tui.requestRender(force) }, {
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
						bg: (color: string, text: string) => `\x1b[${color === "userMessageBg" ? 44 : 45}m${text}\x1b[49m`,
					}, {}, () => {
						editor.clear();
						editor.addChild(new Text("Unsubmitted draft", 0, 0));
						resolve();
					});
					editor.clear();
					editor.addChild(reader!);
				} catch (error) { reject(error); }
			});
		},
	},
};
const toggle = shortcuts.get(Key.ctrlAlt("o")).handler;
const command = commands.get("conversation-only").handler;
await toggle({ ...ctx, mode: "rpc" });
assert.equal(customCalls, 0);
mode = "fullscreen";
await toggle(ctx);
assert.match(notifications.at(-1)!, /regular mode/);
mode = "regular";

session.appendMessage({ role: "user", content: Array.from({ length: 80 }, (_, i) => `Snapshot line ${i}`).join("\n\n"), timestamp: 0 });
tui.start();
try {
	tui.renderNow();
	writes = "";
	const opened = command("", ctx);
	tui.renderNow();
	assert.match(writes, /Snapshot line 0/);
	assert.match(writes, /Snapshot line 79/);
	assert(tui.captureRenderState().previousLines.length > terminal.rows);
	assert(!writes.includes("\x1b[?1049h"), "reader must not enter the alternate screen");
	assert.match(writes, /Progress commentary/);
	assert(writes.includes("\x1b[44m"), "user messages have a background");
	assert(writes.includes("\x1b[45m"), "assistant messages have a distinct background");
	assert(!writes.includes("Hidden"));
	assert(!writes.includes("Abandoned branch"));
	session.appendMessage({ role: "user", content: "Arrived while reading", timestamp: 0 });
	for (const width of [20, 70]) {
		reader!.invalidate();
		const lines = reader!.render(width);
		assert(lines.every((line) => visibleWidth(line) <= width));
		assert(!lines.join("\n").includes("Arrived while reading"));
	}
	reader!.handleInput!("x");
	assert.match(editor.render(70).join("\n"), /End of snapshot/);
	writes = "";
	reader!.handleInput!("\x1b");
	await opened;
	tui.renderNow();
	assert(writes.includes("\x1b[3J"), "closing rebuilds scrollback instead of leaving the snapshot's empty area");
	assert.match(writes, /Normal transcript 29/);
	assert.match(writes, /Unsubmitted draft/);
	const restored = tui.captureRenderState();
	assert.equal(restored.previousViewportTop, restored.previousLines.length - terminal.rows);
	assert.match(editor.render(70).join("\n"), /Unsubmitted draft/);

	for (const close of [() => reader!.handleInput!("\x1b\x0f"), () => events.get("session_shutdown")()]) {
		const reopened = toggle(ctx);
		assert(reader!.render(70).join("\n").includes("Arrived while reading"));
		close();
		await reopened;
	}
} finally { tui.stop(); }
console.log("conversation-only tests passed");
