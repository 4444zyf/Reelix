import { SETTINGS, Type, definePlugin } from "@reelix/plugin";
import { assrt } from "./assrt.ts";
import { gestdown } from "./gestdown.ts";
import { jimaku } from "./jimaku.ts";
import { opensubtitles } from "./opensubtitles.ts";
import type { Site } from "./shared.ts";
import { subdl } from "./subdl.ts";
import { subhd } from "./subhd.ts";

const SEAM = "reelix:subtitle.source@1";

export default definePlugin({
	config: Type.Object({
		subhd_url: Type.String({ default: "https://subhd.me", [SETTINGS.advanced]: true }),
		assrt_url: Type.String({ default: "https://api.assrt.net", [SETTINGS.advanced]: true }),
		opensubtitles_url: Type.String({ default: "https://api.opensubtitles.com/api/v1", [SETTINGS.advanced]: true }),
		subdl_url: Type.String({ default: "https://api.subdl.com/api/v1", [SETTINGS.advanced]: true }),
		subdl_download_url: Type.String({ default: "https://dl.subdl.com", [SETTINGS.advanced]: true }),
		gestdown_url: Type.String({ default: "https://api.gestdown.info", [SETTINGS.advanced]: true }),
		jimaku_url: Type.String({ default: "https://jimaku.cc/api", [SETTINGS.advanced]: true }),
	}),
	async activate(ctx, settings) {
		const site: Site = { ctx, settings };
		for (const make of [subhd, assrt, opensubtitles, subdl, gestdown, jimaku]) await ctx.provide(SEAM, make(site));

		await ctx.check("subhd", async ({ quick }) => {
			if (quick) return undefined;
			const down = (raw: string) => ({ state: "failed", cause: { key: "checks.subhd_unreachable" }, impact: { key: "checks.subhd_unreachable_impact" }, raw }) as const;
			try {
				const res = await ctx.http.fetch(settings.subhd_url, { service: "subhd", timeoutMs: 10_000 });
				return res.status < 500 ? ({ state: "passed", cause: { key: "checks.subhd_ok" }, raw: `HTTP ${res.status}` } as const) : down(`HTTP ${res.status}`);
			} catch (e) {
				return down(e instanceof Error ? e.message : String(e));
			}
		});
	},
});
