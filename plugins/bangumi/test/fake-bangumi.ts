import { send, sendJson, startServer } from "../../../packages/core/test/fakes/server.ts";

/**
 * A fake Bangumi API for the bangumi plugin and the demo: search, subjects, main episodes with air dates and the
 * weekly calendar. Its shapes are Bangumi's (api.bgm.tv v0 and /calendar), filled in only where Reelix reads them.
 */

export type FakeSubject = { id: number; name: string; name_cn?: string; date: string; platform: string; eps: number; score?: number; weekday?: number; watching?: number };

/** Frieren's first season as Bangumi has it: 28 weekly episodes from 2023-09-29, the dates TMDB has. */
export const FRIEREN: FakeSubject = { id: 400602, name: "葬送のフリーレン", name_cn: "葬送的芙莉莲", date: "2023-09-29", platform: "TV", eps: 28, score: 9.1, weekday: 5, watching: 52_000 };
/** Airing, and not in the fake TMDB: a trend that cannot be matched is left out. */
export const UNKNOWN_ANIME: FakeSubject = { id: 512345, name: "まだ誰も知らないアニメ", name_cn: "无人知晓的动画", date: "2026-10-03", platform: "TV", eps: 12, score: 6.8, weekday: 6, watching: 800 };
export const FRIEREN_FILM: FakeSubject = { id: 400603, name: "葬送のフリーレン 劇場版", date: "2024-03-01", platform: "劇場版", eps: 1 };

export type FakeBangumi = { url: string; requests: string[]; close(): Promise<void> };

export async function startFakeBangumi(o: { subjects?: FakeSubject[] } = {}): Promise<FakeBangumi> {
	const subjects = o.subjects ?? [FRIEREN, UNKNOWN_ANIME, FRIEREN_FILM];
	const requests: string[] = [];
	const subject = (s: FakeSubject) => ({ id: s.id, type: 2, name: s.name, name_cn: s.name_cn ?? "", date: s.date, platform: s.platform, eps: s.eps, total_episodes: s.eps, rating: { score: s.score ?? 0 } });
	const day = (date: string, i: number) => new Date(Date.parse(date) + i * 7 * 86_400_000).toISOString().slice(0, 10);
	const server = await startServer((req, res) => {
		requests.push(`${req.method} ${req.url.pathname}${req.url.search}`);
		if (!/Reelix/.test(String(req.headers["user-agent"] ?? ""))) return sendJson(res, 403, { title: "Forbidden", description: "a descriptive User-Agent is required" });
		const p = req.url.pathname;
		let m: RegExpExecArray | null;
		if (p === "/v0/search/subjects" && req.method === "POST") {
			const keyword = String(JSON.parse(req.body.toString("utf8")).keyword ?? "");
			const hits = subjects.filter((s) => s.name.includes(keyword) || keyword.includes(s.name) || (s.name_cn ?? "").includes(keyword));
			return sendJson(res, 200, { data: hits.map(subject), total: hits.length, limit: 10, offset: 0 });
		}
		if ((m = /^\/v0\/subjects\/(\d+)$/.exec(p))) {
			const s = subjects.find((x) => x.id === Number(m![1]));
			return s ? sendJson(res, 200, subject(s)) : sendJson(res, 404, { title: "Not Found" });
		}
		if (p === "/v0/episodes") {
			const s = subjects.find((x) => x.id === Number(req.url.searchParams.get("subject_id")));
			if (!s) return sendJson(res, 404, { title: "Not Found" });
			const all = Array.from({ length: s.eps }, (_, i) => ({ id: s.id * 1000 + i + 1, type: 0, sort: i + 1, ep: i + 1, name: `Episode ${i + 1}`, name_cn: "", airdate: day(s.date, i), duration: "00:24:00" }));
			// A special (type 1) is not part of the main story.
			const typed = req.url.searchParams.get("type") === "0" ? all : [...all, { id: s.id * 1000 + 999, type: 1, sort: 1, name: "SP", name_cn: "", airdate: "" }];
			const offset = Number(req.url.searchParams.get("offset") ?? 0);
			const limit = Number(req.url.searchParams.get("limit") ?? 100);
			return sendJson(res, 200, { data: typed.slice(offset, offset + limit), total: typed.length, limit, offset });
		}
		if (p === "/calendar") {
			const days = [1, 2, 3, 4, 5, 6, 7].map((id) => ({
				weekday: { en: "", cn: "", ja: "", id },
				items: subjects.filter((s) => s.weekday === id).map((s) => ({ id: s.id, url: `http://bgm.tv/subject/${s.id}`, type: 2, name: s.name, name_cn: s.name_cn ?? "", air_date: s.date, air_weekday: id, rating: { total: 100, score: s.score ?? 0 }, collection: { doing: s.watching ?? 0 } })),
			}));
			return sendJson(res, 200, days);
		}
		return send(res, 404, "");
	});
	return { url: server.url, requests, close: server.close };
}
