import subagents from "../index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let start: ((event: unknown, ctx: unknown) => void) | undefined;
subagents({
	on: (name: string, handler: typeof start) => { if (name === "session_start") start = handler; },
	registerCommand() {},
	registerTool() {},
} as unknown as ExtensionAPI);
start!({}, {
	ui: { notify: (message: string) => process.stdout.write(`${JSON.stringify({ type: "extension_ui_request", method: "notify", message })}\n`) },
});
throw new Error("Incompatible child continued past startup");
