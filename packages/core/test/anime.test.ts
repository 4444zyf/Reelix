import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAbsolute } from "../src/anime.ts";
import { autoPlan } from "../src/organiser.ts";
import { getTitle } from "../src/titles.ts";
import { insertTitle, tempApp, touch } from "./helpers.ts";

test("absolute anime numbers: stored Bangumi mapping, wanted season, cumulative seasons", () => {
	const { app, downloads } = tempApp();
	insertTitle(app, { id: "tv:1", kind: "tv", tmdb_id: 1, name: "Anime", year: 2020, media_class: "anime" });
	app.db.prepare("UPDATE titles SET seasons_json = ? WHERE id = 'tv:1'").run(JSON.stringify([{ season_number: 0, episode_count: 2 }, { season_number: 1, episode_count: 12 }, { season_number: 2, episode_count: 13 }]));
	const t = getTitle(app, "tv:1")!;
	assert.deepEqual(resolveAbsolute(app, t, 14), { season: 2, episode: 2, how: "cumulative TMDB seasons" });
	assert.deepEqual(resolveAbsolute(app, t, 5, 2), { season: 2, episode: 5, how: "within the wanted season" });
	// a stored mapping wins: Bangumi entry 99 episodes 1–13 are TMDB S2 from E1
	app.db.prepare("INSERT INTO anime_map (title_id, bangumi_id, bgm_from, bgm_to, tmdb_season, tmdb_start, exceptions_json) VALUES ('tv:1', 99, 13, 25, 2, 1, '{}')").run();
	assert.equal(resolveAbsolute(app, t, 13)!.season, 2);
	assert.equal(resolveAbsolute(app, t, 13)!.episode, 1);

	const f = touch(join(downloads, "[Grp] Anime - 14 [1080p].mkv"), 100);
	const r = autoPlan(app, t, f, { resolveAbsolute: (n, h) => resolveAbsolute(app, t, n, h) });
	assert.deepEqual(r.problems, []);
	assert.match(r.plan.items[0]!.dest, /Anime\/Anime \(2020\) \[tmdbid-1\]\/Season 02\/Anime \(2020\) S02E02\.mkv$/);
	app.close();
});
