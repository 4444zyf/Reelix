import { type OperationPreview, type Proposal, type ProposalOutcome, type ProposalStepResult, outsideLine } from "@reelix/plugin";
import { Type } from "typebox";
import type { Reelix } from "./app.ts";
import { createApproval, dropApproval, sameData } from "./approvals.ts";
import { json } from "./db.ts";
import { tr } from "./i18n.ts";
import { addInbox, dismissInbox, recordAnswer } from "./inbox.ts";
import { INSTRUCTION_TEXT_LIMIT } from "./outside.ts";
import { type Effect, type Operation, defineOperation, prepareInput, runOperation } from "./registry.ts";
import { ReelixError, errorMessage, humanBytes, newId, nowIso } from "./util.ts";

/**
 * Proposals (docs/plugins.md §10.3): a plugin asks the owner to approve a list of operations. Reelix
 * writes what the owner sees from each step's preview; the plugin's title and reason are only quoted.
 * Approved steps run through the ledger under `plugin:<id>`, each on an approval record of its own,
 * after their preview has been made again.
 */
const MAX_STEPS = 50;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const KEY_LIMIT = 100;
const TITLE_LIMIT = 200;
const WHY_LIMIT = 1_000;
/** How long the record for one approved step is good: it is used at once. */
const STEP_APPROVAL_MS = 5 * 60_000;
const COUNT_KEYS = ["downloads", "titles", "files", "bytes"] as const;

type StoredStep = { operation: string; input: unknown; effect: Effect; preview: OperationPreview };
type Row = { id: string; plugin: string; key: string; title: string; why: string; steps_json: string; status: ProposalView["status"]; inbox_id: string | null; results_json: string | null; created_at: string; expires_at: string; decided_at: string | null; decided_by: string | null };

export type ProposalView = {
	id: string;
	plugin: string;
	key: string;
	/** The plugin's words: show them as a quotation. */
	title: string;
	why: string;
	status: "open" | Exclude<ProposalOutcome["status"], "dropped">;
	steps: (StoredStep & { result?: ProposalStepResult })[];
	/** Reelix's own words: what approving every step would do. */
	summary: string;
	destructive: number;
	created_at: string;
	expires_at: string;
	decided_at?: string;
	decided_by?: string;
	inbox_id?: string;
};

const refuse = (message: string) => new ReelixError("proposal_refused", message);

/** "3 downloads, 1.2 GB": what a set of steps adds up to, in the owner's language. */
function proposalTotals(app: Reelix, previews: OperationPreview[]): string {
	const sum = (k: (typeof COUNT_KEYS)[number]) => previews.reduce((n, p) => n + (p.counts?.[k] ?? 0), 0);
	return COUNT_KEYS.flatMap((k) => {
		const n = sum(k);
		if (!n) return [];
		return [k === "bytes" ? tr(app, "proposal.bytes", { size: humanBytes(n) }) : tr(app, `proposal.${k}`, { count: n })];
	}).join(", ");
}

function checkPreview(op: Operation, p: unknown): OperationPreview {
	const v = p as OperationPreview;
	if (typeof v?.text !== "string" || !v.text.trim()) throw refuse(`${op.name}: its preview has no text`);
	const counts: OperationPreview["counts"] = {};
	for (const k of COUNT_KEYS) {
		const n = v.counts?.[k];
		if (n === undefined) continue;
		if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw refuse(`${op.name}: preview count ${k} must be a number of at least 0`);
		counts[k] = n;
	}
	// A plugin's preview is outside text; Reelix's own stays as it is.
	const text = op.plugin ? outsideLine(v.text, INSTRUCTION_TEXT_LIMIT) : v.text;
	return structuredClone({ text, target: v.target ?? null, counts });
}

async function previewOf(app: Reelix, op: Operation, input: unknown, plugin: string): Promise<OperationPreview> {
	if (!op.preview) throw refuse(`${op.name} has no preview, so it cannot be a step of a proposal`);
	return checkPreview(op, await op.preview({ app, actor: `plugin:${plugin}`, requestId: newId("pre_") }, input as never));
}

