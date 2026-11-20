import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TranslationPaused } from "../src/subtitles/translate.ts";
import { fetchTitle } from "../src/titles.ts";
import { forgetWatchHistory, makeSuggestions, readSuggestions, suggestionsStale, trendingTitles, watchHistory } from "../src/trends.ts";
import { startFakeBangumi } from "../../../plugins/bangumi/test/fake-bangumi.ts";
import { startFakeJellyfin } from "../../../plugins/jellyfin/test/fake-jellyfin.ts";
import { startPlugins } from "@reelix/plugin-testing";
import { startFakeTmdb } from "./fakes/tmdb.ts";
import { PLUGINS, tempApp } from "./helpers.ts";

test("trends: TMDB's list in the owner's language, library titles marked", async () => {
	const tmdb = await startFakeTmdb();
	const { app } = tempApp();
	try {
		app.setConfig("tmdb.base_url", tmdb.url);
		app.setSecret("tmdb.api_key", tmdb.apiKey);
		app.setConfig("language", "en");
		const t = await fetchTitle(app, "movie", 872585);
		app.db.prepare("UPDATE titles SET library_folder = ? WHERE id = ?").run("/x/Oppenheimer (2023)", t.id);

		const week = await trendingTitles(app, "all", "week");
		assert.equal(week[0]!.name, "Oppenheimer");
		assert.equal(week[0]!.in_library, true);
		assert.ok(week.filter((w) => w.id !== t.id).every((w) => !w.in_library));
		const shows = await trendingTitles(app, "tv", "day");
		assert.ok(shows.length && shows.every((s) => s.kind === "tv"));
		const n = tmdb.requests.length;
		await trendingTitles(app, "all", "week");
		assert.equal(tmdb.requests.length, n, "kept for 30 minutes");
	} finally {
		app.close();
		await tmdb.close();
	}
});

