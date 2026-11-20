import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { type Kind, type Outcome, type SubtitleHit, type SubtitleQuery, outsideLine, isOutcome } from "@reelix/plugin";
import { Type } from "typebox";
import type { Reelix } from "../app.ts";
import { libraryRoots } from "../organiser.ts";
import { subtitlePathFor } from "../naming.ts";
import { parseReleaseName } from "../parser.ts";
import { probe } from "../probe.ts";
import { defineOperation } from "../registry.ts";
import { type ReasonInput, replaceReasons } from "../reasons.ts";
import { type Provider, outcomeText } from "../seams.ts";
import { type Title, linkDouban, requireTitle } from "../titles.ts";
import { ReelixError, errorMessage, nowIso } from "../util.ts";
import { LANGUAGE_LABEL, SUBTITLE_LANGUAGES, type SubLang, languageScore, trackMatches, wantedLanguages } from "./languages.ts";
import { SUB_FILE, type SubLanguage, decodeSubtitle, detectLanguage, lastTimestamp, timingFits, unpackSubtitles } from "./text.ts";

const SEAM = "reelix:subtitle.source@1";
const PICK = "subtitle.pick@1";

export type SubCandidate = {
	ref: string; // "<source>:<the source's own reference>", e.g. "subhd:N2Covz", "opensubtitles:8412"
	source: string;
	title: string; // the title the site files it under
	release: string; // description: usually the release it was made for
	languages: string[]; // as the site words them: 简体, 繁体, 双语, 英语 …
	formats: string[]; // ASS, SRT
	tags: string[]; // 官方字幕, 机翻, 原创 …
	size?: string;
	downloads?: number;
	date?: string;
	uploader?: string;
	/** ISO 639-1 code when the source states one (en, fr, ru, zh, ja). */
	language?: string;
	season?: number;
	episode?: number;
	hearingImpaired?: boolean;
	/** Machine- or AI-translated, as the source says. */
	machine?: boolean;
	/** The source matched the video file's hash: made for exactly this file. */
	hashMatch?: boolean;
};

function toCandidate(source: string, h: SubtitleHit): SubCandidate {
	return { ref: `${source}:${h.ref}`, source, title: h.name, release: h.release ?? "", languages: h.languages, formats: h.formats ?? [], tags: h.tags ?? [], size: h.size, downloads: h.downloads, date: h.date, uploader: h.uploader, language: h.language, season: h.season, episode: h.episode, hearingImpaired: h.hearingImpaired, machine: h.machine, hashMatch: h.hashMatch };
}

/** OpenSubtitles' file hash, which several sources match on: size + the 64-bit sums of the first and last 64 KB. */
export function videoFileHash(path: string): string {
	const size = statSync(path).size;
	const chunk = 65536;
	const fd = openSync(path, "r");
	try {
		let h = BigInt(size);
		const buf = Buffer.alloc(chunk);
		for (const pos of [0, Math.max(0, size - chunk)]) {
			buf.fill(0);
			readSync(fd, buf, 0, Math.min(chunk, size), pos);
			for (let i = 0; i + 8 <= chunk; i += 8) h = (h + buf.readBigUInt64LE(i)) & 0xffffffffffffffffn;
		}
		return h.toString(16).padStart(16, "0");
	} finally {
		closeSync(fd);
	}
}

/** A site's answer that is not a subtitle, as the error the agent reads (skills/verification). */
function outcomeError(p: Provider<typeof SEAM>, o: Outcome): ReelixError {
	const text = outcomeText(p.label, o);
	switch (o.outcome) {
		case "rate_limited":
			return new ReelixError("daily_limit", `${text} Try another source, or later.`);
		case "needs_verification":
			return new ReelixError("verification_required", `${text} Open it in the browser and follow the verification skill, then fetch again with verification=<the token>; or try another source, or the owner can drop in the file.`, { url: o.url });
		case "needs_auth":
			return new ReelixError("not_configured", text);
		case "unavailable":
			return new ReelixError("source_unavailable", text);
	}
}

