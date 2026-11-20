import { definePlugin, outsideLine } from "@reelix/plugin";

/**
 * After filing, look for subtitles in the owner's first wanted language. Code checks what is
 * already there (no model call when the preference is met); choosing is the agent's judgement.
 */
export default definePlugin({
	async activate(ctx) {
		await ctx.job({
			name: "find",
			async run({ payload }) {
				const titleId = payload.title_id as string;
				const t = await ctx.reelix.read.title(titleId);
				if (!t) return { state: "failed", summary: "title gone" };
				const seasons = t.series ? ((payload.seasons as number[] | undefined) ?? []) : [];
				const { wanted, missing } = await ctx.reelix.read.missingSubtitles(t.id, seasons);
				const first = wanted[0]!;
				if (!missing.length) return { state: "succeeded", summary: `${first.label} subtitles already present (embedded or external); nothing to do.` };
				const prefs = await ctx.reelix.read.preferences();
				// One translation offer per title and season, ever (docs/subtitle-translation.md §1).
				const offerKey = `translate.offered:${t.id}:${seasons.join(",")}`;
				const mayOffer = !(await ctx.kv.get(offerKey));
				if (mayOffer) await ctx.kv.set(offerKey, new Date().toISOString());
				const download = payload.hash ? await ctx.reelix.read.download(payload.hash as string) : undefined;
				const release = download && outsideLine(download.name);
				const r = await ctx.agent.run({
					title: payload.title as string,
					prompt: `${outsideLine(t.name)} (${t.id}) was just filed and ${missing.length} video(s) lack ${first.label} subtitles (wanted, in order: ${wanted.map((l) => l.label).join(" > ")}):\n${missing.slice(0, 20).map((m) => outsideLine(m)).join("\n")}${missing.length > 20 ? "\n…" : ""}\n\nLoad the subtitles skill. Search once per season (subtitle_search title_id=${t.id}${t.series ? " season=N" : ""}), choose the best candidate for the owner's preference${prefs ? "" : first.code === "zh" ? " (default: 简体&English bilingual, then 简体; ASS over SRT)" : " (default: the first wanted language, human-made, matching the release; SRT or ASS)"} and the release (${release ?? "see title_show"}), and fetch it with subtitle_fetch. If a site asks for verification, follow the verification skill (in a background job: notify, then park). If nothing suitable exists in ${first.label}: ${mayOffer ? `load the translation skill. If a usable text subtitle in another language exists (subtitle_translate_sources) or can be fetched, and the preferences note does not already settle it, offer once to translate it (notify with wait=true and options, then stop; start it only on a yes). If the note says to translate such titles without asking, start it.` : `a translation was already offered for this once; do not offer again.`} Otherwise say so in one line.`,
				});
				if (r.parkedOn) return { state: "parked", summary: r.text };
				return { state: r.state === "done" ? "succeeded" : "failed", summary: r.text };
			},
		});

		await ctx.on("download.filed", async ({ hash, titleId, via }) => {
			// As it always was: for downloads, not for a library being adopted or a hand-made plan.
			if (via !== "download" || !titleId) return;
			const seasons = hash ? ((await ctx.reelix.read.download(hash))?.seasons ?? []) : [];
			const name = (await ctx.reelix.read.title(titleId))?.name ?? titleId;
			await ctx.jobs.enqueue("find", { title_id: titleId, seasons, hash, title: ctx.t("jobTitle", { name }) }, { dedupe: `${titleId}:${seasons.join(",")}` });
		});
	},
});
