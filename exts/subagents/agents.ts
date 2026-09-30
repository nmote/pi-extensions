import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { discoverConfiguredAgents } from "../agent-config/config.ts";
import type { NamedAgentDefinition } from "../agent-config/agents.ts";

export interface SubagentTaskInput {
	task: string;
	agent?: string;
	cwd?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface DispatchDefaults {
	cwd: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	autoApproveMode?: string;
}

export interface ResolvedSubagentTask {
	task: string;
	agent: string;
	cwd: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	autoApproveMode?: string;
	systemPrompt: string;
	tools?: string[];
}

export interface NamedAgentDiscovery {
	directory: string | undefined;
	agents: NamedAgentDefinition[];
	errors: string[];
}

const SUPERVISION_PROMPT = `You are a subagent supervised by a parent coding agent. Complete only the delegated task and report a concise, concrete result.

Work autonomously when the answer follows from the task or repository. Use ask_supervisor when you are blocked by missing context, need a consequential preference, or need the parent to coordinate with other work. Do not use ask_supervisor for routine choices. Never ask the supervisor to approve a tool call: attempt the call and let the policy extensions route any approval request directly to the user. Do not address questions directly to the user in normal assistant text; use ask_supervisor so your existing context can resume after the answer.

You cannot spawn subagents. Follow all global and repository instructions loaded by Pi.`;

export function discoverNamedAgents(): NamedAgentDiscovery {
	const discovery = discoverConfiguredAgents();
	return { directory: discovery.directory, agents: discovery.definitions, errors: discovery.errors };
}

export function formatNamedAgentCatalog(discovery: NamedAgentDiscovery): string {
	const entries = [...discovery.agents]
		.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
		.map((agent) => `${agent.name}: ${agent.description}`)
		.join("\n\n") || "none";
	const errors = discovery.errors.length
		? `\n\nDiscovery errors:\n${[...discovery.errors].sort().join("\n")}`
		: "";
	return `Agent directory: ${discovery.directory ?? "invalid configuration"}\n\nNamed subagents:\n${entries}${errors}`;
}

export function resolveSubagentTask(
	input: SubagentTaskInput,
	defaults: DispatchDefaults,
	namedAgents: NamedAgentDefinition[],
): ResolvedSubagentTask {
	const task = input.task.trim();
	if (!task) throw new Error("Subagent task cannot be empty");

	let definition: NamedAgentDefinition | undefined;
	if (input.agent) {
		definition = namedAgents.find((candidate) => candidate.name === input.agent);
		if (!definition) {
			const available = namedAgents.map((candidate) => candidate.name).join(", ") || "none";
			throw new Error(`Unknown subagent "${input.agent}". Named agents: ${available}`);
		}
	}

	const configuredModel = input.model ?? definition?.model;
	const model = !configuredModel || configuredModel === "inherit" ? defaults.model : configuredModel;
	const systemPrompt = definition?.systemPrompt.trim()
		? `${SUPERVISION_PROMPT}\n\n${definition.systemPrompt.trim()}`
		: SUPERVISION_PROMPT;

	return {
		task,
		agent: definition?.name ?? "general",
		cwd: input.cwd ?? defaults.cwd,
		model,
		thinkingLevel: input.thinkingLevel ?? defaults.thinkingLevel,
		autoApproveMode: defaults.autoApproveMode,
		systemPrompt,
		tools: definition?.tools === undefined ? undefined : [...definition.tools, "ask_supervisor"],
	};
}
