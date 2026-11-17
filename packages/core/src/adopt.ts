import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { Reelix } from "./app.ts";
import { isComplete } from "./clients/qbittorrent.ts";
import { toOurs } from "./config.ts";
import { json, kvGet, kvSet } from "./db.ts";
import { TAG, markFiled } from "./downloads.ts";
import { addInbox } from "./inbox.ts";
import { type Plan, applyPlan, autoPlan, planToText } from "./organiser.ts";
import { parseReleaseName } from "./parser.ts";
import { defineOperation } from "./registry.ts";
import { findTitle, getTitle, requireTitle } from "./titles.ts";
import { ReelixError, errorMessage, newId, nowIso, sleep } from "./util.ts";

export type AdoptRow = {
	n: number;
	hash: string;
	name: string;
	content_path: string;
	complete: boolean;
	title_id?: string;
	title?: string;
	confident: boolean;
	why?: string;
	plan?: Plan;
	problems: string[];
	status: "pending" | "applied" | "skipped" | "failed";
	error?: string;
};

export type AdoptScan = { id: string; created_at: string; rows: AdoptRow[] };

function saveScan(app: Reelix, s: AdoptScan): void {
	kvSet(app.db, `adopt:${s.id}`, JSON.stringify(s));
	kvSet(app.db, "adopt:last", s.id);
}

export function getScan(app: Reelix, id?: string): AdoptScan {
	const sid = id ?? kvGet(app.db, "adopt:last");
	const raw = sid ? kvGet(app.db, `adopt:${sid}`) : undefined;
	if (!raw) throw new ReelixError("not_found", "No adoption scan yet; run adopt.scan.");
	return json(raw, { id: "", created_at: "", rows: [] } as AdoptScan);
}

/**
 * Adopt downloads that already exist (§5.4): code identifies and plans everything it can without
 * the model; the agent takes the remainder; the owner gets one review table. Nothing is linked
 * before approval.
 */
export async function adoptScan(app: Reelix, opts: { limit?: number } = {}): Promise<AdoptScan> {
	const all = await app.qb().torrents();
	const tracked = new Set((app.db.prepare("SELECT hash FROM downloads").all() as { hash: string }[]).map((r) => r.hash));
	const candidates = all.filter((t) => !tracked.has(t.hash) && !String(t.tags).split(",").map((x) => x.trim()).includes(TAG)).slice(0, opts.limit ?? 300);
	const rows: AdoptRow[] = [];
	let n = 0;
	for (const t of candidates) {
		n++;
		const row: AdoptRow = { n, hash: t.hash, name: t.name, content_path: toOurs(app.config.path_maps.qbittorrent, t.content_path), complete: isComplete(t), confident: false, problems: [], status: "pending" };
		try {
			const p = parseReleaseName(t.name);
			const r = await findTitle(app, t.name, { kind: p.season !== undefined || p.episodes ? "tv" : undefined, year: p.year });
			if (r.resolved) {
				row.title_id = r.resolved.id;
				row.title = `${r.resolved.name} (${r.resolved.year ?? "?"})`;
				if (!row.complete) row.problems.push("not finished downloading");
				else if (!existsSync(row.content_path)) row.problems.push(`files not found at ${row.content_path} (check path_maps.qbittorrent)`);
				else {
					const ap = autoPlan(app, r.resolved, row.content_path, { hash: t.hash, seasonHint: p.season, version: r.resolved.kind === "movie" ? p.resolution : undefined });
					row.plan = ap.plan;
					row.problems.push(...ap.problems);
				}
				row.confident = row.problems.length === 0 && !!row.plan?.items.length;
			} else row.why = r.candidates.length ? `${r.candidates.length} candidates: ${r.candidates.slice(0, 3).map((c) => `${c.id} ${c.name} ${c.year ?? ""}`).join("; ")}` : "no TMDB match";
		} catch (e) {
			row.why = errorMessage(e);
			if (/network|reach|timeout/i.test(row.why)) await sleep(2000);
		}
		rows.push(row);
		await sleep(150); // TMDB allows ~40 requests/s; stay far below
	}
	const scan: AdoptScan = { id: newId("ad_"), created_at: nowIso(), rows };
	saveScan(app, scan);
	return scan;
}

