import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { type Operation, reconcileOnStartup, runOperation } from "../src/registry.ts";
import { ReelixError } from "../src/util.ts";
import { tempApp as emptyApp } from "./helpers.ts";

let runs = 0;
let world = new Set<string>();
const TEST_ADD = {
	name: "test.add",
	summary: "test",
	effect: "write",
	input: Type.Object({ thing: Type.String(), fail: Type.Optional(Type.Boolean()), timeout: Type.Optional(Type.Boolean()) }),
	async run(_ctx, i: any) {
		runs++;
		if (i.fail) throw new ReelixError("refused", "no");
		world.add(i.thing);
		if (i.timeout) throw new ReelixError("network_timeout", "slow");
		return { added: i.thing };
	},
	async reconcile(_ctx, i: any) {
		return world.has(i.thing) ? { status: "succeeded", output: { added: i.thing, reconciled: true } } : { status: "failed" };
	},
} satisfies Operation<any>;

function tempApp() {
	const t = emptyApp();
	t.app.operations.add(TEST_ADD);
	return t;
}

test("same request id returns the first result without running again", async () => {
	const { app } = tempApp();
	runs = 0;
	const a = await runOperation(app, "test.add", { thing: "x" }, { actor: "owner:cli", requestId: "r1" });
	const b = await runOperation(app, "test.add", { thing: "x" }, { actor: "owner:cli", requestId: "r1" });
	assert.equal(runs, 1);
	assert.equal(b.repeated, true);
	assert.deepEqual(b.output, a.output);
	// a new request for the same thing runs
	await runOperation(app, "test.add", { thing: "x" }, { actor: "owner:cli", requestId: "r2" });
	assert.equal(runs, 2);
	app.close();
});

test("timeouts leave 'unknown'; reconcile settles them; failures are recorded", async () => {
	const { app } = tempApp();
	world = new Set();
	await assert.rejects(runOperation(app, "test.add", { thing: "y", timeout: true }, { actor: "agent:t1", requestId: "r3" }));
	assert.equal((app.db.prepare("SELECT status FROM actions WHERE request_id = 'r3'").get() as any).status, "unknown");
	// a retry of the same request reconciles instead of adding twice
	const before = runs;
	const r = await runOperation(app, "test.add", { thing: "y", timeout: true }, { actor: "agent:t1", requestId: "r3" });
	assert.equal(runs, before);
	assert.equal((r.output as any).reconciled, true);

	await assert.rejects(runOperation(app, "test.add", { thing: "z", fail: true }, { actor: "owner:web", requestId: "r4" }));
	assert.equal((app.db.prepare("SELECT status FROM actions WHERE request_id = 'r4'").get() as any).status, "failed");
	await assert.rejects(runOperation(app, "test.add", { thing: "z", fail: true }, { actor: "owner:web", requestId: "r4" }), /already ran and failed/);
	app.close();
});

test("restart: pending entries become unknown and are reconciled", async () => {
	const { app } = tempApp();
	world = new Set(["w"]);
	app.db.prepare("INSERT INTO actions (request_id, op, effect, actor, input_json, status, started_at) VALUES ('r5', 'test.add', 'write', 'job:1', '{\"thing\":\"w\"}', 'pending', datetime('now'))").run();
	app.db.prepare("INSERT INTO actions (request_id, op, effect, actor, input_json, status, started_at) VALUES ('r6', 'test.add', 'write', 'job:1', '{\"thing\":\"never\"}', 'pending', datetime('now'))").run();
	const r = await reconcileOnStartup(app);
	assert.equal(r.settled, 2);
	const st = Object.fromEntries((app.db.prepare("SELECT request_id, status FROM actions").all() as any[]).map((x) => [x.request_id, x.status]));
	assert.deepEqual(st, { r5: "succeeded", r6: "failed" });
	app.close();
});

test("input is validated against the schema", async () => {
	const { app } = tempApp();
	await assert.rejects(runOperation(app, "test.add", {}, { actor: "owner:cli" }), /thing/);
	await assert.rejects(runOperation(app, "config.set", { path: "limits.nope", value: "1" }, { actor: "owner:cli" }), /no setting/);
	app.close();
});

test("the ledger never keeps a secret's value", async () => {
	const { app } = tempApp();
	await runOperation(app, "secret.set", { key: "plugins.jackett.api_key", value: "abcdef123456" }, { actor: "owner:cli", requestId: "s1" });
	assert.equal(app.secrets["plugins.jackett.api_key"], "abcdef123456");
	const row = app.db.prepare("SELECT input_json FROM actions WHERE request_id = 's1'").get() as { input_json: string };
	assert.deepEqual(JSON.parse(row.input_json), { key: "plugins.jackett.api_key", value: "[secret]" });
	app.close();
});

test("secrets are blanked from text", () => {
	const { app } = tempApp();
	app.setSecret("plugins.jackett.api_key", "abcdef123456");
	assert.equal(app.redact("key=abcdef123456 and http://x/dl?apikey=zzz&file=1"), "key=[secret:plugins.jackett.api_key] and http://x/dl?apikey=[redacted]&file=1");
	app.close();
});
