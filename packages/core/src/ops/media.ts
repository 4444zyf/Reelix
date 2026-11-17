import { Type } from "typebox";
import { getPath, KNOWN_SECRETS, describeConfig, isKnownConfigPath, parseLooseValue } from "../config.ts";
import { checksToText, doctor } from "../doctor.ts";
import { addDownload, downloadLine, fileDownload, getDownload, listDownloads, markFiled, notifyJellyfin, reconcileAdd, setDownloadState, TAG } from "../downloads.ts";
import { haveInLibrary, libraryOverview, listRemoved, removeFromLibrary, restoreRemoved, titleFiles } from "../library.ts";
import { applyPlan, autoPlan, planToText, type Plan } from "../organiser.ts";
import { grabFrame, probe, probeToText } from "../probe.ts";
import { defineOperation } from "../registry.ts";
import { describeFiles, fetchRelease, getHandle, searchReleases, searchToText } from "../releases.ts";
import { addTitleNote, createLocalTitle, fetchTitle, findTitle, linkBangumi, linkDouban, requireTitle, titleSummary, type Title } from "../titles.ts";
import { ReelixError, humanBytes } from "../util.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";

const Episode = Type.Object({ season: Type.Integer({ minimum: 0 }), episode: Type.Integer({ minimum: 0 }) });

// ------------------------------------------------------------------ config & secrets

defineOperation({
	name: "config.show",
	summary: "Show current settings (never secrets)",
	effect: "read",
	input: Type.Object({ path: Type.Optional(Type.String({ description: "dotted path, e.g. limits" })) }),
	positional: ["path"],
	async run(ctx, i) {
		return i.path ? { path: i.path, value: getPath(ctx.app.config, i.path) } : { summary: describeConfig(ctx.app.config, ctx.app.secrets), config: ctx.app.config, warning: ctx.app.configWarning };
	},
	toText: (o: any) => (o.summary ? o.summary + (o.warning ? `\nWARNING: ${o.warning}` : "") : `${o.path} = ${JSON.stringify(o.value, null, 1)}`),
});

defineOperation({
	name: "config.set",
	summary: "Change a setting in config.yaml (validated, recorded)",
	effect: "write",
	input: Type.Object({ path: Type.String({ description: "dotted path, e.g. library.movies" }), value: Type.Unknown({ description: "the new value (any JSON); a string is parsed as JSON if it can be; empty string unsets" }) }),
	positional: ["path", "value"],
	async run(ctx, i) {
		if (i.path.startsWith("secrets") || KNOWN_SECRETS[i.path]) throw new ReelixError("use_secret", `"${i.path}" is a secret; use secret.set (the secret field), not config.`);
		if (!isKnownConfigPath(i.path)) throw new ReelixError("unknown_setting", `There is no setting "${i.path}". See \`reelix config show\`.`);
		const value = i.value === "" || i.value === null ? undefined : typeof i.value === "string" ? parseLooseValue(i.value) : i.value;
		const before = getPath(ctx.app.config, i.path);
		ctx.app.setConfig(i.path, value);
		return { path: i.path, before, after: getPath(ctx.app.config, i.path) };
	},
	toText: (o: any) => `${o.path}: ${JSON.stringify(o.before)} → ${JSON.stringify(o.after)}`,
});

defineOperation({
	name: "secret.set",
	summary: "Store a password or API key in secrets.yaml (owner only; the value never enters chat)",
	effect: "write",
	input: Type.Object({ key: Type.String(), value: Type.String() }),
	positional: ["key"],
	async run(ctx, i) {
		ctx.app.setSecret(i.key, i.value);
		return { key: i.key, set: !!i.value };
	},
	toText: (o: any) => `${o.key} ${o.set ? "stored" : "removed"}.`,
});

defineOperation({
	name: "secret.list",
	summary: "Which secrets are set (names only)",
	effect: "read",
	input: Type.Object({}),
	async run(ctx) {
		const names = new Set([...Object.keys(KNOWN_SECRETS), ...Object.keys(ctx.app.secrets)]);
		return [...names].sort().map((k) => ({ key: k, what: KNOWN_SECRETS[k] ?? "", set: !!ctx.app.secrets[k] }));
	},
	toText: (o: any[]) => o.map((s) => `${s.set ? "set    " : "missing"} ${s.key}${s.what ? ` — ${s.what}` : ""}`).join("\n"),
});

