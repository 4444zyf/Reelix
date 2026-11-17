import { Type } from "typebox";
import type { Reelix } from "./app.ts";
import type { BgmEpisode } from "./clients/bangumi.ts";
import { json } from "./db.ts";
import { normName } from "./parser.ts";
import { defineOperation } from "./registry.ts";
import { doubanPage, getTitle, linkBangumi, linkDouban, requireTitle, type Title } from "./titles.ts";
import { ReelixError, errorMessage } from "./util.ts";

export type AnimeMapRow = { id: number; title_id: string; bangumi_id: number; bgm_from: number; bgm_to: number; tmdb_season: number; tmdb_start: number; exceptions_json: string; source: string };

type TmdbEp = { season: number; episode: number; air: number | null };

const day = (s?: string | null) => (s ? Date.parse(s.slice(0, 10)) : NaN);

/**
 * Line up a title's Bangumi entries with TMDB seasons by air date and episode count (§5.1).
 * Stores: Bangumi entry X episodes N–M are TMDB season S starting at episode E.
 */
export async function mapAnime(app: Reelix, titleId: string): Promise<{ title: string; mappings: AnimeMapRow[]; notes: string[] }> {
	const t = requireTitle(app, titleId);
	if (t.kind !== "tv" || !t.tmdb_id) throw new ReelixError("invalid_input", "Anime mapping is for TMDB TV titles.");
	const notes: string[] = [];
	// TMDB episodes with air dates
	const tmdbEps: TmdbEp[] = [];
	for (const s of t.seasons.filter((x) => x.season_number > 0)) {
		const season = await app.tmdb().season(t.tmdb_id, s.season_number);
		for (const e of season.episodes) tmdbEps.push({ season: s.season_number, episode: e.episode_number, air: day(e.air_date) || null });
	}
	// Bangumi entries: the linked ones, else a search by the original name
	let ids = t.bangumi_ids;
	if (!ids.length) {
		const names = [t.original_name, t.name, t.folder_name].filter((x): x is string => !!x);
		for (const n of names) {
			const hits = await app.bangumi().search(n, 10);
			const want = new Set(t.names.concat(names).map(normName));
			const year = t.year;
			const good = hits.filter((h) => (!h.platform || /TV/i.test(h.platform)) && (want.has(normName(h.name)) || (h.name_cn && want.has(normName(h.name_cn))) || normName(h.name).startsWith(normName(n))) && (!year || !h.date || Number(h.date.slice(0, 4)) >= year));
			if (good.length) {
				ids = good.map((g) => g.id);
				break;
			}
		}
		if (!ids.length) notes.push("No Bangumi entry found by name; link one with `reelix title set <id> --bangumi-id N` and run again.");
	}
	const mappings: AnimeMapRow[] = [];
	app.db.prepare("DELETE FROM anime_map WHERE title_id = ? AND source = 'auto'").run(t.id);
	for (const bid of ids) {
		let eps: BgmEpisode[];
		try {
			eps = (await app.bangumi().episodes(bid)).filter((e) => e.type === 0).sort((a, b) => a.sort - b.sort);
		} catch (e) {
			notes.push(`Bangumi ${bid}: ${errorMessage(e)}`);
			continue;
		}
		if (!eps.length) continue;
		linkBangumi(app, t.id, bid);
		const first = eps[0]!;
		const firstAir = day(first.airdate);
		// The TMDB episode closest in air date to this entry's first episode (±3 days).
		let best: TmdbEp | undefined;
		let bestDiff = Infinity;
		for (const e of tmdbEps) {
			if (e.air === null || Number.isNaN(firstAir)) continue;
			const diff = Math.abs(e.air - firstAir);
			if (diff < bestDiff) {
				bestDiff = diff;
				best = e;
			}
		}
		if (!best || bestDiff > 3 * 86400_000) {
			notes.push(`Bangumi ${bid} (${first.airdate || "no date"}): no TMDB episode within 3 days of its first episode; settle it by hand.`);
			continue;
		}
		const exceptions: Record<string, string> = {};
		// Check the rest line up; record per-episode exceptions where TMDB numbering crosses into another season.
		eps.forEach((e, i) => {
			const target = tmdbEps.find((x) => x.season === best!.season && x.episode === best!.episode + i);
			if (!target) {
				const absIdx = tmdbEps.indexOf(best!) + i;
				const alt = tmdbEps[absIdx];
				if (alt) exceptions[String(e.sort)] = `S${alt.season}E${alt.episode}`;
			}
		});
		const row = { title_id: t.id, bangumi_id: bid, bgm_from: first.sort, bgm_to: eps[eps.length - 1]!.sort, tmdb_season: best.season, tmdb_start: best.episode };
		const info = app.db.prepare("INSERT INTO anime_map (title_id, bangumi_id, bgm_from, bgm_to, tmdb_season, tmdb_start, exceptions_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'auto')").run(row.title_id, row.bangumi_id, row.bgm_from, row.bgm_to, row.tmdb_season, row.tmdb_start, JSON.stringify(exceptions));
		mappings.push({ ...row, id: Number(info.lastInsertRowid), exceptions_json: JSON.stringify(exceptions), source: "auto" });
		const seasonCount = tmdbEps.filter((x) => x.season === best!.season).length;
		if (eps.length !== seasonCount && best.episode === 1) notes.push(`Bangumi ${bid} has ${eps.length} episodes; TMDB season ${best.season} has ${seasonCount}.`);
		if (Object.keys(exceptions).length) notes.push(`Bangumi ${bid}: ${Object.keys(exceptions).length} episodes run past TMDB season ${best.season} (see exceptions).`);
	}
	return { title: `${t.name} (${t.year})`, mappings, notes };
}

