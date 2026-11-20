import { send, sendJson, startServer } from "../../../packages/core/test/fakes/server.ts";

/**
 * One fake for the international subtitle sources (OpenSubtitles v1, SubDL, Gestdown, Jimaku),
 * shaped like their APIs. Severance (TMDB 95396) S01E01–E02 and Sintel (TMDB 45745) have
 * French, English and Russian subtitles; Frieren has Japanese files on Jimaku.
 */
export const FR_SRT = `1\n00:00:01,000 --> 00:00:02,000\nJe ne sais pas ce que vous voulez.\n\n2\n00:00:03,000 --> 00:00:04,000\nC'est une bonne nouvelle, et je suis là.\n\n`.repeat(10);
export const EN_SRT = `1\n00:00:01,000 --> 00:00:02,000\nI don't know what you want from me.\n\n2\n00:00:03,000 --> 00:00:04,000\nThis is good news and I'm here.\n\n`.repeat(10);
export const RU_SRT = `1\n00:00:01,000 --> 00:00:02,000\nЯ не знаю, чего вы хотите.\n\n2\n00:00:03,000 --> 00:00:04,000\nЭто хорошие новости, и я здесь.\n\n`.repeat(10);

export async function startFakeSubtitleSites(opts: { osKey?: string; subdlKey?: string; jimakuKey?: string } = {}) {
	const osKey = opts.osKey ?? "os-key";
	const subdlKey = opts.subdlKey ?? "subdl-key";
	const jimakuKey = opts.jimakuKey ?? "jimaku-key";
	const requests: string[] = [];
	const body = (lang: string) => (lang === "fr" ? FR_SRT : lang === "ru" ? RU_SRT : EN_SRT);
	const srv = await startServer((req, res) => {
		const u = req.url;
		requests.push(`${req.method} ${u.pathname}${u.search}`);
		const p = u.pathname;
		// ---------------- OpenSubtitles /os/api/v1
		if (p.startsWith("/os/")) {
			if (req.headers["api-key"] !== osKey) return sendJson(res, 403, { message: "You cannot consume this service" });
			const keys = [...u.searchParams.keys()];
			if (keys.join() !== [...keys].sort().join()) return send(res, 301, "", { location: "/sorted" });
			if (p === "/os/api/v1/subtitles") {
				const langs = (u.searchParams.get("languages") ?? "").split(",");
				const tv = u.searchParams.get("parent_tmdb_id") === "95396";
				const movie = u.searchParams.get("tmdb_id") === "45745";
				if (!tv && !movie) return sendJson(res, 200, { total_count: 0, data: [] });
				const data = langs.flatMap((l, i) =>
					(tv ? [1, 2] : [0]).map((ep) => ({
						id: `${l}${ep}`,
						attributes: {
							language: l,
							download_count: 100 - i,
							release: tv ? `Severance.S01E0${ep}.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb` : "Sintel.2010.1080p.BluRay.x264-GRP",
							upload_date: "2024-01-02T00:00:00Z",
							hearing_impaired: false,
							machine_translated: l === "ru",
							moviehash_match: !tv && !!u.searchParams.get("moviehash"),
							feature_details: tv ? { title: "Good News About Hell", season_number: 1, episode_number: ep } : { title: "Sintel", year: 2010 },
							files: [{ file_id: 9000 + i * 10 + ep, file_name: `${tv ? `S01E0${ep}` : "Sintel"}.${l}.srt` }],
						},
					})),
				);
				return sendJson(res, 200, { total_count: data.length, data });
			}
			if (p === "/os/api/v1/download" && req.method === "POST") {
				const { file_id } = JSON.parse(req.body.toString());
				return sendJson(res, 200, { link: `${srv.url}/os-files/${file_id}`, file_name: `${file_id}.srt`, remaining: 4 });
			}
		}
		if (p.startsWith("/os-files/")) {
			const id = Number(p.split("/").pop());
			const lang = ["fr", "en", "ru"][Math.floor((id - 9000) / 10)] ?? "en";
			return send(res, 200, body(lang));
		}
		// ---------------- SubDL /subdl/api/v1 + /subdl-dl
		if (p === "/subdl/api/v1/subtitles") {
			if (u.searchParams.get("api_key") !== subdlKey) return sendJson(res, 403, { status: false, statusCode: 403, error: "not_authorized", message: "Not Authorized" });
			const langs = (u.searchParams.get("languages") ?? "").split(",");
			if (u.searchParams.get("tmdb_id") !== "95396" && u.searchParams.get("tmdb_id") !== "45745") return sendJson(res, 200, { status: false, error: "Can't find movie or tv" });
			return sendJson(res, 200, { status: true, results: [], subtitles: langs.map((l) => ({ release_name: `subdl ${l} release`, name: `SUBDL ${l}`, lang: l.toLowerCase(), language: l, author: "someone", url: `/subtitle/1-${l}.zip`, season: u.searchParams.get("season_number") ? 1 : null, episode: null, full_season: !!u.searchParams.get("season_number"), hi: false })) });
		}
		// ---------------- Gestdown /gd
		if (p.startsWith("/gd/shows/search/")) return decodeURIComponent(p.split("/").pop()!) === "Severance" ? sendJson(res, 200, { shows: [{ id: "SEV", name: "Severance", tmdbId: 95396, seasons: [1, 2] }] }) : send(res, 404, "");
		if (p.startsWith("/gd/subtitles/get/SEV/1/")) {
			const [, , , , , , ep, lang] = p.split("/");
			const code = decodeURIComponent(lang!) === "French" ? "fr" : decodeURIComponent(lang!) === "Russian" ? "ru" : "en";
			return sendJson(res, 200, { matchingSubtitles: [{ subtitleId: `gd-${code}-${ep}`, version: "ATVP.WEB-DL", completed: true, hearingImpaired: false, corrected: true, hd: true, downloadUri: `/subtitles/download/gd-${code}-${ep}`, language: decodeURIComponent(lang!), downloadCount: 200, qualities: ["1080p"] }], episode: { season: 1, number: Number(ep), title: "Good News About Hell" } });
		}
		if (p.startsWith("/gd/subtitles/download/")) {
			const code = p.split("/").pop()!.split("-")[1]!;
			return send(res, 200, body(code), { "content-disposition": `attachment; filename="Severance.${code}.srt"` });
		}
		// ---------------- Jimaku /jimaku/api
		if (p.startsWith("/jimaku/api/")) {
			if (req.headers.authorization !== jimakuKey) return sendJson(res, 401, { error: "unauthorized", code: 7 });
			if (p === "/jimaku/api/entries/search") return sendJson(res, 200, /frieren|葬送/i.test(u.searchParams.get("query") ?? "") ? [{ id: 77, name: "Sousou no Frieren", japanese_name: "葬送のフリーレン" }] : []);
			if (p === "/jimaku/api/entries/77/files") return sendJson(res, 200, [{ url: `${srv.url}/jimaku-files/frieren-01.ja.srt`, name: "Sousou no Frieren - 01.ja.srt", size: 30000 }]);
		}
		send(res, 404, "not found");
	});
	return { ...srv, requests, osKey, subdlKey, jimakuKey };
}
