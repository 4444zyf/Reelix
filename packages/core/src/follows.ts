import { Type } from "typebox";
import type { Reelix } from "./app.ts";
import { tr } from "./i18n.ts";
import { addInbox } from "./inbox.ts";
import { defineOperation, runOperation } from "./registry.ts";
import { searchReleases, type Release } from "./releases.ts";
import { fetchTitle, requireTitle } from "./titles.ts";
import { ReelixError, errorMessage, newId, nowIso } from "./util.ts";

export type Follow = { id: string; title_id: string; instruction: string; quick_accept: string | null; season: number | null; active: number; created_at: string };
export type FollowEpisode = { follow_id: string; season: number; episode: number; air_date: string | null; state: string; next_check_at: string | null; misses: number; download_hash: string | null };

const DAY = 86400_000;

/** Add any episodes TMDB knows about that the follow does not have yet; mark filed ones. */
export async function refreshFollow(app: Reelix, f: Follow): Promise<number> {
	const t = await fetchTitle(app, "tv", requireTitle(app, f.title_id).tmdb_id!);
	const seasons = f.season !== null ? [f.season] : t.seasons.filter((s) => s.season_number > 0).map((s) => s.season_number);
	let added = 0;
	const filed = new Set((app.db.prepare("SELECT fe.season, fe.episode FROM file_episodes fe JOIN files f ON f.id = fe.file_id WHERE f.title_id = ?").all(t.id) as { season: number; episode: number }[]).map((e) => `${e.season}:${e.episode}`));
	for (const s of seasons) {
		const season = await app.tmdb().season(t.tmdb_id!, s);
		for (const e of season.episodes) {
			// Air dates carry no time zone: check from a day after.
			const next = e.air_date ? new Date(Date.parse(e.air_date) + DAY).toISOString() : null;
			const state = filed.has(`${s}:${e.episode_number}`) ? "filed" : "wanted";
			const r = app.db.prepare("INSERT OR IGNORE INTO follow_episodes (follow_id, season, episode, air_date, state, next_check_at) VALUES (?, ?, ?, ?, ?, ?)").run(f.id, s, e.episode_number, e.air_date, state, next);
			if (Number(r.changes)) added++;
			else app.db.prepare("UPDATE follow_episodes SET air_date = ?, next_check_at = CASE WHEN state = 'wanted' AND misses = 0 THEN ? ELSE next_check_at END WHERE follow_id = ? AND season = ? AND episode = ?").run(e.air_date, next, f.id, s, e.episode_number);
		}
	}
	app.db.prepare("UPDATE follow_episodes SET state = 'filed' WHERE follow_id = ? AND state != 'filed' AND (season || ':' || episode) IN (SELECT fe.season || ':' || fe.episode FROM file_episodes fe JOIN files fl ON fl.id = fe.file_id WHERE fl.title_id = ?)").run(f.id, t.id);
	return added;
}

