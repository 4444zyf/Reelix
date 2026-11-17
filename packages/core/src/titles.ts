import type { Reelix } from "./app.ts";
import type { TmdbDetails, TmdbKind, TmdbSearchItem } from "./clients/tmdb.ts";
import { json } from "./db.ts";
import { BROWSER_UA, http } from "./http.ts";
import { magnetName } from "./torrent.ts";
import { normName, parseReleaseName, titleVariants } from "./parser.ts";
import { ReelixError, errorMessage, newId, nowIso } from "./util.ts";

export type TitleRow = {
	id: string;
	kind: TmdbKind;
	tmdb_id: number | null;
	media_class: string;
	name: string;
	original_name: string | null;
	folder_name: string | null;
	year: number | null;
	names_json: string;
	imdb_id: string | null;
	douban_id: string | null;
	bangumi_ids_json: string;
	runtime_min: number | null;
	seasons_json: string | null;
	poster_path: string | null;
	rating: number | null;
	douban_rating: number | null;
	overview: string | null;
	notes: string;
	library_folder: string | null;
	updated_at: string;
};

export type Title = Omit<TitleRow, "names_json" | "bangumi_ids_json" | "seasons_json"> & {
	names: string[];
	bangumi_ids: number[];
	seasons: { season_number: number; episode_count: number; air_date?: string | null }[];
};

export function rowToTitle(r: TitleRow): Title {
	const { names_json, bangumi_ids_json, seasons_json, ...rest } = r;
	return { ...rest, names: json(names_json, []), bangumi_ids: json(bangumi_ids_json, []), seasons: json(seasons_json, []) };
}

export function getTitle(app: Reelix, id: string): Title | undefined {
	const r = app.db.prepare("SELECT * FROM titles WHERE id = ?").get(id) as TitleRow | undefined;
	return r ? rowToTitle(r) : undefined;
}

export function requireTitle(app: Reelix, id: string): Title {
	const t = getTitle(app, normaliseTitleId(id));
	if (!t) throw new ReelixError("unknown_title", `No title ${id} is known yet. Identify it first with title_find / \`reelix title find\`.`);
	return t;
}

/** Accept "movie:123", "tv:123", "tmdb:movie:123", "movie/123". */
export function normaliseTitleId(id: string): string {
	const m = /^(?:tmdb[:/])?(movie|tv)[:/](\d+)$/.exec(id.trim());
	return m ? `${m[1]}:${m[2]}` : id.trim();
}

function isLatin(s: string | undefined | null): boolean {
	return !!s && /^[\p{Script=Latin}\d\s\p{P}\p{S}]+$/u.test(s);
}

export function classify(d: TmdbDetails): "movie" | "show" | "anime" {
	if (d.kind === "movie") return "movie";
	const animation = d.genres.some((g) => /animation|动画|動畫/i.test(g));
	const jp = d.original_language === "ja" || d.origin_country?.includes("JP");
	return animation && jp ? "anime" : "show";
}

export function upsertFromTmdb(app: Reelix, d: TmdbDetails): Title {
	const id = `${d.kind}:${d.id}`;
	const existing = getTitle(app, id);
	const folder = isLatin(d.original_title) ? d.original_title : (d.english_title ?? d.original_title);
	const seasons = d.seasons?.map((s) => ({ season_number: s.season_number, episode_count: s.episode_count, air_date: s.air_date }));
	app.db
		.prepare(
			`INSERT INTO titles (id, kind, tmdb_id, media_class, name, original_name, folder_name, year, names_json, imdb_id, runtime_min, seasons_json, poster_path, rating, overview, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET name=excluded.name, original_name=excluded.original_name, folder_name=COALESCE(titles.folder_name, excluded.folder_name),
			   year=excluded.year, names_json=excluded.names_json, imdb_id=COALESCE(excluded.imdb_id, titles.imdb_id), runtime_min=excluded.runtime_min,
			   seasons_json=excluded.seasons_json, poster_path=excluded.poster_path, rating=excluded.rating, overview=excluded.overview, updated_at=excluded.updated_at`,
		)
		.run(
			id,
			d.kind,
			d.id,
			existing?.media_class && existing.media_class !== "auto" ? existing.media_class : classify(d),
			d.title,
			d.original_title,
			folder,
			d.year ?? null,
			JSON.stringify(d.names),
			d.imdb_id ?? null,
			d.runtime ?? d.episode_run_time?.[0] ?? null,
			seasons ? JSON.stringify(seasons) : null,
			d.poster_path ?? null,
			d.vote_average ?? null,
			d.overview ?? null,
			nowIso(),
		);
	return getTitle(app, id)!;
}

export async function fetchTitle(app: Reelix, kind: TmdbKind, tmdbId: number): Promise<Title> {
	const d = await app.tmdb().details(kind, tmdbId);
	return upsertFromTmdb(app, d);
}

