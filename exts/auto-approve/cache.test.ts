import { EvaluatorCache } from "./cache.ts";
import { buildMatchInput } from "./rules.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) {
		console.log(`  ok  ${name}`);
	} else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const cache = new EvaluatorCache();
const command = "printf 'two  spaces'\n";
const input = buildMatchInput("bash", { command });
const output = { decision: "review" as const, reason: "needs confirmation" };
const persisted = cache.remember(input, output);
if (!persisted) throw new Error("bash input should be cacheable");

check("stores command verbatim", persisted.command === command);
check("reuses cached evaluator output", cache.get(input) === output);
check("does not normalize whitespace", cache.get(buildMatchInput("bash", { command: command.trim() })) === undefined);
check("ignores ancillary bash arguments", cache.get(buildMatchInput("bash", { command, timeout: 1 })) === output);
check("distinguishes tool identity", cache.get(buildMatchInput("custom", { path: command })) === undefined);

const restored = new EvaluatorCache();
check("restores persisted output", restored.restore(persisted));
check("restored output matches exact command", restored.get(input)?.decision === "review");
check("restored output rejects a different command", restored.get(buildMatchInput("bash", { command: `${command} ` })) === undefined);

const instructions = ["Approve only when read-only"];
const contextual = cache.remember(input, output, instructions);
if (!contextual) throw new Error("contextual evaluation should be cacheable");
check("stores evaluator instructions", contextual.instructions[0] === instructions[0]);
check("context changes the cache key", cache.get(input, instructions) === output);
check("different context misses the cache", cache.get(input, ["Always review"]) === undefined);
const restoredContextual = new EvaluatorCache();
check("restores contextual output", restoredContextual.restore(contextual));
check("restored contextual output requires the same context", restoredContextual.get(input, instructions)?.decision === "review");
check("rejects malformed persisted instructions", !restoredContextual.restore({ ...contextual, instructions: [1] }));

check(
	"rejects malformed persisted output",
	!restored.restore({ tool: "bash", command, input: { command }, output: { decision: "allow" } }),
);
check(
	"rejects inconsistent persisted command text",
	!restored.restore({ ...persisted, input: { command: "different" } }),
);
check(
	"restores legacy entries without instructions",
	new EvaluatorCache().restore({ tool: "bash", command, input: { command }, output }),
);
check(
	"does not cache evaluator failures",
	cache.remember(input, { decision: "review", reason: "evaluation failed", cacheable: false }) === undefined,
);

check(
	"normalizes persisted block and ask verdicts",
	["block", "ask"].every((decision) => {
		const migrated = new EvaluatorCache();
		return (
			migrated.restore({ ...persisted, output: { decision, reason: "needs confirmation" } }) &&
			migrated.get(input)?.decision === "review"
		);
	}),
);

const firstWrite = buildMatchInput("custom", { path: "target", content: "first" });
const secondWrite = buildMatchInput("custom", { path: "target", content: "second" });
const writeOutput = { decision: "allow" as const, reason: "safe" };
const persistedWrite = cache.remember(firstWrite, writeOutput);
if (!persistedWrite) throw new Error("plain tool input should be cacheable");
check("non-bash inputs include all arguments", cache.get(secondWrite) === undefined);
const restoredWrite = new EvaluatorCache();
check("restores complete non-bash input", restoredWrite.restore(persistedWrite));
check("restored non-bash input rejects changed arguments", restoredWrite.get(secondWrite) === undefined);

restored.clear();
check("clear removes session output", restored.get(input) === undefined);

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
