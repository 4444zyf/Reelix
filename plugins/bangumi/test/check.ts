import type { PluginCheck } from "@reelix/plugin-testing";

/**
 * Answers recorded from Bangumi's API (api.bgm.tv: v0 and /calendar), for `reelix plugin check` and this
 * plugin's tests. Reelix fills in only the parts it reads; the shapes are Bangumi's.
 */
const BGM = "https://api.bgm.tv";
const json = (v: unknown) => JSON.stringify(v);
const FRIEREN = { id: 400602, type: 2, name: "葬送のフリーレン", name_cn: "葬送的芙莉莲", date: "2023-09-29", platform: "TV", eps: 28, total_episodes: 28, rating: { rank: 2, total: 52000, score: 9.1 }, images: {}, summary: "", tags: [] };
const FILM = { ...FRIEREN, id: 400603, name: "葬送のフリーレン ～●●の魔法～", name_cn: "", date: "2024-03-01", platform: "OVA", eps: 1, total_episodes: 1 };
const episodes = Array.from({ length: 28 }, (_, i) => ({ id: 1_227_087 + i, type: 0, sort: i + 1, ep: i + 1, name: `第${i + 1}話`, name_cn: "", airdate: new Date(Date.parse("2023-09-29") + i * 7 * 86_400_000).toISOString().slice(0, 10), duration: "00:24:40", comment: 100, desc: "", disc: 0, duration_seconds: 1480 }));
const calendarItem = (s: typeof FRIEREN, doing: number) => ({ id: s.id, url: `http://bgm.tv/subject/${s.id}`, type: 2, name: s.name, name_cn: s.name_cn, summary: "", air_date: s.date, air_weekday: 5, rating: { total: 52000, count: {}, score: s.rating.score }, rank: 2, images: {}, collection: { doing } });

export default {
	http: [
		{ url: `${BGM}/v0/search/subjects?limit=10`, method: "POST", body: json({ data: [FRIEREN, FILM], total: 2, limit: 10, offset: 0 }) },
		{ url: `${BGM}/v0/subjects/400602`, body: json(FRIEREN) },
		{ url: `${BGM}/v0/episodes?subject_id=400602&type=0&limit=100&offset=0`, body: json({ data: episodes, total: 28, limit: 100, offset: 0 }) },
		{
			url: `${BGM}/calendar`,
			body: json([1, 2, 3, 4, 5, 6, 7].map((id) => ({ weekday: { en: "", cn: "", ja: "", id }, items: id === 5 ? [calendarItem(FRIEREN, 52_000)] : id === 6 ? [{ ...calendarItem({ ...FRIEREN, id: 512345, name: "ある新作", name_cn: "某新番", date: "2026-10-03" }, 800), air_weekday: 6 }] : [] }))),
		},
	],
	seams: {
		"reelix:metadata.source@1": { provider: "bangumi", find: { text: "葬送のフリーレン", kind: "anime", expectHits: 2 }, link: { text: "https://bgm.tv/subject/400602", ids: { bangumi: 400602 } }, enrich: { bangumi: 400602 }, notMine: "https://movie.douban.com/subject/1291546/" },
		"reelix:trends.source@1": { provider: "bangumi", expectHits: 2 },
	},
} satisfies PluginCheck;