function view(app: Reelix, r: Row): ProposalView {
	const steps = json<StoredStep[]>(r.steps_json, []);
	const results = json<ProposalStepResult[] | null>(r.results_json, null);
	return {
		id: r.id,
		plugin: r.plugin,
		key: r.key,
		title: r.title,
		why: r.why,
		status: r.status,
		steps: steps.map((s, i) => ({ ...s, result: results?.[i] })),
		summary: tr(app, "proposal.summary", { plugin: r.plugin, count: steps.length, totals: proposalTotals(app, steps.map((s) => s.preview)) || tr(app, "proposal.noTotals") }),
		destructive: steps.filter((s) => s.effect === "destructive").length,
		created_at: r.created_at,
		expires_at: r.expires_at,
		decided_at: r.decided_at ?? undefined,
		decided_by: r.decided_by ?? undefined,
		inbox_id: r.inbox_id ?? undefined,
	};
}

const getRow = (app: Reelix, id: string) => app.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Row | undefined;

export function getProposal(app: Reelix, id: string): ProposalView {
	expireProposals(app);
	const r = getRow(app, id);
	if (!r) throw new ReelixError("not_found", `There is no proposal ${id}.`);
	return view(app, r);
}

const proposalOutcome = (v: ProposalView): ProposalOutcome => ({ id: v.id, status: v.status === "open" ? "expired" : v.status, steps: v.steps.map((s) => s.result ?? { operation: s.operation, status: "expired" }) });

/** Close a proposal for good, telling whoever waits on it. */
function close(app: Reelix, r: Row, status: Exclude<ProposalOutcome["status"], "dropped">, results: ProposalStepResult[], by?: string): ProposalView {
	app.db.prepare("UPDATE proposals SET status = ?, results_json = ?, decided_at = ?, decided_by = ? WHERE id = ?").run(status, JSON.stringify(results), nowIso(), by ?? null, r.id);
	const v = view(app, getRow(app, r.id)!);
	app.emit({ type: "proposal", id: r.id, plugin: r.plugin, outcome: proposalOutcome(v) });
	return v;
}

/** Proposals past their time are closed as expired. */
export function expireProposals(app: Reelix): void {
	const rows = app.db.prepare("SELECT * FROM proposals WHERE status = 'open' AND expires_at <= ?").all(nowIso()) as Row[];
	for (const r of rows) {
		close(app, r, "expired", json<StoredStep[]>(r.steps_json, []).map((s) => ({ operation: s.operation, status: "expired" })));
		if (r.inbox_id) dismissInbox(app, r.inbox_id);
	}
}

