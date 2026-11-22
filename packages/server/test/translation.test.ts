import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { TranslationPaused, applyPlan, autoPlan, getInbox, getTitle, listInbox, nowIso, runOperation, translationStatus, videosOf } from "@reelix/core";
import { insertTitle, tempApp, touch } from "../../core/test/helpers.ts";
import { JobRunner } from "../src/jobs.ts";
import { ModelRouter } from "../src/models.ts";
import { PluginManager } from "../src/plugins/manager.ts";
import { startTranslation } from "../src/translation.ts";

const MODEL_TRANSLATOR = new URL("../../../plugins/model-translator", import.meta.url).pathname;

/** A stand-in for pi's model runtime: models answer by a script, keyed by "provider/id". */
function fakeRuntime(script: Record<string, (system: string, user: string) => string | Error>) {
	const calls: string[] = [];
	const registered: Record<string, any> = {};
	return {
		calls,
		registered,
		getModel: (provider: string, id: string) => (script[`${provider}/${id}`] ? { provider, id } : undefined),
		getAvailableSnapshot: () => [],
		registerProvider: (id: string, config: any) => {
			registered[id] = config;
			for (const m of config.models) script[`${id}/${m.id}`] ??= () => "{}";
		},
		async completeSimple(model: any, ctx: any) {
			const spec = `${model.provider}/${model.id}`;
			calls.push(spec);
			const r = script[spec]!(ctx.systemPrompt, ctx.messages[0].content);
			if (r instanceof Error) return { stopReason: "error", errorMessage: r.message, content: [] };
			return { stopReason: "stop", content: [{ type: "text", text: r }], usage: { totalTokens: 100, cost: { total: 0.001 } } };
		},
	};
}

