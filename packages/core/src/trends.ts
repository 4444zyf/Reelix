import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TrendHit, isOutcome } from "@reelix/plugin";
import type { Reelix } from "./app.ts";
import type { TmdbKind, TmdbSearchItem } from "./clients/tmdb.ts";
import { TranslationPaused } from "./subtitles/translate.ts";
import { normName } from "./parser.ts";
import { json } from "./db.ts";
import { type Candidate, ratingsText, toCandidate } from "./titles.ts";
import { type MediaServerProvider, activeMediaServer, chooseWatchUsers, serverError } from "./media-server.ts";
import { errorMessage, nowIso } from "./util.ts";

/*
 * Trends and "For you" (docs/trends.md). Candidates are TMDB titles: TMDB's own lists, and what the trends
 * sources (reelix:trends.source@1) offer, found in TMDB. A model only chooses among them and says why.
 */

export type TrendItem = Candidate & { rating?: number; in_library: boolean };

const TREND_TTL_MS = 30 * 60_000;
const trendCache = new Map<string, { at: number; items: TrendItem[] }>();

/** Titles Reelix has in the library (a folder or files). */
export function libraryTitleIds(app: Reelix): Set<string> {
	const rows = app.db.prepare("SELECT id FROM titles t WHERE t.library_folder IS NOT NULL OR EXISTS (SELECT 1 FROM files f WHERE f.title_id = t.id)").all() as { id: string }[];
	return new Set(rows.map((r) => r.id));
}

const toItem = (x: TmdbSearchItem, have: Set<string>): TrendItem => {
	const c = toCandidate(x);
	return { ...c, rating: x.vote_average || undefined, in_library: have.has(c.id) };
};

export const TRENDS = "reelix:trends.source@1";

/** A source's hit as a TMDB title: TMDB stays the identity (docs/plugins.md §7.6). Undefined when TMDB has no clear match. */
async function inTmdb(app: Reelix, h: TrendHit): Promise<{ item: TmdbSearchItem; candidate: Candidate } | undefined> {
	const kind: TmdbKind = h.kind === "movie" ? "movie" : "tv";
	const names = [h.name, ...(h.names ?? [])];
	const wanted = new Set(names.map(normName));
	for (const n of names) {
		const found = (await app.tmdb().search(n, kind)).map((x) => ({ item: { ...x, media_type: kind }, candidate: toCandidate({ ...x, media_type: kind }) }));
		const hit = found.find(({ candidate: c }) => (wanted.has(normName(c.name)) || (!!c.original_name && wanted.has(normName(c.original_name)))) && (!h.year || !c.year || Math.abs(c.year - h.year) <= 1));
		if (hit) return hit;
	}
	return undefined;
}

/** What the trends sources offer, found in TMDB; what TMDB cannot match is left out, and a failing source is skipped. */
async function sourceTrends(app: Reelix, kind: "all" | TmdbKind, window: "day" | "week", have: Set<string>): Promise<TrendItem[]> {
	if (!app.plugins) return [];
	const out: TrendItem[] = [];
	for (const p of app.seams.providers(TRENDS)) {
		const hits = await p.call("trending", [{ kind: kind === "tv" ? "show" : kind, window }]).catch(() => []);
		if (isOutcome(hits)) continue;
		for (const h of hits.slice(0, 20)) {
			const found = await inTmdb(app, h).catch(() => undefined);
			if (found) out.push({ ...found.candidate, rating: h.rating ?? (found.item.vote_average || undefined), in_library: have.has(found.candidate.id) });
		}
	}
	return out;
}

/** Duplicates removed by title id, the first kept. */
const unique = (items: TrendItem[]) => items.filter((x, i) => items.findIndex((y) => y.id === x.id) === i);

/** TMDB's trending list, then what the trends sources add; kept 30 minutes per list and language. */
export async function trendingTitles(app: Reelix, kind: "all" | TmdbKind = "all", window: "day" | "week" = "week"): Promise<TrendItem[]> {
	const tmdb = app.tmdb();
	const sources = app.plugins ? app.seams.providers(TRENDS).map((p) => p.id) : [];
	const key = `${tmdb.base}|${tmdb.language}|${kind}|${window}|${sources.join(",")}`;
	const have = libraryTitleIds(app);
	const hit = trendCache.get(key);
	if (hit && Date.now() - hit.at < TREND_TTL_MS) return hit.items.map((i) => ({ ...i, in_library: have.has(i.id) }));
	const items = unique([...(await tmdb.trending(kind, window)).map((x) => toItem(x, have)), ...(await sourceTrends(app, kind, window, have))]);
	trendCache.set(key, { at: Date.now(), items });
	return items;
}

// ------------------------------------------------------------------ the media server's watch history (§2.1)

