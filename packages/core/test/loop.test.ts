import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { QbClient } from "../src/clients/qbittorrent.ts";
import { fileDownload, getDownload, watchTick, type WatchEvent } from "../src/downloads.ts";
import { runOperation } from "../src/registry.ts";
import { parseTorrent } from "../src/torrent.ts";
import { ReelixError } from "../src/util.ts";
import { makeTorrent } from "./fakes/bencode.ts";
import { startFakeJackett, type FakeIndexer } from "./fakes/jackett.ts";
import { startFakeQb, type FakeQbVersion, type MagnetMeta } from "./fakes/qbittorrent.ts";
import { startFakeTmdb } from "./fakes/tmdb.ts";
import { tempApp } from "./helpers.ts";

// probe() looks for ffprobe in ./.tools/bin; run from elsewhere so no real binary is ever executed
// (the cheap content check is then skipped, as on a system without ffprobe).
process.chdir(tmpdir());

const JACKETT_KEY = "jk_7f3a9c2e5b1d48e6a0c4";
const QB_PASSWORD = "qb-secret-pass";
const GB = 1_000_000_000;

// ------------------------------------------------------------------ fixtures

const SINTEL_1080 = "Sintel.2010.1080p.BluRay.x264-GRP";
const sintel1080 = makeTorrent(SINTEL_1080, [
	{ path: [`${SINTEL_1080}.mkv`], length: 1.2 * GB },
	{ path: [`${SINTEL_1080}.chs.srt`], length: 40_000 },
	{ path: ["Sample", "sample.mkv"], length: 30_000_000 },
]);
const SINTEL_2160 = "Sintel.2010.2160p.WEB-DL.x265-OTHER";
const sintel2160 = makeTorrent(SINTEL_2160, [{ path: [`${SINTEL_2160}.mkv`], length: 4 * GB }]);

const OPP = "Oppenheimer.2023.2160p.WEB-DL.DDP5.1.H.265-GRP";
const oppenheimer = makeTorrent(OPP, [{ path: [`${OPP}.mkv`], length: 20 * GB }]);

const SEV = "Severance.S01.1080p.WEB-DL.x265-GRP";
const SEV_EPS = [1, 2, 3, 4, 6, 7, 8, 9]; // episode 5 is missing from this pack
const severancePack = makeTorrent(
	SEV,
	SEV_EPS.map((e) => ({ path: [`Severance.S01E0${e}.1080p.WEB-DL.x265-GRP.mkv`], length: 1.5 * GB })),
);

const hashOf = (b: Uint8Array) => parseTorrent(b).infoHash;
const fakeHash = (s: string) => createHash("sha1").update(s).digest("hex");

const FRIEREN_RAR_HASH = fakeHash("frieren rar pack");
const FRIEREN_RAR_MAGNET = `magnet:?xt=urn:btih:${FRIEREN_RAR_HASH}&dn=Frieren.S01.1080p.WEB.RARed-GRP`;
const FRIEREN_RAR_META: MagnetMeta = {
	name: "Frieren.S01.1080p.WEB.RARed-GRP",
	files: [
		{ path: "Frieren.S01.1080p.WEB.RARed-GRP/frieren.s01.rar", size: 500_000_000 },
		{ path: "Frieren.S01.1080p.WEB.RARed-GRP/frieren.s01.r00", size: 500_000_000 },
		{ path: "Frieren.S01.1080p.WEB.RARed-GRP/frieren.s01.r01", size: 500_000_000 },
		{ path: "Frieren.S01.1080p.WEB.RARed-GRP/frieren.s01.nfo", size: 2_000 },
	],
};

const FRIEREN_OK_HASH = fakeHash("frieren good release");
const FRIEREN_OK_MAGNET = `magnet:?xt=urn:btih:${FRIEREN_OK_HASH}&dn=%5BGRP%5D+Sousou+no+Frieren+-+01`;
const FRIEREN_OK_META: MagnetMeta = { name: "[GRP] Sousou no Frieren - 01 [1080p].mkv", files: [{ path: "[GRP] Sousou no Frieren - 01 [1080p].mkv", size: 1.4 * GB }] };

