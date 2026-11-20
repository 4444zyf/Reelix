import type { OperationPreview } from "@reelix/plugin";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { Reelix } from "./app.ts";
import { consumeApproval } from "./approvals.ts";
import { json } from "./db.ts";
import { ReelixError, errorMessage, newId, nowIso } from "./util.ts";

export type Effect = "read" | "write" | "destructive" | "admin";

export type OpCtx = {
	app: Reelix;
	/** owner:web | owner:cli | owner:<chat channel> | agent:<thread> | agent:cli | agent:socket | job:<run> | plugin:<id> */
	actor: string;
	requestId: string;
	signal?: AbortSignal;
	progress?: (text: string) => void;
	/** Set for a signed-in browser's request. `origin` is present only after passing `originAllowed`. */
	request?: { origin?: string };
};

export type ReconcileResult = { status: "succeeded" | "failed"; output?: unknown; error?: string } | undefined;

export type Operation<S extends TSchema = TSchema, O = unknown> = {
	name: string; // "download.add"
	summary: string;
	description?: string;
	effect: Effect;
	/** An `admin` operation the agent and jobs may run too (docs/plugins.md §11.2). */
	agentMay?: boolean;
	input: S;
	run(ctx: OpCtx, input: Static<S>): Promise<O>;
	/** How to find out whether an interrupted run took effect (§6.2). */
	reconcile?(ctx: OpCtx, input: Static<S>): Promise<ReconcileResult>;
	/** Compact text for the model and the terminal. Defaults to JSON. A plugin in its own process answers it over the channel, so it may be a promise (docs/plugins.md §11.7). */
	toText?(output: O, input: Static<S>): string | Promise<string>;
	/** Exposed as a typed agent tool under this name (§4.2). */
	tool?: string;
	/** Positional CLI arguments, in order. */
	positional?: string[];
	/** What the ledger keeps of the input, when part of it must never be stored (a secret's value). */
	recordInput?(input: Static<S>): unknown;
	/** What the ledger keeps of the output, when part of it must never be stored (a one-time code). */
	recordOutput?(output: O): unknown;
	/** What it would do, without doing it: how a step of a proposal is shown and checked again (docs/plugins.md §10.3). */
	preview?(ctx: OpCtx, input: Static<S>): Promise<OperationPreview>;
	/** A plugin's card kind (`<plugin>.<kind>`) that shows its result in chat (docs/plugins.md §12.3). */
	card?: string;
	/** Title this action concerns, for the Activity view. */
	titleOf?(input: Static<S>, output?: O): string | undefined;
	/** The plugin that registered it; absent for Reelix's own operations. */
	plugin?: string;
};

/** What `/api/ops` says about an operation: everything the CLI needs to list, parse and label it. */
export type OperationInfo = Pick<Operation, "name" | "summary" | "description" | "effect" | "agentMay" | "input" | "tool" | "positional" | "plugin">;

export const operationInfo = (o: Operation): OperationInfo => ({ name: o.name, summary: o.summary, description: o.description, effect: o.effect, agentMay: o.agentMay, input: o.input, tool: o.tool, positional: o.positional, plugin: o.plugin });

const declared: Operation[] = [];
let sealed = false;

/** Declare one of core's own operations. Only while core is being imported; see `CORE_OPERATIONS`. */
export function defineOperation<S extends TSchema, O>(op: Operation<S, O>): Operation<S, O> {
	if (sealed) throw new Error(`${op.name}: core's operations are fixed; add it to the app's registry`);
	if (declared.some((d) => d.name === op.name)) throw new Error(`duplicate operation ${op.name}`);
	declared.push(op as unknown as Operation);
	return op;
}

/** End of core's declarations: the list every app's registry starts from. */
export function sealCoreOperations(): readonly Operation[] {
	sealed = true;
	return Object.freeze([...declared]);
}

/** The operations of one running Reelix: core's, then the server's and its plugins' (docs/plugins.md §15). */
export class OperationRegistry {
	private entries = new Map<string, Operation>();

	constructor(core: readonly Operation[]) {
		for (const op of core) this.entries.set(op.name, op);
	}

	get(name: string): Operation | undefined {
		return this.entries.get(name);
	}