/** "opensubtitles:123" → provider + its own reference (which may contain ":"). */
function splitRef(app: Reelix, ref: string): { provider: Provider<typeof SEAM>; id: string } {
	const i = ref.indexOf(":");
	const providers = app.seams.providers(SEAM);
	const provider = i > 0 ? providers.find((p) => p.id === ref.slice(0, i)) : undefined;
	const id = i > 0 ? ref.slice(i + 1) : "";
	if (!provider || !id) throw new ReelixError("invalid_input", `Unknown subtitle reference "${ref}" (expected <source>:<id>; sources: ${providers.map((p) => p.id).join(", ")}).`);
	return { provider, id };
}

async function fetchCandidate(app: Reelix, ref: string, verification?: string): Promise<{ bytes: Uint8Array; filename: string }> {
	const { provider, id } = splitRef(app, ref);
	const got = await provider.call("download", [id], { verification });
	if (isOutcome(got)) throw outcomeError(provider, got);
	// Seen live: a source serving a cached empty file. Say so, so another candidate is chosen.
	if (!got.bytes.length) throw new ReelixError("empty_download", `${provider.label} returned an empty file for ${ref}; choose another candidate.`);
	return got;
}

const startOfToday = () => `${nowIso().slice(0, 10)}T00:00:00`;

/** What a source answered lately, as `site.status` and the search note show it. */
function siteRecord(app: Reelix, id: string): { limitUntil?: string; verificationSince?: string; downloadsToday: number } {
	const today = app.seams.outcomes(SEAM, id, startOfToday());
	const now = nowIso();
	const limit = app.seams.outcomes(SEAM, id, new Date(Date.now() - 86_400_000).toISOString()).find((o) => o.outcome === "rate_limited" && o.until && o.until > now);
	return { limitUntil: limit?.until, verificationSince: today.find((o) => o.outcome === "needs_verification")?.at, downloadsToday: today.filter((o) => o.outcome === "ok").length };
}

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

/** What a video already has: external files next to it, embedded tracks in a wanted language, all embedded tracks. */
export type ExistingSubs = { video: string; external: string[]; embeddedWanted: string[]; embeddedAll: number };

export async function existingSubtitles(videos: VideoTarget[], wanted: readonly SubLang[] = ["zh"]): Promise<ExistingSubs[]> {
	const out: ExistingSubs[] = [];
	for (const v of videos) {
		const base = basename(v.path, extname(v.path));
		const external = existsSync(dirname(v.path)) ? readdirSync(dirname(v.path)).filter((n) => n.startsWith(base) && SUB_FILE.test(n)) : [];
		let embeddedWanted: string[] = [];
		let embeddedAll = 0;
		try {
			const p = await probe(v.path);
			v.durationS = p.durationS;
			embeddedAll = p.subtitles.length;
			embeddedWanted = p.subtitles.filter((s) => trackMatches(s, wanted)).map((s) => `#${s.index} ${s.codec} ${s.language ?? ""} ${s.title ?? ""}`.trim());
		} catch {
			/* no ffprobe */
		}
		out.push({ video: v.path, external, embeddedWanted, embeddedAll });
	}
	return out;
}

// ------------------------------------------------------------------ search

export type SubSearchOutput = { title: string; season?: number; languages: SubLang[]; have: ExistingSubs[]; candidates: SubCandidate[]; errors: string[]; skipped: { source: string; label: string; needs: string[] }[]; note?: string };

/**
 * Ask every source that covers this title's kind and the owner's wanted languages (in the
 * configured order), and report what the videos already have.
 */
