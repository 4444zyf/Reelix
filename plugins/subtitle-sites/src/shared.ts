import type { Call, Outcome, PluginContext, PluginFetchInit, PluginFetchResponse, SubtitleSource } from "@reelix/plugin";

export type Settings = { subhd_url: string; assrt_url: string; opensubtitles_url: string; subdl_url: string; subdl_download_url: string; gestdown_url: string; jimaku_url: string };
export type Site = { ctx: PluginContext; settings: Settings };

/** The site answered with something other than what was asked for: expected, and not the plugin's fault. */
export class SiteAnswer extends Error {
	outcome: Outcome;
	constructor(outcome: Outcome) {
		super(outcome.outcome);
		this.outcome = outcome;
	}
}

export const unavailable = (message: string) => new SiteAnswer({ outcome: "unavailable", message });

const isNetworkTrouble = (e: unknown) => /^network/.test(String((e as { code?: unknown } | null)?.code ?? ""));

async function answering<T>(fn: () => Promise<T>): Promise<T | Outcome> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof SiteAnswer) return e.outcome;
		if (isNetworkTrouble(e)) return { outcome: "unavailable", message: (e as Error).message };
		throw e;
	}
}

/** A provider whose expected troubles (limits, refusals, an unreachable site) become outcomes. */
export function source(s: SubtitleSource): SubtitleSource {
	return {
		...s,
		search: (q, call) => answering(() => s.search(q, call) as Promise<never>),
		files: s.files && ((ref, call) => answering(() => s.files!(ref, call) as Promise<never>)),
		download: (ref, call) => answering(() => s.download(ref, call) as Promise<never>),
	};
}

export const base = (url: string) => url.replace(/\/+$/, "");
export const text = (r: PluginFetchResponse) => new TextDecoder().decode(r.bytes);

export function json<T = any>(r: PluginFetchResponse, site: string): T {
	try {
		return JSON.parse(text(r)) as T;
	} catch {
		throw unavailable(`${site} returned something that is not JSON (HTTP ${r.status}).`);
	}
}

export const get = (s: Site, service: string, url: string, call: Call, init: PluginFetchInit = {}) => s.ctx.http.fetch(url, { timeoutMs: 25_000, ...init, service, signal: call.signal });

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => (clearTimeout(t), reject(unavailable("cancelled"))), { once: true });
	});
}

export const pause = sleep;

/** A gentle pace: at least `gapMs` between requests to one site. */
export async function pace(s: Site, site: string, gapMs: number, call: Call): Promise<void> {
	const last = (await s.ctx.kv.get<number>(`pace.${site}`)) ?? 0;
	const wait = last + gapMs - Date.now();
	if (wait > 0) await sleep(wait, call.signal);
	await s.ctx.kv.set(`pace.${site}`, Date.now());
}

const han = (n: string) => /\p{Script=Han}/u.test(n) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(n);

/** The name Chinese sites know a title by: the display name when it is Chinese, else the first Chinese one. */
export const chineseName = (names: string[]) => names.find(han) ?? names[0] ?? "";

/** Names for sites that file under the original or English name: those first, each once. */
export const latinFirst = (names: string[]) => [...names.filter((n) => !han(n)), ...names.filter(han)];

export const unique = <T>(items: T[]) => [...new Set(items)];
