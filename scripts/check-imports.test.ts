import { isAllowedSpecifier, runtimeSpecifiers } from "./check-imports.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const source = `
import type { Foo } from "type-only";
export type { Bar } from "type-export";
import { a } from "./local.ts";
export { b } from "reexported";
const lazy = await import("lazy");
const legacy = require("legacy");
const computed = await import(name);
`;
check(
	"collects runtime specifiers and skips type-only forms",
	runtimeSpecifiers("example.ts", source)
		.map((entry) => entry.specifier)
		.join(",") === "./local.ts,reexported,lazy,legacy,<dynamic>",
);

const dependencies = ["@example/library"];
check("allows declared dependency subpaths", isAllowedSpecifier("@example/library/subpath", dependencies));
check("allows Pi-provided modules", isAllowedSpecifier("@earendil-works/pi-ai/oauth", dependencies));
check("allows Node built-ins", isAllowedSpecifier("node:fs", dependencies) && isAllowedSpecifier("fs", dependencies));
check("rejects Pi internals", !isAllowedSpecifier("@earendil-works/pi-ai/bun-oauth", dependencies));
check("rejects transitive dev packages", !isAllowedSpecifier("proper-lockfile", dependencies));
check("rejects dynamic specifiers", !isAllowedSpecifier("<dynamic>", dependencies));

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
