import { definePlugin } from "@reelix/plugin";

type Refreshed = { language: string; refreshed: number; failed: { id: string; error: string }[] };

/**
 * One language everywhere: when the owner's language changes, titles, overviews and posters are
 * re-read from TMDB in it (a background job; library folder names never change).
 */
export default definePlugin({
	async activate(ctx) {
		await ctx.job({
			name: "refresh",
			async run() {
				const r = await ctx.reelix.run<Refreshed>("title.refresh_metadata", {});
				await ctx.kv.set("locale", r.language);
				const summary = ctx.t("refreshed", { count: r.refreshed, locale: r.language });
				return {
					state: r.failed.length && !r.refreshed ? "failed" : "succeeded",
					summary: r.failed.length ? `${summary} ${ctx.t("failed", { count: r.failed.length })}` : summary,
				};
			},
		});

		const check = async () => {
			const { metadataLocale, tmdbKey } = await ctx.reelix.read.services();
			if ((await ctx.kv.get("locale")) === metadataLocale) return;
			const { withTmdb } = await ctx.reelix.read.titles();
			if (!withTmdb || !tmdbKey) return ctx.kv.set("locale", metadataLocale); // nothing to re-read yet
			await ctx.jobs.enqueue("refresh", { title: ctx.t("jobTitle") }, { dedupe: metadataLocale });
			ctx.log(`titles will be re-read in ${metadataLocale}`);
		};

		await ctx.on("config.changed", async ({ paths }) => {
			if (paths.includes("language")) await check();
		});
		await check(); // a change made while Reelix was stopped or this plugin was off
	},
});
