import type { Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type NamedModel, SmallModelPicker, filterSmallModels, smallModelSearchText } from "./small-model-picker.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const models: NamedModel[] = [
	{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
	{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
	{ provider: "openrouter", id: "openai/gpt-4.1-mini", name: "GPT-4.1 mini" },
	{ provider: "test", id: "tiny", name: "Tiny" },
];

function ids(list: NamedModel[]): string[] {
	return list.map((model) => `${model.provider}/${model.id}`);
}

const searchText = smallModelSearchText(models[0]);
check("search text covers provider/id and human name", [
	searchText.includes("anthropic/claude-haiku-4-5"),
	searchText.includes("claude-haiku-4-5"),
	searchText.includes("Claude Haiku 4.5"),
].every(Boolean));

check("an empty query returns every model", filterSmallModels(models, "").length === models.length);

check(
	"a single token matches by id",
	ids(filterSmallModels(models, "haiku")).join(",") === "anthropic/claude-haiku-4-5",
);

check(
	"slash tokens all have to match",
	ids(filterSmallModels(models, "anthropic/haiku")).join(",") === "anthropic/claude-haiku-4-5",
);

check(
	"whitespace tokens all have to match",
	ids(filterSmallModels(models, "claude haiku")).join(",") === "anthropic/claude-haiku-4-5",
);

check(
	"a token can match across punctuation in the id",
	ids(filterSmallModels(models, "haiku45")).join(",") === "anthropic/claude-haiku-4-5",
);

check(
	"a query that matches nothing returns an empty list",
	filterSmallModels(models, "zebra").length === 0,
);

const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const pickerModels = [{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }] as Model<any>[];
const picker = new SmallModelPicker(theme, "Pick a small model", pickerModels, () => {}, () => {});
check(
	"picker component renders its candidates",
	picker.render(80).some((line) => line.includes("claude-haiku-4-5")),
);
picker.dispose();

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
