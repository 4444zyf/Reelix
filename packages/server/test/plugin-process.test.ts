import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listInbox, reviewText, runOperation, setTrial } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { declarations, readManifest } from "../src/plugins/manifest.ts";

const JACKETT = join(import.meta.dirname, "../../../plugins/jackett");

/** A plugin folder in `root`; its manifest's runtime is `process` unless `reelix` says otherwise. */
function pluginDir(root: string, id: string, reelix: Record<string, unknown>, source: string): string {
	const dir = join(root, id);
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "locales"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `p-${id}`, version: "1.0.0", type: "module", reelix: { api: 0, id, entry: "./src/index.ts", runtime: "process", ...reelix } }));
	writeFileSync(join(dir, "locales/en.json"), JSON.stringify({ hello: "Hello {{name}}", files_one: "{{count}} file", files_other: "{{count}} files" }));
	writeFileSync(join(dir, "locales/fr.json"), JSON.stringify({ hello: "Bonjour {{name}}", files_one: "{{count}} fichier", files_other: "{{count}} fichiers" }));
	writeFileSync(join(dir, "src/index.ts"), source);
	return dir;
}

const until = async (what: string, ok: () => boolean, turns = 500) => {
	for (let i = 0; i < turns && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
	assert.ok(ok(), `timed out waiting for ${what}`);
};

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Every kind of thing that crosses the boundary: handlers, signals, errors, streams, a class, async context. */
const BRIDGE = `import { OperationError, OutcomeError, Type, definePlugin } from "@reelix/plugin";

class Indexer {
	constructor(ctx) { this.ctx = ctx; this.id = "bridge"; this.label = "Bridge"; this.kinds = ["movie"]; }
	async sites() { return [{ id: "one", name: "One", private: false }]; }
	async search() { throw new OutcomeError({ outcome: "rate_limited" }); }
	async fetch(ref, call) {
		await new Promise((resolve) => call.signal.addEventListener("abort", resolve, { once: true }));
		await this.ctx.kv.set("aborted", ref);
		throw new Error("cancelled");
	}
}

export default definePlugin({
	async activate(ctx) {
		await ctx.provide("reelix:indexer@1", new Indexer(ctx));
		await ctx.operation({
			name: "hello", summary: "Greets", effect: "write", input: Type.Object({ name: Type.String(), secret: Type.Optional(Type.String()) }),
			async run({ name, secret }) { return { text: ctx.t("hello", { name }), files: ctx.t("files", { count: 2 }), secret, pid: process.pid }; },
			toText: (o) => "said: " + o.text,
			recordInput: (i) => ({ name: i.name }),
			recordOutput: (o) => ({ text: o.text }),
		});
		await ctx.operation({ name: "refuse", summary: "Refuses", effect: "read", input: Type.Object({}), async run() { throw new OperationError("not_now", "Not now."); } });
		await ctx.hook("release.filter@1", async (input) => {
			await ctx.inbox.add({ title: "seen in a hook", key: "hook" });
			return input.releases.map((r) => ({ ref: r.ref, reason: "hidden by the bridge" }));
		});
		await ctx.job({ name: "turn", async run() {
			const outcome = await ctx.agent.run({ prompt: "check the bridge" });
			return { state: "succeeded", summary: "agent said " + outcome.text };
		} });
		await ctx.route("GET", "/ticks", async (request) => ({
			events: (async function* () { for (let i = 1; i <= 3; i++) yield { event: "tick", data: { i, q: request.query.q } }; })(),
		}));
	},
});
`;

const BRIDGE_USES = { uses: { provides: ["reelix:indexer@1"], operations: { hello: "write", refuse: "read" }, hooks: ["release.filter@1"], jobs: ["turn"], inbox: true, agent: true } };

for (const runtime of ["in-process", "process"] as const) {
	test(`the plugin API is the same ${runtime === "process" ? "in a process of its own" : "inside Reelix"}: handlers, signals, errors, streams, async context, strings`, async () => {
		const root = mkdtempSync(join(tmpdir(), "reelix-process-"));
		const dir = pluginDir(root, "bridge", { ...BRIDGE_USES, runtime }, BRIDGE);
		const t = await startPlugins([dir], { agent: () => ({ state: "done", text: "all well" }) });
		try {
			assert.equal(t.info("bridge").state, "active", t.info("bridge").error);
			assert.equal(t.info("bridge").runtime, runtime);
			const r = await runOperation(t.app, "bridge.hello", { name: "Ada", secret: "s3cret" }, { actor: "owner:web" });
			const out = r.output as { text: string; files: string; pid: number };
			assert.equal(out.text, "Hello Ada");
			assert.equal(out.files, "2 files", "plural forms");
			assert.equal(r.text, "said: Hello Ada", "toText across the channel");
			assert.equal(out.pid === process.pid, runtime === "in-process");
			const row = t.app.db.prepare("SELECT input_json, output_json, actor FROM actions WHERE op = 'bridge.hello'").get() as { input_json: string; output_json: string };
			assert.deepEqual(JSON.parse(row.input_json), { name: "Ada" }, "recordInput");
			assert.deepEqual(JSON.parse(row.output_json), { text: "Hello Ada" }, "recordOutput");

			// The owner's language reaches ctx.t while the plugin runs.
			t.app.setConfig("language", "fr");
			await until("the language", () => true, 5);
			const fr = (await runOperation(t.app, "bridge.hello", { name: "Ada" }, { actor: "owner:web" })).output as { text: string };
			assert.equal(fr.text, "Bonjour Ada");

			// A refusal is the caller's, not a failure.
			await assert.rejects(runOperation(t.app, "bridge.refuse", {}, { actor: "owner:web" }), (e: any) => e.code === "not_now" && e.message === "Not now.");

			// A provider written as a class; an outcome thrown is an outcome; a cancelled call is cancelled in the plugin too.
			const [p] = t.app.seams.providers("reelix:indexer@1");
			assert.ok(p);
			assert.deepEqual(await p.call("sites", []), [{ id: "one", name: "One", private: false }]);
			await assert.rejects(p.call("search", [{ queries: ["x"], kind: "movie" } as never]), /rate|limit/i);
			const stop = new AbortController();
			setTimeout(() => stop.abort(), 50);
			await assert.rejects(p.call("fetch", ["ref-1"], { signal: stop.signal }));
			await until("the plugin saw the abort", () => t.kv("bridge", "aborted") === "ref-1");
			assert.equal(t.info("bridge").failures, 0, "neither the outcome nor the cancellation is a failure");

			// A hook in trial: what it does through ctx is dropped there too (the call keeps its context across the channel).
			setTrial(t.app, "bridge", true);
			await t.hook("release.filter@1", { releases: [{ ref: "r1" } as never] });
			assert.equal(listInbox(t.app).filter((i) => i.title === "seen in a hook").length, 0, "dropped in trial");
			setTrial(t.app, "bridge", false);
			await t.hook("release.filter@1", { releases: [{ ref: "r1" } as never] });
			assert.equal(listInbox(t.app).filter((i) => i.title === "seen in a hook").length, 1);

			// ctx.agent.run works only inside the plugin's job, so the job's context crosses too.
			const run = await t.runJob("bridge.turn");
			assert.deepEqual(run, { state: "succeeded", summary: "agent said all well" });

			// A route's event stream.
			const res = await t.route("bridge", "GET", "/ticks?q=z");
			const body = await res.text();
			assert.equal((body.match(/event: tick/g) ?? []).length, 3, body);
			assert.match(body, /"i":3,"q":"z"/);
		} finally {
			await t.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

const FRAGILE = `import { Type, definePlugin } from "@reelix/plugin";
export default definePlugin({
	async activate(ctx) {
		await ctx.operation({ name: "pid", summary: "Its process", effect: "read", input: Type.Object({}), async run() { return process.pid; } });
		await ctx.operation({ name: "die", summary: "Ends its process", effect: "read", input: Type.Object({}), async run() { setTimeout(() => process.exit(3), 5); return new Promise(() => {}); } });
	},
});
`;

test("a plugin's process that ends is a failure and starts again after a delay; switching the plugin off ends its process", async () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-fragile-"));
	const dir = pluginDir(root, "fragile", { uses: { operations: { pid: "read", die: "read" } } }, FRAGILE);
	const t = await startPlugins([dir], { taskDelayMs: 50 });
	try {
		const pid = async () => (await runOperation(t.app, "fragile.pid", {}, { actor: "owner:web" })).output as number;
		const first = await pid();
		assert.notEqual(first, process.pid);
		await assert.rejects(runOperation(t.app, "fragile.die", {}, { actor: "owner:web" }), (e: any) => e.code === "plugin_process_gone");
		await until("it is marked failed", () => t.info("fragile").state === "failed" && /process ended \(exit code 3\)/.test(t.info("fragile").error ?? ""));
		assert.equal(t.info("fragile").failures, 1);
		await until("it is running again", () => t.info("fragile").state === "active");
		const second = await pid();
		assert.notEqual(second, first);
		assert.equal(alive(first), false);

		// Five in ten minutes switch it off, with an Inbox notice naming the process.
		for (let i = 0; i < 4; i++) {
			await until("running", () => t.info("fragile").state === "active", 2000);
			await runOperation(t.app, "fragile.die", {}, { actor: "owner:web" }).catch(() => undefined);
			await until("ended", () => t.info("fragile").state !== "active", 2000);
		}
		await until("switched off", () => t.info("fragile").state === "disabled", 2000);
		assert.ok(listInbox(t.app).some((i) => /fragile/.test(i.title) && /process/.test(i.body ?? "")));

		assert.equal((await t.manager.enable("fragile")).result, "applied");
		const third = await pid();
		await t.manager.disable("fragile");
		await until("its process ended", () => !alive(third));
	} finally {
		await t.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("runtime: refused for a raw pi extension, chosen by the owner otherwise, shown on the approval screen", async () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-runtime-"));
	const plain = `import { definePlugin } from "@reelix/plugin";\nexport default definePlugin({ async activate() {} });\n`;
	const piProcess = pluginDir(root, "pi-process", { uses: { pi: true } }, plain);
	const piInside = pluginDir(root, "pi-inside", { runtime: "in-process", uses: { pi: true } }, plain);
	const inside = pluginDir(root, "inside", { runtime: "in-process" }, plain);
	const t = await startPlugins([piProcess, piInside, inside]);
	try {
		assert.equal(t.info("pi-process").state, "failed");
		assert.match(t.info("pi-process").error!, /runtime "process" cannot run a raw pi extension/);
		const shown = declarations(inside, readManifest(inside, new Set()));
		assert.deepEqual([shown.runtime, shown.processAllowed], ["in-process", true]);
		assert.match(reviewText({ id: "inside", what: "install", hash: "h", source: { kind: "folder", location: inside }, declarations: shown, nativeFound: [], scriptsNotRun: [], requirements: [] }), /runs: inside Reelix/);
		const jackett = declarations(JACKETT, readManifest(JACKETT, new Set()));
		assert.equal(jackett.runtime, "process", "jackett runs in a process of its own by default");
		assert.equal(t.info("pi-inside").processAllowed, false);
		assert.equal((await t.manager.setRuntime("pi-inside", "process")).result, "failed");
		assert.equal(t.info("pi-inside").runtime, "in-process");
		assert.equal(t.info("inside").processAllowed, true);
		assert.equal(t.info("inside").runtimeDefault, "in-process");
		await assert.rejects(runOperation(t.app, "plugin.runtime", { id: "inside", runtime: "process" }, { actor: "agent:t1" }), (e: any) => e.code === "owner_only");
		await runOperation(t.app, "plugin.runtime", { id: "inside", runtime: "process" }, { actor: "owner:web" });
		assert.equal(t.info("inside").runtime, "process");
		assert.equal(t.info("inside").state, "active");
	} finally {
		await t.close();
		rmSync(root, { recursive: true, force: true });
	}
});
