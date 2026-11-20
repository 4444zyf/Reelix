import { AsyncLocalStorage } from "node:async_hooks";
import { deserialize, serialize } from "node:v8";
import { OperationError, OutcomeError, isOperationError, isOutcome, isOutcomeError } from "@reelix/plugin";

/**
 * The message channel between Reelix and a plugin in its own process (docs/plugins.md §6, §11.7). Only
 * plain data crosses it, by structured clone. What is not plain data is replaced on the way:
 *
 * - a function becomes a handler the other side calls by number (a provider's method, an operation's `run`);
 * - an `AbortSignal` becomes a number, and its abort is sent on; the receiver builds a signal of its own;
 * - an async iterable (a route's event stream) becomes a handler for `next` and `return`;
 * - an error becomes `{ kind, code, message, data }`, from which the receiver builds it again;
 * - properties an object hides (TypeBox keeps a schema's kind there) are sent and hidden again.
 *
 * Both sides use this module: it imports nothing of Reelix beyond `@reelix/plugin`.
 */

/** A message on the wire: its length in 4 bytes, then the message by structured clone (`v8.serialize`). */
export function frame(message: unknown): Buffer {
	const body = serialize(message);
	const head = Buffer.alloc(4);
	head.writeUInt32BE(body.length);
	return Buffer.concat([head, body]);
}

/** The messages in a stream of frames. A frame announced larger than `limit` bytes is refused before it is read. */
export class FrameReader {
	private buffered: Buffer[] = [];
	private size = 0;
	/** The length of the frame being read, once its 4 bytes have come. */
	private length?: number;
	private limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	push(chunk: Uint8Array): unknown[] {
		this.buffered.push(Buffer.from(chunk));
		this.size += chunk.length;
		const out: unknown[] = [];
		for (;;) {
			if (this.length === undefined) {
				if (this.size < 4) return out;
				if (this.buffered[0]!.length < 4) this.buffered = [Buffer.concat(this.buffered)];
				this.length = this.buffered[0]!.readUInt32BE(0);
				if (this.length > this.limit) throw new Error(`it sent a message of ${this.length} bytes, more than the limit of ${this.limit}`);
			}
			if (this.size < 4 + this.length) return out;
			const all = Buffer.concat(this.buffered);
			out.push(deserialize(all.subarray(4, 4 + this.length)));
			const rest = all.subarray(4 + this.length);
			this.buffered = rest.length ? [rest] : [];
			this.size = rest.length;
			this.length = undefined;
		}
	}
}

const TAG = "$reelix";

export type WireError = { kind: "operation" | "outcome" | "coded" | "error"; message: string; code?: string; outcome?: unknown; data?: unknown };

type Message =
	| { k: "call"; id: number; to: number | string; args: unknown[]; via?: number }
	| { k: "post"; to: string; args: unknown[] }
	| { k: "result"; id: number; value: unknown }
	| { k: "error"; id: number; error: WireError }
	| { k: "abort"; signal: number }
	| { k: "release"; fn: number };

type ChannelOptions = {
	send(message: unknown): void;
	/** Functions the other side may call by name. */
	exports?: Record<string, (...args: any[]) => unknown>;
	/** An error of this side that carries a code meant for the caller (Reelix's `ReelixError`). */
	coded?(e: unknown): boolean;
	/** Build such an error again from what the other side sent. */
	revive?(w: WireError): Error | undefined;
	/** How many calls of this side wait for an answer, whenever that changes. */
	waiting?(count: number): void;
};

const isPlainObject = (v: object) => {
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
};

