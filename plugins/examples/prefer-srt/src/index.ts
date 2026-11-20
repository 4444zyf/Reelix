import { definePlugin } from "@reelix/plugin";

/**
 * A recipe for `subtitle.pick`: change scores, never the files. Reelix's score puts ASS over SRT within a
 * language (2 against 1) and a language step ten points apart, so adding 1.5 to SRT reverses only the format,
 * never the owner's order of languages. For players that draw ASS styling badly.
 */
export default definePlugin({
	async activate(ctx) {
		await ctx.hook("subtitle.pick@1", ({ files }) => {
			const srt = files.filter((f) => f.format === "srt");
			return srt.length ? { files: srt.map((f) => ({ name: f.name, score: f.score + 1.5 })), reason: ctx.t("reason") } : undefined;
		});
	},
});
