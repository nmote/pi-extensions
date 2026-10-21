import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function expandHome(path: string, home = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

export function abbreviateHome(path: string, home = homedir()): string {
	if (path === home) return "~";
	if (path.startsWith(`${home}${sep}`)) return `~/${path.slice(home.length + 1)}`;
	return path;
}

/** Canonical path of the nearest existing ancestor, with case normalized on case-insensitive filesystems. */
function canonical(path: string): string {
	let existing = path;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	return join(realpathSync.native(existing), relative(existing, path));
}

/** Shared worktree root for a `.git` file; undefined for submodules. */
function sharedWorktreeRoot(root: string, dotGitFile: string): string | undefined {
	try {
		const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGitFile, "utf8"));
		if (!match) return undefined;
		const gitDir = resolve(root, match[1]!);
		const commonDir = realpathSync.native(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
		const name = basename(commonDir);
		return name === ".git" || name === ".bare" ? dirname(commonDir) : commonDir;
	} catch {
		return undefined;
	}
}

/** Repository root containing `start`, mapping linked worktrees to their shared root. */
export function repoRoot(start: string): string | undefined {
	for (let dir = start; ; dir = dirname(dir)) {
		const dotGit = join(dir, ".git");
		let stats;
		try {
			stats = statSync(dotGit);
		} catch {
			stats = undefined;
		}
		if (stats?.isDirectory()) return dir;
		if (stats?.isFile()) return sharedWorktreeRoot(dir, dotGit) ?? dir;
		if (dirname(dir) === dir) return undefined;
	}
}

function git(root: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1000,
		});
	} catch {
		return undefined;
	}
}

function localRemoteRoots(root: string): string[] {
	const config = git(root, ["config", "--null", "--get-regexp", "^remote\\..*\\.url$"]) ?? "";
	const roots = new Set<string>();
	for (const entry of config.split("\0")) {
		const url = entry.slice(entry.indexOf("\n") + 1);
		if (!url) continue;
		let path: string;
		try {
			if (url.startsWith("file://")) path = fileURLToPath(url);
			else {
				// Git treats a colon before any slash as an SSH host separator.
				if (/^[^/]*:/.test(url)) continue;
				path = resolve(root, url);
			}
			path = realpathSync.native(path);
		} catch {
			continue;
		}
		const gitDir = git(path, ["rev-parse", "--absolute-git-dir"])?.trim();
		if (!gitDir) continue;
		const commonRoot = repoRoot(path);
		roots.add(canonical(commonRoot ?? (basename(gitDir) === ".git" ? dirname(gitDir) : gitDir)));
	}
	return [...roots];
}

/** Cycles and conflicting destinations invalidate the entire traversal. */
function localRemoteRoot(root: string): string {
	const active = new Set<string>();
	const resolved = new Map<string, string>();
	function visit(path: string): string | undefined {
		if (active.has(path) || active.size + resolved.size >= 100) return undefined;
		const cached = resolved.get(path);
		if (cached) return cached;
		active.add(path);
		let destination: string | undefined;
		for (const remote of localRemoteRoots(path)) {
			const target = visit(remote);
			if (!target || (destination !== undefined && destination !== target)) return undefined;
			destination = target;
		}
		active.delete(path);
		const result = destination ?? path;
		resolved.set(path, result);
		return result;
	}
	return visit(root) ?? root;
}

/** Stable repository label, following shared worktree roots and unambiguous local remotes. */
export function repoLabel(path: string, cwd: string, home = homedir()): string {
	const absolute = canonical(resolve(cwd, expandHome(path.trim(), home)));
	const root = repoRoot(absolute);
	return abbreviateHome(root ? localRemoteRoot(canonical(root)) : absolute, canonical(resolve(home)));
}
