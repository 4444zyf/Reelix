import { type MetaHit, OperationError, type Outcome, Type, definePlugin } from "@reelix/plugin";

const LINK = /movie\.douban\.com\/subject\/(\d+)|^douban:(\d+)$/;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type Page = { title?: string; year?: number; rating?: number; imdb?: string; series: boolean };

/** Read Douban's ordinary public page (decision F): title, year, rating, IMDb ID, and whether it has episodes. */
function parsePage(html: string): Page {
	return {
		title: /<span property="v:itemreviewed">([^<]+)<\/span>/.exec(html)?.[1]?.trim(),
		year: Number(/<span class="year">\((\d{4})\)<\/span>/.exec(html)?.[1]) || undefined,
		rating: Number(/property="v:average">([\d.]+)</.exec(html)?.[1]) || undefined,
		imdb: /IMDb:<\/span>\s*(tt\d+)/.exec(html)?.[1],
		series: /<span class="pl">集数:<\/span>/.test(html),
	};
}

type Enriched = { title: string; ids: { douban?: string }; results: { provider: string; rating?: { value: number }; note?: string }[] };

export default definePlugin({
	async activate(ctx) {
		const label = ctx.t("label");
		/** The page, or why it could not be read: Douban often refuses machines, and the browser may be needed. */
		const page = async (id: string, signal: AbortSignal): Promise<Page | Outcome> => {
			try {
				const res = await ctx.http.fetch(`https://movie.douban.com/subject/${id}/`, { headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9" }, signal, timeoutMs: 15_000 });
				if (!res.ok) return { outcome: "unavailable", message: ctx.t("unreadable", { status: res.status }) };
				return parsePage(new TextDecoder().decode(res.bytes));
			} catch (e) {
				if (/^network/.test(String((e as { code?: unknown } | null)?.code ?? ""))) return { outcome: "unavailable", message: e instanceof Error ? e.message : String(e) };
				throw e;
			}
		};
		const rating = (p: Page) => (p.rating ? { value: p.rating, scale: 10 } : undefined);

		await ctx.provide("reelix:metadata.source@1", {
			id: "douban",
			label,
			async fromLink(text, call) {
				const m = LINK.exec(text);
				if (!m) return undefined;
				const douban = m[1] ?? m[2]!;
				const p = await page(douban, call.signal);
				if ("outcome" in p) return p;
				if (!p.title) return { outcome: "unavailable", message: ctx.t("unreadable", { status: 200 }) };
				const hit: MetaHit = { ids: { douban, imdb: p.imdb }, kind: p.series ? "show" : "movie", name: p.title, year: p.year, series: p.series, rating: rating(p) };
				return hit;
			},
			async enrich(ids, call) {
				if (!ids.douban) return {};
				const p = await page(ids.douban, call.signal);
				return "outcome" in p ? p : { rating: rating(p) };
			},
		});

		await ctx.operation({
			name: "rating",
			summary: "Refresh a title's Douban rating from the public page (Douban ID from subhd or a link)",
			effect: "write",
			input: Type.Object({ title_id: Type.String(), douban_id: Type.Optional(Type.String()) }),
			async run(i) {
				if (i.douban_id) await ctx.reelix.run("title.set", { id: i.title_id, douban_id: i.douban_id });
				const r = await ctx.reelix.run<Enriched>("title.enrich", { id: i.title_id, sources: ["douban"] });
				if (!r.ids.douban) throw new OperationError("not_found", "No Douban ID yet; it arrives with a subhd search (subtitle.search) or a Douban link.");
				const mine = r.results.find((x) => x.provider === "douban");
				if (!mine?.rating && mine?.note && mine.note !== "nothing for this title") throw new OperationError("douban", `Douban page unavailable (${mine.note}); best-effort, nothing else depends on it.`);
				return { title: r.title, douban_id: r.ids.douban, rating: mine?.rating?.value };
			},
			toText: (o: { title: string; douban_id: string; rating?: number }) => `${o.title}: Douban ${o.douban_id} ${o.rating ?? "no rating"}`,
		});
	},
});
