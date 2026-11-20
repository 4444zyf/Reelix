import { definePlugin } from "@reelix/plugin";
import { translateChunk } from "./translate.ts";

/**
 * The translator Reelix ships (docs/plugins.md §7.8): each chunk of subtitle lines goes to the owner's models
 * in the `translate` role, through `ctx.model`. It asks to run without a daily budget, as translation always
 * has: a season is long work the owner asked for. The owner can set a budget on its page.
 */
export default definePlugin({
	async activate(ctx) {
		await ctx.provide("reelix:translator@1", {
			id: "model-translator",
			label: ctx.t("label"),
			translate: (job, call) => translateChunk((request) => ctx.model.complete(request), job, call.signal),
		});
	},
});
