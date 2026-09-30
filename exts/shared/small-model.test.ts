import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	availableModels,
	ensureSmallModel,
	loadSmallModel,
	pickModel,
	pickSmallModel,
	saveSmallModel,
} from "./small-model.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

interface HarnessOptions {
	models?: Array<{ provider: string; id: string; name?: string }>;
	authenticated?: (model: { provider: string; id: string }) => boolean;
	hasUI?: boolean;
	choice?: string | undefined;
	saved?: { provider?: string; model?: string };
	mode?: string;
	custom?: () => Promise<Model<any> | undefined>;
}

function createHarness(options: HarnessOptions = {}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const saves: string[] = [];
	let selectCalls = 0;
	let selectSignal: AbortSignal | undefined;
	let selectTitle: string | undefined;
	let customCalls = 0;
	const models = (options.models ?? [
		{ provider: "test", id: "tiny", name: "Tiny" },
		{ provider: "other", id: "unscoped", name: "Unscoped" },
		{ provider: "locked", id: "no-auth", name: "No Auth" },
	]).map((model) => ({ name: model.id, ...model }));

	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode,
		ui: {
			select: async (title: string, _choices: string[], selectOptions?: { signal?: AbortSignal }) => {
				selectCalls++;
				selectSignal = selectOptions?.signal;
				selectTitle = title;
				return options.choice;
			},
			notify: (message: string, level: string) => notifications.push({ message, level }),
			custom: options.custom
				? async () => {
						customCalls++;
						return options.custom!();
					}
				: undefined,
		},
		modelRegistry: {
			getAvailable: () => models,
			hasConfiguredAuth: (model: { provider: string; id: string }) =>
				options.authenticated ? options.authenticated(model) : model.provider !== "locked",
		},
	} as unknown as ExtensionContext;

	return {
		ctx,
		notifications,
		saves,
		save: (provider: string, model: string) => saves.push(`${provider}/${model}`),
		pickerCalls: () => selectCalls,
		pickerSignal: () => selectSignal,
		pickerTitle: () => selectTitle,
		customPickerCalls: () => customCalls,
	};
}

async function main(): Promise<void> {
	const temp = mkdtempSync(join(tmpdir(), "small-model-test-"));
	try {
		const path = join(temp, "small-model.json");
		check("config has no default", loadSmallModel(path).provider === undefined);
		saveSmallModel("anthropic", "claude-haiku", path);
		check("selection persists", loadSmallModel(path).model === "claude-haiku");
		check("saved config is readable JSON", JSON.parse(readFileSync(path, "utf8")) !== null);
		writeFileSync(path, JSON.stringify({ provider: 1, model: false }));
		const invalid = loadSmallModel(path);
		check("invalid config fields are ignored", invalid.provider === undefined && invalid.model === undefined);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}

	const filtered = createHarness();
	check(
		"only authenticated models are available",
		availableModels(filtered.ctx).every((model) => model.provider !== "locked"),
	);

	const picked = createHarness({ choice: "other/unscoped" });
	const chosen = await pickSmallModel(picked.ctx, { save: picked.save });
	check("picker returns the chosen model", chosen?.provider === "other" && chosen?.id === "unscoped");
	check("picker persists through the save hook", picked.saves[0] === "other/unscoped");

	const declined = createHarness({ choice: undefined });
	check("a canceled picker returns undefined", (await pickSmallModel(declined.ctx, { save: declined.save })) === undefined);
	check("a canceled picker does not save", declined.saves.length === 0);

	const declinedEmpty = createHarness({ choice: "" });
	check("an unrecognized choice returns undefined", (await pickSmallModel(declinedEmpty.ctx)) === undefined);

	const empty = createHarness({ models: [] });
	check("an empty catalog returns undefined", (await pickSmallModel(empty.ctx)) === undefined);
	check(
		"an empty catalog reports an error",
		empty.notifications.some((n) => n.level === "error" && n.message.includes("no authenticated models")),
	);

	const headless = createHarness({ hasUI: false });
	check("without a UI the picker returns undefined", (await pickSmallModel(headless.ctx)) === undefined);
	check("without a UI nothing is shown", headless.pickerCalls() === 0 && headless.notifications.length === 0);

	const signal = new AbortController().signal;
	const signaled = createHarness({ choice: "test/tiny" });
	await pickSmallModel(signaled.ctx, { signal, save: signaled.save });
	check("the picker forwards the abort signal", signaled.pickerSignal() === signal);

	const tuiModel = { provider: "other", id: "unscoped" } as Model<any>;
	const tui = createHarness({ mode: "tui", custom: async () => tuiModel });
	const tuiChosen = await pickSmallModel(tui.ctx, { save: tui.save });
	check(
		"TUI mode uses the fuzzy picker instead of select",
		tui.pickerCalls() === 0 && tui.customPickerCalls() === 1,
	);
	check("TUI picker persists through the save hook", tuiChosen?.id === "unscoped" && tui.saves[0] === "other/unscoped");

	const rpc = createHarness({ mode: "rpc", custom: async () => tuiModel, choice: "test/tiny" });
	const rpcChosen = await pickSmallModel(rpc.ctx, { save: rpc.save });
	check(
		"non-TUI mode keeps the select path",
		rpc.customPickerCalls() === 0 && rpc.pickerCalls() === 1 && rpcChosen?.id === "tiny",
	);

	// ensureSmallModel reads the shared config file; point it at a temp dir.
	const generic = createHarness({ choice: "test/tiny" });
	let genericSaved = "";
	const genericChosen = await pickModel(generic.ctx, {
		title: "Pick any model:",
		emptyMessage: "generic: no authenticated models",
		saveErrorPrefix: "generic: could not save",
		save: (provider, model) => {
			genericSaved = `${provider}/${model}`;
		},
	});
	check(
		"generic pickModel uses the provided title and save hook",
		genericChosen?.id === "tiny" && genericSaved === "test/tiny" && generic.pickerTitle() === "Pick any model:",
	);

	const genericEmpty = createHarness({ models: [] });
	await pickModel(genericEmpty.ctx, {
		title: "Pick any model:",
		emptyMessage: "generic: no authenticated models",
		saveErrorPrefix: "generic: could not save",
	});
	check(
		"generic pickModel reports its own empty message",
		genericEmpty.notifications.some((n) => n.level === "error" && n.message === "generic: no authenticated models"),
	);

	const ensureDir = mkdtempSync(join(tmpdir(), "small-model-ensure-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = ensureDir;
	try {
		const resolved = createHarness();
		const prompted = await ensureSmallModel(resolved.ctx);
		check("ensure prompts when nothing is saved", resolved.pickerCalls() === 1 && prompted === undefined);

		saveSmallModel("test", "tiny");
		const found = createHarness();
		const model = await ensureSmallModel(found.ctx);
		check("ensure resolves the saved model without prompting", model?.id === "tiny" && found.pickerCalls() === 0);

		saveSmallModel("locked", "no-auth");
		const unauthenticated = createHarness();
		check("ensure rejects a saved model without auth", (await ensureSmallModel(unauthenticated.ctx)) === undefined);
		check(
			"ensure reports an unavailable saved model and re-picks",
			unauthenticated.notifications.some((n) => n.level === "warning" && n.message.includes("is unavailable")) &&
				unauthenticated.pickerCalls() === 1,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(ensureDir, { recursive: true, force: true });
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
