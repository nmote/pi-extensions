import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SearchablePicker } from "../shared/searchable-picker.ts";
import { tagApprovalTitle } from "../shared/subagent-protocol.ts";
import { listGuidancePresets } from "./guidance-presets.ts";

export async function pickGuidancePreset(ctx: ExtensionContext, signal: AbortSignal): Promise<string | undefined> {
	if (!ctx.hasUI || signal.aborted) return undefined;
	const names = listGuidancePresets();
	if (!names.length) {
		ctx.ui.notify("No guidance presets saved. Use /auto guidance save <name>", "info");
		return undefined;
	}
	const title = tagApprovalTitle("Load guidance preset");
	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
		return ctx.ui.custom<string | undefined>((_tui, theme, _keybindings, done) =>
			new SearchablePicker(theme, title, names, {
				searchText: (name) => name,
				renderItem: (theme, name, selected) => selected ? theme.fg("accent", name) : name,
				emptyMessage: "No matching presets",
			}, done, () => done(undefined), signal));
	}
	return ctx.ui.select(title, names, { signal });
}
