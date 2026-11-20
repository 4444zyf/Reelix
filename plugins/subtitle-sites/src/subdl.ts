import type { SubtitleHit } from "@reelix/plugin";
import { type Site, SiteAnswer, base, get, json, pace, source, unavailable } from "./shared.ts";

const LANGUAGE: Record<string, string> = { en: "EN", fr: "FR", ru: "RU", zh: "ZH", ja: "JA" };

/** SubDL: movies and TV, many languages, by TMDB id. */
export function subdl(s: Site) {
	return source({
		id: "subdl",
		label: "SubDL",
		kinds: ["movie", "show", "anime"],
		languages: ["en", "fr", "ru", "zh", "ja"],
		needsSecrets: ["subdl_api_key"],
		async search(q, call) {
			await pace(s, "subdl", 1100, call);
			const params = new URLSearchParams({ api_key: (await s.ctx.secret.get("subdl_api_key")) ?? "", languages: q.languages.map((l) => LANGUAGE[l]!).join(","), subs_per_page: "30" });
			if (q.text) params.set("film_name", q.text);
			else if (q.ids.tmdb) params.set("tmdb_id", String(q.ids.tmdb));
			else params.set("film_name", q.names[0] ?? "");
			params.set("type", q.series ? "tv" : "movie");
			if (q.series && q.season !== undefined) params.set("season_number", String(q.season));
			if (q.series && q.episodes?.length === 1) params.set("episode_number", String(q.episodes[0]));
			const res = await get(s, "subdl", `${base(s.settings.subdl_url)}/subtitles?${params}`, call);
			const j = json(res, "SubDL");
			if (res.status === 403 || j.error === "not_authorized") throw new SiteAnswer({ outcome: "needs_auth" });
			if (j.status === false) {
				if (/not found|no subtitle/i.test(String(j.error ?? ""))) return [];
				throw unavailable(`SubDL: ${j.error ?? j.message ?? `HTTP ${res.status}`}`);
			}
			return (j.subtitles ?? []).map((x: any): SubtitleHit => {
				const lang = String(x.language ?? x.lang ?? "").toLowerCase();
				return {
					ref: String(x.url ?? "").replace(/^\/?subtitle\//, ""),
					name: x.name ?? q.names[0] ?? "",
					release: x.release_name ?? "",
					languages: [x.lang ?? x.language ?? ""],
					language: lang.startsWith("zh") || /chinese/.test(lang) ? "zh" : lang.slice(0, 2),
					tags: x.full_season ? ["season pack"] : [],
					uploader: x.author,
					season: x.season ?? undefined,
					episode: x.episode ?? undefined,
					hearingImpaired: !!x.hi,
				};
			});
		},
		async download(id, call) {
			const res = await get(s, "subdl", `${base(s.settings.subdl_download_url)}/subtitle/${id}`, call, { timeoutMs: 60_000 });
			if (!res.ok) throw unavailable(`SubDL download failed: HTTP ${res.status}`);
			return { bytes: res.bytes, filename: id.split("/").pop() ?? `${id}.zip` };
		},
	});
}
