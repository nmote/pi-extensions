import type { CursorModel } from "./client.ts";
import { resolveModelSelection } from "./models.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

function message(fn: () => unknown): string {
	try {
		fn();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

const models: CursorModel[] = [
	{
		id: "claude-4", displayName: "Claude 4", aliases: ["claude"],
		parameters: [{ id: "effort", values: ["low", "high"] }],
		variants: [
			{ params: [{ id: "thinking", value: "true" }, { id: "effort", value: "low" }], isDefault: true },
			{ params: [{ id: "thinking", value: "true" }, { id: "effort", value: "high" }] },
		],
	},
	{
		id: "gpt-5", displayName: "GPT 5", aliases: ["gpt"],
		parameters: [{ id: "reasoning", values: ["minimal", "high", "xhigh"] }],
		variants: [
			{ params: [{ id: "mode", value: "standard" }, { id: "reasoning", value: "minimal" }], isDefault: true },
			{ params: [{ id: "mode", value: "standard" }, { id: "reasoning", value: "high" }] },
		],
	},
	{ id: "composer", displayName: "Composer", aliases: [], parameters: [], variants: [] },
	{ id: "claude-other", displayName: "Claude Other", aliases: ["claude"], parameters: [], variants: [] },
	{
		id: "mixed", displayName: "Mixed", aliases: [],
		parameters: [{ id: "reasoning", values: ["low", "high"] }, { id: "effort", values: ["low", "high"] }],
		variants: [
			{ params: [{ id: "reasoning", value: "low" }, { id: "effort", value: "low" }], isDefault: true },
			{ params: [{ id: "reasoning", value: "low" }, { id: "effort", value: "high" }] },
		],
	},
];

const exact = resolveModelSelection(models, "claude-4");
check("exact IDs keep their canonical ID", exact.selection.id === "claude-4" && exact.selection.params === undefined);
const alias = resolveModelSelection(models.filter((model) => model.id !== "claude-other"), "claude");
check("unique aliases resolve to canonical IDs", alias.selection.id === "claude-4");
check("ambiguous aliases list candidate IDs", message(() => resolveModelSelection(models, "claude")).includes("claude-4, claude-other"));
check("unknown models list catalog IDs", message(() => resolveModelSelection(models, "unknown")).includes("claude-4, gpt-5, composer"));

const effort = resolveModelSelection(models, "claude-4", "high");
check("effort variants retain default parameters", effort.effortParameter === "effort" && effort.selection.params?.[0]?.id === "thinking" && effort.selection.params?.[1]?.value === "high");
const reasoning = resolveModelSelection(models, "gpt-5", "high");
check("reasoning parameters retain default variant parameters", reasoning.effortParameter === "reasoning" && reasoning.selection.params?.[0]?.value === "standard" && reasoning.selection.params?.[1]?.value === "high");
const mixed = resolveModelSelection(models, "mixed", "high");
check("effort outranks reasoning regardless of catalog order", mixed.effortParameter === "effort" && mixed.selection.params?.[0]?.value === "low" && mixed.selection.params?.[1]?.value === "high");
check("efforts absent from every variant are rejected", message(() => resolveModelSelection(models, "gpt-5", "xhigh")).includes("Supported values: minimal, high"));
check("invalid effort lists allowed values", message(() => resolveModelSelection(models, "claude-4", "max")).includes("low, high"));
check("models without effort settings reject effort", message(() => resolveModelSelection(models, "composer", "high")).includes("has no effort setting"));

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
