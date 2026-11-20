import { existsSync, statfsSync } from "node:fs";
import { basename } from "node:path";
import type { DownloadBefore, Transfer } from "@reelix/plugin";
import type { Reelix } from "./app.ts";
import { json, kvGet, kvSet } from "./db.ts";
import { consumeApproval } from "./approvals.ts";
import { MARK, MARK_FILED, activeDownloader, addTransfer, downloader, downloaderOf, ourPath } from "./downloader.ts";
import { tellMediaServer } from "./media-server.ts";
import { type ApplyItemResult, type Plan, applyPlan, plannedByReelix } from "./organiser.ts";
import { probe, runtimeFits } from "./probe.ts";
import { type HandlePayload, activeHidden, fetchRelease, getHandle, hookReleaseOf, hookTitle } from "./releases.ts";
import { type Title, getTitle, requireTitle } from "./titles.ts";
import { resolveAbsolute } from "./anime.ts";
import { looksRarPacked } from "./torrent.ts";
import { ReelixError, humanBytes, nowIso, sleep } from "./util.ts";

const BEFORE = "download.before@1";

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
	/** The downloader provider that holds it. */
	downloader: string | null;
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
	/** Take a release a plugin hid. Counts for the owner, or with the owner's approval of this release. */
	allow_hidden?: boolean;
};

/** What the owner approves when the agent asks to take a hidden release. */
export const hiddenApprovalInput = (handle: string) => ({ handle, allow_hidden: true });

export type AddOutput = { hash: string; name: string; adopted: boolean; started: boolean; files: number; size?: number; skipped_files: number; warnings: string[] };

/** Plugins may refuse a download once its files are known (docs/plugins.md §8). Their reasons, or nothing. */
async function refusedBefore(app: Reelix, o: { handle?: string; payload: HandlePayload; title?: Title; files: { path: string; size: number }[]; skipped: number[]; episodes: { season: number; episode: number }[] }): Promise<string | undefined> {
	if (!app.plugins || !app.hooks.has(BEFORE)) return undefined;
	const files = o.files.map((f, i) => ({ path: f.path, size: f.size, wanted: !o.skipped.includes(i) }));
	const input: DownloadBefore = {
		release: o.handle ? hookReleaseOf(o.handle, o.payload) : undefined,
		title: o.title && hookTitle(o.title),
		options: { files, size: files.filter((f) => f.wanted).reduce((n, f) => n + f.size, 0), episodes: o.episodes },
	};
	const verdicts = await app.hooks.each(BEFORE, input);
	for (const plugin of app.hooks.plugins(BEFORE)) app.hooks.countGuard(BEFORE, plugin, 1, verdicts.some((v) => v.plugin === plugin) ? 1 : 0);
	return verdicts.length ? verdicts.map((v) => `${v.plugin}: ${v.item.reason}`).join("; ") : undefined;
}

const refusal = (why: string, removed: boolean) => new ReelixError("download_refused", `A plugin refused this download (${why})${removed ? ", so it was removed from the downloader again" : ""}. Choose another release, or ask the owner.`);

/**
 * Add a chosen release to the active downloader (§5.3, docs/plugins.md §7.5). Fetches the .torrent itself
 * so the hash and file list are known first. Everything is added paused; a magnet is started only to fetch
 * its file list, stopped again, and checked before its selection is applied and it starts for real.
 */
