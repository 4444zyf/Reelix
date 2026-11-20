import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { getTitle, runOperation } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { startFakeTmdb } from "../../../packages/core/test/fakes/tmdb.ts";
import { tempApp } from "../../../packages/core/test/helpers.ts";
import { FRIEREN, startFakeBangumi } from "./fake-bangumi.ts";

const PLUGIN = join(import.meta.dirname, "..");

async function world() {
	const w = tempApp();
	const tmdb = await startFakeTmdb();
	const bgm = await startFakeBangumi();
	w.app.setConfig("tmdb.base_url", tmdb.url);
	w.app.setSecret("tmdb.api_key", tmdb.apiKey);
	w.app.setConfig("language", "en");
	const t = await startPlugins([PLUGIN], { app: w.app, settings: { bangumi: { base_url: bgm.url } } });
	const run = (name: string, input: unknown) => runOperation(w.app, name, input, { actor: "agent:test" });
	return {
		...w,
		bgm,
		t,
		run,
		async close() {
			await t.close();
			w.app.close();
			await tmdb.close();
			await bgm.close();
		},
	};
}

test("anime.map: Bangumi's entry found by name lines up with TMDB's season by air date, and is linked to the title", async () => {
	const w = await world();
	try {
		await w.run("title.find", { id: "tv:209867" });
		await w.run("title.set", { id: "tv:209867", media_class: "anime" });
		const r = (await w.run("anime.map", { title_id: "tv:209867" })).output as { mappings: { bangumi_id: number; bgm_from: number; bgm_to: number; tmdb_season: number; tmdb_start: number }[]; notes: string[] };
		assert.deepEqual(r.mappings.map((m) => [m.bangumi_id, m.bgm_from, m.bgm_to, m.tmdb_season, m.tmdb_start]), [[FRIEREN.id, 1, 28, 1, 1]], "the TV entry only: the film is not a season");
		assert.deepEqual(r.notes, []);
		assert.deepEqual(getTitle(w.app, "tv:209867")!.bangumi_ids, [FRIEREN.id]);
		assert.ok(w.bgm.requests.some((x) => x.startsWith("POST /v0/search/subjects")), "searched by name");
		assert.ok(w.bgm.requests.some((x) => x.startsWith(`GET /v0/episodes?subject_id=${FRIEREN.id}&type=0`)), "main episodes only");
		assert.equal((await w.run("anime.resolve", { title_id: "tv:209867", episode: 12 })).text, "S1E12 (Bangumi 400602 mapping)");
		assert.equal(w.t.info("bangumi").failures, 0);
	} finally {
		await w.close();
	}
});

test("a Bangumi link resolves through TMDB, links the entry, and tells the agent what Bangumi says", async () => {
	const w = await world();
	try {
		const r = await w.run("title.find", { query: `https://bgm.tv/subject/${FRIEREN.id}` });
		const o = r.output as { resolved?: { id: string; bangumi_ids: number[] }; note: string };
		assert.equal(o.resolved?.id, "tv:209867");
		assert.deepEqual(o.resolved?.bangumi_ids, [FRIEREN.id]);
		assert.match(o.note, /Bangumi \(bangumi\) entry: 葬送のフリーレン \/ 葬送的芙莉莲 \(2023\), 28 episodes\. Bangumi has one entry per season/);
		assert.match(((await w.run("title.find", { query: "bangumi:999" })).output as { note: string }).note, /^Bangumi \(bangumi\): Bangumi has no \/v0\/subjects\/999/, "no such entry: said, not guessed");
	} finally {
		await w.close();
	}
});

test("without the bangumi plugin, anime.map says what is missing", async () => {
	const w = tempApp();
	const tmdb = await startFakeTmdb();
	w.app.setConfig("tmdb.base_url", tmdb.url);
	w.app.setSecret("tmdb.api_key", tmdb.apiKey);
	const t = await startPlugins([], { app: w.app });
	try {
		await runOperation(w.app, "title.find", { id: "tv:209867" }, { actor: "agent:test" });
		const r = (await runOperation(w.app, "anime.map", { title_id: "tv:209867" }, { actor: "agent:test" })).output as { mappings: unknown[]; notes: string[] };
		assert.deepEqual(r.mappings, []);
		assert.match(r.notes[0]!, /No metadata source is running/);
	} finally {
		await t.close();
		w.app.close();
		await tmdb.close();
	}
});
