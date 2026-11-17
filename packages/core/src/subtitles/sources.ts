import type { Reelix } from "../app.ts";
import { json } from "../db.ts";
import { BROWSER_UA, http, proxyFor } from "../http.ts";
import { ReelixError, nowIso, sleep } from "../util.ts";

export type SubCandidate = {
	ref: string; // "subhd:N2Covz" | "assrt:123456"
	source: "subhd" | "assrt";
	title: string; // the title the site files it under
	release: string; // description: usually the release it was made for
	languages: string[]; // 简体, 繁体, 双语, 英语 …
	formats: string[]; // ASS, SRT
	tags: string[]; // 官方字幕, 机翻, 原创 …
	size?: string;
	downloads?: number;
	date?: string;
	uploader?: string;
	doubanId?: string;
	files?: string[];
	url?: string;
};

// ------------------------------------------------------------------ per-site state: pace, limits, verification

export type SiteState = { lastRequestAt?: number; dailyLimitUntil?: string; verificationSince?: string; downloadsToday?: number; day?: string; note?: string };

export function siteState(app: Reelix, site: string): SiteState {
	const r = app.db.prepare("SELECT state_json FROM site_state WHERE site = ?").get(site) as { state_json: string } | undefined;
	const s = json<SiteState>(r?.state_json, {});
	const today = nowIso().slice(0, 10);
	if (s.day !== today) {
		s.day = today;
		s.downloadsToday = 0;
		s.verificationSince = undefined;
	}
	return s;
}

export function saveSiteState(app: Reelix, site: string, s: SiteState): void {
	app.db.prepare("INSERT INTO site_state (site, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at").run(site, JSON.stringify(s), nowIso());
}

/** A gentle pace: at least `gapMs` between requests to one site (§5.5 step 4). */
async function pace(app: Reelix, site: string, gapMs: number): Promise<void> {
	const s = siteState(app, site);
	const wait = (s.lastRequestAt ?? 0) + gapMs - Date.now();
	if (wait > 0) await sleep(wait);
	s.lastRequestAt = Date.now();
	saveSiteState(app, site, s);
}

// ------------------------------------------------------------------ subhd (plain pages; no browser in the normal case)

function subhdBase(app: Reelix): string {
	return app.config.subtitles.subhd_url.replace(/\/+$/, "");
}

const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

