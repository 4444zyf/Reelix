import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { libraryFolderFor, surveyLibraryFolders } from "../src/library-folders.ts";
import { autoPlan } from "../src/organiser.ts";
import { runOperation } from "../src/registry.ts";
import { getTitle } from "../src/titles.ts";
import "../src/ops/index.ts";
import { insertTitle, tempApp, touch } from "./helpers.ts";

const facts = (app: any, id: string, f: { lang?: string; countries?: string[]; genres?: string[] }) =>
	app.db.prepare("UPDATE titles SET original_language = ?, origin_country_json = ?, genres_json = ? WHERE id = ?").run(f.lang ?? null, JSON.stringify(f.countries ?? []), JSON.stringify(f.genres ?? []), id);

function twoFolders() {
	const w = tempApp();
	const zh = join(w.library, "movies", "Chinese-language Movies");
	const intl = join(w.library, "movies", "International Movies");
	for (const d of [zh, intl]) mkdirSync(d, { recursive: true });
	w.app.setConfig("library.movies", [{ path: zh, name: "Chinese", rules: [{ when: { original_language: ["zh", "cn"] } }] }, { path: intl }]);
	insertTitle(w.app, { id: "movie:1", kind: "movie", tmdb_id: 1, name: "Hero", year: 2002 });
	insertTitle(w.app, { id: "movie:2", kind: "movie", tmdb_id: 2, name: "Sintel", year: 2010 });
	facts(w.app, "movie:1", { lang: "zh", countries: ["CN"], genres: ["Action"] });
	facts(w.app, "movie:2", { lang: "en", countries: ["NL"], genres: ["Animation"] });
	return { ...w, zh, intl };
}

test("a single path in an old config is read as a list of one folder", () => {
	const c = parseConfig({ library: { movies: "/media/library/Movies", shows: "" } });
	assert.deepEqual(c.library.movies, [{ path: "/media/library/Movies" }]);
	assert.deepEqual(c.library.shows, []);
	assert.throws(() => parseConfig({ library: { movies: [{ path: "/a", default: true }, { path: "/b", default: true }] } }), /more than one default/);
	assert.throws(() => parseConfig({ library: { movies: [{ path: "/a" }, { path: "/a" }] } }), /same folder twice/);
});

test("the folder for a title: rule, then undecided; a default or the owner's choice decides; a filed title stays", () => {
	const { app, zh, intl } = twoFolders();
	const hero = getTitle(app, "movie:1")!;
	const sintel = getTitle(app, "movie:2")!;
	assert.deepEqual(libraryFolderFor(app, hero), { folder: app.config.library.movies[0], how: "rule", rule: { original_language: ["zh", "cn"] } });
	assert.ok("undecided" in libraryFolderFor(app, sintel));

	app.setConfig("library.movies.1.default", true);
	const d = libraryFolderFor(app, sintel);
	assert.ok("folder" in d && d.folder.path === intl && d.how === "default");

	app.db.prepare("UPDATE titles SET library_choice = ? WHERE id = 'movie:2'").run(zh);
	const chosen = libraryFolderFor(app, getTitle(app, "movie:2")!);
	assert.ok("folder" in chosen && chosen.folder.path === zh && chosen.how === "chosen");

	// Already filed in International: it stays there whatever the rules say.
	mkdirSync(join(intl, "Hero (2002) [tmdbid-1]"));
	const there = libraryFolderFor(app, hero);
	assert.ok("folder" in there && there.folder.path === intl && there.how === "there");
});

test("code files into the decided folder, and hands an undecided title to the agent with the reason", async () => {
	const { app, downloads, zh } = twoFolders();
	const dir = join(downloads, "Hero.2002.1080p.BluRay");
	touch(join(dir, "Hero.2002.1080p.BluRay.mkv"), 2048);
	const hero = autoPlan(app, getTitle(app, "movie:1")!, dir);
	assert.deepEqual(hero.problems, []);
	assert.ok(hero.plan.items[0]!.dest.startsWith(`${zh}/Hero (2002) [tmdbid-1]/`));
	assert.deepEqual(hero.plan.notes, ["Library folder: Chinese (rule original_language zh/cn)"]);

	const sintel = autoPlan(app, getTitle(app, "movie:2")!, dir);
	assert.deepEqual(sintel.plan.items, []);
	assert.match(sintel.problems[0]!, /No library folder is decided for "Sintel".*Chinese, International Movies.*library-folders skill/);

	const set = await runOperation(app, "title.library_folder.set", { id: "movie:2", folder: "International Movies" }, { actor: "agent:test" });
	assert.match(set.text, /goes to .*International Movies/);
	assert.ok(autoPlan(app, getTitle(app, "movie:2")!, dir).plan.items[0]!.dest.includes("International Movies/Sintel (2010) [tmdbid-2]/"));
	await assert.rejects(runOperation(app, "title.library_folder.set", { id: "movie:2", folder: "Nowhere" }, { actor: "agent:test" }), /not a library folder for movies/);
});

test("the library setting is the owner's: the agent's change is refused without the owner's yes", async () => {
	const { app } = twoFolders();
	await assert.rejects(runOperation(app, "config.set", { path: "library.movies.1.default", value: true }, { actor: "agent:test" }), (e: any) => e.code === "owner_only");
	await runOperation(app, "config.set", { path: "library.movies.1.default", value: true }, { actor: "owner:test" });
	assert.equal(app.config.library.movies[1]!.default, true);
});

test("the survey counts each folder's facts and names the titles the rules would put elsewhere", async () => {
	const { app, zh, intl } = twoFolders();
	mkdirSync(join(zh, "Hero (2002) [tmdbid-1]"));
	mkdirSync(join(zh, "Sintel (2010) [tmdbid-2]"));
	mkdirSync(join(intl, "Some Home Video"));
	const s = await surveyLibraryFolders(app, "movies");
	const chinese = s.folders.find((f) => f.path === zh)!;
	assert.deepEqual(chinese.counts.original_language, { zh: 1, en: 1 });
	assert.deepEqual(s.folders.find((f) => f.path === intl)!.untagged, ["Some Home Video"]);
	assert.deepEqual(s.misfits, [{ name: "Sintel", in: "Chinese", rules_say: null }]);
});
