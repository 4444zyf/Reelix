import type { Call, SubtitleHit } from "@reelix/plugin";
import { type Site, SiteAnswer, base, get, json, pace, source, text, unavailable } from "./shared.ts";

const UA = "Reelix v0.1";
/** The day of the login token, which is kept as a secret so that it is redacted everywhere. */
const TOKEN_DAY = "opensubtitles.token_day";
const TOKEN_SECRET = "opensubtitles_token";
const today = () => new Date().toISOString().slice(0, 10);
const imdbNumber = (id?: string) => (id ? String(Number(id.replace(/^tt/, ""))) : undefined);

/** OpenSubtitles.com (REST v1): movies and TV in every language, with file-hash matching. */
export function opensubtitles(s: Site) {
	/** Today's login token, if an account is configured and has logged in today. */
	const token = async () => {
		return (await s.ctx.kv.get<string>(TOKEN_DAY)) === today() ? s.ctx.secret.get(TOKEN_SECRET) : undefined;
	};

	async function request<T = any>(path: string, call: Call, init: { method?: string; params?: Record<string, string | undefined>; body?: unknown; auth?: boolean } = {}): Promise<T> {
		await pace(s, "opensubtitles", 1100, call); // their limit: 5 requests a second; be gentler
		// The API wants lower-case parameters in alphabetical order (otherwise it redirects).
		const qs = Object.entries(init.params ?? {})
			.filter(([, v]) => v !== undefined && v !== "")
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${k}=${encodeURIComponent(String(v).toLowerCase())}`)
			.join("&");
		const headers: Record<string, string> = { "api-key": (await s.ctx.secret.get("opensubtitles_api_key")) ?? "", "user-agent": UA, accept: "application/json" };
		if (init.body) headers["content-type"] = "application/json";
		const bearer = init.auth ? await token() : undefined;
		if (bearer) headers.authorization = `Bearer ${bearer}`;
		const res = await get(s, "opensubtitles", `${base(s.settings.opensubtitles_url)}${path}${qs ? `?${qs}` : ""}`, call, { method: init.method, headers, body: init.body ? JSON.stringify(init.body) : undefined });
		if (res.status === 401 || res.status === 403) {
			await s.ctx.kv.delete(TOKEN_DAY); // the next call logs in again instead of keeping a refused token all day
			throw new SiteAnswer({ outcome: "needs_auth" });
		}
		if (res.status === 406 || res.status === 429) {
			const j = json(res, "OpenSubtitles");
			throw new SiteAnswer({ outcome: "rate_limited", until: j.reset_time_utc });
		}
		if (!res.ok) throw unavailable(`OpenSubtitles: HTTP ${res.status} ${text(res).slice(0, 200)}`);
		return json<T>(res, "OpenSubtitles");
	}

	/** Log in once a day when an account is configured (more downloads than the key alone). */
	async function login(call: Call): Promise<void> {
		const username = await s.ctx.secret.get("opensubtitles_username");
		const password = await s.ctx.secret.get("opensubtitles_password");
		if (!username || !password || (await token())) return;
		const j = await request<{ token: string }>("/login", call, { method: "POST", body: { username, password } });
		await s.ctx.secret.set(TOKEN_SECRET, j.token);
		await s.ctx.kv.set(TOKEN_DAY, today());
	}

	return source({
		id: "opensubtitles",
		label: "OpenSubtitles",
		kinds: ["movie", "show", "anime"],
		languages: ["en", "fr", "ru", "zh", "ja"],
		needsSecrets: ["opensubtitles_api_key"],
		async search(q, call) {
			const params: Record<string, string | undefined> = { languages: q.languages.map((l) => (l === "zh" ? "zh-cn,zh-tw" : l)).join(",") };
			const tmdb = q.ids.tmdb ? String(q.ids.tmdb) : undefined;
			if (q.text) params.query = q.text;
			else if (q.series) Object.assign(params, { parent_tmdb_id: tmdb, season_number: q.season?.toString(), episode_number: q.episodes?.length === 1 ? String(q.episodes[0]) : undefined, type: "episode" });
			else Object.assign(params, { tmdb_id: tmdb, imdb_id: imdbNumber(q.ids.imdb), type: "movie" });
			if (q.videoHash) params.moviehash = q.videoHash;
			const j = await request<{ data: any[] }>("/subtitles", call, { params });
			return (j.data ?? []).slice(0, 25).map((d): SubtitleHit => {
				const a = d.attributes ?? {};
				const f = a.feature_details ?? {};
				const file = a.files?.[0];
				const lang = String(a.language ?? "").toLowerCase();
				return {
					ref: String(file?.file_id ?? d.id),
					name: f.title ?? f.movie_name ?? q.names[0] ?? "",
					release: a.release ?? file?.file_name ?? "",
					languages: [lang],
					language: lang.startsWith("zh") ? "zh" : lang.slice(0, 2),
					formats: [String(file?.file_name ?? "").split(".").pop()?.toUpperCase() || "SRT"],
					tags: [a.from_trusted ? "trusted" : "", a.hd ? "HD" : ""].filter(Boolean),
					downloads: a.download_count,
					date: a.upload_date,
					uploader: a.uploader?.name,
					season: f.season_number ?? undefined,
					episode: f.episode_number ?? undefined,
					hearingImpaired: !!a.hearing_impaired,
					machine: !!(a.machine_translated || a.ai_translated),
					hashMatch: !!a.moviehash_match,
				};
			});
		},
		async download(id, call) {
			await login(call).catch(() => undefined); // the key alone still works, with a smaller quota
			const j = await request<{ link: string; file_name: string }>("/download", call, { method: "POST", body: { file_id: Number(id) }, auth: true });
			const res = await get(s, "opensubtitles", j.link, call, { timeoutMs: 60_000 });
			if (!res.ok) throw unavailable(`OpenSubtitles download failed: HTTP ${res.status}`);
			return { bytes: res.bytes, filename: j.file_name ?? `${id}.srt` };
		},
	});
}