defineOperation({
	name: "doctor",
	summary: "Check connections, paths, hard links, permissions, space, indexers",
	effect: "read",
	input: Type.Object({ quick: Type.Optional(Type.Boolean()) }),
	async run(ctx, i) {
		return doctor(ctx.app, { quick: i.quick });
	},
	toText: checksToText,
});

// ------------------------------------------------------------------ titles

defineOperation({
	name: "title.find",
	summary: "Resolve a name, link (TMDB/IMDb/Douban/Bangumi), magnet or release name to a title",
	description: "IDs settle it; an exact name+year match is accepted; otherwise candidates are returned to weigh. Pass id=movie:123 to pick one.",
	effect: "read",
	tool: "title_find",
	input: Type.Object({
		query: Type.Optional(Type.String({ description: "name, link, ID, magnet or release name" })),
		id: Type.Optional(Type.String({ description: "pick a candidate: movie:123 or tv:456" })),
		kind: Type.Optional(Type.Union([Type.Literal("movie"), Type.Literal("tv")])),
		year: Type.Optional(Type.Integer()),
	}),
	positional: ["query"],
	async run(ctx, i) {
		if (i.id) {
			const m = /^(movie|tv)[:/](\d+)$/.exec(i.id.trim());
			if (!m) return { resolved: requireTitle(ctx.app, i.id), how: "known title", candidates: [] };
			return { input: i.id, resolved: await fetchTitle(ctx.app, m[1] as "movie" | "tv", Number(m[2])), how: "chosen ID", candidates: [] };
		}
		if (!i.query) throw new ReelixError("invalid_input", "Give a query or an id.");
		return findTitle(ctx.app, i.query, { kind: i.kind, year: i.year });
	},
	toText(o: any) {
		if (o.resolved) {
			const t = o.resolved as Title;
			return `Resolved (${o.how}): ${titleSummary(t)}${o.note ? `\n${o.note}` : ""}`;
		}
		const c = (o.candidates ?? []).map((x: any) => `${x.id} | ${x.name}${x.original_name && x.original_name !== x.name ? ` / ${x.original_name}` : ""} | ${x.year ?? "?"} | ${x.overview ?? ""}`);
		return `${o.parsed ? `Parsed: ${JSON.stringify(o.parsed)}\n` : ""}${c.length ? `Candidates:\n${c.join("\n")}` : "No candidates."}${o.note ? `\n${o.note}` : ""}`;
	},
	titleOf: (_i, o: any) => o?.resolved?.id,
});

defineOperation({
	name: "title.show",
	summary: "A known title: identity, notes, library files, downloads",
	effect: "read",
	input: Type.Object({ id: Type.String() }),
	positional: ["id"],
	async run(ctx, i) {
		const t = requireTitle(ctx.app, i.id);
		const files = titleFiles(ctx.app, t.id);
		const downloads = ctx.app.db.prepare("SELECT hash, name, state, progress, reason, added_at FROM downloads WHERE title_id = ? ORDER BY added_at DESC").all(t.id);
		const follows = ctx.app.db.prepare("SELECT * FROM follows WHERE title_id = ?").all(t.id);
		return { title: t, have: haveInLibrary(ctx.app, t), files, downloads, follows };
	},
	toText(o: any) {
		const f = o.files.map((x: any) => `  ${x.kind}${x.exists ? "" : " (MISSING)"}: ${x.dest}`).join("\n");
		const d = o.downloads.map((x: any) => `  ${x.hash.slice(0, 10)} ${x.state} ${Math.round(x.progress * 100)}% ${x.name}${x.reason ? ` — why: ${x.reason}` : ""}`).join("\n");
		return `${titleSummary(o.title)}\nlibrary folder: ${o.have.folder ?? "none"}\nfiles:\n${f || "  none"}\ndownloads:\n${d || "  none"}${o.follows.length ? `\nfollows: ${o.follows.map((x: any) => `${x.id}: "${x.instruction}"`).join("; ")}` : ""}`;
	},
	titleOf: (i) => i.id,
});

