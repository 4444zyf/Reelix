import { Type } from "typebox";
import { getPath, KNOWN_SECRETS, configChange, describeConfig } from "../config.ts";
import { consumeApproval } from "../approvals.ts";
import { checksToText, doctor } from "../doctor.ts";
import { DOWNLOADER, MARK, downloaderOf } from "../downloader.ts";
import { addDownload, downloadLine, fileDownload, getDownload, listDownloads, markFiled, reconcileAdd, setDownloadState } from "../downloads.ts";
import { MEDIA_SERVER, tellMediaServer } from "../media-server.ts";
import { type EnrichResult, enrichTitle } from "../metadata.ts";
import { type Survey, decidedText, folderLabel, foldersOf, libraryFolderFor, setLibraryChoice, surveyLibraryFolders, whenText } from "../library-folders.ts";
import { mediaClassOf } from "../naming.ts";
import { haveInLibrary, libraryOverview, listRemoved, mediaFolders, removeFromLibrary, restoreRemoved, titleFiles } from "../library.ts";
import { applyPlan, checkWrittenItems, plannedByReelix, planToText, type Plan } from "../organiser.ts";
import { grabFrame, probe, probeToText } from "../probe.ts";
import { defineOperation } from "../registry.ts";
import { describeFiles, fetchRelease, getHandle, searchReleases, searchToText } from "../releases.ts";
import { addTitleNote, createLocalTitle, fetchTitle, findTitle, linkBangumi, linkDouban, requireTitle, titleSummary, type Title } from "../titles.ts";
import { libraryPlayLinks, playTarget, playTargetText } from "../playback.ts";
import { trendingTitles } from "../trends.ts";
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
		return i.path ? { path: i.path, value: getPath(ctx.app.config, i.path) } : { summary: describeConfig(ctx.app), config: ctx.app.config, warning: ctx.app.configWarning };
	},
	toText: (o: any) => (o.summary ? o.summary + (o.warning ? `\nWARNING: ${o.warning}` : "") : `${o.path} = ${JSON.stringify(o.value, null, 1)}`),
});

defineOperation({
	name: "config.set",
	summary: "Change a setting in config.yaml (validated, recorded)",
	effect: "admin",
	agentMay: true,
	input: Type.Object({ path: Type.String({ description: "dotted path, e.g. library.movies" }), value: Type.Unknown({ description: "the new value (any JSON); a string is parsed as JSON if it can be; empty string unsets" }) }),
	positional: ["path", "value"],
	async run(ctx, i) {
		const { value, needsOwner } = configChange(ctx.app, i);
		if (needsOwner && !ctx.actor.startsWith("owner:") && !consumeApproval(ctx.app, "config.set", i, ctx.actor)) {
			throw new ReelixError("owner_only", `"${i.path}" is the owner's to change: it decides where Reelix connects, or it is one of your own limits. Use the reelix tool with command=config.set (not the shell): Reelix then asks the owner to confirm. The owner can also change it in Settings.`);
		}
		const before = getPath(ctx.app.config, i.path);
		ctx.app.setConfig(i.path, value);
		return { path: i.path, before, after: getPath(ctx.app.config, i.path) };
	},
	toText: (o: any) => `${o.path}: ${JSON.stringify(o.before)} → ${JSON.stringify(o.after)}`,
});

