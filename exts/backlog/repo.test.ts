import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoLabel } from "./repo.ts";

const root = mkdtempSync(join(tmpdir(), "backlog-repos-"));
function git(repo: string, ...args: string[]): void {
	execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}
function repo(name: string): string {
	const path = join(root, name);
	mkdirSync(path);
	git(path, "init", "--quiet");
	return path;
}
function label(path: string): string {
	return repoLabel(path, root, root);
}

try {
	const main = repo("main");
	const middle = repo("middle");
	const clone = repo("clone");
	git(main, "remote", "add", "origin", "git@example.com:team/project.git");
	git(clone, "remote", "add", "origin", "https://example.com/team/project.git");
	git(clone, "remote", "add", "missing", "../missing");
	git(clone, "remote", "add", "invalid", root);
	git(clone, "remote", "add", "local", "../middle");
	git(middle, "remote", "add", "local", pathToFileURL(main).href);
	assert.equal(label(clone), "~/main", "relative and file remotes form a chain; invalid and network remotes are ignored");

	git(clone, "remote", "add", "direct", main);
	assert.equal(label(clone), "~/main", "converging remote paths are not a cycle");

	const other = repo("other");
	git(middle, "remote", "add", "other", other);
	assert.equal(label(clone), "~/clone", "downstream ambiguity falls back to the original project");
	git(middle, "remote", "remove", "other");

	symlinkSync(middle, join(root, "alias"), "dir");
	git(main, "remote", "add", "cycle", "../alias");
	assert.equal(label(clone), "~/clone", "a downstream cycle through a symlink aborts the entire traversal");
	git(main, "remote", "remove", "cycle");
	git(main, "remote", "add", "self", main);
	assert.equal(label(clone), "~/clone", "a self-cycle aborts the entire traversal");
	console.log("  ok  local repository remote resolution");
} finally {
	rmSync(root, { recursive: true, force: true });
}
