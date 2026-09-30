import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectCursorRepository, normalizeGitHubRemote } from "./repository.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function throws(run: () => unknown): boolean {
	try {
		run();
		return false;
	} catch {
		return true;
	}
}

interface FakeOptions {
	inside?: boolean;
	remotes?: string[];
	remoteUrl?: string;
	urlCode?: number;
}

function fakeGit(options: FakeOptions = {}): {
	runner: Pick<ExtensionAPI, "exec">;
	calls: string[];
	signals: Array<AbortSignal | undefined>;
} {
	const calls: string[] = [];
	const signals: Array<AbortSignal | undefined> = [];
	const result = (stdout = "", code = 0) => ({ stdout, stderr: "", code, killed: false });
	const runner = {
		async exec(command: string, args: string[], execOptions?: { signal?: AbortSignal }) {
			calls.push(`${command} ${args.join(" ")}`);
			signals.push(execOptions?.signal);
			if (command !== "git") return result("", 1);
			if (args.join(" ") === "rev-parse --is-inside-work-tree") return result(options.inside === false ? "false\n" : "true\n");
			if (args.join(" ") === "remote") return result(`${(options.remotes ?? ["origin"]).join("\n")}\n`);
			if (args[0] === "remote" && args[1] === "get-url") return result(`${options.remoteUrl ?? "git@github.com:example/project.git"}\n`, options.urlCode ?? 0);
			throw new Error(`Unexpected Git inspection: ${args.join(" ")}`);
		},
	} as Pick<ExtensionAPI, "exec">;
	return { runner, calls, signals };
}

async function main(): Promise<void> {
	check("GitHub SSH remotes normalize to HTTPS", normalizeGitHubRemote("git@github.com:example/project.git") === "https://github.com/example/project");
	check("GitHub HTTPS remotes lose credentials and .git suffixes", normalizeGitHubRemote("https://token@github.com/example/project.git") === "https://github.com/example/project");
	check("non-GitHub remotes are rejected", throws(() => normalizeGitHubRemote("git@gitlab.com:example/project.git")));

	const controller = new AbortController();
	const origin = fakeGit({ remotes: ["fork", "origin"] });
	const repository = await inspectCursorRepository(origin.runner, "/workspace", controller.signal);
	check("origin takes priority over other remotes", repository.repositoryUrl === "https://github.com/example/project" && origin.calls.at(-1) === "git remote get-url origin");
	check("the abort signal is forwarded to every Git command", origin.signals.length === 3 && origin.signals.every((signal) => signal === controller.signal));
	check("branch, HEAD, upstream, status, and remote commits are not inspected", origin.calls.join("|") === "git rev-parse --is-inside-work-tree|git remote|git remote get-url origin");

	const sole = fakeGit({ remotes: ["upstream"], remoteUrl: "https://github.com/example/sole.git" });
	check("a sole non-origin remote is selected", (await inspectCursorRepository(sole.runner, "/workspace")).repositoryUrl === "https://github.com/example/sole" && sole.calls.at(-1) === "git remote get-url upstream");
	check("the current directory must be in a Git repository", (await rejection(inspectCursorRepository(fakeGit({ inside: false }).runner, "/workspace"))).includes("not inside a Git repository"));
	check("a repository without remotes is rejected", (await rejection(inspectCursorRepository(fakeGit({ remotes: [] }).runner, "/workspace"))).includes("no remote"));
	check("multiple remotes without origin are ambiguous", (await rejection(inspectCursorRepository(fakeGit({ remotes: ["fork", "upstream"] }).runner, "/workspace"))).includes("without origin"));
	const secret = "sensitive-token";
	const unsupported = await rejection(inspectCursorRepository(fakeGit({ remoteUrl: `https://${secret}@gitlab.com/example/project.git` }).runner, "/workspace"));
	check("unsupported origin errors do not expose credentials", unsupported.includes("not a supported github.com") && !unsupported.includes(secret));
	check("an unresolvable remote has an actionable error", (await rejection(inspectCursorRepository(fakeGit({ urlCode: 1 }).runner, "/workspace"))).includes("Could not resolve the URL for remote origin"));

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall checks passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