export type Watched = { kind: TmdbKind; name: string; year?: number; tmdb_id?: number; plays: number; episodes?: number; favourite: boolean; watched: boolean; last_played?: string };
export type WatchHistory = { users: string[]; titles: Watched[]; error?: string };

const HISTORY_TTL_MS = 15 * 60_000;
let historyCache: { server: MediaServerProvider; at: number; h: WatchHistory } | undefined;

/** Read the media server again on the next call (tests; new watching). */
export function forgetWatchHistory(): void {
	historyCache = undefined;
}

/** What the chosen users of the active media server watched and marked as favourite. Undefined when there is none. */
export async function watchHistory(app: Reelix): Promise<WatchHistory | undefined> {
	const server = activeMediaServer(app);
	if (!server) return undefined;
	// A changed setting restarts the plugin, and so makes a new provider.
	if (historyCache?.server === server && Date.now() - historyCache.at < HISTORY_TTL_MS) return historyCache.h;
	let h: WatchHistory;
	try {
		const chosen = chooseWatchUsers(server, await server.call("users", []));
		if (typeof chosen === "string") h = { users: [], titles: [], error: chosen };
		else {
			const byKey = new Map<string, Watched>();
			const add = (w: Watched) => {
				const k = w.tmdb_id ? `${w.kind}:${w.tmdb_id}` : `${w.kind}|${w.name.toLowerCase()}|${w.year ?? ""}`;
				const o = byKey.get(k);
				if (!o) return void byKey.set(k, w);
				o.plays += w.plays;
				o.episodes = (o.episodes ?? 0) + (w.episodes ?? 0) || undefined;
				o.favourite ||= w.favourite;
				o.watched ||= w.watched;
				if ((w.last_played ?? "") > (o.last_played ?? "")) o.last_played = w.last_played;
			};
			const kindOf = (k: "movie" | "show"): TmdbKind => (k === "show" ? "tv" : "movie");
			for (const u of chosen.slice(0, 3)) {
				const [movies, shows, favourites] = await Promise.all([
					server.call("items", [{ userId: u.id, kinds: ["movie"], filter: "played", sort: "lastPlayed", limit: 60 }]),
					server.call("items", [{ userId: u.id, kinds: ["show"], filter: "played", sort: "lastPlayed", limit: 40 }]),
					server.call("items", [{ userId: u.id, kinds: ["movie", "show"], filter: "favourite", limit: 60 }]),
				]);
				for (const m of movies) add({ kind: "movie", name: m.name, year: m.year, tmdb_id: m.ids.tmdb, plays: m.plays || 1, favourite: !!m.favourite, watched: true, last_played: m.lastPlayedAt });
				for (const sh of shows) add({ kind: "tv", name: sh.name, year: sh.year, tmdb_id: sh.ids.tmdb, plays: 0, episodes: sh.episodesPlayed, favourite: !!sh.favourite, watched: true, last_played: sh.lastPlayedAt });
				for (const f of favourites) add({ kind: kindOf(f.kind), name: f.name, year: f.year, tmdb_id: f.ids.tmdb, plays: 0, favourite: true, watched: false });
			}
			const titles = [...byKey.values()].sort((a, b) => Number(b.watched) - Number(a.watched) || (b.last_played ?? "").localeCompare(a.last_played ?? "")).slice(0, 80);
			h = { users: chosen.slice(0, 3).map((u) => u.name), titles };
		}
	} catch (e) {
		h = { users: [], titles: [], error: serverError(app, e) };
	}
	historyCache = { server, at: Date.now(), h };
	return h;
}

function historyText(h: WatchHistory | undefined): string {
	if (!h?.titles.length) return "(none)";
	return h.titles
		.map((w) => {
			const what = w.kind === "tv" ? (w.episodes ? `show, ${w.episodes} episodes watched` : "show") : w.watched ? `film, watched${w.plays > 1 ? ` ${w.plays} times` : ""}` : "film";
			return `- ${w.name} (${w.year ?? "?"}; ${what}${w.favourite ? `; FAVOURITE${w.watched ? "" : ", not watched yet"}` : ""})`;
		})
		.join("\n");
}

// ------------------------------------------------------------------ For you

export type Suggestion = TrendItem & { reason: string };
export type SuggestionState = "ok" | "no_model" | "nothing_known" | "failed";
export type Suggestions = {
	made_at: string;
	language: string;
	state: SuggestionState;
	items: Suggestion[];
	model?: string;
	error?: string;
	/** What the list was made from; a change (new notes, new titles, new watching) makes it stale. */
	basis: string;
	/** The media server's part: whose history was used, how many titles, or why it could not be read. */
	history?: { users: string[]; titles: number; error?: string };
};

export const SUGGESTIONS_MAX_AGE_MS = 24 * 3600_000;
const MAX_CANDIDATES = 40;
const MAX_PICKS = 8;
const LANGUAGE_NAMES: Record<string, string> = { en: "English", zh: "Simplified Chinese", fr: "French", ru: "Russian" };

