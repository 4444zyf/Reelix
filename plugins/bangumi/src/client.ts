import type { PluginContext } from "@reelix/plugin";

export type BgmSubject = {
	id: number;
	name: string;
	name_cn?: string;
	date?: string | null;
	eps?: number;
	total_episodes?: number;
	platform?: string;
	rating?: { score?: number };
	type?: number;
};

export type BgmEpisode = { id: number; type: number; sort: number; ep?: number; name: string; name_cn: string; airdate: string; duration?: string };

/** One anime of the weekly airing calendar (`/calendar`): `collection.doing` is how many are watching it. */
export type BgmCalendarItem = { id: number; name: string; name_cn?: string; air_date?: string; rating?: { score?: number }; collection?: { doing?: number } };
export type BgmCalendarDay = { weekday: { id: number }; items: BgmCalendarItem[] };

/** An answer of Bangumi that is expected now and then: no such entry, a limit, or a refusal. */
export class BangumiError extends Error {
	kind: "not_found" | "rate_limited" | "refused";
	constructor(kind: BangumiError["kind"], message: string) {
		super(message);
		this.kind = kind;
	}
}

type Fetch = PluginContext["http"]["fetch"];

/** Bangumi's official API (api.bgm.tv: v0, and the calendar), through Reelix's fetch. It requires a descriptive User-Agent. */
export class BangumiClient {
	readonly base: string;
	private fetch: Fetch;
	constructor(fetch: Fetch, opts: { baseUrl: string }) {
		this.fetch = fetch;
		this.base = opts.baseUrl.replace(/\/+$/, "");
	}

	private async req<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
		const res = await this.fetch(this.base + path, {
			method: init.method,
			headers: { accept: "application/json", "content-type": "application/json", "user-agent": "4444zyf/Reelix (https://github.com/4444zyf/Reelix)" },
			body: init.body ? JSON.stringify(init.body) : undefined,
			signal: init.signal,
			timeoutMs: 15_000,
		});
		if (res.status === 404) throw new BangumiError("not_found", `Bangumi has no ${path}`);
		if (res.status === 429) throw new BangumiError("rate_limited", "Bangumi's limit is reached");
		if (!res.ok) throw new BangumiError("refused", `Bangumi ${path}: HTTP ${res.status}`);
		return JSON.parse(new TextDecoder().decode(res.bytes)) as T;
	}

	/** Search anime (type 2). */
	async search(keyword: string, limit: number, signal?: AbortSignal): Promise<BgmSubject[]> {
		const r = await this.req<{ data: BgmSubject[] }>(`/v0/search/subjects?limit=${limit}`, { method: "POST", body: { keyword, filter: { type: [2] } }, signal });
		return r.data ?? [];
	}

	async subject(id: number, signal?: AbortSignal): Promise<BgmSubject> {
		return this.req(`/v0/subjects/${id}`, { signal });
	}

	/** Main-story episodes (type 0) with air dates. */
	async episodes(subjectId: number, signal?: AbortSignal): Promise<BgmEpisode[]> {
		const out: BgmEpisode[] = [];
		for (let offset = 0; offset < 2000; offset += 100) {
			const r = await this.req<{ data: BgmEpisode[]; total: number }>(`/v0/episodes?subject_id=${subjectId}&type=0&limit=100&offset=${offset}`, { signal });
			out.push(...r.data);
			if (out.length >= r.total || !r.data.length) break;
		}
		return out;
	}

	/** The anime airing this week, by weekday (1 = Monday … 7 = Sunday). */
	async calendar(signal?: AbortSignal): Promise<BgmCalendarDay[]> {
		return this.req("/calendar", { signal });
	}
}
