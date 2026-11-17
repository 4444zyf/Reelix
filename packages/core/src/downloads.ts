import { existsSync, statfsSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Reelix } from "./app.ts";
import { type QbTorrent, isComplete, isStoppedState } from "./clients/qbittorrent.ts";
import { toOurs, toTheirs } from "./config.ts";
import { json, kvGet, kvSet } from "./db.ts";
import { type ApplyItemResult, type Plan, applyPlan, autoPlan, listFilesRecursive } from "./organiser.ts";
import { probe, runtimeFits } from "./probe.ts";
import { type HandlePayload, fetchRelease, getHandle } from "./releases.ts";
import { getTitle, requireTitle } from "./titles.ts";
import { resolveAbsolute } from "./anime.ts";
import { looksRarPacked, magnetHash, VIDEO_EXT } from "./torrent.ts";
import { ReelixError, humanBytes, nowIso, sleep } from "./util.ts";

export const TAG = "reelix";
export const TAG_FILED = "reelix-filed";

export type DownloadRow = {
	hash: string;
	title_id: string | null;
	name: string;
	episodes_json: string;
	release_json: string;
	reason: string | null;
	state: string;
	content_path: string | null;
	save_path: string | null;
	progress: number;
	size: number | null;
	last_progress_at: string | null;
	added_at: string;
	completed_at: string | null;
	filed_at: string | null;
	note: string | null;
};

export function getDownload(app: Reelix, hash: string): DownloadRow | undefined {
	return app.db.prepare("SELECT * FROM downloads WHERE hash = ?").get(hash.toLowerCase()) as DownloadRow | undefined;
}

export function setDownloadState(app: Reelix, hash: string, state: string, note?: string): void {
	app.db.prepare("UPDATE downloads SET state = ?, note = COALESCE(?, note) WHERE hash = ?").run(state, note ?? null, hash);
	app.emit({ type: "download", hash, state });
}

/** Free space at the download folder, from the filesystem itself. */
export function freeSpace(app: Reelix): number | undefined {
	const p = app.config.downloads;
	if (!p || !existsSync(p)) return undefined;
	const s = statfsSync(p);
	return s.bavail * s.bsize;
}

export type AddInput = {
	handle?: string;
	magnet?: string;
	title_id?: string;
	episodes?: { season: number; episode: number }[];
	reason?: string;
	skip_files?: number[];
	only_files?: number[];
	allow_rar?: boolean;
};

export type AddOutput = { hash: string; name: string; adopted: boolean; started: boolean; files: number; size?: number; skipped_files: number; warnings: string[] };

/**
 * Add a chosen release to qBittorrent (§5.3). Fetches the .torrent itself so the hash and file
 * list are known first; magnets are added stopped, inspected once metadata arrives, then started.
 */
