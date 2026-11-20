import { type Ids, type MetaHit, type Rating, isOutcome, outsideLine } from "@reelix/plugin";
import type { Reelix } from "./app.ts";
import { type Provider, outcomeText } from "./seams.ts";
import { type Title, getTitle, linkBangumi, linkDouban, requireTitle } from "./titles.ts";
import { errorMessage, nowIso } from "./util.ts";

/**
 * Sources of facts about titles beside TMDB (docs/plugins.md §7.6), a seam of the kind "many". TMDB stays the
 * identity of a title; a source's hit is found in TMDB, and what it adds is merged in: its ids and its rating.
 * TMDB wins on conflict, so a source never changes a title's name, year or TMDB and IMDb ids.
 */
export const METADATA = "reelix:metadata.source@1";
export type MetadataProvider = Provider<typeof METADATA>;

/** A title's rating at one source, by provider id. */
export type SourceRating = Rating & { label: string; at: string };

export function metadataSources(app: Reelix): MetadataProvider[] {
	return app.plugins ? app.seams.providers(METADATA) : [];
}

/** Something the owner gave that may be a source's link (`https://…`, `movie.douban.com/subject/1`, `douban:1`). */
export const looksLikeLink = (s: string): boolean => !/\s/.test(s) && (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+\//.test(s) || /^[a-z]+:\w+$/i.test(s));

/** The first source that knows the link, with its hit; or what the sources said when none could read it. */
export async function readLink(app: Reelix, text: string): Promise<{ provider?: MetadataProvider; hit?: MetaHit; notes: string[] }> {
	const notes: string[] = [];
	for (const p of metadataSources(app)) {
		if (!p.has("fromLink")) continue;
		try {
			const hit = await p.call("fromLink", [text]);
			if (isOutcome(hit)) notes.push(outcomeText(p.label, hit));
			else if (hit) return { provider: p, hit, notes };
		} catch (e) {
			notes.push(`${p.label}: ${errorMessage(e)}`);
		}
	}
	return { notes };
}

/** What every source finds for a text; a source that fails is left out. */
export async function findAtSources(app: Reelix, q: { text: string; kind?: MetaHit["kind"]; year?: number }): Promise<{ provider: MetadataProvider; hit: MetaHit }[]> {
	const out: { provider: MetadataProvider; hit: MetaHit }[] = [];
	for (const p of metadataSources(app)) {
		if (!p.has("find")) continue;
		const hits = await p.call("find", [q]).catch(() => []);
		if (!isOutcome(hits)) out.push(...hits.map((hit) => ({ provider: p, hit })));
	}
	return out;
}

/** A hit in words, for the agent: its names, year and episodes, and what the source says to know about it. */
export function hitText(p: MetadataProvider, h: MetaHit): string {
	const names = [h.name, ...(h.names ?? [])].map((n) => outsideLine(n, 120)).join(" / ");
	return `${p.label} entry: ${names} (${h.year ?? "?"})${h.episodes ? `, ${h.episodes} episodes` : ""}.${h.note ? ` ${outsideLine(h.note)}` : ""}`;
}

/** Merge a source's hit into a title: its ids for the other sources, and its rating. */
export function mergeHit(app: Reelix, titleId: string, p: MetadataProvider, h: { ids?: Ids; rating?: Rating }): void {
	if (h.ids?.douban) linkDouban(app, titleId, h.ids.douban);
	if (h.ids?.bangumi) linkBangumi(app, titleId, h.ids.bangumi);
	if (h.rating) recordRating(app, titleId, p, h.rating);
}

function recordRating(app: Reelix, titleId: string, p: MetadataProvider, r: Rating): void {
	const t = getTitle(app, titleId);
	if (!t) return;
	const ratings: Record<string, SourceRating> = { ...t.ratings, [p.id]: { value: r.value, scale: r.scale, label: p.label, at: nowIso() } };
	app.db.prepare("UPDATE titles SET ratings_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(ratings), nowIso(), titleId);
}

/** The ids a title has, as sources know them. */
const titleIds = (t: Title): Ids => ({ tmdb: t.tmdb_id ?? undefined, imdb: t.imdb_id ?? undefined, douban: t.douban_id ?? undefined, bangumi: t.bangumi_ids[0] });

export type EnrichResult = { title: string; ids: Ids; results: { provider: string; label: string; rating?: Rating; note?: string }[] };

/** Ask the sources (all, or the provider ids in `only`) for a title's details and record its ratings. */
export async function enrichTitle(app: Reelix, id: string, only?: string[]): Promise<EnrichResult> {
	const t = requireTitle(app, id);
	const ids = titleIds(t);
	const results: EnrichResult["results"] = [];
	for (const p of metadataSources(app)) {
		if (!p.has("enrich") || (only && !only.includes(p.id))) continue;
		try {
			const e = await p.call("enrich", [ids]);
			if (isOutcome(e)) results.push({ provider: p.id, label: p.label, note: outcomeText(p.label, e) });
			else {
				if (e.rating) recordRating(app, t.id, p, e.rating);
				results.push({ provider: p.id, label: p.label, rating: e.rating, note: e.rating ? undefined : "nothing for this title" });
			}
		} catch (e) {
			results.push({ provider: p.id, label: p.label, note: errorMessage(e) });
		}
	}
	return { title: `${t.name} (${t.year ?? "?"})`, ids, results };
}

/** The main episodes of one Bangumi entry, from the first source that has them; an error when every source failed. */
export async function bangumiEpisodes(app: Reelix, bangumiId: number): Promise<{ number: number; airDate?: string }[]> {
	let failure: string | undefined;
	for (const p of metadataSources(app)) {
		if (!p.has("enrich")) continue;
		try {
			const e = await p.call("enrich", [{ bangumi: bangumiId }]);
			if (isOutcome(e)) failure = outcomeText(p.label, e);
			else if (e.episodes) return e.episodes;
		} catch (err) {
			failure = errorMessage(err);
		}
	}
	if (failure) throw new Error(failure);
	return [];
}
