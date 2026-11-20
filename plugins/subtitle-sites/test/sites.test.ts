import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isOutcome } from "@reelix/plugin";
import { applyPlan, autoPlan, fetchSubtitle, getTitle, runOperation, searchSubtitles, videosOf } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { insertTitle, tempApp, touch } from "../../../packages/core/test/helpers.ts";
import { narrowToTitle, parseSubhdSearch } from "../src/subhd.ts";
import check, { DOWN_FLOW, QUERY, SUBHD } from "./check.ts";
import { FR_SRT, startFakeSubtitleSites } from "./fake-sites.ts";

const PLUGIN = join(import.meta.dirname, "..");
const SEAM = "reelix:subtitle.source@1";
const secret = (name: string) => `plugins.subtitle-sites.${name}`;
const siteUrls = (url: string) => ({ opensubtitles_url: `${url}/os/api/v1`, subdl_url: `${url}/subdl/api/v1`, subdl_download_url: `${url}/subdl-dl`, gestdown_url: `${url}/gd`, jimaku_url: `${url}/jimaku/api`, subhd_url: `${url}/subhd` });

async function frenchWorld(secrets: Record<string, string> = {}) {
	const sites = await startFakeSubtitleSites();
	const w = tempApp();
	const { app, downloads } = w;
	app.setConfig("language", "fr");
	insertTitle(app, { id: "tv:95396", kind: "tv", tmdb_id: 95396, name: "Severance", folder_name: "Severance", year: 2022 });
	const dir = join(downloads, "Severance.S01.1080p.ATVP.WEB-DL");
	for (const e of [1, 2]) touch(join(dir, `Severance.S01E0${e}.1080p.ATVP.WEB-DL.mkv`), 1000);
	applyPlan(app, autoPlan(app, getTitle(app, "tv:95396")!, dir).plan);
	const t = await startPlugins([PLUGIN], { app, settings: { "subtitle-sites": siteUrls(sites.url) }, secrets });
	return { ...w, sites, close: async () => (await t.close(), app.close(), await sites.close()) };
}

test("a French owner: Chinese sources are not asked; missing keys are reported and keyless sources work", async () => {
	const w = await frenchWorld();
	try {
		const { app, sites } = w;
		const r = await searchSubtitles(app, getTitle(app, "tv:95396")!, { season: 1 });
		assert.deepEqual(r.languages, ["fr", "en"]);
		assert.ok(!sites.requests.some((x) => x.includes("subhd")), "no Chinese site for a French owner");
		assert.deepEqual([...new Set(r.candidates.map((c) => c.source))], ["gestdown"]);
		assert.deepEqual(r.candidates.map((c) => `${c.language} E${c.episode}`).sort(), ["en E1", "en E2", "fr E1", "fr E2"]);
		assert.deepEqual(r.skipped.map((x) => [x.source, x.needs]), [["assrt", [secret("assrt_token")]], ["opensubtitles", [secret("opensubtitles_api_key")]], ["subdl", [secret("subdl_api_key")]]], "ASSRT has English too");
		assert.ok(!r.skipped.some((x) => x.source === "jimaku"), "Jimaku is for Japanese anime: not relevant here");
	} finally {
		await w.close();
	}
});

