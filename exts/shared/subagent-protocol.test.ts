import {
	isQuestionTitle,
	parseApprovalTitle,
	parseAutoApproveStat,
	questionTitle,
	SUBAGENT_TOKEN_ENV,
	tagApprovalTitle,
	tagAutoApproveStat,
} from "./subagent-protocol.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
	if (condition) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`);
	}
}

const priorToken = process.env[SUBAGENT_TOKEN_ENV];
delete process.env[SUBAGENT_TOKEN_ENV];
check("parent approval titles are unchanged", tagApprovalTitle("Approve?") === "Approve?");
check("parent stats do not create child notifications", tagAutoApproveStat("humanApprovals") === undefined);

process.env[SUBAGENT_TOKEN_ENV] = "secret";
const tagged = tagApprovalTitle("Approve?");
check("child approval titles carry the run token", tagged !== "Approve?");
check("parent strips matching approval markers", parseApprovalTitle(tagged, "secret") === "Approve?");
check("wrong child cannot forge another run's approval marker", parseApprovalTitle(tagged, "other") === undefined);
const taggedStat = tagAutoApproveStat("humanApprovals") ?? "";
check("child stats carry the run token", parseAutoApproveStat(taggedStat, "secret") === "humanApprovals");
check("wrong child cannot report another run's stats", parseAutoApproveStat(taggedStat, "other") === undefined);
check("unknown stat names are rejected", parseAutoApproveStat(`${taggedStat}extra`, "secret") === undefined);
check("supervisor questions require an exact marker", isQuestionTitle(questionTitle("secret"), "secret"));
check("supervisor question suffixes are rejected", !isQuestionTitle(`${questionTitle("secret")}Approve?`, "secret"));

if (priorToken === undefined) delete process.env[SUBAGENT_TOKEN_ENV];
else process.env[SUBAGENT_TOKEN_ENV] = priorToken;

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
