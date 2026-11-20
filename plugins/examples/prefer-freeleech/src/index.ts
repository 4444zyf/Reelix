import { definePlugin } from "@reelix/plugin";

/** A recipe for a ranking hook: a new order of the same releases, with notes the agent reads as facts. */
export default definePlugin({
	async activate(ctx) {
		await ctx.hook("release.rank@1", ({ releases }) => {
			const free = releases.filter((r) => r.downloadFactor === 0);
			if (!free.length) return undefined;
			const others = releases.filter((r) => r.downloadFactor !== 0);
			return {
				order: [...free, ...others].map((r) => r.ref),
				notes: free.map((r) => ({ ref: r.ref, note: ctx.t("note") })),
				reason: ctx.t("reason"),
			};
		});
	},
});