export async function searchSubtitles(app: Reelix, title: Title, opts: { season?: number; query?: string; sources?: string[]; languages?: string[] } = {}): Promise<SubSearchOutput> {
	const providers = app.seams.providers(SEAM);
	const videos = videosOf(app, title.id, opts.season);
	const languages = (opts.languages?.length ? opts.languages.filter((l): l is SubLang => (SUBTITLE_LANGUAGES as readonly string[]).includes(l)) : wantedLanguages(app)) as SubLang[];
	const have = await existingSubtitles(videos, languages);
	const order = opts.sources ?? app.config.subtitles.sources;
	const kind: Kind = title.media_class === "anime" ? "anime" : title.kind === "movie" ? "movie" : "show";
	const series = title.kind === "tv";
	const episodes = [...new Set(videos.map((v) => v.episode).filter((e): e is number => e !== undefined))].sort((x, y) => x - y);
	let videoHash: string | undefined;
	if (title.kind === "movie" && videos.length === 1) {
		try {
			videoHash = videoFileHash(videos[0]!.path);
		} catch {}
	}
	const errors: string[] = [];
	const notes: string[] = [];
	const skipped: SubSearchOutput["skipped"] = [];
	let candidates: SubCandidate[] = [];
	const names = [...new Set([title.name, title.original_name, title.folder_name, ...title.names].filter((x): x is string => !!x))];
	const ids = { tmdb: title.tmdb_id ?? undefined, imdb: title.imdb_id ?? undefined, douban: title.douban_id ?? undefined };

	for (const id of order) {
		const p = providers.find((x) => x.id === id);
		if (!p) {
			errors.push(`${id}: no such subtitle source (active: ${providers.map((x) => x.id).join(", ") || "none"})`);
			continue;
		}
		const langs = languages.filter((l) => p.impl.languages.includes(l));
		const kindOk = p.impl.kinds.includes(kind) || (kind === "anime" && p.impl.kinds.includes("show") && series);
		if (!langs.length || !kindOk) continue; // not this source's field
		const needs = p.missingSecrets(app.secrets);
		if (needs.length) {
			skipped.push({ source: p.id, label: p.label, needs });
			continue;
		}
		const q: SubtitleQuery = { names, year: title.year ?? undefined, ids, kind, series, season: opts.season, episodes, languages: langs, text: opts.query, videoHash };
		try {
			const answer = await p.call("search", [q]);
			if (isOutcome(answer)) {
				errors.push(outcomeText(p.label, answer));
				continue;
			}
			// A site may reveal the title's Douban id (decision F).
			const douban = answer.find((h) => h.ids?.douban)?.ids?.douban;
			if (douban && !title.douban_id) linkDouban(app, title.id, douban);
			let rs = answer.map((h) => toCandidate(p.id, h));
			if (opts.season !== undefined && series) {
				rs = rs.filter((r) => {
					if (r.season !== undefined) return r.season === opts.season;
					const pr = parseReleaseName(`${r.title} ${r.release}`);
					return pr.season === undefined || pr.season === opts.season || pr.seasons?.includes(opts.season!);
				});
			}
			candidates.push(...rs.slice(0, 30));
		} catch (e) {
			errors.push(`${p.id}: ${errorMessage(e)}`);
		}
		const record = siteRecord(app, p.id);
		if (record.limitUntil) notes.push(`${p.label}'s limit is reached until ${record.limitUntil.slice(0, 16)}.`);
		else if (record.verificationSince) notes.push(`${p.label} asked for verification earlier today; downloads may need the browser.`);
	}
	candidates = candidates.filter((c, i, a) => a.findIndex((x) => x.ref === c.ref) === i);
	return { title: `${title.name} (${title.year ?? "?"})`, season: opts.season, languages, have, candidates, errors, skipped, note: notes.join(" ") || undefined };
}

