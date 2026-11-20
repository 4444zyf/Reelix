import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Type } from "typebox";
import { LANGUAGES, LOCALE_TAGS, Reelix, changedPaths, fetchTitle, kvGet, kvSet, listInbox, runOperation } from "@reelix/core";
import { startFakeTmdb } from "../../core/test/fakes/tmdb.ts";
import { insertTitle, tempApp } from "../../core/test/helpers.ts";
import { socketApp } from "../src/http.ts";
import { JobRunner } from "../src/jobs.ts";
import { PluginManager } from "../src/plugins/manager.ts";
import { Scope } from "../src/plugins/scope.ts";
import { SocketTokens } from "../src/socket-tokens.ts";

const REPO = resolve(import.meta.dirname, "../../..");

function addTestOperations(app: Reelix): void {
	app.operations.add({ name: "testadmin.owner", summary: "admin", effect: "admin", input: Type.Object({}), run: async () => "ran" });
	app.operations.add({ name: "testadmin.shared", summary: "admin for the agent too", effect: "admin", agentMay: true, input: Type.Object({}), run: async () => "ran" });
	app.operations.add({ name: "testadmin.remove", summary: "destructive", effect: "destructive", input: Type.Object({}), run: async () => "ran" });
}

async function until(what: string, ok: () => boolean): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (ok()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.fail(`timed out waiting for: ${what}`);
}

/** A plugin folder outside the repository, the way an installed one would be. */
function writePlugin(root: string, folder: string, reelix: Record<string, unknown>, source: string): string {
	const dir = join(root, folder);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `reelix-plugin-${folder}`, version: "1.2.3", type: "module", reelix: { api: 0, id: folder, entry: "./src/index.ts", runtime: "in-process", ...reelix } }));
	writeFileSync(join(dir, "src/index.ts"), source);
	return dir;
}

function setup() {
	const { app, root } = tempApp();
	addTestOperations(app);
	const pluginsDir = mkdtempSync(join(tmpdir(), "reelix-plugins-"));
	const jobs = new JobRunner(app, {} as never);
	const manager = (dirs = [pluginsDir]) => {
		const m = new PluginManager({ app, jobs, host: { globalListeners: new Set() } as never, dirs, stopGraceMs: 50 });
		app.plugins = m;
		return m;
	};
	const runState = (id: string) => ({ ...(app.db.prepare("SELECT state, summary, kind FROM job_runs WHERE id = ?").get(id) as { state: string; summary: string | null; kind: string }) });
	const finished = (id: string) => until(`job ${id} to finish`, () => !["queued", "running"].includes(runState(id).state));
	const done = async () => {
		await new Promise((r) => setTimeout(r, 20)); // the runner's last turn
		app.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(pluginsDir, { recursive: true, force: true });
	};
	return { app, jobs, pluginsDir, manager, runState, finished, done };
}

const info = (m: PluginManager, id: string) => m.list().find((p) => p.id === id)!;

const WORKING = `
import { definePlugin } from "@reelix/plugin";
export default definePlugin({
	async activate(ctx) {
		await ctx.job({ name: "work", run: async (run) => ({ state: "succeeded", summary: "got " + run.payload.n + " dedupe=" + ("dedupe" in run.payload) }) });
		await ctx.on("config.changed", async ({ paths }) => { await ctx.kv.set("changed", paths); });
		await ctx.kv.set("hello", { a: 1 });
	},
});`;
const WORKING_USES = { uses: { jobs: ["work"], events: ["config.changed"] } };

