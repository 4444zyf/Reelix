import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recordSpend, runOperation, spentToday } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";

/** Findings of the review of phases 3 to 8 that are not the process's isolation (plugin-hostile.test.ts has that). */

function pluginDir(root: string, id: string, reelix: Record<string, unknown>, source: string): string {
	const dir = join(root, id);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `p-${id}`, version: "1.0.0", type: "module", reelix: { api: 0, id, entry: "./src/index.ts", ...reelix } }));
	writeFileSync(join(dir, "src/index.ts"), source);
	return dir;
}

const SPENDER = `import { Type, definePlugin } from "@reelix/plugin";
export default definePlugin({
	async activate(ctx) {
		await ctx.operation({
			name: "burst", summary: "Many model calls at once", effect: "read", input: Type.Object({ n: Type.Number() }),
			async run({ n }) {
				const answers = await Promise.all(Array.from({ length: n }, (_, i) => ctx.model.complete({ system: "s", user: "call " + i })));
				return answers.map((a) => a.outcome ?? "answered");
			},
		});
	},
});
`;

for (const runtime of ["process", "in-process"] as const) {
	test(`ctx.model: concurrent calls cannot spend past the daily budget (${runtime})`, async () => {
		const root = mkdtempSync(join(tmpdir(), "reelix-budget-"));
		const dir = pluginDir(root, "spender", { runtime, uses: { model: true, operations: { burst: "read" } } }, SPENDER);
		const t = await startPlugins([dir]);
		try {
			t.app.setConfig("limits.plugin_daily_usd", 0.05);
			let inFlight = 0;
			let most = 0;
			// Each answer costs $0.04, recorded when it arrives, as the router does.
			t.model.access.complete = async (_role, _system, _user, o) => {
				most = Math.max(most, ++inFlight);
				await new Promise((r) => setTimeout(r, 30));
				recordSpend(t.app, o.scope as never, { cost: { total: 0.04 } });
				inFlight--;
				return { text: "ok", model: "recorded/model" };
			};
			const out = (await runOperation(t.app, "spender.burst", { n: 6 }, { actor: "owner:web" })).output as string[];
			assert.equal(most, 1, "one call at a time");
			assert.deepEqual(out, ["answered", "answered", "unavailable", "unavailable", "unavailable", "unavailable"], "the budget is checked after the previous call recorded its spend");
			assert.ok(spentToday(t.app, "plugin:spender").usd <= 0.05 + 0.04, `spent ${spentToday(t.app, "plugin:spender").usd}`);
		} finally {
			await t.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

const ROUTER = `import { definePlugin } from "@reelix/plugin";
export default definePlugin({
	async activate(ctx) {
		await ctx.route("GET", "/item/:name", async (request) => ({ json: { name: request.params.name } }));
	},
});
`;

test("a route path with a broken %-escape is a 400, not a failure", async () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-route-"));
	const dir = pluginDir(root, "router", { runtime: "in-process" }, ROUTER);
	const t = await startPlugins([dir]);
	try {
		assert.deepEqual(await (await t.route("router", "GET", "/item/caf%C3%A9")).json(), { name: "café" });
		const res = await t.route("router", "GET", "/item/%E0%A4%A");
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { error: string }).error, /%-escape/);
		assert.equal(t.info("router").failures, 0);
	} finally {
		await t.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a download's hash: at least 6 hex characters, never a LIKE pattern, and one download only", async () => {
	const t = await startPlugins([]);
	try {
		const insert = t.app.db.prepare("INSERT INTO downloads (hash, title_id, name, state, added_at, downloader) VALUES (?, NULL, ?, 'downloading', '2026-01-01', 'qbittorrent')");
		insert.run("abcdef0000000000000000000000000000000001", "one");
		insert.run("abcdef0000000000000000000000000000000002", "two");
		for (const hash of ["%", "_", "a%", "abcde", "abcdef%", "abcdef_0"]) await assert.rejects(runOperation(t.app, "download.pause", { hash }, { actor: "owner:web" }), (e: any) => e.code === "invalid_input" && /not a hash/.test(e.message), hash);
		await assert.rejects(runOperation(t.app, "download.pause", { hash: "abcdef" }, { actor: "owner:web" }), (e: any) => e.code === "invalid_input" && /More than one download/.test(e.message));
	} finally {
		await t.close();
	}
});
