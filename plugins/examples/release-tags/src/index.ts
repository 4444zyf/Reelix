import { definePlugin } from "@reelix/plugin";
import type { TagRequest, TagResult, Tagged } from "./contract.ts";

const SEAM = "release-tags:tagger@1";

/**
 * A recipe for a seam of your own and an event of your own: release-tags owns the seam `release-tags:tagger@1`,
 * which other plugins provide (tag-hdr), and the event `release-tags:tagged`, which others listen to (hdr-alert).
 * It keeps the order of the releases and only adds the tags as notes, which the agent reads as facts.
 */
export default definePlugin({
	async activate(ctx) {
		await ctx.hook("release.rank@1", async ({ title, releases }) => {
			const asked: TagRequest[] = releases.map((r) => ({ ref: r.ref, name: r.title }));
			const answers = await ctx.seams.call<TagResult[]>(SEAM, "tag", [asked]);
			const tags = new Map<string, string[]>();
			for (const a of answers) {
				if (a.error) ctx.log(`${a.label}: ${a.error}`);
				for (const r of a.result ?? []) if (releases.some((x) => x.ref === r.ref)) tags.set(r.ref, [...new Set([...(tags.get(r.ref) ?? []), ...r.tags])]);
			}
			if (!tags.size) return undefined;
			const tagged: Tagged = { ...(title && { title: { id: title.id, name: title.name } }), releases: releases.filter((r) => tags.has(r.ref)).map((r) => ({ ref: r.ref, name: r.title, tags: tags.get(r.ref)! })) };
			await ctx.emit("release-tags:tagged", tagged);
			return {
				order: releases.map((r) => r.ref),
				notes: tagged.releases.map((r) => ({ ref: r.ref, note: ctx.t("note", { tags: r.tags.join(", ") }).slice(0, 200) })),
				reason: ctx.t("reason"),
			};
		});
	},
});