test("a TypeScript plugin outside the repository loads with its own node_modules and Reelix's @reelix/plugin", async () => {
	const s = setup();
	try {
		const dir = writePlugin(
			s.pluginsDir,
			"sample",
			{ uses: { jobs: ["work"] }, somethingFromTheFuture: true },
			`import { definePlugin, Type } from "@reelix/plugin";
			import pad from "own-dep";
			import { helper } from "./helper.ts";
			export default definePlugin({
				async activate(ctx) {
					await ctx.kv.set("result", { dep: pad("x"), helper, schema: Type.String().type, text: ctx.t("hi", { name: "Ann" }) });
				},
			});`,
		);
		writeFileSync(join(dir, "src/helper.ts"), `export const helper: string = "typed";`);
		mkdirSync(join(dir, "locales"));
		writeFileSync(join(dir, "locales/en.json"), JSON.stringify({ hi: "Hello {{name}}" }));
		// A copy of the SDK in the plugin's own node_modules must lose to Reelix's.
		for (const [name, code] of [["own-dep", `export default (s) => "<" + s + ">";`], ["@reelix/plugin", `throw new Error("the plugin's own copy was loaded");`]] as const) {
			mkdirSync(join(dir, "node_modules", name), { recursive: true });
			writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./index.js" }));
			writeFileSync(join(dir, "node_modules", name, "index.js"), code);
		}
		const m = s.manager();
		await m.start();
		assert.equal(info(m, "sample").state, "active", info(m, "sample").error);
		assert.equal(info(m, "sample").version, "1.2.3");
		assert.deepEqual(JSON.parse(kvGet(s.app.db, "plugin:sample:result")!), { dep: "<x>", helper: "typed", schema: "string", text: "Hello Ann" });
		await m.stop();
	} finally {
		await s.done();
	}
});

test("refused: bad ids, a core operation's word, wrong api or runtime, extra exports, undeclared use", async () => {
	const s = setup();
	try {
		const ok = `import { definePlugin } from "@reelix/plugin"; export default definePlugin({ activate() {} });`;
		writePlugin(s.pluginsDir, "bad-id", { id: "Bad_Id" }, ok);
		writePlugin(s.pluginsDir, "core-word", { id: "title" }, ok);
		writePlugin(s.pluginsDir, "new-api", { api: 1 }, ok);
		writePlugin(s.pluginsDir, "other-runtime", { runtime: "mcp" }, ok);
		writePlugin(s.pluginsDir, "two-exports", {}, `${ok}\nexport const extra = 1;`);
		writePlugin(s.pluginsDir, "not-defined", {}, `export default { activate() {} };`);
		writePlugin(s.pluginsDir, "escapes", { entry: "../other/index.ts" }, ok);
		writePlugin(s.pluginsDir, "runs-undeclared", {}, `import { definePlugin } from "@reelix/plugin"; export default definePlugin({ async activate(ctx) { await ctx.reelix.run("title.refresh_metadata", {}); } });`);
		writePlugin(s.pluginsDir, "job-undeclared", {}, `import { definePlugin } from "@reelix/plugin"; export default definePlugin({ async activate(ctx) { await ctx.job({ name: "x", run: async () => ({ state: "succeeded", summary: "" }) }); } });`);
		writePlugin(s.pluginsDir, "event-undeclared", {}, `import { definePlugin } from "@reelix/plugin"; export default definePlugin({ async activate(ctx) { await ctx.on("config.changed", () => {}); } });`);
		writePlugin(s.pluginsDir, "runs-admin", { uses: { runs: ["testadmin.owner"] } }, `import { definePlugin } from "@reelix/plugin"; export default definePlugin({ async activate(ctx) { await ctx.reelix.run("testadmin.owner", {}); } });`);
		writePlugin(s.pluginsDir, "throws", {}, `import { definePlugin } from "@reelix/plugin"; export default definePlugin({ activate() { throw new Error("boom in activate"); } });`);
		writePlugin(s.pluginsDir, "fine", {}, ok);
		mkdirSync(join(s.pluginsDir, "examples/ignored"), { recursive: true });
		const m = s.manager();
		await m.start();
		const expected: Record<string, RegExp> = {
			"bad-id": /not a valid plugin id/,
			"core-word": /Reelix's own operations/,
			"new-api": /plugin API 1/,
			"other-runtime": /runtime "mcp" is not supported/,
			"two-exports": /exactly one export.*default, extra|exactly one export.*extra, default/,
			"not-defined": /definePlugin/,
			escapes: /inside the plugin's folder/,
			"runs-undeclared": /not declared in reelix\.uses\.runs/,
			"job-undeclared": /not declared in reelix\.uses\.jobs/,
			"event-undeclared": /not declared in reelix\.uses\.events/,
			"runs-admin": /plugins can never run it/,
			throws: /boom in activate/,
		};
		for (const [id, error] of Object.entries(expected)) {
			assert.equal(info(m, id).state, "failed", id);
			assert.match(info(m, id).error!, error, id);
		}
		assert.equal(info(m, "fine").state, "active", "one bad plugin does not stop the others");
		assert.equal(info(m, "examples"), undefined, "plugins/examples is not loaded");
		await m.stop();
	} finally {
		await s.done();
	}
});

