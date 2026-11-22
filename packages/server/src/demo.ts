/**
 * A Reelix with no real services, for trying the web UI (scripts/demo.ts) and for `reelix plugin dev`
 * (docs/plugins.md §14.2): fake qBittorrent / Jackett / TMDB / Jellyfin / Bangumi (Sintel, Oppenheimer, Severance,
 * Frieren) and downloads that "finish" about 30 s after they start. Media go beside the data folder.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Reelix } from "@reelix/core";
import { makeTorrent } from "../../core/test/fakes/bencode.ts";
import { startFakeBangumi } from "../../../plugins/bangumi/test/fake-bangumi.ts";
import { startFakeJellyfin } from "../../../plugins/jellyfin/test/fake-jellyfin.ts";
import { startFakeQb } from "../../../plugins/qbittorrent/test/fake-qbittorrent.ts";
import { startFakeTmdb } from "../../core/test/fakes/tmdb.ts";
import { startFakeJackett } from "../../../plugins/jackett/test/fake-jackett.ts";
import { hashPassword } from "./auth.ts";

const GB = 1_000_000_000;
const rel = (title: string, files: [string, number][], seeders: number, category: number[]) => ({
	title,
	size: files.reduce((a, f) => a + f[1], 0),
	seeders,
	peers: Math.round(seeders / 5),
	category,
	torrent: makeTorrent(title, files.map(([p, n]) => ({ path: p.split("/"), length: n }))),
});
const S1 = "Sintel.2010.1080p.BluRay.x264-GRP";
const S4 = "Sintel.2010.2160p.WEB-DL.x265-OTHER";
const SC = "Sintel.2010.1080p.CAM.x264-NOPE";
/** HDR, from the group XYZ: for the reference plugins release-tags, tag-hdr and hdr-alert, and a plugin the agent writes to hide a group. */
const SDV = "Sintel.2010.2160p.UHD.BluRay.DV.HDR10.HEVC-XYZ";
const O1 = "Oppenheimer.2023.1080p.WEB-DL.DDP5.1.H.264-GRP";
const O4 = "Oppenheimer.2023.2160p.BluRay.REMUX.HEVC.TrueHD.7.1-FGT";
const SEV = "Severance.S01.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb";
const FR = "[SubsPlease] Sousou no Frieren (01-28) (1080p) [Batch]";
/** A magnet-only release: its files are known once the fake qBittorrent has "fetched" them. */
const FR1 = "[Erai-raws] Sousou no Frieren - 01 [1080p]";
const FR1_HASH = "5f0f1a1e7c3b2d4a6e8f9a0b1c2d3e4f5a6b7c8d";
const FR1_MAGNET = `magnet:?xt=urn:btih:${FR1_HASH}&dn=${encodeURIComponent(FR1)}`;

/**
 * Start the fake services and point the data folder `root` at them. `password`: the web sign-in, set on a
 * new data folder or one without a password; `model`: the agent's chat model ("provider/id").
 * Returns a line saying where everything is.
 */
