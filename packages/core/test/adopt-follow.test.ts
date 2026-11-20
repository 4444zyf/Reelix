import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runOperation } from "../src/registry.ts";
import { makeTorrent } from "./fakes/bencode.ts";
import { startFakeJackett } from "../../../plugins/jackett/test/fake-jackett.ts";
import { startFakeQb } from "../../../plugins/qbittorrent/test/fake-qbittorrent.ts";
import { startFakeTmdb } from "./fakes/tmdb.ts";
import { tempApp, withPlugins } from "./helpers.ts";

process.chdir(tmpdir()); // never run a binary from .tools/

const GB = 1_000_000_000;
const SINTEL = "Sintel.2010.1080p.BluRay.x264-GRP";
const E1 = "Severance.S01E01.1080p.WEB-DL.x265-GRP";
const E2 = "Severance.S01E02.720p.HDTV.x264-OTHER";

async function world() {
	const t = tempApp();
	const qb = await startFakeQb({ downloadsDir: t.downloads, password: "pw" });
	const tmdb = await startFakeTmdb();
	const jackett = await startFakeJackett({
		apiKey: "jk",
		indexers: [
			{
				id: "a",
				name: "A",
				results: [
					{ title: E1, size: 1.5 * GB, seeders: 30, torrent: makeTorrent(E1, [{ path: [`${E1}.mkv`], length: 1.5 * GB }]), category: [5040] },
					{ title: E2, size: 0.8 * GB, seeders: 10, torrent: makeTorrent(E2, [{ path: [`${E2}.mkv`], length: 0.8 * GB }]), category: [5040] },
				],
			},
		],
	});
	const { app } = t;
	app.setConfig("plugins.qbittorrent.url", qb.url);
	app.setSecret("plugins.qbittorrent.password", "pw");
	app.setConfig("plugins.jackett.servers", [{ url: jackett.url }]);
	app.setSecret("plugins.jackett.api_key", "jk");
	const stopPlugins = await withPlugins(app, ["jackett", "qbittorrent"]);
	app.setConfig("tmdb.base_url", tmdb.url);
	app.setSecret("tmdb.api_key", tmdb.apiKey);
	app.setConfig("path_maps.downloaders.qbittorrent", [{ theirs: qb.theirsRoot, ours: t.downloads }]);
	const run = (name: string, input: unknown) => runOperation(app, name, input, { actor: "owner:test" });
	return { ...t, qb, run, close: async () => (await stopPlugins(), app.close(), await Promise.all([qb.close(), tmdb.close(), jackett.close()])) };
}

test("adopt: an existing finished torrent is identified, planned, and filed only after approval", async () => {
	const w = await world();
	try {
	const bytes = makeTorrent(SINTEL, [{ path: [`${SINTEL}.mkv`], length: 1.2 * GB }]);
	const hash = w.qb.addOutside(bytes); // added by hand, untagged
	w.qb.complete(hash);

	const scan = (await w.run("adopt.scan", { notify: false })).output as any;
	assert.equal(scan.rows.length, 1);
	const row = scan.rows[0];
	assert.equal(row.title_id, "movie:45745");
	assert.ok(row.confident, JSON.stringify(row.problems));
	const dest = row.plan.items[0].dest as string;
	assert.ok(!existsSync(dest), "nothing linked before approval");

	const applied = (await w.run("adopt.apply", { all_confident: true })).output as any[];
	assert.equal(applied[0].status, "applied");
	assert.equal(statSync(dest).nlink, 2, "a hard link");
	assert.ok([...(w.qb.torrents.get(hash)!.tags as Iterable<string>)].includes("reelix-filed"));
	// a second scan no longer offers it
	assert.equal(((await w.run("adopt.scan", { notify: false })).output as any).rows.length, 0);
	} finally {
		await w.close();
	}
});

test("follow: due episodes are searched by code; quick-accept takes a match, others go to the agent", async () => {
	const w = await world();
	await w.run("title.find", { id: "tv:95396" });
	const f = (await w.run("follow.add", { title_id: "tv:95396", season: 1, instruction: "Weekly 1080p WEB-DL", quick_accept: "1080p, WEB-DL" })).output as any;
	const list = (await w.run("follow.list", {})).output as any[];
	assert.match(list[0].summary, /wanted 9/);

	const out = (await w.run("follow.check", {})).output as any[];
	const e1 = out.find((o) => o.episode === 1);
	const e2 = out.find((o) => o.episode === 2);
	const e3 = out.find((o) => o.episode === 3);
	assert.equal(e1.result, "grabbed", "E01 matches '1080p, WEB-DL'");
	assert.equal(e2.result, "needs_agent", "E02 exists only as 720p HDTV: the agent decides");
	assert.equal(e3.result, "nothing");
	const d = (await w.run("download.status", {})).output as any[];
	assert.equal(d.length, 1);
	assert.match(d[0].reason, /quick-accept/);

	// a miss widens the next check; nothing is searched again before then
	const again = (await w.run("follow.check", {})).output as any[];
	assert.ok(!again.some((o) => o.episode === 1 || o.episode === 3), "grabbed and missed episodes not due again");
	await w.run("follow.remove", { id: f.id });
	await w.close();
});
