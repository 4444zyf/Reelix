import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { TranslationPaused, runOperation } from "@reelix/core";
import { tempApp } from "../../core/test/helpers.ts";
import { AgentHost, REPO_ROOT } from "../src/agent/host.ts";
import { JobRunner } from "../src/jobs.ts";
import { ModelRouter, ModelsUnavailable, classifyFailure, modelTestOperation } from "../src/models.ts";

/**
 * Why a model failed, and what Reelix does next (docs/models.md, "Why a call failed"): the classes,
 * the reason recorded with each fallback, never a model outside the role's list, and `model.test`.
 */

/** A stand-in for pi's model runtime: models answer by a script, keyed by "provider/id". */
function fakeRuntime(script: Record<string, () => string | Error>, defaults: string[] = []) {
	const calls: string[] = [];
	const model = (spec: string) => ({ provider: spec.split("/")[0], id: spec.split("/").slice(1).join("/") });
	return {
		calls,
		getModel: (provider: string, id: string) => (script[`${provider}/${id}`] ? { provider, id } : undefined),
		getAvailableSnapshot: () => defaults.map(model),
		async completeSimple(m: any) {
			const spec = `${m.provider}/${m.id}`;
			calls.push(spec);
			const r = script[spec]!();
			if (r instanceof Error) return { stopReason: "error", errorMessage: r.message, content: [] };
			return { stopReason: "stop", content: [{ type: "text", text: r }], usage: { totalTokens: 10, cost: { total: 0.0001 } } };
		},
	};
}

const roles = (r: Partial<Record<"chat" | "background" | "glossary" | "translate" | "review", string[]>>) => ({ chat: [], background: [], glossary: [], translate: [], review: [], ...r });

