import { definePlugin } from "@reelix/plugin";
import type { Call, Outcome, PluginFetchResponse, SubtitleHit } from "@reelix/plugin";

/** The site this plugin reads. Its host is declared in package.json, under reelix.uses.network. */
const SITE = "https://subtitles.example.org/api";

/** What the site answers to a search. Change it to your site's shape. */
type Found = { results: { id: string; title: string; lang: string; release?: string; downloads?: number }[] };

/**
 * A subtitle source for one site. `search` returns hits, `download` returns the file.
 * An expected answer of the site, such as "too many requests", is an outcome, not an error.
 */
export default definePlugin({
	async activate(ctx) {
		const get = async (path: string, call: Call): Promise<PluginFetchResponse | Outcome> => {
			const res = await ctx.http.fetch(`${SITE}${path}`, { signal: call.signal, headers: { accept: "application/json" } });
			if (res.status === 429) return { outcome: "rate_limited" };
			if (!res.ok) return { outcome: "unavailable", message: ctx.t("httpError", { status: res.status }) };
			return res;
		};

		await ctx.provide("reelix:subtitle.source@1", {
			id: "example-subtitles",
			label: "Example subtitles",
			kinds: ["movie", "show"],
			languages: ["en", "fr"],
			async search(q, call) {
				const params = new URLSearchParams({ q: q.text ?? q.names[0] ?? "", languages: q.languages.join(",") });
				if (q.year !== undefined) params.set("year", String(q.year));
				if (q.season !== undefined) params.set("season", String(q.season));
				const res = await get(`/search?${params}`, call);
				if ("outcome" in res) return res;
				const found = JSON.parse(new TextDecoder().decode(res.bytes)) as Found;
				return found.results.map((r): SubtitleHit => ({ ref: r.id, name: r.title, languages: [r.lang], language: r.lang, release: r.release, downloads: r.downloads }));
			},
			async download(ref, call) {
				const res = await get(`/download/${encodeURIComponent(ref)}`, call);
				if ("outcome" in res) return res;
				return { bytes: res.bytes, filename: `${ref}.srt` };
			},
		});
	},
});
