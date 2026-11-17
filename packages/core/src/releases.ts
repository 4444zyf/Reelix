import type { Reelix } from "./app.ts";
import { CATEGORIES, type IndexerOutcome, type JackettResult } from "./clients/jackett.ts";
import { json } from "./db.ts";
import { type ParsedName, parseReleaseName, titleVariants } from "./parser.ts";
import type { Title } from "./titles.ts";
import { magnetHash, parseTorrent, looksRarPacked, isDiscStructure } from "./torrent.ts";
import { ReelixError, humanBytes, newId, nowIso } from "./util.ts";

/** What a handle stands for. Never shown to the model (§4.2): links carry personal keys. */
export type HandlePayload = {
	link?: string | null;
	magnet?: string | null;
	infoHash?: string | null;
	title: string;
	size?: number;
	seeders?: number;
	peers?: number;
	indexer?: string;
	indexerId?: string;
	publishDate?: string;
	details?: string | null;
	freeleech?: boolean;
	parsed: ParsedName;
	titleId?: string;
};

export type Release = Omit<HandlePayload, "link" | "magnet" | "details"> & { handle: string; hasMagnet: boolean };

export function saveHandle(app: Reelix, payload: HandlePayload): string {
	// Same release (by hash or link) reuses its handle so the model sees stable IDs.
	const key = payload.infoHash ?? payload.link ?? payload.magnet ?? payload.title;
	const existing = app.db.prepare("SELECT id FROM handles WHERE json_extract(payload_json, '$.key') = ?").get(key) as { id: string } | undefined;
	if (existing) {
		app.db.prepare("UPDATE handles SET payload_json = ? WHERE id = ?").run(JSON.stringify({ ...payload, key }), existing.id);
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
	const { link: _l, magnet, details: _d, ...rest } = p;
	return { ...rest, handle, hasMagnet: !!magnet };
}

export type SearchOutput = {
	title?: string;
	queries: string[];
	total: number;
	offset: number;
	releases: Release[]; // the page
	all: Release[]; // for the web UI; not given to the model
	indexers: IndexerOutcome[];
};

/**
 * Search Jackett per indexer, by Chinese and English names, in the title's category (§5.2).
 * Results are de-duplicated, parsed, and given handles.
 */
export async function searchReleases(
	app: Reelix,
	opts: { title?: Title; query?: string; season?: number; episode?: number; limit?: number; offset?: number; sort?: "seeders" | "size" | "date"; indexers?: string[] },
): Promise<SearchOutput> {
	const jackett = app.jackett();
	let indexers = (await jackett.indexers()).map((i) => ({ id: i.id, name: i.name }));
	if (opts.indexers?.length) indexers = indexers.filter((i) => opts.indexers!.includes(i.id) || opts.indexers!.includes(i.name));
	if (!indexers.length) throw new ReelixError("no_indexers", "Jackett has no configured indexers (or none match). Add indexers in Jackett first.");

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

	const cats = t ? [...(t.media_class === "anime" ? CATEGORIES.anime : t.kind === "movie" ? CATEGORIES.movie : CATEGORIES.tv)] : [];
	const { results, outcomes } = await jackett.searchEach(indexers, [...new Set(queries)], cats);

	// de-duplicate by info hash, else by title+size
	const byKey = new Map<string, JackettResult & { indexerId: string }>();
	for (const r of results) {
		const hash = (r.InfoHash ?? (r.MagnetUri ? magnetHash(r.MagnetUri) : undefined))?.toLowerCase();
		const key = hash ?? `${r.Title.toLowerCase()}|${r.Size ?? 0}`;
		const prev = byKey.get(key);
		if (!prev || (r.Seeders ?? 0) > (prev.Seeders ?? 0)) byKey.set(key, r);
	}
	let releases = [...byKey.values()].map((r) => {
		const payload: HandlePayload = {
			link: r.Link,
			magnet: r.MagnetUri,
			infoHash: (r.InfoHash ?? (r.MagnetUri ? magnetHash(r.MagnetUri) : undefined))?.toLowerCase() ?? null,
			title: r.Title,
			size: r.Size,
			seeders: r.Seeders,
			peers: r.Peers,
			indexer: r.Tracker,
			indexerId: r.indexerId,
			publishDate: r.PublishDate,
			details: r.Details,
			freeleech: r.DownloadVolumeFactor === 0,
			parsed: parseReleaseName(r.Title),
			titleId: t?.id,
		};
		return toRelease(saveHandle(app, payload), payload);
	});
	// For a TV episode search, drop results that clearly are other episodes.
	if (t?.kind === "tv" && opts.season !== undefined) {
		releases = releases.filter((r) => r.parsed.season === undefined || r.parsed.season === opts.season || r.parsed.seasons?.includes(opts.season!));
		if (opts.episode !== undefined) releases = releases.filter((r) => !r.parsed.episodes || r.parsed.absolute || r.parsed.episodes.includes(opts.episode!));
	}
	const sort = opts.sort ?? "seeders";
	releases.sort((a, b) => (sort === "size" ? (b.size ?? 0) - (a.size ?? 0) : sort === "date" ? String(b.publishDate).localeCompare(String(a.publishDate)) : (b.seeders ?? 0) - (a.seeders ?? 0)));
	const offset = opts.offset ?? 0;
	const limit = opts.limit ?? 15;
	return { title: t ? `${t.name} (${t.year ?? "?"})` : undefined, queries: [...new Set(queries)], total: releases.length, offset, releases: releases.slice(offset, offset + limit), all: releases, indexers: outcomes.sort((a, b) => a.name.localeCompare(b.name)) };
}

export function releaseLine(r: Release): string {
	const p = r.parsed;
	const tags = [p.resolution, p.source, p.codec, ...(p.hdr ?? []), p.chineseSubs ? `subs:${p.chineseSubs}` : undefined, p.group ? `grp:${p.group}` : undefined, r.freeleech ? "FREE" : undefined].filter(Boolean).join(" ");
	return `${r.handle} | ${r.title} | ${humanBytes(r.size)} | S:${r.seeders ?? "?"} L:${r.peers ?? "?"} | ${r.indexer ?? "?"}${r.publishDate ? ` | ${r.publishDate.slice(0, 10)}` : ""}${tags ? ` | ${tags}` : ""}`;
}

export function searchToText(o: SearchOutput): string {
	const head = `${o.title ? o.title + ": " : ""}${o.total} releases (showing ${o.offset + 1}-${Math.min(o.total, o.offset + o.releases.length)}); queries: ${o.queries.map((q) => JSON.stringify(q)).join(", ")}`;
	const ix = o.indexers.map((i) => `${i.name}: ${i.ok ? `${i.count} in ${(i.ms / 1000).toFixed(1)}s` : `ERROR ${i.error}`}`).join("; ");
	const more = o.total > o.offset + o.releases.length ? `\nMore: offset=${o.offset + o.releases.length}` : "";
	return `${head}\nindexers: ${ix}\nhandle | name | size | seeders/leechers | indexer | date | parsed\n${o.releases.map(releaseLine).join("\n")}${more}`;
}

// ------------------------------------------------------------------ fetching .torrent and file lists

export type FetchedRelease = { torrent?: Uint8Array; magnet?: string; hash?: string; files?: { path: string; size: number }[]; name?: string; private?: boolean };

/** Fetch what a handle points at. A `.torrent` gives its hash and file list at once (§5.3). */
export async function fetchRelease(app: Reelix, h: HandlePayload): Promise<FetchedRelease> {
	if (h.link) {
		try {
			const got = await app.jackett().fetchLink(h.link);
			if (got.torrent) {
				const info = parseTorrent(got.torrent);
				return { torrent: got.torrent, hash: info.infoHash, files: info.files, name: info.name, private: info.private };
			}
			if (got.magnet) return { magnet: got.magnet, hash: magnetHash(got.magnet) };
		} catch (e) {
			if (!h.magnet) throw e;
		}
	}
	if (h.magnet) return { magnet: h.magnet, hash: magnetHash(h.magnet) };
	throw new ReelixError("no_link", "This release has neither a download link nor a magnet link.");
}

export function describeFiles(files: { path: string; size: number }[], limit = 60): string {
	const rar = looksRarPacked(files);
	const disc = isDiscStructure(files);
	const lines = files.slice(0, limit).map((f, i) => `${i}: ${f.path} (${humanBytes(f.size)})`);
	const flags = [rar ? "RAR-PACKED (cannot be hard-linked; avoid)" : "", disc ? `DISC STRUCTURE (${disc})` : ""].filter(Boolean).join("; ");
	return `${files.length} files, ${humanBytes(files.reduce((a, f) => a + f.size, 0))}${flags ? ` — ${flags}` : ""}\n${lines.join("\n")}${files.length > limit ? `\n… ${files.length - limit} more` : ""}`;
}
