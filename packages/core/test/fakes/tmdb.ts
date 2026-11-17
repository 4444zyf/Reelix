import { sendJson, startServer } from "./server.ts";

/**
 * A fake TMDB v3 API with a few canned titles. Overviews are made up for tests.
 * Localised fields follow the `language` parameter (zh-CN or English).
 */

type Canned = {
	kind: "movie" | "tv";
	id: number;
	title: string; // English
	zh: string;
	original: string;
	original_language: string;
	origin_country: string[];
	date: string;
	runtime?: number;
	episode_run_time?: number[];
	genres: { id: number; en: string; zh: string }[];
	imdb: string;
	alt: string[];
	overview: string;
	popularity: number;
	seasons?: { season_number: number; episode_count: number; air_date: string }[];
	status?: string;
};

const ANIMATION = { id: 16, en: "Animation", zh: "动画" };
const FANTASY = { id: 14, en: "Fantasy", zh: "奇幻" };
const DRAMA = { id: 18, en: "Drama", zh: "剧情" };
const HISTORY = { id: 36, en: "History", zh: "历史" };
const MYSTERY = { id: 9648, en: "Mystery", zh: "悬疑" };

export const CANNED: Canned[] = [
	{
		kind: "movie",
		id: 45745,
		title: "Sintel",
		zh: "辛特尔",
		original: "Sintel",
		original_language: "en",
		origin_country: ["NL"],
		date: "2010-09-27",
		runtime: 15,
		genres: [ANIMATION, FANTASY],
		imdb: "tt1727587",
		alt: ["Durian"],
		overview: "A short test overview: a young woman searches far and wide for a small creature she once looked after.",
		popularity: 12.5,
	},
	{
		kind: "movie",
		id: 872585,
		title: "Oppenheimer",
		zh: "奥本海默",
		original: "Oppenheimer",
		original_language: "en",
		origin_country: ["US"],
		date: "2023-07-19",
		runtime: 181,
		genres: [DRAMA, HISTORY],
		imdb: "tt15398776",
		alt: [],
		overview: "A test overview about a physicist and a very large wartime project.",
		popularity: 80.1,
	},
	{
		kind: "tv",
		id: 95396,
		title: "Severance",
		zh: "人生切割术",
		original: "Severance",
		original_language: "en",
		origin_country: ["US"],
		date: "2022-02-17",
		episode_run_time: [55],
		genres: [DRAMA, MYSTERY],
		imdb: "tt11280740",
		alt: [],
		overview: "A test overview about office workers whose work and home memories are kept apart.",
		popularity: 60.3,
		seasons: [
			{ season_number: 1, episode_count: 9, air_date: "2022-02-17" },
			{ season_number: 2, episode_count: 10, air_date: "2025-01-16" },
		],
		status: "Returning Series",
	},
	{
		kind: "tv",
		id: 209867,
		title: "Frieren: Beyond Journey's End",
		zh: "葬送的芙莉莲",
		original: "葬送のフリーレン",
		original_language: "ja",
		origin_country: ["JP"],
		date: "2023-09-29",
		episode_run_time: [24],
		genres: [ANIMATION, FANTASY],
		imdb: "tt22248376",
		alt: ["Sousou no Frieren", "Frieren"],
		overview: "A test overview about an elf who outlives her companions and sets out again.",
		popularity: 45.2,
		seasons: [{ season_number: 1, episode_count: 28, air_date: "2023-09-29" }],
		status: "Returning Series",
	},
];

export type FakeTmdb = { url: string; apiKey: string; requests: string[]; close(): Promise<void> };

