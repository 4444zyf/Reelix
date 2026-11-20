import { createHash } from "node:crypto";
import type { Reelix } from "./app.ts";
import { tr } from "./i18n.ts";
import { prepareInput } from "./registry.ts";
import { ReelixError, newId, nowIso } from "./util.ts";

/**
 * The owner's approval of one run of one operation with one input (docs/plugins.md §11.2). A record
 * is made only for an answer that came from the owner, is used once, and expires.
 */
export type ApprovalRequest = { operation: string; input: unknown; requestedBy: string; expiresAt: string };

function canonical(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(canonical);
	if (typeof v !== "object" || v === null) return v;
	return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)]));
}

/** Whether two plain values are the same data, whatever the order of their keys. */
export const sameData = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function inputHash(app: Reelix, operation: string, input: unknown): string {
	const op = app.operations.get(operation);
	return createHash("sha256").update(JSON.stringify(canonical(op ? prepareInput(op, input) : input))).digest("hex");
}

/** What is put on an Inbox question, so that the owner's yes there makes the record. */
export const approvalRequest = (operation: string, input: unknown, requestedBy: string, expiresAt: string): ApprovalRequest => ({ operation, input, requestedBy, expiresAt });

export function createApproval(app: Reelix, r: ApprovalRequest & { approvedBy: string }): string {
	if (!r.approvedBy.startsWith("owner:")) throw new ReelixError("owner_only", "Only the owner can approve this.");
	const id = newId("apr_");
	app.db.prepare("INSERT INTO approvals (id, operation, input_hash, requested_by, approved_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, r.operation, inputHash(app, r.operation, r.input), r.requestedBy, r.approvedBy, nowIso(), r.expiresAt);
	return id;
}

/** Remove a record that was not used. */
export function dropApproval(app: Reelix, id: string): void {
	app.db.prepare("DELETE FROM approvals WHERE id = ? AND used_at IS NULL").run(id);
}

const MATCH = "operation = ? AND input_hash = ? AND requested_by = ? AND used_at IS NULL AND expires_at > ?";

export function hasApproval(app: Reelix, operation: string, input: unknown, actor: string): boolean {
	return !!app.db.prepare(`SELECT id FROM approvals WHERE ${MATCH}`).get(operation, inputHash(app, operation, input), actor, nowIso());
}

/** Use up a matching record. False when there is none. */
export function consumeApproval(app: Reelix, operation: string, input: unknown, actor: string): boolean {
	const now = nowIso();
	const r = app.db.prepare(`UPDATE approvals SET used_at = ? WHERE id = (SELECT id FROM approvals WHERE ${MATCH} ORDER BY created_at LIMIT 1) RETURNING id`).get(now, operation, inputHash(app, operation, input), actor, now);
	return !!r;
}

export const APPROVE_OPTIONS = (app: Reelix) => [tr(app, "approval.approve"), tr(app, "approval.decline")];

/** Whether this answer is the "approve" the item offered, in the language it was asked in. */
export const answerApproves = (it: { options: string[]; payload?: any }, answer: string | null): boolean => !!it.payload?.approval && answer === it.options[0];

/** The owner's "approve" on an Inbox question makes the record. An answer from anyone else makes none. */
export function watchApprovals(app: Reelix): void {
	app.events.on("event", (e: any) => {
		if (e.type !== "inbox" || e.status !== "answered") return;
		const request = e.item?.payload?.approval as ApprovalRequest | undefined;
		if (!request || typeof e.by !== "string" || !e.by.startsWith("owner:")) return;
		if (answerApproves(e.item, e.item.answer)) createApproval(app, { ...request, approvedBy: e.by });
	});
}