export function createLocalTitle(app: Reelix, input: { kind: TmdbKind; name: string; year?: number; folder_name?: string; media_class?: string; names?: string[] }): Title {
	const id = `local:${newId()}`;
	app.db
		.prepare("INSERT INTO titles (id, kind, tmdb_id, media_class, name, original_name, folder_name, year, names_json, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)")
		.run(id, input.kind, input.media_class ?? (input.kind === "movie" ? "movie" : "show"), input.name, input.name, input.folder_name ?? input.name, input.year ?? null, JSON.stringify(input.names ?? [input.name]), nowIso());
	return getTitle(app, id)!;
}

export function addTitleNote(app: Reelix, id: string, note: string): Title {
	const t = requireTitle(app, id);
	const notes = (t.notes ? t.notes + "\n" : "") + `- ${note.trim()} (${nowIso().slice(0, 10)})`;
	app.db.prepare("UPDATE titles SET notes = ?, updated_at = ? WHERE id = ?").run(notes, nowIso(), t.id);
	return getTitle(app, t.id)!;
}

// ------------------------------------------------------------------ identification

export type Candidate = {
	id: string; // movie:123
	kind: TmdbKind;
	tmdb_id: number;
	name: string;
	original_name?: string;
	year?: number;
	overview?: string;
	popularity?: number;
	poster_path?: string | null;
};

export type FindResult = {
	input: string;
	parsed?: ReturnType<typeof parseReleaseName>;
	resolved?: Title; // set when an ID or an exact match settled it
	how?: string;
	candidates: Candidate[];
	note?: string;
};

function toCandidate(x: TmdbSearchItem): Candidate {
	const kind = (x.media_type === "tv" ? "tv" : "movie") as TmdbKind;
	const date = x.release_date ?? x.first_air_date;
	return {
		id: `${kind}:${x.id}`,
		kind,
		tmdb_id: x.id,
		name: x.title ?? x.name ?? "",
		original_name: x.original_title ?? x.original_name,
		year: date ? Number(date.slice(0, 4)) || undefined : undefined,
		overview: x.overview ? x.overview.slice(0, 160) : undefined,
		popularity: x.popularity,
		poster_path: x.poster_path,
	};
}

/**
 * Resolve a name, link or ID to an identity (§5.1). IDs settle it; an exact name match with the
 * year agreeing is accepted by code; anything else returns candidates for the model to weigh.
 */
