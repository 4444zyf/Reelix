import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { listInbox } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { JobRunner } from "@reelix/server/jobs.ts";
import { PluginManager } from "@reelix/server/plugins/manager.ts";
import { tempApp } from "../../../../packages/core/test/helpers.ts";

const PLUGIN = join(import.meta.dirname, "..");

test("below the limit one notice is added and repeats do not pile up; the rate limit holds", async () => {
	const w = tempApp();
	const t = await startPlugins([PLUGIN], { app: w.app, settings: { "low-space": { min_free_gb: 1_000_000_000 } } });
	try {
		assert.equal(t.info("low-space").state, "active");
		assert.ok(w.app.db.prepare("SELECT id FROM jobs WHERE id = 'plugin:low-space:check' AND schedule = 'every 60m'").get(), "it repeats");
		const first = await t.runJob("low-space.check");
		assert.equal(first.state, "succeeded");
		assert.match(first.summary!, /told/);
		await t.runJob("low-space.check");
		assert.equal(listInbox(w.app).length, 1, "one open notice per key");
		for (let i = 0; i < 4; i++) await t.runJob("low-space.check");
		assert.match((await t.runJob("low-space.check")).summary!, /too many/, "at most five notices an hour");
		await t.manager.disable("low-space");
		assert.equal(w.app.db.prepare("SELECT id FROM jobs WHERE id = 'plugin:low-space:check'").get(), undefined, "switching off removes the schedule");
	} finally {
		await t.close();
		w.app.close();
	}
});

test("plugins/examples is found, off by default, and can be switched on for good", async () => {
	const w = tempApp();
	const jobs = new JobRunner(w.app, {} as never);
	const start = async () => {
		const m = new PluginManager({ app: w.app, jobs, host: { globalListeners: new Set() } as never, dirs: [join(PLUGIN, "../..")], stopGraceMs: 10 });
		w.app.plugins = m;
		await m.start();
		return m;
	};
	const state = (m: PluginManager) => m.list().find((p) => p.id === "low-space")!.state;
	let m = await start();
	try {
		assert.equal(state(m), "disabled");
		assert.equal((await m.enable("low-space")).state, "active");
		await m.stop();
		m = await start();
		assert.equal(state(m), "active", "it stays on after a restart");
		await m.disable("low-space");
		await m.stop();
		m = await start();
		assert.equal(state(m), "disabled");
	} finally {
		await m.stop();
		w.app.close();
	}
});
