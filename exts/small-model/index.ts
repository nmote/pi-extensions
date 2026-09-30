/**
 * Small-model extension: owns the shared "small model" choice used for
 * background work — auto-approve safety evaluation and session-topic
 * topics/summaries. /small-model shows the current choice and opens the
 * picker; the selection persists to ~/.pi/agent/extensions/small-model.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSmallModel, pickSmallModel } from "../shared/small-model.ts";

export default function smallModel(pi: ExtensionAPI): void {
	pi.registerCommand("small-model", {
		description: "Pick the shared small model used for background work",
		handler: async (_args, ctx) => {
			const saved = loadSmallModel();
			const current = saved.provider && saved.model ? `${saved.provider}/${saved.model}` : undefined;
			ctx.ui.notify(`Small model: ${current ?? "not selected"}`, "info");
			const model = await pickSmallModel(ctx, { current });
			if (model) ctx.ui.notify(`small-model: set to ${model.provider}/${model.id}`, "info");
		},
	});
}