export async function addDownload(app: Reelix, input: AddInput, call: { actor: string; requestId: string; signal?: AbortSignal }): Promise<AddOutput> {
	const { requestId, signal } = call;
	const d = downloader(app);
	const warnings: string[] = [];
	let payload: HandlePayload | undefined;
	if (input.handle) payload = getHandle(app, input.handle);
	else if (input.magnet) payload = { magnet: input.magnet, title: input.magnet, parsed: { confident: false } };
	else throw new ReelixError("invalid_input", "Give a release handle (from release_search) or a magnet link.");
	const hidden = activeHidden(app, payload);
	if (hidden.length && !(input.allow_hidden && (call.actor.startsWith("owner:") || consumeApproval(app, "download.add", hiddenApprovalInput(input.handle!), call.actor)))) {
		const why = hidden.map((h) => `${h.plugin}: ${h.reason}`).join("; ");
		throw new ReelixError("release_hidden", `This release is hidden (${why}). Choose another. Only the owner can take it: they use "Download anyway" under "Show hidden", or tell you to; then call download_add with allow_hidden=true and Reelix asks them to confirm.`);
	}
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
	const free = freeSpace(app) ?? (await d.call("freeSpace", []).catch(() => undefined));
	if (size && free !== undefined && size > free * 0.98) throw new ReelixError("no_space", `Not enough free space: the release is ${humanBytes(size)} and ${humanBytes(free)} is free.`);
	if (size && free !== undefined && size > free * 0.8) warnings.push(`After this download only ${humanBytes(free - size)} will be free.`);

	const record = (name: string, adopted: boolean) => {
		app.db
			.prepare(
				`INSERT INTO downloads (hash, title_id, name, episodes_json, release_json, reason, state, size, added_at, last_progress_at, downloader)
				 VALUES (?, ?, ?, ?, ?, ?, 'downloading', ?, ?, ?, ?)
				 ON CONFLICT(hash) DO UPDATE SET title_id = COALESCE(excluded.title_id, downloads.title_id), episodes_json = excluded.episodes_json,
				   reason = COALESCE(excluded.reason, downloads.reason), downloader = excluded.downloader,
				   state = CASE WHEN downloads.state IN ('gone','removed') THEN 'downloading' ELSE downloads.state END`,
			)
			.run(hash, title?.id ?? null, name, JSON.stringify(input.episodes ?? []), JSON.stringify({ ...payload, ref: undefined, magnet: undefined, key: undefined, adopted }) /* the handle key may be the Jackett link, which carries the API key */, input.reason ?? null, size ?? null, nowIso(), nowIso(), d.id);
		app.emit({ type: "download", hash, state: "downloading" });
	};
	const selection = (count: number): number[] => {
		if (input.only_files?.length) return [...Array(count).keys()].filter((i) => !input.only_files!.includes(i));
		return input.skip_files ?? [];
	};
	const before = (files: { path: string; size: number }[]) => refusedBefore(app, { handle: input.handle, payload: payload!, title, files, skipped: selection(files.length), episodes: input.episodes ?? [] });

	// A .torrent's files are known now: plugins decide before anything reaches the downloader.
	if (fetched.torrent && fetched.files) {
		const why = await before(fetched.files);
		if (why) throw refusal(why, false);
	}
	const added = await addTransfer(d, fetched.torrent ? { torrent: fetched.torrent } : { magnet: fetched.magnet! }, { paused: true, mark: MARK }, signal);
	if (added.duplicate) {
		// The downloader already had it and ignored the options: adopt it instead of adding a duplicate.
		await d.call("addMark", [[hash], MARK]);
		const existing = await d.call("get", [hash]);
		const name = existing?.name ?? fetched.name ?? payload.title;
		record(name, true);
		return { hash, name, adopted: true, started: !!existing && existing.state !== "stopped", files: fetched.files?.length ?? 0, size: existing?.size, skipped_files: 0, warnings: [...warnings, `${d.label} already had this torrent; adopted it.`] };
	}

	let files = fetched.files;
	if (!fetched.torrent) {
		// A paused magnet need not fetch metadata (§7.5): start it, wait for the file list, stop it.
		await d.call("start", [[hash]]);
		let t: Transfer | undefined;
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			t = await d.call("get", [hash]);
			if (!t || t.hasMetadata) break;
			await sleep(1500, signal);
		}
		if (!t) throw new ReelixError("outcome_unknown", `${d.label} accepted the magnet link, but the transfer is gone.`);
		await d.call("stop", [[hash]]).catch(() => {});
		if (t.hasMetadata) files = (await d.call("files", [hash])).map((f) => ({ path: f.path, size: f.size }));
		if (!files?.length) {
			await d.call("remove", [[hash], { deleteFiles: true }]);
			throw new ReelixError("no_metadata", "No peer delivered the magnet's file list within two minutes, so it was removed. The release is probably dead; choose another.");
		}
		if (looksRarPacked(files) && !input.allow_rar) {
			await d.call("remove", [[hash], { deleteFiles: true }]);
			throw new ReelixError("rar_packed", "The magnet's file list shows a RAR-packed release, so it was removed. Choose another release, or pass allow_rar if the owner agreed.");
		}
		const why = await before(files);
		if (why) {
			await d.call("remove", [[hash], { deleteFiles: true }]);
			throw refusal(why, true);
		}
	}
	const skipped = files ? selection(files.length) : [];
	if (skipped.length) await d.call("setWanted", [hash, skipped, false]);
	await d.call("start", [[hash]]);
	const t = await d.call("get", [hash]);
	const name = t?.name ?? fetched.name ?? payload.title;
	record(name, false);
	return { hash, name, adopted: false, started: true, files: files?.length ?? 0, size, skipped_files: skipped.length, warnings };
}

