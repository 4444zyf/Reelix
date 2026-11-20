import type { Call, SubtitleHit } from "@reelix/plugin";
import { type Site, base, chineseName, get, json, latinFirst, pace, source, unavailable, unique } from "./shared.ts";

/** ASSRT: the official API, 20 requests a minute. */
export function assrt(s: Site) {
	const request = async (path: string, params: Record<string, string>, call: Call) => {
		await pace(s, "assrt", 3200, call);
		const token = (await s.ctx.secret.get("assrt_token")) ?? "";
		const res = await get(s, "assrt", `${base(s.settings.assrt_url)}${path}?${new URLSearchParams({ token, ...params })}`, call, { timeoutMs: 20_000 });
		const j = json(res, "ASSRT");
		if (j.status !== 0) throw unavailable(`ASSRT: ${j.errmsg ?? `status ${j.status}`}`);
		return j;
	};

	return source({
		id: "assrt",
		label: "ASSRT",
		kinds: ["movie", "show", "anime"],
		languages: ["zh", "en"],
		needsSecrets: ["assrt_token"],
		async search(q, call) {
			const season = q.season !== undefined ? ` S${String(q.season).padStart(2, "0")}` : "";
			for (const name of unique([q.text ?? chineseName(q.names), latinFirst(q.names)[0]].filter((x): x is string => !!x))) {
				const j = await request("/v1/sub/search", { q: name + season, cnt: "15", pos: "0" }, call);
				const hits: SubtitleHit[] = (j.sub?.subs ?? []).map((x: any) => ({
					ref: String(x.id),
					name: x.native_name || x.videoname,
					release: x.videoname ?? "",
					languages: x.lang?.desc ? String(x.lang.desc).split(/\s+/) : Object.keys(x.lang?.langlist ?? {}),
					formats: x.subtype ? [x.subtype] : [],
					date: x.upload_time,
				}));
				if (hits.length) return hits.slice(0, 10);
			}
			return [];
		},
		async download(id, call) {
			const j = await request("/v1/sub/detail", { id }, call);
			const sub = j.sub?.subs?.[0];
			if (!sub?.url) throw unavailable("ASSRT returned no download link (links expire; search again).");
			const res = await get(s, "assrt", sub.url, call, { timeoutMs: 60_000 });
			if (!res.ok) throw unavailable(`ASSRT download failed: HTTP ${res.status}`);
			return { bytes: res.bytes, filename: sub.filename ?? `${id}.zip` };
		},
	});
}