function defaultIndexers(): FakeIndexer[] {
	return [
		{
			id: "alpha",
			name: "Alpha",
			results: [
				{ title: SINTEL_1080, size: 1.2 * GB, seeders: 40, peers: 3, torrent: sintel1080, category: [2040] },
				{ title: SINTEL_2160, size: 4 * GB, seeders: 12, peers: 1, torrent: sintel2160, category: [2045] },
				{ title: OPP, size: 20 * GB, seeders: 90, torrent: oppenheimer, category: [2045] },
				{ title: SEV, size: 12 * GB, seeders: 30, torrent: severancePack, category: [5040] },
			],
		},
		{
			id: "beta",
			name: "Beta",
			results: [
				// the same Sintel release as Alpha's, fewer seeders: must be de-duplicated
				{ title: SINTEL_1080, size: 1.2 * GB, seeders: 7, torrent: sintel1080, category: [2040] },
				{ title: "Frieren.S01.1080p.WEB.RARed-GRP", size: 1.5 * GB, seeders: 20, magnet: FRIEREN_RAR_MAGNET, category: [5070] },
				{ title: "[GRP] Sousou no Frieren - 01 [1080p]", size: 1.4 * GB, seeders: 50, magnet: FRIEREN_OK_MAGNET, magnetInResult: true, infoHash: FRIEREN_OK_HASH, category: [5070] },
			],
		},
		{ id: "broken", name: "Broken", results: [], fail: "Cloudflare challenge could not be solved" },
	];
}

async function world(opts: { version?: FakeQbVersion; magnets?: Record<string, MagnetMeta> } = {}) {
	const t = tempApp();
	const qb = await startFakeQb({ version: opts.version, downloadsDir: t.downloads, password: QB_PASSWORD, magnets: opts.magnets });
	const jackett = await startFakeJackett({ apiKey: JACKETT_KEY, indexers: defaultIndexers() });
	const tmdb = await startFakeTmdb();
	const { app } = t;
	app.setConfig("qbittorrent", { url: qb.url, username: "admin" });
	app.setSecret("qbittorrent.password", QB_PASSWORD);
	app.setConfig("jackett", { url: jackett.url });
	app.setSecret("jackett.api_key", JACKETT_KEY);
	app.setConfig("tmdb.base_url", tmdb.url);
	app.setSecret("tmdb.api_key", tmdb.apiKey);
	app.setConfig("path_maps", { qbittorrent: [{ theirs: "/downloads", ours: t.downloads }], jellyfin: [] });
	const run = (name: string, input: unknown, requestId?: string) => runOperation(app, name, input, { actor: "agent:test", requestId });
	return {
		...t,
		qb,
		jackett,
		tmdb,
		run,
		async close() {
			app.close();
			await Promise.all([qb.close(), jackett.close(), tmdb.close()]);
		},
	};
}