defineOperation({
	name: "title.note",
	summary: "Add a lasting correction or note to one title (e.g. 'episode 13 is S2E1')",
	effect: "write",
	input: Type.Object({ id: Type.String(), note: Type.String() }),
	positional: ["id", "note"],
	async run(ctx, i) {
		return addTitleNote(ctx.app, i.id, i.note);
	},
	toText: (t: any) => `Noted on ${t.id}:\n${t.notes}`,
	titleOf: (i) => i.id,
});

defineOperation({
	name: "title.set",
	summary: "Correct a title's media class (movie/show/anime), folder name, or linked Douban/Bangumi IDs",
	effect: "write",
	input: Type.Object({
		id: Type.String(),
		media_class: Type.Optional(Type.Union([Type.Literal("movie"), Type.Literal("show"), Type.Literal("anime")])),
		folder_name: Type.Optional(Type.String()),
		douban_id: Type.Optional(Type.String()),
		bangumi_id: Type.Optional(Type.Integer()),
	}),
	positional: ["id"],
	async run(ctx, i) {
		const t = requireTitle(ctx.app, i.id);
		if (i.media_class) ctx.app.db.prepare("UPDATE titles SET media_class = ? WHERE id = ?").run(i.media_class, t.id);
		if (i.folder_name) ctx.app.db.prepare("UPDATE titles SET folder_name = ? WHERE id = ?").run(i.folder_name, t.id);
		if (i.douban_id) linkDouban(ctx.app, t.id, i.douban_id);
		if (i.bangumi_id) linkBangumi(ctx.app, t.id, i.bangumi_id);
		return requireTitle(ctx.app, t.id);
	},
	toText: (t: any) => titleSummary(t),
	titleOf: (i) => i.id,
});

defineOperation({
	name: "title.local",
	summary: "Create a local-only title for something not on TMDB (no ID tag in its folder)",
	effect: "write",
	input: Type.Object({ name: Type.String(), kind: Type.Union([Type.Literal("movie"), Type.Literal("tv")]), year: Type.Optional(Type.Integer()), media_class: Type.Optional(Type.String()), folder_name: Type.Optional(Type.String()) }),
	positional: ["name"],
	async run(ctx, i) {
		return createLocalTitle(ctx.app, i);
	},
	toText: (t: any) => `Created ${titleSummary(t)}`,
});

// ------------------------------------------------------------------ releases

defineOperation({
	name: "release.search",
	summary: "Search Jackett for a title; a compact paged list with handles",
	description: "Each indexer is queried separately; errors are reported per indexer. If nothing is found, check indexer health before saying it is unavailable.",
	effect: "read",
	tool: "release_search",
	input: Type.Object({
		title_id: Type.Optional(Type.String({ description: "movie:123 / tv:456 from title_find" })),
		query: Type.Optional(Type.String({ description: "free-text query instead of (or overriding) the title's names" })),
		season: Type.Optional(Type.Integer()),
		episode: Type.Optional(Type.Integer()),
		sort: Type.Optional(Type.Union([Type.Literal("seeders"), Type.Literal("size"), Type.Literal("date")])),
		limit: Type.Optional(Type.Integer({ default: 15, maximum: 50 })),
		offset: Type.Optional(Type.Integer({ default: 0 })),
	}),
	positional: ["title_id"],
	async run(ctx, i) {
		const title = i.title_id ? requireTitle(ctx.app, i.title_id) : undefined;
		return searchReleases(ctx.app, { title, query: i.query, season: i.season, episode: i.episode, sort: i.sort, limit: i.limit, offset: i.offset });
	},
	toText: searchToText,
});

defineOperation({
	name: "release.files",
	summary: "The real file list of a release (packs, RAR, disc images) before committing",
	description: "For a .torrent it is immediate. For a magnet-only release the list is only known after adding (download_add checks it).",
	effect: "read",
	tool: "release_files",
	input: Type.Object({ handle: Type.String() }),
	positional: ["handle"],
	async run(ctx, i) {
		const h = getHandle(ctx.app, i.handle);
		const f = await fetchRelease(ctx.app, h);
		return { handle: i.handle, name: f.name ?? h.title, hash: f.hash, private: f.private, files: f.files, magnetOnly: !f.files };
	},
	toText: (o: any) => (o.magnetOnly ? `${o.handle}: magnet link only; the file list becomes available after adding (download_add checks it before starting).` : `${o.handle}: ${o.name}${o.private ? " (private tracker)" : ""}\n${describeFiles(o.files)}`),
});

