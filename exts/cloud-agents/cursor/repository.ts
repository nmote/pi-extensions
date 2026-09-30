import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_TIMEOUT_MS = 10_000;

export interface CursorRepository {
	repositoryUrl: string;
	remoteName: string;
}

type GitRunner = Pick<ExtensionAPI, "exec">;

function cancelled(signal?: AbortSignal): never {
	if (signal?.aborted) throw new Error("Cursor Cloud dispatch cancelled.");
	throw new Error("Git command failed while identifying the repository.");
}

async function git(runner: GitRunner, cwd: string, args: string[], signal?: AbortSignal) {
	const result = await runner.exec("git", args, { cwd, signal, timeout: GIT_TIMEOUT_MS });
	if (signal?.aborted) cancelled(signal);
	if (result.killed) throw new Error("Git command timed out while identifying the repository.");
	return result;
}

function oneLine(text: string): string | undefined {
	const lines = text.trim().split(/\r?\n/).filter(Boolean);
	return lines.length === 1 ? lines[0] : undefined;
}

function cleanPath(path: string): string | undefined {
	const normalized = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
	const parts = normalized.split("/");
	if (parts.length !== 2 || parts.some((part) => part === "." || part === ".." || !/^[A-Za-z0-9_.-]+$/.test(part))) return undefined;
	return normalized;
}

export function normalizeGitHubRemote(remoteUrl: string): string {
	const remote = remoteUrl.trim();
	const scp = /^git@github\.com:([^?#]+)$/i.exec(remote);
	if (scp) {
		const path = cleanPath(scp[1]);
		if (path) return `https://github.com/${path}`;
	}

	try {
		const url = new URL(remote);
		if (!["https:", "http:", "ssh:"].includes(url.protocol) || url.hostname.toLowerCase() !== "github.com") {
			throw new Error("unsupported");
		}
		const path = cleanPath(url.pathname);
		if (path) return `https://github.com/${path}`;
	} catch {
		// Report one generic error below without echoing a possibly credential-bearing URL.
	}
	throw new Error("The selected remote is not a supported github.com repository URL.");
}

export async function inspectCursorRepository(
	runner: GitRunner,
	cwd: string,
	signal?: AbortSignal,
): Promise<CursorRepository> {
	const inside = await git(runner, cwd, ["rev-parse", "--is-inside-work-tree"], signal);
	if (inside.code !== 0 || inside.stdout.trim() !== "true") {
		throw new Error("The current directory is not inside a Git repository.");
	}

	const listed = await git(runner, cwd, ["remote"], signal);
	if (listed.code !== 0) cancelled(signal);
	const remotes = listed.stdout.split(/\r?\n/).filter(Boolean);
	const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
	if (!remote) {
		throw new Error(remotes.length === 0
			? "This Git repository has no remote. Add a GitHub remote before dispatching."
			: "Multiple Git remotes exist without origin. Configure origin to select a GitHub repository before dispatching.");
	}

	const resolved = await git(runner, cwd, ["remote", "get-url", remote], signal);
	const remoteUrl = resolved.code === 0 ? oneLine(resolved.stdout) : undefined;
	if (!remoteUrl) throw new Error(`Could not resolve the URL for remote ${remote}.`);
	return { repositoryUrl: normalizeGitHubRemote(remoteUrl), remoteName: remote };
}