test("model router: the next model answers when the first fails; all failing is a pause, not an error; magpie's models are listed", async () => {
	const { app } = tempApp();
	const rt = fakeRuntime({ "a/broken": () => new Error("429 quota"), "b/good": () => "hello", "c/chat": () => "chat" });
	const router = new ModelRouter(app, () => rt);
	try {
		app.setConfig("models.roles", { chat: ["c/chat"], background: [], glossary: [], translate: ["a/broken", "b/good", "z/unknown"], review: [] });
		const answer = await router.complete("translate", "s", "u", { scope: "translation" });
		assert.deepEqual([answer.text, answer.model, answer.skipped.map((f) => [f.model, f.class])], ["hello", "b/good", [["a/broken", "rate_limited"]]]);
		assert.deepEqual(rt.calls, ["a/broken", "b/good"]);
		assert.ok(router.isResting("a/broken"));
		// While it rests, the working model is asked first; review inherits translate's list.
		await router.complete("review", "s", "u", { scope: "translation" });
		assert.deepEqual(rt.calls.slice(2), ["b/good"]);
		assert.equal(router.pick("background")!.spec, "c/chat", "background inherits chat");
		assert.equal((app.db.prepare("SELECT tokens FROM spend WHERE scope = 'translation'").get() as any).tokens, 200);
		assert.equal(app.db.prepare("SELECT tokens FROM spend WHERE scope = 'background'").get(), undefined, "outside the background cap");

		app.setConfig("models.roles", { chat: [], background: [], glossary: [], translate: ["a/broken"], review: [] });
		await assert.rejects(router.complete("translate", "s", "u", { scope: "translation" }), (e: any) => e instanceof TranslationPaused && /a\/broken: 429 quota/.test(e.message));

		// A magpie gateway: its routing groups become models of provider "magpie".
		const gw = createServer((req, res) => {
			if (req.headers.authorization !== "Bearer sk-magpie-test") return void res.writeHead(401).end();
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ data: [{ id: "group/translate" }, { id: "openai/gpt-x" }] }));
		});
		await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(gw.address() as any).port}`;
		app.setConfig("magpie.url", url);
		assert.match((await router.registerMagpie()).error!, /401.*Services → magpie/);
		app.setSecret("magpie.api_key", "sk-magpie-test");
		const m = await router.registerMagpie();
		assert.deepEqual([m.url, m.ok, m.models, m.admin], [url, true, ["group/translate", "openai/gpt-x"], false]);
		assert.equal(rt.registered.magpie.baseUrl, `${url}/v1`);
		app.setConfig("models.roles", { chat: [], background: [], glossary: [], translate: ["magpie/group/translate"], review: [] });
		assert.equal((await router.complete("translate", "s", "u", { scope: "translation" })).model, "magpie/group/translate");
		gw.close();
	} finally {
		app.close();
	}
});

const SRT = Array.from({ length: 12 }, (_, i) => `${i + 1}\n00:00:${String(i * 2).padStart(2, "0")},000 --> 00:00:${String(i * 2 + 1).padStart(2, "0")},500\nLine ${i + 1}.\n`).join("\n");
const translate = (_s: string, user: string) => JSON.stringify({ lines: [...user.split("Translate:\n")[1]!.matchAll(/^(\d+)\|(.*)$/gm)].map((m) => ({ n: Number(m[1]), t: `FR ${m[2]}` })) });

test("translation job: started by the operation, run in the background, paused while the model is down, then finished and reported", async () => {
	const { app, downloads } = tempApp();
	let down = true;
	const rt = fakeRuntime({ "m/gloss": () => '{"tone":"plain","entries":[]}', "m/tr": (s, u) => (down ? new Error("budget exceeded for this gateway key") : translate(s, u)), "m/rev": () => '{"fixes":[]}' });
	const sent: string[] = [];
	const host: any = { runtime: rt, router: new ModelRouter(app, () => rt), spendToday: () => ({ reached: false }), getThread: (id: string) => app.db.prepare("SELECT * FROM threads WHERE id = ?").get(id), send: async (_id: string, text: string) => (sent.push(text), {}), globalListeners: new Set() };
	const jobs = new JobRunner(app, host);
	// The lines are the translator's: the built-in one, on the owner's models through the same router.
	const plugins = new PluginManager({ app, jobs, host, dirs: [], plugins: [MODEL_TRANSLATOR], model: host.router, stopGraceMs: 50 });
	app.plugins = plugins;
	await plugins.start();
	try {
		app.setConfig("language", "fr");
		app.setConfig("models.roles", { chat: [], background: [], glossary: ["m/gloss"], translate: ["m/tr"], review: ["m/rev"] });
		insertTitle(app, { id: "movie:45745", kind: "movie", tmdb_id: 45745, name: "Sintel", folder_name: "Sintel", year: 2010 });
		touch(`${downloads}/Sintel.2010.1080p/Sintel.2010.1080p.mkv`, 1000);
		applyPlan(app, autoPlan(app, getTitle(app, "movie:45745")!, `${downloads}/Sintel.2010.1080p`).plan);
		const video = videosOf(app, "movie:45745")[0]!.path;
		writeFileSync(video.replace(/\.mkv$/, ".en.srt"), SRT);
		app.db.prepare("INSERT INTO threads (id, name, kind, created_at, updated_at) VALUES ('t1', 'Sintel', 'chat', ?, ?)").run(nowIso(), nowIso());
		startTranslation({ app, host, jobs });

		const r = await runOperation(app, "subtitle.translate", { title_id: "movie:45745", target: "French", code: "fr", thread_id: "t1" }, { actor: "test" });
		const id = (r.output as any).id as string;
		assert.match(r.text, /Queued as tr_.*1 video\(s\), 12 lines/s);
		const run = () => app.db.prepare("SELECT * FROM job_runs WHERE kind = 'translate'").get() as any;
		const until = async (f: () => boolean) => {
			for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 25));
			assert.ok(f(), "timed out");
		};
		await jobs.tick();
		// The gateway refuses: paused, queued for later, one notice; not failed.
		await until(() => translationStatus(app, id).state === "paused");
		await until(() => run().state === "queued" && !!run().lease_until);
		assert.match(translationStatus(app, id).note!, /budget exceeded for this gateway key/);
		const notice = listInbox(app, {}).find((i: any) => /en pause/.test(i.title));
		assert.ok(notice, "a notice in the owner's language");
		assert.match(getInbox(app, notice!.id)!.body!, /budget exceeded/);
		assert.ok(new Date(run().lease_until) > new Date(Date.now() + 4 * 60_000), "tries again in about five minutes");

		// The budget is back: the job continues and reports in the conversation that asked.
		down = false;
		app.db.prepare("UPDATE job_runs SET lease_until = NULL WHERE kind = 'translate'").run();
		await jobs.tick();
		await until(() => run().state === "succeeded");
		const s = translationStatus(app, id);
		assert.equal(s.state, "succeeded");
		assert.match(readFileSync(s.items[0]!.placed!, "utf8"), /,FR Line 12\.\n$/);
		assert.match(run().summary, /French \(fr\), style plain: 1 of 1 video\(s\) done/);
		assert.equal(sent.length, 1);
		assert.match(sent[0]!, /Les sous-titres French sont prêts : Sintel[\s\S]*different model from the translator/);
		// The lines were spent under the translator plugin, the glossary and review under translation; neither is capped.
		const spend = Object.fromEntries((app.db.prepare("SELECT scope, tokens FROM spend").all() as { scope: string; tokens: number }[]).map((r) => [r.scope, r.tokens]));
		assert.deepEqual(spend, { translation: 200, "plugin:model-translator": 100 });
		assert.equal(plugins.list().find((p) => p.id === "model-translator")!.model!.reached, false);
	} finally {
		jobs.stop();
		await plugins.stop();
		app.close();
	}
});

test("model router: a model that never answers is cut off at the time limit and the next one is used", async () => {
	const { app } = tempApp();
	const rt: any = fakeRuntime({ "a/slow": () => "never", "b/fast": () => "ok" });
	const inner = rt.completeSimple;
	rt.completeSimple = (model: any, ctx: any, opts: any) => (model.id === "slow" ? new Promise((_r, reject) => opts.signal.addEventListener("abort", () => reject(new Error("Request was aborted")))) : inner(model, ctx, opts));
	const router = new ModelRouter(app, () => rt);
	try {
		app.setConfig("models.roles", { chat: [], background: [], glossary: [], translate: ["a/slow", "b/fast"], review: [] });
		app.setConfig("translation", { ...app.config.translation, call_timeout_s: 30 });
		// Shorten the clock: the config minimum is 30 s, so drive the timer directly.
		const realTimeout = AbortSignal.timeout;
		(AbortSignal as any).timeout = () => realTimeout.call(AbortSignal, 50);
		// AbortSignal.timeout does not keep Node running; the server always has other timers.
		const keep = setInterval(() => {}, 1000);
		try {
			const answer = await router.complete("translate", "s", "u", { scope: "translation" });
			assert.deepEqual([answer.text, answer.model, answer.skipped.map((f) => [f.model, f.class])], ["ok", "b/fast", [["a/slow", "timeout"]]]);
		} finally {
			(AbortSignal as any).timeout = realTimeout;
			clearInterval(keep);
		}
		assert.ok(router.isResting("a/slow"));
	} finally {
		app.close();
	}
});