test("with keys: sources in the configured order, a subtitle fetched and placed, a refused key is an outcome, not a failure", async () => {
	const fake = await startFakeSubtitleSites();
	await fake.close();
	const w = await frenchWorld({ [secret("opensubtitles_api_key")]: fake.osKey, [secret("subdl_api_key")]: fake.subdlKey });
	try {
		const { app, sites } = w;
		let r = await searchSubtitles(app, getTitle(app, "tv:95396")!, { season: 1 });
		assert.deepEqual([...new Set(r.candidates.map((c) => c.source))], ["opensubtitles", "subdl", "gestdown"]);
		const os = r.candidates.filter((c) => c.source === "opensubtitles");
		assert.ok(os.every((c) => c.season === 1 && c.episode));
		assert.ok(sites.requests.some((x) => /\/os\/api\/v1\/subtitles\?languages=fr%2Cen&parent_tmdb_id=95396&season_number=1&type=episode/.test(x)), "OpenSubtitles parameters sorted and lower-case");

		const videos = videosOf(app, "tv:95396", 1);
		const e1 = videos.find((v) => v.episode === 1)!;
		const out = await fetchSubtitle(app, { ref: os.find((c) => c.language === "fr" && c.episode === 1)!.ref, video: e1.path, title_id: "tv:95396" });
		assert.equal(out.results[0]!.language, "fr");
		assert.match(out.results[0]!.placed!, /Severance \(2022\) S01E01\.fr\.default\.srt$/);
		assert.equal(readFileSync(out.results[0]!.placed!, "utf8"), FR_SRT.replace(/\r?\n/g, "\n"));
		const gd = await fetchSubtitle(app, { ref: "gestdown:gd-fr-2", video: videos.find((v) => v.episode === 2)!.path, title_id: "tv:95396" });
		assert.match(gd.results[0]!.placed!, /S01E02\.fr\.default\.srt$/);

		const status = (await runOperation(app, "site.status", {}, { actor: "owner:cli" })).output as any[];
		assert.equal(status.find((s) => s.id === "opensubtitles").state.downloadsToday, 1, "recorded outcomes feed site.status");
		assert.match(status.find((s) => s.id === "assrt").ready, /plugins\.subtitle-sites\.assrt_token/);

		app.setSecret(secret("subdl_api_key"), "wrong");
		await new Promise((res) => setTimeout(res, 200)); // the plugin starts again with the new key
		r = await searchSubtitles(app, getTitle(app, "tv:95396")!, { season: 1 });
		assert.match(r.errors.join(" "), /SubDL.*refused the login or key/);
		assert.equal(app.plugins!.list().find((p) => p.id === "subtitle-sites")!.failures, 0);
	} finally {
		await w.close();
	}
});

test("Japanese for anime goes to Jimaku; a Chinese owner still gets subhd first", async () => {
	const sites = await startFakeSubtitleSites();
	const { app } = tempApp();
	const t = await startPlugins([PLUGIN], { app, settings: { "subtitle-sites": siteUrls(sites.url) }, secrets: { [secret("jimaku_api_key")]: sites.jimakuKey } });
	try {
		insertTitle(app, { id: "tv:209867", kind: "tv", tmdb_id: 209867, name: "Frieren", folder_name: "Frieren", year: 2023, media_class: "anime" });
		const r = await searchSubtitles(app, getTitle(app, "tv:209867")!, { languages: ["ja"] });
		assert.deepEqual(r.candidates.map((c) => [c.source, c.language, c.release]), [["jimaku", "ja", "Sousou no Frieren - 01.ja.srt"]]);
		app.setConfig("language", "zh");
		sites.requests.length = 0;
		await searchSubtitles(app, getTitle(app, "tv:209867")!, {});
		assert.ok(sites.requests[0]?.startsWith("GET /subhd/search/"), "subhd is asked first for Chinese");
	} finally {
		await t.close();
		app.close();
		await sites.close();
	}
});

test("subhd search page parsing (hand-written fixture in subhd's structure)", () => {
	const html = `<html><div class="bg-white shadow-sm rounded-3 mb-4"><div class="row"><div class="col-2"><a href='/d/1234567'><img alt="示例 Example"></a></div>
	<div class="col-lg-10"><div class="clearfix"><div class="float-start f16 fw-bold"> <a class="link-dark" href='/a/AbC123'>示例电影</a> </div>
	<div class="view-text text-secondary"> <a href='/a/AbC123'> Example.2023.1080p.WEB-DL.H264-GRP </a> </div>
	<div class="text-truncate py-2 f11"> <span class="rounded p-1 me-1 text-white">官方字幕</span> <span class="p-1 fw-bold">简体 双语</span> <span class="p-1 text-secondary">ASS</span> </div>
	<div class="pt-2 text-secondary f12"><span class='align-text-top me-3'>120k</span><span class="align-text-top me-3">88</span><time datetime="2024-01-02T03:04:05.000Z"></time></div>
	<div class="pt-1 f12 text-secondary"> 发布人 <a class="fw-bold text-dark" href='/u/x'>someone</a> </div></div></div></div></html>`;
	const r = parseSubhdSearch(html);
	assert.equal(r.length, 1);
	assert.deepEqual({ ...r[0], size: undefined, date: undefined }, { ref: "AbC123", ids: { douban: "1234567" }, name: "示例电影", release: "Example.2023.1080p.WEB-DL.H264-GRP", languages: ["简体", "双语"], formats: ["ASS"], tags: ["官方字幕"], downloads: 88, uploader: "someone", size: undefined, date: undefined });
});