const nm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export async function startFakeTmdb(opts: { apiKey?: string } = {}): Promise<FakeTmdb> {
	const apiKey = opts.apiKey ?? "tmdb-test-key";
	const requests: string[] = [];

	const localTitle = (c: Canned, lang: string) => (lang.startsWith("zh") ? c.zh : c.title);
	const searchItem = (c: Canned, lang: string) => {
		const common = {
			id: c.id,
			overview: c.overview,
			poster_path: `/${c.id}.jpg`,
			popularity: c.popularity,
			vote_average: 7.5,
			original_language: c.original_language,
			genre_ids: c.genres.map((g) => g.id),
		};
		return c.kind === "movie"
			? { ...common, title: localTitle(c, lang), original_title: c.original, release_date: c.date }
			: { ...common, name: localTitle(c, lang), original_name: c.original, first_air_date: c.date, origin_country: c.origin_country };
	};
	const matches = (c: Canned, query: string) => {
		const q = nm(query);
		return !!q && [c.title, c.zh, c.original, ...c.alt].some((n) => nm(n).includes(q));
	};

	const server = await startServer((req, res) => {
		requests.push(req.url.pathname + req.url.search);
		const sp = req.url.searchParams;
		const bearer = String(req.headers.authorization ?? "");
		if (sp.get("api_key") !== apiKey && bearer !== `Bearer ${apiKey}`) return sendJson(res, 401, { status_code: 7, status_message: "Invalid API key: You must be granted a valid key.", success: false });
		const lang = sp.get("language") ?? "en-US";
		const p = req.url.pathname.replace(/^\/3/, "");
		const notFound = () => sendJson(res, 404, { status_code: 34, status_message: "The resource you requested could not be found.", success: false });
		const page = (items: unknown[]) => sendJson(res, 200, { page: 1, results: items, total_pages: 1, total_results: items.length });
		let m: RegExpExecArray | null;

		if (p === "/search/movie" || p === "/search/tv" || p === "/search/multi") {
			const query = sp.get("query") ?? "";
			const kind = p === "/search/movie" ? "movie" : p === "/search/tv" ? "tv" : undefined;
			const year = Number(sp.get(kind === "tv" ? "first_air_date_year" : "year")) || undefined;
			const hits = CANNED.filter((c) => (!kind || c.kind === kind) && matches(c, query) && (!year || c.date.startsWith(String(year))));
			return page(hits.map((c) => (kind ? searchItem(c, lang) : { ...searchItem(c, lang), media_type: c.kind })));
		}
		if ((m = /^\/find\/(tt\d+)$/.exec(p))) {
			const hits = sp.get("external_source") === "imdb_id" ? CANNED.filter((c) => c.imdb === m![1]) : [];
			return sendJson(res, 200, {
				movie_results: hits.filter((c) => c.kind === "movie").map((c) => ({ ...searchItem(c, lang), media_type: "movie" })),
				tv_results: hits.filter((c) => c.kind === "tv").map((c) => ({ ...searchItem(c, lang), media_type: "tv" })),
				person_results: [],
				tv_episode_results: [],
				tv_season_results: [],
			});
		}
		if ((m = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(p))) {
			const c = CANNED.find((x) => x.kind === "tv" && x.id === Number(m![1]));
			const s = c?.seasons?.find((x) => x.season_number === Number(m![2]));
			if (!c || !s) return notFound();
			const start = Date.parse(s.air_date);
			return sendJson(res, 200, {
				id: c.id * 100 + s.season_number,
				season_number: s.season_number,
				name: `Season ${s.season_number}`,
				air_date: s.air_date,
				episodes: Array.from({ length: s.episode_count }, (_, i) => ({
					episode_number: i + 1,
					season_number: s.season_number,
					name: `Episode ${i + 1}`,
					air_date: new Date(start + i * 7 * 86400_000).toISOString().slice(0, 10),
					runtime: c.episode_run_time?.[0] ?? null,
				})),
			});
		}
		if ((m = /^\/(movie|tv)\/(\d+)$/.exec(p))) {
			const c = CANNED.find((x) => x.kind === m![1] && x.id === Number(m![2]));
			if (!c) return notFound();
			const append = new Set((sp.get("append_to_response") ?? "").split(",").filter(Boolean));
			const zh = lang.startsWith("zh");
			const body: Record<string, unknown> = {
				id: c.id,
				overview: c.overview,
				poster_path: `/${c.id}.jpg`,
				vote_average: 7.5,
				original_language: c.original_language,
				origin_country: c.origin_country,
				genres: c.genres.map((g) => ({ id: g.id, name: zh ? g.zh : g.en })),
				status: c.status ?? "Released",
			};
			if (c.kind === "movie") Object.assign(body, { title: localTitle(c, lang), original_title: c.original, release_date: c.date, runtime: c.runtime, imdb_id: c.imdb });
			else
				Object.assign(body, {
					name: localTitle(c, lang),
					original_name: c.original,
					first_air_date: c.date,
					episode_run_time: c.episode_run_time ?? [],
					number_of_seasons: c.seasons?.length ?? 0,
					seasons: (c.seasons ?? []).map((s) => ({ ...s, id: c.id * 100 + s.season_number, name: `Season ${s.season_number}` })),
					next_episode_to_air: null,
				});
			const altKey = c.kind === "movie" ? "titles" : "results";
			if (append.has("alternative_titles")) body.alternative_titles = { [altKey]: c.alt.map((t) => ({ iso_3166_1: "US", title: t, type: "" })) };
			if (append.has("translations"))
				body.translations = {
					translations: [
						{ iso_3166_1: "US", iso_639_1: "en", name: "English", data: c.kind === "movie" ? { title: c.title, overview: c.overview } : { name: c.title, overview: c.overview } },
						{ iso_3166_1: "CN", iso_639_1: "zh", name: "普通话", data: c.kind === "movie" ? { title: c.zh, overview: "" } : { name: c.zh, overview: "" } },
					],
				};
			if (append.has("external_ids")) body.external_ids = { imdb_id: c.imdb, tvdb_id: null, wikidata_id: null };
			if (append.has("episode_groups")) body.episode_groups = { results: [] };
			return sendJson(res, 200, body);
		}
		return notFound();
	});
	return { url: server.url, apiKey, requests, close: server.close };
}
