import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Reelix } from "./app.ts";
import { type MediaClass, type TitleLike, episodeRelPath, folderName, libraryPathProblem, mediaClassOf, movieRelPath, subtitlePathFor } from "./naming.ts";
import { outsideLine } from "@reelix/plugin";
import { parseReleaseName } from "./parser.ts";
import { type ReasonInput, replaceReasons } from "./reasons.ts";
import { parsedFacts } from "./releases.ts";
import type { Title } from "./titles.ts";
import { AUDIO_EXT, SUB_EXT, VIDEO_EXT, isDiscStructure } from "./torrent.ts";
import { ReelixError, nowIso } from "./util.ts";

export type PlanItem = {
	source: string; // absolute, inside the download folder
	dest: string; // absolute, inside the library
	kind: "video" | "subtitle" | "extra" | "audio" | "disc";
	reason?: string;
	episodes?: { season: number; episode: number }[];
	version?: string;
};

export type Plan = {
	title_id?: string;
	download_hash?: string;
	items: PlanItem[];
	notes?: string[];
};

export type ApplyItemResult = { source: string; dest: string; status: "linked" | "already" | "conflict" | "failed"; error?: string };

// ------------------------------------------------------------------ roots

export function libraryRoots(app: Reelix): Record<MediaClass, string | undefined> {
	return { movie: app.config.library.movies, show: app.config.library.shows, anime: app.config.library.anime };
}

export function libraryRootFor(app: Reelix, cls: MediaClass): string {
	const root = libraryRoots(app)[cls] ?? (cls === "anime" ? app.config.library.shows : undefined);
	if (!root) throw new ReelixError("not_configured", `No library folder for ${cls === "movie" ? "movies" : cls === "anime" ? "anime" : "shows"} is set (config library.${cls === "movie" ? "movies" : cls === "anime" ? "anime" : "shows"}).`);
	return root;
}

function within(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

function realOrResolved(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		// destination may not exist yet: resolve its nearest existing parent
		const parent = dirname(p);
		if (parent === p) return p;
		return join(realOrResolved(parent), basename(p));
	}
}

// ------------------------------------------------------------------ link errors

export function explainLinkError(e: NodeJS.ErrnoException, source: string, dest: string): string {
	switch (e.code) {
		case "EXDEV":
			return `Cannot hard-link across mounts or shared folders: "${source}" and "${dest}" are on different mounted filesystems (or different Synology shared folders/btrfs subvolumes). Downloads and library must be under one mount. Run \`reelix doctor\`.`;
		case "EPERM":
		case "EACCES":
			return `Permission refused linking "${source}". Linux only lets a user hard-link a file it owns or can write (fs.protected_hardlinks). Run Reelix with the same user and group IDs as the downloader.`;
		case "EMLINK":
			return `"${source}" already has the maximum number of hard links this filesystem allows.`;
		case "ENOTSUP":
		case "EOPNOTSUPP":
			return `This filesystem does not support hard links (${dest}).`;
		case "ENOENT":
			return `Source file is missing: "${source}". It may have been moved by the downloader or deleted.`;
		case "EROFS":
			return `The library is mounted read-only (${dest}).`;
		case "ENOSPC":
			return `No space left to create the directory entry for ${dest}.`;
		default:
			return `Linking failed (${e.code ?? "error"}): ${e.message}`;
	}
}

// ------------------------------------------------------------------ apply

/**
 * Apply a plan: the only code that hard-links into the library (§5.4).
 * - sources inside the download folder, destinations inside the library;
 * - link directly at the destination, never replacing an existing file;
 * - an existing destination that is the same file is done; a different file is a conflict;
 * - no fallback to copying; applying twice changes nothing.
 */
