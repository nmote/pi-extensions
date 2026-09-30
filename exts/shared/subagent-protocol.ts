export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_TOKEN_ENV = "PI_SUBAGENT_TOKEN";
export const SUBAGENT_TASK_COMMAND = "_subagent-task";
export const AUTO_APPROVE_TASK_CHANNEL = "auto-approve:subagent-task";
export const AUTO_APPROVE_STATE_CHANNEL = "auto-approve:get-state";
export const AUTO_APPROVE_STAT_CHANNEL = "auto-approve:record-stat";
export const AUTO_APPROVE_STAT_NAMES = [
	"evaluatorAllows",
	"softRejections",
	"evaluatorFailures",
	"escalations",
	"humanApprovals",
	"humanDenials",
] as const;
export type AutoApproveStat = (typeof AUTO_APPROVE_STAT_NAMES)[number];

const APPROVAL_MARKER = "pi-subagent-approval";
const AUTO_APPROVE_STAT_MARKER = "pi-subagent-auto-approve-stat";
const QUESTION_MARKER = "pi-subagent-question";

function marker(kind: string, token: string): string {
	return `[[${kind}:${token}]]`;
}

export function tagApprovalTitle(title: string): string {
	const token = process.env[SUBAGENT_TOKEN_ENV];
	return token ? `${marker(APPROVAL_MARKER, token)}${title}` : title;
}

export function parseApprovalTitle(title: string, token: string): string | undefined {
	const prefix = marker(APPROVAL_MARKER, token);
	return title.startsWith(prefix) ? title.slice(prefix.length) : undefined;
}

export function isAutoApproveStat(value: unknown): value is AutoApproveStat {
	return typeof value === "string" && AUTO_APPROVE_STAT_NAMES.includes(value as AutoApproveStat);
}

export function tagAutoApproveStat(stat: AutoApproveStat): string | undefined {
	const token = process.env[SUBAGENT_TOKEN_ENV];
	return token ? `${marker(AUTO_APPROVE_STAT_MARKER, token)}${stat}` : undefined;
}

export function parseAutoApproveStat(message: string, token: string): AutoApproveStat | undefined {
	const prefix = marker(AUTO_APPROVE_STAT_MARKER, token);
	if (!message.startsWith(prefix)) return undefined;
	const stat = message.slice(prefix.length);
	return isAutoApproveStat(stat) ? stat : undefined;
}

export function taskPolicyAck(token: string, mode: string): string {
	return `${marker("pi-subagent-task-policy", token)}${mode}`;
}

export function questionTitle(token: string): string {
	return marker(QUESTION_MARKER, token);
}

export function isQuestionTitle(title: string, token: string): boolean {
	return title === questionTitle(token);
}