// ------------------------------------------------------------------ downloads

defineOperation({
	name: "download.add",
	summary: "Add a chosen release to qBittorrent for a known title, recording why",
	description: "Fetches the .torrent itself (hash and file list known at once); a magnet is added stopped and checked first. Adopts an existing identical torrent. Use skip_files/only_files (indexes from release_files) for partial packs.",
	effect: "write",
	tool: "download_add",
	input: Type.Object({
		handle: Type.Optional(Type.String({ description: "release handle from release_search" })),
		magnet: Type.Optional(Type.String()),
		title_id: Type.Optional(Type.String()),
		episodes: Type.Optional(Type.Array(Episode, { description: "episodes wanted from this release; omit for a film or a whole pack" })),
		reason: Type.Optional(Type.String({ description: "one sentence: why this release" })),
		skip_files: Type.Optional(Type.Array(Type.Integer())),
		only_files: Type.Optional(Type.Array(Type.Integer())),
		allow_rar: Type.Optional(Type.Boolean()),
	}),
	positional: ["handle"],
	async run(ctx, i) {
		return addDownload(ctx.app, i, ctx.requestId, ctx.signal);
	},
	reconcile: (ctx) => reconcileAdd(ctx.app, ctx.requestId),
	toText: (o: any) => `${o.adopted ? "Adopted existing" : "Added and started"}: ${o.name} (${o.hash.slice(0, 10)}), ${o.files} files${o.size ? `, ${humanBytes(o.size)}` : ""}${o.skipped_files ? `, ${o.skipped_files} files skipped` : ""}. Added is not downloaded: check download_status later.${o.warnings?.length ? `\nNote: ${o.warnings.join(" ")}` : ""}`,
	titleOf: (i) => i.title_id,
});

defineOperation({
	name: "download.status",
	summary: "Progress and state of Reelix's downloads (or one by hash)",
	effect: "read",
	tool: "download_status",
	input: Type.Object({ hash: Type.Optional(Type.String()), all: Type.Optional(Type.Boolean()) }),
	positional: ["hash"],
	async run(ctx, i) {
		let hash = i.hash;
		if (hash && hash.length < 40) hash = (ctx.app.db.prepare("SELECT hash FROM downloads WHERE hash LIKE ?").get(hash.toLowerCase() + "%") as { hash: string } | undefined)?.hash ?? hash;
		return listDownloads(ctx.app, { hash, all: i.all });
	},
	toText: (o: any[]) => (o.length ? `hash | state | progress | title | name\n${o.map(downloadLine).join("\n")}` : "No downloads."),
});

function resolveHash(ctx: { app: import("../app.ts").Reelix }, h: string): string {
	const row = ctx.app.db.prepare("SELECT hash FROM downloads WHERE hash LIKE ?").get(h.toLowerCase() + "%") as { hash: string } | undefined;
	return row?.hash ?? h.toLowerCase();
}

defineOperation({
	name: "download.pause",
	summary: "Pause a download",
	effect: "write",
	input: Type.Object({ hash: Type.String() }),
	positional: ["hash"],
	async run(ctx, i) {
		const h = resolveHash(ctx, i.hash);
		await ctx.app.qb().stop([h]);
		return { hash: h, paused: true };
	},
	toText: (o: any) => `Paused ${o.hash.slice(0, 10)}.`,
});

defineOperation({
	name: "download.resume",
	summary: "Resume a download",
	effect: "write",
	input: Type.Object({ hash: Type.String() }),
	positional: ["hash"],
	async run(ctx, i) {
		const h = resolveHash(ctx, i.hash);
		await ctx.app.qb().start([h]);
		return { hash: h, resumed: true };
	},
	toText: (o: any) => `Resumed ${o.hash.slice(0, 10)}.`,
});