export function applyPlan(app: Reelix, plan: Plan): ApplyItemResult[] {
	const downloads = app.config.downloads;
	if (!downloads) throw new ReelixError("not_configured", "The download folder is not set (config downloads).");
	const downloadsReal = realOrResolved(downloads);
	const roots = Object.values(libraryRoots(app)).filter(Boolean).map((r) => realOrResolved(r!));
	if (!roots.length) throw new ReelixError("not_configured", "No library folders are set (config library.*).");

	const results: ApplyItemResult[] = [];
	for (const item of plan.items) {
		const src = realOrResolved(resolve(item.source));
		const dest = realOrResolved(resolve(item.dest));
		if (!within(src, downloadsReal)) {
			results.push({ source: item.source, dest: item.dest, status: "failed", error: `Source is outside the download folder (${downloads}).` });
			continue;
		}
		if (!roots.some((r) => within(dest, r) && dest !== r)) {
			results.push({ source: item.source, dest: item.dest, status: "failed", error: "Destination is outside the library folders." });
			continue;
		}
		if (basename(dest).startsWith(".") || /(^|\/)\.reelix-trash(\/|$)/.test(dest)) {
			results.push({ source: item.source, dest: item.dest, status: "failed", error: "Destination name is not allowed." });
			continue;
		}
		let st;
		try {
			st = statSync(src);
		} catch (e) {
			results.push({ source: item.source, dest: item.dest, status: "failed", error: explainLinkError(e as NodeJS.ErrnoException, item.source, item.dest) });
			continue;
		}
		if (st.isDirectory()) {
			// Disc folders (BDMV / VIDEO_TS) are linked whole, file by file.
			const sub = linkTree(src, dest);
			const bad = sub.find((r) => r.status === "failed" || r.status === "conflict");
			results.push({ source: item.source, dest: item.dest, status: bad ? bad.status : sub.every((r) => r.status === "already") ? "already" : "linked", error: bad?.error });
		} else {
			results.push({ source: item.source, dest: item.dest, ...linkOne(src, dest) });
		}
	}
	recordApplied(app, plan, results);
	return results;
}

function linkOne(src: string, dest: string): { status: ApplyItemResult["status"]; error?: string } {
	try {
		mkdirSync(dirname(dest), { recursive: true });
	} catch (e) {
		return { status: "failed", error: explainLinkError(e as NodeJS.ErrnoException, src, dest) };
	}
	try {
		linkSync(src, dest); // fails with EEXIST rather than replacing anything
		return { status: "linked" };
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "EEXIST") {
			try {
				const a = statSync(src);
				const b = lstatSync(dest);
				if (a.dev === b.dev && a.ino === b.ino) return { status: "already" };
				return { status: "conflict", error: `A different file already exists at "${dest}".` };
			} catch (e2) {
				return { status: "failed", error: (e2 as Error).message };
			}
		}
		return { status: "failed", error: explainLinkError(err, src, dest) };
	}
}

function linkTree(srcDir: string, destDir: string): { status: ApplyItemResult["status"]; error?: string }[] {
	const out: { status: ApplyItemResult["status"]; error?: string }[] = [];
	for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
		if (ignoredName(ent.name)) continue;
		const s = join(srcDir, ent.name);
		const d = join(destDir, ent.name);
		if (ent.isDirectory()) out.push(...linkTree(s, d));
		else if (ent.isFile()) out.push(linkOne(s, d));
	}
	return out;
}

function recordApplied(app: Reelix, plan: Plan, results: ApplyItemResult[]): void {
	const ins = app.db.prepare(
		`INSERT INTO files (title_id, download_hash, source, dest, kind, version_label, linked, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
		 ON CONFLICT(dest) DO UPDATE SET source = excluded.source, title_id = COALESCE(excluded.title_id, files.title_id), download_hash = COALESCE(excluded.download_hash, files.download_hash)`,
	);
	const fid = app.db.prepare("SELECT id FROM files WHERE dest = ?");
	const ep = app.db.prepare("INSERT OR IGNORE INTO file_episodes (file_id, season, episode) VALUES (?, ?, ?)");
	plan.items.forEach((item, i) => {
		const r = results[i]!;
		if (r.status !== "linked" && r.status !== "already") return;
		ins.run(plan.title_id ?? null, plan.download_hash ?? null, item.source, item.dest, item.kind, item.version ?? null, nowIso());
		const id = (fid.get(item.dest) as { id: number }).id;
		for (const e of item.episodes ?? []) ep.run(id, e.season, e.episode);
	});
}

// ------------------------------------------------------------------ code planning (no model)

export function ignoredName(name: string): boolean {
	return name === "@eaDir" || name === "#recycle" || name === ".DS_Store" || name === "Thumbs.db" || name.endsWith(".!qB") || name.endsWith(".parts") || name.endsWith(".part") || name.startsWith("._");
}

export function listFilesRecursive(root: string, limit = 5000): { path: string; size: number }[] {
	const out: { path: string; size: number }[] = [];
	const st = statSync(root);
	if (st.isFile()) return [{ path: root, size: st.size }];
	const walk = (dir: string, depth: number) => {
		if (depth > 8 || out.length >= limit) return;
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (ignoredName(ent.name)) continue;
			const p = join(dir, ent.name);
			if (ent.isDirectory()) walk(p, depth + 1);
			else if (ent.isFile()) out.push({ path: p, size: statSync(p).size });
		}
	};
	walk(root, 0);
	return out;
}

