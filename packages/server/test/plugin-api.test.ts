import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { SubtitleQuery } from "@reelix/plugin";
import { Type } from "typebox";
import { Reelix, addInbox, answerInbox, approvalRequest, createApproval, doctor, kvGet, listInbox, loadSecrets, parseConfig, reconcileOnStartup, runOperation } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { tempApp } from "../../core/test/helpers.ts";
import { isHomeAddress } from "../src/plugins/http.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const SEAM = "reelix:subtitle.source@1";

function pluginDir(root: string, id: string, reelix: Record<string, unknown>, source: string): string {
	const dir = join(root, id);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `p-${id}`, version: "1.0.0", type: "module", reelix: { api: 0, id, entry: "./src/index.ts", runtime: "in-process", ...reelix } }));
	writeFileSync(join(dir, "src/index.ts"), `import { definePlugin, Type } from "@reelix/plugin";\n${source}`);
	return dir;
}

function folder() {
	const root = mkdtempSync(join(tmpdir(), "reelix-api-"));
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const until = async (what: string, ok: () => boolean, turns = 400) => {
	for (let i = 0; i < turns && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
	assert.ok(ok(), `timed out waiting for ${what}`);
};

const SOURCE = (id: string, search = "async () => []") => `{ id: "${id}", label: "${id} site", kinds: ["movie"], languages: ["en"], search: ${search}, download: async () => ({ bytes: new Uint8Array([1]), filename: "a.srt" }) }`;
const provider = (id: string, search?: string) => `export default definePlugin({ async activate(ctx) { await ctx.provide("${SEAM}", ${SOURCE(id, search)}); } });`;
const PROVIDES = { uses: { provides: [SEAM] } };
const QUERY: SubtitleQuery = { names: ["x"], ids: {}, kind: "movie", series: false, languages: ["en"] };

test("operations: registered under the plugin's name, run through the ledger, gone when it stops; a plugin's own limits hold", async () => {
	const f = folder();
	const ok = pluginDir(f.root, "sample", { uses: { operations: { hello: "write", sweep: "destructive" } } }, `export default definePlugin({ async activate(ctx) {
		await ctx.operation({ name: "hello", summary: "Say hello", effect: "write", input: Type.Object({ who: Type.String() }), run: async ({ who }) => ({ text: "hi " + who }), toText: (o) => o.text });
		await ctx.operation({ name: "sweep", summary: "Delete", effect: "destructive", input: Type.Object({}), run: async () => "swept" });
	} });`);
	const undeclared = pluginDir(f.root, "undeclared", {}, `export default definePlugin({ async activate(ctx) { await ctx.operation({ name: "x", summary: "s", effect: "read", input: Type.Object({}), run: async () => 1 }); } });`);
	const outside = pluginDir(f.root, "outside", { uses: { operations: { "title.find": "read" } } }, `export default definePlugin({ async activate(ctx) { await ctx.operation({ name: "title.find", summary: "s", effect: "read", input: Type.Object({}), run: async () => 1 }); } });`);
	const t = await startPlugins([ok, undeclared, outside]);
	try {
		assert.match(t.info("undeclared").error!, /not declared in reelix\.uses\.operations/);
		assert.match(t.info("outside").error!, /full name is always outside\.<name>/);
		const op = t.app.operations.get("sample.hello")!;
		assert.equal(op.plugin, "sample");
		const r = await runOperation(t.app, "sample.hello", { who: "you" }, { actor: "owner:cli" });
		assert.equal(r.text, "hi you");
		assert.ok(r.actionId, "it is in the ledger");
		await assert.rejects(runOperation(t.app, "sample.hello", {}, { actor: "owner:cli" }), /who/, "the input schema applies");

		t.app.db.prepare("INSERT INTO actions (request_id, op, effect, actor, input_json, status, started_at) VALUES ('old', 'sample.hello', 'write', 'agent:t', '{}', 'unknown', datetime('now'))").run();
		await t.manager.disable("sample");
		assert.equal(t.app.operations.get("sample.hello"), undefined);
		assert.deepEqual(await reconcileOnStartup(t.app), { settled: 0, unknown: 1 }, "with its plugin gone, an action stays unknown");
	} finally {
		await t.close();
		f.cleanup();
	}
});

test("approvals: a plugin runs a destructive operation only with a matching record, once", async () => {
	const f = folder();
	const dir = pluginDir(f.root, "cleaner", { uses: { runs: ["testops.remove"], jobs: ["go"] } }, `export default definePlugin({ async activate(ctx) { await ctx.job({ name: "go", run: async ({ payload }) => ({ state: "succeeded", summary: String(await ctx.reelix.run("testops.remove", payload)) }) }); } });`);
	const { app } = tempApp();
	let ran = 0;
	app.operations.add({ name: "testops.remove", summary: "remove", effect: "destructive", input: Type.Object({ what: Type.String() }), run: async () => ++ran });
	const t = await startPlugins([dir], { app });
	try {
		const run = (what: string) => t.runJob("cleaner.go", { what });
		assert.match((await run("a")).summary!, /without the owner's approval/);
		const request = approvalRequest("testops.remove", { what: "a" }, "plugin:cleaner", new Date(Date.now() + 60_000).toISOString());
		assert.throws(() => createApproval(app, { ...request, approvedBy: "agent:t1" }), /Only the owner/);
		assert.throws(() => createApproval(app, { ...request, approvedBy: "plugin:cleaner" }), /Only the owner/);
		createApproval(app, { ...request, approvedBy: "owner:web" });
		assert.match((await run("b")).summary!, /approval/, "another input is not approved");
		assert.equal((await run("a")).summary, "1");
		assert.match((await run("a")).summary!, /approval/, "used once");
		createApproval(app, { ...request, approvedBy: "owner:cli", expiresAt: "2000-01-01T00:00:00.000Z" });
		assert.match((await run("a")).summary!, /approval/, "expired");
		assert.equal((await runOperation(app, "testops.remove", { what: "z" }, { actor: "agent:t" })).output, 2, "the agent is unchanged");
	} finally {
		await t.close();
		app.close();
		f.cleanup();
	}
});

test("seams: declared and unique, labelled with the plugin, gone with it; waiting, and switching off the last provider", async () => {
	const f = folder();
	const a = pluginDir(f.root, "site-a", PROVIDES, provider("alpha"));
	const clash = pluginDir(f.root, "site-b", PROVIDES, provider("alpha"));
	const undeclared = pluginDir(f.root, "site-c", {}, provider("gamma"));
	const needs = pluginDir(f.root, "needs", { requires: { seams: [SEAM] } }, `export default definePlugin({ activate() {} });`);
	const t = await startPlugins([a, clash, undeclared, needs]);
	try {
		assert.match(t.info("site-b").error!, /already a reelix:subtitle\.source@1 provider "alpha"/);
		assert.match(t.info("site-c").error!, /not declared in reelix\.uses\.provides/);
		assert.equal(t.info("needs").state, "active");
		assert.equal(t.app.seams.provider(SEAM, "alpha")!.label, "alpha site (site-a)", "a third-party label names its plugin");

		const asked = await t.manager.disable("site-a");
		assert.deepEqual([asked.result, asked.dependents], ["needs_confirmation", ["needs"]]);
		assert.match(asked.next, /needs depend on site-a|needs/);
		assert.equal(t.info("site-a").state, "active", "nothing happens before the owner confirms");
		const done = await t.manager.disable("site-a", { withDependents: true });
		assert.deepEqual([done.result, done.state, done.dependents], ["applied", "disabled", ["needs"]]);
		assert.deepEqual([t.info("needs").state, t.app.seams.providers(SEAM).length], ["disabled", 0]);

		const on = await t.manager.enable("needs");
		assert.deepEqual([on.result, on.state], ["applied", "waiting"]);
		assert.match(on.next, /subtitle\.source/);
		assert.deepEqual(t.info("needs").waitingFor, [SEAM]);
		await t.manager.enable("site-a");
		assert.equal(t.info("needs").state, "active", "checked again when plugins change");
	} finally {
		await t.close();
		f.cleanup();
	}
});

test("seams: throws, broken results and timeouts count per registration; outcomes do not; five switch the plugin off", async () => {
	const f = folder();
	const good = pluginDir(f.root, "typed", PROVIDES, provider("typed", `async () => ({ outcome: "rate_limited", until: "2030-01-01T00:00:00Z" })`));
	const broken = pluginDir(f.root, "broken", PROVIDES, provider("broken", `async () => [{ nothing: true }]`));
	const thrower = pluginDir(f.root, "thrower", PROVIDES, provider("thrower", `async () => { throw new Error("boom"); }`));
	const t = await startPlugins([good, broken, thrower]);
	try {
		const call = (id: string) => t.app.seams.provider(SEAM, id)!.call("search", [QUERY]);
		for (let i = 0; i < 6; i++) assert.deepEqual(await call("typed"), { outcome: "rate_limited", until: "2030-01-01T00:00:00Z" });
		assert.equal(t.info("typed").failures, 0);
		assert.equal(t.app.seams.outcomes(SEAM, "typed", "2000").length, 6, "and each is recorded");
		await assert.rejects(call("broken"), (e: any) => e.code === "provider_contract" && /broke the/.test(e.message));
		assert.equal(t.info("broken").failures, 1);
		for (let i = 0; i < 4; i++) await assert.rejects(call("thrower"), /boom/);
		assert.equal(t.info("thrower").state, "active");
		await assert.rejects(call("thrower"), /boom/);
		await until("the switch-off", () => t.info("thrower").state === "disabled");
		await until("the notice", () => listInbox(t.app).some((n) => /thrower/.test(n.title) && /provider thrower/.test(n.body)));
		assert.equal(t.app.seams.provider(SEAM, "thrower"), undefined);
	} finally {
		await t.close();
		f.cleanup();
	}
});

test("fairness: Reelix being busy is not the plugin's fault, and one incident takes at most one plugin", async () => {
	const f = folder();
	const NEVER = `() => new Promise(() => undefined)`;
	const dirs = ["slow-a", "slow-b"].map((id) => pluginDir(f.root, id, PROVIDES, provider(id, NEVER)));
	const t = await startPlugins(dirs);
	try {
		t.app.seams.limitMs = 300;
		const call = (id: string) => t.app.seams.provider(SEAM, id)!.call("search", [QUERY]);
		const busy = call("slow-a");
		const until0 = Date.now() + 350;
		while (Date.now() < until0); // Reelix cannot do anything meanwhile
		await assert.rejects(busy, (e: any) => e.code === "provider_timeout");
		assert.equal(t.info("slow-a").failures, 0, "time Reelix itself was stuck is not counted");

		t.app.seams.limitMs = 30;
		// Calls begun together are one incident: they end by taking one plugin, not both.
		const burst = [...Array(5).fill("slow-a"), ...Array(5).fill("slow-b")].map((id) => call(id).catch(() => undefined));
		await Promise.all(burst);
		await until("a switch-off", () => [t.info("slow-a").state, t.info("slow-b").state].includes("disabled"));
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual([t.info("slow-a").state, t.info("slow-b").state].sort(), ["active", "disabled"]);
	} finally {
		await t.close();
		f.cleanup();
	}
});

test("settings: checked before activate, defaults filled in; a change of settings or secret starts the plugin again", async () => {
	const f = folder();
	const dir = pluginDir(f.root, "tuned", { uses: { secrets: ["token"] } }, `let runs = 0; export default definePlugin({ config: Type.Object({ n: Type.Number({ default: 3 }) }), async activate(ctx, c) {
		await ctx.kv.set("seen", { n: c.n, token: await ctx.secret.get("token"), runs: ++runs });
		await ctx.secret.get("other").catch(async (e) => ctx.kv.set("refused", e.message));
	} });`);
	const t = await startPlugins([dir]);
	try {
		assert.deepEqual(t.kv("tuned", "seen"), { n: 3, runs: 1 });
		assert.match(t.kv("tuned", "refused"), /not declared in reelix\.uses\.secrets/);
		t.app.setConfig("plugins.tuned.n", 5);
		await until("the new setting", () => t.kv("tuned", "seen").n === 5);
		t.app.setSecret("plugins.tuned.token", "s3cret-value");
		await until("the new secret", () => t.kv("tuned", "seen").token === "s3cret-value");
		assert.equal(t.app.redact("x s3cret-value"), "x [secret:plugins.tuned.token]", "declared secrets are redacted");
		t.app.setConfig("plugins.tuned.n", "many");
		await until("the refusal", () => t.info("tuned").state === "failed");
		assert.match(t.info("tuned").error!, /settings under plugins\.tuned are invalid/);
		t.app.setConfig("plugins.tuned.n", 6);
		await until("the recovery", () => t.info("tuned").state === "active");
	} finally {
		await t.close();
		f.cleanup();
	}
});

test("checks reach Doctor and leave with the plugin; ctx.agent.run works only inside a job", async () => {
	const f = folder();
	const dir = pluginDir(f.root, "watcher-x", { uses: { jobs: ["turn"], agent: true } }, `export default definePlugin({ async activate(ctx) {
		await ctx.check("watcher-x", async ({ quick }) => ({ ok: !quick, detail: "looked" }));
		await ctx.agent.run({ prompt: "no" }).catch((e) => ctx.kv.set("outside", e.message));
		await ctx.job({ name: "turn", run: async () => { const r = await ctx.agent.run({ prompt: "say hi" }); return { state: "succeeded", summary: r.text }; } });
	} });`);
	const noAgent = pluginDir(f.root, "no-agent", { uses: { jobs: ["turn"] } }, `export default definePlugin({ async activate(ctx) { await ctx.job({ name: "turn", run: async () => { await ctx.agent.run({ prompt: "x" }); return { state: "succeeded", summary: "" }; } }); } });`);
	const t = await startPlugins([dir, noAgent], { agent: (p) => ({ state: "done", text: `agent got ${p}` }) });
	try {
		const quick = await doctor(t.app, { quick: true });
		assert.deepEqual(quick.find((c) => c.name === "watcher-x"), { name: "watcher-x", ok: false, detail: "looked" });
		assert.match(t.kv("watcher-x", "outside"), /only inside one of this plugin's jobs/);
		assert.equal((await t.runJob("watcher-x.turn")).summary, "agent got say hi");
		assert.match((await t.runJob("no-agent.turn")).summary!, /not declared/);
		await t.manager.disable("watcher-x");
		assert.equal((await doctor(t.app, { quick: true })).some((c) => c.name === "watcher-x"), false);
	} finally {
		await t.close();
		f.cleanup();
	}
});

test("ctx.http: declared hosts only, home addresses only for hosts the owner typed, Reelix's ports never, redirects re-checked", async () => {
	const f = folder();
	const seen: string[] = [];
	const server = createServer((req, res) => {
		seen.push(req.url!);
		if (req.url === "/to-undeclared") return void res.writeHead(302, { location: "http://example.invalid/x" }).end();
		if (req.url === "/to-self") return void res.writeHead(302, { location: "/final" }).end();
		res.writeHead(200, { "set-cookie": ["a=1; Path=/", "b=2"], "x-test": "yes" }).end(Buffer.from([0, 1, 2]));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	const url = `http://127.0.0.1:${port}`;
	const dir = pluginDir(f.root, "net", { uses: { network: ["config:servers", "localhost"], jobs: ["get"] } }, `export default definePlugin({ config: Type.Object({ servers: Type.Array(Type.Object({ url: Type.String() }), { default: [] }) }), async activate(ctx) {
		await ctx.job({ name: "get", run: async ({ payload }) => {
			try {
				const r = await ctx.http.fetch(payload.url, { redirect: payload.manual ? "manual" : "follow" });
				return { state: "succeeded", summary: JSON.stringify({ status: r.status, url: r.url, cookies: r.cookies, header: r.headers["x-test"], bytes: [...r.bytes] }) };
			} catch (e) { return { state: "failed", summary: e.code + ": " + e.message }; }
		} });
	} });`);
	const t = await startPlugins([dir], { settings: { net: { servers: [{ url }] } } });
	const get = async (u: string, manual = false) => (await t.runJob("net.get", { url: u, manual })).summary!;
	try {
		assert.equal(t.info("net").state, "active", t.info("net").error);
		assert.deepEqual(JSON.parse(await get(`${url}/x`)), { status: 200, url: `${url}/x`, cookies: ["a=1; Path=/", "b=2"], header: "yes", bytes: [0, 1, 2] });
		assert.equal(JSON.parse(await get(`${url}/to-self`)).url, `${url}/final`, "redirects are followed");
		assert.equal(JSON.parse(await get(`${url}/to-undeclared`, true)).status, 302, "manual redirects come back");
		assert.match(await get(`${url}/to-undeclared`), /network_refused: example\.invalid is not declared/, "every redirect is checked");
		assert.match(await get("http://undeclared.invalid/"), /not declared in reelix\.uses\.network/);
		assert.match(await get("http://127.0.0.2:9/"), /not declared/, "another home address is not the one typed");
		const before = seen.length;
		assert.match(await get(`http://localhost:${port}/x`), /on the home network/, "a declared name that resolves to a home address");
		assert.equal(seen.length, before, "nothing was sent");
		t.app.setConfig("plugins.net.servers", [{ url }, { url: `http://localhost:${port}` }]);
		await until("the plugin to start again", () => t.info("net").state === "active" && t.manager.registrations("net") !== undefined);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(JSON.parse(await get(`http://localhost:${port}/y`)).status, 200, "the same name, typed into the settings by the owner");
		t.app.setConfig("web.port", port);
		assert.match(await get(`${url}/x`), /is Reelix's own/);
		assert.deepEqual(["127.0.0.1", "10.1.1.1", "192.168.1.1", "169.254.1.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"].filter((a) => !isHomeAddress(a)), []);
		assert.deepEqual(["8.8.8.8", "2001:4860:4860::8888"].filter(isHomeAddress), []);
	} finally {
		await t.close();
		server.close();
		f.cleanup();
	}
});

test("one-time move of old settings, secrets and stored data; the old keys are gone afterwards", () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-old-"));
	try {
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "config.yaml"), "jackett:\n  url: http://nas:9117\nsubtitles:\n  sources: [subhd]\n  subhd_url: https://subhd.example\n  assrt_url: https://api.assrt.net\n");
		writeFileSync(join(root, "secrets.yaml"), "jackett:\n  api_key: jk-secret\nassrt:\n  token: as-secret\nopensubtitles:\n  api_key: os-key\n  username: me\nsubdl:\n  api_key: sd-key\njimaku:\n  api_key: jm-key\ntmdb:\n  api_key: keep\n");
		let app = new Reelix(root);
		const db = app.db;
		db.exec("ALTER TABLE inbox ADD COLUMN telegram_message_id INTEGER; DROP TABLE notice_deliveries; DROP TABLE chat_channels; DROP TABLE reasons; DROP TABLE proposals; DROP TABLE trial_results; ALTER TABLE downloads DROP COLUMN downloader; ALTER TABLE titles DROP COLUMN ratings_json; ALTER TABLE titles ADD COLUMN douban_rating REAL; UPDATE schema_version SET v = 5; DROP TABLE provider_outcomes; CREATE TABLE site_state (site TEXT PRIMARY KEY, state_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL)");
		const today = new Date().toISOString();
		db.prepare("INSERT INTO site_state VALUES ('subhd', ?, ?)").run(JSON.stringify({ lastRequestAt: 123, dailyLimitUntil: "2099-01-01T00:00:00.000Z", downloadsToday: 2, day: today.slice(0, 10) }), today);
		db.prepare("INSERT INTO kv (k, v) VALUES ('opensubtitles.token', '2026-01-01 tok'), ('translate.offered:movie:1:', 'then')").run();
		db.prepare("INSERT INTO handles (id, payload_json, created_at) VALUES ('r1', ?, 'now')").run(JSON.stringify({ link: "http://nas:9117/dl/x", magnet: null, details: "d", title: "T", key: "k" }));
		app.close();
		app = new Reelix(root);
		try {
			assert.deepEqual(app.config.plugins, { jackett: { servers: [{ url: "http://nas:9117" }] }, "subtitle-sites": { subhd_url: "https://subhd.example" } }, "a default is not carried over");
			assert.equal("jackett" in app.config, false);
			assert.deepEqual(app.config.subtitles, parseConfig({ subtitles: { sources: ["subhd"] } }).subtitles);
			assert.doesNotMatch(readFileSync(join(root, "config.yaml"), "utf8"), /^jackett:|subhd_url: https:\/\/subhd\.example\n  assrt/m);
			assert.deepEqual(Object.keys(loadSecrets(app.paths)).sort(), ["plugins.jackett.api_key", "plugins.subtitle-sites.assrt_token", "plugins.subtitle-sites.jimaku_api_key", "plugins.subtitle-sites.opensubtitles_api_key", "plugins.subtitle-sites.opensubtitles_username", "plugins.subtitle-sites.subdl_api_key", "tmdb.api_key"]);
			assert.equal(app.secrets["plugins.jackett.api_key"], "jk-secret");
			assert.equal(kvGet(app.db, "plugin:subtitle-sites:pace.subhd"), "123");
			assert.equal(kvGet(app.db, "plugin:subtitle-sites:subhd.limit_until"), '"2099-01-01T00:00:00.000Z"');
			assert.equal(kvGet(app.db, "plugin:subtitle-sites:opensubtitles.token"), '"2026-01-01 tok"');
			assert.equal(kvGet(app.db, "plugin:auto-subtitles:translate.offered:movie:1:"), '"then"');
			assert.equal(kvGet(app.db, "opensubtitles.token"), undefined);
			assert.equal(app.db.prepare("SELECT name FROM sqlite_master WHERE name = 'site_state'").get(), undefined);
			assert.deepEqual(app.seams.outcomes(SEAM, "subhd", "2000").map((o) => o.outcome).sort(), ["ok", "ok", "rate_limited"]);
			const handle = JSON.parse((app.db.prepare("SELECT payload_json p FROM handles WHERE id = 'r1'").get() as { p: string }).p);
			assert.deepEqual([handle.provider, JSON.parse(handle.ref), handle.link, handle.details, handle.hasMagnet], ["jackett", { link: "http://nas:9117/dl/x", magnet: null }, undefined, undefined, false]);
		} finally {
			app.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the CLI: without a server plugin operations are absent and providers say so; with one it uses the server's list and asks at the terminal", { timeout: 60_000 }, async () => {
	const { app, root } = tempApp();
	const data = app.paths.root;
	app.setConfig("web.host", "127.0.0.1");
	app.setConfig("plugins.jackett.servers", [{ url: "http://127.0.0.1:9" }]);
	app.close();
	const env = { ...process.env, REELIX_DATA: data, REELIX_PORT: "0", REELIX_BIN_DIR: join(REPO, "bin") };
	const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", join(REPO, "packages/cli/src/main.ts"), ...args], { encoding: "utf8", input: "", env });
	assert.doesNotMatch(cli(["help"]).stdout, /jackett indexers/);
	assert.match(cli(["help"]).stdout, /server is not running/);
	const absent = cli(["jackett", "indexers"]);
	assert.equal(absent.status, 2);
	assert.match(absent.stderr, /need it to run/);
	assert.match(cli(["release", "search", "--query", "x"]).stderr, /plugins run inside the Reelix server/);

	const server = spawn(process.execPath, ["--no-warnings", join(REPO, "packages/server/src/main.ts")], { env, stdio: "ignore" });
	try {
		// Starting the whole server (the agent, every plugin) takes seconds, more on a busy machine.
		await until("the socket", () => existsSync(join(data, "reelix.sock")) && existsSync(join(data, "owner.token")), 3_000);
		for (let i = 0; i < 100 && !/jackett indexers/.test(cli(["help"]).stdout); i++) await new Promise((r) => setTimeout(r, 100));
		assert.match(cli(["help"]).stdout, /jackett indexers/);
		assert.match(cli(["help", "jackett", "indexers"]).stdout, /--test <boolean>/);
		assert.match(cli(["jackett", "indexers"]).stdout, /jackett/);
		assert.match(cli(["plugin", "list"]).stdout, /subtitle-sites/);
		assert.equal(cli(["plugin", "disable", "auto-subtitles"]).status, 1, "not at a terminal: refused");

		if (spawnSync("sh", ["-c", "command -v script"]).status === 0) {
			const atTerminal = (args: string, answer: string) => spawnSync("script", ["-qec", `node --no-warnings ${join(REPO, "packages/cli/src/main.ts")} ${args}`, "/dev/null"], { encoding: "utf8", input: `${answer}\n`, env, timeout: 15_000 }).stdout;
			assert.match(atTerminal("plugin disable auto-subtitles", "n"), /Nothing was changed/);
			assert.match(cli(["plugin", "list"]).stdout, /auto-subtitles [\d.]+ \| active/);
			assert.match(atTerminal("plugin disable auto-subtitles", "y"), /auto-subtitles: disabled/);
			assert.match(cli(["plugin", "list"]).stdout, /auto-subtitles [\d.]+ \| disabled/);
			assert.match(atTerminal("plugin enable auto-subtitles", "y"), /auto-subtitles: active/);
			assert.match(atTerminal("plugin disable subtitle-sites", "y\nn"), /auto-subtitles need subtitle-sites: they require it, or it is the last provider of a seam they need[^]*Nothing was changed/);
			assert.match(cli(["plugin", "list"]).stdout, /subtitle-sites [\d.]+ \| active/);
			assert.match(atTerminal("plugin disable subtitle-sites", "y\ny"), /subtitle-sites: disabled/);
			assert.match(cli(["plugin", "list"]).stdout, /auto-subtitles [\d.]+ \| disabled/, "the dependent went with it");
		}
	} finally {
		server.kill("SIGTERM");
		await new Promise((r) => server.once("exit", r));
		rmSync(dirname(data), { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("hooks: declared only; a section over the limit is dropped and counted; one plugin's failure leaves the others", async () => {
	const f = folder();
	const hooks = { uses: { hooks: ["agent.prompt@1"] } };
	const section = (body: string) => `export default definePlugin({ async activate(ctx) { await ctx.hook("agent.prompt@1", ${body}); } });`;
	const good = pluginDir(f.root, "good-section", hooks, section(`({ session }) => ({ title: "Style", text: "Kind " + session.kind })`));
	const long = pluginDir(f.root, "long-section", hooks, section(`() => ({ title: "Long", text: "x".repeat(1501) })`));
	const slow = pluginDir(f.root, "slow-section", hooks, section(`() => new Promise(() => {})`));
	const silent = pluginDir(f.root, "silent-section", hooks, section(`() => undefined`));
	const undeclared = pluginDir(f.root, "undeclared-hook", {}, section(`() => undefined`));
	const unknown = pluginDir(f.root, "unknown-hook", { uses: { hooks: ["no.such@1"] } }, `export default definePlugin({ activate() {} });`);
	const t = await startPlugins([good, long, slow, silent, undeclared, unknown]);
	try {
		t.app.hooks.limitMs = 50;
		assert.match(t.info("undeclared-hook").error!, /not declared in reelix\.uses\.hooks/);
		assert.match(t.info("unknown-hook").error!, /there is no hook "no\.such@1"/);
		const got = await t.app.hooks.each("agent.prompt@1", { session: { kind: "chat" } });
		assert.deepEqual(got, [{ plugin: "good-section", item: { title: "Style", text: "Kind chat" } }]);
		assert.equal(t.info("long-section").failures, 1);
		assert.match(t.info("long-section").error!, /longer than 1500/);
		assert.equal(t.info("slow-section").failures, 1);
		assert.equal(t.info("silent-section").failures, 0, "no opinion is not a failure");
		await t.manager.disable("good-section");
		assert.deepEqual(await t.app.hooks.each("agent.prompt@1", { session: { kind: "chat" } }), []);
	} finally {
		await t.close();
		f.cleanup();
	}
});

test("tasks: restarted with a growing delay, stopped through the signal; a throw counts; ctx.signal fires", async () => {
	const f = folder();
	const dir = pluginDir(f.root, "looper", {}, `const state = globalThis.__looper = { starts: [], aborted: 0, signal: 0 };
	export default definePlugin({ async activate(ctx) {
		ctx.signal.addEventListener("abort", () => state.signal++);
		await ctx.task("loop", async ({ signal }) => {
			state.starts.push(Date.now());
			if (state.starts.length === 2) throw new Error("boom");
			if (state.starts.length < 4) return;
			await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			state.aborted++;
		});
		await ctx.task("loop", async () => {}).catch((e) => { state.duplicate = e.message; });
	} });`);
	const t = await startPlugins([dir], { taskDelayMs: 20 });
	const state = (globalThis as any).__looper as { starts: number[]; aborted: number; signal: number; duplicate: string };
	try {
		await until("the fourth start", () => state.starts.length === 4);
		const gaps = state.starts.slice(1).map((s, i) => s - state.starts[i]!);
		assert.ok(gaps[0]! >= 18 && gaps[1]! >= 38 && gaps[2]! >= 78, `growing delays: ${gaps}`);
		assert.match(state.duplicate, /already registered/);
		assert.equal(t.info("looper").failures, 1, "only the throw counts");
		await t.manager.disable("looper");
		assert.deepEqual([state.aborted, state.signal], [1, 1]);
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(state.starts.length, 4, "no start after the plugin stopped");
	} finally {
		await t.close();
		f.cleanup();
		delete (globalThis as any).__looper;
	}
});

test("ctx.secret.set: declared names only, redacted, and no restart of the plugin that stored it", async () => {
	const f = folder();
	const dir = pluginDir(f.root, "keeper", { uses: { secrets: ["made"] } }, `const state = (globalThis.__keeper ??= { activations: 0 });
	export default definePlugin({ async activate(ctx) {
		state.activations++;
		await ctx.secret.set("made", "generated-value-1");
		await ctx.secret.set("other", "x").catch((e) => { state.refused = e.message; });
	} });`);
	const t = await startPlugins([dir]);
	const state = (globalThis as any).__keeper as { activations: number; refused: string };
	try {
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(state.activations, 1);
		assert.match(state.refused, /not declared/);
		assert.equal(t.app.redact("a generated-value-1 b"), "a [secret:plugins.keeper.made] b");
		t.app.setSecret("plugins.keeper.made", "changed-by-owner");
		await until("the restart after the owner's change", () => state.activations === 2);
	} finally {
		await t.close();
		f.cleanup();
		delete (globalThis as any).__keeper;
	}
});

test("dispatcher: every notifier gets the notice once; a throw is retried and counted; closing updates only those that can", async () => {
	const f = folder();
	const notifier = (id: string, extra: string) => `{ id: "${id}", label: "${id}", can: { images: false, update: ${extra.includes("update") ? "true" : "false"}, answers: false }, ${extra} }`;
	const seam = "reelix:notifier@1";
	const dir = pluginDir(f.root, "notifiers", { uses: { provides: [seam] } }, `const log = globalThis.__notices = [];
	let tries = 0;
	export default definePlugin({ async activate(ctx) {
		await ctx.provide("${seam}", ${notifier("steady", `send: async (n) => { log.push(["steady", n.inboxId, n.title, n.path, n.urgent, n.answer.kind, n.answer.options]); return { ref: "s1" }; }, update: async (ref, n, closed) => { log.push(["update", ref, closed]); }`)});
		await ctx.provide("${seam}", ${notifier("flaky", `send: async (n) => { log.push(["flaky", n.inboxId]); if (++tries === 1) throw new Error("first try fails"); return {}; }`)});
		await ctx.provide("${seam}", ${notifier("unready", `send: async () => ({ outcome: "needs_auth" })`)});
	} });`);
	const t = await startPlugins([dir]);
	const log = (globalThis as any).__notices as unknown[][];
	const rows = (id: string) => t.app.db.prepare("SELECT provider, state, attempts, closed_at FROM notice_deliveries WHERE inbox_id = ? ORDER BY provider").all(id) as { provider: string; state: string; attempts: number; closed_at: string | null }[];
	t.app.notifications.retryMs = 20;
	try {
		t.app.setSecret("tmdb.api_key", "topsecretvalue");
		addInbox(t.app, { kind: "notice", title: "Routine" });
		const urgent = addInbox(t.app, { kind: "notice", title: "Disk full topsecretvalue", payload: { urgent: true } });
		await until("the retry", () => rows(urgent.id).find((r) => r.provider === "flaky")?.state === "sent");
		assert.deepEqual(log.filter((l) => l[0] === "steady"), [["steady", urgent.id, "Disk full [secret:tmdb.api_key]", `/inbox?item=${urgent.id}`, true, "none", []]]);
		assert.deepEqual(rows(urgent.id).map((r) => [r.provider, r.state, r.attempts]), [["flaky", "sent", 2], ["steady", "sent", 1], ["unready", "needs_auth", 1]]);
		assert.equal(t.info("notifiers").failures, 1, "the throw counts; the outcome does not");
		answerInbox(t.app, urgent.id, "ok", "owner:web");
		await until("the update", () => log.some((l) => l[0] === "update"));
		assert.deepEqual(log.find((l) => l[0] === "update"), ["update", "s1", { status: "answered", answer: "ok" }]);
		await until("closed", () => !!rows(urgent.id).find((r) => r.provider === "steady")?.closed_at);
		assert.equal(rows(urgent.id).find((r) => r.provider === "flaky")!.closed_at, null, "no ref, nothing to change");
	} finally {
		await t.close();
		f.cleanup();
		delete (globalThis as any).__notices;
	}
});
