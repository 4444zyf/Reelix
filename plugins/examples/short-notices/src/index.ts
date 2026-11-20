import { Type, definePlugin } from "@reelix/plugin";

/** A recipe for changing a notice: wording only. Reelix adds that this plugin edited it. */
export default definePlugin({
	config: Type.Object({ max_body: Type.Integer({ default: 140, minimum: 20, maximum: 1000 }) }),
	async activate(ctx, settings) {
		await ctx.hook("notify.before@1", ({ body }) => {
			if (!body || body.length <= settings.max_body) return undefined;
			return { body: `${body.slice(0, settings.max_body - 1).trimEnd()}…`, reason: ctx.t("reason", { max: settings.max_body }) };
		});
	},
});