/** A quick-accept pattern ("group X, 1080p, WEB"): every comma-separated term must appear in the name. */
export function matchesQuickAccept(pattern: string, r: Release): boolean {
	const name = r.title.toLowerCase();
	const terms = pattern.split(/[,，]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
	return terms.length > 0 && terms.every((t) => {
		const g = /^group\s+(.+)$/.exec(t);
		if (g) return (r.parsed.group ?? "").toLowerCase() === g[1] || name.includes(g[1]!);
		return name.includes(t);
	}) && (r.seeders ?? 0) > 0;
}

export type DueOutcome = { follow: string; season: number; episode: number; result: "grabbed" | "needs_agent" | "nothing" | "error"; detail: string; candidates?: string[] };

/**
 * Waking up is code; deciding is the agent (§5.7). No model is called when nothing is due.
 * Returns episodes that need the agent's choice.
 */
export async function followTick(app: Reelix, actor = "job:follow"): Promise<DueOutcome[]> {
	const now = nowIso();
	const due = app.db.prepare("SELECT fe.*, f.title_id, f.quick_accept, f.instruction FROM follow_episodes fe JOIN follows f ON f.id = fe.follow_id WHERE f.active = 1 AND fe.state = 'wanted' AND fe.next_check_at IS NOT NULL AND fe.next_check_at <= ? ORDER BY fe.next_check_at LIMIT 20").all(now) as (FollowEpisode & { title_id: string; quick_accept: string | null; instruction: string })[];
	const out: DueOutcome[] = [];
	for (const e of due) {
		const title = requireTitle(app, e.title_id);
		try {
			const s = await searchReleases(app, { title, season: e.season, episode: e.episode, limit: 30 });
			const fits = (r: Release) => r.parsed.episodes?.includes(e.episode) || (!r.parsed.episodes && r.parsed.season === e.season && r.parsed.complete);
			const hits = s.all.filter((r) => !r.hidden?.length && fits(r));
			// The first match in the order Reelix presents, which a ranking plugin may have set.
			const quick = e.quick_accept ? hits.find((r) => r.parsed.episodes?.includes(e.episode) && matchesQuickAccept(e.quick_accept!, r)) : undefined;
			if (quick) {
				const r = await runOperation(app, "download.add", { handle: quick.handle, title_id: title.id, episodes: [{ season: e.season, episode: e.episode }], reason: `follow quick-accept "${e.quick_accept}"` }, { actor, requestId: `follow:${e.follow_id}:${e.season}:${e.episode}:${e.misses}` });
				const hash = (r.output as { hash: string }).hash;
				app.db.prepare("UPDATE follow_episodes SET state = 'grabbed', download_hash = ? WHERE follow_id = ? AND season = ? AND episode = ?").run(hash, e.follow_id, e.season, e.episode);
				out.push({ follow: e.follow_id, season: e.season, episode: e.episode, result: "grabbed", detail: quick.title });
			} else if (hits.length) {
				// Hold off re-checking while the agent decides.
				app.db.prepare("UPDATE follow_episodes SET next_check_at = ? WHERE follow_id = ? AND season = ? AND episode = ?").run(new Date(Date.now() + 6 * 3600_000).toISOString(), e.follow_id, e.season, e.episode);
				out.push({ follow: e.follow_id, season: e.season, episode: e.episode, result: "needs_agent", detail: `${hits.length} candidates`, candidates: hits.slice(0, 8).map((h) => h.handle) });
			} else {
				// Candidates existed and plugins hid every one: the owner should know who did it.
				const hiddenBy = [...new Set(s.hidden.filter(fits).flatMap((r) => r.hidden!.map((h) => h.plugin)))];
				if (hiddenBy.length) {
					addInbox(app, { kind: "notice", title: tr(app, "follow.filteredTitle", { name: title.name, episode: `S${e.season}E${e.episode}` }), body: tr(app, "follow.filteredBody", { plugins: hiddenBy.join(", "), count: s.hidden.filter(fits).length }), source: `plugin:${hiddenBy[0]}`, dedupeKey: `follow-filtered:${e.follow_id}:${e.season}:${e.episode}` });
				}
				// After a miss the interval widens.
				const misses = e.misses + 1;
				const wait = Math.min(7 * DAY, 2 ** Math.min(misses, 6) * 3 * 3600_000);
				app.db.prepare("UPDATE follow_episodes SET misses = ?, next_check_at = ? WHERE follow_id = ? AND season = ? AND episode = ?").run(misses, new Date(Date.now() + wait).toISOString(), e.follow_id, e.season, e.episode);
				out.push({ follow: e.follow_id, season: e.season, episode: e.episode, result: "nothing", detail: `miss ${misses}; next check in ${Math.round(wait / 3600_000)}h` });
			}
		} catch (err) {
			app.db.prepare("UPDATE follow_episodes SET next_check_at = ? WHERE follow_id = ? AND season = ? AND episode = ?").run(new Date(Date.now() + 3 * 3600_000).toISOString(), e.follow_id, e.season, e.episode);
			out.push({ follow: e.follow_id, season: e.season, episode: e.episode, result: "error", detail: errorMessage(err) });
		}
	}
	// A follow is finished when everything is filed.
	// (A whole-show follow stays active for future seasons; a one-season follow ends.)
	for (const f of app.db.prepare("SELECT id FROM follows WHERE active = 1 AND season IS NOT NULL").all() as { id: string }[]) {
		const left = app.db.prepare("SELECT COUNT(*) n FROM follow_episodes WHERE follow_id = ? AND state != 'filed'").get(f.id) as { n: number };
		const total = app.db.prepare("SELECT COUNT(*) n FROM follow_episodes WHERE follow_id = ?").get(f.id) as { n: number };
		if (total.n > 0 && left.n === 0) app.db.prepare("UPDATE follows SET active = 0 WHERE id = ?").run(f.id);
	}
	return out;
}

function followSummary(app: Reelix, f: Follow): string {
	const eps = app.db.prepare("SELECT season, episode, state, next_check_at, air_date FROM follow_episodes WHERE follow_id = ? ORDER BY season, episode").all(f.id) as FollowEpisode[];
	const count = (s: string) => eps.filter((e) => e.state === s).length;
	const next = eps.find((e) => e.state === "wanted" && e.next_check_at);
	const t = requireTitle(app, f.title_id);
	return `${f.id} | ${t.name}${f.season !== null ? ` S${f.season}` : ""} | ${f.active ? "active" : "finished"} | filed ${count("filed")}, grabbed ${count("grabbed")}, wanted ${count("wanted")}${next ? ` | next S${next.season}E${next.episode} check ${next.next_check_at?.slice(0, 16)}` : ""}\n  "${f.instruction}"${f.quick_accept ? `\n  quick-accept: ${f.quick_accept}` : ""}`;
}

defineOperation({
	name: "follow.add",
	summary: "Follow a show: fetch new episodes as they air, by a standing instruction in the owner's words",
	description: "instruction is stored as written (e.g. 'Weekly 1080p from the same group as season 1; tell me when the Blu-ray batch is out'). quick_accept lets code take matching releases without the model ('group X, 1080p, WEB').",
	effect: "write",
	input: Type.Object({ title_id: Type.String(), instruction: Type.String(), season: Type.Optional(Type.Integer()), quick_accept: Type.Optional(Type.String()) }),
	positional: ["title_id", "instruction"],
	async run(ctx, i) {
		const t = requireTitle(ctx.app, i.title_id);
		if (t.kind !== "tv" || !t.tmdb_id) throw new ReelixError("invalid_input", "Only TMDB TV titles can be followed.");
		const id = newId("f_");
		ctx.app.db.prepare("INSERT INTO follows (id, title_id, instruction, quick_accept, season, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, t.id, i.instruction, i.quick_accept ?? null, i.season ?? null, nowIso());
		const f = ctx.app.db.prepare("SELECT * FROM follows WHERE id = ?").get(id) as Follow;
		await refreshFollow(ctx.app, f);
		// Episodes that aired long ago and are not filed are wanted now.
		return { id, summary: followSummary(ctx.app, f) };
	},
	toText: (o: any) => `Following:\n${o.summary}`,
	titleOf: (i) => i.title_id,
});

defineOperation({
	name: "follow.list",
	summary: "Followed shows and where each episode stands (wanted, grabbed, filed)",
	effect: "read",
	input: Type.Object({ all: Type.Optional(Type.Boolean()) }),
	async run(ctx, i) {
		const rows = ctx.app.db.prepare(`SELECT * FROM follows ${i.all ? "" : "WHERE active = 1"} ORDER BY created_at DESC`).all() as Follow[];
		return rows.map((f) => ({ ...f, summary: followSummary(ctx.app, f) }));
	},
	toText: (o: any[]) => o.map((f) => f.summary).join("\n") || "Nothing followed.",
});

defineOperation({
	name: "follow.set",
	summary: "Change a follow's instruction or quick-accept pattern, or pause/resume it",
	effect: "write",
	input: Type.Object({ id: Type.String(), instruction: Type.Optional(Type.String()), quick_accept: Type.Optional(Type.String()), active: Type.Optional(Type.Boolean()) }),
	positional: ["id"],
	async run(ctx, i) {
		const f = ctx.app.db.prepare("SELECT * FROM follows WHERE id = ?").get(i.id) as Follow | undefined;
		if (!f) throw new ReelixError("not_found", `No follow ${i.id}`);
		ctx.app.db.prepare("UPDATE follows SET instruction = COALESCE(?, instruction), quick_accept = CASE WHEN ? IS NULL THEN quick_accept WHEN ? = '' THEN NULL ELSE ? END, active = COALESCE(?, active) WHERE id = ?").run(i.instruction ?? null, i.quick_accept ?? null, i.quick_accept ?? null, i.quick_accept ?? null, i.active === undefined ? null : i.active ? 1 : 0, i.id);
		return { summary: followSummary(ctx.app, ctx.app.db.prepare("SELECT * FROM follows WHERE id = ?").get(i.id) as Follow) };
	},
	toText: (o: any) => o.summary,
});

defineOperation({
	name: "follow.remove",
	summary: "Stop following a show (nothing downloaded is touched)",
	effect: "write",
	input: Type.Object({ id: Type.String() }),
	positional: ["id"],
	async run(ctx, i) {
		ctx.app.db.prepare("DELETE FROM follow_episodes WHERE follow_id = ?").run(i.id);
		ctx.app.db.prepare("DELETE FROM follows WHERE id = ?").run(i.id);
		return { id: i.id };
	},
	toText: (o: any) => `Stopped following (${o.id}).`,
});

defineOperation({
	name: "follow.check",
	summary: "Run the follow check now (code: search due episodes, take quick-accept matches)",
	effect: "write",
	input: Type.Object({ refresh: Type.Optional(Type.Boolean({ description: "also refresh episode lists from TMDB" })) }),
	async run(ctx, i) {
		if (i.refresh) for (const f of ctx.app.db.prepare("SELECT * FROM follows WHERE active = 1").all() as Follow[]) await refreshFollow(ctx.app, f);
		return followTick(ctx.app, ctx.actor);
	},
	toText: (o: DueOutcome[]) => o.map((x) => `${x.follow} S${x.season}E${x.episode}: ${x.result} — ${x.detail}`).join("\n") || "Nothing due.",
});
