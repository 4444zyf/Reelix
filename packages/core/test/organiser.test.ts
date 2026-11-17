import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyPlan, autoPlan } from "../src/organiser.ts";
import { removeFromLibrary, restoreRemoved, listRemoved } from "../src/library.ts";
import { getTitle } from "../src/titles.ts";
import { insertTitle, tempApp, touch } from "./helpers.ts";

test("movie: code plan, real hard link, repeat-safe, conflict detection", () => {
	const { app, downloads, library } = tempApp();
	insertTitle(app, { id: "movie:872585", kind: "movie", tmdb_id: 872585, name: "奥本海默", folder_name: "Oppenheimer", year: 2023 });
	const dir = join(downloads, "Oppenheimer.2023.2160p.WEB-DL.DDP5.1.H.265-GRP");
	const video = touch(join(dir, "Oppenheimer.2023.2160p.WEB-DL.DDP5.1.H.265-GRP.mkv"), 4096);
	touch(join(dir, "Oppenheimer.2023.2160p.WEB-DL.DDP5.1.H.265-GRP.chs.ass"));
	touch(join(dir, "Sample", "sample.mkv"), 64);
	touch(join(dir, "@eaDir", "thumb.jpg"));

	const { plan, problems } = autoPlan(app, getTitle(app, "movie:872585")!, dir);
	assert.deepEqual(problems, []);
	const v = plan.items.find((i) => i.kind === "video")!;
	assert.equal(v.dest, join(library, "Movies", "Oppenheimer (2023) [tmdbid-872585]", "Oppenheimer (2023) [tmdbid-872585] - 2160p.mkv"));
	const sub = plan.items.find((i) => i.kind === "subtitle")!;
	assert.match(sub.dest, /Oppenheimer \(2023\) \[tmdbid-872585\] - 2160p\.zh\.ass$/);
	assert.ok(!plan.items.some((i) => /sample/i.test(i.source)), "sample skipped");

	const r1 = applyPlan(app, plan);
	assert.deepEqual(r1.map((r) => r.status), ["linked", "linked"]);
	assert.equal(statSync(v.dest).ino, statSync(video).ino, "same inode: a hard link");
	const r2 = applyPlan(app, plan);
	assert.deepEqual(r2.map((r) => r.status), ["already", "already"], "applying twice changes nothing");

	// a different file at the destination is a conflict, never replaced
	const other = touch(join(downloads, "other.mkv"), 10);
	const r3 = applyPlan(app, { items: [{ source: other, dest: v.dest, kind: "video" }] });
	assert.equal(r3[0]!.status, "conflict");
	assert.equal(statSync(v.dest).ino, statSync(video).ino);
	app.close();
});

test("apply refuses sources outside downloads and destinations outside the library", () => {
	const { app, root, library } = tempApp();
	const outside = touch(join(root, "elsewhere", "x.mkv"));
	const r = applyPlan(app, { items: [{ source: outside, dest: join(library, "Movies", "X", "x.mkv"), kind: "video" }] });
	assert.equal(r[0]!.status, "failed");
	assert.match(r[0]!.error!, /outside the download folder/);
	const src = touch(join(app.config.downloads!, "y.mkv"));
	const r2 = applyPlan(app, { items: [{ source: src, dest: join(root, "y.mkv"), kind: "video" }] });
	assert.match(r2[0]!.error!, /outside the library/);
	// .. traversal
	const r3 = applyPlan(app, { items: [{ source: src, dest: join(library, "Movies", "..", "..", "evil.mkv"), kind: "video" }] });
	assert.equal(r3[0]!.status, "failed");
	app.close();
});

test("cross-filesystem link fails with an explanation and no copy", (t) => {
	if (!existsSync("/dev/shm")) return t.skip("no /dev/shm");
	const { app, library } = tempApp();
	const shm = mkdtempSync("/dev/shm/reelix-");
	app.setConfig("downloads", shm);
	const src = join(shm, "a.mkv");
	writeFileSync(src, "x");
	const dest = join(library, "Movies", "A (2020)", "A (2020).mkv");
	const r = applyPlan(app, { items: [{ source: src, dest, kind: "video" }] });
	assert.equal(r[0]!.status, "failed");
	assert.match(r[0]!.error!, /different mounted filesystems/);
	assert.ok(!existsSync(dest), "no fallback copy");
	app.close();
});

test("read-only library folder fails cleanly", (t) => {
	if (process.getuid?.() === 0) return t.skip("root ignores permissions");
	const { app, downloads, library } = tempApp();
	const src = touch(join(downloads, "b.mkv"));
	const ro = join(library, "Movies");
	chmodSync(ro, 0o555);
	const r = applyPlan(app, { items: [{ source: src, dest: join(ro, "B (2020)", "B (2020).mkv"), kind: "video" }] });
	chmodSync(ro, 0o755);
	assert.equal(r[0]!.status, "failed");
	app.close();
});

test("tv: episodes from a season pack, wanted subset, missing episode reported", () => {
	const { app, downloads, library } = tempApp();
	insertTitle(app, { id: "tv:95396", kind: "tv", tmdb_id: 95396, name: "人生切割术", folder_name: "Severance", year: 2022 });
	const dir = join(downloads, "Severance.S01.1080p.WEB-DL");
	for (const e of [1, 2, 4]) touch(join(dir, `Severance.S01E0${e}.1080p.WEB-DL.mkv`), 1000);
	touch(join(dir, "Severance.S01E01E02.1080p.mkv"), 10); // tiny: treated as a sample

	const wanted = [1, 2, 3].map((episode) => ({ season: 1, episode }));
	const { plan, problems } = autoPlan(app, getTitle(app, "tv:95396")!, dir, { wanted });
	const dests = plan.items.map((i) => i.dest.slice(library.length));
	assert.deepEqual(dests.sort(), ["/Shows/Severance (2022) [tmdbid-95396]/Season 01/Severance (2022) S01E01.mkv", "/Shows/Severance (2022) [tmdbid-95396]/Season 01/Severance (2022) S01E02.mkv"]);
	assert.ok(problems.some((p) => /1x3/.test(p)), "missing E03 reported");
	app.close();
});