defineOperation({
	name: "secret.set",
	summary: "Store a password or API key in secrets.yaml (owner only; the value never enters chat)",
	effect: "admin",
	input: Type.Object({ key: Type.String(), value: Type.String() }),
	positional: ["key"],
	recordInput: (i) => ({ key: i.key, value: "[secret]" }),
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
		// A plugin's secrets are named by the plugin; their labels come from its strings.
		const declared = ctx.app.plugins?.list().flatMap((p) => p.secrets) ?? [];
		const names = new Set([...Object.keys(KNOWN_SECRETS), ...declared, ...Object.keys(ctx.app.secrets)]);
		return [...names].sort().map((k) => ({ key: k, what: KNOWN_SECRETS[k] ?? ctx.app.plugins?.secretLabel(k) ?? "", set: !!ctx.app.secrets[k] }));
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
	name: "title.trending",
	summary: "What is trending on TMDB today or this week (films, shows or both), marking titles already in the library",
	effect: "read",
	tool: "title_trending",
	input: Type.Object({
		kind: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("movie"), Type.Literal("tv")])),
		window: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("week")], { description: "default week" })),
	}),
	async run(ctx, i) {
		return { items: await trendingTitles(ctx.app, i.kind ?? "all", i.window ?? "week") };
	},
	toText: (o: any) => o.items.map((x: any) => `${x.id} | ${x.name} | ${x.year ?? "?"}${x.rating ? ` | ${x.rating.toFixed(1)}` : ""}${x.in_library ? " | in library" : ""}`).join("\n") || "Nothing trending.",
});

defineOperation({
	name: "title.play",
	summary: "Links that open a library title in the owner's player (Infuse, Swiftfin, Jellyfin): the next episode to watch unless a season or episode is given",
	description: "When the owner says they want to watch something that is in the library, put it in front of them with the show tool, kind=play. Nothing starts on its own: the owner taps.",
	effect: "read",
	tool: "title_play",
	input: Type.Object({ id: Type.String(), season: Type.Optional(Type.Integer({ minimum: 0 })), episode: Type.Optional(Type.Integer({ minimum: 0 })) }),
	positional: ["id"],
	run: (ctx, i) => playTarget(ctx.app, i.id, { season: i.season, episode: i.episode }),
	toText: (o: any) => playTargetText(o),
});

defineOperation({
	name: "library.play_links",
	summary: "Player links for every title in the library",
	effect: "read",
	input: Type.Object({}),
	run: (ctx) => libraryPlayLinks(ctx.app),
	toText: (o: any) => `${Object.keys(o.targets).length} titles`,
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
		const folders = foldersOf(ctx.app, mediaClassOf(t));
		const decided = folders.length ? libraryFolderFor(ctx.app, t) : undefined;
		const library = { folders: folders.map((f) => ({ path: f.path, name: folderLabel(f), default: !!f.default })), choice: t.library_choice, decided: decided && "folder" in decided ? { path: decided.folder.path, how: decided.how, rule: decided.rule, text: decidedText(decided) } : null };
		return { title: t, have: haveInLibrary(ctx.app, t), files, downloads, follows, library };
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
	name: "title.library_folder.set",
	summary: "Choose the library folder a title goes to, before it is filed (when its media type has several folders)",
	description: "folder: a folder's path or name from Settings → Paths; empty clears the choice. A title already in the library stays where it is.",
	effect: "write",
	input: Type.Object({ id: Type.String(), folder: Type.String() }),
	positional: ["id", "folder"],
	async run(ctx, i) {
		return setLibraryChoice(ctx.app, requireTitle(ctx.app, i.id), i.folder);
	},
	toText: (o: any) => (o.folder ? `${o.title} goes to ${o.folder}` : `${o.title}: choice cleared`),
	titleOf: (i) => i.id,
});

