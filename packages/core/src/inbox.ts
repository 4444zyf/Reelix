import { Type } from "typebox";
import type { Reelix } from "./app.ts";
import { json } from "./db.ts";
import { defineOperation } from "./registry.ts";
import { ReelixError, newId, nowIso } from "./util.ts";

export type InboxItem = {
	id: string;
	kind: string; // notice | question | plan | verification | summary
	title: string;
	body: string;
	options: string[];
	image_path: string | null;
	payload: any;
	source: string | null;
	job_run_id: string | null;
	status: string; // open | answered | dismissed
	answer: string | null;
	created_at: string;
	answered_at: string | null;
};

/** Anything that needs the owner goes to their phone; routine notices stay in the Inbox (§7.4). */
export const inboxNeedsOwner = (it: Pick<InboxItem, "kind" | "payload">): boolean => it.kind !== "notice" || !!it.payload?.urgent;

function rowToItem(r: any): InboxItem {
	return { ...r, options: json(r.options_json, []), payload: json(r.payload_json, {}) };
}

export function addInbox(app: Reelix, item: { kind: string; title: string; body?: string; options?: string[]; image_path?: string; payload?: unknown; source?: string; job_run_id?: string; dedupeKey?: string }): InboxItem {
	if (item.dedupeKey) {
		const existing = app.db.prepare("SELECT * FROM inbox WHERE status = 'open' AND json_extract(payload_json, '$.dedupeKey') = ?").get(item.dedupeKey);
		if (existing) return rowToItem(existing);
	}
	const id = newId("in_");
	const payload = { ...(item.payload as object), ...(item.dedupeKey ? { dedupeKey: item.dedupeKey } : {}) };
	app.db
		.prepare("INSERT INTO inbox (id, kind, title, body, options_json, image_path, payload_json, source, job_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(id, item.kind, item.title, app.redact(item.body ?? ""), JSON.stringify(item.options ?? []), item.image_path ?? null, JSON.stringify(payload), item.source ?? "system", item.job_run_id ?? null, nowIso());
	const it = getInbox(app, id)!;
	app.emit({ type: "inbox", id, status: "open", item: it });
	return it;
}

export function getInbox(app: Reelix, id: string): InboxItem | undefined {
	const r = app.db.prepare("SELECT * FROM inbox WHERE id = ?").get(id);
	return r ? rowToItem(r) : undefined;
}

export function listInbox(app: Reelix, opts: { status?: string; limit?: number } = {}): InboxItem[] {
	const rows = opts.status === "all" ? app.db.prepare("SELECT * FROM inbox ORDER BY created_at DESC LIMIT ?").all(opts.limit ?? 100) : app.db.prepare("SELECT * FROM inbox WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(opts.status ?? "open", opts.limit ?? 100);
	return rows.map(rowToItem);
}

/** The owner, directly or on their paired chat channel. */
export const answeredByOwner = (by: unknown): boolean => typeof by === "string" && (by.startsWith("owner:") || by.startsWith("channel:"));

/** A job, an approval or an adoption goes on when this item is answered. */
const someoneWaits = (it: InboxItem) => (!!it.job_run_id && it.kind !== "notice") || !!it.payload?.approval || !!it.payload?.adoptScan;

/** Record an answer. Parked jobs listen for the `inbox` event and resume (§4.5). What something waits on is the owner's to answer. */
export function answerInbox(app: Reelix, id: string, answer: string, by: string): InboxItem {
	const it = getInbox(app, id);
	if (!it) throw new ReelixError("not_found", `No inbox item ${id}`);
	if (it.status !== "open") return it;
	if (it.payload?.pluginProposal) throw new ReelixError("use_proposal", `This is a proposed plugin: the owner approves or declines it on its screen, or with plugin.proposal_decide ${it.payload.pluginProposal}.`);
	if (it.payload?.proposal) throw new ReelixError("use_proposal", `This is a plugin's proposal: approve or decline it in its card, or with proposal.decide ${it.payload.proposal}.`);
	if (someoneWaits(it) && !answeredByOwner(by)) throw new ReelixError("owner_only", "This item is waiting for the owner's own answer.");
	return recordAnswer(app, id, answer, by);
}

/** Mark an item answered. Only for callers that have made their own checks: `answerInbox`, and a proposal's decision. */
export function recordAnswer(app: Reelix, id: string, answer: string, by: string): InboxItem {
	app.db.prepare("UPDATE inbox SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'open'").run(answer, nowIso(), id);
	const updated = getInbox(app, id)!;
	app.emit({ type: "inbox", id, status: "answered", item: updated, by });
	return updated;
}

export function dismissInbox(app: Reelix, id: string): void {
	app.db.prepare("UPDATE inbox SET status = 'dismissed', answered_at = ? WHERE id = ? AND status = 'open'").run(nowIso(), id);
	app.emit({ type: "inbox", id, status: "dismissed" });
}

defineOperation({
	name: "inbox.list",
	summary: "Things waiting for the owner (questions, plans, verification, notices)",
	effect: "read",
	input: Type.Object({ status: Type.Optional(Type.String({ description: "open (default) | answered | dismissed | all" })) }),
	async run(ctx, i) {
		return listInbox(ctx.app, { status: i.status });
	},
	toText: (o: InboxItem[]) => o.map((x) => `${x.id} | ${x.created_at.slice(0, 16)} | ${x.kind} | ${x.status} | ${x.title}${x.options.length ? ` [${x.options.join(" / ")}]` : ""}${x.answer ? ` → ${x.answer}` : ""}`).join("\n") || "Inbox is empty.",
});

defineOperation({
	name: "inbox.answer",
	summary: "Answer an Inbox item (resumes a parked job)",
	effect: "write",
	input: Type.Object({ id: Type.String(), answer: Type.String() }),
	positional: ["id", "answer"],
	async run(ctx, i) {
		return answerInbox(ctx.app, i.id, i.answer, ctx.actor);
	},
	toText: (o: InboxItem) => `${o.id}: ${o.status}${o.answer ? ` (${o.answer})` : ""}`,
});

defineOperation({
	name: "inbox.dismiss",
	summary: "Dismiss an Inbox item",
	effect: "write",
	input: Type.Object({ id: Type.String() }),
	positional: ["id"],
	async run(ctx, i) {
		dismissInbox(ctx.app, i.id);
		return { id: i.id };
	},
	toText: (o: any) => `Dismissed ${o.id}.`,
});
