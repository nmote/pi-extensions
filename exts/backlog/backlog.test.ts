import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBacklogOperations, statusSummary, type OperationContext } from "./operations.ts";
import { repoLabel } from "./repo.ts";
import { BacklogStore, parseItem, referencedItems } from "./store.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<boolean> {
	try {
		await promise;
		return false;
	} catch (error) {
		return pattern.test(error instanceof Error ? error.message : String(error));
	}
}

function addedId(line: string | undefined): string {
	return /^added (\S+)/.exec(line ?? "")?.[1] ?? "";
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "backlog-test-"));
	try {
		const home = join(root, "home");
		const repo = join(home, "repos", "project");
		mkdirSync(join(repo, ".git", "worktrees", "feature"), { recursive: true });
		mkdirSync(join(repo, "src"), { recursive: true });
		const worktree = join(root, "worktrees", "feature");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "feature")}\n`);
		writeFileSync(join(repo, ".git", "worktrees", "feature", "commondir"), "../..\n");
		check(
			"repo labels map subdirectories, missing paths, and linked worktrees to the main repository under ~",
			repoLabel("src", repo, home) === "~/repos/project" &&
				repoLabel("~/repos/project/planned/module", root, home) === "~/repos/project" &&
				repoLabel(worktree, root, home) === "~/repos/project",
		);

		const store = new BacklogStore(join(root, "store"));
		const context: OperationContext = { cwd: join(repo, "src"), sessionId: "session-1", home };
		const added = await runBacklogOperations(
			store,
			[
				{ action: "add", title: "Refactor parser", body: "Context and definition of done." },
				{ action: "add", title: "Shared fix", repos: [repo, "~/other"], status: "done" },
			],
			context,
		);
		const id = addedId(added[0]);
		const file = readFileSync(store.itemPath(id), "utf8");
		const parsed = parseItem(id, file);
		check(
			"added items round-trip through Markdown frontmatter",
			parsed.title === "Refactor parser" &&
				parsed.status === "open" &&
				parsed.repos.join() === "~/repos/project" &&
				parsed.createdInSession === "session-1" &&
				parsed.body === "Context and definition of done.",
		);
		const [listed] = await runBacklogOperations(store, [{ action: "list" }], context);
		check("list defaults to active items in the current repository", listed === `backlog items for ~/repos/project (1):\n${id} [open] Refactor parser`);
		const shared = addedId(added[1]);
		const references = await referencedItems(
			[`branch zzzzzz 9${id}`, `Then ${shared}, after ~/.pi/agent/backlog/${id}.md and ${shared}`],
			store,
		);
		check(
			"referenced items are existing whole-token IDs in first-mention order",
			JSON.stringify(references) ===
				JSON.stringify([
					{ id: shared, title: "Shared fix" },
					{ id, title: "Refactor parser" },
				]),
		);

		const failed = await rejects(
			runBacklogOperations(store, [{ action: "append", id, text: "lost" }, { action: "delete", id: "zzzzzz" }], context),
			/not found/,
		);
		check("failed batches write nothing", failed && readFileSync(store.itemPath(id), "utf8") === file);

		const [read] = await runBacklogOperations(store, [{ action: "read", id }], context);
		const revision = /^revision: (\S+)$/m.exec(read ?? "")?.[1];
		await runBacklogOperations(store, [{ action: "append", id, text: "Started." }], context);
		check(
			"body replacement rejects stale revisions",
			await rejects(runBacklogOperations(store, [{ action: "update", id, body: "overwrite", revision }], context), /changed since/),
		);

		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				runBacklogOperations(new BacklogStore(store.dir), [{ action: "append", id, text: `entry ${index}` }], context),
			),
		);
		const body = parseItem(id, readFileSync(store.itemPath(id), "utf8")).body;
		check(
			"concurrent batches serialize without losing appends",
			Array.from({ length: 8 }, (_, index) => body.includes(`entry ${index}`)).every(Boolean) &&
				body.match(/^## Log$/gm)?.length === 1 &&
				!readdirSync(store.dir).some((name) => name.startsWith(".")),
		);

		mkdirSync(join(store.dir, ".lock"));
		const old = new Date(Date.now() - 60_000);
		utimesSync(join(store.dir, ".lock"), old, old);
		check(
			"stale locks from crashed processes are recovered",
			(await runBacklogOperations(store, [{ action: "update", id, status: "in_progress" }], context))[0]?.startsWith(`updated ${id}`) ===
				true,
		);

		const tree = new BacklogStore(join(root, "tree"));
		const planId = addedId((await runBacklogOperations(tree, [{ action: "add", title: "Plan" }], context))[0]);
		const [first, second] = await runBacklogOperations(
			tree,
			[
				{ action: "add", title: "Step 1", parent: planId },
				{ action: "add", title: "Step 2", parent: planId, status: "in_progress" },
			],
			context,
		);
		const [step1, step2] = [addedId(first), addedId(second)];
		const [children, readPlan, readStep] = await runBacklogOperations(
			tree,
			[
				{ action: "list", parent: planId },
				{ action: "read", id: planId },
				{ action: "read", id: step1 },
			],
			context,
		);
		check(
			"parents round-trip, filter list, and appear in read output",
			parseItem(step1, readFileSync(tree.itemPath(step1), "utf8")).parent === planId &&
				children ===
					`backlog items for ~/repos/project (2):\n${step2} [in_progress] Step 2 · parent ${planId}\n${step1} [open] Step 1 · parent ${planId}` &&
				readPlan?.endsWith(`children (2):\n  ${step2} [in_progress] Step 2\n  ${step1} [open] Step 1`) === true &&
				readStep?.includes(`parent: ${planId} [open] Plan`) === true,
		);
		check(
			"missing, self, and cyclic parents are rejected",
			(await rejects(runBacklogOperations(tree, [{ action: "add", title: "Orphan", parent: "zzzzzz" }], context), /not found/)) &&
				(await rejects(runBacklogOperations(tree, [{ action: "update", id: planId, parent: planId }], context), /descendants/)) &&
				(await rejects(runBacklogOperations(tree, [{ action: "update", id: planId, parent: step1 }], context), /descendants/)),
		);
		check(
			"deleting a parent requires deleting or detaching its children first",
			(await rejects(runBacklogOperations(tree, [{ action: "delete", id: planId }], context), /has children/)) &&
				(await runBacklogOperations(
					tree,
					[
						{ action: "update", id: step1, parent: "" },
						{ action: "delete", id: step2 },
						{ action: "delete", id: planId },
					],
					context,
				)).at(-1) === `deleted ${planId}` &&
				parseItem(step1, readFileSync(tree.itemPath(step1), "utf8")).parent === undefined,
		);

		const advice = new BacklogStore(join(root, "advice"));
		const advicePlan = addedId((await runBacklogOperations(advice, [{ action: "add", title: "Release" }], context))[0]);
		const adviceChildren = await runBacklogOperations(
			advice,
			[
				{ action: "add", title: "Build", parent: advicePlan },
				{ action: "add", title: "Test", parent: advicePlan },
				{ action: "add", title: "Document", parent: advicePlan },
			],
			context,
		);
		const [adviceBuild, adviceTest, adviceDocument] = adviceChildren.map(addedId);
		const firstCompletion = await runBacklogOperations(advice, [{ action: "update", id: adviceBuild, status: "done" }], context);
		const finalCompletions = await runBacklogOperations(
			advice,
			[
				{ action: "update", id: adviceTest, status: "done" },
				{ action: "update", id: adviceDocument, status: "dropped" },
			],
			context,
		);
		const advisory = `Review parent ${advicePlan} [open] Release: all children are done or dropped. Check its Done criteria and any remaining parent-level work before marking it done.`;
		check(
			"an all-terminal child set produces one advisory for an active parent",
			firstCompletion.length === 1 && finalCompletions.filter((line) => line === advisory).length === 1,
		);
		await runBacklogOperations(advice, [{ action: "update", id: advicePlan, status: "done" }], context);
		check(
			"terminal parents do not produce advisories",
			(await runBacklogOperations(advice, [{ action: "add", title: "Late task", parent: advicePlan, status: "done" }], context))
				.length === 1,
		);

		const deps = new BacklogStore(join(root, "deps"));
		const design = addedId((await runBacklogOperations(deps, [{ action: "add", title: "Design" }], context))[0]);
		const build = addedId((await runBacklogOperations(deps, [{ action: "add", title: "Build", dependsOn: [design] }], context))[0]);
		const ship = addedId((await runBacklogOperations(deps, [{ action: "add", title: "Ship", dependsOn: [build] }], context))[0]);
		const [blockedList, readBuild, , droppedList, , readyList] = await runBacklogOperations(
			deps,
			[
				{ action: "list", blocked: true },
				{ action: "read", id: build },
				{ action: "update", id: design, status: "dropped" },
				{ action: "list", blocked: false },
				{ action: "update", id: design, status: "done" },
				{ action: "list", blocked: false },
			],
			context,
		);
		check(
			"dependencies round-trip, block until done, and appear in list and read output",
			parseItem(ship, readFileSync(deps.itemPath(ship), "utf8")).dependsOn?.join() === build &&
				blockedList?.includes(`${build} [open, blocked by ${design}] Build`) === true &&
				blockedList.includes(`${ship} [open, blocked by ${build}] Ship`) &&
				!blockedList.includes(`${design} [`) &&
				readBuild?.includes(`depends on (1):\n  ${design} [open] Design\ndependents (1):\n  ${ship} [open, blocked by ${build}] Ship`) === true &&
				droppedList === "no matching backlog items for ~/repos/project" &&
				readyList === `backlog items for ~/repos/project (1):\n${build} [open] Build`,
		);
		check(
			"missing, self, cyclic, and depended-on deletions are rejected",
			(await rejects(runBacklogOperations(deps, [{ action: "add", title: "Orphan", dependsOn: ["zzzzzz"] }], context), /not found/)) &&
				(await rejects(runBacklogOperations(deps, [{ action: "update", id: build, dependsOn: [build] }], context), /cannot depend/)) &&
				(await rejects(runBacklogOperations(deps, [{ action: "update", id: design, dependsOn: [ship] }], context), /cannot depend/)) &&
				(await rejects(runBacklogOperations(deps, [{ action: "delete", id: build }], context), /has dependents/)),
		);

		const approval = new BacklogStore(join(root, "approval"));
		const at = (minute: number): OperationContext => ({ ...context, now: new Date(Date.UTC(2026, 0, 1, 0, minute)) });
		const [draftLine, approvedLine] = await runBacklogOperations(
			approval,
			[
				{ action: "add", title: "Draft" },
				{ action: "add", title: "Approved", body: "Plan.", status: "approved" },
			],
			at(0),
		);
		const [draft, approved] = [addedId(draftLine), addedId(approvedLine)];
		const waiting = addedId(
			(await runBacklogOperations(approval, [{ action: "add", title: "Waiting", status: "approved", dependsOn: [draft] }], at(1)))[0],
		);
		const [approvalList, startable] = await runBacklogOperations(
			approval,
			[
				{ action: "list" },
				{ action: "list", statuses: ["approved"], blocked: false },
			],
			context,
		);
		const approvalItem = (itemId: string) => parseItem(itemId, readFileSync(approval.itemPath(itemId), "utf8"));
		check(
			"approved items are logged, listed as active, and filterable to unblocked ones",
			approvalItem(approved).body === "Plan.\n\n## Log\n\n### 2026-01-01T00:00:00Z (session session-1)\n\nMarked approved." &&
				approvalList ===
					`backlog items for ~/repos/project (3):\n${approved} [approved] Approved\n${waiting} [approved, blocked by ${draft}] Waiting\n${draft} [open] Draft` &&
				startable === `backlog items for ~/repos/project (1):\n${approved} [approved] Approved`,
		);
		const approvalSnapshot = await approval.load();
		check(
			"footer summary counts blocked items only as blocked",
			statusSummary(approvalSnapshot, "~/repos/project") === "1 open · 1 approved · 1 blocked" &&
				statusSummary(approvalSnapshot, "~/other") === undefined,
		);

		const [readApproved] = await runBacklogOperations(approval, [{ action: "read", id: approved }], context);
		const approvedRevision = /^revision: (\S+)$/m.exec(readApproved ?? "")?.[1];
		const edited = await runBacklogOperations(
			approval,
			[
				{ action: "update", id: approved, body: "Revised plan.", revision: approvedRevision },
				{ action: "update", id: waiting, title: "Waiting longer", status: "approved" },
				{ action: "append", id: waiting, text: "Note." },
			],
			context,
		);
		check(
			"changing an approved plan reopens it unless the update sets status",
			edited[1] === `${approved} was approved, but its plan changed, so it is now open. Set it to approved only after the user approves the revised plan.` &&
				approvalItem(approved).status === "open" &&
				approvalItem(waiting).status === "approved" &&
				approvalItem(waiting).body.match(/Marked approved/g)?.length === 1,
		);
		check(
			"subagents cannot approve items",
			await rejects(
				runBacklogOperations(approval, [{ action: "update", id: approved, status: "approved" }], { ...context, subagent: true }),
				/subagents cannot set approved/,
			),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall checks passed");
}

await main();