defineOperation({
	name: "download.remove",
	summary: "Remove a torrent from qBittorrent, optionally with its data",
	effect: "destructive",
	input: Type.Object({ hash: Type.String(), delete_data: Type.Boolean({ default: false }) }),
	positional: ["hash"],
	async run(ctx, i) {
		const h = resolveHash(ctx, i.hash);
		await ctx.app.qb().delete([h], i.delete_data);
		setDownloadState(ctx.app, h, "removed", i.delete_data ? "removed with data" : "removed, data kept");
		return { hash: h, data_deleted: i.delete_data };
	},
	reconcile: async (ctx, i) => ((await ctx.app.qb().torrent(resolveHash(ctx, i.hash))) ? { status: "failed" } : { status: "succeeded" }),
	toText: (o: any) => `Removed torrent ${o.hash.slice(0, 10)}${o.data_deleted ? " and deleted its data" : "; its data is still on disk"}.`,
});

defineOperation({
	name: "download.adopt",
	summary: "Take an existing qBittorrent torrent under Reelix's care for a title",
	effect: "write",
	input: Type.Object({ hash: Type.String(), title_id: Type.String(), episodes: Type.Optional(Type.Array(Episode)), reason: Type.Optional(Type.String()) }),
	positional: ["hash", "title_id"],
	async run(ctx, i) {
		const t = await ctx.app.qb().torrent(i.hash.toLowerCase());
		if (!t) throw new ReelixError("not_found", `qBittorrent has no torrent ${i.hash}.`);
		const title = requireTitle(ctx.app, i.title_id);
		await ctx.app.qb().addTags([t.hash], [TAG]);
		ctx.app.db
			.prepare(`INSERT INTO downloads (hash, title_id, name, episodes_json, release_json, reason, state, progress, size, added_at, last_progress_at) VALUES (?, ?, ?, ?, ?, ?, 'downloading', ?, ?, datetime('now'), datetime('now'))
			 ON CONFLICT(hash) DO UPDATE SET title_id = excluded.title_id, episodes_json = excluded.episodes_json, state = CASE WHEN downloads.state = 'filed' THEN 'filed' ELSE 'downloading' END`)
			.run(t.hash, title.id, t.name, JSON.stringify(i.episodes ?? []), JSON.stringify({ title: t.name, adopted: true }), i.reason ?? "adopted", t.progress, t.size);
		return { hash: t.hash, name: t.name, title: title.id, progress: t.progress };
	},
	toText: (o: any) => `Adopted ${o.name} (${o.hash.slice(0, 10)}) for ${o.title}, ${Math.round(o.progress * 100)}% done. It is filed when complete.`,
	titleOf: (i) => i.title_id,
});

// ------------------------------------------------------------------ organising

const PlanItemSchema = Type.Object({
	source: Type.String(),
	dest: Type.String(),
	kind: Type.Union([Type.Literal("video"), Type.Literal("subtitle"), Type.Literal("extra"), Type.Literal("audio"), Type.Literal("disc")]),
	reason: Type.Optional(Type.String()),
	episodes: Type.Optional(Type.Array(Episode)),
	version: Type.Optional(Type.String()),
});

