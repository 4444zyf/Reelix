import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { applyPlan, autoPlan } from "../src/organiser.ts";
import { parseSubhdSearch } from "../src/subtitles/sources.ts";
import { decodeSubtitle, detectLanguage, lastTimestamp, unpackSubtitles } from "../src/subtitles/text.ts";
import { processLocalSubtitle } from "../src/subtitles/pipeline.ts";
import { getTitle } from "../src/titles.ts";
import { insertTitle, tempApp, touch } from "./helpers.ts";

/** Minimal zip writer (deflate), names in GBK unless utf8 is set — like old Chinese archives. */
function makeZip(entries: { name: string; data: Buffer; gbkName?: boolean }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = e.gbkName ? encodeGbk(e.name) : Buffer.from(e.name, "utf8");
		const comp = deflateRawSync(e.data);
		const crc = crc32(e.data);
		const flags = e.gbkName ? 0 : 0x800;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(comp.length, 18);
		local.writeUInt32LE(e.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, comp);
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0);
		c.writeUInt16LE(20, 4);
		c.writeUInt16LE(20, 6);
		c.writeUInt16LE(flags, 8);
		c.writeUInt16LE(8, 10);
		c.writeUInt32LE(crc, 16);
		c.writeUInt32LE(comp.length, 20);
		c.writeUInt32LE(e.data.length, 24);
		c.writeUInt16LE(name.length, 28);
		c.writeUInt32LE(offset, 42);
		centrals.push(c, name);
		offset += 30 + name.length + comp.length;
	}
	const cd = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

// A tiny GBK encoder for the handful of characters used in the tests.
const GBK: Record<string, number[]> = { 简: [0xbc, 0xf2], 体: [0xcc, 0xe5], 繁: [0xb7, 0xb1], 中: [0xd6, 0xd0], 文: [0xce, 0xc4], 们: [0xc3, 0xc7], 这: [0xd5, 0xe2], 说: [0xcb, 0xb5], 个: [0xb8, 0xf6], 来: [0xc0, 0xb4], 时: [0xca, 0xb1], 我: [0xce, 0xd2], 的: [0xb5, 0xc4], 你: [0xc4, 0xe3], 是: [0xca, 0xc7], 好: [0xba, 0xc3], 了: [0xc1, 0xcb], 完: [0xcd, 0xea] };
function encodeGbk(s: string): Buffer {
	const out: number[] = [];
	for (const ch of s) {
		if (ch.charCodeAt(0) < 128) out.push(ch.charCodeAt(0));
		else if (GBK[ch]) out.push(...GBK[ch]!);
		else throw new Error(`no gbk for ${ch}`);
	}
	return Buffer.from(out);
}

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

test("subhd search page parsing (hand-written fixture in subhd's structure)", () => {
	const html = `<html><div class="bg-white shadow-sm rounded-3 mb-4"><div class="row"><div class="col-2"><a href='/d/1234567'><img alt="示例 Example"></a></div>
	<div class="col-lg-10"><div class="clearfix"><div class="float-start f16 fw-bold"> <a class="link-dark" href='/a/AbC123'>示例电影</a> </div>
	<div class="view-text text-secondary"> <a href='/a/AbC123'> Example.2023.1080p.WEB-DL.H264-GRP </a> </div>
	<div class="text-truncate py-2 f11"> <span class="rounded p-1 me-1 text-white">官方字幕</span> <span class="p-1 fw-bold">简体 双语</span> <span class="p-1 text-secondary">ASS</span> </div>
	<div class="pt-2 text-secondary f12"><span class='align-text-top me-3'>120k</span><span class="align-text-top me-3">88</span><time datetime="2024-01-02T03:04:05.000Z"></time></div>
	<div class="pt-1 f12 text-secondary"> 发布人 <a class="fw-bold text-dark" href='/u/x'>someone</a> </div></div></div></div></html>`;
	const r = parseSubhdSearch(html);
	assert.equal(r.length, 1);
	assert.deepEqual({ ref: r[0]!.ref, doubanId: r[0]!.doubanId, title: r[0]!.title, release: r[0]!.release, languages: r[0]!.languages, formats: r[0]!.formats, tags: r[0]!.tags, downloads: r[0]!.downloads, uploader: r[0]!.uploader }, {
		ref: "subhd:AbC123",
		doubanId: "1234567",
		title: "示例电影",
		release: "Example.2023.1080p.WEB-DL.H264-GRP",
		languages: ["简体", "双语"],
		formats: ["ASS"],
		tags: ["官方字幕"],
		downloads: 88,
		uploader: "someone",
	});
});