test("model failures: each class from what providers really say, with its action and, where named, the time to wait until", () => {
	const now = Date.parse("2026-11-22T10:00:00Z");
	const c = (m: string, o: { reset?: string } = {}) => classifyFailure(m, { now, ...o });
	const cases: [string, string, string, string?][] = [
		['401 {"error":{"message":"Incorrect API key provided: sk-ab***cd.","type":"invalid_request_error","code":"invalid_api_key"}}', "signed_out", "reconnect"],
		["No API key for anthropic/claude-sonnet-4", "signed_out", "reconnect"],
		["Your refresh token has expired. Please log in again.", "signed_out", "reconnect"],
		["the gateway answered 403 (it wants a gateway key: add magpie.api_key under Settings → Secrets)", "signed_out", "reconnect"],
		["no answer within 300 s (a reasoning model may need its thinking switched off for this role)", "timeout", "retry"],
		["Request timed out.", "timeout", "retry"],
		["429 Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 6s.", "rate_limited", "wait", "2026-11-22T10:00:06.000Z"],
		['529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "rate_limited", "wait"],
		["Quota exceeded for quota metric 'Generate Content API requests per minute'", "rate_limited", "wait"],
		["429 You exceeded your current quota, please check your plan and billing details.", "budget", "wait"],
		["magpie: this gateway key's spending limit is reached (day $1.00); resets at 2026-11-23T00:00:00Z", "budget", "wait", "2026-11-23T00:00:00.000Z"],
		["400 This model's maximum context length is 128000 tokens. However, your messages resulted in 130211 tokens.", "capability", "choose_model"],
		["Range of input length should be [1, 98304]", "capability", "choose_model"],
		['400 {"error":{"message":"Invalid content type. image_url is only supported by certain models."}}', "capability", "choose_model"],
		["500 Internal server error", "other", "retry"],
	];
	for (const [message, cls, action, until] of cases) {
		const f = c(message);
		assert.deepEqual([f.class, f.action, f.until], [cls, action, until], message);
		assert.equal(f.message, message);
	}
	assert.equal(c("400 This model's maximum context length is 8192 tokens").capability, "context");
	assert.equal(c("This model does not support image input").capability, "images");
	// A budget refusal that names no time waits for the renewal known from elsewhere (magpie's limit).
	assert.equal(c("out of budget", { reset: "2026-11-23T00:00:00.000Z" }).until, "2026-11-23T00:00:00.000Z");
});

test("model router: the reason is recorded with each failed model, the answer names the ones skipped, and no model outside the role's list is ever used", async () => {
	const { app } = tempApp();
	const rt = fakeRuntime({ "a/limited": () => new Error("429 Too Many Requests: please retry after 120 seconds"), "b/good": () => "hello", "pi/default": () => "from the default", "c/other": () => "outside" }, ["pi/default"]);
	const router = new ModelRouter(app, () => rt);
	try {
		app.setConfig("models.roles", roles({ chat: ["a/limited", "b/good"] }));
		const a = await router.complete("chat", "s", "u", { scope: "chat" });
		assert.equal(a.model, "b/good");
		assert.deepEqual(a.skipped.map((f) => [f.model, f.class, f.action]), [["a/limited", "rate_limited", "wait"]]);
		const rest = router.describe().rests.find((r) => r.model === "a/limited")!;
		assert.equal(rest.class, "rate_limited");
		assert.ok(Date.parse(rest.until) >= Date.now() + 110_000, "rests at least until the time the provider named");
		assert.equal(router.pick("chat")!.spec, "b/good", "the next conversation starts on the next model");

		// Every model of the list fails: nothing outside it is tried, not pi's default and not another known model.
		app.setConfig("models.roles", roles({ chat: ["a/limited", "z/unknown"] }));
		rt.calls.length = 0;
		await assert.rejects(router.complete("chat", "s", "u", { scope: "chat" }), (e: any) => {
			assert.ok(e instanceof ModelsUnavailable && e instanceof TranslationPaused, "still a pause for translation");
			// The resting model is asked last.
			assert.deepEqual(e.failures.map((f: any) => [f.model, f.class]), [["z/unknown", "signed_out"], ["a/limited", "rate_limited"]]);
			return true;
		});
		assert.deepEqual(rt.calls, ["a/limited"]);
		assert.equal(router.pick("chat")!.spec, "a/limited", "a resting model of the list, never one outside it");
		app.setConfig("models.roles", roles({ chat: ["z/unknown"] }));
		assert.throws(() => router.pick("chat"), /None of the models set for "chat"/);
		rt.calls.length = 0;
		await assert.rejects(router.complete("chat", "s", "u", { scope: "chat" }), ModelsUnavailable);
		assert.deepEqual(rt.calls, [], "an unknown model is not replaced by pi's default");

		// Only a role with no list of its own (and nothing to inherit) uses pi's default.
		app.setConfig("models.roles", roles({}));
		assert.equal(router.pick("chat"), undefined);
		assert.equal((await router.complete("chat", "s", "u", { scope: "chat" })).model, "pi/default");
	} finally {
		app.close();
	}
});

test("model.test: the answer, the model and the time; a failure comes back with its class", async () => {
	const { app } = tempApp();
	const rt = fakeRuntime({ "a/expired": () => new Error("401 Unauthorized: token has expired"), "b/good": () => " Hello! " });
	const router = new ModelRouter(app, () => rt);
	app.operations.add(modelTestOperation(router));
	try {
		app.setConfig("models.roles", roles({ chat: ["a/expired", "b/good"], translate: ["a/expired"] }));
		const ok = await runOperation(app, "model.test", {}, { actor: "owner:web" });
		const o = ok.output as any;
		assert.deepEqual([o.ok, o.role, o.model, o.answer], [true, "chat", "b/good", "Hello!"]);
		assert.equal(typeof o.ms, "number");
		assert.deepEqual(o.skipped.map((f: any) => [f.model, f.class, f.action]), [["a/expired", "signed_out", "reconnect"]]);
		assert.match(ok.text, /b\/good answered in [\d.]+ s: Hello!/);
		assert.equal(app.db.prepare("SELECT tokens FROM spend WHERE scope = 'chat'").get()!.tokens, 10, "counted as chat");

		const bad = (await runOperation(app, "model.test", { role: "translate" }, { actor: "owner:web" })).output as any;
		assert.deepEqual([bad.ok, bad.role, bad.failures.map((f: any) => [f.model, f.class, f.action])], [false, "translate", [["a/expired", "signed_out", "reconnect"]]]);
		// Read-only: the agent may run it too.
		assert.equal(app.operations.get("model.test")!.effect, "read");
	} finally {
		app.close();
	}
});

/** Two models behind an OpenAI-compatible address: "bad" refuses the key, "good" answers. */
async function twoModels() {
	const asked: string[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const r = JSON.parse(body);
			asked.push(r.model);
			if (r.model === "bad") {
				res.writeHead(401, { "content-type": "application/json" });
				return void res.end(JSON.stringify({ error: { message: "Incorrect API key provided: sk-te***st.", type: "invalid_request_error", code: "invalid_api_key" } }));
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: r.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			chunk({ role: "assistant", content: "Done." });
			chunk({}, "stop");
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, asked, close: () => (server.closeAllConnections(), server.close()) };
}

test("a failing chat model: the conversation says why, and the next answer from the role's next model names it; a job records both", async () => {
	const { app, root } = tempApp();
	const model = await twoModels();
	const piDir = join(root, "pi");
	mkdirSync(piDir, { recursive: true });
	writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: model.url, api: "openai-completions", apiKey: "local", models: [{ id: "bad" }, { id: "good" }] } } }));
	app.setConfig("models.roles", roles({ chat: ["fake/bad", "fake/good"] }));
	const host = new AgentHost(app, { piDir, binDir: join(REPO_ROOT, "bin"), skillsDir: join(REPO_ROOT, "skills"), notify: async () => "in_1" });
	await host.init();
	const jobs = new JobRunner(app, host);
	try {
		const chat = host.createThread("chat");
		const first = await host.runToEnd(chat.id, "hello");
		assert.deepEqual([first.model, first.failure?.class, first.failure?.action], ["fake/bad", "signed_out", "reconnect"]);
		const events = host.subscribe(chat.id, 0, () => {}).backlog;
		assert.equal((events.find((e) => e.type === "assistant_end") as any).failure.class, "signed_out", "shown live");
		let h = host.history(chat.id);
		const failed = h.find((m) => m.role === "assistant")! as any;
		assert.deepEqual([failed.model, failed.failure.class], ["fake/bad", "signed_out"], "and after a reload");

		const second = await host.runToEnd(chat.id, "again");
		assert.deepEqual([second.model, second.failure, second.text], ["fake/good", undefined, "Done."]);
		const start = host.subscribe(chat.id, 0, () => {}).backlog.filter((e) => e.type === "assistant_start").at(-1) as any;
		assert.deepEqual([start.model, start.fallback?.model, start.fallback?.class], ["fake/good", "fake/bad", "signed_out"], "the note names the failed model, live");
		h = host.history(chat.id);
		const answered = h.filter((m) => m.role === "assistant").at(-1) as any;
		assert.deepEqual([answered.model, answered.fallback?.model, answered.fallback?.class], ["fake/good", "fake/bad", "signed_out"], "and in the saved conversation");
		assert.deepEqual([...new Set(model.asked)], ["bad", "good"], "only the role's models were asked");

		// A background job: the first model fails, the next takes the task over; the job record says so.
		host.router.ok("fake/bad");
		const id = jobs.enqueue("agent", { prompt: "do it", title: "test" });
		await jobs.tick();
		let run: any;
		for (let i = 0; i < 200 && !["succeeded", "failed"].includes((run = app.db.prepare("SELECT * FROM job_runs WHERE id = ?").get(id) as any)?.state); i++) await new Promise((r) => setTimeout(r, 25));
		assert.equal(run.state, "succeeded");
		const record = JSON.parse(run.models_json);
		assert.equal(record.model, "fake/good");
		assert.deepEqual(record.failures.map((f: any) => [f.model, f.class, f.action]), [["fake/bad", "signed_out", "reconnect"]]);
	} finally {
		jobs.stop();
		host.dispose();
		model.close();
		app.close();
	}
});

