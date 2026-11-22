import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Reelix, getTitle, runOperation, titleSummary } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { startFakeTmdb } from "../../../packages/core/test/fakes/tmdb.ts";
import { tempApp } from "../../../packages/core/test/helpers.ts";
import { PAGE } from "./check.ts";

const PLUGIN = join(import.meta.dirname, "..");

async function world(page = PAGE) {
	const w = tempApp();
	const tmdb = await startFakeTmdb();
	w.app.setConfig("tmdb.base_url", tmdb.url);
	w.app.setSecret("tmdb.api_key", tmdb.apiKey);
	w.app.setConfig("language", "en");
	// TMDB is a real server here; only Douban's page is a recorded answer.
	const t = await startPlugins([PLUGIN], { app: w.app, http: [{ url: "https://movie.douban.com/subject/35593344/", body: page }, { url: "https://movie.douban.com/subject/1/", status: 403, body: "" }] });
	const run = (name: string, input: unknown) => runOperation(w.app, name, input, { actor: "agent:test" });
	return {
		...w,
		t,
		run,
		async close() {
			await t.close();
			w.app.close();
			await tmdb.close();
		},
	};
}

test("a Douban link settles the title by its IMDb ID; the Douban ID and rating are merged in, TMDB's name stays", async () => {
	const w = await world();
	try {
		const o = (await w.run("title.find", { query: "https://movie.douban.com/subject/35593344/" })).output as { resolved?: { id: string; name: string; douban_id: string; ratings: Record<string, { value: number; label: string }> }; how: string };
		assert.equal(o.resolved?.id, "movie:872585");
		assert.equal(o.how, "Douban (douban) → IMDb ID");
		assert.equal(o.resolved?.name, "Oppenheimer", "TMDB wins on the name");
		assert.equal(o.resolved?.douban_id, "35593344");
		assert.deepEqual([o.resolved?.ratings.douban?.value, o.resolved?.ratings.douban?.label], [8.8, "Douban (douban)"]);
		assert.match(titleSummary(getTitle(w.app, "movie:872585")!), /, Douban \(douban\) 8\.8/);
		const refused = (await w.run("title.find", { query: "douban:1" })).output as { candidates: unknown[]; note: string };
		assert.deepEqual(refused.candidates, []);
		assert.match(refused.note, /Could not read the Douban page \(HTTP 403\)/);
		assert.equal(w.t.info("douban").failures, 0, "a refused page is an outcome");
	} finally {
		await w.close();
	}
});

test("douban.rating: the plugin's operation records the rating through title.enrich; without a Douban ID it says where one comes from", async () => {
	const w = await world(PAGE.replace(">8.8<", ">9.0<"));
	try {
		await w.run("title.find", { id: "movie:872585" });
		await assert.rejects(w.run("douban.rating", { title_id: "movie:872585" }), /No Douban ID yet/);
		const r = await w.run("douban.rating", { title_id: "movie:872585", douban_id: "35593344" });
		assert.equal(r.text, "Oppenheimer (2023): Douban 35593344 9");
		assert.equal(getTitle(w.app, "movie:872585")!.ratings.douban?.value, 9);
		await assert.rejects(w.run("douban.rating", { title_id: "movie:872585", douban_id: "1" }), /Douban page unavailable/);
		const ledger = w.app.db.prepare("SELECT op, actor FROM actions WHERE actor = 'plugin:douban' ORDER BY id").all() as { op: string }[];
		assert.ok(ledger.some((a) => a.op === "title.enrich"), "the plugin runs core's title.enrich, recorded under its name");
	} finally {
		await w.close();
	}
});

test("an old database's Douban rating becomes the title's rating from the source douban", () => {
	const w = tempApp();
	const data = w.app.paths.root;
	w.app.db.exec("ALTER TABLE titles DROP COLUMN ratings_json; ALTER TABLE titles ADD COLUMN douban_rating REAL; ALTER TABLE titles DROP COLUMN original_language; ALTER TABLE titles DROP COLUMN origin_country_json; ALTER TABLE titles DROP COLUMN genres_json; ALTER TABLE titles DROP COLUMN library_choice; ALTER TABLE job_runs DROP COLUMN models_json; UPDATE schema_version SET v = 10;");
	w.app.db.prepare("INSERT INTO titles (id, kind, tmdb_id, media_class, name, douban_id, douban_rating, updated_at) VALUES ('movie:872585', 'movie', 872585, 'movie', 'Oppenheimer', '35593344', 8.8, '2026-11-01T00:00:00Z'), ('movie:45745', 'movie', 45745, 'movie', 'Sintel', NULL, NULL, '2026-11-01T00:00:00Z')").run();
	w.app.close();
	const app = new Reelix(data);
	try {
		assert.deepEqual(getTitle(app, "movie:872585")!.ratings, { douban: { value: 8.8, scale: 10, label: "Douban", at: "2026-11-01T00:00:00Z" } });
		assert.deepEqual(getTitle(app, "movie:45745")!.ratings, {});
		assert.equal((app.db.prepare("SELECT COUNT(*) n FROM pragma_table_info('titles') WHERE name = 'douban_rating'").get() as { n: number }).n, 0, "the old column is gone");
	} finally {
		app.close();
	}
});