defineOperation({
	name: "organise",
	summary: "Plan or apply filing a download into the Jellyfin library by hard link",
	description:
		"mode=plan: code plans a routine download (by hash, or title_id + path) and lists problems. mode=apply: apply a plan (the code plan by hash, or your own items). Apply only creates hard links inside the library, never replaces files, and is safe to repeat.",
	effect: "write",
	tool: "organise",
	input: Type.Object({
		mode: Type.Union([Type.Literal("plan"), Type.Literal("apply")]),
		hash: Type.Optional(Type.String({ description: "a Reelix download" })),
		title_id: Type.Optional(Type.String()),
		path: Type.Optional(Type.String({ description: "a file or folder in the download folder (for things not downloaded by Reelix)" })),
		items: Type.Optional(Type.Array(PlanItemSchema, { description: "your own plan items (apply mode)" })),
		version: Type.Optional(Type.String({ description: "version label for a second copy of a film, e.g. 2160p" })),
		season: Type.Optional(Type.Integer({ description: "season for files numbered without one" })),
	}),
	async run(ctx, i) {
		const app = ctx.app;
		const hash = i.hash ? resolveHash(ctx, i.hash) : undefined;
		const d = hash ? getDownload(app, hash) : undefined;
		const titleId = i.title_id ?? d?.title_id ?? undefined;
		let plan: Plan;
		let problems: string[] = [];
		if (i.items?.length) plan = { title_id: titleId, download_hash: hash, items: i.items };
		else if (hash && i.mode === "plan" && !i.path) {
			const r = await fileDownload(app, hash, { apply: false });
			plan = r.plan;
			problems = r.problems;
		} else {
			if (!titleId) throw new ReelixError("invalid_input", "Give a hash of a Reelix download, or title_id with path.");
			const title = requireTitle(app, titleId);
			const path = i.path ?? d?.content_path;
			if (!path) throw new ReelixError("invalid_input", "No path: give path=, or a hash of a completed download.");
			const r = autoPlan(app, title, path, { hash, version: i.version, seasonHint: i.season, wanted: d ? JSON.parse(d.episodes_json) : undefined });
			plan = r.plan;
			problems = r.problems;
		}
		if (i.mode === "plan") return { mode: "plan", plan, problems };
		if (!plan.items.length) throw new ReelixError("empty_plan", `Nothing to apply.${problems.length ? ` Problems: ${problems.join("; ")}` : ""}`);
		const results = applyPlan(app, plan);
		const ok = results.every((r) => r.status === "linked" || r.status === "already");
		if (ok && hash) await markFiled(app, hash, titleId, plan);
		else if (ok && titleId) await notifyJellyfin(app, plan.items.map((x) => x.dest)).catch(() => {});
		return { mode: "apply", plan, results, ok };
	},
	reconcile: async () => ({ status: "succeeded" }), // apply is idempotent: re-running yields "already"
	toText: (o: any) => (o.mode === "plan" ? `Plan (${o.plan.items.length} items):\n${planToText(o.plan)}${o.problems.length ? `\nProblems:\n- ${o.problems.join("\n- ")}` : "\nNo problems: safe to apply."}` : `${o.ok ? "Applied" : "Applied with failures"}:\n${planToText(o.plan, o.results)}`),
	titleOf: (i) => i.title_id,
});

// ------------------------------------------------------------------ library

defineOperation({
	name: "library.list",
	summary: "Titles in the library, and folders on disk Reelix does not track",
	effect: "read",
	input: Type.Object({}),
	async run(ctx) {
		return libraryOverview(ctx.app);
	},
	toText: (o: any) => `${o.titles.length} titles:\n${o.titles.map((t: any) => `${t.id} | ${t.name} (${t.year ?? "?"}) | ${t.media_class} | ${t.file_count} files`).join("\n")}${o.untracked_folders.length ? `\nUntracked folders (${o.untracked_folders.length}):\n${o.untracked_folders.slice(0, 50).join("\n")}` : ""}`,
});

defineOperation({
	name: "library.remove",
	summary: "Remove a title (or season/episodes) at one of three levels: entry | torrent | data",
	description: "entry: library link only (restorable while the download exists). torrent: also remove the torrent, data stays. data: also delete the downloaded data (gone immediately). A last remaining copy goes to a 14-day trash.",
	effect: "destructive",
	input: Type.Object({
		title_id: Type.String(),
		level: Type.Union([Type.Literal("entry"), Type.Literal("torrent"), Type.Literal("data")]),
		season: Type.Optional(Type.Integer()),
		episodes: Type.Optional(Type.Array(Type.Integer())),
		paths: Type.Optional(Type.Array(Type.String())),
	}),
	positional: ["title_id", "level"],
	async run(ctx, i) {
		return removeFromLibrary(ctx.app, i);
	},
	toText: (o: any) => `Unlinked ${o.unlinked.length} (data still in downloads unless deleted), moved ${o.trashed.length} last copies to the trash${o.torrent ? `; torrent ${o.data_deleted ? "and data deleted" : "removed, data kept"}` : ""}.${o.unlinked.length + o.trashed.length ? `\n${[...o.unlinked, ...o.trashed].join("\n")}` : ""}${o.notes.length ? `\n${o.notes.join("\n")}` : ""}`,
	titleOf: (i) => i.title_id,
});

