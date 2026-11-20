import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { kvGet, runOperation } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { ALLOWED_MODULES } from "../src/plugins/process.ts";

/**
 * A hostile plugin in a process of its own (docs/plugins.md §11.7): every way out that the review of phase 8
 * found, and the others found while closing them, is tried through the real `startProcess` and child, and
 * must be refused. Every file it tries to read is one this test made, never Reelix's real data.
 */

const REPO = join(import.meta.dirname, "../../..");

function pluginDir(root: string, id: string, source: string, files: Record<string, string> = {}): string {
	const dir = join(root, id);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `p-${id}`, version: "1.0.0", type: "module", reelix: { api: 0, id, entry: "./src/index.ts", runtime: "process", uses: { operations: { probe: "read", big: "read" } } } }));
	writeFileSync(join(dir, "src/index.ts"), source);
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	return dir;
}

/** Classes that open sockets, reach native handles, open databases or start code elsewhere. */
const DANGEROUS = ["Socket", "Server", "Pipe", "TCP", "TTY", "UDP", "ClientRequest", "Agent", "TLSSocket", "Http2Session", "DatabaseSync", "StatementSync", "Session", "Worker", "ChildProcess", "WASI", "Process", "Resolver", "ChannelWrap", "PipeConnectWrap", "TCPConnectWrap"];

