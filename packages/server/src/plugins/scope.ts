export class ScopeClosed extends Error {
	constructor() {
		super("the plugin has stopped");
	}
}

type Undo = () => void | Promise<void>;

/**
 * Everything one activation of a plugin registered. Disposing waits for its running calls, then
 * undoes the registrations newest first, one at a time (docs/plugins.md §5.3).
 */
export class Scope {
	private phase: "open" | "closing" | "closed" = "open";
	private undo: Undo[] = [];
	private running = 0;
	private idle?: () => void;
	private stop = new AbortController();

	/** Aborted as soon as disposal begins (docs/plugins.md §5.3). */
	get signal(): AbortSignal {
		return this.stop.signal;
	}

	get open(): boolean {
		return this.phase === "open";
	}

	/** Registrations and new work: only while the plugin is running. */
	assertOpen(): void {
		if (this.phase !== "open") throw new ScopeClosed();
	}

	/** Calls from code already running: allowed until disposal has finished. */
	assertNotClosed(): void {
		if (this.phase === "closed") throw new ScopeClosed();
	}

	add(undo: Undo): void {
		this.assertOpen();
		this.undo.push(undo);
	}

	/** Run plugin code, so that disposal knows it is running. */
	async track<T>(fn: () => T | Promise<T>): Promise<T> {
		this.assertOpen();
		this.running++;
		try {
			return await fn();
		} finally {
			this.running--;
			if (!this.running) this.idle?.();
		}
	}

	async dispose(graceMs: number, onUndoError: (e: unknown) => void): Promise<void> {
		if (this.phase !== "open") return;
		this.phase = "closing";
		this.stop.abort();
		if (this.running && graceMs > 0) {
			let timer!: NodeJS.Timeout;
			await new Promise<void>((resolve) => {
				this.idle = resolve;
				timer = setTimeout(resolve, graceMs);
			});
			clearTimeout(timer);
		}
		for (const undo of this.undo.reverse()) {
			try {
				await undo();
			} catch (e) {
				onUndoError(e);
			}
		}
		this.undo = [];
		this.phase = "closed";
	}
}
