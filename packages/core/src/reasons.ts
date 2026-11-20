import { Type } from "typebox";
import type { Reelix } from "./app.ts";
import { json } from "./db.ts";
import { outsideLine } from "@reelix/plugin";
import { defineOperation } from "./registry.ts";
import { getHandle, activeHidden } from "./releases.ts";
import { nowIso } from "./util.ts";

/**
 * Why Reelix did what it did (docs/plugins.md §10.1): one record of hook changes, hidden releases and
 * provider outcomes, each with its plugin and reason. The owner and the agent read the same rows.
 */
const KEPT_DAYS = 30;
const REASON_LIMIT = 200;

export type ReasonKind = "hidden" | "moved" | "note" | "provider" | "renamed" | "edited" | "scored";
export type ReasonInput = { kind: ReasonKind; plugin: string; reason: string; detail?: Record<string, unknown> };
export type ReasonRow = ReasonInput & { at: string; detail: Record<string, unknown> };

export const releaseSubject = (handle: string) => `release:${handle}`;
export const searchSubject = (id: string) => `search:${id}`;

/** What is known about a subject now takes the place of what was known before. */
export function replaceReasons(app: Reelix, subject: string, rows: ReasonInput[]): void {
	const at = nowIso();
	app.db.prepare("DELETE FROM reasons WHERE subject = ? OR at < ?").run(subject, new Date(Date.now() - KEPT_DAYS * 86_400_000).toISOString());
	const add = app.db.prepare("INSERT INTO reasons (subject, kind, plugin, reason, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)");
	for (const r of rows) add.run(subject, r.kind, r.plugin, outsideLine(app.redact(r.reason), REASON_LIMIT), app.redact(JSON.stringify(r.detail ?? {})), at);
}

export function reasonsFor(app: Reelix, subject: string): ReasonRow[] {
	const rows = app.db.prepare("SELECT kind, plugin, reason, detail_json, at FROM reasons WHERE subject = ? ORDER BY id").all(subject) as { kind: ReasonKind; plugin: string; reason: string; detail_json: string; at: string }[];
	return rows.map(({ detail_json, ...r }) => ({ ...r, detail: json(detail_json, {}) }));
}

export type ReleaseWhy = { handle: string; title: string; hidden: boolean; reasons: ReasonRow[]; providers: ReasonRow[]; searched_at?: string };

function reasonLine(r: ReasonRow): string {
	const by = outsideLine(r.plugin, 60);
	switch (r.kind) {
		case "hidden":
			return `hidden by ${by}: ${r.reason}`;
		case "moved":
			return `moved from place ${r.detail.from} to ${r.detail.to} by ${by}: ${r.reason}`;
		case "note":
			return `note from ${by}: ${r.reason}`;
		default:
			return `${by}: ${r.reason}`;
	}
}

defineOperation({
	name: "release.why",
	summary: "Why a release stands where it does: what plugins hid, moved or noted, and what each indexer answered in its search",
	effect: "read",
	tool: "release_why",
	input: Type.Object({ handle: Type.String({ description: "release handle from release_search" }) }),
	positional: ["handle"],
	async run(ctx, i): Promise<ReleaseWhy> {
		const h = getHandle(ctx.app, i.handle);
		const providers = h.search ? reasonsFor(ctx.app, searchSubject(h.search)) : [];
		return { handle: i.handle, title: h.title, hidden: activeHidden(ctx.app, h).length > 0, reasons: reasonsFor(ctx.app, releaseSubject(i.handle)), providers, searched_at: providers[0]?.at };
	},
	toText: (o: ReleaseWhy) =>
		[
			`${o.handle}: ${outsideLine(o.title)}`,
			...(o.reasons.length ? o.reasons.map(reasonLine) : ["No plugin hid, moved or noted it; the order is best seeded first."]),
			...(o.providers.length ? [`Its last search (${o.searched_at?.slice(0, 16)}):`, ...o.providers.map(reasonLine)] : []),
		].join("\n"),
});
