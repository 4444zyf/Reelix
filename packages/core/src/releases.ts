import type { Reelix } from "./app.ts";
import { type HookRelease, type HookTitle, type IndexerQuery, type Kind, type ParsedFacts, type ReleaseHit, type Site, isOutcome, outsideLine } from "@reelix/plugin";
import { json } from "./db.ts";
import { type ParsedName, parseReleaseName, titleVariants } from "./parser.ts";
import { type ReasonInput, releaseSubject, replaceReasons, searchSubject } from "./reasons.ts";
import type { Title } from "./titles.ts";
import { type Provider, outcomeText } from "./seams.ts";
import { magnetHash, parseTorrent, looksRarPacked, isDiscStructure } from "./torrent.ts";
import { ReelixError, errorMessage, humanBytes, newId, nowIso } from "./util.ts";

const SEAM = "reelix:indexer@1";
const FILTER = "release.filter@1";
const RANK = "release.rank@1";
/** Hidden releases listed for the model; the owner's list has them all. */
const HIDDEN_LINES = 10;

/** A plugin hid this release, and why. */
export type HiddenMark = { plugin: string; reason: string };
export type ReleaseNote = { plugin: string; note: string };

/** What a handle stands for. Never shown to the model (§4.2): links carry personal keys. */
export type HandlePayload = {
	/** The indexer provider that found it, and its own reference for fetching it. */
	provider?: string;
	ref?: string;
	/** A magnet the owner gave directly. */
	magnet?: string | null;
	hasMagnet?: boolean;
	infoHash?: string | null;
	title: string;
	size?: number;
	seeders?: number;
	peers?: number;
	indexer?: string;
	indexerId?: string;
	publishDate?: string;
	freeleech?: boolean;
	parsed: ParsedName;
	titleId?: string;
	/** Set by the last search that returned it (docs/plugins.md §8). */
	hidden?: HiddenMark[];
	notes?: ReleaseNote[];
	/** That search; its record says what each indexer answered. */
	search?: string;
};

export type Release = Omit<HandlePayload, "ref" | "magnet"> & { handle: string; hasMagnet: boolean };

export type IndexerOutcome = { indexer: string; name: string; ok: boolean; count: number; ms: number; error?: string; plugin: string };

/** `keepMarks`: what the plugins said about this release stays until they have looked at it again. */
function saveHandle(app: Reelix, payload: HandlePayload, o: { keepMarks?: boolean } = {}): string {
	// Same release (by hash or reference) reuses its handle so the model sees stable IDs.
	const key = payload.infoHash ?? (payload.ref ? `${payload.provider}:${payload.ref}` : undefined) ?? payload.magnet ?? payload.title;
	const existing = app.db.prepare("SELECT id, payload_json FROM handles WHERE json_extract(payload_json, '$.key') = ?").get(key) as { id: string; payload_json: string } | undefined;
	if (existing) {
		const old = json(existing.payload_json, {} as HandlePayload);
		const marks = o.keepMarks ? { hidden: old.hidden, notes: old.notes } : {};
		app.db.prepare("UPDATE handles SET payload_json = ? WHERE id = ?").run(JSON.stringify({ ...payload, ...marks, key }), existing.id);
		return existing.id;
	}
	const id = "r" + newId().slice(0, 5);
	app.db.prepare("INSERT INTO handles (id, payload_json, created_at) VALUES (?, ?, ?)").run(id, JSON.stringify({ ...payload, key }), nowIso());
	return id;
}

export function getHandle(app: Reelix, id: string): HandlePayload {
	const r = app.db.prepare("SELECT payload_json FROM handles WHERE id = ?").get(id.trim()) as { payload_json: string } | undefined;
	if (!r) throw new ReelixError("unknown_handle", `No release handle "${id}". Handles come from release_search; copy them exactly.`);
	return json(r.payload_json, {} as HandlePayload);
}

function toRelease(handle: string, p: HandlePayload): Release {
	const { ref: _r, magnet, key: _k, ...rest } = p as HandlePayload & { key?: string };
	return { ...rest, handle, hasMagnet: !!magnet || !!p.hasMagnet };
}

/** A stored release as the owner's screens may see it: no link, no reference. */
export const releaseOfHandle = (app: Reelix, handle: string): Release => toRelease(handle, getHandle(app, handle));

