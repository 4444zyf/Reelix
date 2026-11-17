import { http, expectOk } from "../http.ts";
import { ReelixError, errorMessage } from "../util.ts";

export type JackettResult = {
	Title: string;
	Guid?: string;
	Link?: string | null;
	MagnetUri?: string | null;
	Details?: string | null;
	Size?: number;
	Seeders?: number;
	Peers?: number;
	Grabs?: number;
	Tracker?: string;
	TrackerId?: string;
	CategoryDesc?: string;
	Category?: number[];
	PublishDate?: string;
	InfoHash?: string | null;
	Imdb?: number | null;
	TMDb?: number | null;
	DownloadVolumeFactor?: number;
	UploadVolumeFactor?: number;
};

export type JackettIndexer = { id: string; name: string; type?: string; categories: number[]; searchModes: string[] };

export type IndexerOutcome = { indexer: string; name: string; ok: boolean; count: number; ms: number; error?: string };

export const CATEGORIES = { movie: [2000], tv: [5000], anime: [5070, 5000] } as const;

export class JackettClient {
	url: string;
	apiKey: string;
	proxy?: string;

	constructor(opts: { url: string; apiKey: string }) {
		this.url = opts.url.replace(/\/+$/, "");
		this.apiKey = opts.apiKey;
	}

	/** Configured indexers, via the Torznab "indexers" call (needs only the API key). */
	async indexers(): Promise<JackettIndexer[]> {
		const res = await expectOk(
			await http(`${this.url}/api/v2.0/indexers/all/results/torznab/api?t=indexers&configured=true&apikey=${encodeURIComponent(this.apiKey)}`, { timeoutMs: 15_000 }),
			"Jackett indexer list",
		);
		const xml = await res.text();
		if (/<error/.test(xml)) throw new ReelixError("jackett_error", `Jackett: ${/description="([^"]*)"/.exec(xml)?.[1] ?? xml.slice(0, 200)}`);
		const out: JackettIndexer[] = [];
		for (const m of xml.matchAll(/<indexer\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/indexer>/g)) {
			const body = m[2]!;
			const name = /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? m[1]!;
			const type = /<type>([^<]*)<\/type>/.exec(body)?.[1];
			const categories = [...body.matchAll(/<category\s+id="(\d+)"/g)].map((c) => Number(c[1]));
			const searchModes = [...body.matchAll(/<(search|tv-search|movie-search)\s+available="yes"/g)].map((c) => c[1]!);
			out.push({ id: m[1]!, name: decodeXml(name), type, categories, searchModes });
		}
		return out;
	}

	/** Query one indexer through Jackett's JSON results endpoint. */
	async searchIndexer(indexer: string, query: string, categories: number[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<JackettResult[]> {
		const qs = new URLSearchParams({ apikey: this.apiKey, Query: query });
		for (const c of categories) qs.append("Category[]", String(c));
		const res = await http(`${this.url}/api/v2.0/indexers/${encodeURIComponent(indexer)}/results?${qs}`, { timeoutMs: opts.timeoutMs ?? 30_000, signal: opts.signal, proxy: this.proxy });
		await expectOk(res, `Jackett search on ${indexer}`);
		const data = await res.json<{ Results?: JackettResult[]; Indexers?: { Error?: string | null; Status?: number }[] }>();
		const err = data.Indexers?.find((i) => i.Error)?.Error;
		if (err && !data.Results?.length) throw new ReelixError("indexer_error", err);
		return data.Results ?? [];
	}

	/** Query each indexer separately so one slow or broken indexer neither delays nor hides the rest (§5.2). */
	async searchEach(indexers: { id: string; name: string }[], queries: string[], categories: number[], timeoutMs = 30_000): Promise<{ results: (JackettResult & { indexerId: string })[]; outcomes: IndexerOutcome[] }> {
		const results: (JackettResult & { indexerId: string })[] = [];
		const outcomes: IndexerOutcome[] = [];
		await Promise.all(
			indexers.map(async (ix) => {
				const t0 = Date.now();
				let count = 0;
				const errors: string[] = [];
				for (const q of queries) {
					try {
						const r = await this.searchIndexer(ix.id, q, categories, { timeoutMs });
						count += r.length;
						for (const x of r) results.push({ ...x, indexerId: ix.id, Tracker: x.Tracker ?? ix.name });
					} catch (e) {
						errors.push(errorMessage(e));
					}
				}
				outcomes.push({ indexer: ix.id, name: ix.name, ok: errors.length < queries.length, count, ms: Date.now() - t0, error: errors[0] });
			}),
		);
		return { results, outcomes };
	}

	/** Fetch a result's Link (a Jackett proxy URL). Returns either .torrent bytes or a magnet it redirected to. */
	async fetchLink(link: string): Promise<{ torrent?: Uint8Array; magnet?: string }> {
		const res = await http(link, { redirect: "manual", timeoutMs: 45_000, proxy: this.proxy });
		const loc = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && loc) {
			if (loc.startsWith("magnet:")) return { magnet: loc };
			const r2 = await expectOk(await http(new URL(loc, link).toString(), { timeoutMs: 45_000 }), "Fetching the torrent file");
			return { torrent: await r2.bytes() };
		}
		await expectOk(res, "Fetching the torrent file");
		const bytes = await res.bytes();
		const head = new TextDecoder().decode(bytes.slice(0, 7));
		if (head === "magnet:") return { magnet: new TextDecoder().decode(bytes).trim() };
		if (bytes[0] !== 0x64 /* 'd' */) throw new ReelixError("not_torrent", "The download link did not return a torrent file (the indexer may need a login or the link expired).");
		return { torrent: bytes };
	}
}

function decodeXml(s: string): string {
	return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
