import type { PluginCheck } from "@reelix/plugin-testing";

const server = { serverId: "f3a9b8c7d6e54f3a9b8c7d6e5f4a3b2c", userId: "4c8c5d4e2f3a4b1c9d8e7f6a5b4c3d2e", itemId: "a1b2c3d4e5f60718293a4b5c6d7e8f90", publicUrl: "https://jellyfin.example.ts.net" };

/**
 * What the players' conformance suites run with. A player builds links and asks no service, so there is
 * nothing to record: the requests are a film with a server item, a show's episode, and a title with no TMDB id.
 */
export default {
	seams: {
		"reelix:player@1": {
			provider: "infuse",
			requests: [
				{ ids: { tmdb: 45745 }, kind: "movie", series: false, server },
				{ ids: { tmdb: 95396 }, kind: "show", series: true, season: 1, episode: 2 },
				{ ids: {}, kind: "movie", series: false },
			],
			expectLinks: 2,
		},
	},
} satisfies PluginCheck;
