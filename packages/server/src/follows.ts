import { type Follow, adoptApply, errorMessage, followTick, getScan, getTitle, refreshFollow, nowIso } from "@reelix/core";
import type { Subsystem } from "./plugins.ts";

/** Follows (§5.7) and adoption review answers (§5.4). Waking is code; deciding is the agent. */
export const followsSubsystem: Subsystem = {
	name: "follows",
	init({ app, host, jobs }) {
		jobs.schedule("follows", "follow_tick", "every 10m");
		jobs.schedule("follows-refresh", "follow_refresh", "daily 05:00");
		jobs.register("follow_refresh", async () => {
			let added = 0;
			for (const f of app.db.prepare("SELECT * FROM follows WHERE active = 1").all() as Follow[]) {
				try {
					added += await refreshFollow(app, f);
				} catch {}
			}
			return { state: "succeeded", summary: `Episode lists refreshed; ${added} new episodes.` };
		});
		jobs.register("follow_tick", async () => {
			const out = await followTick(app);
			for (const o of out.filter((x) => x.result === "needs_agent")) {
				const f = app.db.prepare("SELECT * FROM follows WHERE id = ?").get(o.follow) as Follow;
				const t = getTitle(app, f.title_id);
				jobs.enqueue(
					"agent",
					{
						title: `Follow: ${t?.name} S${o.season}E${o.episode}`,
						prompt: `A followed show has a new episode to choose: ${t?.name} (${f.title_id}) S${o.season}E${o.episode}.\nThe owner's standing instruction: "${f.instruction}"\nCandidates found by code (handles): ${o.candidates?.join(", ")}. Run release_search title_id=${f.title_id} season=${o.season} episode=${o.episode} to see them.\nChoose per the instruction and the preferences note, add it with download_add (episodes=[{season:${o.season},episode:${o.episode}}]). If the instruction asks to be told about something (e.g. a Blu-ray batch), notify. Then, if this choice is the kind that will repeat weekly, record a quick-accept pattern so code can take the next one without you: reelix follow set ${f.id} --quick-accept "group X, 1080p, WEB".`,
					},
					{ dedupe: `follow:${o.follow}:${o.season}:${o.episode}` },
				);
			}
			const grabbed = out.filter((x) => x.result === "grabbed").length;
			return { state: "succeeded", summary: out.length ? `${out.length} due: ${grabbed} grabbed by quick-accept, ${out.filter((x) => x.result === "needs_agent").length} to the agent.` : "Nothing due." };
		});
		// Answers to the adoption review item.
		app.events.on("event", (e: any) => {
			if (e.type !== "inbox" || e.status !== "answered" || !e.item?.payload?.adoptScan) return;
			const scanId = e.item.payload.adoptScan as string;
			if (/approve/i.test(e.item.answer ?? "")) {
				const scan = getScan(app, scanId);
				void adoptApply(app, scanId, scan.rows.filter((r) => r.confident && r.status === "pending").map((r) => r.n)).catch((err) => console.error("adopt", errorMessage(err)));
			} else {
				const t = host.createThread(`Adopt existing downloads (${nowIso().slice(0, 10)})`, "chat");
				void host.send(t.id, `Let's review adoption scan ${scanId} together. Show me the uncertain rows (reelix adopt show) and help me settle them.`, { from: "inbox" });
			}
		});
	},
};