export async function startDemo(root: string, o: { password?: string; model?: string } = {}): Promise<string> {
	const media = join(root, "..", "reelix-demo-media");
	const downloads = join(media, "torrents");
	const library = join(media, "library");
	for (const d of [downloads, join(library, "Movies"), join(library, "Shows"), join(library, "Anime")]) mkdirSync(d, { recursive: true });

	const qb = await startFakeQb({ downloadsDir: downloads, password: "demo-qb", magnets: { [FR1_HASH]: { name: `${FR1}.mkv`, files: [{ path: `${FR1}.mkv`, size: 1.4 * GB }] } } });
	const tmdb = await startFakeTmdb();
	// What was watched: the owner's history shapes "For you" on Trends; the guest's does not (docs/trends.md §2.1).
	const jellyfin = await startFakeJellyfin({
		apiKey: "demo-jellyfin-key",
		users: [{ name: "owner", admin: true }, { name: "guest" }],
		library: [
			{ type: "Movie", name: "Sintel", year: 2010, tmdb: 45745 },
			{ type: "Series", name: "Severance", year: 2022, tmdb: 95396, episodes: Array.from({ length: 9 }, (_, i) => [1, i + 1] as [number, number]) },
		],
		next: [{ user: "owner", tmdb: 95396, season: 2, episode: 1 }],
		// Jellyfin sees the library under /data/media; Reelix's path map says so.
		folders: [{ name: "Films", paths: ["/data/media/library/Movies"] }, { name: "Shows", paths: ["/data/media/library/Shows", "/data/media/library/Anime"] }],
		watch: [
			{ user: "owner", type: "Series", name: "Severance", year: 2022, tmdb: 95396, episodes: 9, favourite: true, last: "2026-11-15T21:00:00Z" },
			{ user: "owner", type: "Movie", name: "Oppenheimer", year: 2023, tmdb: 872585, plays: 2, last: "2026-11-08T20:00:00Z" },
			{ user: "guest", type: "Movie", name: "Sintel", year: 2010, tmdb: 45745, plays: 1, last: "2026-11-16T18:00:00Z" },
		],
	});
	// Bangumi's entries and calendar: anime mapping, and what is airing on Trends.
	const bangumi = await startFakeBangumi();
	const jackett = await startFakeJackett({
		apiKey: "demo-jackett-key",
		indexers: [
			{
				id: "alpha",
				name: "Alpha",
				results: [
					rel(S1, [[`${S1}.mkv`, 1.2 * GB], [`${S1}.chs.srt`, 40_000], ["Sample/sample.mkv", 30_000_000]], 40, [2040]),
					{ ...rel(S4, [[`${S4}.mkv`, 4 * GB]], 12, [2045]), freeleech: true },
					rel(SC, [[`${SC}.mkv`, 0.7 * GB]], 300, [2040]),
					rel(SDV, [[`${SDV}.mkv`, 18 * GB]], 25, [2045]),
					rel(O1, [[`${O1}.mkv`, 9 * GB]], 85, [2040]),
					rel(O4, [[`${O4}.mkv`, 70 * GB]], 20, [2045]),
				],
			},
			{
				id: "beta",
				name: "Beta",
				results: [
					rel(SEV, Array.from({ length: 9 }, (_, i) => [`${SEV}/Severance.S01E0${i + 1}.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb.mkv`, 1.6 * GB] as [string, number]), 55, [5040]),
					rel(FR, Array.from({ length: 28 }, (_, i) => [`${FR}/[SubsPlease] Sousou no Frieren - ${String(i + 1).padStart(2, "0")} (1080p).mkv`, 1.4 * GB] as [string, number]), 120, [5070]),
					rel(S1, [[`${S1}.mkv`, 1.2 * GB]], 7, [2040]),
					{ title: FR1, size: 1.4 * GB, seeders: 60, peers: 5, category: [5070], magnet: FR1_MAGNET, magnetInResult: true, infoHash: FR1_HASH },
				],
			},
			{ id: "flaky", name: "Flaky", results: [], fail: "Cloudflare challenge could not be solved (demo)" },
		],
	});

	// Configure the data folder; a fresh one keeps the owner's password once set.
	const firstRun = !existsSync(join(root, "config.yaml"));
	const app = new Reelix(root);
	app.setConfig("downloads", downloads);
	app.setConfig("library", { movies: [{ path: join(library, "Movies") }], shows: [{ path: join(library, "Shows") }], anime: [{ path: join(library, "Anime") }] });
	app.setConfig("plugins.qbittorrent", { ...(app.config.plugins.qbittorrent as object | undefined), url: qb.url });
	app.setConfig("plugins.jackett.servers", [{ url: jackett.url }]);
	app.setConfig("tmdb.base_url", tmdb.url);
	app.setConfig("path_maps.downloaders.qbittorrent", [{ theirs: qb.theirsRoot, ours: downloads }]);
	app.setSecret("plugins.qbittorrent.password", "demo-qb");
	app.setSecret("plugins.jackett.servers.0.api_key", "demo-jackett-key");
	app.setSecret("tmdb.api_key", tmdb.apiKey);
	app.setConfig("plugins.jellyfin", { ...(app.config.plugins.jellyfin as object | undefined), url: jellyfin.url });
	app.setConfig("path_maps.media_servers.jellyfin", [{ theirs: "/data/media", ours: media }]);
	app.setSecret("plugins.jellyfin.api_key", jellyfin.apiKey);
	app.setConfig("plugins.bangumi", { base_url: bangumi.url });
	if (o.model) app.setConfig("models.roles.chat", [o.model]);
	if (o.password && (firstRun || !app.secrets["web.password_hash"])) app.setSecret("web.password_hash", hashPassword(o.password));
	mkdirSync(app.paths.notes, { recursive: true });
	if (!existsSync(join(app.paths.notes, "preferences.md"))) writeFileSync(join(app.paths.notes, "preferences.md"), "- Films: 1080p; 4K only if I ask. Never CAM/TS.\n- Subtitles: 简体&English bilingual, then 简体; ASS over SRT.\n");
	app.close();

	// Downloads progress and "finish" about 30 s after they start.
	setInterval(() => {
		for (const [hash, t] of qb.torrents) {
			if (t.stopped || t.completed || !t.hasMetadata) continue;
			t.progress = Math.min(1, t.progress + 0.1);
			if (t.progress >= 1) qb.complete(hash);
		}
	}, 3000).unref();

	return `Demo services: qBittorrent ${qb.url}, Jackett ${jackett.url}, TMDB ${tmdb.url}, Jellyfin ${jellyfin.url}, Bangumi ${bangumi.url}; media in ${media}`;
}