test("scope: undo runs newest first, errors are contained, registering is refused while stopping, running calls get their time", async () => {
	const scope = new Scope();
	const order: string[] = [];
	let refused = false;
	scope.add(() => void order.push("first"));
	scope.add(() => {
		order.push("second");
		throw new Error("undo failed");
	});
	scope.add(async () => {
		await new Promise((r) => setTimeout(r, 5));
		order.push("third");
		try {
			scope.add(() => undefined);
		} catch {
			refused = true;
		}
	});
	let finishCall!: () => void;
	const call = scope.track(() => new Promise<void>((r) => (finishCall = r)).then(() => void order.push("call ended")));
	const errors: unknown[] = [];
	const disposing = scope.dispose(5_000, (e) => errors.push(e));
	await assert.rejects(scope.track(() => 1), /stopped/, "no new calls while stopping");
	assert.deepEqual(order, [], "undo waits for the running call");
	finishCall();
	await Promise.all([call, disposing]);
	assert.deepEqual(order, ["call ended", "third", "second", "first"]);
	assert.equal(errors.length, 1);
	assert.ok(refused);

	const stuck = new Scope();
	const undone: string[] = [];
	stuck.add(() => void undone.push("undone"));
	void stuck.track(() => new Promise(() => undefined));
	await stuck.dispose(20, () => undefined);
	assert.deepEqual(undone, ["undone"], "a call that never ends does not block stopping");
});

test("switching off and on is live: job and listener are undone, the state survives a restart", async () => {
	const s = setup();
	try {
		writePlugin(s.pluginsDir, "sample", WORKING_USES, WORKING);
		let m = s.manager();
		await m.start();
		assert.deepEqual(JSON.parse(kvGet(s.app.db, "plugin:sample:hello")!), { a: 1 }, "the store is namespaced by plugin");
		assert.ok(s.jobs.handlers.has("sample.work"));
		s.app.setConfig("limits.trash_days", 9);
		await until("the listener", () => kvGet(s.app.db, "plugin:sample:changed") === '["limits.trash_days"]');
		const first = s.jobs.enqueue("sample.work", { n: 1 }, { dedupe: "d" });
		await s.finished(first);
		assert.deepEqual(s.runState(first), { state: "succeeded", summary: "got 1 dedupe=false", kind: "sample.work" });

		const off = (await runOperation(s.app, "plugin.disable", { id: "sample" }, { actor: "owner:web" })).output as any;
		assert.equal(off.result, "applied");
		assert.equal(off.state, "disabled");
		assert.ok(off.next);
		assert.equal(s.jobs.handlers.has("sample.work"), false, "a stopped plugin's job is unregistered");
		assert.equal(s.app.pluginEvents.listenerCount("config.changed"), 1, "and its listener removed (the manager's own stays)");

		await m.stop();
		m = s.manager();
		await m.start();
		assert.equal(info(m, "sample").state, "disabled", "still off after a restart");
		assert.equal(s.jobs.handlers.has("sample.work"), false);

		const on = (await runOperation(s.app, "plugin.enable", { id: "sample" }, { actor: "owner:cli" })).output as any;
		assert.deepEqual([on.result, on.state], ["applied", "active"]);
		assert.ok(s.jobs.handlers.has("sample.work"));
		await m.stop();
	} finally {
		await s.done();
	}
});

