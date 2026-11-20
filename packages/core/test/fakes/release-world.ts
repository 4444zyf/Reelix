import { join } from "node:path";
import { startPlugins } from "@reelix/plugin-testing";
import { startFakeJackett, type FakeRelease } from "../../../../plugins/jackett/test/fake-jackett.ts";
import { runOperation } from "../../src/registry.ts";
import { tempApp } from "../helpers.ts";
import { makeTorrent } from "./bencode.ts";
import { type MagnetMeta, startFakeQb } from "../../../../plugins/qbittorrent/test/fake-qbittorrent.ts";
import { startFakeTmdb } from "./tmdb.ts";

export const GB = 1_000_000_000;
const PLUGINS = join(import.meta.dirname, "../../../../plugins");

/** A release a fake indexer offers, with a real .torrent behind it. */
export const offered = (title: string, seeders: number, more: Partial<FakeRelease> = {}): FakeRelease => ({ title, size: GB, seeders, peers: 1, category: [2040, 5040], torrent: makeTorrent(title, [{ path: [`${title}.mkv`], length: GB }]), ...more });

/** Reelix with fake services, Jackett and qBittorrent through the real loading path, and the reference plugins named. */
export async function releaseWorld(o: { examples?: string[]; folders?: string[]; settings?: Record<string, unknown>; results: FakeRelease[]; magnets?: Record<string, MagnetMeta> }) {
	const w = tempApp();
	const qb = await startFakeQb({ downloadsDir: w.downloads, password: "pw", magnets: o.magnets });
	const tmdb = await startFakeTmdb();
	const jackett = await startFakeJackett({ apiKey: "jk", indexers: [{ id: "alpha", name: "Alpha", results: o.results }, { id: "flaky", name: "Flaky", results: [], fail: "Cloudflare challenge" }] });
	const { app } = w;
	app.setConfig("plugins.qbittorrent", { url: qb.url });
	app.setSecret("plugins.qbittorrent.password", "pw");
	app.setConfig("plugins.jackett.servers", [{ url: jackett.url }]);
	app.setSecret("plugins.jackett.api_key", "jk");
	app.setConfig("tmdb.base_url", tmdb.url);
	app.setSecret("tmdb.api_key", tmdb.apiKey);
	app.setConfig("path_maps.downloaders.qbittorrent", [{ theirs: qb.theirsRoot, ours: w.downloads }]);
	const t = await startPlugins([join(PLUGINS, "jackett"), join(PLUGINS, "qbittorrent"), ...(o.examples ?? []).map((id) => join(PLUGINS, "examples", id)), ...(o.folders ?? [])], { app, settings: o.settings });
	return {
		...w,
		t,
		qb,
		/** Run an operation as this actor. */
		run: (name: string, input: unknown, actor = "agent:test") => runOperation(app, name, input, { actor }),
		async close() {
			await t.close();
			app.close();
			await Promise.all([qb.close(), tmdb.close(), jackett.close()]);
		},
	};
}
