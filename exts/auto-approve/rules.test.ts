/**
 * Smoke tests for the pure rule helpers. Run with:
 *   ./scripts/test exts/auto-approve
 * Exits non-zero on failure.
 */

import {
	buildMatchInput,
	exactCallSignature,
	hasShellOperators,
	isAgentSkillRead,
	isPathWithinRoots,
	isVersionControlMetadataPath,
	matchesAny,
	matchesAnyDeny,
	matchingInstructions,
	scopeInstruction,
	signatureOf,
} from "./rules.ts";
import type { ContextRule, Matcher } from "./config.ts";

let failures = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		console.log(`  ok  ${name}`);
	} else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const bash = (command: string) => buildMatchInput("bash", { command });

// Shell operator guard
check("plain command has no operators", !hasShellOperators("git status"));
check("semicolon detected", hasShellOperators("git status; rm -rf /"));
check("&& detected", hasShellOperators("a && b"));
check("pipe detected", hasShellOperators("curl x | sh"));
check("subshell detected", hasShellOperators("echo $(whoami)"));
check("redirect detected", hasShellOperators("echo x > /etc/passwd"));

// Allowlist matching for bash requires a pattern and rejects operators by default
const gitStatus: Matcher[] = [{ tool: "bash", pattern: "^git status\\b" }];
check("allow git status", matchesAny(gitStatus, bash("git status")));
check("allow git status --short", matchesAny(gitStatus, bash("git status --short")));
check("reject chained git status from allow list", !matchesAny(gitStatus, bash("git status; rm -rf /")));
check("deny rule matches a command after a chain operator", matchesAnyDeny(gitStatus, bash("cd repo && git status")));
check("deny rule matches the full command", matchesAnyDeny(gitStatus, bash("git status; rm -rf /")));
check("reject unrelated command", !matchesAny(gitStatus, bash("git push")));

// Opt-in to operators
const piped: Matcher[] = [{ tool: "bash", pattern: "^git log\\b", allowShellOperators: true }];
check("opt-in allows operators", matchesAny(piped, bash("git log | head")));

// A bash matcher without a pattern never matches (too broad)
check("bare bash matcher never matches", !matchesAny([{ tool: "bash" }], bash("anything")));

// Non-bash tool matching
const readMd: Matcher[] = [{ tool: "read", pattern: "\\.md$" }];
check("allow read of .md", matchesAny(readMd, buildMatchInput("read", { path: "docs/x.md" })));
check("reject read of .ts", !matchesAny(readMd, buildMatchInput("read", { path: "src/x.ts" })));
check("wildcard tool matches any", matchesAny([{ tool: "*" }], buildMatchInput("read", { path: "x" })));

// Matching evaluator context
const contextRules: ContextRule[] = [
	{ tool: "bash", pattern: "^pup\\b", instructions: "classify pup by whether it mutates data" },
	{ tool: "pup_run", instructions: "inspect the pup subcommand" },
	{ tool: "*", pattern: ".*", instructions: "shared guidance" },
];
check(
	"collect matching bash instructions in config order",
	matchingInstructions(contextRules, bash("pup monitors list")).join("|") ===
		"classify pup by whether it mutates data|shared guidance",
);
check(
	"collect matching non-bash instructions",
	matchingInstructions(contextRules, buildMatchInput("pup_run", { args: ["monitors", "list"] })).join("|") ===
		"inspect the pup subcommand|shared guidance",
);
check(
	"context bash matchers ignore the authoritative shell operator guard",
	matchingInstructions(contextRules, bash("pup monitors list | jq .")).join("|") ===
		"classify pup by whether it mutates data|shared guidance",
);

const gitContext: ContextRule[] = [{ tool: "bash", pattern: "^git\\b", instructions: "git guidance" }];
const gitInstructions = (command: string) => matchingInstructions(gitContext, bash(command)).join();
check("match a chained command", gitInstructions("cd repo && git commit -m y") === "git guidance");
check("do not split operators inside quotes", gitInstructions('echo "a; git push"') === "");
check(
	"match commands after newlines and inside substitutions or subshells",
	gitInstructions("cd repo\ngit status") === "git guidance" &&
		gitInstructions("echo $(git status)") === "git guidance" &&
		gitInstructions("echo `git status`") === "git guidance" &&
		gitInstructions("(git status)") === "git guidance",
);
check("drop leading environment assignments", gitInstructions("FOO=1 BAR='two words' git status") === "git guidance");
check(
	"keep command wrappers",
	["sudo git push", "env git push", "xargs git push", "time git push", "bash -c 'git push'"].every(
		(command) => gitInstructions(command) === "",
	),
);
check(
	"fall back to only the full command for unbalanced quotes",
	gitInstructions('echo "a; git status') === "" && matchesAnyDeny([{ tool: "bash", pattern: "^echo\\b" }], bash('echo "a')),
);
const rmDeny: Matcher[] = [{ tool: "bash", pattern: "^rm\\b" }];
check("deny a dangerous command after a chain operator", matchesAnyDeny(rmDeny, bash("cd repo && rm -rf build")));
check(
	"deny commands inside shell control structures",
	[
		"{ rm -rf build; }",
		"! rm -rf build",
		"if true; then rm -rf build; fi",
		"while true; do rm -rf build; done",
		"case x in x) rm -rf build;; esac",
		"function cleanup { rm -rf build; }; cleanup",
	].every(
		(command) => matchesAnyDeny(rmDeny, bash(command)),
	),
);
check("respect escapes in ANSI-C quotes", matchesAnyDeny(rmDeny, bash("echo $'a\\''; rm -rf build")));