export async function reconcileAdd(app: Reelix, requestId: string): Promise<{ status: "succeeded" | "failed"; output?: unknown } | undefined> {
	const hash = kvGet(app.db, `req:${requestId}`);
	if (!hash) return undefined;
	const t = await downloader(app).call("get", [hash]);
	return t ? { status: "succeeded", output: { hash, name: t.name, reconciled: true } } : { status: "failed" };
}

// ------------------------------------------------------------------ status

export type DownloadView = DownloadRow & { live?: Transfer; title_name?: string };

export async function listDownloads(app: Reelix, opts: { all?: boolean; hash?: string } = {}): Promise<DownloadView[]> {
	const rows = (opts.hash
		? app.db.prepare("SELECT * FROM downloads WHERE hash = ?").all(opts.hash.toLowerCase())
		: app.db.prepare(`SELECT * FROM downloads ${opts.all ? "" : "WHERE state NOT IN ('removed','gone') OR added_at > datetime('now','-3 days')"} ORDER BY added_at DESC LIMIT 200`).all()) as DownloadRow[];
	let live: Transfer[] = [];
	const d = activeDownloader(app);
	try {
		if (d) live = await d.call("list", [opts.hash ? { ids: [opts.hash.toLowerCase()] } : { mark: MARK }]);
	} catch {
		/* the downloader is unreachable: show what we know */
	}
	const byHash = new Map(live.map((t) => [t.id, t]));
	return rows.map((r) => ({ ...r, title_name: r.title_id ? getTitle(app, r.title_id)?.name : undefined, live: !r.downloader || r.downloader === d?.id ? byHash.get(r.hash) : undefined }));
}

export function downloadLine(d: DownloadView): string {
	const l = d.live;
	const pct = Math.round((l?.progress ?? d.progress) * 100);
	const speed = l?.downSpeed ? ` ${humanBytes(l.downSpeed)}/s` : "";
	const eta = l?.etaSeconds !== undefined && pct < 100 ? ` eta ${Math.round(l.etaSeconds / 60)}m` : "";
	const problem = l?.problem ? ` | ${l.problem.kind === "tracker" ? "tracker says" : "error"}: ${l.problem.message}` : "";
	return `${d.hash.slice(0, 10)} | ${d.state}${l ? ` (${l.state})` : ""} | ${pct}%${speed}${eta} | ${d.title_name ?? d.title_id ?? "?"} | ${d.name}${d.note ? ` | ${d.note}` : ""}${problem}`;
}

// ------------------------------------------------------------------ watcher tick (ordinary code, no model)

export type WatchEvent =
	| { kind: "completed"; hash: string }
	| { kind: "removed_outside"; hash: string; filed: boolean }
	| { kind: "stalled"; hash: string; hours: number }
	| { kind: "unreachable"; error: string };

/** What the watcher knows between ticks, for one downloader. */
export type WatchState = { provider?: string; cursor?: string; known: Map<string, Transfer> };

/**
 * One look at the active downloader (§5.3, docs/plugins.md §7.5): its change feed when it has one, else
 * a list of Reelix's own transfers. Updates the downloads table and returns what happened; the server
 * decides what to do about it (file, notify, start a job).
 */