	list(): Operation[] {
		return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Returns the step that removes it again. */
	add<S extends TSchema, O>(op: Operation<S, O>): () => void {
		if (this.entries.has(op.name)) throw new Error(`there is already an operation named ${op.name}`);
		const entry = op as unknown as Operation;
		this.entries.set(op.name, entry);
		return () => {
			if (this.entries.get(op.name) === entry) this.entries.delete(op.name);
		};
	}

	/** First words of the operations that are not a plugin's: no plugin may take one as its id (§3). */
	reservedWords(): Set<string> {
		return new Set(this.list().filter((o) => !o.plugin).map((o) => o.name.split(".")[0]!));
	}
}

/** The mark an operation carries in `reelix help` and the agent's list. */
export function effectLabel(op: Pick<Operation, "effect" | "agentMay">): string {
	if (op.effect === "destructive") return " [destructive]";
	if (op.effect === "admin") return op.agentMay ? " [admin]" : " [owner only]";
	return "";
}

/** Who may run what (docs/plugins.md §11.2). */
function checkActor(op: Operation, actor: string): void {
	if (op.effect !== "admin" || actor.startsWith("owner:")) return;
	if (actor.startsWith("plugin:")) throw new ReelixError("owner_only", `${op.name} changes how Reelix is set up; plugins can never run it.`);
	if (!op.agentMay) throw new ReelixError("owner_only", `${op.name} is for the owner only. Use the web UI, or run \`reelix ${op.name.replace(/\./g, " ")}\` yourself in a real terminal (commands from scripts, pipes and the agent's shell do not count).`);
}

export type OpResult = { output: unknown; text: string; actionId?: number; repeated?: boolean };

/** Fill defaults, coerce CLI strings, validate. */
export function prepareInput(op: Operation, raw: unknown): unknown {
	let v: unknown = Value.Clone((raw ?? {}) as object);
	v = Value.Default(op.input, v);
	v = Value.Convert(op.input, v);
	v = Value.Clean(op.input, v);
	const errors = [...Value.Errors(op.input, v)];
	if (errors.length) {
		throw new ReelixError(
			"invalid_input",
			`${op.name}: ` + errors.map((e) => `${((e as { instancePath?: string }).instancePath || "input").replace(/^\//, "")} ${e.message}`).join("; "),
		);
	}
	return v;
}

/**
 * Run an operation by name. `write` and `destructive` operations are recorded in the ledger
 * before they run and settled afterwards (§6.2). Re-sending the same request ID returns the
 * first result instead of running again.
 */
export async function runOperation(app: Reelix, name: string, rawInput: unknown, opts: { actor: string; requestId?: string; signal?: AbortSignal; progress?: (t: string) => void; request?: OpCtx["request"] }): Promise<OpResult> {
	const op = app.operations.get(name);
	if (!op) throw new ReelixError("unknown_operation", `No operation named "${name}". Run \`reelix help\` for the list.`);
	checkActor(op, opts.actor);
	const input = prepareInput(op, rawInput);
	const ctx: OpCtx = { app, actor: opts.actor, requestId: opts.requestId ?? newId("req_"), signal: opts.signal, progress: opts.progress, request: opts.request };
	const textOf = async (o: unknown) => app.redact(op.toText ? await op.toText(o as never, input as never) : JSON.stringify(o, null, 1));

	if (op.effect === "read") {
		const output = await op.run(ctx, input as never);
		return { output, text: await textOf(output) };
	}

	// --- ledger
	const existing = app.db.prepare("SELECT * FROM actions WHERE request_id = ?").get(ctx.requestId) as Record<string, any> | undefined;
	if (existing) {
		if (existing.status === "succeeded") return { output: json(existing.output_json, null), text: await textOf(json(existing.output_json, null)), actionId: existing.id, repeated: true };
		if (existing.status === "failed") throw new ReelixError("repeated_failure", `This request already ran and failed: ${existing.error}`);
		if (existing.status === "pending") throw new ReelixError("in_progress", "This request is already running.");
		if (existing.status === "unknown") {
			const settled = await reconcileAction(app, existing.id);
			if (settled === "succeeded") {
				const row = app.db.prepare("SELECT output_json FROM actions WHERE id = ?").get(existing.id) as { output_json: string };
				return { output: json(row.output_json, null), text: await textOf(json(row.output_json, null)), actionId: existing.id, repeated: true };
			}
			if (settled === "unknown") throw new ReelixError("outcome_unknown", "An earlier attempt of this request has an unknown outcome and cannot be checked automatically. Look at the current state before retrying with a new request.");
			// failed: fall through and run again under a fresh ledger row
			app.db.prepare("UPDATE actions SET request_id = request_id || ':' || id WHERE id = ?").run(existing.id);
		}
	}
	// A plugin runs something destructive only on the owner's recorded approval, used up here (§11.2).
	if (op.effect === "destructive" && ctx.actor.startsWith("plugin:") && !consumeApproval(app, op.name, input, ctx.actor)) {
		throw new ReelixError("approval_required", `${op.name} is destructive; a plugin cannot run it without the owner's approval.`);
	}
	const recorded = op.recordInput ? await op.recordInput(input as never) : input;
	const started = nowIso();
	const info = app.db
		.prepare("INSERT INTO actions (request_id, op, effect, actor, input_json, status, title_id, started_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)")
		.run(ctx.requestId, op.name, op.effect, ctx.actor, app.redact(JSON.stringify(recorded)), safeTitle(op, input), started);
	const actionId = Number(info.lastInsertRowid);
	app.emit({ type: "action", action: { id: actionId, op: op.name, actor: ctx.actor, status: "pending", started_at: started } });
	try {
		const output = await op.run(ctx, input as never);
		const title = safeTitle(op, input, output);
		const kept = op.recordOutput ? await op.recordOutput(output) : output;
		app.db.prepare("UPDATE actions SET status = 'succeeded', output_json = ?, finished_at = ?, title_id = COALESCE(?, title_id) WHERE id = ?").run(app.redact(JSON.stringify(kept ?? null)), nowIso(), title ?? null, actionId);
		app.emit({ type: "action", action: { id: actionId, op: op.name, actor: ctx.actor, status: "succeeded" } });
		return { output, text: await textOf(output), actionId };
	} catch (e) {
		// A timeout or cancellation leaves the outcome unknown; a refusal is a failure.
		const unknown = ctx.signal?.aborted || (e instanceof ReelixError && (e.code === "network_timeout" || e.code === "outcome_unknown"));
		app.db.prepare("UPDATE actions SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(unknown ? "unknown" : "failed", app.redact(errorMessage(e)), nowIso(), actionId);
		app.emit({ type: "action", action: { id: actionId, op: op.name, actor: ctx.actor, status: unknown ? "unknown" : "failed" } });
		throw e;
	}
}

function safeTitle(op: Operation, input: unknown, output?: unknown): string | null {
	try {
		return op.titleOf?.(input as never, output as never) ?? null;
	} catch {
		return null;
	}
}

/** Settle one `unknown` (or crashed `pending`) entry using the operation's own reconcile step. */
export async function reconcileAction(app: Reelix, id: number): Promise<"succeeded" | "failed" | "unknown"> {
	const row = app.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Record<string, any> | undefined;
	if (!row) return "unknown";
	// A plugin's operation whose plugin is not here cannot be checked: the action stays unknown.
	const op = app.operations.get(row.op);
	if (!op?.reconcile) {
		app.db.prepare("UPDATE actions SET status = 'unknown' WHERE id = ? AND status = 'pending'").run(id);
		return "unknown";
	}
	try {
		const r = await op.reconcile({ app, actor: "system", requestId: row.request_id }, json(row.input_json, {}) as never);
		if (!r) {
			app.db.prepare("UPDATE actions SET status = 'unknown' WHERE id = ?").run(id);
			return "unknown";
		}
		app.db.prepare("UPDATE actions SET status = ?, output_json = COALESCE(?, output_json), error = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?").run(r.status, r.output === undefined ? null : app.redact(JSON.stringify(r.output)), r.error ?? null, nowIso(), id);
		return r.status;
	} catch {
		return "unknown";
	}
}

/** On start-up: anything still `pending` was interrupted. Reconcile it and every `unknown`. */
export async function reconcileOnStartup(app: Reelix): Promise<{ settled: number; unknown: number }> {
	app.db.prepare("UPDATE actions SET status = 'unknown', error = COALESCE(error, 'interrupted by a restart') WHERE status = 'pending'").run();
	const rows = app.db.prepare("SELECT id FROM actions WHERE status = 'unknown' AND started_at > datetime('now', '-7 days')").all() as { id: number }[];
	let settled = 0;
	for (const r of rows) if ((await reconcileAction(app, r.id)) !== "unknown") settled++;
	return { settled, unknown: rows.length - settled };
}