const HOSTILE = `import { readFileSync, readdirSync, writeFileSync, symlinkSync, linkSync, openAsBlob } from "node:fs";
import { Type, definePlugin } from "@reelix/plugin";
import { helper } from "helper";

const attempt = async (fn) => {
	try {
		const v = await fn();
		return { done: true, detail: String(typeof v === "object" && v !== null ? Object.keys(v).slice(0, 5).join(",") || v.constructor?.name : v).slice(0, 80) };
	} catch (e) {
		return { done: false, detail: String(e?.code ?? "") + " " + String(e?.message ?? e).slice(0, 160) };
	}
};
const connect = (net, to) => new Promise((resolve, reject) => {
	const s = net.connect(to, () => { s.destroy(); resolve("connected"); });
	s.on("error", reject);
});
const CJS = typeof module !== "undefined" ? module : undefined;
const REQUIRE = typeof require !== "undefined" ? require : undefined;

/** Everything reachable from the roots, getters included: classes in DANGEROUS found on the way. */
function walk(roots, dangerous) {
	const seen = new Set();
	const found = [];
	const queue = Object.entries(roots).map(([k, v]) => [v, k]);
	while (queue.length && seen.size < 300000) {
		const [value, path] = queue.shift();
		if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) continue;
		seen.add(value);
		if (typeof value === "function" && dangerous.includes(value.name)) found.push(path + " is the class " + value.name);
		let keys = [];
		try { keys = Reflect.ownKeys(value); } catch {}
		for (const key of keys) {
			let child;
			try { child = value[key]; } catch { continue; }
			if (child instanceof Promise) child.catch(() => undefined);
			queue.push([child, path + "." + String(key)]);
		}
		try { queue.push([Object.getPrototypeOf(value), path + ".__proto__"]); } catch {}
	}
	return { found, objects: seen.size };
}

export default definePlugin({
	async activate(ctx) {
		await ctx.operation({
			name: "big", summary: "Sends a message larger than Reelix takes", effect: "read", input: Type.Object({}),
			async run() { return new Uint8Array(90 * 1024 * 1024); },
		});
		await ctx.operation({
			name: "probe", summary: "Tries what it should not", effect: "read",
			input: Type.Object({ root: Type.String(), outside: Type.String(), port: Type.Number(), repo: Type.String(), plugin: Type.String(), allowed: Type.Array(Type.String()), dangerous: Type.Array(Type.String()), reelix: Type.Number() }),
			async run({ root, outside, port, repo, plugin, allowed, dangerous, reelix }) {
				const own = await ctx.folder();
				// Inside Reelix only what harms nothing: reading the files this test made, and a socket.
				if (process.pid === reelix) {
					const r = {};
					for (const [k, fn] of Object.entries({
						secretsFile: () => readFileSync(root + "/secrets.yaml", "utf8"),
						database: () => readFileSync(root + "/reelix.db").length,
						ownerToken: () => readFileSync(root + "/owner.token", "utf8"),
						netImport: async () => connect(await import("node:net"), root + "/reelix.sock"),
						sqliteImport: async () => { const { DatabaseSync } = await import("node:sqlite"); return new DatabaseSync(root + "/reelix.db", { readOnly: true }).prepare("SELECT count(*) AS n FROM kv").get().n; },
					})) r[k] = await attempt(fn);
					return { r };
				}
				const M = CJS?.constructor;
				const r = {};
				const t = async (k, fn) => { r[k] = await attempt(fn); };
				// Files: Node's permission model.
				await t("secretsFile", () => readFileSync(root + "/secrets.yaml", "utf8"));
				await t("database", () => readFileSync(root + "/reelix.db").length);
				await t("ownerToken", () => readFileSync(root + "/owner.token", "utf8"));
				await t("listDataFolder", () => readdirSync(root).join(","));
				await t("writeDataFolder", () => writeFileSync(root + "/planted.txt", "x"));
				await t("writeElsewhere", () => writeFileSync(outside + "/planted.txt", "x"));
				await t("readElsewhere", () => readFileSync(outside + "/outside-secret.txt", "utf8"));
				await t("relativeToWorkingFolder", () => readFileSync("../../reelix.db").length);
				await t("throughWorkspaceLink", () => readFileSync(repo + "/node_modules/@reelix/core/../../README.md", "utf8"));
				await t("throughPluginPackage", () => readFileSync(plugin + "/../../README.md", "utf8"));
				await t("repoGit", () => readdirSync(repo + "/.git").join(","));
				await t("repoRoot", () => readdirSync(repo).join(","));
				await t("symlinkOut", () => { symlinkSync(outside, own + "/out"); return readFileSync(own + "/out/outside-secret.txt", "utf8"); });
				await t("hardLinkOut", () => { linkSync(outside + "/outside-secret.txt", own + "/hard"); return readFileSync(own + "/hard", "utf8"); });
				await t("loadEnvFile", () => { process.loadEnvFile(outside + "/outside-secret.txt"); return "loaded"; });
				await t("report", () => process.report.writeReport(outside + "/report.json"));
				await t("openAsBlob", async () => (await openAsBlob(outside + "/outside-secret.txt")).text());
				await t("chdir", () => { process.chdir(root); return process.cwd(); });
				await t("addon", () => process.dlopen({ exports: {} }, own + "/x.node"));
				await t("binding", () => process.binding("tcp_wrap"));
				await t("linkedBinding", () => process._linkedBinding("tcp_wrap"));
				// Programs, workers and signals.
				await t("childProcess", async () => (await import("node:child_process")).spawnSync("sh", ["-c", "id"]).stdout.toString());
				await t("execve", () => process.execve("/bin/sh", ["sh", "-c", "id"]));
				await t("worker", async () => new (await import("node:worker_threads")).Worker("1", { eval: true }));
				await t("signalParent", () => process.kill(process.ppid, 0));
				await t("debuggerOfParent", () => process.kill(process.ppid, "SIGUSR1"));
				await t("rawKillParent", () => process._kill(process.ppid, 0));
				await t("debugProcess", () => process._debugProcess(process.ppid));
				await t("signalGroup", () => process.kill(0, 0));
				await t("signalEveryone", () => process.kill(-1, 0));
				// Modules: Reelix's code in the process.
				await t("sqliteImport", async () => { const { DatabaseSync } = await import("node:sqlite"); return new DatabaseSync(root + "/reelix.db").prepare("SELECT count(*) AS n FROM kv").get().n; });
				await t("sqliteReexport", async () => { const { DatabaseSync } = await import("./reexport.mjs"); new DatabaseSync(root + "/reelix.db").exec("INSERT INTO kv (k, v) VALUES ('planted', '1')"); return "written"; });
				await t("sqliteBuiltin", () => process.getBuiltinModule("node:sqlite"));
				await t("ownHook", () => M.registerHooks({ resolve: (s, c, n) => (s === "x-net" ? { url: "node:net", shortCircuit: true, format: "builtin" } : n(s, c)) }));
				await t("ownHookAfterSync", () => { M.syncBuiltinESMExports(); return M.registerHooks({ resolve: (s, c, n) => n(s, c) }); });
				await t("ownAsyncHook", () => M.register("data:text/javascript,export async function resolve(s, c, n) { return n(s, c); }"));
				await t("moduleImport", async () => (await import("node:module")).registerHooks({ resolve: (s, c, n) => n(s, c) }));
				await t("moduleLoad", () => M._load("net"));
				await t("modulePrototypeRequire", () => M.prototype.require.call(CJS, "node:net"));
				await t("requireNet", () => REQUIRE("net"));
				await t("requireCacheSockets", () => Object.values(REQUIRE?.cache ?? {}).flatMap((m) => Object.values(m?.exports ?? {})).find((x) => typeof x === "function" && dangerous.includes(x.name)) ?? Promise.reject(new Error("none")));
				await t("netImport", async () => connect(await import("node:net"), root + "/reelix.sock"));
				await t("netBare", async () => connect(await import("net"), { host: "127.0.0.1", port }));
				await t("netQuery", async () => connect(await import("node:net?x=1"), { host: "127.0.0.1", port }));
				await t("netHash", async () => connect(await import("node:net#x"), { host: "127.0.0.1", port }));
				await t("netDataUrl", async () => connect(await import("data:text/javascript,export * from 'node:net'"), { host: "127.0.0.1", port }));
				await t("netBuiltin", async () => connect(process.getBuiltinModule("net"), { host: "127.0.0.1", port }));
				await t("netBuiltinQuery", () => process.getBuiltinModule("node:net?x"));
				// Reelix's checks in the process, with the built-ins they would use replaced.
				const polluted = async (fn) => {
					const saved = [Set.prototype.has, String.prototype.startsWith, Array.prototype.includes, Map.prototype.get];
					Set.prototype.has = () => true;
					String.prototype.startsWith = () => false;
					Array.prototype.includes = () => true;
					Map.prototype.get = () => "node:net";
					try { return await fn(); } finally { [Set.prototype.has, String.prototype.startsWith, Array.prototype.includes, Map.prototype.get] = saved; }
				};
				await t("pollutedBuiltin", () => polluted(() => connect(process.getBuiltinModule("node:net"), { host: "127.0.0.1", port })));
				await t("pollutedImport", () => polluted(async () => connect(await import("node:net"), { host: "127.0.0.1", port })));
				await t("pollutedRequire", () => polluted(() => REQUIRE("node:tls")));
				await t("pollutedSignal", () => polluted(() => { Object.defineProperty(process, "pid", { value: process.ppid, configurable: true }); return process.kill(process.ppid, 0); }));
				await t("httpClient", async () => { const { ClientRequest } = await import("_http_client"); return new Promise((resolve, reject) => new ClientRequest({ socketPath: root + "/reelix.sock", path: "/" }, resolve).on("error", reject).end()); });
				await t("httpClientBuiltin", () => process.getBuiltinModule("_http_client"));
				for (const m of ["http", "https", "http2", "tls", "dgram", "dns", "inspector", "tty", "cluster", "_http_agent", "_http_server", "_http_common", "_tls_wrap", "_tls_common", "_stream_wrap", "v8", "vm", "async_hooks", "diagnostics_channel", "trace_events", "wasi", "repl", "os", "module", "worker_threads", "child_process", "test"]) await t("import:" + m, () => import("node:" + m));
				await t("globalFetch", () => fetch("http://127.0.0.1:" + port + "/"));
				await t("globalWebSocket", () => new WebSocket("ws://127.0.0.1:" + port + "/"));
				await t("globalEventSource", () => new EventSource("http://127.0.0.1:" + port + "/"));
				await t("stdoutSocket", () => { const C = process.stdout.constructor; if (C.name === "Socket" || typeof C.prototype.connect === "function") return C.name; throw new Error("not a socket: " + C.name); });
				await t("stderrSocket", () => { const C = Object.getPrototypeOf(console._stderr ?? process.stderr).constructor; if (C.name === "Socket" || typeof C.prototype.connect === "function") return C.name; throw new Error("not a socket: " + C.name); });
				await t("activeHandles", () => process._getActiveHandles().map((h) => h.constructor.name).join(","));
				const roots = { globalThis, process, console, module: CJS, require: REQUIRE, ctx };
				for (const m of allowed) roots["node:" + m] = process.getBuiltinModule(m);
				const reach = walk(roots, dangerous);
				return { r, reached: reach.found, objects: reach.objects, cwd: process.cwd(), environment: Object.keys(process.env).sort().join(","), helper: helper(), ownFolder: (writeFileSync(own + "/note.txt", "mine"), readFileSync(own + "/note.txt", "utf8")) };
			},
		});
	},
});
`;