test("for you: the model picks only among TMDB's candidates, never the library, and says why", async () => {
	const tmdb = await startFakeTmdb();
	const { app } = tempApp();
	try {
		app.setConfig("tmdb.base_url", tmdb.url);
		app.setSecret("tmdb.api_key", tmdb.apiKey);
		app.setConfig("language", "en");

		// nothing known yet: no model call
		let calls = 0;
		const s0 = await makeSuggestions(app, async () => {
			calls++;
			return { text: "{}", model: "m" };
		});
		assert.equal(s0.state, "nothing_known");
		assert.equal(calls, 0);

		writeFileSync(join(app.paths.notes, "preferences.md"), "- Loves hand-drawn animation and fantasy. Avoids war films.\n");
		const sintel = await fetchTitle(app, "movie", 45745);
		app.db.prepare("UPDATE titles SET library_folder = ? WHERE id = ?").run("/x/Sintel (2010)", sintel.id);
		assert.ok(await suggestionsStale(app, readSuggestions(app)), "new notes and a new title make the list stale");

		let prompt = "";
		const s = await makeSuggestions(app, async (system, user) => {
			prompt = `${system}\n${user}`;
			return {
				text: 'Here you go: {"picks":[{"id":"tv:209867","why":"Fantasy and animation, like Sintel."},{"id":"movie:45745","why":"already owned"},{"id":"movie:999","why":"made up"},{"id":"tv:209867","why":"twice"}]}',
				model: "fake/model",
			};
		});
		assert.match(prompt, /hand-drawn animation/, "the owner's notes go to the model");
		assert.match(prompt, /Sintel \(2010; movie/, "and the library");
		assert.match(prompt, /tv:209867 \| Frieren/, "TMDB's recommendations are candidates");
		assert.doesNotMatch(prompt.split("Candidates")[1]!, /movie:45745/, "the library is not suggested back");
		assert.equal(s.state, "ok");
		assert.deepEqual(
			s.items.map((i) => [i.id, i.reason]),
			[["tv:209867", "Fantasy and animation, like Sintel."]],
			"only offered candidates, once each",
		);
		assert.equal(readSuggestions(app)?.items.length, 1, "kept");
		assert.equal(await suggestionsStale(app, readSuggestions(app)), false);
		app.setConfig("language", "fr");
		assert.equal(await suggestionsStale(app, readSuggestions(app)), true, "another language makes a new list");

		const none = await makeSuggestions(app, async () => {
			throw new TranslationPaused('No model for "background" could answer.');
		});
		assert.equal(none.state, "no_model");
		const bad = await makeSuggestions(app, async () => ({ text: "I think you'd like Frieren", model: "m" }));
		assert.equal(bad.state, "failed");
	} finally {
		app.close();
		await tmdb.close();
	}
});

test("for you: the media server's watch history is the strongest signal, only the owner's, and watched titles are never suggested", async () => {
	const tmdb = await startFakeTmdb();
	const jf = await startFakeJellyfin({
		users: [{ name: "owner", admin: true }, { name: "kid" }, { name: "old", admin: true, disabled: true }],
		watch: [
			{ user: "owner", type: "Series", name: "Severance", year: 2022, tmdb: 95396, episodes: 9, favourite: true, last: "2026-11-10T20:00:00Z" },
			{ user: "owner", type: "Movie", name: "Oppenheimer", year: 2023, tmdb: 872585, plays: 2, last: "2026-11-01T20:00:00Z" },
			{ user: "kid", type: "Series", name: "Frieren: Beyond Journey's End", year: 2023, tmdb: 209867, episodes: 28, favourite: true, last: "2026-11-12T16:00:00Z" },
		],
	});
	const { app } = tempApp();
	app.setConfig("tmdb.base_url", tmdb.url);
	app.setSecret("tmdb.api_key", tmdb.apiKey);
	app.setConfig("language", "en");
	const t = await startPlugins([join(PLUGINS, "jellyfin")], { app, settings: { jellyfin: { url: jf.url } }, secrets: { "plugins.jellyfin.api_key": jf.apiKey } });
	try {
		forgetWatchHistory();
		const h = (await watchHistory(app))!;
		assert.deepEqual(h.users, ["owner"], "several users: the administrators, not the disabled one");
		assert.deepEqual(
			h.titles.map((w) => [w.name, w.kind, w.tmdb_id, w.plays, w.episodes, w.favourite]),
			[
				["Severance", "tv", 95396, 0, 9, true],
				["Oppenheimer", "movie", 872585, 2, undefined, false],
			],
			"most recent first; episodes counted per show; a favourite seen in two lists counted once",
		);

		let prompt = "";
		const s = await makeSuggestions(app, async (system, user) => {
			prompt = `${system}\n${user}`;
			return { text: '{"picks":[{"id":"movie:872585","why":"seen"},{"id":"tv:209867","why":"Fantasy, a change from Severance."}]}', model: "fake/model" };
		});
		assert.equal(s.state, "ok", "history alone is enough to suggest");
		assert.deepEqual(s.history, { users: ["owner"], titles: 2, error: undefined });
		assert.match(prompt, /- Severance \(2022; show, 9 episodes watched; FAVOURITE\)/);
		assert.match(prompt, /- Oppenheimer \(2023; film, watched 2 times\)/);
		const watchedPart = prompt.split("Watched on their media server")[1]!.split("In their library")[0]!;
		assert.doesNotMatch(watchedPart, /Frieren/, "another user's history does not count");
		const candidates = prompt.split("Candidates")[1]!;
		assert.doesNotMatch(candidates, /movie:872585|tv:95396/, "watched titles are not candidates");
		assert.ok(tmdb.requests.some((r) => r.startsWith("/tv/95396/recommendations")), "the favourite seeds TMDB's recommendations");
		assert.deepEqual(s.items.map((i) => i.id), ["tv:209867"], "a watched title the model picks anyway is dropped");

		// new watching makes the list stale
		assert.equal(await suggestionsStale(app, readSuggestions(app)), false);
		jf.watch.push({ user: "owner", type: "Movie", name: "Sintel", year: 2010, tmdb: 45745, plays: 1, last: "2026-11-17T20:00:00Z" });
		forgetWatchHistory();
		assert.equal(await suggestionsStale(app, readSuggestions(app)), true);

		// the owner says whose history counts, in the plugin's settings
		await t.manager.configure("jellyfin", { url: jf.url, watch_users: ["Kid"] });
		assert.deepEqual((await watchHistory(app))!.titles.map((w) => w.name), ["Frieren: Beyond Journey's End"], "a changed setting is a new provider, so the history is read again");
		await t.manager.configure("jellyfin", { url: jf.url, watch_users: ["nobody"] });
		assert.match((await watchHistory(app))!.error!, /nobody/);

		// Jellyfin unreachable: suggestions are still made, and say why the history is missing
		await t.manager.configure("jellyfin", { url: "http://127.0.0.1:9" });
		const s2 = await makeSuggestions(app, async () => ({ text: '{"picks":[]}', model: "m" }));
		assert.equal(s2.state, "nothing_known", "nothing else is known in this test");
		assert.ok(s2.history?.error, "the error is reported");
		assert.equal(t.info("jellyfin").failures, 0, "an unreachable server is an outcome, not a failure of the plugin");

		// no media server at all: no history, and nothing breaks
		await t.manager.configure("jellyfin", {});
		assert.equal(await watchHistory(app), undefined);
	} finally {
		await t.close();
		app.close();
		await tmdb.close();
		await jf.close();
	}
});

test("trends: Bangumi's airing anime are added to TMDB's list, found in TMDB, without duplicates; what TMDB lacks is left out", async () => {
	const tmdb = await startFakeTmdb();
	const bgm = await startFakeBangumi();
	const { app } = tempApp();
	app.setConfig("tmdb.base_url", tmdb.url);
	app.setSecret("tmdb.api_key", tmdb.apiKey);
	app.setConfig("language", "en");
	const t = await startPlugins([join(PLUGINS, "bangumi")], { app, settings: { bangumi: { base_url: bgm.url } } });
	try {
		const tmdbOnly = (await app.tmdb().trending("all", "week")).map((x) => `${x.media_type}:${x.id}`);
		const week = await trendingTitles(app, "all", "week");
		assert.deepEqual(week.slice(0, tmdbOnly.length).map((x) => x.id), tmdbOnly, "TMDB's own list comes first, as it was");
		const added = week.slice(tmdbOnly.length);
		assert.ok(week.some((x) => x.id === "tv:209867"), "Frieren, airing on Bangumi, is there as its TMDB title");
		assert.equal(week.filter((x) => x.id === "tv:209867").length, 1, "once, even when TMDB lists it too");
		assert.ok(!week.some((x) => /まだ誰も/.test(x.name) || /无人知晓/.test(x.name)), "an anime TMDB does not have is left out");
		if (!tmdbOnly.includes("tv:209867")) assert.equal(added.find((x) => x.id === "tv:209867")?.rating, 9.1, "with Bangumi's score");
		assert.deepEqual((await trendingTitles(app, "movie", "week")).map((x) => x.id), (await app.tmdb().trending("movie", "week")).map((x) => `movie:${x.id}`), "Bangumi adds no films");

		// "For you" gets them as candidates too
		writeFileSync(join(app.paths.notes, "preferences.md"), "- Anime.\n");
		let prompt = "";
		await makeSuggestions(app, async (system, user) => {
			prompt = user;
			return { text: '{"picks":[]}', model: "m" };
		});
		assert.match(prompt.split("Candidates")[1]!, /tv:209867/);
		assert.equal(t.info("bangumi").failures, 0);
	} finally {
		await t.close();
		app.close();
		await tmdb.close();
		await bgm.close();
	}
});
