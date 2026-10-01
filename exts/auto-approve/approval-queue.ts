/** Serializes approval dialogs within one extension runtime. */
export class ApprovalQueue {
	private tail: Promise<void> = Promise.resolve();
	private lifetime = new AbortController();

	reset(): void {
		this.lifetime.abort();
		this.lifetime = new AbortController();
	}

	async select(
		open: (signal: AbortSignal) => Promise<string | undefined>,
		operationSignal?: AbortSignal,
	): Promise<{ choice: string | undefined; signal: AbortSignal }> {
		const signal = AbortSignal.any([
			this.lifetime.signal,
			...(operationSignal ? [operationSignal] : []),
		]);
		let onAbort!: () => void;
		const cancelled = new Promise<undefined>((resolve) => {
			onAbort = () => resolve(undefined);
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		const route = this.tail.then(() => {
			if (signal.aborted) return undefined;
			return Promise.race([open(signal), cancelled]);
		});
		this.tail = route.then(() => undefined, () => undefined);
		try {
			// Queued requests can cancel without waiting for the active dialog.
			const choice = await Promise.race([route, cancelled]);
			return { choice, signal };
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}
}