/** A plugin's proposal (§10.3). `runs`: the core operations its manifest lists. Refused as a whole when anything is wrong. */
export async function createProposal(app: Reelix, plugin: string, runs: string[], p: Proposal): Promise<ProposalView> {
	if (typeof p?.key !== "string" || !p.key || p.key.length > KEY_LIMIT) throw refuse(`key must be 1 to ${KEY_LIMIT} characters`);
	if (typeof p.title !== "string" || !p.title.trim() || p.title.length > TITLE_LIMIT) throw refuse(`title must be 1 to ${TITLE_LIMIT} characters`);
	if (typeof p.why !== "string" || p.why.length > WHY_LIMIT) throw refuse(`why must be at most ${WHY_LIMIT} characters`);
	if (!Array.isArray(p.steps) || !p.steps.length) throw refuse("a proposal needs at least one step");
	if (p.steps.length > MAX_STEPS) throw refuse(`a proposal has at most ${MAX_STEPS} steps; this one has ${p.steps.length}`);
	const now = Date.now();
	const expires = p.expiresAt === undefined ? now + DEFAULT_DAYS * 86_400_000 : Date.parse(p.expiresAt);
	if (!Number.isFinite(expires) || expires <= now) throw refuse("expiresAt must be a time in the future");
	const expiresAt = new Date(Math.min(expires, now + MAX_DAYS * 86_400_000)).toISOString();

	const steps: StoredStep[] = [];
	for (const step of p.steps) {
		const op = app.operations.get(String(step?.operation));
		if (!op) throw refuse(`there is no operation "${step?.operation}"`);
		if (op.plugin ? op.plugin !== plugin : !runs.includes(op.name)) throw refuse(`${op.name} is not this plugin's own operation and not in reelix.uses.runs`);
		if (op.effect === "admin") throw refuse(`${op.name} changes how Reelix is set up; plugins can never run it`);
		const input = prepareInput(op, step.input);
		steps.push({ operation: op.name, input, effect: op.effect, preview: await previewOf(app, op, input, plugin) });
	}

	expireProposals(app);
	for (const old of app.db.prepare("SELECT * FROM proposals WHERE status = 'open' AND plugin = ? AND key = ?").all(plugin, p.key) as Row[]) {
		close(app, old, "replaced", json<StoredStep[]>(old.steps_json, []).map((s) => ({ operation: s.operation, status: "not_approved" })));
		if (old.inbox_id) dismissInbox(app, old.inbox_id);
	}

	const id = newId("prop_");
	const title = outsideLine(app.redact(p.title), TITLE_LIMIT);
	const why = app.redact(p.why).split("\n").map((l) => outsideLine(l, WHY_LIMIT)).join("\n").trim();
	app.db.prepare("INSERT INTO proposals (id, plugin, key, title, why, steps_json, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)").run(id, plugin, p.key, title, why, app.redact(JSON.stringify(steps)), nowIso(), expiresAt);
	const v = view(app, getRow(app, id)!);
	// What reaches the Inbox and the owner's devices is Reelix's summary; the plugin's words come last, quoted.
	const quote = [title, ...why.split("\n").filter(Boolean)].map((l) => `> ${l}`).join("\n");
	const body = [...v.steps.map((s) => `- ${s.preview.text}`), "", tr(app, "proposal.quoted", { plugin }), quote, "", tr(app, "proposal.openToDecide")].join("\n");
	const item = addInbox(app, { kind: "proposal", title: v.summary, body, payload: { proposal: id, urgent: true }, source: `plugin:${plugin}` });
	app.db.prepare("UPDATE proposals SET inbox_id = ? WHERE id = ?").run(item.id, id);
	return { ...v, inbox_id: item.id };
}

/** The owner's decision. Approved steps run now, one after another; the result of each is returned. */
async function decideProposal(app: Reelix, id: string, d: { approve: boolean; steps?: number[] }, actor: string): Promise<ProposalView> {
	const current = getProposal(app, id);
	if (current.status !== "open") throw new ReelixError("proposal_closed", `This proposal is no longer open: ${current.status}.`);
	const r = getRow(app, id)!;
	const steps = json<StoredStep[]>(r.steps_json, []);
	if (!d.approve) {
		const v = close(app, r, "declined", steps.map((s) => ({ operation: s.operation, status: "declined" })), actor);
		if (r.inbox_id) recordAnswer(app, r.inbox_id, tr(app, "proposal.declined"), actor);
		return v;
	}
	const ticked = new Set(d.steps ?? steps.map((_, i) => i));
	for (const i of ticked) if (!Number.isInteger(i) || i < 0 || i >= steps.length) throw new ReelixError("invalid_input", `There is no step ${i}.`);
	if (!ticked.size) throw new ReelixError("invalid_input", "Tick at least one step, or decline the proposal.");
	// Closed first, so a second click cannot run anything twice.
	const taken = app.db.prepare("UPDATE proposals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'open'").run(nowIso(), actor, id);
	if (!taken.changes) throw new ReelixError("proposal_closed", "This proposal was decided a moment ago.");

	const results: ProposalStepResult[] = [];
	for (const [i, s] of steps.entries()) {
		if (!ticked.has(i)) {
			results.push({ operation: s.operation, status: "not_approved" });
			continue;
		}
		results.push(await runStep(app, r, s, i, actor));
	}
	const v = close(app, r, "approved", results, actor);
	if (r.inbox_id) recordAnswer(app, r.inbox_id, tr(app, "proposal.approved", { done: results.filter((x) => x.status === "succeeded").length, count: steps.length }), actor);
	return v;
}

