/** Model-specific search and rendering for the shared searchable picker. */

import type { Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { SearchablePicker } from "./searchable-picker.ts";

export interface NamedModel {
	provider: string;
	id: string;
	name?: string;
}

/** Search text matching the built-in model selector: provider-prefixed token bundles. */
export function smallModelSearchText(model: NamedModel): string {
	const name = model.name ? ` ${model.name}` : "";
	return `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id}${name}`;
}

/** Filter and rank candidates for a query, best matches first. */
export function filterSmallModels<T extends NamedModel>(models: T[], query: string): T[] {
	return fuzzyFilter(models, query, smallModelSearchText);
}

export class SmallModelPicker extends SearchablePicker<Model<any>> {
	constructor(
		theme: Theme,
		title: string,
		models: Model<any>[],
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		signal?: AbortSignal,
	) {
		super(theme, title, models, {
			searchText: smallModelSearchText,
			renderItem: (theme, model, selected) => {
				const modelText = selected ? theme.fg("accent", model.id) : model.id;
				return `${modelText} ${theme.fg("muted", `[${model.provider}]`)}`;
			},
			renderDetails: (theme, model) => theme.fg("muted", `  Model Name: ${model.name}`),
			emptyMessage: "No matching models",
		}, onSelect, onCancel, signal);
	}
}