export async function addDownload(app: Reelix, input: AddInput, requestId: string, signal?: AbortSignal): Promise<AddOutput> {
	const qb = app.qb();
	const warnings: string[] = [];
	let payload: HandlePayload | undefined;
	if (input.handle) payload = getHandle(app, input.handle);
	else if (input.magnet) payload = { magnet: input.magnet, title: input.magnet, parsed: { confident: false } };
	else throw new ReelixError("invalid_input", "Give a release handle (from release_search) or a magnet link.");
	const titleId = input.title_id ?? payload.titleId;
	const title = titleId ? requireTitle(app, titleId) : undefined;

	const fetched = await fetchRelease(app, payload);
	if (!fetched.hash) throw new ReelixError("no_hash", "Could not work out the torrent's ID from the release.");
	const hash = fetched.hash.toLowerCase();
	kvSet(app.db, `req:${requestId}`, hash); // lets reconcile find it after a crash

	if (fetched.files && looksRarPacked(fetched.files) && !input.allow_rar) {
		throw new ReelixError("rar_packed", "This release is RAR-packed: it cannot be hard-linked and unpacking doubles the space. Choose another release, or pass allow_rar if the owner agreed.");
	}
	const size = payload.size ?? fetched.files?.reduce((a, f) => a + f.size, 0);
	const free = freeSpace(app) ?? (await qb.freeSpace().catch(() => undefined));
	if (size && free !== undefined && size > free * 0.98) throw new ReelixError("no_space", `Not enough free space: the release is ${humanBytes(size)} and ${humanBytes(free)} is free.`);
	if (size && free !== undefined && size > free * 0.8) warnings.push(`After this download only ${humanBytes(free - size)} will be free.`);

	const record = (name: string, adopted: boolean) => {
		app.db
			.prepare(
				`INSERT INTO downloads (hash, title_id, name, episodes_json, release_json, reason, state, size, added_at, last_progress_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'downloading', ?, ?, ?)
				 ON CONFLICT(hash) DO UPDATE SET title_id = COALESCE(excluded.title_id, downloads.title_id), episodes_json = excluded.episodes_json,
				   reason = COALESCE(excluded.reason, downloads.reason), state = CASE WHEN downloads.state IN ('gone','removed') THEN 'downloading' ELSE downloads.state END`,
			)
			.run(hash, title?.id ?? null, name, JSON.stringify(input.episodes ?? []), JSON.stringify({ ...payload, link: undefined, magnet: undefined, key: undefined, adopted }) /* the handle key may be the Jackett link, which carries the API key */, input.reason ?? null, size ?? null, nowIso(), nowIso());
		app.emit({ type: "download", hash, state: "downloading" });
	};

	// Already in qBittorrent? Adopt it instead of adding a duplicate.
	const existing = await qb.torrent(hash);
	if (existing) {
		await qb.addTags([hash], [TAG]);
		record(existing.name, true);
		return { hash, name: existing.name, adopted: true, started: !isStoppedState(existing.state), files: fetched.files?.length ?? 0, size: existing.size, skipped_files: 0, warnings: [...warnings, "qBittorrent already had this torrent; adopted it."] };
	}

	const needSelection = !!(input.skip_files?.length || input.only_files?.length);
	let files = fetched.files;
	if (fetched.torrent) {
		await qb.addTorrentFile(fetched.torrent, { stopped: true, tags: [TAG], filename: `${hash}.torrent` });
	} else {
		await qb.addMagnet(fetched.magnet!, { stopped: true, tags: [TAG] });
	}
	// Wait for qBittorrent to register it (and, for a magnet, fetch the file list).
	let t: QbTorrent | undefined;
	const deadline = Date.now() + (fetched.torrent ? 20_000 : 120_000);
	while (Date.now() < deadline) {
		t = await qb.torrent(hash);
		if (t && fetched.torrent) break;
		if (t) {
			const fl = await qb.files(hash).catch(() => []);
			if (fl.length) {
				files = fl.map((f) => ({ path: f.name, size: f.size }));
				break;
			}
			// A stopped magnet never fetches metadata on some versions; let it run to fetch metadata.
			if (Date.now() > deadline - 110_000 && isStoppedState(t.state)) await qb.start([hash]).catch(() => {});
		}
		await sleep(1500, signal);
	}
	if (!t) throw new ReelixError("outcome_unknown", "qBittorrent accepted the request but the torrent did not appear in time.");
	if (!files?.length) {
		await qb.delete([hash], true);
		throw new ReelixError("no_metadata", "No peer delivered the magnet's file list within two minutes, so it was removed. The release is probably dead; choose another.");
	}
	if (!fetched.torrent) await qb.stop([hash]).catch(() => {});
	if (looksRarPacked(files) && !input.allow_rar) {
		await qb.delete([hash], true);
		throw new ReelixError("rar_packed", "The magnet's file list shows a RAR-packed release, so it was removed. Choose another release, or pass allow_rar if the owner agreed.");
	}
	let skipped: number[] = [];
	if (needSelection) {
		const all = files.map((_, i) => i);
		skipped = input.only_files?.length ? all.filter((i) => !input.only_files!.includes(i)) : input.skip_files!;
		await qb.setFilePriority(hash, skipped, 0);
	}
	await qb.start([hash]);
	record(t.name, false);
	return { hash, name: t.name, adopted: false, started: true, files: files.length, size, skipped_files: skipped.length, warnings };
}

