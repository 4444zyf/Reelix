import type { Call, SubtitleHit } from "@reelix/plugin";
import { type Site, SiteAnswer, base, get, json, latinFirst, pace, source, unavailable, unique } from "./shared.ts";

/** Jimaku: Japanese subtitles for anime. */
export function jimaku(s: Site) {
	const request = async <T = any>(path: string, call: Call): Promise<T> => {
		await pace(s, "jimaku", 1100, call);
		const res = await get(s, "jimaku", `${base(s.settings.jimaku_url)}${path}`, call, { headers: { authorization: (await s.ctx.secret.get("jimaku_api_key")) ?? "", accept: "application/json" } });
		if (res.status === 401) throw new SiteAnswer({ outcome: "needs_auth" });
		if (res.status === 429) throw new SiteAnswer({ outcome: "rate_limited" });
		if (!res.ok) throw unavailable(`Jimaku: HTTP ${res.status}`);
		return json<T>(res, "Jimaku");
	};

	return source({
		id: "jimaku",
		label: "Jimaku",
		kinds: ["anime"],
		languages: ["ja"],
		needsSecrets: ["jimaku_api_key"],
		async search(q, call) {
			let entry: { id: number; name: string } | undefined;
			for (const n of unique([q.text, ...latinFirst(q.names)].filter((x): x is string => !!x))) {
				entry = (await request<{ id: number; name: string }[]>(`/entries/search?anime=true&query=${encodeURIComponent(n)}`, call))[0];
				if (entry) break;
			}
			if (!entry) return [];
			const out: SubtitleHit[] = [];
			for (const ep of (q.episodes?.length ? q.episodes : [undefined]).slice(0, 30)) {
				const files = await request<{ name: string; size?: number; last_modified?: string }[]>(`/entries/${entry.id}/files${ep !== undefined ? `?episode=${ep}` : ""}`, call);
				for (const f of files)
					out.push({
						ref: `${entry.id}:${encodeURIComponent(f.name)}`,
						name: entry.name,
						release: f.name,
						languages: ["日本語"],
						language: "ja",
						formats: [f.name.split(".").pop()?.toUpperCase() ?? ""],
						size: f.size ? `${Math.round(f.size / 1024)} KB` : undefined,
						date: f.last_modified,
						episode: ep,
					});
			}
			return out.filter((c, i, a) => a.findIndex((x) => x.ref === c.ref) === i);
		},
		async download(id, call) {
			const [entryId, enc] = id.split(":");
			const name = decodeURIComponent(enc ?? "");
			const f = (await request<{ url: string; name: string }[]>(`/entries/${entryId}/files`, call)).find((x) => x.name === name);
			if (!f) throw unavailable(`Jimaku entry ${entryId} has no file "${name}" any more.`);
			const res = await get(s, "jimaku", f.url, call, { timeoutMs: 60_000 });
			if (!res.ok) throw unavailable(`Jimaku download failed: HTTP ${res.status}`);
			return { bytes: res.bytes, filename: f.name };
		},
	});
}