/** The marks that still count: a plugin the owner switched off hides nothing. Without a server its marks stand. */
export function activeHidden(app: Reelix, p: Pick<HandlePayload, "hidden">): HiddenMark[] {
	const marks = p.hidden ?? [];
	if (!app.plugins) return marks;
	const running = app.hooks.plugins(FILTER);
	return marks.filter((m) => running.includes(m.plugin));
}

export type SearchOutput = {
	title?: string;
	queries: string[];
	/** Releases not hidden. */
	total: number;
	offset: number;
	releases: Release[]; // the page, without hidden releases
	all: Release[]; // for the web UI, hidden ones last; not given to the model
	hidden: Release[];
	/** This search's record (docs/plugins.md §10.1). */
	search: string;
	indexers: IndexerOutcome[];
};

type Found = { hits: (ReleaseHit & { provider: string; siteName: string })[]; outcomes: IndexerOutcome[] };

/** Ask one provider. What it cannot do is reported per site; the other providers carry on. */
async function searchProvider(p: Provider<typeof SEAM>, q: IndexerQuery, only: string[] | undefined): Promise<Found & { sites: number; problem?: string }> {
	const empty = { hits: [], outcomes: [] };
	let sites: Site[];
	try {
		const answer = await p.call("sites", []);
		if (isOutcome(answer)) return { ...empty, sites: 0, problem: outcomeText(p.label, answer) };
		sites = answer;
	} catch (e) {
		return { ...empty, sites: 0, problem: errorMessage(e) };
	}
	if (only?.length) sites = sites.filter((s) => only.includes(s.id) || only.includes(s.name));
	if (!sites.length) return { ...empty, sites: 0 };
	const names = new Map(sites.map((s) => [s.id, s.name]));
	const r = await p.call("search", [{ ...q, sites: sites.map((s) => s.id) }]);
	return {
		sites: sites.length,
		hits: r.hits.map((h) => ({ ...h, provider: p.id, siteName: names.get(h.site) ?? h.site })),
		outcomes: r.sites.map((s) => ({ plugin: p.plugin, indexer: s.site, name: names.get(s.site) ?? s.site, ok: s.ok, count: s.count, ms: s.ms, error: s.outcome?.outcome === "unavailable" ? s.outcome.message : s.outcome && outcomeText(names.get(s.site) ?? s.site, s.outcome) })),
	};
}

async function searchIndexers(app: Reelix, q: IndexerQuery, only?: string[]): Promise<Found> {
	const providers = app.seams.providers(SEAM);
	if (!providers.length) throw new ReelixError("no_indexers", "No indexer is set up. Add a Jackett server under Settings → Services.");
	const all = await Promise.all(providers.map((p) => searchProvider(p, q, only).catch((e) => ({ hits: [], outcomes: [], sites: 0, problem: errorMessage(e) }))));
	if (!all.some((r) => r.sites)) {
		const problems = all.flatMap((r) => r.problem ?? []);
		if (problems.length) throw new ReelixError("indexers_unavailable", problems.join(" "));
		throw new ReelixError("no_indexers", "The indexers have no sites configured (or none match). Add some in Jackett first.");
	}
	return { hits: all.flatMap((r) => r.hits), outcomes: all.flatMap((r) => r.outcomes) };
}

/** Every provider's sites, tested with one query, for the nightly check. */
export async function indexerHealth(app: Reelix): Promise<IndexerOutcome[]> {
	return app.seams.providers(SEAM).length ? (await searchIndexers(app, { queries: ["test"] })).outcomes : [];
}

/**
 * Search every indexer provider, per site, by Chinese and English names, for the title's kind (§5.2).
 * Results are de-duplicated across providers by info-hash, else by name and size, keeping the best seeded.
 */
