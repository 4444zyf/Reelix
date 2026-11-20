import type { PluginCheck } from "@reelix/plugin-testing";

/**
 * Answers recorded from the site, for `reelix plugin check` and this plugin's tests.
 * Record them from the real site: the conformance suite checks the provider against them.
 */
export const SEARCH = "https://subtitles.example.org/api/search?q=Sintel&languages=en&year=2010";

export default {
	http: [
		{ url: SEARCH, body: JSON.stringify({ results: [{ id: "101", title: "Sintel", lang: "en", release: "Sintel.2010.1080p.BluRay.x264-GRP", downloads: 1200 }] }) },
		{ url: "https://subtitles.example.org/api/download/101", body: "1\n00:00:01,000 --> 00:00:03,000\nHello.\n" },
	],
	seams: {
		"reelix:subtitle.source@1": { provider: "example-subtitles", query: { names: ["Sintel"], year: 2010, ids: { tmdb: 45745 }, kind: "movie", series: false, languages: ["en"] }, expectHits: 1 },
	},
} satisfies PluginCheck;
