import { http, expectOk } from "../http.ts";
import { ReelixError } from "../util.ts";

export type TmdbKind = "movie" | "tv";

export type TmdbSearchItem = {
	id: number;
	media_type?: string;
	title?: string;
	name?: string;
	original_title?: string;
	original_name?: string;
	release_date?: string;
	first_air_date?: string;
	overview?: string;
	poster_path?: string | null;
	popularity?: number;
	vote_average?: number;
	original_language?: string;
	genre_ids?: number[];
	origin_country?: string[];
};

export type TmdbDetails = {
	id: number;
	kind: TmdbKind;
	title: string; // localised
	original_title: string;
	english_title?: string;
	year?: number;
	runtime?: number;
	episode_run_time?: number[];
	overview?: string;
	poster_path?: string | null;
	vote_average?: number;
	original_language?: string;
	genres: string[];
	origin_country?: string[];
	imdb_id?: string;
	names: string[];
	/** The Simplified Chinese title, if TMDB has one (for Chinese subtitle sites). */
	zh_title?: string;
	seasons?: { season_number: number; episode_count: number; air_date?: string | null; name?: string }[];
	status?: string;
	next_episode_to_air?: { season_number: number; episode_number: number; air_date: string } | null;
	episode_groups?: { id: string; name: string; type: number; group_count: number; episode_count: number }[];
	raw: Record<string, unknown>;
};

export class TmdbClient {
	base: string;
	key: string;
	language: string;
	proxy?: string;

	constructor(opts: { key: string; baseUrl?: string; language?: string; proxy?: string }) {
		if (!opts.key) throw new ReelixError("tmdb_no_key", "No TMDB API key is set. Add one with `reelix secret set tmdb.api_key` or in Settings.");
		this.base = (opts.baseUrl ?? "https://api.themoviedb.org/3").replace(/\/+$/, "");
		this.key = opts.key;
		this.language = opts.language ?? "zh-CN";
		this.proxy = opts.proxy;
	}