export function subSearchToText(o: SubSearchOutput): string {
	const have = o.have.map((h) => `${basename(h.video)}: external [${h.external.join(", ") || "none"}], embedded in a wanted language [${h.embeddedWanted.join("; ") || "none"}]`).join("\n");
	const c = o.candidates
		.map((x) => {
			const flags = [x.hashMatch ? "HASH MATCH" : "", x.machine ? "machine-translated" : "", x.hearingImpaired ? "HI" : "", x.episode !== undefined ? `E${x.episode}` : ""].filter(Boolean);
			return `${x.ref} | ${outsideLine(x.title)} | ${outsideLine(x.release)} | ${outsideLine(x.languages.join("/"), 80)} ${outsideLine(x.formats.join("/"), 80)}${x.tags.length ? ` | ${outsideLine(x.tags.join(","))}` : ""}${flags.length ? ` | ${flags.join(",")}` : ""}${x.downloads ? ` | ${x.downloads} dl` : ""}${x.date ? ` | ${x.date.slice(0, 10)}` : ""}`;
		})
		.join("\n");
	return `${o.title}${o.season !== undefined ? ` season ${o.season}` : ""} — wanted: ${o.languages.map((l) => LANGUAGE_LABEL[l]).join(" > ")}\nAlready there:\n${have || "(no library files recorded)"}\nCandidates (${o.candidates.length}):\n${c || "none"}${o.errors.length ? `\nErrors: ${o.errors.join("; ")}` : ""}${o.skipped.length ? `\nNot asked (no key; the owner can add one under Settings → Secrets): ${o.skipped.map((x) => `${x.label} needs ${x.needs.join(", ")}`).join("; ")}` : ""}${o.note ? `\nNote: ${o.note}` : ""}`;
}

// ------------------------------------------------------------------ fetch, clean, place

export type AnalysedSub = { path: string; name: string; format: string; language: SubLanguage; encoding: string; season?: number; episodes?: number[]; lastS?: number; text: string };

export function analyse(file: string): AnalysedSub {
	const { text, encoding } = decodeSubtitle(readFileSync(file));
	const lang = detectLanguage(text);
	const p = parseReleaseName(basename(file));
	return { path: file, name: basename(file), format: extname(file).slice(1).toLowerCase(), language: lang.language, encoding, season: p.season, episodes: p.episodes, lastS: lastTimestamp(text), text };
}

/** The owner's wanted languages in order (简英双语 > 简体 > 繁體 within Chinese); ASS over SRT. */
function rank(s: AnalysedSub, wanted: readonly SubLang[], prefer?: string): number {
	return languageScore(s.language, wanted, prefer) * 10 + (s.format === "ass" || s.format === "ssa" ? 2 : s.format === "srt" ? 1 : 0);
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
		case "fr":
			return { code: "fr" };
		case "ru":
			return { code: "ru" };
		case "ja":
			return { code: "ja" };
		default:
			return { code: "und" };
	}
}

/** The languages of a file as the `subtitle.pick` hook names them. */
const hookLanguages = (l: SubLanguage): string[] => (l === "zh-bilingual" ? ["zh", "en"] : langCode(l).code === "und" ? [] : [langCode(l).code]);

/** The deepest folder holding every file: names in the hook are paths inside the archive. */
function commonFolder(paths: string[]): string {
	let dir = dirname(paths[0]!);
	while (!paths.every((p) => p.startsWith(`${dir}/`)) && dir !== dirname(dir)) dir = dirname(dir);
	return dir;
}

/** Each file's score: Reelix's ranking, then the plugins' changes through the `subtitle.pick` hook (docs/plugins.md §8). */
type Scored = { score: Map<AnalysedSub, number>; changes: Map<AnalysedSub, ReasonInput[]> };

async function scores(app: Reelix, subs: AnalysedSub[], prefer?: string): Promise<Scored> {
	const wanted = wantedLanguages(app);
	const out: Scored = { score: new Map(subs.map((s) => [s, rank(s, wanted, prefer)])), changes: new Map() };
	if (!subs.length || !app.hooks.has(PICK)) return out;
	const root = commonFolder(subs.map((s) => s.path));
	const byName = new Map(subs.map((s) => [relative(root, s.path), s]));
	const input = { files: [...byName].map(([name, s]) => ({ name, languages: hookLanguages(s.language), format: s.format, score: out.score.get(s)! })) };
	const result = await app.hooks.pipeline(PICK, input, (value, item, plugin) => ({
		files: value.files.map((f) => {
			const score = item.files.find((c) => c.name === f.name)?.score ?? f.score;
			if (score !== f.score) {
				const s = byName.get(f.name)!;
				out.changes.set(s, [...(out.changes.get(s) ?? []), { kind: "scored", plugin, reason: item.reason, detail: { file: f.name, from: f.score, to: score } }]);
			}
			return { ...f, score };
		}),
	}));
	for (const f of result.files) out.score.set(byName.get(f.name)!, f.score);
	return out;
}