export async function findTitle(app: Reelix, input: string, opts: { kind?: TmdbKind; year?: number } = {}): Promise<FindResult> {
	const s = input.trim();
	let m: RegExpExecArray | null;

	if ((m = /themoviedb\.org\/(movie|tv)\/(\d+)/.exec(s)) || (m = /^(?:tmdb[:/])?(movie|tv)[:/](\d+)$/.exec(s))) {
		return { input: s, resolved: await fetchTitle(app, m[1] as TmdbKind, Number(m[2])), how: "TMDB ID", candidates: [] };
	}
	if ((m = /(tt\d{6,})/.exec(s))) {
		const f = await app.tmdb().find(m[1]!, "imdb_id");
		if (!f) return { input: s, candidates: [], note: `TMDB has nothing for IMDb ${m[1]}` };
		return { input: s, resolved: await fetchTitle(app, f.kind, f.id), how: "IMDb ID", candidates: [] };
	}
	if ((m = /movie\.douban\.com\/subject\/(\d+)/.exec(s)) || (m = /^douban:(\d+)$/.exec(s))) {
		const doubanId = m[1]!;
		const page = await doubanPage(app, doubanId);
		if (page.imdb) {
			const f = await app.tmdb().find(page.imdb, "imdb_id");
			if (f) {
				const t = await fetchTitle(app, f.kind, f.id);
				linkDouban(app, t.id, doubanId, page.rating);
				return { input: s, resolved: getTitle(app, t.id), how: "Douban page → IMDb ID", candidates: [] };
			}
		}
		if (page.title) {
			const r = await findTitle(app, page.title, { year: page.year });
			return { ...r, input: s, note: `Douban page gave "${page.title}" ${page.year ?? ""}; no IMDb ID to settle it.` };
		}
		return { input: s, candidates: [], note: "Could not read the Douban page (it may need the browser)." };
	}
	if ((m = /(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/(\d+)/.exec(s)) || (m = /^bangumi:(\d+)$/.exec(s))) {
		const subj = await app.bangumi().subject(Number(m[1]));
		const year = subj.date ? Number(subj.date.slice(0, 4)) : undefined;
		const r = await findTitle(app, subj.name, { kind: "tv", year });
		const r2 = r.resolved || r.candidates.length ? r : await findTitle(app, subj.name_cn || subj.name, { year });
		if (r2.resolved) linkBangumi(app, r2.resolved.id, subj.id);
		return { ...r2, input: s, note: `Bangumi entry ${subj.id}: ${subj.name}${subj.name_cn ? ` / ${subj.name_cn}` : ""} (${subj.date ?? "?"}), ${subj.eps ?? "?"} episodes. Bangumi has one entry per season; check which TMDB season it is.` };
	}

	// magnet or release name: read the name
	let query = s;
	let parsed: ReturnType<typeof parseReleaseName> | undefined;
	if (s.startsWith("magnet:")) query = magnetName(s) ?? "";
	if (/[._]|\b(1080p|2160p|720p|S\d\dE\d\d|WEB|BluRay)\b/i.test(query) || s.startsWith("magnet:")) {
		parsed = parseReleaseName(query);
		if (parsed.title) query = parsed.title;
	}
	let year = opts.year ?? parsed?.year;
	const ym = /^(.*?)[\s(（]+((?:19|20)\d{2})[)）]?\s*$/.exec(query);
	if (ym && ym[1]!.trim()) {
		query = ym[1]!.trim();
		year ??= Number(ym[2]);
	}
	const kind = opts.kind ?? (parsed?.season !== undefined || parsed?.episodes ? "tv" : undefined);
	const variants = titleVariants(query);
	const seen = new Map<string, Candidate>();
	for (const v of variants) {
		try {
			for (const x of await app.tmdb().search(v, kind)) {
				const c = toCandidate(x);
				if (!seen.has(c.id)) seen.set(c.id, c);
			}
		} catch (e) {
			if (e instanceof ReelixError && e.code === "network") throw e; // never store a network failure as "not found"
			throw e;
		}
	}
	let candidates = [...seen.values()];
	if (year) candidates.sort((a, b) => Math.abs((a.year ?? 0) - year!) - Math.abs((b.year ?? 0) - year!) || (b.popularity ?? 0) - (a.popularity ?? 0));
	else candidates.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
	candidates = candidates.slice(0, 8);

	// Cheap code path: exact name match (any variant) with the year agreeing → accept without the model.
	const wanted = new Set(variants.map(normName));
	const exact = candidates.filter((c) => (wanted.has(normName(c.name)) || (c.original_name && wanted.has(normName(c.original_name)))) && (!year || c.year === year || (c.year && Math.abs(c.year - year) <= 0)));
	if (exact.length === 1 && year) {
		return { input: s, parsed, resolved: await fetchTitle(app, exact[0]!.kind, exact[0]!.tmdb_id), how: "exact name and year", candidates };
	}
	return { input: s, parsed, candidates, note: candidates.length ? "Several candidates or no year: weigh the evidence (years, type, overview) and pick one with title_find id=…" : "TMDB found nothing. Try another name (English/original), or create a local-only title." };
}

export function linkDouban(app: Reelix, titleId: string, doubanId: string, rating?: number): void {
	app.db.prepare("UPDATE titles SET douban_id = ?, douban_rating = COALESCE(?, douban_rating), updated_at = ? WHERE id = ?").run(doubanId, rating ?? null, nowIso(), titleId);
}

export function linkBangumi(app: Reelix, titleId: string, bangumiId: number): void {
	const t = getTitle(app, titleId);
	if (!t) return;
	const ids = [...new Set([...t.bangumi_ids, bangumiId])];
	app.db.prepare("UPDATE titles SET bangumi_ids_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(ids), nowIso(), titleId);
}

/** Read Douban's ordinary public page (decision F): rating, Chinese title, IMDb ID. Best effort. */
export async function doubanPage(app: Reelix, doubanId: string): Promise<{ title?: string; year?: number; rating?: number; imdb?: string; error?: string }> {
	try {
		const res = await http(`https://movie.douban.com/subject/${doubanId}/`, { headers: { "user-agent": BROWSER_UA, "accept-language": "zh-CN,zh;q=0.9" }, timeoutMs: 15_000 });
		if (!res.ok) return { error: `HTTP ${res.status}` };
		const html = await res.text();
		const title = /<span property="v:itemreviewed">([^<]+)<\/span>/.exec(html)?.[1]?.trim();
		const year = Number(/<span class="year">\((\d{4})\)<\/span>/.exec(html)?.[1]) || undefined;
		const rating = Number(/property="v:average">([\d.]+)</.exec(html)?.[1]) || undefined;
		const imdb = /IMDb:<\/span>\s*(tt\d+)/.exec(html)?.[1];
		return { title, year, rating, imdb };
	} catch (e) {
		return { error: errorMessage(e) };
	}
}

export function titleSummary(t: Title): string {
	const ids = [t.tmdb_id ? `tmdb ${t.kind}/${t.tmdb_id}` : "local-only", t.imdb_id, t.douban_id ? `douban ${t.douban_id}` : null, t.bangumi_ids.length ? `bangumi ${t.bangumi_ids.join(",")}` : null].filter(Boolean).join(", ");
	const seasons = t.kind === "tv" && t.seasons.length ? `\nseasons: ${t.seasons.filter((s) => s.season_number > 0).map((s) => `S${s.season_number}=${s.episode_count}ep`).join(" ")}` : "";
	return `${t.id}: ${t.name}${t.original_name && t.original_name !== t.name ? ` / ${t.original_name}` : ""} (${t.year ?? "?"}) [${t.media_class}] — ${ids}${t.runtime_min ? `, ${t.runtime_min} min` : ""}${t.rating ? `, TMDB ${t.rating.toFixed(1)}` : ""}${t.douban_rating ? `, Douban ${t.douban_rating}` : ""}${seasons}${t.notes ? `\nnotes:\n${t.notes}` : ""}`;
}
