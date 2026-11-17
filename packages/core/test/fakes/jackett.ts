import { setTimeout as delay } from "node:timers/promises";
import { send, sendJson, startServer } from "./server.ts";

/**
 * A fake Jackett: the Torznab indexer list, per-indexer JSON results, and proxy download links
 * (`/dl/{indexer}/?jackett_apikey=…&path=…&file=…`) like real Jackett hands out.
 */

export type FakeRelease = {
	title: string;
	size?: number;
	seeders?: number;
	peers?: number;
	publishDate?: string;
	category?: number[];
	infoHash?: string;
	/** .torrent bytes served from the download link. */
	torrent?: Uint8Array;
	/** A magnet: by default the download link 302-redirects to it; with `magnetInResult` it is the result's MagnetUri. */
	magnet?: string;
	magnetInResult?: boolean;
	freeleech?: boolean;
};

export type FakeIndexer = { id: string; name: string; results: FakeRelease[]; fail?: string; delayMs?: number; categories?: number[] };

export type FakeJackett = {
	url: string;
	apiKey: string;
	indexers: FakeIndexer[];
	/** Every request path+query received (for leak checks and counting). */
	requests: string[];
	downloads: string[];
	close(): Promise<void>;
};

const norm = (s: string) => s.toLowerCase().replace(/[._\-[\]()]+/g, " ").replace(/\s+/g, " ").trim();

export async function startFakeJackett(opts: { apiKey: string; indexers: FakeIndexer[] }): Promise<FakeJackett> {
	const requests: string[] = [];
	const downloads: string[] = [];
	// download token -> release
	const byToken = new Map<string, FakeRelease>();
	let base = "";

	const linkFor = (ix: FakeIndexer, r: FakeRelease, i: number): string | null => {
		if (!r.torrent && !(r.magnet && !r.magnetInResult)) return null;
		const token = `${ix.id}-${i}`;
		byToken.set(token, r);
		return `${base}/dl/${encodeURIComponent(ix.id)}/?jackett_apikey=${encodeURIComponent(opts.apiKey)}&path=${encodeURIComponent(token)}&file=${encodeURIComponent(r.title)}`;
	};

	const server = await startServer(async (req, res) => {
		requests.push(req.url.pathname + req.url.search);
		const p = req.url.pathname;

		if (p === "/api/v2.0/indexers/all/results/torznab/api") {
			if (req.url.searchParams.get("apikey") !== opts.apiKey) return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<error code="100" description="Invalid API Key" />`, { "content-type": "application/xml" });
			if (req.url.searchParams.get("t") !== "indexers") return send(res, 400, "unsupported");
			const xml = opts.indexers
				.map(
					(ix) => `  <indexer id="${ix.id}" configured="true">
    <title>${ix.name.replace(/&/g, "&amp;")}</title>
    <description>Fake indexer ${ix.id}</description>
    <link>https://${ix.id}.example/</link>
    <language>en-US</language>
    <type>public</type>
    <caps>
      <server title="Jackett" />
      <limits default="100" max="100" />
      <searching>
        <search available="yes" supportedParams="q" />
        <tv-search available="yes" supportedParams="q,season,ep" />
        <movie-search available="yes" supportedParams="q,imdbid" />
      </searching>
      <categories>
${(ix.categories ?? [2000, 5000, 5070]).map((c) => `        <category id="${c}" name="cat${c}" />`).join("\n")}
      </categories>
    </caps>
  </indexer>`,
				)
				.join("\n");
			return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<indexers>\n${xml}\n</indexers>`, { "content-type": "application/xml" });
		}

		let m: RegExpExecArray | null;
		if ((m = /^\/api\/v2\.0\/indexers\/([^/]+)\/results$/.exec(p))) {
			if (req.url.searchParams.get("apikey") !== opts.apiKey) return send(res, 401, "");
			const ix = opts.indexers.find((x) => x.id === decodeURIComponent(m![1]!));
			if (!ix) return sendJson(res, 404, { error: "Indexer is not configured" });
			if (ix.delayMs) await delay(ix.delayMs);
			const ixInfo = { ID: ix.id, Name: ix.name, Status: ix.fail ? 1 : 2, Results: 0, Error: ix.fail ?? null, ElapsedTime: ix.delayMs ?? 5 };
			if (ix.fail) return sendJson(res, 200, { Results: [], Indexers: [ixInfo] });
			const terms = norm(req.url.searchParams.get("Query") ?? "").split(" ").filter(Boolean);
			const cats = req.url.searchParams.getAll("Category[]").map(Number);
			const results = ix.results
				.map((r, i) => ({ r, i }))
				.filter(({ r }) => terms.every((t) => norm(r.title).includes(t)))
				.filter(({ r }) => !cats.length || !r.category || r.category.some((c) => cats.some((k) => Math.floor(c / 1000) === Math.floor(k / 1000))))
				.map(({ r, i }) => ({
					FirstSeen: "0001-01-01T00:00:00",
					Tracker: ix.name,
					TrackerId: ix.id,
					TrackerType: "public",
					CategoryDesc: "Movies",
					Title: r.title,
					Guid: `https://${ix.id}.example/details/${i}`,
					Link: linkFor(ix, r, i),
					Details: `https://${ix.id}.example/details/${i}`,
					PublishDate: r.publishDate ?? "2024-01-01T00:00:00Z",
					Category: r.category ?? [2000],
					Size: r.size ?? 0,
					Grabs: 10,
					Seeders: r.seeders ?? 0,
					Peers: r.peers ?? 0,
					InfoHash: r.infoHash ?? null,
					MagnetUri: r.magnetInResult ? (r.magnet ?? null) : null,
					DownloadVolumeFactor: r.freeleech ? 0 : 1,
					UploadVolumeFactor: 1,
				}));
			return sendJson(res, 200, { Results: results, Indexers: [{ ...ixInfo, Results: results.length }] });
		}

		if ((m = /^\/dl\/([^/]+)\/?$/.exec(p))) {
			if (req.url.searchParams.get("jackett_apikey") !== opts.apiKey) return send(res, 401, "");
			const token = req.url.searchParams.get("path") ?? "";
			const r = byToken.get(token);
			if (!r) return send(res, 404, "Not Found");
			downloads.push(token);
			if (r.torrent) return send(res, 200, r.torrent, { "content-type": "application/x-bittorrent", "content-disposition": `attachment; filename="${token}.torrent"` });
			if (r.magnet) {
				res.writeHead(302, { location: r.magnet });
				return res.end();
			}
			return send(res, 404, "Not Found");
		}
		return send(res, 404, "Not Found");
	});
	base = server.url;
	return { url: server.url, apiKey: opts.apiKey, indexers: opts.indexers, requests, downloads, close: server.close };
}
