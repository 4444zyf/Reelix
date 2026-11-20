import type { Call, Kind, PluginContext, ReleaseHit, Site, SiteResult } from "@reelix/plugin";

export type JackettResult = {
	Title: string;
	Link?: string | null;
	MagnetUri?: string | null;
	Size?: number;
	Seeders?: number;
	Peers?: number;
	PublishDate?: string;
	InfoHash?: string | null;
	DownloadVolumeFactor?: number;
	UploadVolumeFactor?: number;
};

export type JackettSite = Site & { type?: string };

/** A refusal or bad answer from Jackett: expected, reported to the owner, not a broken plugin. */
export class JackettError extends Error {}

const CATEGORIES: Record<Kind, number[]> = { movie: [2000], show: [5000], anime: [5070, 5000] };
const SITE_LIMIT_MS = 30_000;

const decodeXml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const text = (b: Uint8Array) => new TextDecoder().decode(b);

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function magnetHash(magnet: string): string | undefined {
	const h = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(magnet)?.[1];
	if (h?.length === 40) return h.toLowerCase();
	if (h?.length !== 32) return undefined;
	const bits = [...h.toUpperCase()].map((c) => BASE32.indexOf(c).toString(2).padStart(5, "0")).join("");
	return (bits.match(/.{4}/g) ?? []).map((b) => parseInt(b, 2).toString(16)).join("").slice(0, 40);
}

/** What a hit's `ref` holds. The link carries the owner's key, so it stays inside Reelix's handle. */
export type FetchRef = { link?: string | null; magnet?: string | null };

export function jackettClient(ctx: PluginContext, url: string, apiKey: string) {
	const root = url.replace(/\/+$/, "");
	const get = (u: string, signal: AbortSignal, timeoutMs: number, redirect?: "manual") => ctx.http.fetch(u, { signal, timeoutMs, redirect });

	async function ok(u: string, what: string, signal: AbortSignal, timeoutMs: number) {
		const res = await get(u, signal, timeoutMs);
		if (!res.ok) throw new JackettError(`${what} failed: HTTP ${res.status}${res.bytes.length ? `: ${text(res.bytes).slice(0, 300)}` : ""}`);
		return res;
	}

	/** Configured indexers, via the Torznab "indexers" call (needs only the API key). */
	async function sites(signal: AbortSignal): Promise<JackettSite[]> {
		const xml = text((await ok(`${root}/api/v2.0/indexers/all/results/torznab/api?t=indexers&configured=true&apikey=${encodeURIComponent(apiKey)}`, "Jackett indexer list", signal, 15_000)).bytes);
		if (/<error/.test(xml)) throw new JackettError(`Jackett: ${/description="([^"]*)"/.exec(xml)?.[1] ?? xml.slice(0, 200)}`);
		return [...xml.matchAll(/<indexer\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/indexer>/g)].map((m) => {
			const type = /<type>([^<]*)<\/type>/.exec(m[2]!)?.[1];
			return { id: m[1]!, name: decodeXml(/<title>([^<]*)<\/title>/.exec(m[2]!)?.[1] ?? m[1]!), type, private: type === "private" };
		});
	}

	/** Query one indexer through Jackett's JSON results endpoint. */
	async function searchSite(site: string, query: string, categories: number[], signal: AbortSignal, timeoutMs: number): Promise<JackettResult[]> {
		const qs = new URLSearchParams({ apikey: apiKey, Query: query });
		for (const c of categories) qs.append("Category[]", String(c));
		const res = await ok(`${root}/api/v2.0/indexers/${encodeURIComponent(site)}/results?${qs}`, `Jackett search on ${site}`, signal, timeoutMs);
		const data = JSON.parse(text(res.bytes)) as { Results?: JackettResult[]; Indexers?: { Error?: string | null }[] };
		const err = data.Indexers?.find((i) => i.Error)?.Error;
		if (err && !data.Results?.length) throw new JackettError(err);
		return data.Results ?? [];
	}

	/** Query each site separately, at most 30 seconds each and never past the deadline, so one slow or broken site neither delays nor hides the rest. */
	async function searchEach(ids: string[], queries: string[], kind: Kind | undefined, { signal, deadline }: Pick<Call, "signal" | "deadline">): Promise<{ hits: ReleaseHit[]; sites: SiteResult[] }> {
		const categories = kind ? CATEGORIES[kind] : [];
		const hits: ReleaseHit[] = [];
		const results = await Promise.all(
			ids.map(async (site): Promise<SiteResult> => {
				const started = Date.now();
				let count = 0;
				const errors: string[] = [];
				for (const q of queries) {
					const left = Math.min(started + SITE_LIMIT_MS, deadline) - Date.now();
					if (left <= 0 || signal.aborted) {
						errors.push("no time left for this site");
						continue;
					}
					try {
						const found = await searchSite(site, q, categories, signal, left);
						count += found.length;
						for (const r of found) hits.push(toHit(r, site));
					} catch (e) {
						errors.push(e instanceof Error ? e.message : String(e));
					}
				}
				const ok = errors.length < queries.length;
				return { site, ok, count, ms: Date.now() - started, outcome: ok ? undefined : { outcome: "unavailable", message: errors[0]! } };
			}),
		);
		return { hits, sites: results };
	}

	/** Fetch a result's link (a Jackett proxy address): .torrent bytes, or the magnet it redirects to. */
	async function fetchLink(link: string, signal: AbortSignal): Promise<{ torrent?: Uint8Array; magnet?: string }> {
		const res = await get(link, signal, 45_000, "manual");
		const location = res.headers.location;
		if (res.status >= 300 && res.status < 400 && location) {
			if (location.startsWith("magnet:")) return { magnet: location };
			return { torrent: (await ok(new URL(location, link).toString(), "Fetching the torrent file", signal, 45_000)).bytes };
		}
		if (!res.ok) throw new JackettError(`Fetching the torrent file failed: HTTP ${res.status}`);
		if (text(res.bytes.slice(0, 7)) === "magnet:") return { magnet: text(res.bytes).trim() };
		if (res.bytes[0] !== 0x64 /* 'd' */) throw new JackettError("The download link did not return a torrent file (the indexer may need a login or the link expired).");
		return { torrent: res.bytes };
	}

	return { sites, searchEach, fetchLink };
}

function toHit(r: JackettResult, site: string): ReleaseHit {
	const ref: FetchRef = { link: r.Link ?? null, magnet: r.MagnetUri ?? null };
	return {
		ref: JSON.stringify(ref),
		title: r.Title,
		site,
		size: r.Size,
		seeders: r.Seeders,
		peers: r.Peers,
		infoHash: (r.InfoHash ?? (r.MagnetUri ? magnetHash(r.MagnetUri) : undefined))?.toLowerCase(),
		publishedAt: r.PublishDate,
		hasMagnet: !!r.MagnetUri,
		downloadFactor: r.DownloadVolumeFactor,
		uploadFactor: r.UploadVolumeFactor,
	};
}