const suggestionsFile = (app: Reelix) => join(app.paths.cache, "suggestions.json");

/** The owner's memory about taste: notes/preferences.md. */
export function ownerPreferences(app: Reelix): string {
	const f = join(app.paths.notes, "preferences.md");
	return existsSync(f) ? readFileSync(f, "utf8").trim().slice(0, 4000) : "";
}

type LibRow = { id: string; kind: TmdbKind; tmdb_id: number | null; name: string; year: number | null; media_class: string; rating: number | null; ratings_json: string; followed: number };

function libraryForTaste(app: Reelix): LibRow[] {
	return app.db
		.prepare(
			`SELECT t.id, t.kind, t.tmdb_id, t.name, t.year, t.media_class, t.rating, t.ratings_json,
			 EXISTS (SELECT 1 FROM follows f WHERE f.title_id = t.id AND f.active = 1) AS followed
			 FROM titles t
			 WHERE t.library_folder IS NOT NULL OR EXISTS (SELECT 1 FROM files f WHERE f.title_id = t.id) OR EXISTS (SELECT 1 FROM follows f WHERE f.title_id = t.id AND f.active = 1)
			 ORDER BY t.updated_at DESC LIMIT 120`,
		)
		.all() as LibRow[];
}

/** What a list would be made from, as a short fingerprint. */
export function suggestionBasis(app: Reelix, history?: WatchHistory): string {
	const lib = libraryForTaste(app).map((r) => `${r.id}${r.followed ? "+" : ""}`).sort();
	const watched = (history?.titles ?? []).map((w) => `${w.kind}:${w.tmdb_id ?? w.name}:${w.plays}:${w.episodes ?? 0}:${w.favourite ? 1 : 0}`).sort();
	return createHash("sha256").update(`${app.config.language ?? "en"}\n${ownerPreferences(app)}\n${lib.join(",")}\n${watched.join(",")}`).digest("hex").slice(0, 16);
}

/** Candidates: this week's trending plus TMDB's recommendations for recent and followed titles, minus the library. */
export async function suggestionCandidates(app: Reelix, history?: WatchHistory): Promise<TrendItem[]> {
	const tmdb = app.tmdb();
	const have = libraryTitleIds(app);
	// Already watched: never suggested, even when no longer kept.
	const seen = new Set<string>();
	for (const w of history?.titles ?? []) if (w.tmdb_id && w.watched) seen.add(`${w.kind}:${w.tmdb_id}`);
	const lib = libraryForTaste(app).filter((r) => r.tmdb_id);
	// Seeds: favourites, then what was watched lately, then what is followed, then what was added lately.
	const hist = (history?.titles ?? []).filter((w) => w.tmdb_id);
	const seedList = [
		...hist.filter((w) => w.favourite).map((w) => ({ kind: w.kind, tmdb_id: w.tmdb_id! })),
		...hist.filter((w) => w.watched && !w.favourite).map((w) => ({ kind: w.kind, tmdb_id: w.tmdb_id! })),
		...lib.filter((r) => r.followed).map((r) => ({ kind: r.kind, tmdb_id: r.tmdb_id! })),
		...lib.filter((r) => !r.followed).map((r) => ({ kind: r.kind, tmdb_id: r.tmdb_id! })),
	];
	const seeds = seedList.filter((x, i) => seedList.findIndex((y) => y.kind === x.kind && y.tmdb_id === x.tmdb_id) === i).slice(0, 6);
	const lists = await Promise.allSettled([tmdb.trending("all", "week"), ...seeds.map((s) => tmdb.recommendations(s.kind, s.tmdb_id!))]);
	// Recommendations first: they are closer to the owner than what everyone watches; then the trends sources.
	const ordered = [...lists.slice(1), lists[0]!].flatMap((l) => (l.status === "fulfilled" ? l.value.slice(0, 12).map((x) => toItem(x, have)) : []));
	const out: TrendItem[] = [];
	for (const it of [...ordered, ...(await sourceTrends(app, "all", "week", have))]) {
		if (it.in_library || seen.has(it.id)) continue;
		seen.add(it.id);
		out.push(it);
		if (out.length >= MAX_CANDIDATES) break;
	}
	return out;
}