test("a plugin that fails to switch on reports failed with what to do next", async () => {
	const s = setup();
	try {
		const dir = writePlugin(s.pluginsDir, "sample", {}, `import { definePlugin } from "@reelix/plugin"; export default definePlugin({ activate() { throw new Error("not yet"); } });`);
		const m = s.manager();
		await m.start();
		const r = await m.enable("sample");
		assert.deepEqual([r.result, r.state], ["failed", "failed"]);
		assert.ok(r.next);
		writeFileSync(join(dir, "src/index.ts"), `import { definePlugin } from "@reelix/plugin"; export default definePlugin({ activate() {} });`);
		assert.equal((await m.enable("sample")).result, "applied", "switching on again reads the fixed code");
		await assert.rejects(m.enable("nothing"), /no plugin "nothing"/);
		await m.stop();
	} finally {
		await s.done();
	}
});

test("five throws of one registration switch the plugin off with an Inbox notice naming it", async () => {
	const s = setup();
	try {
		writePlugin(
			s.pluginsDir,
			"flaky",
			{ uses: { jobs: ["bad", "soft"] } },
			`import { definePlugin } from "@reelix/plugin";
			export default definePlugin({ async activate(ctx) {
				await ctx.job({ name: "bad", run: async () => { throw new Error("it broke"); } });
				await ctx.job({ name: "soft", run: async () => ({ state: "failed", summary: "a site said no" }) });
			} });`,
		);
		const m = s.manager();
		await m.start();
		for (let i = 0; i < 6; i++) {
			const id = s.jobs.enqueue("flaky.soft", {});
			await s.finished(id);
			assert.equal(s.runState(id).state, "failed");
		}
		assert.equal(info(m, "flaky").failures, 0, "a reported failure is not a broken plugin");
		for (let i = 0; i < 4; i++) {
			const id = s.jobs.enqueue("flaky.bad", {});
			await s.finished(id);
			assert.match(s.runState(id).summary!, /it broke/);
		}
		assert.equal(info(m, "flaky").state, "active");
		assert.equal(info(m, "flaky").failures, 4);
		await s.finished(s.jobs.enqueue("flaky.bad", {}));
		await until("the switch-off", () => info(m, "flaky").state === "disabled");
		await until("the notice", () => listInbox(s.app).length === 1);
		const notice = listInbox(s.app)[0]!;
		assert.match(notice.title, /flaky/);
		assert.match(notice.body ?? "", /job bad/);
		assert.match(notice.body ?? "", /it broke/);
		assert.equal(s.jobs.handlers.has("flaky.bad"), false);
		assert.match(info(m, "flaky").error!, /job bad/);

		assert.equal((await m.enable("flaky")).result, "applied", "the owner can switch it back on");
		assert.equal(info(m, "flaky").failures, 0);
		await m.stop();
	} finally {
		await s.done();
	}
});

test("queued runs of a plugin that is switched off do not run", async () => {
	const s = setup();
	try {
		writePlugin(s.pluginsDir, "sample", { uses: { jobs: ["work"] } }, `import { definePlugin } from "@reelix/plugin"; export default definePlugin({ async activate(ctx) { await ctx.job({ name: "work", run: async () => { await ctx.kv.set("ran", true); return { state: "succeeded", summary: "" }; } }); } });`);
		const m = s.manager();
		await m.start();
		const id = s.jobs.enqueue("sample.work", {});
		await m.disable("sample"); // before the runner's next turn
		await s.jobs.tick();
		assert.equal(s.runState(id).state, "interrupted");
		assert.equal(kvGet(s.app.db, "plugin:sample:ran"), undefined);
		await m.stop();
	} finally {
		await s.done();
	}
});

