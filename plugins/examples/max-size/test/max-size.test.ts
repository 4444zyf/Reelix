import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { getDownload } from "@reelix/core";
import { makeTorrent } from "../../../../packages/core/test/fakes/bencode.ts";
import { GB, offered, releaseWorld } from "../../../../packages/core/test/fakes/release-world.ts";

process.chdir(tmpdir()); // never run a binary from .tools/

const BIG = "Sintel.2010.2160p.REMUX-GRP";
const SMALL = "Sintel.2010.1080p.WEB-DL-GRP";
const MAGNET_HASH = createHash("sha1").update("a big magnet").digest("hex");
const MAGNET = `magnet:?xt=urn:btih:${MAGNET_HASH}&dn=Sintel.2010.2160p.WEB-DL-MAG`;

const world = () =>
	releaseWorld({
		examples: ["max-size"],
		settings: { "max-size": { max_gb: 2 } },
		results: [
			offered(BIG, 40, { size: 5 * GB, torrent: makeTorrent(BIG, [{ path: [`${BIG}.mkv`], length: 5 * GB }]) }),
			offered(SMALL, 30),
			offered("Sintel.2010.2160p.WEB-DL-MAG", 20, { torrent: undefined, magnet: MAGNET, magnetInResult: true, infoHash: MAGNET_HASH, size: 3 * GB }),
		],
		magnets: { [MAGNET_HASH]: { name: "Sintel.2010.2160p.WEB-DL-MAG", files: [{ path: "Sintel.2160p.mkv", size: 3 * GB }] } },
	});
const handleOf = async (w: Awaited<ReturnType<typeof world>>, title: string) => ((await w.run("release.search", { query: "Sintel" })).output as any).all.find((r: any) => r.title === title).handle as string;

test("a .torrent over the limit is refused before anything reaches the downloader", async () => {
	const w = await world();
	try {
		const handle = await handleOf(w, BIG);
		await assert.rejects(w.run("download.add", { handle }), (e: any) => e.code === "download_refused" && /max-size: 5\.0 GB to download, more than the limit of 2 GB/.test(e.message) && !/removed/.test(e.message));
		assert.deepEqual(w.qb.hits().filter((h) => h.startsWith("torrents/")), [], "nothing was asked of the downloader");
	} finally {
		await w.close();
	}
});

test("a magnet is refused once its files are known, and removed again", async () => {
	const w = await world();
	try {
		const handle = await handleOf(w, "Sintel.2010.2160p.WEB-DL-MAG");
		await assert.rejects(w.run("download.add", { handle }), (e: any) => e.code === "download_refused" && /max-size: 3\.0 GB to download, more than the limit of 2 GB/.test(e.message) && /removed from the downloader again/.test(e.message));
		assert.ok(w.qb.hits().includes("torrents/add"), "it had to be added to learn its files");
		const del = w.qb.calls.find((c) => c.path === "torrents/delete")!;
		assert.deepEqual([del.form.hashes, del.form.deleteFiles], [MAGNET_HASH, "true"]);
		assert.ok(!w.qb.torrents.has(MAGNET_HASH));
		assert.equal(getDownload(w.app, MAGNET_HASH), undefined, "not recorded");
		const ledger = w.app.db.prepare("SELECT status, error FROM actions WHERE op = 'download.add'").get() as { status: string; error: string };
		assert.equal(ledger.status, "failed");
	} finally {
		await w.close();
	}
});

test("under the limit nothing changes", async () => {
	const w = await world();
	try {
		assert.match((await w.run("download.add", { handle: await handleOf(w, SMALL) })).text, /Added and started/);
	} finally {
		await w.close();
	}
});
