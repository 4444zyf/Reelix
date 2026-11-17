import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { magnetHash, magnetName, parseTorrent } from "../../src/torrent.ts";
import { formOf, send, sendJson, startServer, type FakeRequest } from "./server.ts";

/**
 * A fake qBittorrent Web API covering exactly what QbClient uses. It keeps its own idea of paths:
 * it reports save paths under `/downloads` (theirs) and writes files into `downloadsDir` (ours).
 */

export type FakeQbVersion = "v4.6.7" | "v5.0.2";
export type FakeFile = { name: string; size: number; priority: number; progress: number };
export type FakeTorrent = {
	hash: string;
	name: string;
	files: FakeFile[]; // empty until a magnet's metadata arrives
	hasMetadata: boolean;
	stopped: boolean;
	progress: number;
	completed: boolean;
	tags: Set<string>;
	category: string;
	savePath: string; // theirs
	addedOn: number;
	completionOn: number;
	magnet?: string;
};
export type MagnetMeta = { name: string; files: { path: string; size: number }[] };
export type QbCall = { path: string; form: Record<string, string> };

export type FakeQb = {
	url: string;
	version: FakeQbVersion;
	username: string;
	password: string;
	theirsRoot: string;
	torrents: Map<string, FakeTorrent>;
	calls: QbCall[];
	preferences: Record<string, unknown>;
	/** Metadata a magnet gets once "peers" deliver it (by hash). */
	magnets: Map<string, MagnetMeta>;
	metadataDelayMs: number;
	/** Write the wanted files (priority > 0) under downloadsDir and mark the torrent finished. */
	complete(hash: string): void;
	/** Remove a torrent as if someone did it in qBittorrent's own UI. Data stays. */
	removeOutside(hash: string): void;
	/** Names of the endpoints hit, in order (without `api/v2/`). */
	hits(): string[];
	close(): Promise<void>;
};

const MiB = 1024 * 1024;

