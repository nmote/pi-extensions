/**
 * Shared "small model" selection for background work: auto-approve safety
 * evaluation and session-topic topics/summaries.
 *
 * The choice lives at ~/.pi/agent/extensions/small-model.json and is managed
 * by the small-model extension (/small-model). Consumers resolve it with
 * ensureSmallModel (prompting only when missing or unusable) or show the
 * picker directly with pickSmallModel. There is no default model.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SmallModelPicker } from "./small-model-picker.ts";

export interface SmallModelConfig {
	provider?: string;
	model?: string;
}

export function configPath(): string {
	return join(getAgentDir(), "extensions", "small-model.json");
}

export function loadSmallModel(path = configPath()): SmallModelConfig {
	if (!existsSync(path)) return {};

	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			provider: typeof raw.provider === "string" ? raw.provider : undefined,
			model: typeof raw.model === "string" ? raw.model : undefined,
		};
	} catch (error) {
		console.error(`small-model: could not parse ${path}: ${error}`);
		return {};
	}
}

export function saveSmallModel(provider: string, model: string, path = configPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ provider, model }, null, 2)}\n`);
}

export function availableModels(ctx: ExtensionContext): Model<any>[] {
	return ctx.modelRegistry.getAvailable().filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
}

export interface PickSmallModelOptions {
	/** Abort signal forwarded to the picker UI. */
	signal?: AbortSignal;
	/** Current selection ("provider/model") shown in the picker title. */
	current?: string;
	/** Persistence hook; defaults to saving the shared small-model config. */
	save?: (provider: string, model: string) => void;
}

export interface PickModelOptions {
	/** Abort signal forwarded to the picker UI. */
	signal?: AbortSignal;
	/** Title shown by the picker. */
	title: string;
	/** Error message shown when no authenticated models are available. */
	emptyMessage: string;
	/** Prefix for the notification shown when persisting the choice fails. */
	saveErrorPrefix: string;
	/** Persistence hook; omitted when the caller handles persistence itself. */
	save?: (provider: string, model: string) => void;
}

/** Show the shared model picker and persist the choice through `options.save`. */
export async function pickModel(
	ctx: ExtensionContext,
	options: PickModelOptions,
): Promise<Model<any> | undefined> {
	if (!ctx.hasUI) return undefined;
	const candidates = availableModels(ctx).sort((left, right) =>
		`${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
	);
	if (candidates.length === 0) {
		ctx.ui.notify(options.emptyMessage, "error");
		return undefined;
	}

	let model: Model<any> | undefined;
	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function" && !options.signal?.aborted) {
		model = await ctx.ui.custom<Model<any> | undefined>(
			(_tui, theme, _keybindings, done) =>
				new SmallModelPicker(theme, options.title, candidates, done, () => done(undefined), options.signal),
		);
	} else {
		const choice = await ctx.ui.select(
			options.title,
			candidates.map((candidate) => `${candidate.provider}/${candidate.id}`),
			{ signal: options.signal },
		);
		model = candidates.find((candidate) => `${candidate.provider}/${candidate.id}` === choice);
	}
	if (!model) return undefined;

	if (options.save) {
		try {
			options.save(model.provider, model.id);
		} catch (error) {
			ctx.ui.notify(`${options.saveErrorPrefix}: ${error}`, "error");
		}
	}
	return model;
}

/** Always show the small-model picker and persist the choice. Returns the chosen model. */
export async function pickSmallModel(
	ctx: ExtensionContext,
	options: PickSmallModelOptions = {},
): Promise<Model<any> | undefined> {
	return pickModel(ctx, {
		signal: options.signal,
		title: options.current
			? `Pick the small model (current: ${options.current}):`
			: "Pick a small model for background work (command safety evaluation, session topics, and summaries):",
		emptyMessage: "small-model: no authenticated models available",
		saveErrorPrefix: "small-model: could not save model selection",
		save: options.save ?? saveSmallModel,
	});
}

/** Resolve the saved small model, prompting the user to pick one only when needed. */
export async function ensureSmallModel(
	ctx: ExtensionContext,
	options: { signal?: AbortSignal } = {},
): Promise<Model<any> | undefined> {
	const saved = loadSmallModel();
	const current = saved.provider && saved.model ? `${saved.provider}/${saved.model}` : undefined;
	if (saved.provider && saved.model) {
		const model = availableModels(ctx).find(
			(candidate) => candidate.provider === saved.provider && candidate.id === saved.model,
		);
		if (model) return model;
		ctx.ui.notify(`small-model: ${saved.provider}/${saved.model} is unavailable`, "warning");
	}
	return pickSmallModel(ctx, { signal: options.signal, current });
}
