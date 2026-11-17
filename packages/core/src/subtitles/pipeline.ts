import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { Type } from "typebox";
import type { Reelix } from "../app.ts";
import { libraryRoots } from "../organiser.ts";
import { subtitlePathFor } from "../naming.ts";
import { parseReleaseName, normName } from "../parser.ts";
import { probe } from "../probe.ts";
import { defineOperation } from "../registry.ts";
import { type Title, linkDouban, requireTitle } from "../titles.ts";
import { ReelixError, errorMessage, nowIso } from "../util.ts";
import { type SubCandidate, assrtSearch, fetchCandidate, siteState, subhdFiles, subhdSearch } from "./sources.ts";
import { SUB_FILE, type SubLanguage, decodeSubtitle, detectLanguage, lastTimestamp, timingFits, unpackSubtitles } from "./text.ts";

export type VideoTarget = { path: string; season?: number; episode?: number; durationS?: number };

/** Library videos of a title (optionally one season), from Reelix's records. */
export function videosOf(app: Reelix, titleId: string, season?: number): VideoTarget[] {
	const rows = app.db.prepare("SELECT f.id, f.dest FROM files f WHERE f.title_id = ? AND f.kind = 'video' ORDER BY f.dest").all(titleId) as { id: number; dest: string }[];
	const ep = app.db.prepare("SELECT season, episode FROM file_episodes WHERE file_id = ? ORDER BY season, episode LIMIT 1");
	return rows
		.map((r) => {
			const e = ep.get(r.id) as { season: number; episode: number } | undefined;
			return { path: r.dest, season: e?.season, episode: e?.episode };
		})
		.filter((v) => existsSync(v.path) && (season === undefined || v.season === season));
}

export type ExistingSubs = { video: string; external: string[]; embeddedChinese: string[]; embeddedAll: number };

export async function existingSubtitles(videos: VideoTarget[]): Promise<ExistingSubs[]> {
	const out: ExistingSubs[] = [];
	for (const v of videos) {
		const base = basename(v.path, extname(v.path));
		const external = existsSync(dirname(v.path)) ? readdirSync(dirname(v.path)).filter((n) => n.startsWith(base) && SUB_FILE.test(n)) : [];
		let embeddedChinese: string[] = [];
		let embeddedAll = 0;
		try {
			const p = await probe(v.path);
			v.durationS = p.durationS;
			embeddedAll = p.subtitles.length;
			embeddedChinese = p.subtitles.filter((s) => /^(chi|zho|zh|chs|cht)/i.test(s.language ?? "") || /中|简|繁|chinese|chs|cht/i.test(s.title ?? "")).map((s) => `#${s.index} ${s.codec} ${s.language ?? ""} ${s.title ?? ""}`.trim());
		} catch {
			/* no ffprobe */
		}
		out.push({ video: v.path, external, embeddedChinese, embeddedAll });
	}
	return out;
}

// ------------------------------------------------------------------ search

export type SubSearchOutput = { title: string; season?: number; have: ExistingSubs[]; candidates: SubCandidate[]; errors: string[]; note?: string };

