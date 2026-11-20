import type { PluginCheck } from "@reelix/plugin-testing";

/**
 * Answers recorded from Jellyfin 10.10, for `reelix plugin check` and this plugin's tests. Reelix fills in only
 * the parts it reads; the shapes are Jellyfin's.
 */
export const JF = "http://jellyfin.test:8096";
const json = (v: unknown) => JSON.stringify(v);
const items = (list: unknown[]) => json({ Items: list, TotalRecordCount: list.length, StartIndex: 0 });

const SINTEL = { Name: "Sintel", Id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", Type: "Movie", ProductionYear: 2010, ProviderIds: { Tmdb: "45745", Imdb: "tt1727587" }, UserData: { PlayCount: 2, IsFavorite: true, Played: true, LastPlayedDate: "2026-11-15T20:41:07.0000000Z" } };
const SEVERANCE = { Name: "Severance", Id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", Type: "Series", ProductionYear: 2022, ProviderIds: { Tmdb: "95396", Tvdb: "371980" }, UserData: { PlayCount: 0, IsFavorite: false, Played: false } };
const episode = (n: number, last: string) => ({ Name: `Episode ${n}`, Id: `e${n}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 32), Type: "Episode", SeriesId: SEVERANCE.Id, SeriesName: "Severance", ParentIndexNumber: 1, IndexNumber: n, UserData: { PlayCount: 1, Played: true, LastPlayedDate: last } });

export default {
	settings: { url: JF, public_url: "https://jellyfin.example.ts.net" },
	secrets: { api_key: "0123456789abcdef0123456789abcdef" },
	http: [
		{ url: `${JF}/System/Info`, body: json({ Id: "f3a9b8c7d6e54f3a9b8c7d6e5f4a3b2c", ServerName: "nas", Version: "10.10.7", OperatingSystem: "Linux" }) },
		{ url: `${JF}/Library/VirtualFolders`, body: json([{ Name: "Films", ItemId: "f137a2dd21bbc1b99aa5c0f6bf02a805", Locations: ["/data/media/library/Movies"], CollectionType: "movies" }, { Name: "Shows", ItemId: "a656b907eb3a73532e40e44b968d0225", Locations: ["/data/media/library/Shows"], CollectionType: "tvshows" }]) },
		{ url: `${JF}/Users`, body: json([{ Name: "owner", Id: "4c8c5d4e2f3a4b1c9d8e7f6a5b4c3d2e", Policy: { IsAdministrator: true, IsDisabled: false, IsHidden: true } }, { Name: "guest", Id: "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b", Policy: { IsAdministrator: false, IsDisabled: false, IsHidden: true } }]) },
		{ url: /\/Items\?userId=[^&]+&.*IncludeItemTypes=Episode&Filters=IsPlayed/, body: items([episode(3, "2026-11-10T21:00:00.0000000Z"), episode(2, "2026-11-09T21:00:00.0000000Z")]) },
		{ url: /\/Items\?userId=[^&]+&Ids=/, body: items([SEVERANCE]) },
		{ url: /\/Items\?userId=[^&]+&.*IncludeItemTypes=Movie&Filters=IsPlayed/, body: items([SINTEL]) },
		{ url: /\/Items\?userId=[^&]+&.*Filters=IsFavorite/, body: items([SINTEL]) },
		{ url: /\/Items\?userId=[^&]+&.*IncludeItemTypes=Movie&Limit=/, body: items([SINTEL]) },
		{ url: /\/Items\?userId=[^&]+&.*Limit=1$/, body: items([SINTEL]) },
		{ url: /\/Items\?userId=/, body: items([SINTEL, SEVERANCE]) },
		{ url: `${JF}/Shows/${SEVERANCE.Id}/Episodes?userId=4c8c5d4e2f3a4b1c9d8e7f6a5b4c3d2e`, body: items([1, 2, 3].map((n) => episode(n, ""))) },
		{ url: /\/Shows\/NextUp\?userId=/, body: items([{ ...episode(4, ""), UserData: { PlayCount: 0, Played: false } }]) },
		{ url: `${JF}/Library/Media/Updated`, method: "POST", status: 204 },
		{ url: `${JF}/Library/Refresh`, method: "POST", status: 204 },
	],
	seams: {
		"reelix:media.server@1": { provider: "jellyfin", userId: "4c8c5d4e2f3a4b1c9d8e7f6a5b4c3d2e", showId: SEVERANCE.Id, changed: ["/data/media/library/Shows/Severance (2022) [tmdbid-95396]"] },
	},
} satisfies PluginCheck;