export function suggestionPrompt(app: Reelix, candidates: TrendItem[], history?: WatchHistory): { system: string; user: string } {
	const lang = LANGUAGE_NAMES[app.config.language ?? "en"] ?? "English";
	const lib = libraryForTaste(app);
	const libText = lib.length
		? lib
				.map((r) => {
					const extra = [r.media_class, r.followed ? "followed" : "", ratingsText(json(r.ratings_json, {})).replace(/^, /, "")].filter(Boolean).join(", ");
					return `- ${r.name} (${r.year ?? "?"}; ${extra})`;
				})
				.join("\n")
		: "(empty)";
	const candText = candidates.map((c) => `${c.id} | ${c.name}${c.original_name && c.original_name !== c.name ? ` / ${c.original_name}` : ""} | ${c.year ?? "?"} | ${c.overview ?? ""}`).join("\n");
	const system = [
		"You suggest films and shows to one person, for their home media server.",
		`Choose up to ${MAX_PICKS} titles from the candidate list ONLY, the ones this person is most likely to love, best first.`,
		"Judge from their notes first, then from what they actually watched and marked as favourite (the strongest sign of taste), then from what they keep and follow. Skip anything their notes say they avoid.",
		"Only taste counts: genres, moods, makers, countries, themes, titles they love or dislike. Notes about quality, formats, subtitles or downloading say nothing about taste; never use them as a reason.",
		`For each, write one short sentence (under 25 words) in ${lang} saying why it suits THEM, naming the title in their library or the note it connects to. If the link is weak, say so plainly ("popular this week; a change from your usual"). No spoilers, no hype.`,
		'Answer with JSON only: {"picks":[{"id":"movie:123","why":"…"}]}. Use the ids exactly as given. Pick at least 3 when there are that many candidates (fewer only if the rest are things their notes say they avoid); a weak match with an honest reason beats an empty row.',
	].join("\n");
	const user = `Their notes:\n${ownerPreferences(app) || "(none yet)"}\n\nWatched on their media server, most recent first:\n${historyText(history)}\n\nIn their library or followed:\n${libText}\n\nCandidates (id | name | year | overview):\n${candText}`;
	return { system, user };
}

/** Keep only picks the model was offered; at most MAX_PICKS, no duplicates. */
export function parseSuggestions(text: string, candidates: TrendItem[]): Suggestion[] {
	const m = /\{[\s\S]*\}/.exec(text);
	if (!m) throw new Error("the model did not answer with JSON");
	const picks = (JSON.parse(m[0]).picks ?? []) as { id?: unknown; why?: unknown }[];
	const byId = new Map(candidates.map((c) => [c.id, c]));
	const out: Suggestion[] = [];
	for (const p of picks) {
		const c = byId.get(String(p.id ?? "").trim());
		if (!c || out.some((o) => o.id === c.id)) continue;
		out.push({ ...c, reason: String(p.why ?? "").trim().slice(0, 300) });
		if (out.length >= MAX_PICKS) break;
	}
	return out;
}

export function readSuggestions(app: Reelix): Suggestions | undefined {
	try {
		return JSON.parse(readFileSync(suggestionsFile(app), "utf8"));
	} catch {
		return undefined;
	}
}

/** Old, made from other notes or titles, or in another language. */
export async function suggestionsStale(app: Reelix, s: Suggestions | undefined): Promise<boolean> {
	if (!s) return true;
	if (s.state === "failed" || s.state === "no_model") return Date.now() - Date.parse(s.made_at) > 10 * 60_000;
	if (Date.now() - Date.parse(s.made_at) > SUGGESTIONS_MAX_AGE_MS || s.language !== (app.config.language ?? "en")) return true;
	return s.basis !== suggestionBasis(app, await watchHistory(app));
}

export type Complete = (system: string, user: string) => Promise<{ text: string; model: string }>;

/** Make a new list and keep it. `complete` is one model call (the server's router); undefined = no model. */
export async function makeSuggestions(app: Reelix, complete: Complete | undefined): Promise<Suggestions> {
	const history = await watchHistory(app);
	const base = {
		made_at: nowIso(),
		language: app.config.language ?? "en",
		basis: suggestionBasis(app, history),
		items: [] as Suggestion[],
		history: history && { users: history.users, titles: history.titles.length, error: history.error },
	};
	let result: Suggestions;
	if (!ownerPreferences(app) && !libraryForTaste(app).length && !history?.titles.length) result = { ...base, state: "nothing_known" };
	else if (!complete) result = { ...base, state: "no_model" };
	else {
		try {
			const candidates = await suggestionCandidates(app, history);
			const { system, user } = suggestionPrompt(app, candidates, history);
			const answer = await complete(system, user);
			result = { ...base, state: "ok", items: parseSuggestions(answer.text, candidates), model: answer.model };
		} catch (e) {
			const msg = app.redact(errorMessage(e)).slice(0, 300);
			// The router throws TranslationPaused when no model could answer at all.
			result = { ...base, state: e instanceof TranslationPaused ? "no_model" : "failed", error: msg };
		}
	}
	const f = suggestionsFile(app);
	writeFileSync(`${f}.tmp`, JSON.stringify(result, null, 2));
	renameSync(`${f}.tmp`, f);
	return result;
}
