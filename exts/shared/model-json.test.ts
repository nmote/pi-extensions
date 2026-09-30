import { parseJsonObject } from "./model-json.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

check("parses plain object JSON", parseJsonObject('{"topic":"x","n":1}')?.topic === "x");
check(
	"parses JSON wrapped in a markdown fence",
	parseJsonObject('```json\n{"topic":"x","n":1}\n```')?.topic === "x",
);
check(
	"parses JSON surrounded by prose",
	parseJsonObject('Here: {"topic":"x","n":1} thanks!')?.topic === "x",
);
check("rejects text without braces", parseJsonObject("no JSON here") === undefined);
check("rejects text without a closing brace", parseJsonObject('{"topic": "unterminated"') === undefined);
check("rejects invalid JSON inside braces", parseJsonObject('{"topic": }') === undefined);
check(
	"rejects a second object after the first",
	parseJsonObject('{"topic":"x"} {"other":true}') === undefined,
);

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