export async function searchReleases(
	app: Reelix,
	opts: { title?: Title; query?: string; season?: number; episode?: number; limit?: number; offset?: number; sort?: "seeders" | "size" | "date"; indexers?: string[] },
): Promise<SearchOutput> {
	const t = opts.title;
	const queries: string[] = [];
	if (opts.query) queries.push(opts.query);
	else if (t) {
		const suffix = t.kind === "tv" && opts.season !== undefined ? ` S${String(opts.season).padStart(2, "0")}${opts.episode !== undefined ? `E${String(opts.episode).padStart(2, "0")}` : ""}` : "";
		const names = [t.folder_name, t.name, t.original_name].filter((x): x is string => !!x);
		const uniq = [...new Set(names.flatMap(titleVariants))].slice(0, 3);
		for (const n of uniq) queries.push(t.kind === "movie" && t.year ? `${n} ${t.year}` : n + suffix);
		// A season query often misses packs named only by title; add the bare name too.
		if (suffix && t.folder_name) queries.push(t.folder_name);
	} else throw new ReelixError("invalid_input", "Give a title or a query.");

	const kind: Kind | undefined = t ? (t.media_class === "anime" ? "anime" : t.kind === "movie" ? "movie" : "show") : undefined;
	const q: IndexerQuery = { queries: [...new Set(queries)], kind, ids: t ? { tmdb: t.tmdb_id ?? undefined, imdb: t.imdb_id ?? undefined } : undefined, season: opts.season, episode: opts.episode };
	const { hits, outcomes } = await searchIndexers(app, q, opts.indexers);

	// de-duplicate by info hash, else by title+size
	const byKey = new Map<string, Found["hits"][number]>();
	for (const r of hits) {
		const key = r.infoHash?.toLowerCase() ?? `${r.title.toLowerCase()}|${r.size ?? 0}`;
		const prev = byKey.get(key);
		if (!prev || (r.seeders ?? 0) > (prev.seeders ?? 0)) byKey.set(key, r);
	}
	const search = newId("s_");
	const stored = new Map<string, { payload: HandlePayload; kept: Pick<HandlePayload, "hidden" | "notes">; hit: Found["hits"][number] }>();
	let releases = [...byKey.values()].map((r) => {
		const payload: HandlePayload = {
			provider: r.provider,
			ref: r.ref,
			hasMagnet: r.hasMagnet,
			infoHash: r.infoHash?.toLowerCase() ?? null,
			title: r.title,
			size: r.size,
			seeders: r.seeders,
			peers: r.peers,
			indexer: r.siteName,
			indexerId: r.site,
			publishDate: r.publishedAt,
			freeleech: r.downloadFactor === 0,
			parsed: parseReleaseName(r.title),
			titleId: t?.id,
			search,
		};
		const handle = saveHandle(app, payload, { keepMarks: true });
		stored.set(handle, { payload, kept: getHandle(app, handle), hit: r });
		return toRelease(handle, payload);
	});
	// For a TV episode search, drop results that clearly are other episodes.
	if (t?.kind === "tv" && opts.season !== undefined) {
		releases = releases.filter((r) => r.parsed.season === undefined || r.parsed.season === opts.season || r.parsed.seasons?.includes(opts.season!));
		if (opts.episode !== undefined) releases = releases.filter((r) => !r.parsed.episodes || r.parsed.absolute || r.parsed.episodes.includes(opts.episode!));
	}
	const sort = opts.sort ?? "seeders";
	releases.sort((a, b) => (sort === "size" ? (b.size ?? 0) - (a.size ?? 0) : sort === "date" ? String(b.publishDate).localeCompare(String(a.publishDate)) : (b.seeders ?? 0) - (a.seeders ?? 0)));

	const decided = await askReleaseHooks(app, t, releases, (handle) => stored.get(handle)!.hit, sort === "seeders");
	const finished = (r: Release): Release => {
		const { payload, kept } = stored.get(r.handle)!;
		const hidden = decided.hidden.get(r.handle);
		const notes = decided.notes.get(r.handle);
		const done = { ...payload, ...(hidden && { hidden }), ...(notes && { notes }) };
		// A running plugin that did not look at it this time (it failed, or the order was not its to set) has not changed its mind.
		if (hidden || notes || kept.hidden || kept.notes) saveHandle(app, { ...done, hidden: hidden ?? (decided.guardsAnswered ? undefined : kept.hidden), notes: notes ?? (decided.rankersAnswered ? undefined : kept.notes) });
		replaceReasons(app, releaseSubject(r.handle), decided.reasons.get(r.handle) ?? []);
		return toRelease(r.handle, done);
	};
	const visible = decided.visible.map(finished);
	const hidden = releases.filter((r) => decided.hidden.has(r.handle)).map(finished);
	replaceReasons(app, searchSubject(search), outcomes.map((o) => ({ kind: "provider", plugin: o.plugin, reason: o.ok ? `${o.name}: ${o.count} found` : `${o.name}: ${o.error ?? "failed"}` })));

	const offset = opts.offset ?? 0;
	const limit = opts.limit ?? 15;
	return { title: t ? `${t.name} (${t.year ?? "?"})` : undefined, queries: [...new Set(queries)], total: visible.length, offset, releases: visible.slice(offset, offset + limit), all: [...visible, ...hidden], hidden, search, indexers: outcomes.sort((a, b) => a.name.localeCompare(b.name)) };
}