test("subhd: hits are narrowed to the title's Douban entry, and an entry found by name is reported", () => {
	const hit = (ref: string, name: string, douban?: string) => ({ ref, name, languages: [], ids: douban ? { douban } : undefined });
	const hits = [hit("a", "示例", "1"), hit("b", "别的", "2"), hit("c", "示例 第二版", undefined)];
	assert.deepEqual(narrowToTitle(hits, { ids: { douban: "1" }, names: ["示例"] }).map((h) => [h.ref, h.ids]), [["a", undefined], ["c", undefined]], "known id: others go");
	assert.deepEqual(narrowToTitle(hits, { ids: {}, names: ["示例"] }).map((h) => [h.ref, h.ids?.douban]), [["a", "1"]], "found by name: the id is revealed");
	assert.deepEqual(narrowToTitle(hits, { ids: {}, names: ["Nothing"] }).map((h) => h.ids), [undefined, undefined, undefined], "no match: nothing is claimed");
});

test("subhd: the prepare step's cookie is sent back, and the human check travels through needs_verification and call.verification", async () => {
	const t = await startPlugins([PLUGIN], { settings: { "subtitle-sites": check.settings }, http: check.http });
	try {
		const p = t.app.seams.provider(SEAM, "subhd")!;
		const hits = await p.call("search", [QUERY]);
		assert.ok(!isOutcome(hits));
		await p.call("download", [hits[0]!.ref]);
		const asked = t.http.requests.find((r) => r.url.endsWith("/api/sub/down"))!;
		assert.equal(asked.headers.cookie, "sess=1", "the cookie from the prepare step is sent back");
		assert.deepEqual(JSON.parse(asked.body!), { sid: "sid1", turnstileToken: null });
	} finally {
		await t.close();
	}
	const v = await startPlugins([PLUGIN], { settings: { "subtitle-sites": { subhd_url: SUBHD } }, http: [...DOWN_FLOW, { url: `${SUBHD}/api/sub/down`, method: "POST", body: JSON.stringify({ turnstileRequired: true }) }] });
	try {
		const p = v.app.seams.provider(SEAM, "subhd")!;
		assert.deepEqual(await p.call("download", ["sid1"]), { outcome: "needs_verification", url: `${SUBHD}/down/x` });
		await p.call("download", ["sid1"], { verification: "tok" });
		assert.equal(JSON.parse(v.http.requests.filter((r) => r.url.endsWith("/api/sub/down")).at(-1)!.body!).turnstileToken, "tok");
		assert.equal(v.info("subtitle-sites").failures, 0);
	} finally {
		await v.close();
	}
});

test("subhd's daily limit becomes rate_limited, is remembered, and shows in site.status", async () => {
	const t = await startPlugins([PLUGIN], { settings: { "subtitle-sites": { subhd_url: SUBHD } }, http: [...DOWN_FLOW, { url: `${SUBHD}/api/sub/down`, method: "POST", body: JSON.stringify({ dailyLimitReached: true }) }] });
	try {
		const p = t.app.seams.provider(SEAM, "subhd")!;
		const first = await p.call("download", ["sid1"]);
		assert.ok(isOutcome(first) && first.outcome === "rate_limited" && first.until);
		const before = t.http.requests.length;
		assert.equal(((await p.call("download", ["sid1"])) as { outcome: string }).outcome, "rate_limited");
		assert.equal(t.http.requests.length, before, "the site is not asked again until the limit ends");
		const status = (await runOperation(t.app, "site.status", {}, { actor: "owner:cli" })).output as any[];
		assert.ok(status.find((s) => s.id === "subhd").state.limitUntil);
	} finally {
		await t.close();
	}
});
