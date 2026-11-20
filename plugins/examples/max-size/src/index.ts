import { Type, definePlugin } from "@reelix/plugin";

const GB = 1_000_000_000;

/**
 * A recipe for `download.before`: refuse with a reason. It sees what will really be downloaded, after the
 * owner's file selection; for a magnet that is known only once the downloader has loaded it, and Reelix
 * removes a refused magnet again.
 */
export default definePlugin({
	config: Type.Object({ max_gb: Type.Number({ default: 60, exclusiveMinimum: 0 }) }),
	async activate(ctx, settings) {
		await ctx.hook("download.before@1", ({ options }) => (options.size > settings.max_gb * GB ? { reason: ctx.t("reason", { size: (options.size / GB).toFixed(1), max: settings.max_gb }) } : undefined));
	},
});