export async function reconcileAdd(app: Reelix, requestId: string): Promise<{ status: "succeeded" | "failed"; output?: unknown } | undefined> {
	const hash = kvGet(app.db, `req:${requestId}`);
	if (!hash) return undefined;
	const t = await app.qb().torrent(hash);
	return t ? { status: "succeeded", output: { hash, name: t.name, reconciled: true } } : { status: "failed" };
}

// ------------------------------------------------------------------ status

export type DownloadView = DownloadRow & { live?: Partial<QbTorrent>; title_name?: string };

export async function listDownloads(app: Reelix, opts: { all?: boolean; hash?: string } = {}): Promise<DownloadView[]> {
	const rows = (opts.hash
		? app.db.prepare("SELECT * FROM downloads WHERE hash = ?").all(opts.hash.toLowerCase())
		: app.db.prepare(`SELECT * FROM downloads ${opts.all ? "" : "WHERE state NOT IN ('removed','gone') OR added_at > datetime('now','-3 days')"} ORDER BY added_at DESC LIMIT 200`).all()) as DownloadRow[];
	let live: QbTorrent[] = [];
	try {
		live = await app.qb().torrents(opts.hash ? { hashes: [opts.hash.toLowerCase()] } : { tag: TAG });
	} catch {
		/* qBittorrent unreachable: show what we know */
	}
	const byHash = new Map(live.map((t) => [t.hash, t]));
	return rows.map((r) => {
		const t = byHash.get(r.hash);
		return {
			...r,
			title_name: r.title_id ? getTitle(app, r.title_id)?.name : undefined,
			live: t ? { state: t.state, progress: t.progress, dlspeed: t.dlspeed, upspeed: t.upspeed, eta: t.eta, num_seeds: t.num_seeds, ratio: t.ratio, amount_left: t.amount_left } : undefined,
		};
	});
}

export function downloadLine(d: DownloadView): string {
	const l = d.live;
	const pct = Math.round((l?.progress ?? d.progress) * 100);
	const speed = l?.dlspeed ? ` ${humanBytes(l.dlspeed)}/s` : "";
	const eta = l?.eta && l.eta < 8640000 && pct < 100 ? ` eta ${Math.round(l.eta / 60)}m` : "";
	return `${d.hash.slice(0, 10)} | ${d.state}${l ? ` (${l.state})` : ""} | ${pct}%${speed}${eta} | ${d.title_name ?? d.title_id ?? "?"} | ${d.name}${d.note ? ` | ${d.note}` : ""}`;
}

// ------------------------------------------------------------------ watcher tick (ordinary code, no model)

export type WatchEvent =
	| { kind: "completed"; hash: string }
	| { kind: "removed_outside"; hash: string; filed: boolean }
	| { kind: "stalled"; hash: string; hours: number }
	| { kind: "unreachable"; error: string };

/**
 * One poll of qBittorrent's change feed (§5.3). Updates the downloads table and returns what
 * happened; the server decides what to do about it (file, notify, start a job).
 */
