import type { Call, SubtitleHit } from "@reelix/plugin";
import { type Site, SiteAnswer, base, get, json, latinFirst, pace, source, unavailable, unique } from "./shared.ts";

const LANGUAGE: Record<string, string> = { en: "English", fr: "French", ru: "Russian", zh: "Chinese (Simplified)", ja: "Japanese" };
const GAP_MS = 1500;

/** Gestdown: Addic7ed's TV subtitles through a free API (no key). */
export function gestdown(s: Site) {
	const request = async <T = any>(path: string, call: Call): Promise<T | undefined> => {
		await pace(s, "gestdown", GAP_MS, call);
		const res = await get(s, "gestdown", `${base(s.settings.gestdown_url)}${path}`, call, { headers: { accept: "application/json" } });
		if (res.status === 404) return undefined;
		if (res.status === 429) throw new SiteAnswer({ outcome: "rate_limited" });
		if (!res.ok) throw unavailable(`Gestdown: HTTP ${res.status}`);
		return json<T>(res, "Gestdown");
	};

	return source({
		id: "gestdown",
		label: "Gestdown (Addic7ed)",
		kinds: ["show"],
		languages: ["en", "fr", "ru", "zh"],
		async search(q, call) {
			if (!q.series || q.season === undefined) return [];
			let show: { id: string; tmdbId?: number } | undefined;
			for (const n of unique([q.text, ...latinFirst(q.names)].filter((x): x is string => !!x))) {
				const j = await request<{ shows: { id: string; tmdbId?: number }[] }>(`/shows/search/${encodeURIComponent(n)}`, call);
				show = j?.shows.find((x) => q.ids.tmdb && x.tmdbId === q.ids.tmdb) ?? (j?.shows.length === 1 ? j.shows[0] : undefined);
				if (show) break;
			}
			if (!show) return [];
			const out: SubtitleHit[] = [];
			const code = (n: number) => String(n).padStart(2, "0");
			for (const ep of (q.episodes?.length ? q.episodes : [1]).slice(0, 30))
				for (const l of q.languages) {
					const j = await request<{ matchingSubtitles: any[]; episode?: { title?: string } }>(`/subtitles/get/${show.id}/${q.season}/${ep}/${encodeURIComponent(LANGUAGE[l]!)}`, call);
					for (const x of j?.matchingSubtitles ?? []) {
						if (x.completed === false) continue;
						out.push({
							ref: String(x.subtitleId),
							name: `${q.names[0]} S${code(q.season)}E${code(ep)}${j?.episode?.title ? ` ${j.episode.title}` : ""}`,
							release: [x.version, ...(x.qualities ?? [])].filter(Boolean).join(" "),
							languages: [x.language],
							language: l,
							formats: ["SRT"],
							tags: [x.corrected ? "corrected" : "", x.hd ? "HD" : ""].filter(Boolean),
							downloads: x.downloadCount,
							date: x.discovered,
							season: q.season,
							episode: ep,
							hearingImpaired: !!x.hearingImpaired,
						});
					}
				}
			return out;
		},
		async download(id, call) {
			await pace(s, "gestdown", GAP_MS, call);
			const res = await get(s, "gestdown", `${base(s.settings.gestdown_url)}/subtitles/download/${encodeURIComponent(id)}`, call, { timeoutMs: 60_000 });
			if (!res.ok) throw unavailable(`Gestdown download failed: HTTP ${res.status}`);
			const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers["content-disposition"] ?? "")?.[1];
			return { bytes: res.bytes, filename: name ? decodeURIComponent(name) : `${id}.srt` };
		},
	});
}