/**
 * Resolve an absolute or per-cour episode number for an anime title to TMDB season/episode:
 * stored Bangumi mappings first, then cumulative TMDB season counts.
 */
export function resolveAbsolute(app: Reelix, t: Title, n: number, hintSeason?: number): { season: number; episode: number; how: string } | undefined {
	const rows = app.db.prepare("SELECT * FROM anime_map WHERE title_id = ? ORDER BY tmdb_season, tmdb_start").all(t.id) as AnimeMapRow[];
	for (const r of rows) {
		const ex = json<Record<string, string>>(r.exceptions_json, {});
		if (ex[String(n)]) {
			const m = /S(\d+)E(\d+)/.exec(ex[String(n)]!);
			if (m) return { season: Number(m[1]), episode: Number(m[2]), how: `Bangumi ${r.bangumi_id} exception` };
		}
		if (n >= r.bgm_from && n <= r.bgm_to) return { season: r.tmdb_season, episode: r.tmdb_start + (n - r.bgm_from), how: `Bangumi ${r.bangumi_id} mapping` };
	}
	const seasons = t.seasons.filter((s) => s.season_number > 0).sort((a, b) => a.season_number - b.season_number);
	if (hintSeason !== undefined) {
		const s = seasons.find((x) => x.season_number === hintSeason);
		if (s && n <= s.episode_count) return { season: hintSeason, episode: n, how: "within the wanted season" };
	}
	let left = n;
	for (const s of seasons) {
		if (left <= s.episode_count) return { season: s.season_number, episode: left, how: "cumulative TMDB seasons" };
		left -= s.episode_count;
	}
	return undefined;
}

defineOperation({
	name: "anime.map",
	summary: "Line up a title's Bangumi entries with TMDB seasons by air date and store the mapping",
	effect: "write",
	input: Type.Object({ title_id: Type.String() }),
	positional: ["title_id"],
	async run(ctx, i) {
		return mapAnime(ctx.app, i.title_id);
	},
	toText: (o: any) => `${o.title}\n${o.mappings.map((m: AnimeMapRow) => `Bangumi ${m.bangumi_id} eps ${m.bgm_from}-${m.bgm_to} → TMDB S${m.tmdb_season} from E${m.tmdb_start}${m.exceptions_json !== "{}" ? ` exceptions ${m.exceptions_json}` : ""}`).join("\n") || "No mappings."}${o.notes.length ? `\nNotes:\n- ${o.notes.join("\n- ")}` : ""}`,
	titleOf: (i) => i.title_id,
});

defineOperation({
	name: "anime.resolve",
	summary: "Which TMDB season/episode an absolute anime episode number is",
	effect: "read",
	input: Type.Object({ title_id: Type.String(), episode: Type.Integer(), season_hint: Type.Optional(Type.Integer()) }),
	positional: ["title_id", "episode"],
	async run(ctx, i) {
		const r = resolveAbsolute(ctx.app, requireTitle(ctx.app, i.title_id), i.episode, i.season_hint);
		if (!r) throw new ReelixError("not_found", "Cannot place that episode; run anime.map or add a per-title note.");
		return r;
	},
	toText: (o: any) => `S${o.season}E${o.episode} (${o.how})`,
});

defineOperation({
	name: "anime.set_map",
	summary: "Store a hand-made mapping: Bangumi entry eps N–M are TMDB season S starting at E",
	effect: "write",
	input: Type.Object({ title_id: Type.String(), bangumi_id: Type.Integer(), from: Type.Integer(), to: Type.Integer(), season: Type.Integer(), start: Type.Integer() }),
	async run(ctx, i) {
		const t = requireTitle(ctx.app, i.title_id);
		ctx.app.db.prepare("INSERT INTO anime_map (title_id, bangumi_id, bgm_from, bgm_to, tmdb_season, tmdb_start, source) VALUES (?, ?, ?, ?, ?, ?, 'owner')").run(t.id, i.bangumi_id, i.from, i.to, i.season, i.start);
		return i;
	},
	toText: (o: any) => `Stored: Bangumi ${o.bangumi_id} eps ${o.from}-${o.to} → S${o.season}E${o.start}.`,
	titleOf: (i) => i.title_id,
});

defineOperation({
	name: "douban.rating",
	summary: "Refresh a title's Douban rating from the public page (Douban ID from subhd or a link)",
	effect: "write",
	input: Type.Object({ title_id: Type.String(), douban_id: Type.Optional(Type.String()) }),
	positional: ["title_id"],
	async run(ctx, i) {
		const t = requireTitle(ctx.app, i.title_id);
		const id = i.douban_id ?? t.douban_id;
		if (!id) throw new ReelixError("not_found", "No Douban ID yet; it arrives with a subhd search (subtitle.search) or a Douban link.");
		const page = await doubanPage(ctx.app, id);
		if (page.error) throw new ReelixError("douban", `Douban page unavailable (${page.error}); best-effort, nothing else depends on it.`);
		linkDouban(ctx.app, t.id, id, page.rating);
		return { ...page, douban_id: id, title: getTitle(ctx.app, t.id)?.name };
	},
	toText: (o: any) => `${o.title}: Douban ${o.douban_id} ${o.rating ?? "no rating"}${o.title ? ` (${o.title})` : ""}`,
	titleOf: (i) => i.title_id,
});