export async function watchTick(app: Reelix, state: { rid: number; known: Map<string, Partial<QbTorrent>> }): Promise<WatchEvent[]> {
	const events: WatchEvent[] = [];
	const qb = app.qb();
	const data = await qb.maindata(state.rid);
	if (data.full_update) state.known.clear();
	state.rid = data.rid;
	for (const [hash, patch] of Object.entries(data.torrents ?? {})) state.known.set(hash, { ...state.known.get(hash), ...patch, hash });
	const ours = app.db.prepare("SELECT * FROM downloads WHERE state IN ('downloading','added','stalled','complete')").all() as DownloadRow[];
	for (const h of data.torrents_removed ?? []) state.known.delete(h);
	const stalledAfterMs = app.config.limits.stalled_after_h * 3600_000;
	for (const d of ours) {
		const t = state.known.get(d.hash);
		if (!t) {
			if (data.full_update || (data.torrents_removed ?? []).includes(d.hash)) {
				setDownloadState(app, d.hash, "gone", "removed from qBittorrent outside Reelix");
				events.push({ kind: "removed_outside", hash: d.hash, filed: !!d.filed_at });
			}
			continue;
		}
		const progress = t.progress ?? d.progress;
		if (progress > d.progress + 0.0001) {
			app.db.prepare("UPDATE downloads SET progress = ?, last_progress_at = ? WHERE hash = ?").run(progress, nowIso(), d.hash);
			if (d.state === "stalled") setDownloadState(app, d.hash, "downloading");
			app.emit({ type: "download", hash: d.hash, state: d.state, progress });
		}
		if (d.state !== "complete" && isComplete({ progress, amount_left: t.amount_left ?? 0, state: t.state ?? "" })) {
			const contentPath = t.content_path ? toOurs(app.config.path_maps.qbittorrent, t.content_path) : null;
			const savePath = t.save_path ? toOurs(app.config.path_maps.qbittorrent, t.save_path) : null;
			app.db.prepare("UPDATE downloads SET state = 'complete', progress = 1, content_path = ?, save_path = ?, completed_at = ? WHERE hash = ?").run(contentPath, savePath, nowIso(), d.hash);
			app.emit({ type: "download", hash: d.hash, state: "complete", progress: 1 });
			events.push({ kind: "completed", hash: d.hash });
			continue;
		}
		if (d.state === "downloading" && progress < 1 && !isStoppedState(t.state ?? "")) {
			const last = Date.parse(d.last_progress_at ?? d.added_at);
			if (Date.now() - last > stalledAfterMs) {
				setDownloadState(app, d.hash, "stalled", `no progress for ${app.config.limits.stalled_after_h}h`);
				events.push({ kind: "stalled", hash: d.hash, hours: Math.round((Date.now() - last) / 3600_000) });
			}
		}
	}
	return events;
}

// ------------------------------------------------------------------ filing a finished download

export type FileOutcome = { hash: string; filed: boolean; plan: Plan; results?: ApplyItemResult[]; problems: string[] };

/** Read where the files are now (not at add time: qBittorrent may have moved them). */
export async function currentContentPath(app: Reelix, hash: string): Promise<string | undefined> {
	const t = await app.qb().torrent(hash);
	if (!t?.content_path) return undefined;
	return toOurs(app.config.path_maps.qbittorrent, t.content_path);
}

/**
 * File a completed download by code when it is routine; otherwise mark it for the agent (§5.4).
 */
