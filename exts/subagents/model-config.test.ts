import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import subagents from "./index.ts";
import {
	clearSubagentModel,
	describeSubagentModelPolicy,
	formatModelRef,
	loadSubagentModels,
	pickSubagentModel,
	saveSubagentModel,
} from "./model-config.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

function pickerCtx(choice?: string) {
	const notifications: Array<{ message: string; level: string }> = [];
	let selectTitle = "";
	const models = [
		{ provider: "test", id: "tiny", name: "Tiny" },
		{ provider: "test", id: "small", name: "Small" },
	];

	return {
		ctx: {
			hasUI: true,
			mode: "rpc",
			ui: {
				select: async (title: string) => {
					selectTitle = title;
					return choice;
				},
				notify: (message: string, level: string) => notifications.push({ message, level }),
			},
			modelRegistry: {
				getAvailable: () => models,
				hasConfiguredAuth: () => true,
			},
		} as unknown as ExtensionContext,
		notifications,
		title: () => selectTitle,
	};
}

async function main(): Promise<void> {
	const temp = mkdtempSync(join(tmpdir(), "subagent-models-test-"));
	try {
		const path = join(temp, "subagent-models.json");
		check("config has no default slots", loadSubagentModels(path).routine === undefined && loadSubagentModels(path).basic === undefined && loadSubagentModels(path).complex === undefined);

		saveSubagentModel("routine", "anthropic", "claude-haiku-4-5", path);
		const saved = loadSubagentModels(path);
		check("routine slot persists", saved.routine?.provider === "anthropic" && saved.routine?.model === "claude-haiku-4-5");
		check("basic slot is untouched", saved.basic === undefined);

		saveSubagentModel("basic", "openrouter", "openai/gpt-4.1-mini", path);
		const both = loadSubagentModels(path);
		check("saving a second slot preserves the first", both.routine?.model === "claude-haiku-4-5" && both.basic?.model === "openai/gpt-4.1-mini");

		saveSubagentModel("complex", "test", "reasoning", path);
		const all = loadSubagentModels(path);
		check("complex slot persists alongside existing slots", all.complex?.model === "reasoning" && all.basic?.model === "openai/gpt-4.1-mini" && all.routine?.model === "claude-haiku-4-5");

		clearSubagentModel("complex", path);
		const cleared = loadSubagentModels(path);
		check("clear removes only the complex slot", cleared.complex === undefined && cleared.routine?.model === "claude-haiku-4-5" && cleared.basic?.model === "openai/gpt-4.1-mini");

		check("saved config is readable JSON", JSON.parse(readFileSync(path, "utf8")) !== null);

		writeFileSync(path, JSON.stringify({ routine: { provider: 1 }, basic: false, complex: { model: "missing-provider" } }));
		const invalid = loadSubagentModels(path);
		check("invalid config fields are ignored", invalid.routine === undefined && invalid.basic === undefined && invalid.complex === undefined);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}

	check("formatModelRef joins provider and model", formatModelRef({ provider: "test", model: "tiny" }) === "test/tiny");

	const none = describeSubagentModelPolicy({});
	check("unset slots fall back to the session model", none.text.includes("routine tasks -> the session model") && none.text.includes("basic tasks -> the session model") && none.text.includes("complex tasks -> the session model (omit model)"));
	check("policy states it is advisory", none.text.includes("advisory") && none.guidelines[0].includes("advisory"));
	check("policy mentions explicit user requests", none.text.includes("explicit user request"));

	const configured = describeSubagentModelPolicy({ routine: { provider: "test", model: "tiny" } });
	check("configured slots replace the session model", configured.text.includes("routine tasks -> test/tiny") && configured.text.includes("basic tasks -> the session model"));
	check("complex tasks use the session model when unset", configured.text.includes("complex tasks -> the session model (omit model)"));
	const complexPolicy = describeSubagentModelPolicy({ complex: { provider: "test", model: "reasoning" } });
	check("complex preference appears in both policy surfaces with an explicit-user override", complexPolicy.text.includes("complex tasks -> test/reasoning") && complexPolicy.guidelines[0].includes("complex tasks -> test/reasoning") && complexPolicy.guidelines[0].includes("explicit user request"));

	const pickDir = mkdtempSync(join(tmpdir(), "subagent-models-pick-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = pickDir;
	try {
		const first = pickerCtx("test/tiny");
		const picked = await pickSubagentModel(first.ctx, "routine");
		check("pickSubagentModel persists the chosen slot", picked?.id === "tiny" && loadSubagentModels().routine?.model === "tiny");
		check("pickSubagentModel shows a slot-specific title", first.title().includes("routine"));

		const again = pickerCtx("test/small");
		await pickSubagentModel(again.ctx, "routine");
		check("re-picking includes the current value in the title", again.title().includes("current: test/tiny"));
		check("re-picking replaces the saved choice", loadSubagentModels().routine?.model === "small");

		const tools = new Map<string, any>();
		const commands = new Map<string, any>();
		const pi = {
			registerTool(tool: any) { tools.set(tool.name, tool); },
			registerCommand(name: string, command: any) { commands.set(name, command); },
			on() {},
			events: { emit() {} },
		} as unknown as ExtensionAPI;
		subagents(pi);
		const command = commands.get("subagent-models");
		const picker = pickerCtx("test/tiny");
		await command.handler("", picker.ctx);
		check("command shows an unset complex slot", picker.notifications.at(-1)?.message.includes("Complex subagent model: not set (session model)") === true);
		await command.handler("complex", picker.ctx);
		check("command picker saves the complex slot", loadSubagentModels().complex?.model === "tiny" && picker.title().includes("complex"));
		check("command refreshes tool guidance after selection", tools.get("subagent")?.description.includes("complex tasks -> test/tiny") && tools.get("subagent")?.promptGuidelines.some((line: string) => line.includes("complex tasks -> test/tiny")));
		await command.handler("", picker.ctx);
		check("command displays the selected complex model", picker.notifications.at(-1)?.message.includes("Complex subagent model: test/tiny") === true);

		const reloadedTools = new Map<string, any>();
		subagents({ ...pi, registerTool(tool: any) { reloadedTools.set(tool.name, tool); } } as ExtensionAPI);
		check("reloading retains the complex preference in tool guidance", reloadedTools.get("subagent")?.description.includes("complex tasks -> test/tiny"));

		await command.handler("complex clear", picker.ctx);
		check("command clearing complex keeps other slots", loadSubagentModels().complex === undefined && loadSubagentModels().routine?.model === "small");
		check("clearing restores the session-model guidance", tools.get("subagent")?.description.includes("complex tasks -> the session model (omit model)"));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(pickDir, { recursive: true, force: true });
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
