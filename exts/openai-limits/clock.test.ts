import assert from "node:assert/strict";
import { systemClock } from "./clock.ts";

const afternoon = new Date(2026, 0, 2, 13, 5, 0).getTime();
const midnight = new Date(2026, 0, 2, 0, 5, 0).getTime();
const env = { LANG: "en_US.UTF-8" };

for (const preference of ["1", "0"]) {
	const calls: string[] = [];
	const clock = systemClock((command, args) => { calls.push(`${command} ${args.join(" ")}`); return preference; }, "darwin", env);
	assert.equal(clock.time(afternoon), preference === "1" ? "13:05" : "01:05 PM");
	assert.equal(/PM/.test(clock.dateTime(afternoon)), preference === "0");
	if (preference === "1") assert.equal(clock.time(midnight), "00:05");
	assert.deepEqual(calls, ["defaults read -g AppleICUForce24HourTime"]);
}
console.log("PASS: macOS clock preference overrides en-US defaults for both displays, including midnight");

for (const format of ['t_fmt="%H:%M:%S"', 't_fmt="%I:%M:%S %p"']) {
	const clock = systemClock((command, args) => {
		assert.equal(command, "locale");
		assert.deepEqual(args, ["-k", "t_fmt"]);
		return format;
	}, "linux", { LANG: "en_US.UTF-8", LC_TIME: "en_GB.UTF-8" });
	assert.equal(clock.time(afternoon), format.includes("%H") ? "13:05" : "01:05 pm");
}
const fallback = systemClock((command) => command === "defaults" ? undefined : 't_fmt="%H:%M:%S"', "darwin", { LANG: "C" });
assert.equal(fallback.time(afternoon), "13:05");
const missing = systemClock(() => undefined, "linux", { LANG: "not_a_locale" });
assert.ok(missing.time(afternoon));
console.log("PASS: POSIX time locale is honored; missing preferences and invalid locale names fall back safely");
