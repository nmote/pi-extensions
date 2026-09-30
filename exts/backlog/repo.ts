import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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

/** Stable repository label for a path: its repository root, or the path itself outside one, with home shown as `~`. */
export function repoLabel(path: string, cwd: string, home = homedir()): string {
	const absolute = canonical(resolve(cwd, expandHome(path.trim(), home)));
	return abbreviateHome(repoRoot(absolute) ?? absolute, canonical(resolve(home)));
}