/** `why`: which plugins changed the chosen file's score, and their reasons (`subtitle.pick`). */
export type PlaceResult = { video: string; placed?: string; from?: string; language?: string; encoding?: string; warnings: string[]; skipped?: string; why?: string };

/** Write cleaned subtitles next to their videos (ordinary files, not links). */
export async function placeSubtitles(app: Reelix, titleId: string | undefined, subs: AnalysedSub[], videos: VideoTarget[], opts: { prefer?: string; file?: string; source?: string; ref?: string } = {}): Promise<PlaceResult[]> {
	const roots = Object.values(libraryRoots(app)).filter(Boolean) as string[];
	const results: PlaceResult[] = [];
	const usable = subs.filter((s) => s.format !== "sub" && s.format !== "idx" && s.format !== "sup");
	const { score, changes } = await scores(app, usable, opts.prefer);
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
		const best = [...pool].sort((a, b) => score.get(b)! - score.get(a)!)[0]!;
		const warnings: string[] = [];
		const scoredBy = changes.get(best) ?? [];
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
		replaceReasons(app, `subtitle:${dest}`, scoredBy);
		app.db.prepare("INSERT INTO subtitles (title_id, video_path, path, source, source_ref, language, format, checks_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(titleId ?? null, v.path, dest, opts.source ?? "drop-in", opts.ref ?? null, best.language, best.format, JSON.stringify({ encoding: best.encoding, lastS: best.lastS, videoS: v.durationS, warnings }), nowIso());
		app.db.prepare("INSERT INTO files (title_id, source, dest, kind, linked, created_at) VALUES (?, ?, ?, 'subtitle', 0, ?) ON CONFLICT(dest) DO NOTHING").run(titleId ?? null, best.path, dest, nowIso());
		results.push({ video: v.path, placed: dest, from: best.name, language: best.language, encoding: best.encoding, warnings, why: scoredBy.map((r) => `scored by ${r.plugin}: ${outsideLine(r.reason, 200)}`).join("; ") || undefined });
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
	const results = await placeSubtitles(app, titleId, subs, videos, input);
	return { ref: input.ref, archive: basename(file), files: subs.map((s) => ({ name: s.name, language: s.language, format: s.format, encoding: s.encoding, episodes: s.episodes })), results };
}

export async function fetchSubtitle(app: Reelix, input: { ref: string; title_id?: string; season?: number; video?: string; prefer?: string; file?: string; verification?: string }): Promise<FetchOutput> {
	targetsFor(app, input); // fail early, before spending a download
	const got = await fetchCandidate(app, input.ref, input.verification);
	const dir = join(app.paths.workspace, "subs", "downloads");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${input.ref.replace(":", "-")}-${basename(got.filename).replace(/[^\w.\-一-鿿]/g, "_")}`);
	writeFileSync(path, got.bytes);
	return processLocalSubtitle(app, path, { ...input, source: input.ref.split(":")[0], ref: input.ref });
}

export function fetchToText(o: FetchOutput): string {
	const files = o.files.map((f) => `  ${outsideLine(f.name)}: ${f.language}, ${f.format}, ${f.encoding}${f.episodes ? `, E${f.episodes.join(",")}` : ""}`).join("\n");
	const res = o.results.map((r) => `  ${basename(r.video)}: ${r.placed ? `→ ${basename(r.placed)} (from ${r.from}, ${r.language}${r.why ? `; ${r.why}` : ""})` : `skipped: ${r.skipped}`}${r.warnings.length ? ` ! ${r.warnings.join("; ")}` : ""}`).join("\n");
	return `${o.archive ?? o.ref}: ${o.files.length} subtitle files\n${files}\nPlaced:\n${res}`;
}

// ------------------------------------------------------------------ operations (step 4)

defineOperation({
	name: "subtitle.search",
	summary: "Find subtitle candidates for a title/season from every source that covers the owner's wanted languages, and report what is already there",
	description: "Sources (subtitles.sources): subhd and ASSRT for Chinese; OpenSubtitles, SubDL and Gestdown (TV) for English, French, Russian and more; Jimaku for Japanese anime. Choose once per season where a pack exists: weigh the language order, human over machine translation, a HASH MATCH or the same release group, and hearing-impaired only if wanted. languages= overrides the wanted list (zh, en, fr, ru, ja).",
	effect: "read",
	tool: "subtitle_search",
	input: Type.Object({ title_id: Type.String(), season: Type.Optional(Type.Integer()), query: Type.Optional(Type.String({ description: "search with another name" })), sources: Type.Optional(Type.Array(Type.String())), languages: Type.Optional(Type.Array(Type.String({ description: "zh, en, fr, ru or ja" }))) }),
	positional: ["title_id"],
	async run(ctx, i) {
		return searchSubtitles(ctx.app, requireTitle(ctx.app, i.title_id), i);
	},
	toText: subSearchToText,
	titleOf: (i) => i.title_id,
});

defineOperation({
	name: "subtitle.files",
	summary: "List the files inside a subtitle archive before downloading it, where the source can",
	effect: "read",
	input: Type.Object({ ref: Type.String() }),
	positional: ["ref"],
	async run(ctx, i) {
		const { provider, id } = splitRef(ctx.app, i.ref);
		if (!provider.has("files")) throw new ReelixError("invalid_input", `${provider.label} does not list archive contents.`);
		const files = await provider.call("files", [id]);
		if (isOutcome(files)) throw outcomeError(provider, files);
		return { ref: i.ref, files: files.map((f) => f.name) };
	},
	toText: (o: any) => `${o.ref}:\n${o.files.join("\n") || "(no file list)"}`,
});

defineOperation({
	name: "subtitle.fetch",
	summary: "Download a subtitle candidate, unpack, clean (UTF-8, script by content, episodes, timing) and place it next to the videos",
	description: "ref from subtitle_search. For a season pack give title_id + season; for one file (one episode) give video=. prefer=bilingual|simplified|traditional|en|fr|ru|ja overrides the wanted order; file= picks one file in the archive. verification= is the token from a human check the source asked for.",
	effect: "write",
	tool: "subtitle_fetch",
	input: Type.Object({ ref: Type.String(), title_id: Type.Optional(Type.String()), season: Type.Optional(Type.Integer()), video: Type.Optional(Type.String()), prefer: Type.Optional(Type.String()), file: Type.Optional(Type.String()), verification: Type.Optional(Type.String()) }),
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
	summary: "Subtitle sources: which are ready (keys), and what each answered lately: limits, verification, downloads today",
	effect: "read",
	input: Type.Object({}),
	async run(ctx) {
		const order = ctx.app.config.subtitles.sources;
		return ctx.app.seams.providers(SEAM).map((p) => {
			const needs = p.missingSecrets(ctx.app.secrets);
			return { id: p.id, label: p.label, enabled: order.includes(p.id), ready: needs.length ? `needs ${needs.join(", ")} (set it through the secret field)` : "ready", kinds: p.impl.kinds, languages: p.impl.languages, state: siteRecord(ctx.app, p.id) };
		});
	},
	toText: (o: any[]) => `Wanted subtitle languages come from subtitles.languages (or the owner's language).\n` + o.map((p) => `${p.enabled ? "●" : "○"} ${p.id} (${p.label}): ${p.ready}; ${p.kinds.join("/")}; ${p.languages.join(", ")}${p.state.limitUntil || p.state.verificationSince || p.state.downloadsToday ? `; ${[p.state.downloadsToday ? `${p.state.downloadsToday} downloads today` : "", p.state.limitUntil ? `limit until ${p.state.limitUntil.slice(0, 16)}` : "", p.state.verificationSince ? "asked for verification today" : ""].filter(Boolean).join(", ")}` : ""}`).join("\n"),
});
