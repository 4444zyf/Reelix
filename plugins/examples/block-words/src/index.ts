import { Type, definePlugin } from "@reelix/plugin";

const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A recipe for a guard hook: say no with a reason. Hidden releases stay visible to the owner. */
export default definePlugin({
	config: Type.Object({ words: Type.Array(Type.String({ minLength: 1 }), { default: ["CAM", "HDCAM", "TS", "HDTS", "TELESYNC"] }) }),
	async activate(ctx, settings) {
		const words = settings.words.map((word) => ({ word, pattern: new RegExp(`(^|[^\\p{L}\\p{N}])${escaped(word)}($|[^\\p{L}\\p{N}])`, "iu") }));
		await ctx.hook("release.filter@1", ({ releases }) =>
			releases.flatMap((r) => {
				const found = words.find((w) => w.pattern.test(r.title));
				return found ? [{ ref: r.ref, reason: ctx.t("reason", { word: found.word }) }] : [];
			}),
		);
	},
});
