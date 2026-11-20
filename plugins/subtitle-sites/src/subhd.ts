import type { Call, SubtitleHit, SubtitleQuery } from "@reelix/plugin";
import { type Site, base, chineseName, get, json, pace, pause, source, text, unavailable, SiteAnswer } from "./shared.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const GAP_MS = 2500;
const LIMIT_KEY = "subhd.limit_until";

const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

/** Parse subhd's search result blocks (each: Douban ID, subtitle ID, description, tags, stats). */
export function parseSubhdSearch(html: string): SubtitleHit[] {
	const out: SubtitleHit[] = [];
	for (const b of html.split(/<div class="bg-white shadow-sm rounded-3 mb-4">/).slice(1)) {
		const sid = /href='\/a\/([A-Za-z0-9]+)'/.exec(b)?.[1] ?? /href="\/a\/([A-Za-z0-9]+)"/.exec(b)?.[1];
		if (!sid) continue;
		const douban = /href=['"]\/d\/(\d+)['"]/.exec(b)?.[1];
		const tagHtml = /<div class="text-truncate py-2 f11">([\s\S]*?)<\/div>/.exec(b)?.[1] ?? "";
		const spans = [...tagHtml.matchAll(/<span([^>]*)>([\s\S]*?)<\/span>/g)].map((m) => ({ attrs: m[1]!, text: strip(m[2]!) })).filter((s) => s.text);
		const stats = [...b.matchAll(/<span class=['"]?align-text-top me-3['"]?>([\s\S]*?)<\/span>/g)].map((m) => strip(m[1]!));
		out.push({
			ref: sid,
			name: strip(/<div class="float-start f16 fw-bold">([\s\S]*?)<\/div>/.exec(b)?.[1] ?? ""),
			release: strip(/<div class="view-text[^"]*">([\s\S]*?)<\/div>/.exec(b)?.[1] ?? ""),
			languages: spans.filter((s) => /fw-bold/.test(s.attrs)).flatMap((s) => s.text.split(/[\s/]+/)),
			formats: spans.filter((s) => /text-secondary/.test(s.attrs)).flatMap((s) => s.text.split(/[\s/]+/)),
			tags: spans.filter((s) => /rounded/.test(s.attrs)).map((s) => s.text),
			size: stats[0],
			downloads: Number(stats[1]) || undefined,
			date: /datetime="([^"]+)"/.exec(b)?.[1],
			uploader: strip(/发布人\s*<a[^>]*>([\s\S]*?)<\/a>/.exec(b)?.[1] ?? "") || undefined,
			ids: douban ? { douban } : undefined,
		});
	}
	return out;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[\s.\-_:：·・'’!?,，。!？&]+/g, "").replace(/^the/, "");

/**
 * subhd files subtitles under the title's Douban ID (decision F). With the id known, hits under
 * another id go; without it, a single Douban entry filed under one of the title's names is the
 * title, and its id is reported on the hits so that Reelix records it.
 */
export function narrowToTitle(hits: SubtitleHit[], q: Pick<SubtitleQuery, "ids" | "names">): SubtitleHit[] {
	const known = q.ids.douban;
	const plain = hits.map(({ ids: _ids, ...h }) => h);
	if (known) return plain.filter((_, i) => !hits[i]!.ids?.douban || hits[i]!.ids!.douban === known);
	const wanted = new Set(q.names.map(norm));
	const byDouban = new Map<string, SubtitleHit[]>();
	for (const h of hits) if (h.ids?.douban) byDouban.set(h.ids.douban, [...(byDouban.get(h.ids.douban) ?? []), h]);
	const matches = [...byDouban.values()].filter((list) => list.some((h) => wanted.has(norm(h.name))));
	return matches.length === 1 ? matches[0]! : plain;
}

export function subhd(s: Site) {
	const url = () => base(s.settings.subhd_url);
	const request = async (path: string, call: Call, init: Parameters<typeof get>[4] = {}) => {
		await pace(s, "subhd", GAP_MS, call);
		return get(s, "subhd", `${url()}${path}`, call, { timeoutMs: 20_000, ...init, headers: { "user-agent": UA, ...init.headers } });
	};

	return source({
		id: "subhd",
		label: "SubHD",
		kinds: ["movie", "show", "anime"],
		languages: ["zh"],
		async search(q, call) {
			const path = `/search/${encodeURIComponent(q.text ?? chineseName(q.names))}`;
			const res = await request(path, call, { headers: { "accept-language": "zh-CN,zh;q=0.9" } });
			if (res.status === 403 || res.status === 503) return { outcome: "needs_verification", url: `${url()}${path}` };
			if (!res.ok) throw unavailable(`subhd search failed: HTTP ${res.status}`);
			return narrowToTitle(parseSubhdSearch(text(res)), q);
		},
		/** The files inside a subtitle archive, as listed on its page. */
		async files(sid, call) {
			const res = await request(`/a/${sid}`, call);
			if (!res.ok) return [];
			return [...text(res).matchAll(/data-filename="([^"]+)"/g)].map((m) => ({ name: strip(m[1]!) }));
		},
		/**
		 * prepare → the /down page (sets a short-lived cookie) → POST /api/sub/down, which passes
		 * with a file URL, asks for Turnstile, or reports the daily cap. The token of a passed check
		 * arrives in `call.verification`.
		 */
		async download(sid, call) {
			const until = await s.ctx.kv.get<string>(LIMIT_KEY);
			if (until && until > new Date().toISOString()) return { outcome: "rate_limited", until };
			const root = url();
			const cookies = new Map<string, string>();
			const keep = (list: string[]) => {
				for (const c of list) {
					const [kv] = c.split(";");
					const i = kv!.indexOf("=");
					if (i > 0) cookies.set(kv!.slice(0, i).trim(), kv!.slice(i + 1));
				}
			};
			const headers = (referer: string) => ({ referer, origin: root, "content-type": "application/json; charset=utf-8", cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") });

			const prepared = await request("/api/sub/prepare-download", call, { method: "POST", headers: headers(`${root}/a/${sid}`), body: JSON.stringify({ sid }) });
			keep(prepared.cookies);
			const pj = json<{ success?: boolean; url?: string; msg?: string }>(prepared, "subhd");
			if (!pj.success || !pj.url?.startsWith("/down/")) throw unavailable(`subhd would not prepare the download: ${pj.msg ?? prepared.status}`);
			const page = await get(s, "subhd", `${root}${pj.url}`, call, { timeoutMs: 20_000, headers: { "user-agent": UA, ...headers(`${root}/a/${sid}`), "content-type": "text/html" } });
			keep(page.cookies);
			await pause(1200, call.signal);
			const down = await get(s, "subhd", `${root}/api/sub/down`, call, { timeoutMs: 20_000, method: "POST", headers: { "user-agent": UA, ...headers(`${root}${pj.url}`) }, body: JSON.stringify({ sid, turnstileToken: call.verification ?? null }) });
			const fj = json<{ pass?: boolean; url?: string; msg?: string; dailyLimitReached?: boolean; turnstileRequired?: boolean }>(down, "subhd");
			if (fj.dailyLimitReached) {
				const t = new Date();
				t.setUTCHours(16, 5, 0, 0); // midnight China time
				if (t.getTime() < Date.now()) t.setUTCDate(t.getUTCDate() + 1);
				await s.ctx.kv.set(LIMIT_KEY, t.toISOString());
				throw new SiteAnswer({ outcome: "rate_limited", until: t.toISOString() });
			}
			if (fj.turnstileRequired) return { outcome: "needs_verification", url: `${root}${pj.url}` };
			if (!fj.pass || !fj.url) throw unavailable(`subhd refused the download: ${fj.msg ?? down.status}`);
			const file = await get(s, "subhd", fj.url, call, { timeoutMs: 60_000, headers: { "user-agent": UA } });
			if (!file.ok) throw unavailable(`subhd file download failed: HTTP ${file.status}`);
			return { bytes: file.bytes, filename: decodeURIComponent(fj.url.split("/").pop() ?? `${sid}.zip`) };
		},
	});
}