test("a model refused before any answer (no key): the turn is saved, the page's stream follows the next model's answer, and the note names the refusal", async () => {
	const { app, root } = tempApp();
	const model = await twoModels();
	const piDir = join(root, "pi");
	mkdirSync(piDir, { recursive: true });
	writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: { nokey: { baseUrl: model.url, api: "openai-completions", models: [{ id: "m" }] }, fake: { baseUrl: model.url, api: "openai-completions", apiKey: "local", models: [{ id: "good" }] } } }));
	app.setConfig("models.roles", roles({ chat: ["nokey/m", "fake/good"] }));
	const host = new AgentHost(app, { piDir, binDir: join(REPO_ROOT, "bin"), skillsDir: join(REPO_ROOT, "skills"), notify: async () => "in_1" });
	await host.init();
	try {
		const chat = host.createThread("chat");
		const seen: any[] = [];
		await host.load(chat.id); // as the page's event route does
		host.subscribe(chat.id, 0, (e) => seen.push(e));
		const first = await host.runToEnd(chat.id, "hello");
		assert.deepEqual([first.state, first.failure?.class], ["failed", "signed_out"]);
		const second = await host.runToEnd(chat.id, "again");
		assert.deepEqual([second.state, second.model, second.text], ["done", "fake/good", "Done."]);
		const start = seen.filter((e) => e.type === "assistant_start").at(-1);
		assert.deepEqual([start?.model, start?.fallback?.model], ["fake/good", "nokey/m"], "the stream opened before the refusal sees the next model's answer");
		const seqs = seen.map((e) => e.seq);
		assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "event numbers go on, not from 1 again");
		host.unload(chat.id);
		const h = host.history(chat.id) as any[];
		assert.deepEqual(
			h.map((m) => [m.role, m.text, m.failure?.class, m.fallback?.model]),
			[["user", "hello", undefined, undefined], ["assistant", "", "signed_out", undefined], ["user", "again", undefined, undefined], ["assistant", "Done.", undefined, "nokey/m"]],
			"after a reload: the refused turn, its failure, and the note on the answer",
		);
		assert.deepEqual(model.asked, ["good"], "the refused model was never sent anything");
	} finally {
		host.dispose();
		model.close();
		app.close();
	}
});
