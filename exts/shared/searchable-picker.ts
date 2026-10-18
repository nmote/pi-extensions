import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Focusable, fuzzyFilter, getKeybindings, Input, Spacer, Text } from "@earendil-works/pi-tui";

export interface SearchablePickerOptions<T> {
	searchText: (item: T) => string;
	renderItem: (theme: Theme, item: T, selected: boolean) => string;
	renderDetails?: (theme: Theme, item: T) => string;
	emptyMessage: string;
}

/** Fuzzy-searchable list with keyboard navigation and abort handling. */
export class SearchablePicker<T> extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private filtered: T[];
	private selectedIndex = 0;
	private _focused = false;
	private disposed = false;
	private readonly onAbort: () => void;

	constructor(
		private readonly theme: Theme,
		title: string,
		private readonly items: T[],
		private readonly options: SearchablePickerOptions<T>,
		private readonly onSelect: (item: T) => void,
		private readonly onCancel: () => void,
		private readonly signal?: AbortSignal,
	) {
		super();
		this.filtered = items;
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
			if (selected !== undefined) this.select(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.cancel();
		} else {
			this.searchInput.handleInput(keyData);
			const query = this.searchInput.getValue();
			this.filtered = fuzzyFilter(this.items, query, this.options.searchText);
			this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
			this.updateList();
		}
	}

	private updateList(): void {
		this.listContainer.clear();
		const maxVisible = 10;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
		const end = Math.min(start + maxVisible, this.filtered.length);

		for (let i = start; i < end; i++) {
			const item = this.filtered[i];
			if (item === undefined) continue;
			const isSelected = i === this.selectedIndex;
			const cursor = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			this.listContainer.addChild(new Text(`${cursor}${this.options.renderItem(this.theme, item, isSelected)}`, 1, 0));
		}

		if (this.filtered.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  ${this.options.emptyMessage}`), 1, 0));
		} else if (this.options.renderDetails) {
			const selected = this.filtered[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(this.options.renderDetails(this.theme, selected), 1, 0));
		}

		if (start > 0 || end < this.filtered.length) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 1, 0));
		}
	}

	private select(item: T): void {
		if (this.disposed) return;
		this.dispose();
		this.onSelect(item);
	}

	private cancel(): void {
		if (this.disposed) return;
		this.dispose();
		this.onCancel();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.signal?.removeEventListener("abort", this.onAbort);
	}
}