export function hookTitle(t: Title): HookTitle {
	return { id: t.id, name: t.name, kind: t.kind, mediaClass: t.media_class, year: t.year ?? undefined, tmdbId: t.tmdb_id ?? undefined };
}

/** A stored release as hooks receive it; `ref` is its handle (docs/plugins.md §8). */
export function hookReleaseOf(handle: string, p: HandlePayload): HookRelease {
	return {
		ref: handle,
		title: p.title,
		site: p.indexerId ?? "",
		siteName: p.indexer ?? "",
		size: p.size,
		seeders: p.seeders,
		peers: p.peers,
		infoHash: p.infoHash ?? undefined,
		publishedAt: p.publishDate,
		hasMagnet: !!p.magnet || !!p.hasMagnet,
		downloadFactor: p.freeleech ? 0 : undefined,
		...parsedFacts(p.parsed),
	};
}

/** The facts of a release name that hooks receive (docs/plugins.md §8). */
export const parsedFacts = (p: ParsedName): ParsedFacts => ({ resolution: p.resolution, source: p.source, codec: p.codec, group: p.group, season: p.season, episodes: p.episodes });

type Decided = { visible: Release[]; hidden: Map<string, HiddenMark[]>; notes: Map<string, ReleaseNote[]>; reasons: Map<string, ReasonInput[]>; guardsAnswered: boolean; rankersAnswered: boolean };

/** One call per list: guards hide, then the ranking plugins order what is left. */
async function askReleaseHooks(app: Reelix, t: Title | undefined, releases: Release[], hitOf: (handle: string) => Found["hits"][number], mayRank: boolean): Promise<Decided> {
	const title = t && hookTitle(t);
	const forHook = (list: Release[]): HookRelease[] =>
		list.map((r) => {
			const { ref: _ref, provider: _provider, ...hit } = hitOf(r.handle);
			return { ...hit, ...parsedFacts(r.parsed), ref: r.handle };
		});
	const hidden = new Map<string, HiddenMark[]>();
	const notes = new Map<string, ReleaseNote[]>();
	const reasons = new Map<string, ReasonInput[]>();
	const remember = (handle: string, r: ReasonInput) => reasons.set(handle, [...(reasons.get(handle) ?? []), r]);

	const guards = app.hooks.plugins(FILTER);
	let guardsAnswered = true;
	if (app.hooks.has(FILTER) && releases.length) {
		const verdicts = await app.hooks.each(FILTER, { title, releases: forHook(releases) });
		guardsAnswered = verdicts.length === guards.length;
		for (const { plugin, item } of verdicts) {
			for (const { ref, reason } of item) {
				const clean = outsideLine(app.redact(reason), 200);
				hidden.set(ref, [...(hidden.get(ref) ?? []), { plugin, reason: clean }]);
				remember(ref, { kind: "hidden", plugin, reason: clean });
			}
		}
		for (const plugin of guards) app.hooks.countGuard(FILTER, plugin, releases.length, new Set(verdicts.find((v) => v.plugin === plugin)?.item.map((h) => h.ref)).size);
	}

	let visible = releases.filter((r) => !hidden.has(r.handle));
	const rankers = app.hooks.plugins(RANK).length;
	const ranked = mayRank && visible.length > 0 && app.hooks.has(RANK);
	if (ranked) {
		const byHandle = new Map(visible.map((r) => [r.handle, r]));
		const order = await app.hooks.pipeline(RANK, { title, releases: forHook(visible) }, (value, item, plugin) => {
			const from = new Map(value.releases.map((r, i) => [r.ref, i]));
			const byRef = new Map(value.releases.map((r) => [r.ref, r]));
			item.order.forEach((ref, to) => {
				if (to < from.get(ref)!) remember(ref, { kind: "moved", plugin, reason: item.reason, detail: { from: from.get(ref)! + 1, to: to + 1 } });
			});
			for (const { ref, note } of item.notes ?? []) {
				const clean = outsideLine(app.redact(note), 200);
				notes.set(ref, [...(notes.get(ref) ?? []), { plugin, note: clean }]);
				remember(ref, { kind: "note", plugin, reason: clean });
			}
			return { ...value, releases: item.order.map((ref) => byRef.get(ref)!) };
		});
		visible = order.releases.map((r) => byHandle.get(r.ref)!);
	}
	return { visible, hidden, notes, reasons, guardsAnswered, rankersAnswered: ranked || !rankers };
}

