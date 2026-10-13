import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBuiltinRoots, supplementalRoots } from "./builtin-roots.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-builtin-roots-"));
try {
	const path = join(directory, "defaults.json");
	const load = (value: unknown) => {
		writeFileSync(path, JSON.stringify(value));
		return loadBuiltinRoots(path);
	};
	assert.deepEqual(load({}), { writeRoots: [], readRoots: [] });
	const builtin = load({ writeRoots: ["/tmp"], readRoots: ["/docs"] });
	assert.deepEqual(supplementalRoots({
		writeRoots: ["/tmp", "/docs", "/extra", "/tmp/"],
		readRoots: ["/skills", "/docs", "/tmp", "~/extra", "/tmp/", "~/extra"],
	}, ["/skills"], builtin), {
		writeRoots: ["/docs", "/extra", "/tmp/"],
		readRoots: ["~/extra", "/tmp/", "~/extra"],
	});
	for (const value of [null, [], { imports: [] }, { writeRoots: null }, { readRoots: [1] },
		{ writeRoots: ["relative"] }, { readRoots: ["~/docs"] }, { readRoots: ["/docs/"] },
		{ writeRoots: ["/tmp/../docs"] }]) {
		assert.throws(() => load(value), /builtin roots:/);
	}
	assert.deepEqual(loadBuiltinRoots(), { writeRoots: ["/tmp"], readRoots: [] });
	console.log("  ok  builtin root loading and exact permission-aware subtraction");
} finally {
	rmSync(directory, { recursive: true, force: true });
}