test("multi-episode file and anime absolute numbering", () => {
	const { app, downloads } = tempApp();
	insertTitle(app, { id: "tv:1", kind: "tv", tmdb_id: 1, name: "Show", year: 2020 });
	const f = touch(join(downloads, "Show.S02E05-E06.720p.HDTV.mkv"), 100);
	const { plan } = autoPlan(app, getTitle(app, "tv:1")!, f);
	assert.match(plan.items[0]!.dest, /Season 02\/Show \(2020\) S02E05-E06\.mkv$/);

	insertTitle(app, { id: "tv:209867", kind: "tv", tmdb_id: 209867, name: "葬送的芙莉莲", folder_name: "Frieren", year: 2023, media_class: "anime" });
	const a = touch(join(downloads, "[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv"), 100);
	const r1 = autoPlan(app, getTitle(app, "tv:209867")!, a);
	assert.ok(r1.problems.some((p) => /Absolute/.test(p)), "absolute numbering without mapping goes to the agent");
	const r2 = autoPlan(app, getTitle(app, "tv:209867")!, a, { seasonHint: 1 });
	assert.match(r2.plan.items[0]!.dest, /Anime\/Frieren \(2023\) \[tmdbid-209867\]\/Season 01\/Frieren \(2023\) S01E05\.mkv$/);
	app.close();
});

test("unexpected structure goes to the agent: two feature files, RAR, disc", () => {
	const { app, downloads, library } = tempApp();
	insertTitle(app, { id: "movie:2", kind: "movie", tmdb_id: 2, name: "Film", year: 2001 });
	const t = getTitle(app, "movie:2")!;
	const two = join(downloads, "two");
	touch(join(two, "Film.2001.CD1.mkv"), 1000);
	touch(join(two, "Film.2001.CD2.mkv"), 1000);
	assert.ok(autoPlan(app, t, two).problems.length > 0);

	const rar = join(downloads, "rar");
	touch(join(rar, "film.rar"), 1000);
	touch(join(rar, "film.r00"), 1000);
	assert.match(autoPlan(app, t, rar).problems[0]!, /RAR/);

	const disc = join(downloads, "Film.2001.BluRay");
	touch(join(disc, "BDMV", "STREAM", "00001.m2ts"), 1000);
	touch(join(disc, "BDMV", "index.bdmv"), 10);
	const dp = autoPlan(app, t, disc);
	assert.deepEqual(dp.problems, []);
	assert.equal(dp.plan.items[0]!.kind, "disc");
	const res = applyPlan(app, dp.plan);
	assert.equal(res[0]!.status, "linked");
	assert.ok(existsSync(join(library, "Movies", "Film (2001) [tmdbid-2]", "BDMV", "STREAM", "00001.m2ts")));
	app.close();
});

test("remove: link-only removal is restorable; last copy goes to trash with .ignore", async () => {
	const { app, downloads, library } = tempApp();
	insertTitle(app, { id: "movie:3", kind: "movie", tmdb_id: 3, name: "Gone", year: 1999 });
	const src = touch(join(downloads, "Gone.1999.1080p.BluRay.mkv"), 500);
	const { plan } = autoPlan(app, getTitle(app, "movie:3")!, src);
	applyPlan(app, plan);
	const dest = plan.items[0]!.dest;

	const r = await removeFromLibrary(app, { title_id: "movie:3", level: "entry" });
	assert.deepEqual(r.unlinked, [dest]);
	assert.ok(!existsSync(dest) && existsSync(src));
	const removed = listRemoved(app, "movie:3");
	assert.equal(removed.length, 1);
	assert.ok(removed[0]!.restorable);
	assert.deepEqual(restoreRemoved(app, [removed[0]!.id]).restored, [dest]);
	assert.equal(statSync(dest).ino, statSync(src).ino);

	// now the torrent's data disappears; the library copy is the last one
	const { rmSync } = await import("node:fs");
	rmSync(src);
	const r2 = await removeFromLibrary(app, { title_id: "movie:3", level: "entry" });
	assert.deepEqual(r2.trashed, [dest]);
	assert.ok(existsSync(join(library, "Movies", ".reelix-trash", ".ignore")));
	const again = listRemoved(app, "movie:3").find((x) => x.trash_path);
	assert.ok(again?.restorable);
	assert.ok(!existsSync(join(library, "Movies", "Gone (1999) [tmdbid-3]")), "empty folder pruned");
	app.close();
});

test("subtitles in a Subs folder follow a single film", () => {
	const { app, downloads } = tempApp();
	insertTitle(app, { id: "movie:4", kind: "movie", tmdb_id: 4, name: "Sub", year: 2010 });
	const dir = join(downloads, "Sub.2010.1080p.BluRay.x264-G");
	mkdirSync(dir, { recursive: true });
	touch(join(dir, "Sub.2010.1080p.BluRay.x264-G.mkv"), 1000);
	touch(join(dir, "Subs", "2_Chinese.srt"));
	touch(join(dir, "Subs", "3_English.srt"));
	const { plan } = autoPlan(app, getTitle(app, "movie:4")!, dir);
	const subs = plan.items.filter((i) => i.kind === "subtitle");
	assert.equal(subs.length, 2);
	assert.equal(new Set(subs.map((s) => s.dest)).size, 2, "distinct names");
	app.close();
});
