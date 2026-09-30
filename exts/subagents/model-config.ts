/**
 * Preferred subagent models for routine, basic, and complex tasks.
 *
 * The choice lives at ~/.pi/agent/extensions/subagent-models.json and is
 * managed by /subagent-models. Consumers read it only to build advisory
 * guidance for the parent agent; the parent can always override it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickModel } from "../shared/small-model.ts";

export type SubagentModelSlot = "routine" | "basic" | "complex";

export interface SubagentModelRef {
	provider: string;
	model: string;
}

export interface SubagentModelsConfig {
	routine?: SubagentModelRef;
	basic?: SubagentModelRef;
	complex?: SubagentModelRef;
}

export function configPath(): string {
	return join(getAgentDir(), "extensions", "subagent-models.json");
}

function parseRef(raw: unknown): SubagentModelRef | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Record<string, unknown>;
	return typeof value.provider === "string" && typeof value.model === "string"
		? { provider: value.provider, model: value.model }
		: undefined;
}

export function loadSubagentModels(path = configPath()): SubagentModelsConfig {
	if (!existsSync(path)) return {};

	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			routine: parseRef(raw.routine),
			basic: parseRef(raw.basic),
			complex: parseRef(raw.complex),
		};
	} catch (error) {
		console.error(`subagent-models: could not parse ${path}: ${error}`);
		return {};
	}
}

function writeConfig(path: string, config: SubagentModelsConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function saveSubagentModel(
	slot: SubagentModelSlot,
	provider: string,
	model: string,
	path = configPath(),
): void {
	const config = loadSubagentModels(path);
	config[slot] = { provider, model };
	writeConfig(path, config);
}

export function clearSubagentModel(slot: SubagentModelSlot, path = configPath()): void {
	const config = loadSubagentModels(path);
	delete config[slot];
	writeConfig(path, config);
}

export function formatModelRef(ref: SubagentModelRef): string {
	return `${ref.provider}/${ref.model}`;
}

export interface SubagentModelPolicy {
	/** Compact guidance appended to the subagent tool description. */
	text: string;
	/** Guideline bullets appended to the subagent tool promptGuidelines. */
	guidelines: string[];
}

/** Build advisory model guidance from the saved preferences. */
export function describeSubagentModelPolicy(config: SubagentModelsConfig): SubagentModelPolicy {
	const routine = config.routine ? formatModelRef(config.routine) : "the session model";
	const basic = config.basic ? formatModelRef(config.basic) : "the session model";
	const complex = config.complex ? formatModelRef(config.complex) : "the session model (omit model)";
	return {
		text:
			`Preferred subagent models (advisory, not binding): basic tasks -> ${basic}; ` +
			`routine tasks -> ${routine}; complex tasks -> ${complex}. ` +
			"An explicit user request for a specific model always overrides these.",
		guidelines: [
			`Prefer the user's subagent model preferences when they fit: basic tasks -> ${basic}, ` +
				`routine tasks -> ${routine}, complex tasks -> ${complex}. ` +
				"These are advisory; honor an explicit user request for a model first.",
		],
	};
}

/** Show the shared picker for one slot and persist the choice. Returns the chosen model. */
export async function pickSubagentModel(
	ctx: ExtensionContext,
	slot: SubagentModelSlot,
	options: { signal?: AbortSignal } = {},
): Promise<Model<any> | undefined> {
	const current = loadSubagentModels()[slot];
	const currentRef = current ? formatModelRef(current) : undefined;
	const title = currentRef
		? `Pick the model for ${slot} subagent tasks (current: ${currentRef}):`
		: `Pick the model for ${slot} subagent tasks:`;
	return pickModel(ctx, {
		signal: options.signal,
		title,
		emptyMessage: "subagent-models: no authenticated models available",
		saveErrorPrefix: "subagent-models: could not save model selection",
		save: (provider, model) => saveSubagentModel(slot, provider, model),
	});
}
