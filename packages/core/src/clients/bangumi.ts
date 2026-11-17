import { http, expectOk } from "../http.ts";
import { ReelixError } from "../util.ts";

export type BgmSubject = {
	id: number;
	name: string;
	name_cn?: string;
	date?: string | null;
	eps?: number;
	total_episodes?: number;
	platform?: string;
	rating?: { score?: number };
	infobox?: { key: string; value: unknown }[];
	type?: number;
};

export type BgmEpisode = { id: number; type: number; sort: number; ep?: number; name: string; name_cn: string; airdate: string; duration?: string };

/** Bangumi's official API (api.bgm.tv v0). It requires a descriptive User-Agent. */
export class BangumiClient {
	base: string;
	proxy?: string;
	constructor(opts: { baseUrl?: string; proxy?: string }) {
		this.base = (opts.baseUrl ?? "https://api.bgm.tv").replace(/\/+$/, "");
		this.proxy = opts.proxy;
	}

	private async req<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
		const res = await http(this.base + path, {
			method: init.method,
			headers: { accept: "application/json", "content-type": "application/json", "user-agent": "4444zyf/Reelix (https://github.com/4444zyf/Reelix)" },
			body: init.body ? JSON.stringify(init.body) : undefined,
			proxy: this.proxy,
			timeoutMs: 15_000,
		});
		if (res.status === 404) throw new ReelixError("not_found", `Bangumi has no ${path}`);
		await expectOk(res, `Bangumi ${path}`);
		return res.json<T>();
	}

	/** Search anime (type 2). */
	async search(keyword: string, limit = 10): Promise<BgmSubject[]> {
		const r = await this.req<{ data: BgmSubject[] }>(`/v0/search/subjects?limit=${limit}`, { method: "POST", body: { keyword, filter: { type: [2] } } });
		return r.data ?? [];
	}

	async subject(id: number): Promise<BgmSubject> {
		return this.req(`/v0/subjects/${id}`);
	}

	/** Main-story episodes (type 0) with air dates. */
	async episodes(subjectId: number): Promise<BgmEpisode[]> {
		const out: BgmEpisode[] = [];
		for (let offset = 0; offset < 2000; offset += 100) {
			const r = await this.req<{ data: BgmEpisode[]; total: number }>(`/v0/episodes?subject_id=${subjectId}&type=0&limit=100&offset=${offset}`);
			out.push(...r.data);
			if (out.length >= r.total || !r.data.length) break;
		}
		return out;
	}
}
