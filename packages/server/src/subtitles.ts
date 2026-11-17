import { type Reelix, existingSubtitles, getDownload, getTitle, json, readNoteSafe, videosOf } from "./subtitles-deps.ts";
import type { Subsystem } from "./plugins.ts";

/**
 * After filing, look for Chinese subtitles (§5.5). Code checks what is already there (no model
 * call when the preference is met); choosing among candidates is the agent's judgement.
 */
export const subtitlesSubsystem: Subsystem = {
	name: "subtitles",
	init({ app, jobs, watcher }) {
		watcher.onFiled.push((hash, titleId) => {
			if (!titleId) return;
			const d = getDownload(app, hash);
			const eps = json<{ season: number }[]>(d?.episodes_json, []);
			const seasons = [...new Set(eps.map((e) => e.season))];
			jobs.enqueue("subtitles", { title_id: titleId, seasons, hash, title: `Subtitles: ${getTitle(app, titleId)?.name ?? titleId}` }, { dedupe: `subs:${titleId}:${seasons.join(",")}` });
		});
		jobs.register("subtitles", async (ctx) => {
			const t = getTitle(app, ctx.payload.title_id);
			if (!t) return { state: "failed", summary: "title gone" };
			const seasons: (number | undefined)[] = t.kind === "tv" ? (ctx.payload.seasons?.length ? ctx.payload.seasons : [undefined]) : [undefined];
			const missing: string[] = [];
			for (const s of seasons) {
				const have = await existingSubtitles(videosOf(app, t.id, s));
				for (const h of have) if (!h.embeddedChinese.length && !h.external.some((n) => /\.(zh|chi|chs|zho|zh-CN|zh-TW)\b|简|繁|chs|cht/i.test(n))) missing.push(h.video);
			}
			if (!missing.length) return { state: "succeeded", summary: "Chinese subtitles already present (embedded or external); nothing to do." };
			const prefs = readNoteSafe(app);
			const r = await ctx.agent(
				`${t.name} (${t.id}) was just filed and ${missing.length} video(s) lack Chinese subtitles:\n${missing.slice(0, 20).join("\n")}${missing.length > 20 ? "\n…" : ""}\n\nLoad the subtitles skill. Search once per season (subtitle_search title_id=${t.id}${t.kind === "tv" ? " season=N" : ""}), choose the best candidate for the owner's preference${prefs ? "" : " (default: 简体&English bilingual, then 简体; ASS over SRT)"} and the release (${getDownload(app, ctx.payload.hash)?.name ?? "see title_show"}), and fetch it with subtitle_fetch. If a site asks for verification, follow the verification skill (in a background job: notify, then park). If nothing suitable exists, say so in one line.`,
				ctx.payload.title,
			);
			return r.parkedOn ? { state: "parked", summary: r.text } : { state: r.state === "done" ? "succeeded" : "failed", summary: r.text };
		});
	},
};

export type { Reelix };
