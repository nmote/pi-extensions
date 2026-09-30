const MAX_PURPOSE_LENGTH = 100;

interface SpawnTask {
	task?: string;
	agent?: string;
}

interface SpawnCall extends SpawnTask {
	cwd?: string;
	tasks?: SpawnTask[];
}

interface SpawnCallStyles {
	title(text: string): string;
	accent(text: string): string;
	muted(text: string): string;
}

export function summarizePurpose(task?: string): string {
	const firstLine = task?.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
	const characters = Array.from(firstLine);
	if (characters.length <= MAX_PURPOSE_LENGTH) return firstLine;
	return `${characters.slice(0, MAX_PURPOSE_LENGTH - 1).join("").trimEnd()}…`;
}

function taskPurpose(task: SpawnTask): string {
	const purpose = summarizePurpose(task.task);
	return `${task.agent || "general"}${purpose ? ` · ${purpose}` : ""}`;
}

export function formatSpawnCall(args: SpawnCall, styles: SpawnCallStyles): string {
	const title = styles.title("subagent ");
	if (args.tasks?.length) {
		const purposes = args.tasks.map((task) => styles.muted(`  ${taskPurpose(task)}`));
		return `${title}${styles.accent(`${args.tasks.length} parallel tasks`)}\n${purposes.join("\n")}`;
	}
	const purpose = summarizePurpose(args.task);
	return (
		title +
		styles.accent(args.agent || "general") +
		(purpose ? styles.muted(` · ${purpose}`) : "") +
		(args.cwd ? styles.muted(` in ${args.cwd}`) : "")
	);
}