test("metadata-refresh: a language change re-reads titles through the operation and reports counts and failures", async () => {
	const s = setup();
	const tmdb = await startFakeTmdb();
	try {
		s.app.setConfig("tmdb.base_url", tmdb.url);
		s.app.setSecret("tmdb.api_key", tmdb.apiKey);
		s.app.setConfig("language", "en");
		await fetchTitle(s.app, "movie", 45745);
		kvSet(s.app.db, "plugin:metadata-refresh:locale", '"en-US"');
		const m = s.manager([join(REPO, "plugins")]);
		await m.start();
		assert.equal(info(m, "metadata-refresh").state, "active", info(m, "metadata-refresh").error);
		const runs = () => s.app.db.prepare("SELECT id, kind FROM job_runs ORDER BY created_at, rowid").all() as { id: string; kind: string }[];
		assert.equal(runs().length, 0, "nothing to do while the language is the one already read");

		s.app.setConfig("limits.trash_days", 9);
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(runs().length, 0, "other settings do not start a refresh");

		s.app.setConfig("language", "zh");
		await until("the job", () => runs().length === 1);
		assert.equal(runs()[0]!.kind, "metadata-refresh.refresh");
		await s.finished(runs()[0]!.id);
		assert.deepEqual([s.runState(runs()[0]!.id).state, s.runState(runs()[0]!.id).summary], ["succeeded", "已用 zh-CN 重新读取 1 部作品。"]);
		assert.equal(kvGet(s.app.db, "plugin:metadata-refresh:locale"), '"zh-CN"');
		assert.equal((s.app.db.prepare("SELECT name FROM titles WHERE id = 'movie:45745'").get() as any).name, "辛特尔");
		const ledger = s.app.db.prepare("SELECT actor, status FROM actions WHERE op = 'title.refresh_metadata'").all() as any[];
		assert.deepEqual(ledger.map((r) => ({ ...r })), [{ actor: "plugin:metadata-refresh", status: "succeeded" }]);

		// One title TMDB does not know: still a success, with the failure in the summary.
		insertTitle(s.app, { id: "movie:999999", kind: "movie", tmdb_id: 999999, name: "Gone" });
		s.app.setConfig("language", "en");
		await until("the second job", () => runs().length === 2);
		await s.finished(runs()[1]!.id);
		assert.deepEqual([s.runState(runs()[1]!.id).state, s.runState(runs()[1]!.id).summary], ["succeeded", "1 title re-read in en-US. 1 failed."]);

		// Nothing could be re-read: the job failed, as before.
		s.app.db.prepare("DELETE FROM titles WHERE id = 'movie:45745'").run();
		s.app.setConfig("language", "fr");
		await until("the third job", () => runs().length === 3);
		await s.finished(runs()[2]!.id);
		assert.deepEqual([s.runState(runs()[2]!.id).state, s.runState(runs()[2]!.id).summary], ["failed", "0 titre relu en fr-FR. 1 échec."]);
		await m.stop();
	} finally {
		await tmdb.close();
		await s.done();
	}
});

test("metadata-refresh: with nothing to re-read it only remembers the language", async () => {
	const s = setup();
	try {
		const jobCount = () => (s.app.db.prepare("SELECT COUNT(*) n FROM job_runs").get() as { n: number }).n;
		const m = s.manager([join(REPO, "plugins")]);
		await m.start();
		assert.equal(kvGet(s.app.db, "plugin:metadata-refresh:locale"), '"en-US"', "no titles");
		insertTitle(s.app, { id: "movie:1", kind: "movie", tmdb_id: 1, name: "One" });
		s.app.setConfig("language", "ru");
		await until("the language to be remembered", () => kvGet(s.app.db, "plugin:metadata-refresh:locale") === '"ru-RU"');
		assert.equal(jobCount(), 0, "titles but no TMDB key");
		await m.disable("metadata-refresh");
		s.app.setConfig("tmdb.base_url", "http://127.0.0.1:9");
		s.app.setSecret("tmdb.api_key", "key");
		s.app.setConfig("language", "fr");
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(jobCount(), 0, "switched off: no reaction");
		await m.enable("metadata-refresh");
		assert.equal(jobCount(), 1, "switched on again: it catches up");
		await m.disable("metadata-refresh");
		await m.stop();
	} finally {
		await s.done();
	}
});