export class Channel {
	private o: ChannelOptions;
	private exports: Record<string, (...args: any[]) => unknown>;
	private handlers = new Map<number, (...args: unknown[]) => unknown>();
	private handlerIds = new WeakMap<(...args: any[]) => unknown, number>();
	private nextHandler = 1;
	private nextCall = 1;
	private pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void; context: <R>(fn: () => R) => R }>();
	/** Signals of the other side, mirrored here, and how many running calls carry each. */
	private mirrored = new Map<number, { controller: AbortController; uses: number }>();
	private signalIds = new WeakMap<AbortSignal, number>();
	private nextSignal = 1;
	/** Which call of the other side this side is serving now: its calls back belong to it. */
	private serving = new AsyncLocalStorage<number>();
	private closed?: Error;

	constructor(o: ChannelOptions) {
		this.o = o;
		this.exports = o.exports ?? {};
	}

	/** Functions the other side may call by name from now on. */
	expose(exports: Record<string, (...args: any[]) => unknown>): void {
		this.exports = { ...this.exports, ...exports };
	}

	/** Call a function of the other side; its own errors come back as errors. */
	call(to: number | string, args: unknown[]): Promise<unknown> {
		if (this.closed) return Promise.reject(this.closed);
		const id = this.nextCall++;
		// A call back from the other side runs where this call was made (a hook in trial, a plugin's job).
		const context = AsyncLocalStorage.snapshot();
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, context });
			this.o.waiting?.(this.pending.size);
			try {
				this.o.send({ k: "call", id, to, args: this.marshal(args) as unknown[], via: this.serving.getStore() } satisfies Message);
			} catch (e) {
				this.pending.delete(id);
				this.o.waiting?.(this.pending.size);
				reject(e);
			}
		});
	}

	/** Call without waiting for an answer (a log line). */
	post(to: string, args: unknown[]): void {
		if (!this.closed) this.trySend({ k: "post", to, args: this.marshal(args) as unknown[] });
	}

	/** Send what needs no answer; when the other side has gone, its exit already says so. */
	private trySend(message: Message): void {
		try {
			this.o.send(message);
		} catch {
			/* gone */
		}
	}

	/** The other side is gone: every waiting call fails with `error`, and its signals are aborted. */
	close(error: Error): void {
		if (this.closed) return;
		this.closed = error;
		for (const p of this.pending.values()) p.reject(error);
		this.pending.clear();
		for (const m of this.mirrored.values()) m.controller.abort(error);
		this.mirrored.clear();
		this.handlers.clear();
	}

	receive(raw: unknown): void {
		const m = raw as Message;
		if (this.closed || typeof m !== "object" || m === null) return;
		switch (m.k) {
			case "call":
			case "post":
				void this.serve(m);
				return;
			case "result":
			case "error": {
				const p = this.pending.get(m.id);
				if (!p) return;
				this.pending.delete(m.id);
				this.o.waiting?.(this.pending.size);
				if (m.k === "result") p.resolve(this.unmarshal(m.value));
				else p.reject(this.errorFrom(m.error));
				return;
			}
			case "abort":
				this.mirrored.get(m.signal)?.controller.abort();
				return;
			case "release":
				this.handlers.delete(m.fn);
				return;
		}
	}

	private async serve(m: Extract<Message, { k: "call" | "post" }>): Promise<void> {
		const carried: number[] = [];
		const run = async () => {
			const fn = typeof m.to === "number" ? this.handlers.get(m.to) : Object.hasOwn(this.exports, m.to) ? this.exports[m.to] : undefined;
			if (!fn) throw new Error(`there is no handler ${m.to}; the plugin may have stopped`);
			return fn(...(this.unmarshal(m.args, carried) as unknown[]));
		};
		const pending = m.k === "call" && m.via !== undefined ? this.pending.get(m.via) : undefined;
		const within = <R>(fn: () => R) => (pending ? pending.context(fn) : fn());
		try {
			const value = await within(() => (m.k === "call" ? this.serving.run(m.id, run) : run()));
			if (m.k === "call") this.answer({ k: "result", id: m.id, value: this.marshal(value) });
		} catch (e) {
			if (m.k === "call") this.answer({ k: "error", id: m.id, error: this.wireError(e) });
		} finally {
			for (const id of carried) {
				const s = this.mirrored.get(id);
				if (s && --s.uses <= 0) this.mirrored.delete(id);
			}
		}
	}

	private answer(message: Message): void {
		if (this.closed) return;
		try {
			this.o.send(message);
		} catch (e) {
			// A result that cannot be cloned is the plugin's error, not the channel's.
			if (message.k === "result") this.trySend({ k: "error", id: message.id, error: this.wireError(new Error(`the answer is not plain data: ${(e as Error).message}`)) });
		}
	}

	private handler(fn: (...args: any[]) => unknown): number {
		const known = this.handlerIds.get(fn);
		if (known) return known;
		const id = this.nextHandler++;
		this.handlers.set(id, fn);
		this.handlerIds.set(fn, id);
		return id;
	}

	private signal(s: AbortSignal): number {
		const known = this.signalIds.get(s);
		if (known) return known;
		const id = this.nextSignal++;
		this.signalIds.set(s, id);
		if (!s.aborted) s.addEventListener("abort", () => !this.closed && this.trySend({ k: "abort", signal: id }), { once: true });
		return id;
	}

	/** Replace what is not plain data, to send it. */
	marshal(value: unknown, seen = new Set<object>()): unknown {
		if (typeof value === "function") return { [TAG]: "fn", id: this.handler(value as (...args: unknown[]) => unknown) };
		if (typeof value !== "object" || value === null) return value;
		if (value instanceof AbortSignal) return { [TAG]: "signal", id: this.signal(value), aborted: value.aborted };
		if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp) return value;
		if (value instanceof Error) return { [TAG]: "error", error: this.wireError(value) };
		if (seen.has(value)) throw new Error("a value sent to or from a plugin cannot refer to itself");
		seen.add(value);
		try {
			if (Array.isArray(value)) return value.map((v) => this.marshal(v, seen));
			const iterate = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
			if (typeof iterate === "function") return { [TAG]: "iter", id: this.handler(this.iteratorHandler(value as AsyncIterable<unknown>)) };
			const out: Record<string, unknown> = {};
			const hidden: Record<string, unknown> = {};
			for (const key of Object.getOwnPropertyNames(value)) {
				const d = Object.getOwnPropertyDescriptor(value, key)!;
				if (!("value" in d)) continue;
				const v = this.marshal(typeof d.value === "function" ? d.value.bind(value) : d.value, seen);
				if (d.enumerable) out[key] = v;
				else hidden[key] = v;
			}
			// Methods of a class instance (a provider written as a class) live on its prototype.
			if (!isPlainObject(value)) {
				for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
					for (const key of Object.getOwnPropertyNames(proto)) {
						const d = Object.getOwnPropertyDescriptor(proto, key)!;
						if (key !== "constructor" && !(key in out) && typeof d.value === "function") out[key] = this.marshal(d.value.bind(value), seen);
					}
				}
			}
			return Object.keys(hidden).length ? { [TAG]: "object", value: out, hidden } : out;
		} finally {
			seen.delete(value);
		}
	}

	private iteratorHandler(iterable: AsyncIterable<unknown>) {
		let it: AsyncIterator<unknown> | undefined;
		return async (op: unknown, arg: unknown) => {
			it ??= iterable[Symbol.asyncIterator]();
			if (op === "return") return (await it.return?.(arg)) ?? { done: true, value: undefined };
			return it.next();
		};
	}

	/** Build what was sent again. `carried`: the other side's signals in it, held while the call that brought them runs. */
	unmarshal(value: unknown, carried?: number[]): unknown {
		if (typeof value !== "object" || value === null || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp) return value;
		if (Array.isArray(value)) return value.map((v) => this.unmarshal(v, carried));
		const tagged = value as Record<string, any>;
		switch (tagged[TAG]) {
			case "fn": {
				const id = tagged.id as number;
				return (...args: unknown[]) => this.call(id, args);
			}
			case "signal": {
				const id = tagged.id as number;
				let s = this.mirrored.get(id);
				if (!s) {
					s = { controller: new AbortController(), uses: 0 };
					this.mirrored.set(id, s);
				}
				s.uses++;
				carried?.push(id);
				if (tagged.aborted) s.controller.abort();
				return s.controller.signal;
			}
			case "iter": {
				const id = tagged.id as number;
				const release = () => !this.closed && this.trySend({ k: "release", fn: id });
				return {
					[Symbol.asyncIterator]: () => ({
						next: async () => {
							const r = (await this.call(id, ["next"])) as IteratorResult<unknown>;
							if (r.done) release();
							return r;
						},
						// Ending a stream whose plugin has stopped is no error: it has ended.
						return: async (v?: unknown) => {
							const r = (await this.call(id, ["return", v]).catch(() => ({ done: true, value: undefined }))) as IteratorResult<unknown>;
							release();
							return r;
						},
					}),
				};
			}
			case "error":
				return this.errorFrom(tagged.error as WireError);
			case "object": {
				const out = this.unmarshal(tagged.value, carried) as Record<string, unknown>;
				for (const [k, v] of Object.entries(tagged.hidden as Record<string, unknown>)) Object.defineProperty(out, k, { value: this.unmarshal(v, carried), enumerable: false, writable: true, configurable: true });
				return out;
			}
		}
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(tagged)) out[k] = this.unmarshal(v, carried);
		return out;
	}

	private wireError(e: unknown): WireError {
		const err = e as { message?: unknown; code?: unknown; data?: unknown; detail?: unknown } | null;
		const message = typeof err?.message === "string" ? err.message : String(e);
		const code = typeof err?.code === "string" ? err.code : undefined;
		let data: unknown;
		try {
			data = structuredClone(err?.data ?? err?.detail);
		} catch {
			data = undefined;
		}
		if (isOperationError(e)) return { kind: "operation", message, code, data };
		if (isOutcomeError(e)) return { kind: "outcome", message, outcome: e.outcome };
		return { kind: this.o.coded?.(e) ? "coded" : "error", message, code, data };
	}

	private errorFrom(w: WireError): Error {
		if (w.kind === "operation") return new OperationError(w.code ?? "refused", w.message);
		if (w.kind === "outcome" && isOutcome(w.outcome)) return new OutcomeError(w.outcome);
		const revived = w.kind === "coded" ? this.o.revive?.(w) : undefined;
		if (revived) return revived;
		return Object.assign(new Error(w.message), w.code === undefined ? {} : { code: w.code }, w.data === undefined ? {} : { data: w.data });
	}
}
