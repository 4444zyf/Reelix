import type { PluginCheck } from "@reelix/plugin-testing";

/**
 * Answers recorded from qBittorrent 5.0 (Web API 2.11), for `reelix plugin check` and this plugin's tests.
 * Reelix fills in only the parts it uses; the shapes are qBittorrent's.
 */
export const QB = "http://qbittorrent.test:8080";
export const KNOWN = "a1".repeat(20);
export const BARE = "b2".repeat(20);
export const ADDED = "c3".repeat(20);
export const UNKNOWN = "d4".repeat(20);

const NOW = 1_763_500_000;
const info = (hash: string, o: Record<string, unknown>) => ({
	hash,
	name: "Sintel.2010.1080p.BluRay.x264-GRP",
	state: "stalledUP",
	progress: 1,
	size: 1_200_040_000,
	total_size: 1_230_040_000,
	amount_left: 0,
	save_path: "/downloads",
	content_path: "/downloads/Sintel.2010.1080p.BluRay.x264-GRP",
	tags: "reelix, reelix-filed",
	category: "",
	added_on: NOW - 7200,
	completion_on: NOW - 3600,
	dlspeed: 0,
	upspeed: 51_200,
	num_seeds: 0,
	num_leechs: 2,
	eta: 8_640_000,
	ratio: 0.42,
	seeding_time: 3600,
	...o,
});
const known = info(KNOWN, {});
const bare = info(BARE, { name: BARE, state: "metaDL", progress: 0, size: 0, total_size: -1, amount_left: 0, content_path: `/downloads/${BARE}`, tags: "reelix", completion_on: -1, upspeed: 0, eta: 8_640_000, ratio: 0, seeding_time: 0 });
const added = info(ADDED, { name: "Frieren - 01", state: "stoppedDL", progress: 0, size: 0, total_size: -1, content_path: "/downloads/Frieren - 01", tags: "reelix", completion_on: -1, upspeed: 0, ratio: 0, seeding_time: 0 });
const json = (v: unknown) => JSON.stringify(v);
const files = [
	{ index: 0, name: "Sintel.2010.1080p.BluRay.x264-GRP/Sintel.2010.1080p.BluRay.x264-GRP.mkv", size: 1_200_000_000, progress: 1, priority: 1 },
	{ index: 1, name: "Sintel.2010.1080p.BluRay.x264-GRP/Sintel.2010.1080p.BluRay.x264-GRP.chs.srt", size: 40_000, progress: 1, priority: 1 },
	{ index: 2, name: "Sintel.2010.1080p.BluRay.x264-GRP/Sample/sample.mkv", size: 30_000_000, progress: 0, priority: 0 },
];
const hashes = (...ids: string[]) => new RegExp(`/torrents/info\\?hashes=${ids.join("%7C")}(&|$)`);

export default {
	settings: { url: QB },
	secrets: { password: "adminadmin" },
	http: [
		{ url: `${QB}/api/v2/auth/login`, method: "POST", body: "Ok.", cookies: ["SID=Zm9vYmFy; HttpOnly; SameSite=Strict; path=/"] },
		{ url: `${QB}/api/v2/app/version`, body: "v5.0.2" },
		{ url: `${QB}/api/v2/app/webapiVersion`, body: "2.11.2" },
		{ url: `${QB}/api/v2/app/defaultSavePath`, body: "/downloads" },
		{ url: hashes(KNOWN, UNKNOWN), body: json([known]) },
		{ url: hashes(UNKNOWN), body: "[]" },
		{ url: hashes(KNOWN), body: json([known]) },
		{ url: hashes(BARE), body: json([bare]) },
		// Not there before `add`, there after it.
		{ url: hashes(ADDED), body: "[]", times: 1 },
		{ url: hashes(ADDED), body: json([added]) },
		{ url: `${QB}/api/v2/torrents/info?tag=reelix`, body: json([known, bare, added]) },
		{ url: `${QB}/api/v2/torrents/info`, body: json([known, bare, added, info("e5".repeat(20), { name: "Someone.Elses.2019.mkv", tags: "" })]) },
		{ url: `${QB}/api/v2/torrents/add`, method: "POST", body: "Ok." },
		{ url: `${QB}/api/v2/torrents/files?hash=${KNOWN}`, body: json(files) },
		{ url: /\/torrents\/trackers\?hash=/, body: json([{ url: "** [DHT] **", status: 2, msg: "" }, { url: "http://tracker.test/announce", status: 2, msg: "" }]) },
		{ url: `${QB}/api/v2/sync/maindata?rid=0`, body: json({ rid: 1, full_update: true, torrents: { [KNOWN]: known, [BARE]: bare }, server_state: { free_space_on_disk: 512_000_000_000 } }) },
		{ url: `${QB}/api/v2/sync/maindata?rid=1`, body: json({ rid: 2, torrents: { [KNOWN]: { upspeed: 0 } }, torrents_removed: [BARE] }) },
	],
	seams: {
		"reelix:downloader@1": {
			provider: "qbittorrent",
			known: { id: KNOWN, mark: "reelix", magnet: `magnet:?xt=urn:btih:${KNOWN}&dn=Sintel` },
			unknown: UNKNOWN,
			withoutMetadata: BARE,
			added: { id: ADDED, magnet: `magnet:?xt=urn:btih:${ADDED}&dn=Frieren`, mark: "reelix" },
		},
	},
} satisfies PluginCheck;
