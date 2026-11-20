import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { startPlugins } from "@reelix/plugin-testing";
import { startFakeJellyfin } from "../../../plugins/jellyfin/test/fake-jellyfin.ts";
import { forgetPlayIndex, libraryPlayLinks, playTarget } from "../src/playback.ts";
import { fetchTitle } from "../src/titles.ts";
import { startFakeTmdb } from "./fakes/tmdb.ts";
import { PLUGINS, tempApp } from "./helpers.ts";

const urls = (l: { app: string; url: string }[]) => Object.fromEntries(l.map((x) => [x.app, x.url]));

test("play links: the exact film or next episode in Infuse, Swiftfin and Jellyfin, in the owner's order, with no key in them", async () => {
	const tmdb = await startFakeTmdb();
	const jf = await startFakeJellyfin({
		apiKey: "jellyfin-private-key",
		users: [{ name: "owner", admin: true }, { name: "guest" }],
		library: [{ type: "Movie", name: "Sintel", year: 2010, tmdb: 45745 }, { type: "Series", name: "Severance", year: 2022, tmdb: 95396, episodes: [[1, 1], [1, 2], [1, 3]] }],
		next: [{ user: "owner", tmdb: 95396, season: 1, episode: 2 }, { user: "guest", tmdb: 95396, season: 1, episode: 3 }],
	});
	const { app } = tempApp();
	app.setConfig("tmdb.base_url", tmdb.url);
	app.setSecret("tmdb.api_key", tmdb.apiKey);
	app.setConfig("language", "en");
	const t = await startPlugins([join(PLUGINS, "players"), join(PLUGINS, "jellyfin")], { app });
	try {
		forgetPlayIndex();
		const movie = await fetchTitle(app, "movie", 45745);
		const show = await fetchTitle(app, "tv", 95396);
		const frieren = await fetchTitle(app, "tv", 209867);
		const oppie = await fetchTitle(app, "movie", 872585);
		const mark = app.db.prepare("UPDATE titles SET library_folder = ? WHERE id = ?");
		mark.run("/l/Sintel", movie.id);
		mark.run("/l/Severance", show.id);
		mark.run("/l/Frieren", frieren.id);
		const addEp = (title: string, n: number) => {
			const f = app.db.prepare("INSERT INTO files (title_id, dest, kind, created_at) VALUES (?, ?, 'video', 'now')").run(title, `/l/${title}/${n}.mkv`);
			app.db.prepare("INSERT INTO file_episodes (file_id, season, episode) VALUES (?, 1, ?)").run(f.lastInsertRowid, n);
		};
		for (const n of [1, 2, 3]) addEp(show.id, n);
		addEp(frieren.id, 4);

		// Without a media server: Infuse only needs TMDB IDs
		assert.deepEqual(urls((await playTarget(app, movie.id)).links), { infuse: "infuse://movie/45745?play" });
		assert.deepEqual(urls((await playTarget(app, frieren.id)).links), { infuse: "infuse://series/209867-1-4?play" }, "not started: the first episode in the library");

		app.setSecret("plugins.jellyfin.api_key", jf.apiKey);
		await t.manager.configure("jellyfin", { url: jf.url, public_url: "https://jf.example.ts.net/" });
		const film = await playTarget(app, movie.id);
		assert.deepEqual(urls(film.links), {
			infuse: "infuse://movie/45745?play",
			swiftfin: "swiftfin://fakeserver0001/u1/item/m45745",
			jellyfin: "https://jf.example.ts.net/web/#/details?id=m45745&serverId=fakeserver0001",
		});
		// Loaded from a folder here, so each label also names the plugin (docs/plugins.md §7); built in, it is the player's name alone.
		assert.deepEqual(film.links.map((l) => [l.app, l.label, l.autoplay]), [["infuse", "Infuse (players)", true], ["swiftfin", "Swiftfin (players)", false], ["jellyfin", "Jellyfin (players)", false]], "each link names its player");
		const next = await playTarget(app, show.id);
		assert.deepEqual([next.season, next.episode], [1, 2], "the owner's next episode, not the guest's");
		assert.equal(urls(next.links).infuse, "infuse://series/95396-1-2?play");
		assert.equal(urls(next.links).swiftfin, "swiftfin://fakeserver0001/u1/item/s95396x1x2");
		assert.deepEqual(next.episodes!.map((e) => e.episode), [1, 2, 3], "every episode in the library has its own link");
		assert.equal(urls(next.episodes![2]!.links).swiftfin, "swiftfin://fakeserver0001/u1/item/s95396x1x3");

		const asked = await playTarget(app, show.id, { season: 1, episode: 3 });
		assert.equal(urls(asked.links).infuse, "infuse://series/95396-1-3?play");
		assert.match((await playTarget(app, show.id, { season: 1, episode: 9 })).note!, /not in the library/);
		const absent = await playTarget(app, oppie.id);
		assert.equal(absent.in_library, false);
		assert.deepEqual(absent.links, [], "nothing to play");

		const all = await libraryPlayLinks(app);
		assert.deepEqual(Object.keys(all.targets).sort(), [movie.id, frieren.id, show.id].sort());
		assert.equal(urls(all.targets[show.id]!.links).swiftfin, "swiftfin://fakeserver0001/u1/item/s95396x1x2", "a poster also continues where the owner stopped");
		assert.doesNotMatch(JSON.stringify(all), /jellyfin-private-key/);

		// The owner's player list sets the order; a player not in it comes last
		app.setConfig("players", ["jellyfin", "infuse"]);
		assert.deepEqual((await playTarget(app, movie.id)).links.map((l) => l.app), ["jellyfin", "infuse", "swiftfin"]);
		app.setConfig("players", ["infuse", "swiftfin", "jellyfin"]);

		// A Docker-only address is no use on a phone
		await t.manager.configure("jellyfin", { url: "http://jellyfin:8096" });
		assert.ok((await libraryPlayLinks(app)).media_server_error, "unreachable here");
		assert.deepEqual(urls((await playTarget(app, movie.id)).links), { infuse: "infuse://movie/45745?play" }, "Infuse still works");
		assert.match((await playTarget(app, movie.id)).note!, /^Jellyfin.*Could not reach jellyfin:8096/);
	} finally {
		await t.close();
		app.close();
		await tmdb.close();
		await jf.close();
	}
});
