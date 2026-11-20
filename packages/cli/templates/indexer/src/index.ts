import { definePlugin } from "@reelix/plugin";
import type { Call, Outcome, PluginFetchResponse, ReleaseHit, Site } from "@reelix/plugin";

/** The tracker this plugin searches. Its host is declared in package.json, under reelix.uses.network. */
const API = "https://tracker.example.org/api";
/** One plugin may cover several sites; this one covers one. */
const SITE: Site = { id: "example", name: "Example tracker", private: true };

/** What the tracker answers to a search. Change it to your tracker's shape. */
type Found = { torrents: { id: number; name: string; size: number; seeders: number; leechers: number; info_hash?: string; freeleech?: boolean; added?: string }[] };

/**
 * An indexer for one tracker. The owner's key is a secret (declared under reelix.uses.secrets).
 * Reelix parses the names, removes duplicates and keeps the links away from the model.
 */
export default definePlugin({
	async activate(ctx) {
		const get = async (path: string, call: Call): Promise<PluginFetchResponse | Outcome> => {
			const key = await ctx.secret.get("api_key");
			if (!key) return { outcome: "needs_auth" };
			const res = await ctx.http.fetch(`${API}${path}`, { signal: call.signal, headers: { authorization: `Bearer ${key}` } });
			if (res.status === 401 || res.status === 403) return { outcome: "needs_auth" };
			if (res.status === 429) return { outcome: "rate_limited" };
			if (!res.ok) return { outcome: "unavailable", message: ctx.t("httpError", { status: res.status }) };
			return res;
		};

		await ctx.provide("reelix:indexer@1", {
			id: "example-indexer",
			label: "Example tracker",
			kinds: ["movie", "show", "anime"],
			// Asking the tracker who the key belongs to tells the owner early that the key works.
			async sites(call) {
				const res = await get("/me", call);
				return "outcome" in res ? res : [SITE];
			},
			async search(q, call) {
				if (q.sites && !q.sites.includes(SITE.id)) return { hits: [], sites: [] };
				const started = Date.now();
				const hits = new Map<string, ReleaseHit>();
				for (const text of q.queries) {
					const res = await get(`/search?${new URLSearchParams({ q: text })}`, call);
					if ("outcome" in res) return { hits: [...hits.values()], sites: [{ site: SITE.id, ok: false, count: hits.size, ms: Date.now() - started, outcome: res }] };
					for (const t of (JSON.parse(new TextDecoder().decode(res.bytes)) as Found).torrents) {
						hits.set(String(t.id), { ref: String(t.id), title: t.name, site: SITE.id, size: t.size, seeders: t.seeders, peers: t.leechers, infoHash: t.info_hash, publishedAt: t.added, hasMagnet: false, downloadFactor: t.freeleech ? 0 : 1 });
					}
				}
				return { hits: [...hits.values()], sites: [{ site: SITE.id, ok: true, count: hits.size, ms: Date.now() - started }] };
			},
			async fetch(ref, call) {
				const res = await get(`/download/${encodeURIComponent(ref)}`, call);
				if ("outcome" in res) return res;
				return { torrent: res.bytes };
			},
		});
	},
});