/** Parse subhd's search result blocks (each: Douban ID, subtitle ID, description, tags, stats). */
export function parseSubhdSearch(html: string): SubCandidate[] {
	const out: SubCandidate[] = [];
	const blocks = html.split(/<div class="bg-white shadow-sm rounded-3 mb-4">/).slice(1);
	for (const b of blocks) {
		const sid = /href='\/a\/([A-Za-z0-9]+)'/.exec(b)?.[1] ?? /href="\/a\/([A-Za-z0-9]+)"/.exec(b)?.[1];
		if (!sid) continue;
		const doubanId = /href=['"]\/d\/(\d+)['"]/.exec(b)?.[1];
		const title = strip(/<div class="float-start f16 fw-bold">([\s\S]*?)<\/div>/.exec(b)?.[1] ?? "");
		const release = strip(/<div class="view-text[^"]*">([\s\S]*?)<\/div>/.exec(b)?.[1] ?? "");
		const tagHtml = /<div class="text-truncate py-2 f11">([\s\S]*?)<\/div>/.exec(b)?.[1] ?? "";
		const spans = [...tagHtml.matchAll(/<span([^>]*)>([\s\S]*?)<\/span>/g)].map((m) => ({ attrs: m[1]!, text: strip(m[2]!) })).filter((s) => s.text);
		const tags = spans.filter((s) => /rounded/.test(s.attrs)).map((s) => s.text);
		const languages = spans.filter((s) => /fw-bold/.test(s.attrs)).flatMap((s) => s.text.split(/[\s/]+/));
		const formats = spans.filter((s) => /text-secondary/.test(s.attrs)).flatMap((s) => s.text.split(/[\s/]+/));
		const stats = [...b.matchAll(/<span class=['"]?align-text-top me-3['"]?>([\s\S]*?)<\/span>/g)].map((m) => strip(m[1]!));
		const date = /datetime="([^"]+)"/.exec(b)?.[1];
		const uploader = strip(/发布人\s*<a[^>]*>([\s\S]*?)<\/a>/.exec(b)?.[1] ?? "") || undefined;
		out.push({ ref: `subhd:${sid}`, source: "subhd", title, release, languages, formats, tags, size: stats[0], downloads: Number(stats[1]) || undefined, date, uploader, doubanId });
	}
	return out;
}

export async function subhdSearch(app: Reelix, query: string): Promise<SubCandidate[]> {
	await pace(app, "subhd", 2500);
	const res = await http(`${subhdBase(app)}/search/${encodeURIComponent(query)}`, { headers: { "user-agent": BROWSER_UA, "accept-language": "zh-CN,zh;q=0.9" }, proxy: proxyFor(app.config, "subhd"), timeoutMs: 20_000 });
	if (res.status === 403 || res.status === 503) throw new ReelixError("verification_required", `subhd answered HTTP ${res.status} (a Cloudflare check?). Use the browser (verification skill).`, { url: `${subhdBase(app)}/search/${encodeURIComponent(query)}` });
	if (!res.ok) throw new ReelixError("http_error", `subhd search failed: HTTP ${res.status}`);
	return parseSubhdSearch(await res.text());
}

/** The files inside a subtitle archive, as listed on its page (choose before downloading, §5.5). */
export async function subhdFiles(app: Reelix, sid: string): Promise<string[]> {
	await pace(app, "subhd", 2500);
	const res = await http(`${subhdBase(app)}/a/${sid}`, { headers: { "user-agent": BROWSER_UA }, proxy: proxyFor(app.config, "subhd"), timeoutMs: 20_000 });
	if (!res.ok) return [];
	const html = await res.text();
	return [...html.matchAll(/data-filename="([^"]+)"/g)].map((m) => strip(m[1]!));
}

/**
 * subhd's download: prepare → the /down page (sets a short-lived cookie) → POST /api/sub/down,
 * which either passes with a file URL, asks for Turnstile, or reports the daily cap.
 */
export async function subhdDownload(app: Reelix, sid: string, turnstileToken: string | null = null): Promise<{ bytes: Uint8Array; filename: string }> {
	const base = subhdBase(app);
	const st = siteState(app, "subhd");
	if (st.dailyLimitUntil && st.dailyLimitUntil > nowIso()) throw new ReelixError("daily_limit", `subhd's daily download limit was reached; it resets ${st.dailyLimitUntil.slice(0, 16)}. Try ASSRT or tomorrow.`);
	const proxy = proxyFor(app.config, "subhd");
	const cookies = new Map<string, string>();
	const keep = (h: Headers) => {
		const raw = (h as any).getSetCookie?.() ?? (h.get("set-cookie") ? [h.get("set-cookie")!] : []);
		for (const c of raw as string[]) {
			const [kv] = c.split(";");
			const i = kv!.indexOf("=");
			if (i > 0) cookies.set(kv!.slice(0, i).trim(), kv!.slice(i + 1));
		}
	};
	const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
	const hdr = (referer: string) => ({ "user-agent": BROWSER_UA, referer, origin: base, "content-type": "application/json; charset=utf-8", cookie: cookieHeader() });

	await pace(app, "subhd", 2500);
	const p = await http(`${base}/api/sub/prepare-download`, { method: "POST", headers: hdr(`${base}/a/${sid}`), body: JSON.stringify({ sid }), proxy, timeoutMs: 20_000 });
	keep(p.headers);
	const pj = await p.json<{ success?: boolean; url?: string; msg?: string }>().catch(() => ({}) as any);
	if (!pj.success || !pj.url?.startsWith("/down/")) throw new ReelixError("subhd_error", `subhd would not prepare the download: ${pj.msg ?? p.status}`);
	const d = await http(`${base}${pj.url}`, { headers: { ...hdr(`${base}/a/${sid}`), "content-type": "text/html" }, proxy, timeoutMs: 20_000 });
	keep(d.headers);
	await d.text();
	await sleep(1200);
	const f = await http(`${base}/api/sub/down`, { method: "POST", headers: hdr(`${base}${pj.url}`), body: JSON.stringify({ sid, turnstileToken }), proxy, timeoutMs: 20_000 });
	const fj = await f.json<{ success?: boolean; pass?: boolean; url?: string; msg?: string; dailyLimitReached?: boolean; turnstileRequired?: boolean }>().catch(() => ({}) as any);
	const s2 = siteState(app, "subhd");
	if (fj.dailyLimitReached) {
		const t = new Date();
		t.setUTCHours(16, 5, 0, 0); // midnight China time
		if (t.getTime() < Date.now()) t.setUTCDate(t.getUTCDate() + 1);
		s2.dailyLimitUntil = t.toISOString();
		saveSiteState(app, "subhd", s2);
		throw new ReelixError("daily_limit", `subhd: ${fj.msg ?? "daily download limit reached"}. Try ASSRT, or tomorrow.`);
	}
	if (fj.turnstileRequired) {
		s2.verificationSince ??= nowIso();
		saveSiteState(app, "subhd", s2);
		throw new ReelixError("verification_required", `subhd asks for a human check (Cloudflare Turnstile) before more downloads today: ${fj.msg ?? ""}. Open ${base}${pj.url} in the browser and follow the verification skill, try ASSRT, or the owner can drop in the file.`, { url: `${base}${pj.url}` });
	}
	if (!fj.pass || !fj.url) throw new ReelixError("subhd_error", `subhd refused the download: ${fj.msg ?? f.status}`);
	const file = await http(fj.url, { headers: { "user-agent": BROWSER_UA }, proxy, timeoutMs: 60_000 });
	if (!file.ok) throw new ReelixError("subhd_error", `subhd file download failed: HTTP ${file.status}`);
	s2.downloadsToday = (s2.downloadsToday ?? 0) + 1;
	saveSiteState(app, "subhd", s2);
	return { bytes: await file.bytes(), filename: decodeURIComponent(fj.url.split("/").pop() ?? `${sid}.zip`) };
}

// ------------------------------------------------------------------ ASSRT (official API, 20 requests a minute)

function assrtToken(app: Reelix): string {
	const t = app.secrets["assrt.token"];
	if (!t) throw new ReelixError("not_configured", "No ASSRT token (secret assrt.token). Get one free at assrt.net.");
	return t;
}

async function assrtGet<T>(app: Reelix, path: string, params: Record<string, string>): Promise<T> {
	await pace(app, "assrt", 3200);
	const qs = new URLSearchParams({ token: assrtToken(app), ...params });
	const res = await http(`${app.config.subtitles.assrt_url.replace(/\/+$/, "")}${path}?${qs}`, { proxy: proxyFor(app.config, "assrt"), timeoutMs: 20_000 });
	const j = await res.json<any>();
	if (j.status !== 0) throw new ReelixError("assrt_error", `ASSRT: ${j.errmsg ?? `status ${j.status}`}`);
	return j as T;
}

export async function assrtSearch(app: Reelix, query: string): Promise<SubCandidate[]> {
	const j = await assrtGet<any>(app, "/v1/sub/search", { q: query, cnt: "15", pos: "0" });
	const subs = j.sub?.subs ?? [];
	return subs.map((s: any) => ({
		ref: `assrt:${s.id}`,
		source: "assrt" as const,
		title: s.native_name || s.videoname,
		release: s.videoname ?? "",
		languages: s.lang?.desc ? String(s.lang.desc).split(/\s+/) : Object.keys(s.lang?.langlist ?? {}),
		formats: s.subtype ? [s.subtype] : [],
		tags: [],
		date: s.upload_time,
	}));
}

export async function assrtDownload(app: Reelix, id: string): Promise<{ bytes: Uint8Array; filename: string }> {
	const j = await assrtGet<any>(app, "/v1/sub/detail", { id });
	const sub = j.sub?.subs?.[0];
	if (!sub?.url) throw new ReelixError("assrt_error", "ASSRT returned no download link (links expire; search again).");
	const res = await http(sub.url, { proxy: proxyFor(app.config, "assrt"), timeoutMs: 60_000 });
	if (!res.ok) throw new ReelixError("assrt_error", `ASSRT download failed: HTTP ${res.status}`);
	return { bytes: await res.bytes(), filename: sub.filename ?? `${id}.zip` };
}

export async function fetchCandidate(app: Reelix, ref: string): Promise<{ bytes: Uint8Array; filename: string }> {
	const [src, id] = ref.split(":");
	if (src === "subhd" && id) return subhdDownload(app, id);
	if (src === "assrt" && id) return assrtDownload(app, id);
	throw new ReelixError("invalid_input", `Unknown subtitle reference "${ref}" (expected subhd:<id> or assrt:<id>).`);
}
