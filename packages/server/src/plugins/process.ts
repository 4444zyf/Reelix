import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PluginContext, PluginDefinition } from "@reelix/plugin";
import { type Catalog, type Language, ReelixError } from "@reelix/core";
import { ISOLATION, pluginCommand, pluginFolderAccess } from "../isolation.ts";
import { Channel, FrameReader, frame } from "./channel.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "../..");
const CORE = join(here, "../../../core");
const CHILD = join(here, "child.ts");

/**
 * Node's own modules the plugin may load in its process; every other one is refused (docs/plugins.md §11.7).
 * None of these opens a socket, reaches a native handle, starts code elsewhere or opens files past
 * Node's permission model; the network is `ctx.http.fetch` (§11.4).
 */
export const ALLOWED_MODULES = [
	"assert",
	"assert/strict",
	"buffer",
	"console",
	"crypto",
	"events",
	"fs",
	"fs/promises",
	"path",
	"path/posix",
	"path/win32",
	"perf_hooks",
	"process",
	"querystring",
	"stream",
	"stream/consumers",
	"stream/promises",
	"stream/web",
	"string_decoder",
	"timers",
	"timers/promises",
	"url",
	"util",
	"util/types",
	"zlib",
];

/** The environment the process gets: nothing of Reelix's (no keys, no data folder, no proxy). */
const ENVIRONMENT = ["TZ", "LANG", "LC_ALL"];

/** How long the process has to end after it was asked to, before it is killed. */
const KILL_AFTER_MS = 2_000;

/** The largest message the process may send: room for a 64 MB download a route answers with. */
const MESSAGE_LIMIT = 80 * 1024 * 1024;

/** A line it prints longer than this is cut. */
const LINE_LIMIT = 16 * 1024;

/** The folder of the package `name` that holds `file`. */
function packageFolder(name: string, file: string): string {
	for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
		const pkg = join(dir, "package.json");
		if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === name) return dir;
	}
	throw new Error(`the package ${name} was not found above ${file}`);
}

/** Reelix's own packages the process loads, by the name it imports them with: their entry file, and their folder. */
function packages(): Record<string, { file: string; folder: string }> {
	const plugin = realpathSync(fileURLToPath(import.meta.resolve("@reelix/plugin")));
	const jiti = realpathSync(fileURLToPath(import.meta.resolve("jiti")));
	const typebox = realpathSync(createRequire(plugin).resolve("typebox"));
	return {
		"@reelix/plugin": { file: plugin, folder: packageFolder("@reelix/plugin", plugin) },
		jiti: { file: jiti, folder: packageFolder("jiti", jiti) },
		typebox: { file: typebox, folder: packageFolder("typebox", typebox) },
	};
}

const inside = (root: string, p: string) => p === root || p.startsWith(root + sep);

/**
 * A granted folder must not hold a symbolic link that leads out of it: Node checks the path as written,
 * the system follows the link, so `<link>/../..` would reach anything (docs/plugins.md §11.7).
 */
function refuseLinksOut(root: string): void {
	const walk = (dir: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isSymbolicLink()) {
				let target = resolve(dir, readlinkSync(p));
				try {
					target = realpathSync(p);
				} catch {
					/* a link to nothing yet: where it says is where it would lead */
				}
				if (!inside(root, target)) throw new Error(`${p} is a symbolic link to ${target}, outside ${root}; the plugin's process is not started, since it could read through it`);
			} else if (e.isDirectory()) walk(p);
		}
	};
	walk(root);
}

/** The folders and files the process may read, and the one it may write, as real paths (docs/plugins.md §11.7). */
function processGrants(dir: string, dataDir: string): { read: string[]; write: string } {
	const own = realpathSync(dir);
	const data = realpathSync(dataDir);
	const modules = existsSync(join(own, "node_modules")) ? realpathSync(join(own, "node_modules")) : undefined;
	const folders = [own, ...(modules && !inside(own, modules) ? [modules] : []), data, ...Object.values(packages()).map((p) => p.folder)];
	for (const f of folders) refuseLinksOut(f);
	const files = [CHILD, join(here, "channel.ts"), join(here, "loader.ts"), join(SERVER, "package.json"), join(CORE, "src/messages.ts"), join(CORE, "package.json")].map((f) => realpathSync(f));
	return { read: [...new Set([...folders, ...files])], write: data };
}

/** The node flags the process runs with (docs/plugins.md §11.7). */
function processFlags(grants: { read: string[]; write: string }): string[] {
	return ["--permission", ...grants.read.map((p) => `--allow-fs-read=${p}`), `--allow-fs-write=${grants.write}`, "--disable-warning=ExperimentalWarning", "--disable-sigusr1"];
}

export type PluginProcess = PluginDefinition & {
	/** Ask it to stop; it is killed if it does not. */
	kill(): void;
	/** The owner's language changed: `ctx.t` follows. */
	language(lang: Language): void;
};

