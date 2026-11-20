import { extname } from "node:path";
import { definePlugin } from "@reelix/plugin";

const stem = (path: string) => path.slice(0, path.length - extname(path).length);

/** A recipe for a naming hook: change paths inside Reelix's limits, and keep subtitles beside their video. */
export default definePlugin({
	async activate(ctx) {
		await ctx.hook("organise.name@1", ({ items }) => {
			const changes = items.flatMap((video) => {
				const { resolution } = video.parsed;
				if (video.kind !== "video" || !resolution || stem(video.path).includes(resolution)) return [];
				const before = stem(video.path);
				const after = `${before} - ${resolution}`;
				return items.filter((i) => i === video || (i.kind !== "video" && i.path.startsWith(`${before}.`))).map((i) => ({ source: i.source, path: after + i.path.slice(before.length) }));
			});
			return changes.length ? { items: changes, reason: ctx.t("reason") } : undefined;
		});
	},
});