defineOperation({
	name: "library.removed",
	summary: "Removed library entries that can be restored, and the trash",
	effect: "read",
	input: Type.Object({ title_id: Type.Optional(Type.String()) }),
	async run(ctx, i) {
		return listRemoved(ctx.app, i.title_id);
	},
	toText: (o: any[]) => o.map((r) => `${r.id} | ${r.removed_at.slice(0, 16)} | ${r.trash_path ? `trash until ${r.expires_at?.slice(0, 10)}` : "unlinked"} | ${r.restorable ? "restorable" : "NOT restorable"} | ${r.dest}`).join("\n") || "Nothing removed.",
});

defineOperation({
	name: "library.restore",
	summary: "Restore removed library entries by id (re-link or move back from trash)",
	effect: "write",
	input: Type.Object({ ids: Type.Array(Type.Integer()) }),
	async run(ctx, i) {
		return restoreRemoved(ctx.app, i.ids);
	},
	toText: (o: any) => `Restored ${o.restored.length}.${o.failed.length ? ` Failed: ${o.failed.map((f: any) => `${f.dest}: ${f.error}`).join("; ")}` : ""}`,
});

defineOperation({
	name: "jellyfin.refresh",
	summary: "Tell Jellyfin that paths changed (or scan everything)",
	effect: "write",
	input: Type.Object({ paths: Type.Optional(Type.Array(Type.String())) }),
	async run(ctx, i) {
		if (i.paths?.length) return { result: await notifyJellyfin(ctx.app, i.paths) };
		const jf = ctx.app.jellyfin();
		if (!jf) throw new ReelixError("not_configured", "Jellyfin is not configured.");
		await jf.refreshAll();
		return { result: "Full library scan requested." };
	},
	toText: (o: any) => o.result,
});

// ------------------------------------------------------------------ media

defineOperation({
	name: "media.probe",
	summary: "A video's running time, tracks and embedded subtitles; optionally grab a frame",
	effect: "read",
	tool: "media_probe",
	input: Type.Object({ path: Type.String(), frame_at_s: Type.Optional(Type.Number({ description: "grab a frame at this second; returned as an image" })) }),
	positional: ["path"],
	async run(ctx, i) {
		if (!existsSync(i.path)) throw new ReelixError("not_found", `No such file: ${i.path}`);
		const p = await probe(i.path);
		let frame: string | undefined;
		if (i.frame_at_s !== undefined) frame = await grabFrame(i.path, i.frame_at_s, join(ctx.app.paths.workspace, `frame-${Date.now()}.png`));
		return { ...p, frame };
	},
	toText: (o: any) => probeToText(o) + (o.frame ? `\nframe saved: ${o.frame}` : ""),
});

// ------------------------------------------------------------------ qBittorrent and Jackett settings (§10)

defineOperation({
	name: "qb.prefs",
	summary: "Read qBittorrent preferences (save folders, completion behaviour, …)",
	effect: "read",
	input: Type.Object({ keys: Type.Optional(Type.Array(Type.String())) }),
	async run(ctx, i) {
		const p = await ctx.app.qb().preferences();
		const keys = i.keys?.length ? i.keys : ["save_path", "temp_path_enabled", "temp_path", "auto_tmm_enabled", "torrent_changed_tmm_enabled", "max_ratio_enabled", "max_ratio", "max_ratio_act", "add_stopped_enabled", "start_paused_enabled", "preallocate_all", "incomplete_files_ext"];
		return Object.fromEntries(keys.filter((k) => k in p).map((k) => [k, p[k]]));
	},
	toText: (o: any) => Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n"),
});

defineOperation({
	name: "qb.set_prefs",
	summary: "Change qBittorrent preferences (JSON object)",
	effect: "write",
	input: Type.Object({ prefs: Type.Record(Type.String(), Type.Unknown()) }),
	async run(ctx, i) {
		await ctx.app.qb().setPreferences(i.prefs);
		return { changed: Object.keys(i.prefs) };
	},
	toText: (o: any) => `qBittorrent preferences changed: ${o.changed.join(", ")}`,
});

