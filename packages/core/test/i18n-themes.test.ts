import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LANGUAGES } from "../src/config.ts";
import { translate, tr } from "../src/i18n.ts";
import { LOCALE_TAGS } from "../src/messages.ts";
import { runOperation } from "../src/registry.ts";
import { BUILT_IN_THEMES_DIR, checkThemeDir, installedThemes, themeTokens } from "../src/themes.ts";
import { tempApp } from "./helpers.ts";

type Tree = { [k: string]: string | Tree };
const load = (l: string) => JSON.parse(readFileSync(new URL(`../locales/${l}.json`, import.meta.url), "utf8")) as Tree;
const flat = (o: Tree, pre = "", out: Record<string, string> = {}) => {
	for (const [k, v] of Object.entries(o)) typeof v === "string" ? (out[pre + k] = v) : flat(v, `${pre}${k}.`, out);
	return out;
};
const PLURAL = /_(zero|one|two|few|many|other)$/;
const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).filter((v) => v !== "count").sort().join(",");

test("server messages: every language has every key, its plural forms and the same placeholders", () => {
	const en = flat(load("en"));
	const bases = (o: Record<string, string>) => new Set(Object.keys(o).map((k) => k.replace(PLURAL, "")));
	for (const l of LANGUAGES) {
		const got = flat(load(l));
		const cats = new Intl.PluralRules(LOCALE_TAGS[l]).resolvedOptions().pluralCategories;
		assert.deepEqual([...bases(got)].sort(), [...bases(en)].sort(), `${l}: same keys as en`);
		for (const k of Object.keys(en)) {
			const base = k.replace(PLURAL, "");
			if (PLURAL.test(k)) for (const c of cats) assert.ok(got[`${base}_${c}`], `${l}: ${base}_${c}`);
			else assert.equal(vars(got[k]!), vars(en[k]!), `${l}: ${k} placeholders`);
		}
	}
});

test("translate: plural forms, placeholders, owner language, English fallback", () => {
	assert.equal(translate("en", "nightly.waiting", { count: 1 }), "1 item is waiting for you in the Inbox.");
	assert.match(translate("ru", "nightly.waiting", { count: 3 }), /3 элемента/);
	assert.match(translate("ru", "nightly.waiting", { count: 5 }), /5 элементов/);
	assert.match(translate("zh", "chat.error", { message: "坏了" }), /出错了：坏了/);
	assert.equal(translate("fr", "no.such.key"), "no.such.key");
	const { app } = tempApp();
	assert.equal(tr(app, "chat.error", { message: "x" }), "Error: x");
	app.setConfig("language", "fr");
	assert.equal(tr(app, "chat.error", { message: "x" }), "Erreur : x");
	assert.throws(() => app.setConfig("language", "de"));
	app.close();
});

test("themes: built-ins pass the check and set every token", () => {
	for (const id of ["marquee", "paper"]) {
		const t = checkThemeDir(join(BUILT_IN_THEMES_DIR, id), id, true);
		assert.ok(t.ok, `${id}: ${t.errors.join("; ")}`);
		assert.deepEqual(t.inherited, [], `${id} sets every token itself`);
		assert.deepEqual(t.warnings, []);
	}
	assert.ok(themeTokens().length > 50);
});