defineOperation({
	name: "title.enrich",
	summary: "Ask the metadata sources (such as Douban) for a title's ratings and record them; TMDB stays the title's identity",
	effect: "write",
	input: Type.Object({ id: Type.String(), sources: Type.Optional(Type.Array(Type.String(), { description: "only these sources (provider ids)" })) }),
	positional: ["id"],
	run: (ctx, i) => enrichTitle(ctx.app, i.id, i.sources),
	toText: (o: EnrichResult) => `${o.title}\n${o.results.map((r) => `${r.label}: ${r.rating ? `${r.rating.value}/${r.rating.scale}` : r.note}`).join("\n") || "No metadata source is running."}`,
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
	summary: "Search the indexers for a title; a compact paged list with handles",
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
	summary: "Add a chosen release to the downloader for a known title, recording why",
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
		allow_hidden: Type.Optional(Type.Boolean({ description: "take a release a plugin hid; only when the owner said so: Reelix asks them to confirm" })),
	}),
	positional: ["handle"],
	async run(ctx, i) {
		return addDownload(ctx.app, i, ctx);
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

/** A download's hash from the hash or its start: at least 6 hex characters (so nothing in it is a LIKE wildcard), matching one download. */
function resolveHash(ctx: { app: import("../app.ts").Reelix }, h: string): string {
	const given = h.toLowerCase();
	if (!/^[0-9a-f]{6,64}$/.test(given)) throw new ReelixError("invalid_input", `"${h}" is not a hash: give at least its first 6 characters (0-9, a-f).`);
	const rows = ctx.app.db.prepare("SELECT hash FROM downloads WHERE hash LIKE ? LIMIT 2").all(`${given}%`) as { hash: string }[];
	if (rows.length > 1) throw new ReelixError("invalid_input", `More than one download starts with "${h}": give more of the hash.`);
	return rows[0]?.hash ?? given;
}

defineOperation({
	name: "download.pause",
	summary: "Pause a download",
	effect: "write",
	input: Type.Object({ hash: Type.String() }),
	positional: ["hash"],
	async run(ctx, i) {
		const h = resolveHash(ctx, i.hash);
		await downloaderOf(ctx.app, getDownload(ctx.app, h)).call("stop", [[h]]);
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
		await downloaderOf(ctx.app, getDownload(ctx.app, h)).call("start", [[h]]);
		return { hash: h, resumed: true };
	},
	toText: (o: any) => `Resumed ${o.hash.slice(0, 10)}.`,
});

defineOperation({
	name: "download.remove",
	summary: "Remove a torrent from the downloader, optionally with its data",
	effect: "destructive",
	input: Type.Object({ hash: Type.String(), delete_data: Type.Boolean({ default: false }) }),
	positional: ["hash"],
	async preview(ctx, i) {
		const h = resolveHash(ctx, i.hash);
		const row = getDownload(ctx.app, h);
		const live = await downloaderOf(ctx.app, row).call("get", [h]);
		const name = live?.name ?? row?.name ?? h;
		const size = live?.size ?? row?.size ?? undefined;
		const sized = size ? ` (${humanBytes(size)})` : "";
		return {
			text: i.delete_data ? `Remove the torrent ${name}${sized} and delete its files` : `Remove the torrent ${name}${sized}; its files stay on disk`,
			// Gone from the downloader, or a different torrent under the same name: the step no longer applies.
			target: { hash: h, present: !!live, name, size: size ?? null, delete_data: i.delete_data },
			counts: { downloads: 1, ...(i.delete_data && size ? { bytes: size } : {}) },
		};
	},
	async run(ctx, i) {
		const h = resolveHash(ctx, i.hash);
		await downloaderOf(ctx.app, getDownload(ctx.app, h)).call("remove", [[h], { deleteFiles: i.delete_data }]);
		setDownloadState(ctx.app, h, "removed", i.delete_data ? "removed with data" : "removed, data kept");
		return { hash: h, data_deleted: i.delete_data };
	},
	reconcile: async (ctx, i) => {
		const h = resolveHash(ctx, i.hash);
		return (await downloaderOf(ctx.app, getDownload(ctx.app, h)).call("get", [h])) ? { status: "failed" } : { status: "succeeded" };
	},
	toText: (o: any) => `Removed torrent ${o.hash.slice(0, 10)}${o.data_deleted ? " and deleted its data" : "; its data is still on disk"}.`,
});

defineOperation({
	name: "download.adopt",
	summary: "Take an existing torrent in the downloader under Reelix's care for a title",
	effect: "write",
	input: Type.Object({ hash: Type.String(), title_id: Type.String(), episodes: Type.Optional(Type.Array(Episode)), reason: Type.Optional(Type.String()) }),
	positional: ["hash", "title_id"],
	async run(ctx, i) {
		const d = downloaderOf(ctx.app, undefined);
		const t = await d.call("get", [i.hash.toLowerCase()]);
		if (!t) throw new ReelixError("not_found", `${d.label} has no torrent ${i.hash}.`);
		const title = requireTitle(ctx.app, i.title_id);
		await d.call("addMark", [[t.id], MARK]);
		ctx.app.db
			.prepare(`INSERT INTO downloads (hash, title_id, name, episodes_json, release_json, reason, state, progress, size, added_at, last_progress_at, downloader) VALUES (?, ?, ?, ?, ?, ?, 'downloading', ?, ?, datetime('now'), datetime('now'), ?)
			 ON CONFLICT(hash) DO UPDATE SET title_id = excluded.title_id, episodes_json = excluded.episodes_json, downloader = excluded.downloader, state = CASE WHEN downloads.state = 'filed' THEN 'filed' ELSE 'downloading' END`)
			.run(t.id, title.id, t.name, JSON.stringify(i.episodes ?? []), JSON.stringify({ title: t.name, adopted: true }), i.reason ?? "adopted", t.progress, t.size, d.id);
		return { hash: t.id, name: t.name, title: title.id, progress: t.progress };
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
		if (i.items?.length) {
			checkWrittenItems(app, titleId ? requireTitle(app, titleId) : undefined, i.items);
			plan = { title_id: titleId, download_hash: hash, items: i.items };
		} else if (hash && i.mode === "plan" && !i.path) {
			const r = await fileDownload(app, hash, { apply: false });
			plan = r.plan;
			problems = r.problems;
		} else {
			if (!titleId) throw new ReelixError("invalid_input", "Give a hash of a Reelix download, or title_id with path.");
			const title = requireTitle(app, titleId);
			const path = i.path ?? d?.content_path;
			if (!path) throw new ReelixError("invalid_input", "No path: give path=, or a hash of a completed download.");
			const r = await plannedByReelix(app, title, path, { hash, version: i.version, seasonHint: i.season, wanted: d ? JSON.parse(d.episodes_json) : undefined });
			plan = r.plan;
			problems = r.problems;
		}
		if (i.mode === "plan") return { mode: "plan", plan, problems };
		if (!plan.items.length) throw new ReelixError("empty_plan", `Nothing to apply.${problems.length ? ` Problems: ${problems.join("; ")}` : ""}`);
		const results = applyPlan(app, plan);
		const ok = results.every((r) => r.status === "linked" || r.status === "already");
		if (ok && hash) await markFiled(app, hash, titleId, plan, "download");
		else if (ok && titleId) {
			await tellMediaServer(app, plan.items.map((x) => x.dest)).catch(() => {});
			app.pluginEvents.emit("download.filed", { titleId, paths: plan.items.map((x) => x.dest), via: "organise" });
		}
		return { mode: "apply", plan, results, ok };
	},
	reconcile: async () => ({ status: "succeeded" }), // apply is idempotent: re-running yields "already"
	toText: (o: any) => (o.mode === "plan" ? `Plan (${o.plan.items.length} items):\n${planToText(o.plan)}${o.problems.length ? `\nProblems:\n- ${o.problems.join("\n- ")}` : "\nNo problems: safe to apply."}` : `${o.ok ? "Applied" : "Applied with failures"}:\n${planToText(o.plan, o.results)}`),
	titleOf: (i) => i.title_id,
});

// ------------------------------------------------------------------ library

defineOperation({
	name: "media.folders",
	summary: "List the folders directly inside a folder of the media folder (for choosing the download and library folders)",
	effect: "read",
	input: Type.Object({ path: Type.Optional(Type.String({ description: "a folder inside media_root; default media_root itself" })) }),
	positional: ["path"],
	async run(ctx, i) {
		return mediaFolders(ctx.app, i.path);
	},
	toText: (o: any) => `${o.path}${o.parent ? ` (up: ${o.parent})` : ""}\n${o.folders.map((f: any) => `  ${f.name}/`).join("\n") || "  (no folders)"}${o.truncated ? "\n  …" : ""}`,
});

defineOperation({
	name: "library.folders.survey",
	summary: "What each library folder holds, with the language, countries and genres of its titles, and the titles the current rules would put elsewhere",
	description: "For learning how the owner sorts titles into folders (skill library-folders). Reads TMDB for titles it does not know yet, up to 200 per call; call again for the rest.",
	effect: "read",
	input: Type.Object({ type: Type.Optional(Type.Union([Type.Literal("movies"), Type.Literal("shows"), Type.Literal("anime")])) }),
	positional: ["type"],
	async run(ctx, i) {
		return surveyLibraryFolders(ctx.app, i.type);
	},
	toText: (o: Survey) => {
		const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(", ") || "-";
		const folders = o.folders.map((f) => `${f.type}: ${f.name}${f.default ? " [default]" : ""} — ${f.path}\n  ${f.titles.length} titles, ${f.untagged.length} untagged\n  languages: ${top(f.counts.original_language)}\n  countries: ${top(f.counts.origin_country)}\n  genres: ${top(f.counts.genre)}${f.rules.length ? `\n  rules: ${f.rules.map((r) => whenText(r.when)).join("; ")}` : ""}`);
		const misfits = o.misfits.length ? `\nThe rules would put elsewhere (${o.misfits.length}):\n${o.misfits.slice(0, 40).map((m) => `  ${m.name}: in ${m.in}, rules say ${m.rules_say ?? "nothing"}`).join("\n")}` : "\nThe rules put every identified title where it is.";
		return `${folders.join("\n") || "No library folders."}${misfits}${o.unread ? `\n${o.unread} titles not read from TMDB yet; call again.` : ""}`;
	},
});

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

// ------------------------------------------------------------------ the downloader (docs/plugins.md §7.5)

/** The providers of a seam of the kind "one of several", and the owner's choice among them. */
type ProviderChoice = { active: string; running: boolean; providers: { id: string; label: string; plugin: string }[] };

defineOperation({
	name: "download.downloaders",
	summary: "The downloaders this Reelix can use and the active one, which only the owner chooses (config downloader)",
	effect: "read",
	input: Type.Object({}),
	async run(ctx): Promise<ProviderChoice> {
		const providers = ctx.app.seams.providers(DOWNLOADER).map((p) => ({ id: p.id, label: p.label, plugin: p.plugin }));
		return { active: ctx.app.config.downloader, running: providers.some((p) => p.id === ctx.app.config.downloader), providers };
	},
	toText: (o: ProviderChoice) => `Active: ${o.active}${o.running ? "" : " (not running)"}\n${o.providers.map((p) => `${p.id} | ${p.label} | plugin ${p.plugin}`).join("\n") || "No downloader is running."}`,
});

// ------------------------------------------------------------------ the media server (docs/plugins.md §7.7)

defineOperation({
	name: "library.media_servers",
	summary: "The media servers this Reelix can use and the active one, which only the owner chooses (config media_server)",
	effect: "read",
	input: Type.Object({}),
	async run(ctx): Promise<ProviderChoice> {
		const providers = ctx.app.seams.providers(MEDIA_SERVER).map((p) => ({ id: p.id, label: p.label, plugin: p.plugin }));
		return { active: ctx.app.config.media_server, running: providers.some((p) => p.id === ctx.app.config.media_server), providers };
	},
	toText: (o: ProviderChoice) => `Active: ${o.active}${o.running ? "" : " (not running or not set up)"}\n${o.providers.map((p) => `${p.id} | ${p.label} | plugin ${p.plugin}`).join("\n") || "No media server is running."}`,
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