type ProcessOptions = {
	id: string;
	dir: string;
	entry: string;
	/** Its own folder (`<data>/plugin-data/<id>`): the only one it may write. */
	dataDir: string;
	messages: Catalog;
	language: Language;
	/** The context calls the plugin's `ctx` has (CONTEXT_CALLS). */
	calls: string[];
	/** A line it printed. */
	output(line: string): void;
	/** It ended without being asked to. */
	crashed(error: Error): void;
};

/**
 * Start a plugin in a process of its own. The result is used like the plugin's definition: `config` is its
 * settings schema, and `activate` hands it the context, whose calls then come over the channel: framed
 * messages on the process's fourth stream, never Node's IPC, so their size is checked before they are read.
 */
export async function startProcess(o: ProcessOptions): Promise<PluginProcess> {
	mkdirSync(o.dataDir, { recursive: true });
	if (ISOLATION) pluginFolderAccess(o.dataDir, ISOLATION, true);
	const grants = processGrants(o.dir, o.dataDir);
	const env = Object.fromEntries(ENVIRONMENT.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
	const setup = { allowed: ALLOWED_MODULES, packages: Object.fromEntries(Object.entries(packages()).map(([name, p]) => [name, pathToFileURL(p.file).href])) };
	// Its working folder is the root: a relative path names nothing of Reelix's. In the image it runs as the plugins' user (§11.3).
	const [command, ...args] = [...(ISOLATION ? pluginCommand(ISOLATION) : []), process.execPath, ...processFlags(grants), CHILD, JSON.stringify(setup)];
	const child: ChildProcess = spawn(command!, args, { cwd: "/", env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
	const pipe = child.stdio[3] as Socket;
	let asked = false;
	let open = true;
	let refusal: string | undefined;
	const recent: string[] = [];
	const lines = (stream: NodeJS.ReadableStream | null, keep: boolean) => {
		let rest = "";
		stream?.setEncoding("utf8");
		stream?.on("data", (chunk: string) => {
			const parts = (rest + chunk).split("\n");
			rest = parts.pop()!.slice(0, LINE_LIMIT);
			for (const part of parts) {
				const line = part.slice(0, LINE_LIMIT);
				if (!line.trim()) continue;
				o.output(line);
				if (keep && recent.push(line) > 5) recent.shift();
			}
		});
	};
	lines(child.stdout, false);
	lines(child.stderr, true);
	const handles = [child.stdout as Socket | null, child.stderr as Socket | null, pipe];
	const channel = new Channel({
		send: (m) => {
			if (!open) throw new ReelixError("plugin_process_gone", `the process of ${o.id} has ended`);
			pipe.write(frame(m));
		},
		coded: (e) => e instanceof ReelixError,
		// The process keeps Reelix running only while Reelix waits for it.
		waiting: (count) => {
			if (count) child.ref();
			else child.unref();
			for (const h of handles) {
				if (count) h?.ref();
				else h?.unref();
			}
		},
		revive: (w) => new ReelixError(w.code ?? "plugin_error", w.message, w.data),
	});
	child.unref();
	for (const h of handles) h?.unref();
	const reader = new FrameReader(MESSAGE_LIMIT);
	pipe.on("data", (chunk: Buffer) => {
		if (refusal) return;
		let messages: unknown[];
		try {
			messages = reader.push(chunk);
		} catch (e) {
			refusal = (e as Error).message;
			child.kill("SIGKILL");
			return;
		}
		for (const m of messages) channel.receive(m);
	});
	pipe.on("error", () => undefined);
	child.on("error", (e) => o.output(`the process could not run: ${e.message}`));
	child.on("exit", (code, signal) => {
		open = false;
		const why = refusal ?? (signal ? `it was ended by ${signal}` : `exit code ${code}`);
		const error = new ReelixError("plugin_process_gone", `the plugin's process ended (${why})${!refusal && recent.length ? `: ${recent.at(-1)}` : ""}`);
		channel.close(error);
		if (!asked) o.crashed(error);
	});
	const kill = () => {
		if (asked) return;
		asked = true;
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), KILL_AFTER_MS).unref();
	};
	try {
		const { config } = (await channel.call("load", [o.dir, o.entry])) as { config?: PluginDefinition["config"] };
		const started: PluginProcess = {
			config,
			async activate(ctx: PluginContext, settings: unknown) {
				const exported: Record<string, (...args: any[]) => unknown> = {};
				for (const path of o.calls) {
					const parts = path.replace(/^ctx\./, "").split(".");
					const holder = parts.slice(0, -1).reduce<any>((h, part) => h?.[part], ctx);
					const fn = holder?.[parts.at(-1)!];
					if (typeof fn === "function") exported[path] = fn.bind(holder);
				}
				channel.expose(exported);
				// Its signal is its own; Reelix says when the plugin stops.
				ctx.signal.addEventListener("abort", () => channel.post("stop", []), { once: true });
				await channel.call("activate", [settings, o.calls, o.messages, o.language]);
			},
			kill,
			language: (lang) => channel.post("language", [lang]),
		};
		return started;
	} catch (e) {
		kill();
		throw e;
	}
}
