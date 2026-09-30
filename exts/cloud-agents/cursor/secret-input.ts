import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Focusable, Input, Spacer, Text } from "@earendil-works/pi-tui";

class MaskedInput implements Focusable {
	private readonly input = new Input({ prompt: "> ", placeholder: "Cursor API key" });

	constructor(onSubmit: (value: string) => void, onCancel: () => void) {
		this.input.onSubmit = onSubmit;
		this.input.onEscape = onCancel;
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const value = this.input.getValue();
		this.input.setValue("•".repeat(value.length));
		try {
			return this.input.render(width);
		} finally {
			this.input.setValue(value);
		}
	}
}

export class SecretInputDialog extends Container implements Focusable {
	private readonly input: MaskedInput;
	private _focused = false;
	private disposed = false;
	private readonly onAbort: () => void;

	constructor(
		theme: Theme,
		title: string,
		private readonly done: (value: string | undefined) => void,
		private readonly signal?: AbortSignal,
	) {
		super();
		this.input = new MaskedInput((value) => this.submit(value), () => this.cancel());
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "The key is stored in Pi's private extension configuration."), 1, 0));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "  enter save · esc cancel"), 1, 0));

		this.onAbort = () => this.cancel();
		if (signal?.aborted) queueMicrotask(() => this.cancel());
		else signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		if (!this.disposed) this.input.handleInput(data);
	}

	private submit(value: string): void {
		if (this.disposed) return;
		const apiKey = value.trim();
		if (!apiKey) return;
		this.dispose();
		this.done(apiKey);
	}

	private cancel(): void {
		if (this.disposed) return;
		this.dispose();
		this.done(undefined);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.signal?.removeEventListener("abort", this.onAbort);
	}

}
