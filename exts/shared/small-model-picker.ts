/**
 * Fuzzy-searchable small-model picker for interactive (TUI) mode.
 *
 * Mirrors the built-in model selector: a search box filters the candidates
 * with the same fuzzy matcher pi uses for /model. RPC and other UI modes keep
 * the plain ctx.ui.select path in small-model.ts, which they can relay.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Focusable, fuzzyFilter, getKeybindings, Input, Spacer, Text } from "@earendil-works/pi-tui";

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

export class SmallModelPicker extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly models: Model<any>[];
	private filtered: Model<any>[];
	private selectedIndex = 0;
	private _focused = false;
	private disposed = false;
	private readonly signal: AbortSignal | undefined;
	private readonly onAbort: () => void;

	constructor(
		private readonly theme: Theme,
		title: string,
		models: Model<any>[],
		private readonly onSelect: (model: Model<any>) => void,
		private readonly onCancel: () => void,
		signal?: AbortSignal,
	) {
		super();
		this.models = models;
		this.filtered = models;
		this.signal = signal;

		this.addChild(new Text(this.theme.fg("accent", this.theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("muted", "  ↑↓ navigate · enter select · esc cancel"), 1, 0));

		this.updateList();

		this.onAbort = () => this.cancel();
		if (signal?.aborted) {
			queueMicrotask(() => this.cancel());
		} else if (signal) {
			signal.addEventListener("abort", this.onAbort, { once: true });
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	handleInput(keyData: string): void {
		if (this.disposed) return;
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filtered[this.selectedIndex];
			if (selected) this.select(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.cancel();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private filterModels(query: string): void {
		this.filtered = filterSmallModels(this.models, query);
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const maxVisible = 10;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
		const end = Math.min(start + maxVisible, this.filtered.length);

		for (let i = start; i < end; i++) {
			const model = this.filtered[i];
			if (!model) continue;
			const isSelected = i === this.selectedIndex;
			const cursor = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const modelText = isSelected ? this.theme.fg("accent", model.id) : model.id;
			const providerBadge = this.theme.fg("muted", `[${model.provider}]`);
			this.listContainer.addChild(new Text(`${cursor}${modelText} ${providerBadge}`, 1, 0));
		}

		if (this.filtered.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 1, 0));
		} else {
			const selected = this.filtered[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  Model Name: ${selected.name}`), 1, 0));
		}

		if (start > 0 || end < this.filtered.length) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 1, 0));
		}
	}

	private select(model: Model<any>): void {
		if (this.disposed) return;
		this.dispose();
		this.onSelect(model);
	}

	private cancel(): void {
		if (this.disposed) return;
		this.dispose();
		this.onCancel();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.signal) this.signal.removeEventListener("abort", this.onAbort);
	}
}