	private async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
		const qs = new URLSearchParams();
		const bearer = this.key.startsWith("eyJ");
		if (!bearer) qs.set("api_key", this.key);
		for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
		const headers: Record<string, string> = { accept: "application/json" };
		if (bearer) headers.authorization = `Bearer ${this.key}`;
		const res = await http(`${this.base}${path}?${qs}`, { headers, proxy: this.proxy, timeoutMs: 15_000 });
		if (res.status === 404) throw new ReelixError("not_found", `TMDB has no ${path}`);
		if (res.status === 401) throw new ReelixError("tmdb_auth", "TMDB rejected the API key.");
		await expectOk(res, `TMDB ${path}`);
		return res.json<T>();
	}

	async search(query: string, kind?: TmdbKind, year?: number): Promise<TmdbSearchItem[]> {
		if (kind === "movie") {
			const r = await this.get<{ results: TmdbSearchItem[] }>("/search/movie", { query, language: this.language, year, include_adult: "false" });
			return r.results.map((x) => ({ ...x, media_type: "movie" }));
		}
		if (kind === "tv") {
			const r = await this.get<{ results: TmdbSearchItem[] }>("/search/tv", { query, language: this.language, first_air_date_year: year, include_adult: "false" });
			return r.results.map((x) => ({ ...x, media_type: "tv" }));
		}
		const r = await this.get<{ results: TmdbSearchItem[] }>("/search/multi", { query, language: this.language, include_adult: "false" });
		return r.results.filter((x) => x.media_type === "movie" || x.media_type === "tv");
	}

	/** TMDB's trending list (films and shows only), in the client's language. */
	async trending(kind: "all" | TmdbKind = "all", window: "day" | "week" = "week"): Promise<TmdbSearchItem[]> {
		const r = await this.get<{ results: TmdbSearchItem[] }>(`/trending/${kind}/${window}`, { language: this.language });
		return r.results.map((x) => (kind === "all" ? x : { ...x, media_type: kind })).filter((x) => x.media_type === "movie" || x.media_type === "tv");
	}

	/** Titles TMDB recommends for people who liked this one. */
	async recommendations(kind: TmdbKind, id: number): Promise<TmdbSearchItem[]> {
		const r = await this.get<{ results: TmdbSearchItem[] }>(`/${kind}/${id}/recommendations`, { language: this.language });
		return r.results.map((x) => ({ ...x, media_type: x.media_type ?? kind })).filter((x) => x.media_type === "movie" || x.media_type === "tv");
	}

	async find(externalId: string, source: "imdb_id" | "tvdb_id"): Promise<{ kind: TmdbKind; id: number } | undefined> {
		const r = await this.get<{ movie_results: { id: number }[]; tv_results: { id: number }[] }>(`/find/${encodeURIComponent(externalId)}`, { external_source: source });
		if (r.movie_results[0]) return { kind: "movie", id: r.movie_results[0].id };
		if (r.tv_results[0]) return { kind: "tv", id: r.tv_results[0].id };
		return undefined;
	}

	async details(kind: TmdbKind, id: number): Promise<TmdbDetails> {
		const append = kind === "movie" ? "alternative_titles,translations,external_ids" : "alternative_titles,translations,external_ids,episode_groups";
		const raw = await this.get<Record<string, any>>(`/${kind}/${id}`, { language: this.language, append_to_response: append });
		const names = new Set<string>();
		const add = (s?: string) => s && s.trim() && names.add(s.trim());
		add(raw.title ?? raw.name);
		add(raw.original_title ?? raw.original_name);
		for (const t of raw.alternative_titles?.titles ?? raw.alternative_titles?.results ?? []) add(t.title);
		let english: string | undefined;
		const translations: any[] = raw.translations?.translations ?? [];
		// The Simplified Chinese title goes first: Chinese subtitle sites search by it, whatever the owner's language.
		const zh = translations.find((t) => t.iso_639_1 === "zh" && t.iso_3166_1 === "CN") ?? translations.find((t) => t.iso_639_1 === "zh");
		const zhTitle: string | undefined = zh?.data?.title || zh?.data?.name || undefined;
		const ordered = new Set<string>();
		if (zhTitle) ordered.add(zhTitle.trim());
		for (const t of translations) {
			const tt = t.data?.title ?? t.data?.name;
			add(tt);
			if (t.iso_639_1 === "en" && tt) english = tt;
		}
		const date: string | undefined = raw.release_date ?? raw.first_air_date;
		return {
			id,
			kind,
			title: raw.title ?? raw.name,
			original_title: raw.original_title ?? raw.original_name,
			english_title: english,
			year: date ? Number(date.slice(0, 4)) || undefined : undefined,
			runtime: raw.runtime ?? undefined,
			episode_run_time: raw.episode_run_time,
			overview: raw.overview,
			poster_path: raw.poster_path,
			vote_average: raw.vote_average,
			original_language: raw.original_language,
			genres: (raw.genres ?? []).map((g: { name: string }) => g.name),
			origin_country: raw.origin_country,
			imdb_id: raw.external_ids?.imdb_id ?? raw.imdb_id ?? undefined,
			names: [...new Set([...ordered, ...names])],
			zh_title: zhTitle,
			seasons: raw.seasons?.map((s: any) => ({ season_number: s.season_number, episode_count: s.episode_count, air_date: s.air_date, name: s.name })),
			status: raw.status,
			next_episode_to_air: raw.next_episode_to_air,
			episode_groups: raw.episode_groups?.results,
			raw,
		};
	}

	async season(tvId: number, season: number): Promise<{ episodes: { episode_number: number; air_date: string | null; name: string; runtime?: number | null }[] }> {
		return this.get(`/tv/${tvId}/season/${season}`, { language: this.language });
	}

	async episodeGroup(groupId: string): Promise<{ groups: { name: string; order: number; episodes: { season_number: number; episode_number: number; order: number; air_date?: string }[] }[] }> {
		return this.get(`/tv/episode_group/${groupId}`, { language: this.language });
	}
}