/** The agent (or owner) settles an uncertain row: a title, and optionally explicit plan items. */
export function adoptSet(app: Reelix, scanId: string | undefined, n: number, titleId: string, plan?: Plan): AdoptRow {
	const scan = getScan(app, scanId);
	const row = scan.rows.find((r) => r.n === n);
	if (!row) throw new ReelixError("not_found", `No row ${n}`);
	const t = requireTitle(app, titleId);
	row.title_id = t.id;
	row.title = `${t.name} (${t.year ?? "?"})`;
	row.problems = [];
	if (plan?.items.length) row.plan = { ...plan, title_id: t.id, download_hash: row.hash };
	else if (row.complete && existsSync(row.content_path)) {
		const p = parseReleaseName(row.name);
		const ap = autoPlan(app, t, row.content_path, { hash: row.hash, seasonHint: p.season });
		row.plan = ap.plan;
		row.problems = ap.problems;
	}
	row.confident = !row.problems.length && !!row.plan?.items.length;
	row.why = "settled";
	saveScan(app, scan);
	return row;
}

export async function adoptApply(app: Reelix, scanId: string | undefined, ns: number[]): Promise<AdoptRow[]> {
	const scan = getScan(app, scanId);
	const out: AdoptRow[] = [];
	for (const n of ns) {
		const row = scan.rows.find((r) => r.n === n);
		if (!row || row.status === "applied") continue;
		if (!row.title_id || !row.plan?.items.length) {
			row.status = "failed";
			row.error = "no title or plan";
			out.push(row);
			continue;
		}
		try {
			await app.qb().addTags([row.hash], [TAG]);
			app.db.prepare("INSERT INTO downloads (hash, title_id, name, release_json, reason, state, progress, content_path, added_at, completed_at) VALUES (?, ?, ?, ?, 'adopted', 'complete', 1, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET title_id = excluded.title_id").run(row.hash, row.title_id, row.name, JSON.stringify({ title: row.name, adopted: true }), row.content_path, nowIso(), nowIso());
			const results = applyPlan(app, row.plan);
			const bad = results.filter((r) => r.status === "failed" || r.status === "conflict");
			if (bad.length) {
				row.status = "failed";
				row.error = bad.map((b) => b.error).join("; ");
			} else {
				await markFiled(app, row.hash, row.title_id, row.plan);
				row.status = "applied";
			}
		} catch (e) {
			row.status = "failed";
			row.error = errorMessage(e);
		}
		out.push(row);
	}
	saveScan(app, scan);
	return out;
}

function scanText(s: AdoptScan): string {
	const conf = s.rows.filter((r) => r.confident && r.status === "pending");
	const unsure = s.rows.filter((r) => !r.confident && r.status === "pending");
	const line = (r: AdoptRow) => `${r.n} | ${r.name} | ${r.title ?? "?"} | ${r.plan?.items.filter((i) => i.kind === "video" || i.kind === "disc").length ?? 0} videos${r.problems.length ? ` | ${r.problems.join("; ")}` : ""}${r.why && !r.title ? ` | ${r.why}` : ""}`;
	return `Adoption scan ${s.id}: ${s.rows.length} untracked torrents. ${conf.length} confident (pre-ticked), ${unsure.length} uncertain, ${s.rows.filter((r) => r.status === "applied").length} applied.\nConfident:\n${conf.map(line).join("\n") || "none"}\nUncertain (settle with adopt.set):\n${unsure.map(line).join("\n") || "none"}`;
}

defineOperation({
	name: "adopt.scan",
	summary: "Scan qBittorrent's existing torrents and plan filing them (nothing is linked until approved)",
	effect: "write",
	input: Type.Object({ limit: Type.Optional(Type.Integer()), notify: Type.Optional(Type.Boolean({ default: true })) }),
	async run(ctx, i) {
		const s = await adoptScan(ctx.app, { limit: i.limit });
		if (i.notify !== false && s.rows.length) {
			addInbox(ctx.app, { kind: "plan", title: `Adopt ${s.rows.length} existing downloads`, body: `${s.rows.filter((r) => r.confident).length} can be filed now; ${s.rows.filter((r) => !r.confident).length} need a decision. Review the table.`, payload: { adoptScan: s.id }, options: ["Approve all confident", "Review in chat"], dedupeKey: `adopt:${s.id}` });
		}
		return s;
	},
	toText: scanText,
});