export function isSample(path: string, size: number, largest: number): boolean {
	const n = basename(path).toLowerCase();
	if (/(^|[\s.\-_[(])(sample|trailer|teaser|preview|promo)([\s.\-_\])]|$)/.test(n) || /\/samples?\//i.test(path)) return true;
	return largest > 0 && size < largest * 0.08 && size < 300 * 1024 * 1024;
}

const LANG_HINTS: [RegExp, string][] = [
	[/(简英|chs[&.+_-]?eng|zh-hans.*en|双语)/i, "zh"],
	[/(简体|简中|chs|zh-?cn|zh-hans|\bsc\b|gb)/i, "zh"],
	[/(繁体|繁中|cht|zh-?tw|zh-hk|zh-hant|\btc\b|big5)/i, "zh-TW"],
	[/(\beng?\b|english)/i, "en"],
	[/(\bjpn?\b|japanese|日)/i, "ja"],
];

export function guessSubLang(name: string): string {
	for (const [re, lang] of LANG_HINTS) if (re.test(name)) return lang;
	return "und";
}

export type AutoPlanResult = { plan: Plan; problems: string[] };

/**
 * Plan routine downloads by code (§5.4): a single film file, or cleanly numbered episodes.
 * Anything unexpected is listed in `problems`, and the caller hands the case to the agent.
 */
export function autoPlan(
	app: Reelix,
	title: TitleLike & { id: string; runtime_min?: number | null },
	contentPath: string,
	opts: { wanted?: { season: number; episode: number }[]; hash?: string; version?: string; seasonHint?: number; resolveAbsolute?: (n: number, hintSeason?: number) => { season: number; episode: number; how: string } | undefined } = {},
): AutoPlanResult {
	const problems: string[] = [];
	const cls = mediaClassOf(title);
	const root = libraryRootFor(app, cls);
	const plan: Plan = { title_id: title.id, download_hash: opts.hash, items: [] };
	if (!existsSync(contentPath)) return { plan, problems: [`Content path does not exist: ${contentPath}`] };

	const files = listFilesRecursive(contentPath);
	const disc = isDiscStructure(files.map((f) => ({ path: relative(contentPath, f.path) })));
	if (disc) {
		if (title.kind !== "movie") return { plan, problems: ["A disc structure in a TV download needs a decision on how to file it."] };
		const discRoot = statSync(contentPath).isDirectory() ? contentPath : dirname(contentPath);
		// The disc tree lands inside the title folder; disc folders cannot have versions or external subtitles.
		plan.items.push({ source: discRoot, dest: join(root, folderName(title)), kind: "disc", reason: `${disc.toUpperCase()} disc folder, linked whole` });
		return { plan, problems };
	}

	if (files.some((f) => /\.(rar|r\d\d)$/i.test(f.path)) && !files.some((f) => VIDEO_EXT.test(f.path))) {
		return { plan, problems: ["The release is RAR-packed; it cannot be hard-linked. Unpacking needs the owner's consent (decision I)."] };
	}

	const videos = files.filter((f) => VIDEO_EXT.test(f.path) && !/\.iso$/i.test(f.path));
	const largest = Math.max(0, ...videos.map((v) => v.size));
	const main = videos.filter((v) => !isSample(v.path, v.size, largest));
	if (!main.length) return { plan, problems: ["No video files found."] };
	if (files.some((f) => /\.iso$/i.test(f.path))) problems.push("Contains an ISO image.");

	const sidecars = files.filter((f) => SUB_EXT.test(f.path) || AUDIO_EXT.test(f.path));
	const extrasDir = (p: string) => /\/(extras?|featurettes?|behind the scenes|deleted scenes|interviews?|specials?|sps?|bonus|花絮|特典|映像特典|menu|cms?|pvs?)\//i.test("/" + relative(contentPath, p));

	const addSidecars = (videoSrc: string, videoDest: string) => {
		const vbase = basename(videoSrc, extname(videoSrc));
		for (const s of sidecars) {
			const sb = basename(s.path);
			const sameDir = dirname(s.path) === dirname(videoSrc);
			const inSubsDir = /\/(subs?|subtitles?|字幕)\//i.test(s.path) && main.length === 1;
			if (!(sameDir && sb.startsWith(vbase)) && !inSubsDir && !(sameDir && main.length === 1)) continue;
			const ext = extname(sb);
			const rest = sb.slice(vbase.length, sb.length - ext.length).replace(/^[.\s_-]+/, "");
			if (SUB_EXT.test(sb)) {
				const lang = guessSubLang(rest || sb);
				const label = rest && !/^(chs|cht|eng?|sc|tc|zh[-a-z]*|en|ja|jpn?)$/i.test(rest) ? rest.replace(/\.(chs|cht|eng?|sc|tc)$/i, "") : undefined;
				plan.items.push({ source: s.path, dest: subtitlePathFor(videoDest, lang, ext, { label: label && label !== lang ? label : undefined }), kind: "subtitle", reason: "shipped next to the video" });
			} else plan.items.push({ source: s.path, dest: videoDest.slice(0, -extname(videoDest).length) + (rest ? `.${rest}` : "") + ext, kind: "audio", reason: "separate audio track shipped next to the video" });
		}
	};

	if (title.kind === "movie") {
		const features = main.filter((v) => !extrasDir(v.path));
		if (features.length !== 1) {
			problems.push(features.length > 1 ? `${features.length} candidate feature files (versions, parts or extras?): ${features.map((f) => basename(f.path)).join(", ")}` : "No feature file outside extras folders.");
			return { plan, problems };
		}
		const v = features[0]!;
		if (/\b(cd|disc|part|pt)[\s._-]?\d\b/i.test(basename(v.path))) problems.push("Looks like a multi-part file.");
		const p = parseReleaseName(basename(v.path));
		const version = opts.version ?? p.resolution;
		const dest = join(root, movieRelPath(title, extname(v.path), version));
		plan.items.push({ source: v.path, dest, kind: "video", reason: "the film", version });
		addSidecars(v.path, dest);
		for (const x of main.filter((m) => extrasDir(m.path))) {
			plan.items.push({ source: x.path, dest: join(dirname(dest), "extras", basename(x.path)), kind: "extra", reason: "in an extras folder" });
		}
		return { plan, problems };
	}

	// TV / anime
	const wantedSet = opts.wanted?.length ? new Set(opts.wanted.map((w) => `${w.season}:${w.episode}`)) : undefined;
	const seen = new Map<string, string>();
	for (const v of main) {
		if (extrasDir(v.path)) {
			problems.push(`Extra or special: ${basename(v.path)}`);
			continue;
		}
		const p = parseReleaseName(basename(v.path));
		let season = p.season ?? opts.seasonHint ?? (opts.wanted?.length ? opts.wanted[0]!.season : undefined);
		if (season === undefined) {
			const dirP = parseReleaseName(basename(dirname(v.path)));
			season = dirP.season;
		}
		let how = "from the file name";
		let eps = p.episodes ?? [];
		if (p.absolute && p.season === undefined && opts.resolveAbsolute && eps.length) {
			// Anime: Bangumi mapping, else the wanted season, else cumulative TMDB seasons.
			const mapped = eps.map((n) => opts.resolveAbsolute!(n, opts.seasonHint ?? opts.wanted?.[0]?.season));
			if (mapped.every(Boolean) && new Set(mapped.map((m) => m!.season)).size === 1) {
				season = mapped[0]!.season;
				eps = mapped.map((m) => m!.episode);
				how = `absolute ${p.episodes!.join(",")} via ${mapped[0]!.how}`;
			} else {
				problems.push(`Absolute episode numbering in ${basename(v.path)} could not be placed in one season.`);
				continue;
			}
		} else if (p.absolute && p.season === undefined && !opts.seasonHint && !opts.wanted?.length) {
			problems.push(`Absolute episode numbering in ${basename(v.path)}; needs the season mapping.`);
			continue;
		}
		if (!eps.length || season === undefined) {
			problems.push(`Cannot tell the episode of ${basename(v.path)}`);
			continue;
		}
		const key = `${season}:${eps.join(",")}`;
		if (seen.has(key)) {
			problems.push(`Two files claim ${key}: ${seen.get(key)} and ${basename(v.path)}`);
			continue;
		}
		seen.set(key, basename(v.path));
		if (wantedSet && !eps.some((e) => wantedSet.has(`${season}:${e}`))) continue; // not wanted from this pack
		const dest = join(root, episodeRelPath(title, season, eps, extname(v.path), opts.version));
		plan.items.push({ source: v.path, dest, kind: "video", reason: `S${season} E${eps.join(",")} ${how}`, episodes: eps.map((e) => ({ season: season!, episode: e })) });
		addSidecars(v.path, dest);
	}
	if (wantedSet) {
		const got = new Set(plan.items.flatMap((i) => i.episodes ?? []).map((e) => `${e.season}:${e.episode}`));
		const missing = [...wantedSet].filter((w) => !got.has(w));
		if (missing.length) problems.push(`Wanted episodes not found in the download: ${missing.map((m) => m.replace(":", "x")).join(", ")}`);
	}
	if (!plan.items.some((i) => i.kind === "video")) problems.push("Nothing to file.");
	return { plan, problems };
}

type PlanOptions = Parameters<typeof autoPlan>[3];

/** The plan Reelix makes itself, after the plugins of `organise.name` had their say (docs/plugins.md §8). */
export async function plannedByReelix(app: Reelix, title: Title, contentPath: string, opts: PlanOptions = {}): Promise<AutoPlanResult> {
	const result = autoPlan(app, title, contentPath, opts);
	const { plan } = result;
	if (!plan.items.length || !app.hooks.has("organise.name@1")) return result;
	const root = libraryRootFor(app, mediaClassOf(title));
	const reasons: ReasonInput[] = [];
	const named = await app.hooks.pipeline(
		"organise.name@1",
		{
			title: { id: title.id, name: title.name, kind: title.kind, mediaClass: title.media_class, year: title.year ?? undefined, tmdbId: title.tmdb_id ?? undefined },
			items: plan.items.map((i) => ({ source: i.source, path: relative(root, i.dest), kind: i.kind, parsed: parsedFacts(parseReleaseName(basename(i.source))) })),
		},
		(value, item, plugin) => {
			const changed = new Map(item.items.map((c) => [c.source, c.path]));
			for (const i of value.items) if (changed.has(i.source) && changed.get(i.source) !== i.path) reasons.push({ kind: "renamed", plugin, reason: item.reason, detail: { from: i.path, to: changed.get(i.source) } });
			return { ...value, items: value.items.map((i) => ({ ...i, path: changed.get(i.source) ?? i.path })) };
		},
	);
	plan.items.forEach((item, n) => {
		const path = named.items[n]!.path;
		const by = reasons.filter((r) => r.detail!.to === path);
		item.dest = join(root, path);
		if (by.length) item.reason = [item.reason, ...by.map((r) => `named by ${r.plugin}: ${outsideLine(r.reason, 200)}`)].filter(Boolean).join("; ");
	});
	replaceReasons(app, `plan:${opts.hash ?? title.id}`, reasons);
	return result;
}

/** Items the agent wrote are held to the limits of `organise.name`, without passing through it. */
export function checkWrittenItems(app: Reelix, title: (TitleLike & { library_folder?: string | null }) | undefined, items: PlanItem[]): void {
	const roots = title ? [libraryRootFor(app, mediaClassOf(title))] : Object.values(libraryRoots(app)).filter((r): r is string => !!r);
	const fileDepth = title?.kind === "movie" ? 2 : 3;
	const depths: Record<PlanItem["kind"], number[]> = { video: title ? [fileDepth] : [2, 3], subtitle: title ? [fileDepth] : [2, 3], audio: title ? [fileDepth] : [2, 3], extra: [fileDepth, fileDepth + 1], disc: [1] };
	const titleFolders = title ? [folderName(title), ...(title.library_folder ? [basename(title.library_folder)] : [])] : undefined;
	const problems = items.flatMap((item) => {
		const root = roots.find((r) => within(resolve(item.dest), r) && resolve(item.dest) !== r);
		if (!root) return [`${item.dest}: it must be inside the library${title ? ` folder ${roots[0]}` : ""}`];
		const problem = libraryPathProblem(relative(root, resolve(item.dest)), { titleFolders, depths: depths[item.kind], extension: item.kind === "disc" ? undefined : extname(item.source) });
		return problem ? [`${item.dest}: ${problem}`] : [];
	});
	if (problems.length) throw new ReelixError("invalid_plan", `These plan items break the library's limits:\n- ${problems.join("\n- ")}`);
}

/** Render a plan for people and the model. */
export function planToText(plan: Plan, results?: ApplyItemResult[]): string {
	return plan.items
		.map((it, i) => {
			const r = results?.[i];
			return `${r ? `[${r.status}] ` : ""}${it.kind}: ${it.source}\n    -> ${it.dest}${it.reason ? `  (${it.reason})` : ""}${r?.error ? `\n    ! ${r.error}` : ""}`;
		})
		.join("\n");
}