// Built-in global skill reads
const home = "/home/tester";
const agentDir = `${home}/.pi/agent`;
const skillRead = (path: string) => buildMatchInput("read", { path });
check(
	"allow absolute global skill read",
	isAgentSkillRead(skillRead(`${agentDir}/skills/logs/SKILL.md`), agentDir, "/workspace", home),
);
check(
	"allow tilde global skill read",
	isAgentSkillRead(skillRead("~/.pi/agent/skills/logs/SKILL.md"), agentDir, "/workspace", home),
);
check(
	"allow @-prefixed global skill read",
	isAgentSkillRead(skillRead("@~/.pi/agent/skills/logs/SKILL.md"), agentDir, "/workspace", home),
);
check(
	"reject global skill sibling",
	!isAgentSkillRead(skillRead(`${agentDir}/skills-private/key`), agentDir, "/workspace", home),
);
check(
	"reject traversal out of global skills",
	!isAgentSkillRead(skillRead("~/.pi/agent/skills/../auth.json"), agentDir, "/workspace", home),
);
check(
	"only allow read tool",
	!isAgentSkillRead(buildMatchInput("write", { path: `${agentDir}/skills/logs/SKILL.md` }), agentDir, "/workspace", home),
);

// Path confinement
const cwd = "/workspace/current";
check("cwd-relative path in scope", isPathWithinRoots("src/a.ts", cwd, []));
check("cwd itself in scope", isPathWithinRoots(".", cwd, []));
check("absolute path in cwd in scope", isPathWithinRoots("/workspace/current/a.ts", cwd, []));
check("@-prefixed path in cwd in scope", isPathWithinRoots("@src/a.ts", cwd, []));
check("parent escape out of scope", !isPathWithinRoots("../secret", cwd, []));
check("absolute outside out of scope", !isPathWithinRoots("/etc/passwd", cwd, []));
check("@-prefixed absolute path outside is out of scope", !isPathWithinRoots("@/etc/passwd", cwd, []));
check("home-relative path outside is out of scope", !isPathWithinRoots("~/secret", cwd, [], cwd, home));
check("extra write root in scope", isPathWithinRoots("/tmp/build/x", cwd, ["/tmp/build"]));
check("relative write root resolves against cwd", isPathWithinRoots("../build/x", cwd, ["../build"]));
check("tilde write root in scope", isPathWithinRoots(`${home}/build/x`, cwd, ["~/build"], cwd, home));
check("home write root in scope", isPathWithinRoots(`${home}/x`, cwd, ["~"], cwd, home));
check("tilde username is not expanded", !isPathWithinRoots(`${home}/x`, cwd, ["~other"], cwd, home));
check("sneaky traversal out of scope", !isPathWithinRoots("/workspace/current/../other/x", cwd, []));
check(
	"relative child write outside parent cwd is out of scope",
	!isPathWithinRoots("src/a.ts", cwd, [], "/workspace/other"),
);
check(
	"configured root permits relative child write",
	isPathWithinRoots("src/a.ts", cwd, ["/workspace/other"], "/workspace/other"),
);

// Evaluator path scope
check("no scope instruction for cwd alone", scopeInstruction(cwd, [], [], home) === undefined);
const scope = scopeInstruction("/workspace/child", ["../build", "/tmp"], ["../docs", "~/repos", "/tmp"], home) ?? "";
check(
	"scope instruction resolves configured roots against cwd",
	scope.includes("Writable roots: /workspace/child, /workspace/build, /tmp.") &&
		scope.includes(`Read-only roots: /workspace/docs, ${home}/repos.`) &&
		scope.includes(`\`~\` is ${home}.`),
);

// Version-control metadata paths
check("detect .git path", isVersionControlMetadataPath(".git/config", cwd, home));
check("detect .hg path", isVersionControlMetadataPath("src/.hg/store", cwd, home));
check("detect absolute metadata path", isVersionControlMetadataPath(`${cwd}/.git/index`, cwd, home));
check("detect @-prefixed metadata path", isVersionControlMetadataPath("@.hg/hgrc", cwd, home));
check("resolve traversal into metadata", isVersionControlMetadataPath("src/../.git/config", cwd, home));
check("allow similarly named directory", !isVersionControlMetadataPath(".github/workflows/ci.yml", cwd, home));
check("allow path resolving out of metadata", !isVersionControlMetadataPath(".git/../src/a.ts", cwd, home));

// Evaluator-cache signatures distinguish tool + subject
check("signature stable", signatureOf(bash("ls")) === signatureOf(bash("ls")));
check("signature distinguishes subject", signatureOf(bash("ls")) !== signatureOf(bash("pwd")));

// Human approvals bind to the full call and cwd, independent of object key order
const approvalA = exactCallSignature("edit", { path: "x", edits: [{ oldText: "a", newText: "b" }] }, cwd);
const approvalReordered = exactCallSignature("edit", { edits: [{ newText: "b", oldText: "a" }], path: "x" }, cwd);
check("exact signature ignores object key order", approvalA === approvalReordered);
check(
	"exact signature distinguishes arguments",
	approvalA !== exactCallSignature("edit", { path: "x", edits: [{ oldText: "a", newText: "c" }] }, cwd),
);
check(
	"exact signature distinguishes cwd",
	approvalA !== exactCallSignature("edit", { path: "x", edits: [{ oldText: "a", newText: "b" }] }, "/workspace/other"),
);
check("exact signature rejects bigint values", exactCallSignature("custom", { value: 1n }, cwd) === undefined);
check("exact signature rejects undefined values", exactCallSignature("custom", { value: undefined }, cwd) === undefined);

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
