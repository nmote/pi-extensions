import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Key, Markdown, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";

const shortcut = Key.ctrlAlt("o");

export function conversationSnapshot(entries: SessionEntry[]): Array<{ role: "user" | "assistant"; text: string }> {
	const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = typeof message.content === "string" ? message.content : message.content.flatMap((block) => {
			if (block.type === "text") return [block.text];
			if (message.role === "user" && block.type === "image") return ["[Image attachment]"];
			return [];
		}).join("\n\n");
		if (text.trim()) messages.push({ role: message.role, text });
	}
	return messages;
}

export default function (pi: ExtensionAPI) {
	let open = false;
	let close: (() => void) | undefined;

	async function toggle(ctx: ExtensionContext) {
		if (open) {
			close?.();
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Conversation reader requires regular terminal mode.", "error");
			return;
		}
		open = true;
		try {
			const messages = conversationSnapshot(ctx.sessionManager.getBranch());
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				if (tui.mode !== "regular") throw new Error("Conversation reader requires regular mode; disable fullscreen in /settings.");
				close = () => done();
				const content = new Container();
				content.addChild(new Text(theme.fg("accent", "Conversation snapshot"), 1, 0));
				for (const message of messages) {
					content.addChild(new Spacer(1));
					const box = new Box(1, 1, (text) => theme.bg(message.role === "user" ? "userMessageBg" : "customMessageBg", text));
					box.addChild(new Text(theme.bold(message.role === "user" ? "You" : "Assistant"), 0, 0));
					box.addChild(new Markdown(message.text, 0, 0, getMarkdownTheme()));
					content.addChild(box);
				}
				if (messages.length === 0) content.addChild(new Text("No conversation messages.", 1, 0));
				content.addChild(new Spacer(1));
				content.addChild(new Text(theme.fg("dim", "End of snapshot · terminal scrollback to read · Ctrl+Alt+O / Escape to close"), 1, 0));
				return {
					render: (width) => content.render(width),
					invalidate: () => content.invalidate(),
					handleInput(data) {
						if (matchesKey(data, shortcut) || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done();
					},
				};
			});
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			open = false;
			close = undefined;
		}
	}

	pi.registerShortcut(shortcut, { description: "Toggle conversation-only snapshot", handler: toggle });
	pi.registerCommand("conversation-only", {
		description: "Read conversation text in terminal scrollback (regular mode only)",
		handler: async (_args, ctx) => toggle(ctx),
	});
	pi.on("session_shutdown", () => close?.());
}
