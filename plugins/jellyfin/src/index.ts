import { type Ids, OperationError, type Outcome, OutcomeError, type PluginCheck, SETTINGS, type ServerItem, type ServerItemsQuery, Type, definePlugin } from "@reelix/plugin";
import { JellyfinClient, JellyfinError, type JellyfinItem } from "./client.ts";

const SEAM = "reelix:media.server@1";

const expected = (e: unknown) => e instanceof JellyfinError || /^network/.test(String((e as { code?: unknown } | null)?.code ?? ""));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const outcomeOf = (e: unknown): Outcome => (e instanceof JellyfinError && e.kind === "auth" ? { outcome: "needs_auth" } : { outcome: "unavailable", message: message(e) });

/** Jellyfin being away or refusing is an outcome, not a broken plugin (docs/plugins.md §7). */
async function answering<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (expected(e)) throw new OutcomeError(outcomeOf(e));
		throw e;
	}
}

/** The address a phone can open: the setting, else Jellyfin's own unless it only works inside Docker or on the NAS. */
function publicUrl(url: string, setting: string | undefined): string | undefined {
	if (setting) return setting.replace(/\/+$/, "");
	try {
		const h = new URL(url).hostname;
		return /^(localhost|127\.|\[?::1|0\.0\.0\.0|host\.docker\.internal)/i.test(h) || !h.includes(".") ? undefined : url.replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

function idsOf(x: JellyfinItem): Ids {
	const p = Object.fromEntries(Object.entries(x.ProviderIds ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
	return { tmdb: Number(p.tmdb) || undefined, imdb: p.imdb || undefined, tvdb: Number(p.tvdb) || undefined };
}

const toItem = (x: JellyfinItem): ServerItem => ({
	id: x.Id,
	kind: x.Type === "Series" ? "show" : "movie",
	name: x.Name,
	year: x.ProductionYear,
	ids: idsOf(x),
	plays: x.UserData?.PlayCount,
	favourite: x.UserData?.IsFavorite,
	lastPlayedAt: x.UserData?.LastPlayedDate,
});

const TYPES = { movie: "Movie", show: "Series" } as const;

const notSetUp = () => new OperationError("not_configured", "Jellyfin is not set up: give its address and API key in Settings → Plugins → jellyfin.");

export default definePlugin({
	config: Type.Object({
		url: Type.Optional(Type.String({ [SETTINGS.required]: true })),
		public_url: Type.Optional(Type.String()),
		watch_users: Type.Array(Type.String(), { default: [] }),
	}),
	async activate(ctx, settings) {
		const url = settings.url;
		const key = await ctx.secret.get("api_key");
		const jf = url && key ? new JellyfinClient(ctx.http.fetch, { url, apiKey: key }) : undefined;

		if (jf) {
			/** Shows this user played at least one episode of, with how many and when last. */
			const playedShows = async (userId: string, limit: number, signal: AbortSignal): Promise<ServerItem[]> => {
				const common = { Recursive: "true", Fields: "ProviderIds" };
				const episodes = await jf.userItems(userId, { ...common, IncludeItemTypes: "Episode", Filters: "IsPlayed", SortBy: "DatePlayed", SortOrder: "Descending", Limit: 500 }, signal);
				const shows = new Map<string, { n: number; last?: string }>();
				for (const e of episodes) {
					if (!e.SeriesId) continue;
					const sh = shows.get(e.SeriesId) ?? { n: 0 };
					sh.n++;
					if ((e.UserData?.LastPlayedDate ?? "") > (sh.last ?? "")) sh.last = e.UserData?.LastPlayedDate;
					shows.set(e.SeriesId, sh);
				}
				const ids = [...shows.keys()].slice(0, limit);
				const series = ids.length ? await jf.userItems(userId, { Ids: ids.join(","), Fields: "ProviderIds" }, signal) : [];
				return series.flatMap((sr) => {
					const sh = shows.get(sr.Id);
					return sh ? [{ ...toItem(sr), plays: undefined, episodesPlayed: sh.n, lastPlayedAt: sh.last }] : [];
				});
			};
			const items = async (q: ServerItemsQuery, signal: AbortSignal): Promise<ServerItem[]> => {
				const limit = q.limit ?? 10_000;
				const common = { Recursive: "true", Fields: "ProviderIds", ...(q.sort === "lastPlayed" ? { SortBy: "DatePlayed", SortOrder: "Descending" } : {}) };
				if (q.filter !== "played") {
					const found = await jf.userItems(q.userId, { ...common, IncludeItemTypes: q.kinds.map((k) => TYPES[k]).join(","), ...(q.filter === "favourite" ? { Filters: "IsFavorite" } : {}), Limit: limit }, signal);
					return found.filter((x) => x.Type === "Movie" || x.Type === "Series").map(toItem);
				}
				const movies = q.kinds.includes("movie") ? (await jf.userItems(q.userId, { ...common, IncludeItemTypes: "Movie", Filters: "IsPlayed", Limit: limit }, signal)).map(toItem) : [];
				const shows = q.kinds.includes("show") ? await playedShows(q.userId, limit, signal) : [];
				const all = [...movies, ...shows];
				if (q.sort === "lastPlayed") all.sort((a, b) => (b.lastPlayedAt ?? "").localeCompare(a.lastPlayedAt ?? ""));
				return all.slice(0, limit);
			};
			const episode = (e: JellyfinItem) => (e.SeriesId && e.ParentIndexNumber !== undefined && e.IndexNumber !== undefined ? [{ id: e.Id, showId: e.SeriesId, season: e.ParentIndexNumber, episode: e.IndexNumber }] : []);

			await ctx.provide(SEAM, {
				id: "jellyfin",
				label: "Jellyfin",
				watchUsers: settings.watch_users.length ? settings.watch_users : undefined,
				info: (call) =>
					answering(async () => {
						const i = await jf.info(call.signal);
						return { serverId: i.Id, name: i.ServerName, version: i.Version, publicUrl: publicUrl(jf.url, settings.public_url) };
					}),
				libraries: (call) => answering(async () => (await jf.virtualFolders(call.signal)).map((l) => ({ id: l.ItemId ?? l.Name, name: l.Name, paths: l.Locations ?? [] }))),
				users: (call) => answering(async () => (await jf.users(call.signal)).map((u) => ({ id: u.Id, name: u.Name, admin: !!u.Policy?.IsAdministrator, active: !u.Policy?.IsDisabled }))),
				changed: (paths, call) =>
					answering(async () => {
						// An empty list never reaches Jellyfin.
						if (paths.length) await jf.pathsUpdated(paths.map((p) => ({ path: p.path, updateType: p.change === "deleted" ? "Deleted" : "Created" })), call.signal);
					}),
				refreshAll: (call) => answering(() => jf.refreshAll(call.signal)),
				items: (q, call) => answering(() => items(q, call.signal)),
				episodes: (o, call) => answering(async () => (await jf.seriesEpisodes(o.showId, o.userId, call.signal)).flatMap(episode)),
				nextUp: (userId, call) => answering(async () => (await jf.nextUp(userId, call.signal)).flatMap(episode)),
			});
		}

		await ctx.operation({
			name: "refresh",
			summary: "Ask Jellyfin to scan every library (Reelix tells it about each filed folder by itself)",
			effect: "write",
			input: Type.Object({}),
			async run() {
				if (!jf) throw notSetUp();
				try {
					await jf.refreshAll(ctx.signal);
				} catch (e) {
					if (expected(e)) throw new OperationError(e instanceof JellyfinError && e.kind === "auth" ? "needs_auth" : "unavailable", message(e));
					throw e;
				}
				return { result: "Full library scan requested." };
			},
			toText: (o: { result: string }) => o.result,
		});

		await ctx.check("jellyfin", async (): Promise<PluginCheck> => {
			if (!url)
				return { state: "not_used", cause: { key: "checks.not_set_up" }, action: { label: { key: "checks.set_up" }, setting: "url" }, cli: "reelix config set plugins.jellyfin '{\"url\":\"http://jellyfin:8096\"}', then its API key in Settings", raw: "not configured (optional)", cause_id: "setup" };
			if (!jf) return { state: "failed", cause: { key: "checks.no_key" }, impact: { key: "checks.off" }, action: { label: { key: "checks.add_key" }, secret: "api_key" }, raw: "no API key (Jellyfin → Dashboard → API keys)", cause_id: "setup" };
			try {
				const i = await jf.info(ctx.signal);
				return { state: "passed", cause: { key: "checks.ok", values: { name: i.ServerName, version: i.Version } }, raw: `${i.ServerName} ${i.Version} at ${jf.url}` };
			} catch (e) {
				if (!expected(e)) throw e;
				const refused = e instanceof JellyfinError && e.kind === "auth";
				return {
					state: "failed",
					cause: refused ? { key: "checks.key_refused" } : { key: "checks.unreachable", values: { url } },
					impact: { key: "checks.off" },
					action: refused ? { label: { key: "checks.add_key" }, secret: "api_key" } : { label: { key: "checks.set_up" }, setting: "url" },
					raw: message(e),
					cause_id: "unreachable",
				};
			}
		});
	},
});
