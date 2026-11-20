import { Type, definePlugin } from "@reelix/plugin";
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
		subhd_url: Type.String({ default: "https://subhd.me" }),
		assrt_url: Type.String({ default: "https://api.assrt.net" }),
		opensubtitles_url: Type.String({ default: "https://api.opensubtitles.com/api/v1" }),
		subdl_url: Type.String({ default: "https://api.subdl.com/api/v1" }),
		subdl_download_url: Type.String({ default: "https://dl.subdl.com" }),
		gestdown_url: Type.String({ default: "https://api.gestdown.info" }),
		jimaku_url: Type.String({ default: "https://jimaku.cc/api" }),
	}),
	async activate(ctx, settings) {
		const site: Site = { ctx, settings };
		for (const make of [subhd, assrt, opensubtitles, subdl, gestdown, jimaku]) await ctx.provide(SEAM, make(site));

		await ctx.check("subhd", async ({ quick }) => {
			if (quick) return undefined;
			try {
				const res = await ctx.http.fetch(settings.subhd_url, { service: "subhd", timeoutMs: 10_000 });
				return { ok: res.status < 500, detail: `HTTP ${res.status}` };
			} catch (e) {
				return { ok: false, detail: e instanceof Error ? e.message : String(e) };
			}
		});
	},
});