export async function fileDownload(app: Reelix, hash: string, opts: { apply?: boolean } = {}): Promise<FileOutcome> {
	const d = getDownload(app, hash);
	if (!d) throw new ReelixError("unknown_download", `Reelix does not track download ${hash}.`);
	if (!d.title_id) return { hash, filed: false, plan: { items: [] }, problems: ["The download has no title recorded; identify it first."] };
	const title = requireTitle(app, d.title_id);
	const contentPath = (await currentContentPath(app, hash).catch(() => undefined)) ?? d.content_path ?? undefined;
	if (!contentPath) return { hash, filed: false, plan: { items: [] }, problems: ["qBittorrent does not report where the files are."] };
	if (contentPath !== d.content_path) app.db.prepare("UPDATE downloads SET content_path = ? WHERE hash = ?").run(contentPath, hash);
	const wanted = json<{ season: number; episode: number }[]>(d.episodes_json, []);
	const release = json<HandlePayload>(d.release_json, { title: d.name, parsed: { confident: false } });
	const { plan, problems } = autoPlan(app, title, contentPath, { wanted, hash, seasonHint: release.parsed?.season ?? (wanted[0]?.season), version: title.kind === "movie" ? release.parsed?.resolution : undefined, resolveAbsolute: title.media_class === "anime" ? (n, hint) => resolveAbsolute(app, title, n, hint) : undefined });

	// Cheap content check: running time against TMDB's.
	for (const item of plan.items.filter((i) => i.kind === "video")) {
		try {
			const p = await probe(item.source);
			const fit = runtimeFits(p.durationS, title.runtime_min, title.kind);
			if (!fit.ok) problems.push(`Content check failed for ${basename(item.source)}: ${fit.why}`);
		} catch {
			/* no ffprobe: skip the check */
		}
	}
	if (problems.length || opts.apply === false) {
		if (problems.length) setDownloadState(app, hash, "needs_agent", problems.join("; "));
		return { hash, filed: false, plan, problems };
	}
	const results = applyPlan(app, plan);
	const bad = results.filter((r) => r.status === "failed" || r.status === "conflict");
	if (bad.length) {
		setDownloadState(app, hash, "needs_agent", bad.map((b) => b.error).join("; "));
		return { hash, filed: false, plan, results, problems: bad.map((b) => b.error ?? b.status) };
	}
	await markFiled(app, hash, title.id, plan);
	return { hash, filed: true, plan, results, problems: [] };
}

export async function markFiled(app: Reelix, hash: string, titleId: string | undefined, plan: Plan): Promise<void> {
	app.db.prepare("UPDATE downloads SET state = 'filed', filed_at = ?, note = NULL WHERE hash = ?").run(nowIso(), hash);
	app.emit({ type: "download", hash, state: "filed" });
	try {
		await app.qb().addTags([hash], [TAG_FILED]);
	} catch {
		/* tag is a convenience */
	}
	const video = plan.items.find((i) => i.kind === "video" || i.kind === "disc");
	if (titleId && video) {
		const folder = video.kind === "disc" ? video.dest : video.dest.split("/").slice(0, video.dest.split("/").length - (video.episodes ? 2 : 1)).join("/");
		app.db.prepare("UPDATE titles SET library_folder = ? WHERE id = ?").run(folder, titleId);
	}
	// follows: mark filed episodes
	for (const e of plan.items.flatMap((i) => i.episodes ?? [])) {
		app.db.prepare("UPDATE follow_episodes SET state = 'filed' WHERE season = ? AND episode = ? AND follow_id IN (SELECT id FROM follows WHERE title_id = ?)").run(e.season, e.episode, titleId ?? "");
	}
	await notifyJellyfin(app, plan.items.map((i) => i.dest)).catch(() => {});
}

/** Tell Jellyfin paths changed; fall back to a full scan (§5.6). */
export async function notifyJellyfin(app: Reelix, ourPaths: string[], type: "Created" | "Deleted" = "Created"): Promise<string> {
	const jf = app.jellyfin();
	if (!jf) return "Jellyfin is not configured.";
	const theirs = [...new Set(ourPaths.map((p) => toTheirs(app.config.path_maps.jellyfin, p.replace(/\/[^/]*\.[a-z0-9]{2,4}$/i, ""))))];
	try {
		await jf.pathsUpdated(theirs.map((path) => ({ path, updateType: type })));
		return `Told Jellyfin about ${theirs.length} path(s).`;
	} catch {
		await jf.refreshAll();
		return "Asked Jellyfin for a full library scan.";
	}
}

export function videoFilesIn(path: string): string[] {
	return listFilesRecursive(path).filter((f) => VIDEO_EXT.test(f.path)).map((f) => f.path);
}

export { magnetHash, extname };
