import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.ts";
import { allowance, mergeUsage, parseHeaders, parseStream, parseUsage } from "./usage.ts";

const at = 1_700_000_000_000;
const snapshot = parseUsage({
	rate_limit: {
		allowed: true,
		primary_window: { used_percent: 95, reset_at: at / 1000 + 3600, limit_window_seconds: 18_000 },
		secondary_window: { used_percent: 92, reset_at: at / 1000 + 7200, limit_window_seconds: 604_800 },
	},
	credits: { has_credits: true, balance: "10" },
	additional_rate_limits: [{ metered_feature: "codex_other", normal_model_slug: "other", rate_limit: {
		primary_window: { used_percent: 100, reset_at: at / 1000 + 10_000 },
	} }],
}, at);
assert.deepEqual(allowance(snapshot, "main", 10), { remaining: 5, resetAt: at + 7200_000 });
assert.deepEqual(allowance(snapshot, "other", 10), { remaining: 0, resetAt: at + 10_000_000 });
console.log("PASS: included allowance ignores credits and uses all applicable exhausted windows");

const headers = parseHeaders({
	"X-Codex-Primary-Used-Percent": "42.5",
	"x-codex-primary-reset-at": String(at / 1000 + 100),
	"x-codex-primary-window-minutes": "300",
	"x-codex-other-primary-used-percent": "99",
	"x-codex-other-limit-name": "other",
	"x-codex-secondary-used-percent": "",
}, at)!;
assert.equal(headers.limits.length, 2);
assert.equal(headers.limits[0].windows[0].resetAt, at + 100_000);
const event = parseStream({ type: "codex.rate_limits", metered_limit_name: "codex-other", rate_limits: {
	primary: { used_percent: 90, window_minutes: 60, reset_at: at / 1000 + 1000 },
} }, "other", at)!;
const merged = mergeUsage(headers, event);
assert.equal(allowance(merged, "main", 10).remaining, 57.5);
assert.equal(allowance(merged, "other", 10).remaining, 10);
assert.equal(parseStream({ type: "response.completed" }, "main", at), undefined);
const partial = parseStream({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 40 } } }, "main", at)!;
assert.equal(allowance(mergeUsage(snapshot, partial), "main", 10).remaining, 8);
console.log("PASS: partial headers/events preserve other windows and model-specific limits");

assert.throws(() => parseUsage({ rate_limit: { primary_window: { used_percent: "99" } } }, at));
assert.deepEqual(allowance(parseUsage({ rate_limit: { allowed: false } }, at), "main", 10), { remaining: 0, resetAt: undefined });
assert.deepEqual(allowance(parseUsage({ rate_limit: { allowed: true } }, at), "main", 10), { remaining: undefined, resetAt: undefined });
assert.equal(allowance(undefined, "main", 10).remaining, undefined);
console.log("PASS: malformed or missing data does not imply available subscription usage");

const directory = mkdtempSync(join(tmpdir(), "pi-openai-limits-"));
try {
	const path = join(directory, "config.json");
	assert.deepEqual(loadConfig(path), DEFAULT_CONFIG);
	assert.equal(loadConfig(path).pauseAtPercent, 3);
	saveConfig({ autoPause: false, pauseAtPercent: 7 }, path);
	assert.deepEqual(loadConfig(path), { autoPause: false, pauseAtPercent: 7 });
	assert.equal(JSON.parse(readFileSync(path, "utf8")).autoPause, false);
	writeFileSync(path, JSON.stringify({ autoPause: false, pauseAtPercent: 100 }));
	assert.deepEqual(loadConfig(path), { autoPause: false, pauseAtPercent: 3 });
} finally {
	rmSync(directory, { recursive: true, force: true });
}
console.log("PASS: persistent off preference survives loading and invalid threshold values");