export function releaseLine(r: Release): string {
	const p = r.parsed;
	const tags = [p.resolution, p.source, p.codec, ...(p.hdr ?? []), p.chineseSubs ? `subs:${p.chineseSubs}` : undefined, p.group ? `grp:${p.group}` : undefined, r.freeleech ? "FREE" : undefined].filter(Boolean).join(" ");
	const notes = (r.notes ?? []).map((n) => ` | note from ${n.plugin}: ${n.note}`).join("");
	const hidden = (r.hidden ?? []).map((h) => ` | HIDDEN by ${h.plugin}: ${h.reason}`).join("");
	return `${r.handle} | ${outsideLine(r.title)} | ${humanBytes(r.size)} | S:${r.seeders ?? "?"} L:${r.peers ?? "?"} | ${outsideLine(r.indexer ?? "?", 80)}${r.publishDate ? ` | ${r.publishDate.slice(0, 10)}` : ""}${tags ? ` | ${outsideLine(tags)}` : ""}${notes}${hidden}`;
}

export function searchToText(o: SearchOutput): string {
	const head = `${o.title ? o.title + ": " : ""}${o.total} releases (showing ${o.offset + 1}-${Math.min(o.total, o.offset + o.releases.length)}); queries: ${o.queries.map((q) => JSON.stringify(q)).join(", ")}`;
	const ix = o.indexers.map((i) => `${outsideLine(i.name, 80)}: ${i.ok ? `${i.count} in ${(i.ms / 1000).toFixed(1)}s` : `ERROR ${outsideLine(i.error ?? "failed")}`}`).join("; ");
	const more = o.total > o.offset + o.releases.length ? `\nMore: offset=${o.offset + o.releases.length}` : "";
	const hidden = o.hidden.length
		? `\nHidden by plugins (${o.hidden.length}; download_add refuses these unless the owner decides otherwise; release_why explains):\n${o.hidden.slice(0, HIDDEN_LINES).map(releaseLine).join("\n")}${o.hidden.length > HIDDEN_LINES ? `\n… ${o.hidden.length - HIDDEN_LINES} more` : ""}`
		: "";
	return `${head}\nindexers: ${ix}\nhandle | name | size | seeders/leechers | indexer | date | parsed\n${o.releases.map(releaseLine).join("\n")}${more}${hidden}`;
}

// ------------------------------------------------------------------ fetching .torrent and file lists

export type FetchedRelease = { torrent?: Uint8Array; magnet?: string; hash?: string; files?: { path: string; size: number }[]; name?: string; private?: boolean };

/** Fetch what a handle points at. A `.torrent` gives its hash and file list at once (§5.3). */
export async function fetchRelease(app: Reelix, h: HandlePayload): Promise<FetchedRelease> {
	if (h.provider && h.ref) {
		const p = app.seams.provider(SEAM, h.provider);
		if (!p) throw new ReelixError("provider_gone", `This release came from "${h.provider}", which is not active now. Switch it on or search again.`);
		const got = await p.call("fetch", [h.ref]);
		if (isOutcome(got)) throw new ReelixError("fetch_refused", outcomeText(p.label, got));
		if (got.torrent) {
			const info = parseTorrent(got.torrent);
			return { torrent: got.torrent, hash: info.infoHash, files: info.files, name: info.name, private: info.private };
		}
		return { magnet: got.magnet, hash: magnetHash(got.magnet!) };
	}
	if (h.magnet) return { magnet: h.magnet, hash: magnetHash(h.magnet) };
	throw new ReelixError("no_link", "This release has neither a provider to fetch it from nor a magnet link.");
}

export function describeFiles(files: { path: string; size: number }[], limit = 60): string {
	const rar = looksRarPacked(files);
	const disc = isDiscStructure(files);
	const lines = files.slice(0, limit).map((f, i) => `${i}: ${outsideLine(f.path)} (${humanBytes(f.size)})`);
	const flags = [rar ? "RAR-PACKED (cannot be hard-linked; avoid)" : "", disc ? `DISC STRUCTURE (${disc})` : ""].filter(Boolean).join("; ");
	return `${files.length} files, ${humanBytes(files.reduce((a, f) => a + f.size, 0))}${flags ? ` — ${flags}` : ""}\n${lines.join("\n")}${files.length > limit ? `\n… ${files.length - limit} more` : ""}`;
}