function assertNoLeak(what: string, s: string) {
	assert.ok(!s.includes(JACKETT_KEY), `${what} contains the Jackett API key`);
	assert.ok(!s.includes("/dl/"), `${what} contains a Jackett download link`);
	assert.ok(!s.includes("jackett_apikey"), `${what} contains a jackett_apikey parameter`);
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<ReelixError> {
	try {
		await p;
	} catch (e) {
		assert.ok(e instanceof ReelixError, `expected a ReelixError, got ${String(e)}`);
		assert.equal(e.code, code, e.message);
		return e;
	}
	assert.fail(`expected an error with code ${code}`);
}

// ------------------------------------------------------------------ (a) the whole loop

test("get me Sintel: find, search, look inside, add, complete, file", async () => {
	const w = await world();
	try {
		// identify: a bare name gives candidates, the chosen ID settles it
		const found = await w.run("title.find", { query: "Sintel" });
		const fo = found.output as any;
		assert.equal(fo.resolved, undefined, "a bare name without a year is not accepted by code");
		assert.ok(fo.candidates.some((c: any) => c.id === "movie:45745" && c.year === 2010));
		const picked = await w.run("title.find", { id: "movie:45745" });
		const title = (picked.output as any).resolved;
		assert.equal(title.id, "movie:45745");
		assert.equal(title.folder_name, "Sintel");
		assert.equal(title.media_class, "movie");
		assert.equal(title.imdb_id, "tt1727587");
		assert.match(picked.text, /movie:45745/);
		// with the year, an exact match is accepted by code
		const withYear = await w.run("title.find", { query: "Sintel (2010)" });
		assert.equal((withYear.output as any).resolved?.id, "movie:45745");

		// search
		const search = await w.run("release.search", { title_id: "movie:45745" });
		const so = search.output as any;
		assertNoLeak("release.search text", search.text);
		assertNoLeak("release.search output", JSON.stringify(so));
		assert.equal(so.indexers.length, 3);
		const broken = so.indexers.find((i: any) => i.indexer === "broken");
		assert.equal(broken.ok, false);
		assert.match(broken.error, /Cloudflare/);
		assert.ok(so.indexers.find((i: any) => i.indexer === "alpha").ok);
		assert.ok(so.indexers.find((i: any) => i.indexer === "beta").ok);
		assert.match(search.text, /Broken: ERROR .*Cloudflare/);
		assert.match(search.text, /Alpha: \d+ in/);
		const sintels = so.all.filter((r: any) => /^Sintel/.test(r.title));
		assert.equal(sintels.length, 2, "the 1080p release found on two indexers is listed once");
		const r1080 = sintels.find((r: any) => r.parsed.resolution === "1080p");
		assert.equal(r1080.seeders, 40, "the copy with more seeders is kept");
		assert.match(r1080.handle, /^r/);
		assert.ok(search.text.includes(r1080.handle));

		// look inside
		const files = await w.run("release.files", { handle: r1080.handle });
		assert.equal((files.output as any).files.length, 3);
		assert.equal((files.output as any).hash, hashOf(sintel1080));
		assert.match(files.text, /3 files/);
		assert.doesNotMatch(files.text, /RAR-PACKED/);
		assertNoLeak("release.files text", files.text);
		assertNoLeak("release.files output", JSON.stringify(files.output));

		// add
		const added = await w.run("download.add", { handle: r1080.handle, title_id: "movie:45745", reason: "1080p BluRay, small, most seeders" });
		const ao = added.output as any;
		const hash = hashOf(sintel1080);
		assert.equal(ao.hash, hash);
		assert.equal(ao.adopted, false);
		assert.equal(ao.started, true);
		assert.equal(ao.files, 3);
		assertNoLeak("download.add text", added.text);
		assertNoLeak("download.add output", JSON.stringify(ao));
		const qt = w.qb.torrents.get(hash)!;
		assert.ok(qt.tags.has("reelix"), "tagged reelix");
		assert.equal(qt.stopped, false, "started after the checks");
		const addCall = w.qb.calls.find((c) => c.path === "torrents/add")!;
		assert.equal(addCall.form.stopped, "true", "added stopped first");
		assert.ok(w.jackett.downloads.length >= 1, "the .torrent was fetched by Reelix through the Jackett link");
		const row = getDownload(w.app, hash)!;
		assert.equal(row.title_id, "movie:45745");
		assert.equal(row.reason, "1080p BluRay, small, most seeders");
		assert.equal(row.state, "downloading");
		assertNoLeak("downloads.release_json", row.release_json);
		const status = await w.run("download.status", { hash });
		assertNoLeak("download.status output", JSON.stringify(status.output));
		const ledger = w.app.db.prepare("SELECT * FROM actions WHERE op = 'download.add'").get() as any;
		assert.equal(ledger.status, "succeeded");
		assertNoLeak("ledger row", JSON.stringify(ledger));

		// watch: nothing yet, then completed
		const ws = { rid: 0, known: new Map() };
		assert.deepEqual(await watchTick(w.app, ws), []);
		w.qb.complete(hash);
		const events = await watchTick(w.app, ws);
		assert.deepEqual(events, [{ kind: "completed", hash }] satisfies WatchEvent[]);
		const done = getDownload(w.app, hash)!;
		assert.equal(done.state, "complete");
		assert.equal(done.content_path, join(w.downloads, SINTEL_1080), "content path mapped from qBittorrent's /downloads to ours");
		assert.deepEqual(await watchTick(w.app, ws), [], "completion is reported once");

		// file
		const outcome = await fileDownload(w.app, hash);
		assert.deepEqual(outcome.problems, []);
		assert.equal(outcome.filed, true);
		const folder = join(w.library, "Movies", "Sintel (2010) [tmdbid-45745]");
		const dest = join(folder, "Sintel (2010) [tmdbid-45745] - 1080p.mkv");
		assert.ok(existsSync(dest));
		assert.equal(statSync(dest).ino, statSync(join(w.downloads, SINTEL_1080, `${SINTEL_1080}.mkv`)).ino, "hard link");
		assert.ok(existsSync(join(folder, "Sintel (2010) [tmdbid-45745] - 1080p.zh.srt")), "subtitle follows the video");
		assert.deepEqual(readdirSync(folder).sort(), ["Sintel (2010) [tmdbid-45745] - 1080p.mkv", "Sintel (2010) [tmdbid-45745] - 1080p.zh.srt"], "sample skipped");
		assert.equal(getDownload(w.app, hash)!.state, "filed");
		assert.ok(w.qb.torrents.get(hash)!.tags.has("reelix-filed"));
		const t = w.app.db.prepare("SELECT library_folder FROM titles WHERE id = 'movie:45745'").get() as any;
		assert.equal(t.library_folder, folder);
		// filing again changes nothing
		const again = await fileDownload(w.app, hash);
		assert.ok(again.results?.every((r) => r.status === "already"));
	} finally {
		await w.close();
	}
});

// ------------------------------------------------------------------ (b) a partial season pack with a missing episode

test("season pack: only wanted episodes downloaded; a missing wanted episode goes to the agent", async () => {
	const w = await world();
	try {
		await w.run("title.find", { id: "tv:95396" });
		const search = await w.run("release.search", { title_id: "tv:95396", season: 1 });
		const pack = (search.output as any).all.find((r: any) => r.title === SEV);
		assert.ok(pack, "the season pack is found");
		const files = (await w.run("release.files", { handle: pack.handle })).output as any;
		const idx = (e: number) => files.files.findIndex((f: any) => f.path.includes(`S01E0${e}.`));
		assert.equal(idx(5), -1, "the pack really lacks episode 5");
		const only = [idx(4), idx(6)];

		const added = await w.run("download.add", {
			handle: pack.handle,
			title_id: "tv:95396",
			episodes: [4, 5, 6].map((episode) => ({ season: 1, episode })),
			only_files: only,
			reason: "the only S01 pack",
		});
		const hash = (added.output as any).hash;
		assert.equal((added.output as any).skipped_files, SEV_EPS.length - 2);
		const qt = w.qb.torrents.get(hash)!;
		assert.deepEqual(
			qt.files.map((f, i) => (only.includes(i) ? 1 : 0)),
			qt.files.map((f) => f.priority),
			"unwanted files set to do-not-download before starting",
		);
		assert.equal(qt.stopped, false);
		const prioCall = w.qb.calls.findIndex((c) => c.path === "torrents/filePrio");
		const startCall = w.qb.calls.findIndex((c) => c.path === "torrents/start");
		assert.ok(prioCall >= 0 && prioCall < startCall, "priorities set before starting");

		const ws = { rid: 0, known: new Map() };
		await watchTick(w.app, ws);
		w.qb.complete(hash);
		assert.deepEqual(await watchTick(w.app, ws), [{ kind: "completed", hash }]);
		assert.ok(!existsSync(join(w.downloads, SEV, "Severance.S01E01.1080p.WEB-DL.x265-GRP.mkv")), "skipped files were not downloaded");
		assert.ok(existsSync(join(w.downloads, SEV, "Severance.S01E04.1080p.WEB-DL.x265-GRP.mkv")));

		const outcome = await fileDownload(w.app, hash);
		assert.equal(outcome.filed, false);
		assert.ok(outcome.problems.some((p) => /Wanted episodes not found.*1x5/.test(p)), outcome.problems.join("; "));
		const planned = outcome.plan.items.filter((i) => i.kind === "video").map((i) => i.dest);
		assert.deepEqual(planned, [
			join(w.library, "Shows", "Severance (2022) [tmdbid-95396]", "Season 01", "Severance (2022) S01E04.mkv"),
			join(w.library, "Shows", "Severance (2022) [tmdbid-95396]", "Season 01", "Severance (2022) S01E06.mkv"),
		]);
		const row = getDownload(w.app, hash)!;
		assert.equal(row.state, "needs_agent");
		assert.match(row.note ?? "", /1x5/);
		assert.deepEqual(readdirSync(join(w.library, "Shows")), [], "nothing linked while there are problems");
	} finally {
		await w.close();
	}
});

// ------------------------------------------------------------------ (c) a magnet that turns out RAR-packed

test("magnet release: added stopped, metadata arrives, RAR-packed list → removed with rar_packed", async () => {
	const w = await world({ magnets: { [FRIEREN_RAR_HASH]: FRIEREN_RAR_META } });
	try {
		const t = (await w.run("title.find", { id: "tv:209867" })).output as any;
		assert.equal(t.resolved.media_class, "anime");
		assert.equal(t.resolved.folder_name, "Frieren: Beyond Journey's End");
		const search = await w.run("release.search", { title_id: "tv:209867", query: "Frieren" });
		assertNoLeak("release.search text", search.text);
		assertNoLeak("release.search output", JSON.stringify(search.output));
		const rar = (search.output as any).all.find((r: any) => /RARed/.test(r.title));
		assert.ok(rar);
		const files = await w.run("release.files", { handle: rar.handle });
		assert.equal((files.output as any).magnetOnly, true);
		assert.equal((files.output as any).hash, FRIEREN_RAR_HASH, "the link redirected to the magnet");
		assertNoLeak("release.files output", JSON.stringify(files.output));

		await rejectsWith(w.run("download.add", { handle: rar.handle, title_id: "tv:209867", reason: "test" }), "rar_packed");
		const add = w.qb.calls.find((c) => c.path === "torrents/add")!;
		assert.equal(add.form.urls, FRIEREN_RAR_MAGNET);
		assert.equal(add.form.stopped, "true", "magnet added stopped");
		assert.equal(add.form.tags, "reelix");
		const del = w.qb.calls.find((c) => c.path === "torrents/delete")!;
		assert.equal(del.form.hashes, FRIEREN_RAR_HASH);
		assert.equal(del.form.deleteFiles, "true");
		assert.ok(!w.qb.torrents.has(FRIEREN_RAR_HASH), "removed from qBittorrent");
		assert.ok(!w.qb.hits().includes("torrents/start"), "never started");
		assert.equal(getDownload(w.app, FRIEREN_RAR_HASH), undefined, "not recorded as a download");
		const ledger = w.app.db.prepare("SELECT status, error FROM actions WHERE op = 'download.add'").get() as any;
		assert.equal(ledger.status, "failed");
		assert.match(ledger.error, /RAR-packed/);
	} finally {
		await w.close();
	}
});

// ------------------------------------------------------------------ (d) adopting instead of duplicating

test("re-adding a torrent qBittorrent already has adopts it instead of duplicating", async () => {
	const w = await world();
	try {
		// someone added it by hand, untagged
		const direct = new QbClient({ url: w.qb.url, username: "admin", password: QB_PASSWORD });
		await direct.addTorrentFile(oppenheimer);
		const hash = hashOf(oppenheimer);
		assert.equal(w.qb.torrents.get(hash)!.tags.size, 0);

		await w.run("title.find", { id: "movie:872585" });
		const search = await w.run("release.search", { title_id: "movie:872585" });
		const rel = (search.output as any).all.find((r: any) => r.title === OPP);
		const first = (await w.run("download.add", { handle: rel.handle, title_id: "movie:872585", reason: "2160p WEB-DL" })).output as any;
		assert.equal(first.adopted, true);
		assert.equal(first.hash, hash);
		assert.ok(w.qb.torrents.get(hash)!.tags.has("reelix"), "adoption tags it");
		const second = (await w.run("download.add", { handle: rel.handle, title_id: "movie:872585" })).output as any;
		assert.equal(second.adopted, true);
		assert.equal(w.qb.torrents.size, 1);
		assert.equal(w.qb.hits().filter((h) => h === "torrents/add").length, 1, "only the hand-made add reached qBittorrent");
		const rows = w.app.db.prepare("SELECT * FROM downloads").all() as any[];
		assert.equal(rows.length, 1);
		assert.equal(rows[0].reason, "2160p WEB-DL", "a later add without a reason keeps the first");
		assert.equal(rows[0].title_id, "movie:872585");
	} finally {
		await w.close();
	}
});

// ------------------------------------------------------------------ (e) v4 and v5 names

for (const version of ["v4.6.7", "v5.0.2"] as const) {
	test(`qBittorrent ${version}: start/stop endpoint and parameter names`, async () => {
		const w = await world({ version, magnets: { [FRIEREN_OK_HASH]: FRIEREN_OK_META } });
		const v5 = version.startsWith("v5");
		try {
			await w.run("title.find", { id: "tv:209867" });
			const search = await w.run("release.search", { title_id: "tv:209867", query: "Frieren" });
			const rel = (search.output as any).all.find((r: any) => r.title.startsWith("[GRP]"));
			assert.equal(rel.hasMagnet, true);
			const added = (await w.run("download.add", { handle: rel.handle, title_id: "tv:209867", episodes: [{ season: 1, episode: 1 }] })).output as any;
			assert.equal(added.hash, FRIEREN_OK_HASH);
			assert.equal(added.files, 1, "file list from the magnet's metadata");
			assert.equal(added.name, FRIEREN_OK_META.name);
			const add = w.qb.calls.find((c) => c.path === "torrents/add")!;
			assert.equal(add.form[v5 ? "stopped" : "paused"], "true");
			const qt = w.qb.torrents.get(FRIEREN_OK_HASH)!;
			assert.equal(qt.stopped, false, "started");

			await w.run("download.pause", { hash: FRIEREN_OK_HASH.slice(0, 10) });
			assert.equal(qt.stopped, true);
			const status = (await w.run("download.status", { hash: FRIEREN_OK_HASH })).output as any[];
			assert.equal(status[0].live.state, v5 ? "stoppedDL" : "pausedDL");
			await w.run("download.resume", { hash: FRIEREN_OK_HASH.slice(0, 10) });
			assert.equal(qt.stopped, false);

			const hits = w.qb.hits();
			const [start, stop, wrongStart, wrongStop] = v5 ? ["torrents/start", "torrents/stop", "torrents/resume", "torrents/pause"] : ["torrents/resume", "torrents/pause", "torrents/start", "torrents/stop"];
			assert.ok(hits.includes(start) && hits.includes(stop));
			assert.ok(!hits.includes(wrongStart) && !hits.includes(wrongStop), `no ${wrongStart}/${wrongStop} on ${version}`);
		} finally {
			await w.close();
		}
	});
}

// ------------------------------------------------------------------ (f) removed outside

test("a torrent removed outside Reelix is reported and marked gone", async () => {
	const w = await world();
	try {
		await w.run("title.find", { id: "movie:45745" });
		const so = (await w.run("release.search", { title_id: "movie:45745" })).output as any;
		const rel = so.all.find((r: any) => r.title === SINTEL_2160);
		const hash = ((await w.run("download.add", { handle: rel.handle, title_id: "movie:45745" })).output as any).hash;
		const ws = { rid: 0, known: new Map() };
		assert.deepEqual(await watchTick(w.app, ws), []);
		w.qb.removeOutside(hash);
		assert.deepEqual(await watchTick(w.app, ws), [{ kind: "removed_outside", hash, filed: false }]);
		const row = getDownload(w.app, hash)!;
		assert.equal(row.state, "gone");
		assert.match(row.note ?? "", /outside Reelix/);
		assert.deepEqual(await watchTick(w.app, ws), [], "reported once");
	} finally {
		await w.close();
	}
});

// ------------------------------------------------------------------ (g) idempotent requests

test("the same request ID for download.add runs once", async () => {
	const w = await world();
	try {
		await w.run("title.find", { id: "movie:45745" });
		const so = (await w.run("release.search", { title_id: "movie:45745" })).output as any;
		const rel = so.all.find((r: any) => r.title === SINTEL_1080);
		const a = await w.run("download.add", { handle: rel.handle, title_id: "movie:45745" }, "req-same");
		const b = await w.run("download.add", { handle: rel.handle, title_id: "movie:45745" }, "req-same");
		assert.equal(b.repeated, true);
		assert.deepEqual(b.output, a.output);
		assert.equal(w.qb.hits().filter((h) => h === "torrents/add").length, 1);
		assert.equal(w.jackett.downloads.length, 1, "the .torrent was fetched once");
		assert.equal((w.app.db.prepare("SELECT COUNT(*) AS n FROM actions WHERE request_id = 'req-same'").get() as any).n, 1);
	} finally {
		await w.close();
	}
});

// ------------------------------------------------------------------ fakes behave like the real services where it matters

test("fake qBittorrent refuses a wrong password; TMDB rejects a wrong key", async () => {
	const w = await world();
	try {
		const bad = new QbClient({ url: w.qb.url, username: "admin", password: "wrong" });
		await rejectsWith(bad.version(), "qb_auth");
		w.app.setSecret("tmdb.api_key", "not-the-key");
		await rejectsWith(w.run("title.find", { id: "movie:45745" }), "tmdb_auth");
		w.app.setSecret("jackett.api_key", "wrong-jackett-key");
		await rejectsWith(w.run("release.search", { query: "Sintel" }), "jackett_error");
	} finally {
		await w.close();
	}
});
