import type { Kind, PlayRequest } from "@reelix/plugin";
import type { Reelix } from "./app.ts";
import { libraryOverview } from "./library.ts";
import { type MediaServerProvider, activeMediaServer, chooseWatchUsers, serverError } from "./media-server.ts";
import type { Provider } from "./seams.ts";
import { type Title, requireTitle } from "./titles.ts";

/*
 * One tap from Reelix into the player (docs/web-app.md, "Playing"). Links only: no key or video address ever
 * goes to the phone, and each app plays through its own sign-in. The links come from the players
 * (reelix:player@1, docs/plugins.md §7.9), in the order of the owner's list; where the active media server has
 * the title, they are told its ids there.
 */

export const PLAYER = "reelix:player@1";

/** `app`: the player's provider id, which the web app remembers; `label`: its name. */
export type PlayLink = { app: string; label: string; url: string; autoplay: boolean };
export type PlayEpisode = { season: number; episode: number; links: PlayLink[] };
export type PlayTarget = { title_id: string; name: string; year?: number; kind: string; poster_path?: string | null; in_library: boolean; season?: number; episode?: number; links: PlayLink[]; episodes?: PlayEpisode[]; note?: string };

/** Where the media server has each library title, and where the owner stopped in each show. */
type ServerIndex = { server: MediaServerProvider; serverId: string; userId: string; publicUrl?: string; items: Map<string, string>; next: Map<string, { id: string; season: number; episode: number }> };

const INDEX_TTL_MS = 2 * 60_000;
let cached: { server: MediaServerProvider; at: number; index?: ServerIndex; error?: string } | undefined;

export function forgetPlayIndex(): void {
	cached = undefined;
}

/** `error`: what the active media server answered instead; it names the server. */
async function serverIndex(app: Reelix): Promise<{ index?: ServerIndex; error?: string }> {
	const server = activeMediaServer(app);
	if (!server) return {};
	// A new provider (a changed setting restarts its plugin) is a new index.
	if (cached?.server === server && Date.now() - cached.at < INDEX_TTL_MS) return cached;
	let r: { index?: ServerIndex; error?: string };
	try {
		const chosen = chooseWatchUsers(server, await server.call("users", []));
		if (typeof chosen === "string") r = { error: chosen };
		else {
			const user = chosen[0]!;
			const [info, all, next] = await Promise.all([server.call("info", []), server.call("items", [{ userId: user.id, kinds: ["movie", "show"], limit: 10000 }]), server.call("nextUp", [user.id])]);
			const items = new Map<string, string>();
			for (const x of all) if (x.ids.tmdb) items.set(`${x.kind === "show" ? "tv" : "movie"}:${x.ids.tmdb}`, x.id);
			const nextByShow = new Map(next.map((e) => [e.showId, { id: e.id, season: e.season, episode: e.episode }]));
			r = { index: { server, serverId: info.serverId, userId: user.id, publicUrl: info.publicUrl?.replace(/\/+$/, ""), items, next: nextByShow } };
		}
	} catch (e) {
		r = { error: serverError(app, e) };
	}
	cached = { server, at: Date.now(), ...r };
	return r;
}

const kindOf = (t: Pick<Title, "kind" | "media_class">): Kind => (t.media_class === "anime" ? "anime" : t.kind === "tv" ? "show" : "movie");

function request(t: Title, ix: ServerIndex | undefined, itemId: string | undefined, ep?: { season: number; episode: number }): PlayRequest {
	return {
		ids: { tmdb: t.tmdb_id ?? undefined, imdb: t.imdb_id ?? undefined },
		kind: kindOf(t),
		series: t.kind === "tv",
		season: ep?.season,
		episode: ep?.episode,
		server: ix && itemId ? { serverId: ix.serverId, userId: ix.userId, itemId, publicUrl: ix.publicUrl } : undefined,
	};
}

/** The players in the owner's order; the ones not in the list follow, in the order they started. */
function players(app: Reelix): Provider<typeof PLAYER>[] {
	if (!app.plugins) return [];
	const order = app.config.players;
	const place = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
	return app.seams.providers(PLAYER).map((p, i) => ({ p, i })).sort((a, b) => place(a.p.id) - place(b.p.id) || a.i - b.i).map((x) => x.p);
}

/** Every player's links for many requests at once: one list per request. A player that fails is left out. */
async function linksFor(app: Reelix, requests: PlayRequest[]): Promise<PlayLink[][]> {
	const out = requests.map((): PlayLink[] => []);
	if (!requests.length) return out;
	for (const p of players(app)) {
		const got = await p.call("links", [requests]).catch(() => undefined);
		if (!got || got.length !== requests.length) continue;
		got.forEach((l, i) => {
			if (l) out[i]!.push({ app: p.id, label: p.label, url: l.url, autoplay: l.autoplay });
		});
	}
	return out;
}