export async function searchSubtitles(app: Reelix, title: Title, opts: { season?: number; query?: string; sources?: string[] } = {}): Promise<SubSearchOutput> {
	const videos = videosOf(app, title.id, opts.season);
	const have = await existingSubtitles(videos);
	const sources = opts.sources ?? app.config.subtitles.sources;
	const errors: string[] = [];
	let candidates: SubCandidate[] = [];
	const names = [title.name, title.original_name, title.folder_name].filter((x): x is string => !!x);
	const wantNames = new Set(title.names.concat(names).map(normName));

	if (sources.includes("subhd")) {
		try {
			const q = opts.query ?? title.name;
			let rs = await subhdSearch(app, q);
			// The title's Douban ID: subhd files subtitles under it (decision F).
			if (title.douban_id) rs = rs.filter((r) => !r.doubanId || r.doubanId === title.douban_id);
			else {
				const byDouban = new Map<string, SubCandidate[]>();
				for (const r of rs) if (r.doubanId) byDouban.set(r.doubanId, [...(byDouban.get(r.doubanId) ?? []), r]);
				const match = [...byDouban.entries()].filter(([, list]) => list.some((r) => wantNames.has(normName(r.title))));
				if (match.length === 1) {
					linkDouban(app, title.id, match[0]![0]);
					rs = match[0]![1];
				}
			}
			if (opts.season !== undefined && title.kind === "tv") {
				rs = rs.filter((r) => {
					const p = parseReleaseName(`${r.title} ${r.release}`);
					return p.season === undefined || p.season === opts.season || p.seasons?.includes(opts.season!);
				});
			}
			candidates.push(...rs.slice(0, 20));
		} catch (e) {
			errors.push(`subhd: ${errorMessage(e)}`);
		}
	}
	if (sources.includes("assrt") && app.secrets["assrt.token"]) {
		for (const q of [opts.query ?? title.name, title.folder_name].filter((x, i, a): x is string => !!x && a.indexOf(x) === i)) {
			try {
				const rs = await assrtSearch(app, q + (opts.season !== undefined ? ` S${String(opts.season).padStart(2, "0")}` : ""));
				candidates.push(...rs.slice(0, 10));
				if (rs.length) break;
			} catch (e) {
				errors.push(`assrt: ${errorMessage(e)}`);
				break;
			}
		}
	}
	candidates = candidates.filter((c, i, a) => a.findIndex((x) => x.ref === c.ref) === i);
	const st = siteState(app, "subhd");
	const note = st.dailyLimitUntil && st.dailyLimitUntil > nowIso() ? `subhd's daily limit is reached until ${st.dailyLimitUntil.slice(0, 16)}.` : st.verificationSince ? "subhd asked for verification earlier today; downloads may need the browser." : undefined;
	return { title: `${title.name} (${title.year ?? "?"})`, season: opts.season, have, candidates, errors, note };
}

export function subSearchToText(o: SubSearchOutput): string {
	const have = o.have.map((h) => `${basename(h.video)}: external [${h.external.join(", ") || "none"}], embedded Chinese [${h.embeddedChinese.join("; ") || "none"}]`).join("\n");
	const c = o.candidates.map((x) => `${x.ref} | ${x.title} | ${x.release} | ${x.languages.join("/")} ${x.formats.join("/")}${x.tags.length ? ` | ${x.tags.join(",")}` : ""}${x.downloads ? ` | ${x.downloads} dl` : ""}${x.date ? ` | ${x.date.slice(0, 10)}` : ""}`).join("\n");
	return `${o.title}${o.season !== undefined ? ` season ${o.season}` : ""}\nAlready there:\n${have || "(no library files recorded)"}\nCandidates (${o.candidates.length}):\n${c || "none"}${o.errors.length ? `\nErrors: ${o.errors.join("; ")}` : ""}${o.note ? `\nNote: ${o.note}` : ""}`;
}

// ------------------------------------------------------------------ fetch, clean, place

export type AnalysedSub = { path: string; name: string; format: string; language: SubLanguage; encoding: string; season?: number; episodes?: number[]; lastS?: number; text: string };

export function analyse(file: string): AnalysedSub {
	const { text, encoding } = decodeSubtitle(readFileSync(file));
	const lang = detectLanguage(text);
	const p = parseReleaseName(basename(file));
	return { path: file, name: basename(file), format: extname(file).slice(1).toLowerCase(), language: lang.language, encoding, season: p.season, episodes: p.episodes, lastS: lastTimestamp(text), text };
}

const LANG_RANK: Record<string, number> = { "zh-bilingual": 6, "zh-Hans": 5, "zh-mixed": 3, "zh-Hant": 2, en: 1, ja: 0, und: 0 };

