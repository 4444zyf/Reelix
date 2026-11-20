/**
 * The process a plugin with `runtime: "process"` runs in (docs/plugins.md §11.7). Reelix starts it with
 * Node's permission model (`process.ts` sets the flags); it receives the plugin's context over the
 * message channel on its fourth stream and nothing else. This file runs only there.
 *
 * Before the plugin's code loads, this file takes away what Node's permission model does not cover:
 * Node's modules other than `ALLOWED_MODULES` (the network, `node:sqlite`, the inspector), module hooks of
 * the plugin's own, signals to other processes, and the global `fetch`, `WebSocket` and `EventSource`. That is
 * Reelix's code inside the process, not the operating system's guarantee: §11.7 says what it does not stop.
 */
import Module, { registerHooks, syncBuiltinESMExports } from "node:module";
import { writeSync } from "node:fs";
import { Socket } from "node:net";
import { Writable } from "node:stream";
import type { PluginContext, PluginDefinition } from "@reelix/plugin";
import type { Catalog } from "../../../core/src/messages.ts";
import type { Language } from "../../../core/src/config.ts";

/** What process.ts passes: the modules the plugin may load, and where Reelix's own packages are. */
const setup = JSON.parse(process.argv[2]!) as { allowed: string[]; packages: Record<string, string> };

// Taken now, before the plugin's code can replace them: the checks below use only these.
const uncurry = Function.prototype.bind.bind(Function.prototype.call) as <A extends unknown[], R>(fn: (...args: A) => R) => (self: unknown, ...args: A) => R;
const startsWith = uncurry(String.prototype.startsWith);
const has = uncurry(Set.prototype.has as (v: string) => boolean);
const allowed = new Set(setup.allowed.map((m) => `node:${m}`));
const packageUrls = new Map(Object.entries(setup.packages));
const packageUrl = uncurry(Map.prototype.get as (k: string) => string | undefined);
const self = process.pid;

const refusal = (what: string) => Object.assign(new Error(`${what} is not available to a plugin in its own process; its network is ctx.http.fetch (docs/plugins.md §11.7)`), { code: "ERR_ACCESS_DENIED" });

/** Write all of `bytes` to the output Reelix reads. */
function writeAll(fd: number, bytes: Uint8Array): void {
	for (let at = 0; at < bytes.length; ) {
		try {
			at += writeSync(fd, bytes, at);
		} catch (e) {
			if ((e as { code?: string }).code !== "EAGAIN") throw e;
		}
	}
}

// Its output goes to Reelix as plain writes. Node would make a pipe a network socket, whose class opens any socket.
for (const [name, fd] of [["stdout", 1], ["stderr", 2]] as const) {
	const stream = new Writable({
		write(chunk: Buffer, _encoding, done) {
			try {
				writeAll(fd, chunk);
				done();
			} catch (e) {
				done(e as Error);
			}
		},
	});
	Object.defineProperty(process, name, { value: Object.assign(stream, { fd, isTTY: false }), enumerable: true, configurable: false, writable: false });
}

let locked = false;
registerHooks({
	resolve(specifier, context, next) {
		let found: ReturnType<typeof next>;
		try {
			found = next(specifier, context);
		} catch (e) {
			// Reelix's packages, which the process may read only where they really are, not through node_modules.
			const url = packageUrl(packageUrls, specifier);
			if (url === undefined) throw e;
			return { url, shortCircuit: true };
		}
		if (locked && startsWith(found.url, "node:") && !has(allowed, found.url)) throw refusal(specifier);
		return found;
	},
});

const { Channel, FrameReader, frame } = await import("./channel.ts");
const { loadPlugin, prepareLoader } = await import("./loader.ts");
const { messageFrom } = await import("../../../core/src/messages.ts");
// The loader's own modules (its TypeScript compiler) load now, while every module may.
prepareLoader();

locked = true;
const noHooks = () => {
	throw refusal("A module hook");
};
Object.assign(Module, { registerHooks: noHooks, register: noHooks });
syncBuiltinESMExports();
const builtin = uncurry(process.getBuiltinModule);
process.getBuiltinModule = ((id: string) => {
	if (typeof id !== "string" || !has(allowed, startsWith(id, "node:") ? id : `node:${id}`)) throw refusal(String(id));
	return builtin(process, id);
}) as typeof process.getBuiltinModule;
// A signal only to itself: SIGUSR1 to Reelix would open its debugger, and SIGKILL would end it.
const kill = uncurry((process as unknown as { _kill: (pid: number, signal: number) => number })._kill);
Object.defineProperty(process, "_kill", {
	value: (pid: number, signal: number) => {
		if (pid !== self) throw refusal("A signal to another process");
		return kill(process, self, signal);
	},
	writable: false,
	configurable: false,
});
Object.defineProperty(process, "_debugProcess", {
	value: () => {
		throw refusal("Another process's debugger");
	},
	writable: false,
	configurable: false,
});
// Node's own fetch, WebSocket and EventSource reach the network from inside Node.
for (const name of ["fetch", "WebSocket", "EventSource"]) Reflect.deleteProperty(globalThis, name);

const stop = new AbortController();
let definition: PluginDefinition | undefined;
let language: Language = "en";
let messages: Catalog = {};

/** The plugin's `ctx`: every call goes to Reelix, except the signal, the log line and its own strings. */
function context(calls: string[]): PluginContext {
	const ctx: Record<string, any> = {};
	for (const path of calls) {
		const parts = path.replace(/^ctx\./, "").split(".");
		let holder = ctx;
		for (const part of parts.slice(0, -1)) holder = holder[part] ??= {};
		const name = parts.at(-1)!;
		if (path === "ctx.signal") holder[name] = stop.signal;
		else if (path === "ctx.log") holder[name] = (message: unknown) => channel.post(path, [String(message)]);
		else if (path === "ctx.t") holder[name] = (key: string, vars?: Record<string, unknown>) => messageFrom(messages, language, key, vars) ?? key;
		else if (path === "ctx.pi") holder[name] = async () => Promise.reject(new Error("a raw pi extension can only run inside Reelix's own process (docs/plugins.md §10.4)"));
		else holder[name] = (...args: unknown[]) => channel.call(path, args);
	}
	return ctx as PluginContext;
}

/**
 * The channel's stream, its fourth. Only this file holds it: Node's list of open handles is gone, so the
 * plugin cannot reach it or its class. Its end means Reelix went away, and so does the plugin.
 */
const wire = new Socket({ fd: 3, readable: true, writable: true });
for (const name of ["_getActiveHandles", "_getActiveRequests"]) Reflect.deleteProperty(process, name);
const channel = new Channel({
	send: (m) => void wire.write(frame(m)),
	coded: (e) => (e as { name?: unknown } | null)?.name === "ReelixError",
	revive: (w) => Object.assign(new Error(w.message), { name: "ReelixError", code: w.code, data: w.data }),
	exports: {
		async load(dir: string, entry: string) {
			definition = await loadPlugin(dir, entry);
			return { config: definition.config };
		},
		async activate(settings: unknown, calls: string[], catalog: Catalog, lang: Language) {
			messages = catalog;
			language = lang;
			await definition!.activate(context(calls), settings as never);
		},
		language(lang: Language) {
			language = lang;
		},
		stop() {
			stop.abort();
		},
	},
});
const reader = new FrameReader(Number.POSITIVE_INFINITY);
wire.on("data", (chunk: Buffer) => {
	for (const m of reader.push(chunk)) channel.receive(m);
});
wire.on("error", () => process.exit(0));
wire.on("close", () => process.exit(0));