async function runStep(app: Reelix, r: Row, s: StoredStep, index: number, approvedBy: string): Promise<ProposalStepResult> {
	const op = app.operations.get(s.operation);
	if (!op) return { operation: s.operation, status: "failed", text: `${s.operation} is not available now (its plugin is off).` };
	try {
		const again = await previewOf(app, op, s.input, r.plugin);
		if (!sameData(again.target, s.preview.target)) return { operation: s.operation, status: "skipped", text: tr(app, "proposal.changed", { now: again.text }) };
	} catch (e) {
		return { operation: s.operation, status: "skipped", text: app.redact(errorMessage(e)) };
	}
	const approval = createApproval(app, { operation: s.operation, input: s.input, requestedBy: `plugin:${r.plugin}`, approvedBy, expiresAt: new Date(Date.now() + STEP_APPROVAL_MS).toISOString() });
	try {
		const out = await runOperation(app, s.operation, s.input, { actor: `plugin:${r.plugin}`, requestId: `proposal:${r.id}:${index}` });
		return { operation: s.operation, status: "succeeded", text: out.text };
	} catch (e) {
		return { operation: s.operation, status: "failed", text: app.redact(errorMessage(e)) };
	} finally {
		dropApproval(app, approval);
	}
}

export function listProposals(app: Reelix, status = "open"): ProposalView[] {
	expireProposals(app);
	const rows = (status === "all" ? app.db.prepare("SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100").all() : app.db.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT 100").all(status)) as Row[];
	return rows.map((r) => view(app, r));
}

const stepLine = (s: ProposalView["steps"][number], i: number) => `${i}. ${s.preview.text}${s.effect === "destructive" ? " [destructive]" : ""}${s.result ? ` → ${s.result.status}${s.result.text ? `: ${s.result.text}` : ""}` : ""}`;
const proposalText = (v: ProposalView) => [`${v.id} | ${v.status} | ${v.summary}`, ...v.steps.map(stepLine), `From the plugin ${v.plugin}: ${v.title}${v.why ? ` (${v.why.replace(/\n/g, " ")})` : ""}`].join("\n");

defineOperation({
	name: "proposal.list",
	summary: "Proposals plugins made for the owner to approve",
	effect: "read",
	input: Type.Object({ status: Type.Optional(Type.String({ description: "open (default) | approved | declined | expired | replaced | all" })) }),
	async run(ctx, i) {
		return listProposals(ctx.app, i.status);
	},
	toText: (o: ProposalView[]) => o.map((v) => `${v.id} | ${v.status} | ${v.summary}`).join("\n") || "No proposals.",
});

defineOperation({
	name: "proposal.show",
	summary: "One proposal: each step as Reelix previews it, and the result of each once decided",
	effect: "read",
	input: Type.Object({ id: Type.String() }),
	positional: ["id"],
	async run(ctx, i) {
		return getProposal(ctx.app, i.id);
	},
	toText: proposalText,
});

defineOperation({
	name: "proposal.decide",
	summary: "Approve a plugin's proposal, all steps or the ones listed, or decline it (owner only)",
	// Approving makes approval records, which only the owner's own answer may make (§11.2).
	effect: "admin",
	input: Type.Object({ id: Type.String(), approve: Type.Boolean(), steps: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }), { description: "the steps to run, by number; default all" })) }),
	positional: ["id"],
	async run(ctx, i) {
		return decideProposal(ctx.app, i.id, { approve: i.approve, steps: i.steps }, ctx.actor);
	},
	toText: proposalText,
});