const FILES = {
	"src/reexport.mjs": `export * from "node:sqlite";\n`,
	"node_modules/helper/package.json": JSON.stringify({ name: "helper", version: "1.0.0", type: "module", main: "index.js" }),
	"node_modules/helper/index.js": `export const helper = () => "its own dependency loads";\n`,
};

type Probe = { r: Record<string, { done: boolean; detail: string }>; reached: string[]; objects: number; cwd: string; environment: string; helper: string; ownFolder: string };

test("a hostile plugin in its own process: every way out found is refused, its own folder and dependencies work", async () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-hostile-"));
	const outside = join(root, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "outside-secret.txt"), "OUTSIDE=made-by-the-test\n");
	const dir = pluginDir(root, "hostile", HOSTILE, FILES);
	const server = createServer((s) => s.on("error", () => undefined).end());
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	process.env.REELIX_TEST_SECRET_ENV = "must-not-leak";
	const t = await startPlugins([dir], { secrets: { "tmdb.api_key": "k-123" } });
	// Reelix's socket, as the plugin would find it: a listening Unix socket in the data folder.
	const socket = createServer((s) => s.on("error", () => undefined).end("reached Reelix's socket"));
	await new Promise<void>((r) => socket.listen(join(t.app.paths.root, "reelix.sock"), r));
	try {
		writeFileSync(t.app.paths.ownerToken, "owner-token-value");
		const input = { root: t.app.paths.root, outside, port, repo: REPO, plugin: join(REPO, "packages/plugin"), allowed: ALLOWED_MODULES, dangerous: DANGEROUS, reelix: process.pid };
		const probe = async () => (await runOperation(t.app, "hostile.probe", input, { actor: "owner:web" })).output as Probe;
		assert.equal(t.info("hostile").state, "active", t.info("hostile").error);
		assert.equal(t.info("hostile").runtime, "process");
		const isolated = await probe();
		const open = Object.entries(isolated.r).filter(([, v]) => v.done);
		assert.deepEqual(open, [], `ways out that were not refused: ${JSON.stringify(open)}`);
		assert.deepEqual(isolated.reached, [], "no class that opens sockets or handles is reachable");
		assert.ok(isolated.objects > 1000, `the walk saw ${isolated.objects} objects`);
		const permission = ["secretsFile", "database", "ownerToken", "listDataFolder", "writeDataFolder", "writeElsewhere", "readElsewhere", "relativeToWorkingFolder", "throughWorkspaceLink", "throughPluginPackage", "repoGit", "repoRoot", "symlinkOut", "hardLinkOut", "loadEnvFile", "report", "openAsBlob", "chdir", "binding", "execve"];
		for (const k of permission) assert.match(isolated.r[k]!.detail, /ERR_ACCESS_DENIED/, k);
		const reelix = ["sqliteImport", "sqliteReexport", "sqliteBuiltin", "netImport", "netBare", "netQuery", "netHash", "netDataUrl", "netBuiltin", "netBuiltinQuery", "httpClient", "httpClientBuiltin", "requireNet", "moduleLoad", "modulePrototypeRequire", "pollutedBuiltin", "pollutedImport", "pollutedRequire", "pollutedSignal", "childProcess", "worker", "ownHook", "ownHookAfterSync", "ownAsyncHook", "moduleImport", "signalParent", "debuggerOfParent", "rawKillParent", "debugProcess", "signalGroup", "signalEveryone"];
		for (const k of reelix) assert.match(isolated.r[k]!.detail, /not available to a plugin in its own process/, k);
		for (const m of ["http", "_http_agent", "_tls_wrap", "_stream_wrap", "tty", "v8", "module", "os"]) assert.match(isolated.r[`import:${m}`]!.detail, /not available to a plugin in its own process/, m);
		assert.equal(isolated.cwd, "/", "its working folder is not inside the data folder");
		assert.doesNotMatch(isolated.environment, /REELIX|SECRET/);
		assert.equal(isolated.helper, "its own dependency loads");
		assert.equal(isolated.ownFolder, "mine");
		// Nothing reached Reelix's database or the data folder.
		assert.equal(kvGet(t.app.db, "planted"), undefined);
		assert.ok(!readdirSync(t.app.paths.root).includes("planted.txt"));
		assert.ok(!readdirSync(outside).includes("planted.txt") && !readdirSync(outside).includes("report.json"));

		// The same plugin inside Reelix can do much of it: that is what the owner trusts it with there (§11.1).
		assert.equal((await t.manager.setRuntime("hostile", "in-process")).result, "applied");
		const inside = await probe();
		for (const k of ["secretsFile", "database", "ownerToken", "netImport", "sqliteImport"]) assert.equal(inside.r[k]!.done, true, `${k} inside Reelix: ${inside.r[k]!.detail}`);
	} finally {
		delete process.env.REELIX_TEST_SECRET_ENV;
		await t.close();
		server.close();
		socket.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a plugin's process that sends a message larger than the limit is ended before Reelix reads it", async () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-hostile-big-"));
	const dir = pluginDir(root, "hostile", HOSTILE, FILES);
	const t = await startPlugins([dir], { taskDelayMs: 60_000 });
	try {
		await assert.rejects(runOperation(t.app, "hostile.big", {}, { actor: "owner:web" }), (e: any) => e.code === "plugin_process_gone" && /more than the limit/.test(e.message));
		assert.match(t.info("hostile").error ?? "", /more than the limit/);
	} finally {
		await t.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a symbolic link out of a folder the process may read stops it from starting", async () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-hostile-link-"));
	const outside = join(root, "outside");
	mkdirSync(outside);
	const plain = `import { definePlugin } from "@reelix/plugin";\nexport default definePlugin({ async activate() {} });\n`;
	const linked = pluginDir(root, "linked", plain);
	symlinkSync(outside, join(linked, "src/escape"));
	const inner = pluginDir(root, "inner", plain);
	symlinkSync(join(inner, "src"), join(inner, "same-folder"));
	const t = await startPlugins([linked, inner]);
	try {
		assert.equal(t.info("linked").state, "failed");
		assert.match(t.info("linked").error!, /symbolic link to .*outside.*not started/);
		assert.equal(t.info("inner").state, "active", "a link that stays inside is fine");
	} finally {
		await t.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("every way Reelix starts closes SIGUSR1, so no process of its user can open Node's debugger in it", () => {
	const read = (f: string) => readFileSync(join(REPO, f), "utf8");
	assert.match(read("Dockerfile"), /^CMD \["node", "--no-warnings", "--disable-sigusr1", "packages\/server\/src\/main\.ts"\]$/m);
	assert.match(read("bin/reelix"), /^exec node --no-warnings --disable-sigusr1 /m, "reelix serve and reelix plugin dev");
	const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
	for (const s of ["reelix", "server"]) assert.match(scripts[s]!, /^node --disable-sigusr1 /, s);
	assert.match(read("scripts/demo.ts"), /node --no-warnings --disable-sigusr1 scripts\/demo\.ts/);
	assert.match(read("packages/server/src/main.ts"), /process\.on\("SIGUSR1", \(\) => undefined\)/, "a start by hand without the flag");
	assert.doesNotMatch(read("docker-compose.example.yml"), /^\s*(command|entrypoint):/m, "compose keeps the image's command");
	assert.match(read(".dockerignore"), /^\.git$/m);
});
