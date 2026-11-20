import { definePlugin } from "@reelix/plugin";
import type { Tagged } from "reelix-plugin-release-tags/contract";

const HDR = ["HDR", "HDR10", "HDR10+", "Dolby Vision", "HLG"];

/** A recipe for listening to an event another plugin owns: its payload type comes from that plugin's package. */
export default definePlugin({
	async activate(ctx) {
		await ctx.on("release-tags:tagged", async (payload) => {
			const { title, releases } = payload as Tagged;
			if (!title) return; // a search by words, not for a title
			const hdr = releases.filter((r) => r.tags.some((t) => HDR.includes(t)));
			if (!hdr.length || (await ctx.kv.get(`told:${title.id}`))) return;
			const { added } = await ctx.inbox.add({ title: ctx.t("title", { name: title.name }), body: hdr.map((r) => `- ${r.name} (${r.tags.join(", ")})`).join("\n"), key: title.id });
			if (added) await ctx.kv.set(`told:${title.id}`, new Date().toISOString());
		});
	},
});