defineOperation({
	name: "adopt.show",
	summary: "The last adoption scan (or one by id), with plans",
	effect: "read",
	input: Type.Object({ id: Type.Optional(Type.String()), n: Type.Optional(Type.Integer()) }),
	async run(ctx, i) {
		return getScan(ctx.app, i.id);
	},
	toText: (s: AdoptScan) => scanText(s),
});

defineOperation({
	name: "adopt.set",
	summary: "Settle an uncertain adoption row: its title (and optionally explicit plan items)",
	effect: "write",
	input: Type.Object({ n: Type.Integer(), title_id: Type.String(), id: Type.Optional(Type.String()), items: Type.Optional(Type.Array(Type.Any())) }),
	positional: ["n", "title_id"],
	async run(ctx, i) {
		return adoptSet(ctx.app, i.id, i.n, i.title_id, i.items ? { items: i.items } : undefined);
	},
	toText: (r: AdoptRow) => `${r.n}: ${r.title} — ${r.confident ? "ready" : `problems: ${r.problems.join("; ")}`}${r.plan ? `\n${planToText(r.plan)}` : ""}`,
});

defineOperation({
	name: "adopt.apply",
	summary: "Apply approved adoption rows (by number, or all confident ones)",
	effect: "write",
	input: Type.Object({ rows: Type.Optional(Type.Array(Type.Integer())), all_confident: Type.Optional(Type.Boolean()), id: Type.Optional(Type.String()) }),
	async run(ctx, i) {
		const scan = getScan(ctx.app, i.id);
		const ns = i.all_confident ? scan.rows.filter((r) => r.confident && r.status === "pending").map((r) => r.n) : (i.rows ?? []);
		if (!ns.length) throw new ReelixError("invalid_input", "No rows given (rows=[…] or all_confident=true).");
		return adoptApply(ctx.app, i.id, ns);
	},
	toText: (o: AdoptRow[]) => o.map((r) => `${r.n} ${r.name}: ${r.status}${r.error ? ` — ${r.error}` : ""}`).join("\n"),
});

// ------------------------------------------------------------------ skills the agent wrote for itself (§4.4)

function skillDirs(app: Reelix): { name: string; dir: string; description: string; body: string }[] {
	if (!existsSync(app.paths.skills)) return [];
	return readdirSync(app.paths.skills, { withFileTypes: true })
		.filter((e) => e.isDirectory() && existsSync(join(app.paths.skills, e.name, "SKILL.md")))
		.map((e) => {
			const body = readFileSync(join(app.paths.skills, e.name, "SKILL.md"), "utf8");
			return { name: e.name, dir: join(app.paths.skills, e.name), description: /^description:\s*(.+)$/m.exec(body)?.[1] ?? "", body };
		});
}

defineOperation({
	name: "skills.list",
	summary: "Things the agent has learned: skills it wrote for itself in /data/skills",
	effect: "read",
	input: Type.Object({}),
	async run(ctx) {
		return skillDirs(ctx.app);
	},
	toText: (o: any[]) => o.map((s) => `${s.name} — ${s.description}`).join("\n") || "None yet.",
});

defineOperation({
	name: "skills.delete",
	summary: "Delete a skill the agent wrote",
	effect: "destructive",
	input: Type.Object({ name: Type.String() }),
	positional: ["name"],
	async run(ctx, i) {
		const s = skillDirs(ctx.app).find((x) => x.name === i.name);
		if (!s) throw new ReelixError("not_found", `No skill ${i.name}`);
		rmSync(s.dir, { recursive: true });
		return { name: i.name };
	},
	toText: (o: any) => `Deleted skill ${o.name}.`,
});

export { getTitle };
