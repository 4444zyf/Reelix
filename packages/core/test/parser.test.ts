import assert from "node:assert/strict";
import { test } from "node:test";
import { chineseNumber, parseReleaseName, titleVariants } from "../src/parser.ts";

// The set grows from real names met in use (§5.2). No fixtures from MoviePilot.
const cases: [string, Partial<ReturnType<typeof parseReleaseName>>][] = [
	["Oppenheimer.2023.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLUX", { title: "Oppenheimer", year: 2023, resolution: "2160p", source: "WEB-DL", codec: "x265", group: "FLUX" }],
	["Severance.S01E03.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb", { title: "Severance", season: 1, episodes: [3], resolution: "1080p" }],
	["The.Bear.S02.1080p.DSNP.WEB-DL.DDP5.1.H.264-NTb", { title: "The Bear", season: 2, complete: true }],
	["1917.2019.1080p.BluRay.x264-SPARKS", { title: "1917", year: 2019, source: "BluRay" }],
	["2012.2009.BluRay.1080p.DTS-HD.MA.5.1.AVC.REMUX-FraMeSToR", { title: "2012", year: 2009, source: "Remux" }],
	["[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv", { title: "Sousou no Frieren", episodes: [5], absolute: true, group: "SubsPlease" }],
	["[Nekomoe kissaten][Sousou no Frieren][01-28][1080p][CHS]", { episodes: Array.from({ length: 28 }, (_, i) => i + 1), absolute: true, chineseSubs: "simplified" }],
	["奥本海默 Oppenheimer 2023 2160p WEB-DL H265 DDP5.1-ADWeb 简英双语", { year: 2023, chineseSubs: "bilingual" }],
	["漫长的季节 第一季 全12集 2023 1080p WEB-DL", { season: 1, complete: true, year: 2023 }],
	["Show.S01E01-E03.720p.HDTV", { season: 1, episodes: [1, 2, 3] }],
	["Show.S03E09E10.1080p", { season: 3, episodes: [9, 10] }],
	["Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1.Atmos-FGT", { title: "Dune Part Two", year: 2024, source: "Remux", hdr: ["DV", "HDR"] }],
	["Friends.S01-S10.1080p.BluRay.x265", { title: "Friends", seasons: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
];

for (const [name, want] of cases) {
	test(`parse: ${name}`, () => {
		const got = parseReleaseName(name);
		for (const [k, v] of Object.entries(want)) assert.deepEqual((got as any)[k], v, `${k} of ${name}: ${JSON.stringify(got)}`);
	});
}

test("chinese numbers", () => {
	assert.equal(chineseNumber("二"), 2);
	assert.equal(chineseNumber("十二"), 12);
	assert.equal(chineseNumber("二十一"), 21);
	assert.equal(chineseNumber("12"), 12);
});

test("title variants split Chinese and English", () => {
	assert.deepEqual(titleVariants("奥本海默 Oppenheimer").sort(), ["Oppenheimer", "奥本海默", "奥本海默 Oppenheimer"].sort());
});