/** The episodes Reelix has filed, in order; specials last. */
function libraryEpisodes(app: Reelix, titleId: string): { season: number; episode: number }[] {
	return app.db.prepare("SELECT DISTINCT e.season, e.episode FROM files f JOIN file_episodes e ON e.file_id = f.id WHERE f.title_id = ? AND f.kind IN ('video','disc') ORDER BY e.season = 0, e.season, e.episode").all(titleId) as { season: number; episode: number }[];
}

function base(t: Title, inLibrary: boolean): PlayTarget {
	return { title_id: t.id, name: t.name, year: t.year ?? undefined, kind: t.kind, poster_path: t.poster_path, in_library: inLibrary, links: [] };
}

/** A film, or where to continue a show: the server's next episode, else the first one in the library. */
function quickTarget(app: Reelix, t: Title, ix: ServerIndex | undefined): { target: PlayTarget; request: PlayRequest } {
	const out = base(t, true);
	const item = ix?.items.get(t.id);
	if (t.kind === "movie") return { target: out, request: request(t, ix, item) };
	const next = item ? ix?.next.get(item) : undefined;
	const ep = next ?? libraryEpisodes(app, t.id)[0];
	out.season = ep?.season;
	out.episode = ep?.episode;
	return { target: out, request: request(t, ix, next?.id ?? item, ep) };
}

/** Every library title's play links at once, so a poster can open the player in a single tap. */
export async function libraryPlayLinks(app: Reelix): Promise<{ targets: Record<string, PlayTarget>; media_server_error?: string }> {
	const { index, error } = await serverIndex(app);
	const quick = libraryOverview(app).titles.map((t) => quickTarget(app, t as unknown as Title, index));
	const links = await linksFor(app, quick.map((q) => q.request));
	const targets: Record<string, PlayTarget> = {};
	quick.forEach((q, i) => (targets[q.target.title_id] = { ...q.target, links: links[i]! }));
	return { targets, media_server_error: error };
}

/** One title: where to continue, or the episode asked for, plus a link for each episode Reelix has. */
export async function playTarget(app: Reelix, id: string, want: { season?: number; episode?: number } = {}): Promise<PlayTarget> {
	const t = requireTitle(app, id);
	const { index, error } = await serverIndex(app);
	const inLibrary = !!t.library_folder || !!app.db.prepare("SELECT 1 FROM files WHERE title_id = ? LIMIT 1").get(t.id);
	if (!inLibrary) return { ...base(t, false), note: "This title is not in the library." };
	const { target: out, request: quick } = quickTarget(app, t, index);
	if (error) out.note = error;
	if (t.kind !== "tv") {
		out.links = (await linksFor(app, [quick]))[0]!;
		return out;
	}

	const showItem = index?.items.get(t.id);
	const aired = index && showItem ? await index.server.call("episodes", [{ userId: index.userId, showId: showItem }]).catch(() => []) : [];
	const itemFor = (e: { season: number; episode: number }) => aired.find((x) => x.season === e.season && x.episode === e.episode)?.id;
	const have = libraryEpisodes(app, t.id).slice(0, 500);
	let chosen: { season: number; episode: number } | undefined;
	if (want.episode !== undefined) {
		chosen = { season: want.season ?? out.season ?? have[0]?.season ?? 1, episode: want.episode };
		if (!have.some((x) => x.season === chosen!.season && x.episode === chosen!.episode)) out.note = `Season ${chosen.season} episode ${chosen.episode} is not in the library.`;
	} else if (want.season !== undefined) {
		chosen = have.find((x) => x.season === want.season);
		if (!chosen) out.note = `Season ${want.season} is not in the library.`;
	} else if (out.season !== undefined && out.episode !== undefined) chosen = { season: out.season, episode: out.episode };
	const links = await linksFor(app, [chosen ? request(t, index, itemFor(chosen), chosen) : quick, ...have.map((e) => request(t, index, itemFor(e), e))]);
	if (chosen) {
		out.season = chosen.season;
		out.episode = chosen.episode;
	}
	out.links = links[0]!;
	out.episodes = have.map((e, i) => ({ ...e, links: links[i + 1]! }));
	return out;
}

export function playTargetText(p: PlayTarget): string {
	const what = `${p.name}${p.year ? ` (${p.year})` : ""}${p.episode !== undefined ? ` S${String(p.season).padStart(2, "0")}E${String(p.episode).padStart(2, "0")}` : ""}`;
	return `${what}${p.note ? `\n${p.note}` : ""}\n${p.links.map((l) => `${l.label}: ${l.url}`).join("\n") || "No player link is available."}`;
}