/** Default preference (agreed): 简体&English bilingual, then 简体 alone; ASS over SRT. */
function rank(s: AnalysedSub, prefer?: string): number {
	let r = LANG_RANK[s.language] ?? 0;
	if (prefer === "simplified" && s.language === "zh-Hans") r = 10;
	if (prefer === "traditional" && s.language === "zh-Hant") r = 10;
	if (prefer === "bilingual" && s.language === "zh-bilingual") r = 10;
	return r * 10 + (s.format === "ass" || s.format === "ssa" ? 2 : s.format === "srt" ? 1 : 0);
}

function langCode(l: SubLanguage): { code: string; label?: string } {
	switch (l) {
		case "zh-bilingual":
			return { code: "zh", label: "简英双语" };
		case "zh-Hans":
			return { code: "zh", label: "简体" };
		case "zh-Hant":
			return { code: "zh-TW", label: "繁體" };
		case "zh-mixed":
			return { code: "zh" };
		case "en":
			return { code: "en" };
		case "ja":
			return { code: "ja" };
		default:
			return { code: "und" };
	}
}

export type PlaceResult = { video: string; placed?: string; from?: string; language?: string; encoding?: string; warnings: string[]; skipped?: string };

/** Write cleaned subtitles next to their videos (ordinary files, not links). */
export function placeSubtitles(app: Reelix, titleId: string | undefined, subs: AnalysedSub[], videos: VideoTarget[], opts: { prefer?: string; file?: string; source?: string; ref?: string } = {}): PlaceResult[] {
	const roots = Object.values(libraryRoots(app)).filter(Boolean) as string[];
	const results: PlaceResult[] = [];
	const usable = subs.filter((s) => s.format !== "sub" && s.format !== "idx" && s.format !== "sup");
	for (const v of videos) {
		let pool = usable;
		if (opts.file) pool = pool.filter((s) => s.name === opts.file || s.path.endsWith(opts.file!));
		else if (v.episode !== undefined && videos.length > 1) {
			// Attribute each file in a pack to its episode.
			pool = pool.filter((s) => s.episodes?.includes(v.episode!) && (s.season === undefined || s.season === v.season));
		}
		if (!pool.length) {
			results.push({ video: v.path, warnings: [], skipped: v.episode !== undefined ? `no file in the archive for E${v.episode}` : "no usable subtitle file" });
			continue;
		}
		const best = [...pool].sort((a, b) => rank(b, opts.prefer) - rank(a, opts.prefer))[0]!;
		const warnings: string[] = [];
		const fit = timingFits(best.lastS, v.durationS);
		if (!fit.ok) warnings.push(`timing: ${fit.why}`);
		if (best.language === "zh-mixed") warnings.push("mixed simplified/traditional text");
		const { code, label } = langCode(best.language);
		let dest = subtitlePathFor(v.path, code, "." + (best.format === "ssa" ? "ass" : best.format), { default: true, label });
		if (!roots.some((r) => dest.startsWith(r.replace(/\/+$/, "") + "/"))) {
			results.push({ video: v.path, warnings, skipped: "the video is not inside the library" });
			continue;
		}
		const body = (best.format === "ass" || best.format === "ssa" ? "﻿" : "") + best.text.replace(/\r?\n/g, "\n");
		if (existsSync(dest)) {
			if (readFileSync(dest, "utf8") === body) {
				results.push({ video: v.path, placed: dest, from: best.name, language: best.language, warnings: [...warnings, "already in place"] });
				continue;
			}
			for (let n = 2; existsSync(dest); n++) dest = subtitlePathFor(v.path, code, "." + best.format, { label: `${label ?? code} ${n}` });
		}
		writeFileSync(dest, body, "utf8");
		app.db.prepare("INSERT INTO subtitles (title_id, video_path, path, source, source_ref, language, format, checks_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(titleId ?? null, v.path, dest, opts.source ?? "drop-in", opts.ref ?? null, best.language, best.format, JSON.stringify({ encoding: best.encoding, lastS: best.lastS, videoS: v.durationS, warnings }), nowIso());
		app.db.prepare("INSERT INTO files (title_id, source, dest, kind, linked, created_at) VALUES (?, ?, ?, 'subtitle', 0, ?) ON CONFLICT(dest) DO NOTHING").run(titleId ?? null, best.path, dest, nowIso());
		results.push({ video: v.path, placed: dest, from: best.name, language: best.language, encoding: best.encoding, warnings });
	}
	return results;
}

function targetsFor(app: Reelix, input: { title_id?: string; season?: number; video?: string }): { titleId?: string; videos: VideoTarget[] } {
	if (input.video) {
		if (!existsSync(input.video)) throw new ReelixError("not_found", `No video at ${input.video}`);
		const p = parseReleaseName(basename(input.video));
		return { titleId: input.title_id, videos: [{ path: input.video, season: p.season, episode: p.episodes?.[0] }] };
	}
	if (!input.title_id) throw new ReelixError("invalid_input", "Give title_id (and season) or video.");
	const t = requireTitle(app, input.title_id);
	const videos = videosOf(app, t.id, input.season);
	if (!videos.length) throw new ReelixError("no_videos", `${t.name} has no library video files${input.season !== undefined ? ` in season ${input.season}` : ""} recorded yet.`);
	return { titleId: t.id, videos };
}

async function withDurations(videos: VideoTarget[]): Promise<void> {
	for (const v of videos) {
		if (v.durationS) continue;
		try {
			v.durationS = (await probe(v.path)).durationS;
		} catch {}
	}
}

export type FetchOutput = { ref?: string; archive?: string; files: { name: string; language: string; format: string; encoding: string; episodes?: number[] }[]; results: PlaceResult[] };

export async function processLocalSubtitle(app: Reelix, file: string, input: { title_id?: string; season?: number; video?: string; prefer?: string; file?: string; source?: string; ref?: string }): Promise<FetchOutput> {
	const { titleId, videos } = targetsFor(app, input);
	await withDurations(videos);
	const scratch = join(app.paths.workspace, "subs", `${Date.now()}`);
	const files = await unpackSubtitles(file, scratch);
	if (!files.length) throw new ReelixError("no_subtitles", "The file contains no subtitle files (it may be password-protected, or not a subtitle archive).");
	const subs = files.map(analyse);
	const results = placeSubtitles(app, titleId, subs, videos, input);
	return { ref: input.ref, archive: basename(file), files: subs.map((s) => ({ name: s.name, language: s.language, format: s.format, encoding: s.encoding, episodes: s.episodes })), results };
}

export async function fetchSubtitle(app: Reelix, input: { ref: string; title_id?: string; season?: number; video?: string; prefer?: string; file?: string }): Promise<FetchOutput> {
	targetsFor(app, input); // fail early, before spending a download
	const got = await fetchCandidate(app, input.ref);
	const dir = join(app.paths.workspace, "subs", "downloads");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${input.ref.replace(":", "-")}-${basename(got.filename).replace(/[^\w.\-一-鿿]/g, "_")}`);
	writeFileSync(path, got.bytes);
	return processLocalSubtitle(app, path, { ...input, source: input.ref.split(":")[0], ref: input.ref });
}

export function fetchToText(o: FetchOutput): string {
	const files = o.files.map((f) => `  ${f.name}: ${f.language}, ${f.format}, ${f.encoding}${f.episodes ? `, E${f.episodes.join(",")}` : ""}`).join("\n");
	const res = o.results.map((r) => `  ${basename(r.video)}: ${r.placed ? `→ ${basename(r.placed)} (from ${r.from}, ${r.language})` : `skipped: ${r.skipped}`}${r.warnings.length ? ` ! ${r.warnings.join("; ")}` : ""}`).join("\n");
	return `${o.archive ?? o.ref}: ${o.files.length} subtitle files\n${files}\nPlaced:\n${res}`;
}

// ------------------------------------------------------------------ operations (step 4)

defineOperation({
	name: "subtitle.search",
	summary: "Find Chinese subtitle candidates for a title/season (subhd first, ASSRT fallback) and report what is already there",
	description: "Choose once per season: prefer a season pack; weigh the language preference, human over machine translation, and whether it was made for this release.",
	effect: "read",
	tool: "subtitle_search",
	input: Type.Object({ title_id: Type.String(), season: Type.Optional(Type.Integer()), query: Type.Optional(Type.String({ description: "search with another name" })), sources: Type.Optional(Type.Array(Type.String())) }),
	positional: ["title_id"],
	async run(ctx, i) {
		return searchSubtitles(ctx.app, requireTitle(ctx.app, i.title_id), i);
	},
	toText: subSearchToText,
	titleOf: (i) => i.title_id,
});

defineOperation({
	name: "subtitle.files",
	summary: "List the files inside a subhd subtitle archive before downloading it",
	effect: "read",
	input: Type.Object({ ref: Type.String() }),
	positional: ["ref"],
	async run(ctx, i) {
		const [src, id] = i.ref.split(":");
		if (src !== "subhd" || !id) throw new ReelixError("invalid_input", "Only subhd lists archive contents.");
		return { ref: i.ref, files: await subhdFiles(ctx.app, id) };
	},
	toText: (o: any) => `${o.ref}:\n${o.files.join("\n") || "(no file list)"}`,
});

defineOperation({
	name: "subtitle.fetch",
	summary: "Download a subtitle candidate, unpack, clean (UTF-8, script by content, episodes, timing) and place it next to the videos",
	description: "ref from subtitle_search. For a season pack give title_id + season; for one file give video=. prefer=bilingual|simplified|traditional overrides the default; file= picks one file in the archive.",
	effect: "write",
	tool: "subtitle_fetch",
	input: Type.Object({ ref: Type.String(), title_id: Type.Optional(Type.String()), season: Type.Optional(Type.Integer()), video: Type.Optional(Type.String()), prefer: Type.Optional(Type.String()), file: Type.Optional(Type.String()) }),
	positional: ["ref"],
	async run(ctx, i) {
		return fetchSubtitle(ctx.app, i);
	},
	toText: fetchToText,
	titleOf: (i) => i.title_id,
});

defineOperation({
	name: "subtitle.place",
	summary: "Place a dropped-in subtitle file or archive (already on disk) next to a title's videos",
	effect: "write",
	input: Type.Object({ path: Type.String(), title_id: Type.Optional(Type.String()), season: Type.Optional(Type.Integer()), video: Type.Optional(Type.String()), prefer: Type.Optional(Type.String()), file: Type.Optional(Type.String()) }),
	positional: ["path"],
	async run(ctx, i) {
		if (!existsSync(i.path)) throw new ReelixError("not_found", `No file at ${i.path}`);
		const copy = join(ctx.app.paths.workspace, "subs", "dropped");
		mkdirSync(copy, { recursive: true });
		const local = join(copy, `${Date.now()}-${basename(i.path)}`);
		copyFileSync(i.path, local);
		return processLocalSubtitle(ctx.app, local, { ...i, source: "drop-in" });
	},
	toText: fetchToText,
	titleOf: (i) => i.title_id,
});

defineOperation({
	name: "subtitle.list",
	summary: "Subtitles Reelix placed for a title",
	effect: "read",
	input: Type.Object({ title_id: Type.String() }),
	positional: ["title_id"],
	async run(ctx, i) {
		return ctx.app.db.prepare("SELECT * FROM subtitles WHERE title_id = ? ORDER BY created_at DESC").all(i.title_id);
	},
	toText: (o: any[]) => o.map((s) => `${s.created_at.slice(0, 16)} | ${s.language} ${s.format} | ${s.source}${s.source_ref ? ` ${s.source_ref}` : ""} | ${s.path}`).join("\n") || "None.",
});

defineOperation({
	name: "site.status",
	summary: "Per-site limits, pace and verification state (subhd, ASSRT)",
	effect: "read",
	input: Type.Object({}),
	async run(ctx) {
		return Object.fromEntries(["subhd", "assrt"].map((s) => [s, siteState(ctx.app, s)]));
	},
	toText: (o: any) => Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n"),
});
