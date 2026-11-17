import assert from "node:assert/strict";
import { test } from "node:test";
import { addInbox, answerInbox, nowIso } from "@reelix/core";
import { tempApp } from "../../core/test/helpers.ts";
import { JobRunner, nextRunAt } from "../src/jobs.ts";
import { webApp } from "../src/http.ts";

/** A stand-in for the pi host: scripted agent turns, no model. */
function stubHost(app: any, script: (prompt: string, threadId: string) => { state: string; text: string; parkedOn?: string }) {
	const threads = new Map<string, any>();
	const prompts: string[] = [];
	let spend = { reached: false };
	return {
		prompts,
		setCap(v: boolean) {
			spend = { reached: v };
		},
		runtime: {},
		spendToday: () => ({ usd: 0, tokens: 0, capUsd: 1, capTokens: 1, ...spend }),
		createThread(name: string, kind: string, extra: any = {}) {
			const id = `t${threads.size + 1}`;
			const row = { id, name, kind, job_run_id: extra.job_run_id ?? null, session_file: null };
			threads.set(id, row);
			app.db.prepare("INSERT INTO threads (id, name, kind, job_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, kind, row.job_run_id, nowIso(), nowIso());
			return row;
		},
		getThread: (id: string) => app.db.prepare("SELECT * FROM threads WHERE id = ?").get(id),
		unload() {},
		async runToEnd(threadId: string, prompt: string) {
			prompts.push(prompt);
			return script(prompt, threadId);
		},
		globalListeners: new Set(),
	};
}

async function settle(app: any, id: string, want: string[]) {
	for (let i = 0; i < 100; i++) {
		const s = (app.db.prepare("SELECT state FROM job_runs WHERE id = ?").get(id) as any).state;
		if (want.includes(s)) return s;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("job did not settle");
}

test("a job parks on a question and resumes in the same conversation when answered", async () => {
	const { app } = tempApp();
	let inboxId = "";
	const host = stubHost(app, (prompt) => {
		if (prompt.startsWith("The owner answered")) return { state: "done", text: "Swapped the release." };
		inboxId = addInbox(app, { kind: "question", title: "Swap the stalled release?", options: ["Swap", "Wait"] }).id;
		return { state: "done", text: "Asked the owner.", parkedOn: inboxId };
	});
	const jobs = new JobRunner(app, host as any);
	const id = jobs.enqueue("agent", { prompt: "do the thing", title: "thing" });
	await jobs.tick();
	assert.equal(await settle(app, id, ["parked", "failed"]), "parked");
	app.db.prepare("UPDATE inbox SET job_run_id = ? WHERE id = ?").run(id, inboxId);
	answerInbox(app, inboxId, "Swap", "owner:telegram");
	assert.equal(await settle(app, id, ["succeeded", "failed"]), "succeeded");
	assert.match(host.prompts[1]!, /The owner answered your question "Swap the stalled release\?": Swap/);
	const threads = app.db.prepare("SELECT * FROM threads WHERE job_run_id = ?").all(id);
	assert.equal(threads.length, 1, "resumed in the same thread");
	app.close();
});

test("spending cap: model work waits for tomorrow and one notice says so", async () => {
	const { app } = tempApp();
	const host = stubHost(app, () => ({ state: "done", text: "x" }));
	host.setCap(true);
	const jobs = new JobRunner(app, host as any);
	const a = jobs.enqueue("agent", { prompt: "a" });
	const b = jobs.enqueue("agent", { prompt: "b" });
	await jobs.tick();
	await new Promise((r) => setTimeout(r, 100));
	const rows = app.db.prepare("SELECT state, lease_until FROM job_runs WHERE id IN (?, ?)").all(a, b) as any[];
	assert.ok(rows.every((r) => r.state === "queued" && r.lease_until > nowIso()), "queued for later");
	assert.equal((app.db.prepare("SELECT COUNT(*) n FROM inbox WHERE title LIKE '%spending cap%'").get() as any).n, 1);
	assert.equal(host.prompts.length, 0, "no model call");
	app.close();
});

test("restart: a run left 'running' is taken up again; dedupe keys prevent double queuing", async () => {
	const { app } = tempApp();
	const host = stubHost(app, () => ({ state: "done", text: "ok" }));
	app.db.prepare("INSERT INTO job_runs (id, kind, payload_json, state, attempts, created_at) VALUES ('j1', 'agent', '{\"prompt\":\"p\"}', 'running', 1, ?)").run(nowIso());
	const jobs = new JobRunner(app, host as any);
	assert.equal(jobs.enqueue("agent", { prompt: "x" }, { dedupe: "k" }), jobs.enqueue("agent", { prompt: "x" }, { dedupe: "k" }));
	jobs.start();
	assert.equal((app.db.prepare("SELECT state FROM job_runs WHERE id = 'j1'").get() as any).state, "queued");
	await jobs.tick();
	assert.equal(await settle(app, "j1", ["succeeded"]), "succeeded");
	jobs.stop();
	app.close();
});

test("schedules", () => {
	const from = new Date("2026-11-17T10:00:00");
	assert.equal(new Date(nextRunAt("daily 03:30", from)).getHours(), 3);
	assert.ok(new Date(nextRunAt("daily 03:30", from)) > from);
	assert.equal(Date.parse(nextRunAt("every 10m", from)) - from.getTime(), 600_000);
});

test("web API: first-run password, login, cookie, cross-site refusal, rate limit", async () => {
	const { app } = tempApp();
	const deps = { app, host: { listThreads: () => [] } as any, jobs: {} as any, telegram: {} as any };
	const api = webApp(deps);
	const req = (path: string, init: RequestInit = {}) => api.request(`http://reelix.local${path}`, { ...init, headers: { host: "reelix.local", "content-type": "application/json", ...(init.headers as any) } });
	assert.deepEqual(await (await req("/api/session")).json(), { authenticated: false, needsPassword: true });
	assert.equal((await req("/api/threads")).status, 401);
	const setup = await req("/api/setup-password", { method: "POST", body: JSON.stringify({ password: "correct horse" }) });
	const cookie = setup.headers.get("set-cookie")!;
	assert.match(cookie, /HttpOnly; SameSite=Strict/);
	const c = cookie.split(";")[0]!;
	assert.equal((await req("/api/threads", { headers: { cookie: c } })).status, 200);
	assert.equal((await req("/api/op/config.show", { method: "POST", body: "{}", headers: { cookie: c, origin: "http://evil.example" } })).status, 403);
	assert.equal((await req("/api/op/config.show", { method: "POST", body: "{}", headers: { cookie: c, origin: "http://reelix.local" } })).status, 200);
	assert.equal((await req("/api/setup-password", { method: "POST", body: JSON.stringify({ password: "again again" }) })).status, 409);
	for (let i = 0; i < 5; i++) assert.equal((await req("/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }), headers: { "x-forwarded-for": "9.9.9.9" } })).status, 401);
	assert.equal((await req("/api/login", { method: "POST", body: JSON.stringify({ password: "correct horse" }), headers: { "x-forwarded-for": "9.9.9.9" } })).status, 429);
	assert.equal((await req("/api/login", { method: "POST", body: JSON.stringify({ password: "correct horse" }), headers: { "x-forwarded-for": "1.1.1.1" } })).status, 200);
	app.close();
});