export async function startFakeQb(opts: {
	version?: FakeQbVersion;
	downloadsDir: string;
	username?: string;
	password?: string;
	theirsRoot?: string;
	magnets?: Record<string, MagnetMeta>;
	metadataDelayMs?: number;
}): Promise<FakeQb> {
	const version = opts.version ?? "v5.0.2";
	const v5 = version.startsWith("v5");
	const username = opts.username ?? "admin";
	const password = opts.password ?? "adminadmin";
	const theirsRoot = opts.theirsRoot ?? "/downloads";
	const sids = new Set<string>();
	const torrents = new Map<string, FakeTorrent>();
	const calls: QbCall[] = [];
	const metadataDelayMs = opts.metadataDelayMs ?? 300;
	const magnets = new Map(Object.entries(opts.magnets ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
	const preferences: Record<string, unknown> = { save_path: theirsRoot, temp_path_enabled: false, auto_tmm_enabled: false, max_ratio_enabled: false, add_stopped_enabled: false, start_paused_enabled: false };
	// sync/maindata: snapshots of what each rid's caller has seen
	let rid = 0;
	const snapshots = new Map<number, Map<string, Record<string, unknown>>>();

	const ours = (theirs: string) => (theirs === theirsRoot || theirs.startsWith(theirsRoot + "/") ? join(opts.downloadsDir, theirs.slice(theirsRoot.length)) : undefined);

	const stateOf = (t: FakeTorrent): string => {
		if (!t.hasMetadata) return t.stopped ? (v5 ? "stoppedDL" : "pausedDL") : "metaDL";
		if (t.completed) return t.stopped ? (v5 ? "stoppedUP" : "pausedUP") : "stalledUP";
		return t.stopped ? (v5 ? "stoppedDL" : "pausedDL") : "downloading";
	};

	const info = (t: FakeTorrent): Record<string, unknown> => {
		const wanted = t.files.filter((f) => f.priority > 0);
		const size = wanted.reduce((a, f) => a + f.size, 0);
		const total = t.files.reduce((a, f) => a + f.size, 0);
		return {
			hash: t.hash,
			name: t.name,
			state: stateOf(t),
			progress: t.progress,
			size,
			total_size: total,
			amount_left: t.completed ? 0 : Math.round(size * (1 - t.progress)),
			save_path: t.savePath,
			content_path: `${t.savePath}/${t.name}`,
			tags: [...t.tags].join(", "),
			category: t.category,
			added_on: t.addedOn,
			completion_on: t.completionOn,
			dlspeed: t.completed || t.stopped ? 0 : 1_000_000,
			upspeed: 0,
			num_seeds: 5,
			num_leechs: 1,
			eta: t.completed ? 8640000 : 600,
			ratio: 0,
		};
	};

	const hashesOf = (s: string | undefined): string[] => {
		if (!s) return [];
		if (s === "all") return [...torrents.keys()];
		return s.split("|").map((h) => h.toLowerCase());
	};

	const register = (t: FakeTorrent) => {
		torrents.set(t.hash, t);
		if (!t.hasMetadata) {
			setTimeout(() => {
				const cur = torrents.get(t.hash);
				const meta = magnets.get(t.hash);
				if (!cur || !meta) return; // no peer ever delivers it
				cur.name = meta.name;
				cur.files = meta.files.map((f) => ({ name: f.path, size: f.size, priority: 1, progress: 0 }));
				cur.hasMetadata = true;
			}, metadataDelayMs).unref();
		}
	};
	const formRecord = (fd: FormData): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const [k, v] of fd.entries()) if (typeof v === "string") out[k] = v; // a repeated field: the last one wins
		return out;
	};

	const POST_ONLY = new Set(["auth/login", "app/setPreferences", "torrents/add", "torrents/delete", "torrents/addTags", "torrents/filePrio", "torrents/start", "torrents/stop", "torrents/resume", "torrents/pause", "torrents/recheck", "torrents/createCategory"]);

	const handle = async (req: FakeRequest, res: import("node:http").ServerResponse) => {
		const path = req.url.pathname.replace(/^\/api\/v2\//, "");
		if (!req.url.pathname.startsWith("/api/v2/")) return send(res, 404, "Not Found");
		if (POST_ONLY.has(path) && req.method !== "POST") return send(res, 405, "Method Not Allowed");
		const fd = req.method === "POST" ? await formOf(req) : new FormData();
		const form = formRecord(fd);
		const q = Object.fromEntries(req.url.searchParams);
		calls.push({ path, form: { ...q, ...form } });

		if (path === "auth/login") {
			if (form.username !== username || form.password !== password) return send(res, 200, "Fails.");
			const sid = randomBytes(16).toString("base64url");
			sids.add(sid);
			return send(res, 200, "Ok.", { "set-cookie": `SID=${sid}; HttpOnly; SameSite=Strict; path=/` });
		}
		const cookie = /(?:^|;\s*)SID=([^;]+)/.exec(String(req.headers.cookie ?? ""))?.[1];
		if (!cookie || !sids.has(cookie)) return send(res, 403, "Forbidden");

		switch (path) {
			case "app/version":
				return send(res, 200, version);
			case "app/webapiVersion":
				return send(res, 200, v5 ? "2.11.2" : "2.9.3");
			case "app/preferences":
				return sendJson(res, 200, preferences);
			case "app/setPreferences":
				Object.assign(preferences, JSON.parse(form.json ?? "{}"));
				return send(res, 200, "");
			case "app/defaultSavePath":
				return send(res, 200, String(preferences.save_path));
			case "torrents/info": {
				let list = [...torrents.values()];
				if (q.hashes) {
					const hs = new Set(hashesOf(q.hashes));
					list = list.filter((t) => hs.has(t.hash));
				}
				if (q.tag !== undefined) list = list.filter((t) => (q.tag === "" ? t.tags.size === 0 : t.tags.has(q.tag)));
				if (q.category !== undefined) list = list.filter((t) => t.category === q.category);
				return sendJson(res, 200, list.map(info));
			}
			case "torrents/files": {
				const t = torrents.get(String(q.hash).toLowerCase());
				if (!t) return send(res, 404, "Torrent hash was not found");
				return sendJson(
					res,
					200,
					t.files.map((f, index) => ({ index, name: f.name, size: f.size, progress: f.progress, priority: f.priority, is_seed: t.completed, piece_range: [0, 0], availability: 1 })),
				);
			}
			case "torrents/add": {
				const stopped = (v5 ? form.stopped : form.paused) === "true";
				const tags = (form.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean);
				const savePath = (form.savepath || String(preferences.save_path)).replace(/\/+$/, "");
				let added = 0;
				for (const file of fd.getAll("torrents")) {
					if (typeof file === "string") continue;
					const parsed = parseTorrent(new Uint8Array(await file.arrayBuffer()));
					if (torrents.has(parsed.infoHash)) continue;
					register({
						hash: parsed.infoHash,
						name: parsed.name,
						files: parsed.files.map((f) => ({ name: f.path, size: f.size, priority: 1, progress: 0 })),
						hasMetadata: true,
						stopped,
						progress: 0,
						completed: false,
						tags: new Set(tags),
						category: form.category ?? "",
						savePath,
						addedOn: Math.floor(Date.now() / 1000),
						completionOn: -1,
					});
					added++;
				}
				for (const url of (form.urls ?? "").split("\n").map((s) => s.trim()).filter(Boolean)) {
					const hash = magnetHash(url);
					if (!hash || torrents.has(hash)) continue;
					register({
						hash,
						name: magnetName(url) ?? hash,
						files: [],
						hasMetadata: false,
						stopped,
						progress: 0,
						completed: false,
						tags: new Set(tags),
						category: form.category ?? "",
						savePath,
						addedOn: Math.floor(Date.now() / 1000),
						completionOn: -1,
						magnet: url,
					});
					added++;
				}
				return send(res, 200, added ? "Ok." : "Fails.");
			}
			case "torrents/start":
			case "torrents/resume":
			case "torrents/stop":
			case "torrents/pause": {
				const wantStart = path === "torrents/start" || path === "torrents/resume";
				const v5Name = path === "torrents/start" || path === "torrents/stop";
				if (v5Name !== v5) return send(res, 404, "Not Found");
				for (const h of hashesOf(form.hashes)) {
					const t = torrents.get(h);
					if (t) t.stopped = !wantStart;
				}
				return send(res, 200, "");
			}
			case "torrents/delete": {
				for (const h of hashesOf(form.hashes)) {
					const t = torrents.get(h);
					if (!t) continue;
					torrents.delete(h);
					if (form.deleteFiles === "true") {
						const dir = ours(t.savePath);
						if (dir && t.name) rmSync(join(dir, t.name), { recursive: true, force: true });
					}
				}
				return send(res, 200, "");
			}
			case "torrents/addTags": {
				const tags = (form.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean);
				for (const h of hashesOf(form.hashes)) for (const tag of tags) torrents.get(h)?.tags.add(tag);
				return send(res, 200, "");
			}
			case "torrents/filePrio": {
				const t = torrents.get(String(form.hash).toLowerCase());
				if (!t) return send(res, 404, "Torrent hash was not found");
				if (!t.hasMetadata) return send(res, 409, "Torrent's metadata has not yet downloaded");
				const prio = Number(form.priority);
				if (![0, 1, 6, 7].includes(prio)) return send(res, 400, "Priority is invalid");
				const ids = String(form.id).split("|").map(Number);
				if (ids.some((i) => !Number.isInteger(i) || i < 0 || i >= t.files.length)) return send(res, 409, "File IDs are invalid");
				for (const i of ids) t.files[i]!.priority = prio;
				return send(res, 200, "");
			}
			case "torrents/recheck":
				return send(res, 200, "");
			case "torrents/categories":
				return sendJson(res, 200, {});
			case "torrents/createCategory":
				return send(res, 200, "");
			case "sync/maindata": {
				const asked = Number(q.rid ?? 0);
				const prev = asked ? snapshots.get(asked) : undefined;
				const now = new Map([...torrents.values()].map((t) => [t.hash, info(t)]));
				rid++;
				snapshots.set(rid, now);
				const base = { rid, server_state: { free_space_on_disk: 500 * 1024 * MiB, connection_status: "connected" } };
				if (!prev) return sendJson(res, 200, { ...base, full_update: true, torrents: Object.fromEntries(now), tags: [], categories: {} });
				const patch: Record<string, Record<string, unknown>> = {};
				for (const [h, cur] of now) {
					const old = prev.get(h);
					if (!old) {
						patch[h] = cur;
						continue;
					}
					const diff: Record<string, unknown> = {};
					for (const [k, v] of Object.entries(cur)) if (old[k] !== v) diff[k] = v;
					if (Object.keys(diff).length) patch[h] = diff;
				}
				const removed = [...prev.keys()].filter((h) => !now.has(h));
				return sendJson(res, 200, { ...base, torrents: patch, ...(removed.length ? { torrents_removed: removed } : {}) });
			}
			default:
				return send(res, 404, "Not Found");
		}
	};

	const server = await startServer(handle);

	return {
		url: server.url,
		version,
		username,
		password,
		theirsRoot,
		torrents,
		calls,
		preferences,
		magnets,
		metadataDelayMs,
		complete(hash: string) {
			const t = torrents.get(hash.toLowerCase());
			if (!t) throw new Error(`fake qBittorrent has no torrent ${hash}`);
			if (!t.hasMetadata) throw new Error(`torrent ${hash} has no metadata yet`);
			const dir = ours(t.savePath);
			if (!dir) throw new Error(`save path ${t.savePath} is outside ${theirsRoot}`);
			for (const f of t.files) {
				if (f.priority === 0) continue;
				const p = join(dir, f.name);
				mkdirSync(dirname(p), { recursive: true });
				// Small dummy bytes, but proportional so "sample" heuristics still see relative sizes.
				writeFileSync(p, Buffer.alloc(Math.max(16, Math.ceil(f.size / MiB)), 7));
				f.progress = 1;
			}
			t.progress = 1;
			t.completed = true;
			t.completionOn = Math.floor(Date.now() / 1000);
		},
		removeOutside(hash: string) {
			torrents.delete(hash.toLowerCase());
		},
		hits: () => calls.map((c) => c.path),
		close: server.close,
	};
}
