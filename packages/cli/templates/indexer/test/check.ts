import type { PluginCheck } from "@reelix/plugin-testing";

/**
 * Answers recorded from the tracker, for `reelix plugin check` and this plugin's tests.
 * Record them from the real tracker: the conformance suite checks the provider against them.
 */
export const SEARCH = "https://tracker.example.org/api/search?q=Sintel";

export default {
	secrets: { api_key: "recorded-key" },
	http: [
		{ url: "https://tracker.example.org/api/me", body: JSON.stringify({ user: "owner" }) },
		{ url: SEARCH, body: JSON.stringify({ torrents: [{ id: 7, name: "Sintel.2010.1080p.BluRay.x264-GRP", size: 1_200_000_000, seeders: 40, leechers: 2, freeleech: true }] }) },
		{ url: "https://tracker.example.org/api/download/7", body: "d4:infod4:name6:Sintelee" },
	],
	seams: {
		"reelix:indexer@1": { provider: "example-indexer", query: { queries: ["Sintel"], kind: "movie" }, expectHits: 1 },
	},
} satisfies PluginCheck;