test("themes: theme.new copies a built-in, theme.check validates, unsafe themes are refused", async () => {
	const { app } = tempApp();
	const run = (name: string, input: unknown) => runOperation(app, name, input, { actor: "owner:test" });
	const made = (await run("theme.new", { id: "neon-noir", from: "paper", name: "Neon Noir" })).output as any;
	assert.ok(made.ok, made.errors.join("; "));
	const css = readFileSync(join(app.paths.themes, "neon-noir", "theme.css"), "utf8");
	assert.match(css, /\[data-theme="neon-noir"\]/);
	assert.doesNotMatch(css, /data-base="paper"|data-theme="paper"/, "the copy answers only to its own id");
	assert.deepEqual(installedThemes(app).map((t) => [t.id, t.base, t.scheme]), [["neon-noir", "paper", "light"]]);
	await assert.rejects(run("theme.new", { id: "paper" }), /exists/);
	await assert.rejects(run("theme.new", { id: "Bad Id" }), /lowercase/);

	// A partial theme is fine with a base; a remote font or an @import is not.
	const dir = join(app.paths.themes, "tiny");
	mkdirSync(dir);
	writeFileSync(join(dir, "theme.json"), JSON.stringify({ id: "tiny", name: { en: "Tiny", zh: "小" }, scheme: "dark", base: "marquee" }));
	writeFileSync(join(dir, "theme.css"), '[data-theme="tiny"] { --primary: #ff0066; --nav-active: #ff0066; }');
	const tiny = (await run("theme.check", { id: "tiny" })).output as any;
	assert.ok(tiny.ok);
	assert.ok(tiny.inherited.includes("--bg"));
	writeFileSync(join(dir, "theme.css"), '@font-face { font-family: X; src: url(https://fonts.example/x.woff2); }\n[data-theme="tiny"] { --primary: red; }');
	const bad = (await run("theme.check", { id: "tiny" })).output as any;
	assert.equal(bad.ok, false);
	assert.match(bad.errors.join(" "), /web addresses/);
	assert.deepEqual(installedThemes(app).map((t) => t.id), ["neon-noir"], "a failing theme is not offered");
	writeFileSync(join(dir, "theme.json"), JSON.stringify({ id: "tiny", name: "Tiny", scheme: "dark" }));
	writeFileSync(join(dir, "theme.css"), '[data-theme="tiny"] { --primary: red; }');
	assert.match(((await run("theme.check", { id: "tiny" })).output as any).errors.join(" "), /no base/);
	app.close();
});

test("one language everywhere: tmdb.language migrates, TMDB follows the owner, subhd keeps the Chinese name", async () => {
	const { parseConfig } = await import("../src/config.ts");
	assert.equal(parseConfig({ tmdb: { language: "zh-CN" } }).language, "zh", "the old TMDB setting becomes the owner's language");
	assert.equal(parseConfig({ language: "fr", tmdb: { language: "zh-CN" } }).language, "fr", "an explicit language wins");
	assert.equal((parseConfig({ tmdb: { language: "zh-CN" } }).tmdb as any).language, undefined, "and the old key is dropped");

	const { startFakeTmdb } = await import("./fakes/tmdb.ts");
	const { chineseName, fetchTitle, refreshAllTitles } = await import("../src/titles.ts");
	const tmdb = await startFakeTmdb();
	const { app } = tempApp();
	try {
		app.setConfig("tmdb.base_url", tmdb.url);
		app.setSecret("tmdb.api_key", tmdb.apiKey);
		app.setConfig("language", "en");
		let t = await fetchTitle(app, "movie", 45745);
		assert.equal(t.name, "Sintel");
		const sintelFacts = { original_language: t.original_language, origin_country: t.origin_country };
		assert.ok(t.original_language && t.genres.includes("Animation"));
		assert.equal(chineseName(t), "辛特尔", "Chinese subtitle sites still get the Chinese name");
		const folder = t.folder_name;
		app.setConfig("language", "zh");
		assert.deepEqual(await refreshAllTitles(app), { refreshed: 1, failed: [] });
		t = (await import("../src/titles.ts")).getTitle(app, "movie:45745")!;
		assert.equal(t.name, "辛特尔", "metadata re-read in the owner's new language");
		assert.equal(t.folder_name, folder, "the library folder name never changes");
		assert.deepEqual([t.original_language, t.origin_country, t.genres.includes("Animation")], [sintelFacts.original_language, sintelFacts.origin_country, true], "library rules see the same facts, genres in English, in any language");
		assert.ok(tmdb.requests.some((r) => r.includes("language=zh-CN")));
	} finally {
		app.close();
		await tmdb.close();
	}
});
