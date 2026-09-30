import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectCursorRepository } from "../cursor/repository.ts";

export async function inspectCodexRepository(pi: Pick<ExtensionAPI, "exec">, cwd: string, signal?: AbortSignal) {
	const { repositoryUrl, remoteName } = await inspectCursorRepository(pi, cwd, signal);
	const run = async (args: string[]) => {
		const result = await pi.exec("git", args, { cwd, signal, timeout: 10_000 });
		if (result.killed || signal?.aborted) throw new Error("Remote default branch lookup interrupted.");
		if (result.code !== 0) throw new Error("Remote default branch is unavailable. Check remote access before dispatch.");
		return result.stdout;
	};
	const symref = await run(["ls-remote", "--symref", "--", remoteName, "HEAD"]);
	const match = /^ref: refs\/heads\/([^\s]+)\tHEAD$/m.exec(symref);
	const branch = match?.[1];
	if (!branch || !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith(".") || branch.endsWith("/")) {
		throw new Error("Remote default branch is unknown. Configure the GitHub remote HEAD before dispatch.");
	}
	const refs = await run(["ls-remote", "--exit-code", "--", remoteName, `refs/heads/${branch}`]);
	if (!refs.split(/\r?\n/).some((line) => /^[0-9a-fA-F]{40,64}\t/.test(line) && line.endsWith(`\trefs/heads/${branch}`))) {
		throw new Error("Remote default branch is not available as a branch ref.");
	}
	return { repositoryUrl, branch };
}
