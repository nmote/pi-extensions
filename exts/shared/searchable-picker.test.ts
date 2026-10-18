import type { Theme } from "@earendil-works/pi-coding-agent";
import { SearchablePicker } from "./searchable-picker.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else { failures++; console.error(`FAIL  ${name}`); }
}
const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const options = {
	searchText: (item: string) => item,
	renderItem: (_theme: Theme, item: string) => item,
	emptyMessage: "No matching presets",
};
let selected: string | undefined;
let cancelled = 0;
const picker = new SearchablePicker(theme, "Load preset", ["pr-review", "release"], options,
	(item) => { selected = item; }, () => { cancelled++; });
picker.focused = true;
picker.handleInput("prr");
check("fuzzy search filters generic items without requiring details",
	picker.render(80).some((line) => line.includes("pr-review")) && !picker.render(80).some((line) => line.includes("release")));
picker.handleInput("\r");
picker.handleInput("\x1b");
check("selection returns the filtered item and disposes the picker", selected === "pr-review" && cancelled === 0);

const navigation = new SearchablePicker(theme, "Load preset", ["pr-review", "release"], options,
	(item) => { selected = item; }, () => { cancelled++; });
navigation.handleInput("\x1b[A");
navigation.handleInput("\r");
check("navigation wraps to the last item", selected === "release");

const empty = new SearchablePicker(theme, "Load preset", ["pr-review"], options,
	() => { throw new Error("An unmatched query cannot select an item"); }, () => { cancelled++; });
empty.handleInput("zzz");
empty.handleInput("\r");
check("unmatched queries render the configured empty message", empty.render(80).some((line) => line.includes(options.emptyMessage)));
empty.handleInput("\x1b");
check("escape cancels the picker", cancelled === 1);

const controller = new AbortController();
const aborted = new SearchablePicker(theme, "Load preset", ["pr-review"], options,
	() => { throw new Error("An aborted picker cannot select an item"); }, () => { cancelled++; }, controller.signal);
controller.abort();
aborted.handleInput("\r");
check("abort cancels once and prevents selection", cancelled === 2);
const alreadyAborted = new SearchablePicker(theme, "Load preset", [], options,
	() => {}, () => { cancelled++; }, controller.signal);
await Promise.resolve();
check("an already-aborted signal cancels after construction", cancelled === 3);
alreadyAborted.dispose();

if (failures) process.exit(1);
console.log("\nall checks passed");