export async function watchTick(app: Reelix, state: WatchState): Promise<WatchEvent[]> {
	const d = downloader(app);
	if (state.provider !== d.id) {
		state.provider = d.id;
		state.cursor = undefined;
		state.known.clear();
	}
	const ours = app.db.prepare("SELECT * FROM downloads WHERE state IN ('downloading','added','stalled','complete') AND (downloader IS NULL OR downloader = ?)").all(d.id) as DownloadRow[];
	/** Transfers proven gone: only a full answer, `removed`, or an id missing from a successful list proves it. */
	const gone = new Set<string>();
	if (d.has("changes")) {
		const c = await d.call("changes", [state.cursor]);
		state.cursor = c.cursor;
		if (c.full) {
			state.known.clear();
			for (const r of ours) if (!c.changed.some((t) => t.id === r.hash)) gone.add(r.hash);
		}
		for (const t of c.changed) state.known.set(t.id, t);
		for (const h of c.removed) {
			state.known.delete(h);
			gone.add(h);
		}
	} else {
		const ids = ours.map((r) => r.hash);
		const found = ids.length ? await d.call("list", [{ ids }]) : [];
		state.known.clear();
		for (const t of found) state.known.set(t.id, t);
		for (const h of ids) if (!state.known.has(h)) gone.add(h);
	}
	const events: WatchEvent[] = [];
	const stalledAfterMs = app.config.limits.stalled_after_h * 3600_000;
	for (const r of ours) {
		const t = state.known.get(r.hash);
		if (!t) {
			if (gone.has(r.hash)) {
				setDownloadState(app, r.hash, "gone", `removed from ${d.label} outside Reelix`);
				events.push({ kind: "removed_outside", hash: r.hash, filed: !!r.filed_at });
			}
			continue;
		}
		if (t.progress > r.progress + 0.0001) {
			app.db.prepare("UPDATE downloads SET progress = ?, last_progress_at = ? WHERE hash = ?").run(t.progress, nowIso(), r.hash);
			if (r.state === "stalled") setDownloadState(app, r.hash, "downloading");
			app.emit({ type: "download", hash: r.hash, state: r.state, progress: t.progress });
		}
		if (r.state !== "complete" && t.done) {
			const contentPath = t.contentPath ? ourPath(app, d.id, t.contentPath) : null;
			const savePath = t.folder ? ourPath(app, d.id, t.folder) : null;
			app.db.prepare("UPDATE downloads SET state = 'complete', progress = 1, content_path = ?, save_path = ?, completed_at = ? WHERE hash = ?").run(contentPath, savePath, nowIso(), r.hash);
			app.emit({ type: "download", hash: r.hash, state: "complete", progress: 1 });
			events.push({ kind: "completed", hash: r.hash });
			continue;
		}
		if (r.state === "downloading" && !t.done && t.state !== "stopped") {
			const last = Date.parse(r.last_progress_at ?? r.added_at);
			if (Date.now() - last > stalledAfterMs) {
				setDownloadState(app, r.hash, "stalled", `no progress for ${app.config.limits.stalled_after_h}h`);
				events.push({ kind: "stalled", hash: r.hash, hours: Math.round((Date.now() - last) / 3600_000) });
			}
		}
	}
	return events;
}

// ------------------------------------------------------------------ filing a finished download

export type FileOutcome = { hash: string; filed: boolean; plan: Plan; results?: ApplyItemResult[]; problems: string[] };

/** Read where the files are now (not at add time: the downloader may have moved them). */
export async function currentContentPath(app: Reelix, row: DownloadRow): Promise<string | undefined> {
	const d = downloaderOf(app, row);
	const t = await d.call("get", [row.hash]);
	if (!t?.done || !t.contentPath) return undefined;
	return ourPath(app, d.id, t.contentPath);
}

/**
 * File a completed download by code when it is routine; otherwise mark it for the agent (§5.4).
 */
export async function fileDownload(app: Reelix, hash: string, opts: { apply?: boolean } = {}): Promise<FileOutcome> {
	const d = getDownload(app, hash);
	if (!d) throw new ReelixError("unknown_download", `Reelix does not track download ${hash}.`);
	if (!d.title_id) return { hash, filed: false, plan: { items: [] }, problems: ["The download has no title recorded; identify it first."] };
	const title = requireTitle(app, d.title_id);
	const contentPath = (await currentContentPath(app, d).catch(() => undefined)) ?? d.content_path ?? undefined;
	if (!contentPath) return { hash, filed: false, plan: { items: [] }, problems: ["The downloader does not report where the files are."] };
	if (contentPath !== d.content_path) app.db.prepare("UPDATE downloads SET content_path = ? WHERE hash = ?").run(contentPath, hash);
	const wanted = json<{ season: number; episode: number }[]>(d.episodes_json, []);
	const release = json<HandlePayload>(d.release_json, { title: d.name, parsed: { confident: false } });
	const { plan, problems } = await plannedByReelix(app, title, contentPath, { wanted, hash, seasonHint: release.parsed?.season ?? (wanted[0]?.season), version: title.kind === "movie" ? release.parsed?.resolution : undefined, resolveAbsolute: title.media_class === "anime" ? (n, hint) => resolveAbsolute(app, title, n, hint) : undefined });

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
	await markFiled(app, hash, title.id, plan, "download");
	return { hash, filed: true, plan, results, problems: [] };
}

export async function markFiled(app: Reelix, hash: string, titleId: string | undefined, plan: Plan, via: "download" | "adopt"): Promise<void> {
	app.db.prepare("UPDATE downloads SET state = 'filed', filed_at = ?, note = NULL WHERE hash = ?").run(nowIso(), hash);
	app.emit({ type: "download", hash, state: "filed" });
	try {
		await downloaderOf(app, getDownload(app, hash)).call("addMark", [[hash], MARK_FILED]);
	} catch {
		/* the mark is a convenience */
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
	await tellMediaServer(app, plan.items.map((i) => i.dest)).catch(() => {});
	app.pluginEvents.emit("download.filed", { hash, titleId, paths: plan.items.map((i) => i.dest), via });
}
