import { send, sendJson, startServer } from "../../../packages/core/test/fakes/server.ts";

/**
 * A fake Jellyfin for the jellyfin plugin: users, played films and episodes, favourites (docs/trends.md §2.1),
 * system info, libraries, path updates and scans (kept in `updates`). Speaks the 10.9+ /Items?userId= form, or
 * only the older /Users/{id}/Items form with `legacy`.
 */

export type FakeWatch = { user: string; type: "Movie" | "Series"; name: string; year: number; tmdb: number; plays?: number; episodes?: number; favourite?: boolean; last?: string };

export type FakeLibraryItem = { type: "Movie" | "Series"; name: string; year: number; tmdb: number; episodes?: [number, number][] };

export type FakeJellyfin = { url: string; apiKey: string; requests: string[]; updates: unknown[]; watch: FakeWatch[]; close(): Promise<void> };

export async function startFakeJellyfin(opts: { apiKey?: string; users?: { name: string; admin?: boolean; disabled?: boolean }[]; watch?: FakeWatch[]; legacy?: boolean; library?: FakeLibraryItem[]; folders?: { name: string; paths: string[] }[]; next?: { user: string; tmdb: number; season: number; episode: number }[] } = {}): Promise<FakeJellyfin> {
	const apiKey = opts.apiKey ?? "jf-test-key";
	const users = (opts.users ?? [{ name: "owner", admin: true }]).map((u, i) => ({ Id: `u${i + 1}`, Name: u.name, Policy: { IsAdministrator: !!u.admin, IsDisabled: !!u.disabled, IsHidden: false } }));
	const watch = opts.watch ?? [];
	const requests: string[] = [];
	const updates: unknown[] = [];
	const idOf = (w: FakeWatch) => `${w.type === "Movie" ? "m" : "s"}${w.tmdb}`;

	const items = (userId: string, sp: URLSearchParams) => {
		const user = users.find((u) => u.Id === userId);
		if (!user) return undefined;
		const mine = watch.filter((w) => w.user === user.Name);
		const types = (sp.get("IncludeItemTypes") ?? "").split(",").filter(Boolean);
		const filters = sp.get("Filters") ?? "";
		const item = (w: FakeWatch) => ({
			Id: idOf(w),
			Name: w.name,
			Type: w.type,
			ProductionYear: w.year,
			ProviderIds: { Tmdb: String(w.tmdb) },
			UserData: { PlayCount: w.plays ?? 0, IsFavorite: !!w.favourite, Played: !!(w.plays || w.episodes), LastPlayedDate: w.last },
		});
		if (sp.get("Ids")) {
			const ids = new Set(sp.get("Ids")!.split(","));
			return mine.filter((w) => ids.has(idOf(w))).map(item);
		}
		if (types.includes("Episode")) {
			return mine
				.filter((w) => w.type === "Series" && w.episodes)
				.flatMap((w) => Array.from({ length: w.episodes! }, (_, i) => ({ Id: `${idOf(w)}e${i + 1}`, Name: `Episode ${i + 1}`, Type: "Episode", SeriesId: idOf(w), SeriesName: w.name, UserData: { PlayCount: 1, Played: true, LastPlayedDate: w.last } })));
		}
		if (!filters) return (opts.library ?? []).filter((x) => types.includes(x.type)).map((x) => ({ Id: `${x.type === "Movie" ? "m" : "s"}${x.tmdb}`, Name: x.name, Type: x.type, ProductionYear: x.year, ProviderIds: { Tmdb: String(x.tmdb) } }));
		return mine
			.filter((w) => types.includes(w.type))
			.filter((w) => (filters === "IsPlayed" ? !!w.plays : filters === "IsFavorite" ? !!w.favourite : true))
			.sort((a, b) => (b.last ?? "").localeCompare(a.last ?? ""))
			.map(item);
	};

	const server = await startServer((req, res) => {
		requests.push(`${req.method} ${req.url.pathname}${req.url.search}`);
		if (!String(req.headers.authorization ?? "").includes(`Token="${apiKey}"`)) return send(res, 401, "");
		const p = req.url.pathname;
		const sp = req.url.searchParams;
		let m: RegExpExecArray | null;
		if (p === "/System/Info") return sendJson(res, 200, { Id: "fakeserver0001", ServerName: "fake", Version: "10.10.7" });
		const ep = (tmdb: number, s: number, e: number) => ({ Id: `s${tmdb}x${s}x${e}`, Type: "Episode", Name: `Episode ${e}`, SeriesId: `s${tmdb}`, ParentIndexNumber: s, IndexNumber: e });
		if (p === "/Shows/NextUp") {
			const user = users.find((u) => u.Id === sp.get("userId"));
			return sendJson(res, 200, { Items: (opts.next ?? []).filter((n) => n.user === user?.Name).map((n) => ep(n.tmdb, n.season, n.episode)) });
		}
		if ((m = /^\/Shows\/s(\d+)\/Episodes$/.exec(p))) {
			const tmdb = Number(m[1]);
			return sendJson(res, 200, { Items: (opts.library ?? []).find((x) => x.tmdb === tmdb)?.episodes?.map(([s, e]) => ep(tmdb, s, e)) ?? [] });
		}
		if (p === "/Users") return sendJson(res, 200, users);
		if (p === "/Items" && !opts.legacy) {
			const r = items(sp.get("userId") ?? "", sp);
			return r ? sendJson(res, 200, { Items: r, TotalRecordCount: r.length }) : send(res, 400, "");
		}
		if ((m = /^\/Users\/([^/]+)\/Items$/.exec(p))) {
			const r = items(m[1]!, sp);
			return r ? sendJson(res, 200, { Items: r, TotalRecordCount: r.length }) : send(res, 404, "");
		}
		if (p === "/Library/Media/Updated" || p === "/Library/Refresh") {
			updates.push(p === "/Library/Refresh" ? "refresh" : JSON.parse(req.body.toString("utf8") || "null"));
			return send(res, 204, "");
		}
		if (p === "/Library/VirtualFolders") return sendJson(res, 200, (opts.folders ?? []).map((f, i) => ({ Name: f.name, ItemId: `lib${i + 1}`, Locations: f.paths, CollectionType: "mixed" })));
		return send(res, 404, "");
	});
	return { url: server.url, apiKey, requests, updates, watch, close: server.close };
}
