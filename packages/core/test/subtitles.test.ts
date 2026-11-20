import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyPlan, autoPlan } from "../src/organiser.ts";
import { decodeSubtitle, detectLanguage, lastTimestamp, unpackSubtitles } from "../src/subtitles/text.ts";
import { processLocalSubtitle } from "../src/subtitles/pipeline.ts";
import { getTitle } from "../src/titles.ts";
import { encodeGbk, makeZip } from "./fakes/zip.ts";
import { insertTitle, tempApp, touch } from "./helpers.ts";


function srt(lines: string[], endMin = 44): string {
	return lines.map((l, i) => `${i + 1}\n00:${String(Math.min(i, 59)).padStart(2, "0")}:01,000 --> 00:${String(Math.min(i, 59)).padStart(2, "0")}:03,000\n${l}\n`).join("\n") + `\n${lines.length + 1}\n00:${endMin}:00,000 --> 00:${endMin}:02,000\n完\n`;
}

test("encodings: GB18030 and Big5 are told apart; UTF-8 BOM honoured", () => {
	const hans = "我们这个时来说你是好的了".repeat(5);
	const gbk = new TextEncoder().encode(hans); // build GBK via our table instead
	const gbkBytes = encodeGbk(hans);
	assert.equal(decodeSubtitle(gbkBytes).text, hans);
	assert.equal(decodeSubtitle(gbkBytes).encoding, "gb18030");
	assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(gbk)])).encoding, "utf-8-bom");
	const big5 = Buffer.from([0xa7, 0xda, 0xad, 0xcc, 0xb3, 0x6f, 0xad, 0xd3, 0xbb, 0xa1, 0xa6, 0x6e]); // 我們這個說好 in Big5
	assert.equal(decodeSubtitle(Buffer.concat(Array(6).fill(big5))).encoding, "big5");
});

test("script and bilingual detection by content", () => {
	assert.equal(detectLanguage(srt(Array(20).fill("我们这个时候来说"))).language, "zh-Hans");
	assert.equal(detectLanguage(srt(Array(20).fill("我們這個時候來說"))).language, "zh-Hant");
	assert.equal(detectLanguage(srt(Array(20).fill("我们这个时候来说 We should say this now"))).language, "zh-bilingual");
	assert.equal(detectLanguage(srt(Array(20).fill("We should say this now please"))).language, "en");
	const ass = `[Script Info]\nTitle: x\n\n[Events]\n${Array(20).fill("Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,我们这个来说\\NWe say this here").join("\n")}\nDialogue: 0,1:58:00.00,1:58:02.00,Default,,0,0,0,,完`;
	assert.equal(detectLanguage(ass).language, "zh-bilingual");
	assert.equal(lastTimestamp(ass), 1 * 3600 + 58 * 60 + 2);
});

test("hardened unzip: GBK names decoded, path escapes refused", async () => {
	const { app } = tempApp();
	const zip = makeZip([
		{ name: "简体中文.srt", data: Buffer.from(srt(["我们来说"])), gbkName: true },
		{ name: "../../evil.srt", data: Buffer.from("x") },
		{ name: "readme.txt", data: Buffer.from("hi") },
	]);
	const f = join(app.paths.workspace, "a.zip");
	writeFileSync(f, zip);
	const out = await unpackSubtitles(f, join(app.paths.workspace, "x"));
	assert.deepEqual(out.map((p) => p.split("/").pop()), ["简体中文.srt"]);
	assert.ok(!existsSync(join(app.paths.workspace, "evil.srt")) && !existsSync(join(app.paths.root, "evil.srt")));
	app.close();
});

test("season pack: files attributed to episodes, bilingual preferred, placed with Jellyfin names", async () => {
	const { app, downloads, library } = tempApp();
	insertTitle(app, { id: "tv:95396", kind: "tv", tmdb_id: 95396, name: "人生切割术", folder_name: "Severance", year: 2022 });
	const dir = join(downloads, "Severance.S01.1080p.WEB-DL");
	for (const e of [1, 2]) touch(join(dir, `Severance.S01E0${e}.1080p.WEB-DL.mkv`), 1000);
	applyPlan(app, autoPlan(app, getTitle(app, "tv:95396")!, dir).plan);

	const zip = makeZip([
		{ name: "Severance.S01E01.简体.srt", data: encodeGbk(srt(Array(20).fill("我们这个时来说"))), gbkName: true },
		{ name: "Severance.S01E01.chs&eng.ass", data: Buffer.from(`[Script Info]\n\n[Events]\n${Array(20).fill("Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,我们这个来说\\NWe say this here").join("\n")}`) },
		{ name: "Severance.S01E02.chs.srt", data: Buffer.from(srt(Array(20).fill("我们这个时来说"))) },
	]);
	const f = join(app.paths.workspace, "pack.zip");
	writeFileSync(f, zip);
	const out = await processLocalSubtitle(app, f, { title_id: "tv:95396", season: 1 });
	const placed = out.results.map((r) => r.placed!.slice(library.length));
	assert.deepEqual(placed, [
		"/Shows/Severance (2022) [tmdbid-95396]/Season 01/Severance (2022) S01E01.简英双语.zh.default.ass",
		"/Shows/Severance (2022) [tmdbid-95396]/Season 01/Severance (2022) S01E02.简体.zh.default.srt",
	]);
	const e1 = readFileSync(out.results[0]!.placed!, "utf8");
	assert.ok(e1.startsWith("﻿[Script Info]"), "ASS written as UTF-8 with BOM");
	// placing again changes nothing
	const again = await processLocalSubtitle(app, f, { title_id: "tv:95396", season: 1 });
	assert.ok(again.results.every((r) => r.warnings.includes("already in place")));
	assert.equal(readdirSync(join(library, "Shows", "Severance (2022) [tmdbid-95396]", "Season 01")).filter((n) => /\.(srt|ass)$/.test(n)).length, 2);
	app.close();
});
