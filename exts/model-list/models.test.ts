import { matchingModelIds, type AvailableModel } from "./models.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const models: AvailableModel[] = [
	{ provider: "openai-codex", id: "zeta", name: "Zeta" },
	{ provider: "anthropic", id: "alpha", name: "Quick Claude" },
];

check(
	"lists sorted provider/model identifiers",
	matchingModelIds(models).join(",") === "anthropic/alpha,openai-codex/zeta",
);
check(
	"filters case-insensitively by model name",
	matchingModelIds(models, " QUICK ").join(",") === "anthropic/alpha",
);
check("filters by provider", matchingModelIds(models, "codex").join(",") === "openai-codex/zeta");
check("reports no matches", matchingModelIds(models, "missing").length === 0);

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