defineOperation({
	name: "qb.torrents",
	summary: "All torrents in qBittorrent (not only Reelix's), for adoption and diagnosis",
	effect: "read",
	input: Type.Object({ filter: Type.Optional(Type.String({ description: "substring of the name" })), limit: Type.Optional(Type.Integer({ default: 50 })) }),
	async run(ctx, i) {
		let t = await ctx.app.qb().torrents();
		if (i.filter) t = t.filter((x) => x.name.toLowerCase().includes(i.filter!.toLowerCase()));
		return { total: t.length, torrents: t.slice(0, i.limit).map((x) => ({ hash: x.hash, name: x.name, state: x.state, progress: x.progress, size: x.size, tags: x.tags, category: x.category, content_path: x.content_path })) };
	},
	toText: (o: any) => `${o.total} torrents\n${o.torrents.map((x: any) => `${x.hash.slice(0, 10)} | ${x.state} | ${Math.round(x.progress * 100)}% | ${humanBytes(x.size)} | ${x.tags || "-"} | ${x.name}`).join("\n")}`,
});

defineOperation({
	name: "jackett.indexers",
	summary: "Jackett's configured indexers; with test=true, a health check of each",
	effect: "read",
	input: Type.Object({ test: Type.Optional(Type.Boolean()) }),
	async run(ctx, i) {
		const ix = await ctx.app.jackett().indexers();
		if (!i.test) return { indexers: ix };
		const { outcomes } = await ctx.app.jackett().searchEach(ix, ["test"], [], 20_000);
		return { indexers: ix, health: outcomes };
	},
	toText: (o: any) => o.indexers.map((x: any) => { const h = o.health?.find((y: any) => y.indexer === x.id); return `${x.id} | ${x.name} | ${x.type ?? ""}${h ? ` | ${h.ok ? `ok ${(h.ms / 1000).toFixed(1)}s` : `ERROR ${h.error}`}` : ""}`; }).join("\n"),
});

// ------------------------------------------------------------------ the ledger (Activity)

defineOperation({
	name: "activity",
	summary: "The ledger: what was done, by whom, with what result (newest first)",
	effect: "read",
	input: Type.Object({ limit: Type.Optional(Type.Integer({ default: 30 })), title_id: Type.Optional(Type.String()), status: Type.Optional(Type.String()) }),
	async run(ctx, i) {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (i.title_id) (where.push("title_id = ?"), args.push(i.title_id));
		if (i.status) (where.push("status = ?"), args.push(i.status));
		return ctx.app.db.prepare(`SELECT id, op, actor, status, error, title_id, started_at, finished_at, input_json FROM actions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...args, i.limit ?? 30);
	},
	toText: (o: any[]) => o.map((a) => `${a.id} | ${a.started_at.slice(0, 16)} | ${a.status} | ${a.op} | ${a.actor}${a.title_id ? ` | ${a.title_id}` : ""}${a.error ? ` | ${a.error}` : ""}`).join("\n") || "No activity yet.",
});

defineOperation({
	name: "download.file",
	summary: "File a completed download now (code plan; problems are reported, not guessed)",
	effect: "write",
	input: Type.Object({ hash: Type.String() }),
	positional: ["hash"],
	async run(ctx, i) {
		return fileDownload(ctx.app, resolveHash(ctx, i.hash));
	},
	toText: (o: any) => (o.filed ? `Filed:\n${planToText(o.plan, o.results)}` : `Not filed. Problems:\n- ${o.problems.join("\n- ")}${o.plan.items.length ? `\nPartial plan:\n${planToText(o.plan, o.results)}` : ""}`),
});

defineOperation({
	name: "config.get",
	summary: "Read one setting by dotted path (or all settings)",
	effect: "read",
	input: Type.Object({ path: Type.Optional(Type.String()) }),
	positional: ["path"],
	async run(ctx, i) {
		return { path: i.path ?? "(all)", value: i.path ? getPath(ctx.app.config, i.path) : ctx.app.config };
	},
	toText: (o: any) => `${o.path} = ${JSON.stringify(o.value, null, 1)}`,
});
