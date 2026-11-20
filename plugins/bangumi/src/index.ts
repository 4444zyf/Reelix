import { type MetaHit, type Outcome, Type, definePlugin } from "@reelix/plugin";
import { BangumiClient, BangumiError, type BgmSubject } from "./client.ts";

const LINK = /(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/(\d+)|^bangumi:(\d+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const expected = (e: unknown) => e instanceof BangumiError || /^network/.test(String((e as { code?: unknown } | null)?.code ?? ""));
const outcomeOf = (e: unknown): Outcome => (e instanceof BangumiError && e.kind === "rate_limited" ? { outcome: "rate_limited" } : { outcome: "unavailable", message: e instanceof Error ? e.message : String(e) });

/** Bangumi being away, limiting or refusing is an outcome, not a broken plugin (docs/plugins.md §7). */
async function answering<T>(fn: () => Promise<T>): Promise<T | Outcome> {
	try {
		return await fn();
	} catch (e) {
		if (expected(e)) return outcomeOf(e);
		throw e;
	}
}

const yearOf = (date?: string | null) => (date ? Number(date.slice(0, 4)) || undefined : undefined);

/** A subject as a hit. Bangumi has one entry per season (or cour); `series` follows its platform: TV or not. */
const toHit = (s: BgmSubject): MetaHit => ({
	ids: { bangumi: s.id },
	kind: "anime",
	name: s.name,
	names: s.name_cn ? [s.name_cn] : undefined,
	year: yearOf(s.date),
	series: s.platform ? /TV/i.test(s.platform) : undefined,
	episodes: s.eps ?? s.total_episodes,
	rating: s.rating?.score ? { value: s.rating.score, scale: 10 } : undefined,
});

/** Today's weekday as Bangumi numbers it: Monday 1 … Sunday 7. */
const today = () => new Date().getDay() || 7;

export default definePlugin({
	config: Type.Object({ base_url: Type.String({ default: "https://api.bgm.tv" }) }),
	async activate(ctx, settings) {
		const bgm = new BangumiClient(ctx.http.fetch, { baseUrl: settings.base_url });

		await ctx.provide("reelix:metadata.source@1", {
			id: "bangumi",
			label: "Bangumi",
			// Bangumi knows anime only.
			find: (q, call) => answering(async () => (q.kind && q.kind !== "anime" ? [] : (await bgm.search(q.text, 10, call.signal)).map(toHit))),
			fromLink: (text, call) =>
				answering(async () => {
					const m = LINK.exec(text);
					if (!m) return undefined;
					const hit = toHit(await bgm.subject(Number(m[1] ?? m[2]), call.signal));
					return { ...hit, note: ctx.t("perSeason") };
				}),
			enrich: (ids, call) =>
				answering(async () => {
					if (!ids.bangumi) return {};
					const episodes = (await bgm.episodes(ids.bangumi, call.signal)).filter((e) => e.type === 0);
					return { episodes: episodes.map((e) => ({ number: e.sort, airDate: DATE.test(e.airdate) ? e.airdate : undefined })) };
				}),
		});

		// What is airing now, by how many people on Bangumi are watching it: the nearest thing its API has to "trending".
		await ctx.provide("reelix:trends.source@1", {
			id: "bangumi",
			label: "Bangumi",
			trending: (o, call) =>
				answering(async () => {
					if (o.kind === "movie") return [];
					const days = await bgm.calendar(call.signal);
					const items = days.filter((d) => o.window === "week" || d.weekday.id === today()).flatMap((d) => d.items);
					return items
						.sort((a, b) => (b.collection?.doing ?? 0) - (a.collection?.doing ?? 0))
						.slice(0, 30)
						.map((i) => ({ ids: { bangumi: i.id }, kind: "anime" as const, name: i.name, names: i.name_cn ? [i.name_cn] : undefined, year: yearOf(i.air_date), rating: i.rating?.score || undefined }));
				}),
		});

		await ctx.check("bangumi", async ({ quick }) => {
			if (quick) return undefined;
			try {
				await bgm.subject(1, ctx.signal);
				return { ok: true, detail: `reachable at ${bgm.base}` };
			} catch (e) {
				if (!expected(e)) throw e;
				// An entry it does not have is still an answer: Bangumi is reachable.
				if (e instanceof BangumiError && e.kind === "not_found") return { ok: true, detail: `reachable at ${bgm.base}` };
				return { ok: false, detail: e instanceof Error ? e.message : String(e) };
			}
		});
	},
});