test("metadata-refresh: the stored language moves once from the core store to the plugin's", () => {
	const { app, root } = tempApp();
	const data = app.paths.root;
	app.close();
	const db = new DatabaseSync(join(data, "reelix.db"));
	db.exec("ALTER TABLE inbox ADD COLUMN telegram_message_id INTEGER; DROP TABLE notice_deliveries; DROP TABLE chat_channels; DROP TABLE reasons; DROP TABLE proposals; DROP TABLE trial_results; ALTER TABLE downloads DROP COLUMN downloader; ALTER TABLE titles DROP COLUMN ratings_json; ALTER TABLE titles ADD COLUMN douban_rating REAL; UPDATE schema_version SET v = 2; DELETE FROM kv WHERE k LIKE 'plugin:%'; DROP TABLE approvals; DROP TABLE provider_outcomes; CREATE TABLE site_state (site TEXT PRIMARY KEY, state_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL)");
	db.prepare("INSERT INTO kv (k, v) VALUES ('metadata.locale', 'zh-CN')").run();
	db.prepare("INSERT INTO job_runs (id, kind, payload_json, state, created_at) VALUES ('old', 'metadata_refresh', '{}', 'queued', 'now')").run();
	db.close();
	const again = new Reelix(data);
	try {
		assert.equal(kvGet(again.db, "metadata.locale"), undefined);
		assert.equal(kvGet(again.db, "plugin:metadata-refresh:locale"), '"zh-CN"');
		assert.equal((again.db.prepare("SELECT state FROM job_runs WHERE id = 'old'").get() as any).state, "interrupted");
	} finally {
		again.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("metadata-refresh: every language has every string and plural form", () => {
	const read = (l: string) => JSON.parse(readFileSync(join(REPO, "plugins/metadata-refresh/locales", `${l}.json`), "utf8")) as Record<string, string>;
	const bases = new Set(Object.keys(read("en")).map((k) => k.replace(/_(one|other)$/, "")));
	for (const l of LANGUAGES) {
		const messages = read(l);
		for (const base of bases) {
			if (base === "refreshed" || base === "failed") for (const form of new Intl.PluralRules(LOCALE_TAGS[l]).resolvedOptions().pluralCategories) assert.ok(messages[`${base}_${form}`], `${l}: ${base}_${form}`);
			else assert.ok(messages[base], `${l}: ${base}`);
		}
	}
});

test("config.changed names the settings that really changed", async () => {
	assert.deepEqual(changedPaths({ a: { b: 1, c: [1] }, d: 1 }, { a: { b: 2, c: [1] }, e: 1 }), ["a.b", "d", "e"]);
	const { app } = tempApp();
	try {
		const seen: string[][] = [];
		app.pluginEvents.on("config.changed", ({ paths }) => seen.push(paths));
		app.setConfig("limits.trash_days", 11);
		app.setConfig("limits.trash_days", 11);
		assert.deepEqual(seen, [["limits.trash_days"]]);
	} finally {
		app.close();
	}
});

test("admin: the owner always, the agent and jobs only with agentMay, plugins never", async () => {
	const { app } = tempApp();
	addTestOperations(app);
	try {
		const run = (op: string, actor: string) => runOperation(app, op, {}, { actor });
		for (const actor of ["owner:web", "owner:cli", "owner:telegram"]) assert.equal((await run("testadmin.owner", actor)).output, "ran");
		for (const actor of ["agent:t1", "agent:cli", "agent:socket", "job:1", "system"]) {
			await assert.rejects(run("testadmin.owner", actor), (e: any) => e.code === "owner_only" && /real terminal/.test(e.message), actor);
			assert.equal((await run("testadmin.shared", actor)).output, "ran", actor);
		}
		await assert.rejects(run("testadmin.owner", "plugin:x"), (e: any) => e.code === "owner_only");
		await assert.rejects(run("testadmin.shared", "plugin:x"), (e: any) => e.code === "owner_only", "agentMay does not reach plugins");
		await assert.rejects(run("testadmin.remove", "plugin:x"), (e: any) => e.code === "approval_required");
		assert.equal((await run("testadmin.remove", "agent:t1")).output, "ran", "the agent is unchanged for destructive operations");

		const refused = async (op: string, input: unknown) => assert.rejects(runOperation(app, op, input, { actor: "agent:t1" }), (e: any) => e.code === "owner_only", op);
		await refused("secret.set", { key: "x.y", value: "v" });
		await refused("plugin.enable", { id: "x" });
		await refused("plugin.disable", { id: "x" });
		await runOperation(app, "config.set", { path: "translation.chunk_lines", value: 50 }, { actor: "agent:t1" });
		await assert.rejects(runOperation(app, "config.set", { path: "translation.chunk_lines", value: 60 }, { actor: "plugin:x" }), (e: any) => e.code === "owner_only");
		await assert.rejects(runOperation(app, "config.set", { path: "limits.background_daily_usd", value: 100 }, { actor: "agent:t1" }), (e: any) => e.code === "owner_only", "the agent's own limits are the owner's");
		await runOperation(app, "config.set", { path: "limits.background_daily_usd", value: 2 }, { actor: "owner:web" });
		await assert.rejects(runOperation(app, "plugin.list", {}, { actor: "owner:cli" }), /needs the running server/);
		await assert.rejects(runOperation(app, "plugin.disable", { id: "x" }, { actor: "owner:cli" }), /needs the running server/);
	} finally {
		app.close();
	}
});

test("socket: the token decides who is calling, and a claimed actor is ignored", async () => {
	const { app } = tempApp();
	try {
		const tokens = new SocketTokens();
		const api = socketApp({ app, host: { tokens }, jobs: {} } as never);
		const call = (op: string, input: unknown, headers: Record<string, string>) => api.request(`/api/op/${op}`, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json", ...headers } });
		const lastActor = () => (app.db.prepare("SELECT actor FROM actions ORDER BY id DESC LIMIT 1").get() as { actor: string }).actor;
		const setting = (n: number) => ({ path: "translation.chunk_lines", value: 50 + n });

		assert.equal((await call("config.set", setting(1), {})).status, 200);
		assert.equal(lastActor(), "agent:socket", "no token");
		assert.equal((await call("config.set", setting(2), { "x-reelix-token": "made-up" })).status, 200);
		assert.equal(lastActor(), "agent:socket", "unknown token");

		const forged = await call("secret.set", { key: "x.y", value: "v" }, { "x-reelix-actor": "owner:cli" });
		assert.equal(forged.status, 403);
		assert.equal(((await forged.json()) as any).code, "owner_only");
		assert.equal(app.secrets["x.y"], undefined);

		const agent = tokens.issue("agent:thread1");
		assert.equal((await call("config.set", setting(3), { "x-reelix-token": agent })).status, 200);
		assert.equal(lastActor(), "agent:thread1");
		assert.equal((await call("secret.set", { key: "x.y", value: "v" }, { "x-reelix-token": agent })).status, 403);
		tokens.revoke(agent);
		assert.equal(tokens.actorOf(agent), "agent:socket", "a closed session's token stops working");

		tokens.writeOwnerToken(app);
		assert.equal(statSync(app.paths.ownerToken).mode & 0o777, 0o600);
		const owner = readFileSync(app.paths.ownerToken, "utf8").trim();
		assert.equal((await call("secret.set", { key: "x.y", value: "stored" }, { "x-reelix-token": owner })).status, 200);
		assert.equal(app.secrets["x.y"], "stored");
		assert.equal(lastActor(), "owner:cli");
	} finally {
		app.close();
	}
});

test("the CLI without a server and without a terminal counts as the agent", () => {
	const { app, root } = tempApp();
	const data = app.paths.root;
	app.close();
	const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ["--no-warnings", join(REPO, "packages/cli/src/main.ts"), ...args], { encoding: "utf8", input: "", env: { ...process.env, REELIX_DATA: data, ...env } });
	try {
		const refused = cli(["secret", "set", "x.y", "--value", "v"]);
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /owner only.*real terminal/);
		assert.equal(cli(["config", "set", "translation.chunk_lines", "40"]).status, 0, refused.stderr);
		assert.equal(cli(["config", "set", "limits.trash_days", "4"]).status, 1, "the agent's own limits are the owner's");
		assert.equal(cli(["plugin", "disable", "x"], { REELIX_TOKEN: "any" }).status, 1);
		assert.match(cli(["plugin", "list"]).stderr, /needs the running server/);
		const again = new Reelix(data);
		assert.equal((again.db.prepare("SELECT actor FROM actions WHERE op = 'config.set' ORDER BY id DESC LIMIT 1").get() as any).actor, "agent:cli");
		assert.equal(again.secrets["x.y"], undefined);
		again.close();
	} finally {
		rmSync(dirname(data), { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
