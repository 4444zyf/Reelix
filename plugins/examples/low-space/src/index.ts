import { Type, definePlugin } from "@reelix/plugin";

const GB = 1024 ** 3;

/** A recipe: a repeating job, settings, a stable record from Reelix, and one Inbox notice. */
export default definePlugin({
	config: Type.Object({ min_free_gb: Type.Number({ default: 50, minimum: 1 }) }),
	async activate(ctx, settings) {
		await ctx.job({
			name: "check",
			every: "60m",
			async run() {
				const { bytes } = await ctx.reelix.read.freeSpace();
				if (bytes === undefined) return { state: "succeeded", summary: ctx.t("unknown") };
				const free = Math.round(bytes / GB);
				if (bytes >= settings.min_free_gb * GB) return { state: "succeeded", summary: ctx.t("enough", { free }) };
				const { added } = await ctx.inbox.add({ title: ctx.t("title", { free }), body: ctx.t("body", { free, min: settings.min_free_gb }), key: "low" });
				return { state: "succeeded", summary: ctx.t(added ? "told" : "held", { free }) };
			},
		});
	},
});
