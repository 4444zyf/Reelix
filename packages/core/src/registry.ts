import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { Reelix } from "./app.ts";
import { json } from "./db.ts";
import { ReelixError, errorMessage, newId, nowIso } from "./util.ts";

export type Effect = "read" | "write" | "destructive";

export type OpCtx = {
	app: Reelix;
	/** owner:web | owner:cli | owner:telegram | agent:<thread> | job:<run> */
	actor: string;
	requestId: string;
	signal?: AbortSignal;
	progress?: (text: string) => void;
};

export type ReconcileResult = { status: "succeeded" | "failed"; output?: unknown; error?: string } | undefined;

export type Operation<S extends TSchema = TSchema, O = unknown> = {
	name: string; // "download.add"
	summary: string;
	description?: string;
	effect: Effect;
	input: S;
	run(ctx: OpCtx, input: Static<S>): Promise<O>;
	/** How to find out whether an interrupted run took effect (§6.2). */
	reconcile?(ctx: OpCtx, input: Static<S>): Promise<ReconcileResult>;
	/** Compact text for the model and the terminal. Defaults to JSON. */
	toText?(output: O, input: Static<S>): string;
	/** Exposed as a typed agent tool under this name (§4.2). */
	tool?: string;
	/** Positional CLI arguments, in order. */
	positional?: string[];
	/** Title this action concerns, for the Activity view. */
	titleOf?(input: Static<S>, output?: O): string | undefined;
};

const registry = new Map<string, Operation>();

export function defineOperation<S extends TSchema, O>(op: Operation<S, O>): Operation<S, O> {
	if (registry.has(op.name)) throw new Error(`duplicate operation ${op.name}`);
	registry.set(op.name, op as unknown as Operation);
	return op;
}

export function getOperation(name: string): Operation | undefined {
	return registry.get(name);
}

export function listOperations(): Operation[] {
	return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
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
export async function runOperation(app: Reelix, name: string, rawInput: unknown, opts: { actor: string; requestId?: string; signal?: AbortSignal; progress?: (t: string) => void }): Promise<OpResult> {
	const op = registry.get(name);
	if (!op) throw new ReelixError("unknown_operation", `No operation named "${name}". Run \`reelix help\` for the list.`);
	const input = prepareInput(op, rawInput);
	const ctx: OpCtx = { app, actor: opts.actor, requestId: opts.requestId ?? newId("req_"), signal: opts.signal, progress: opts.progress };
	const textOf = (o: unknown) => app.redact(op.toText ? op.toText(o as never, input as never) : JSON.stringify(o, null, 1));

	if (op.effect === "read") {
		const output = await op.run(ctx, input as never);
		return { output, text: textOf(output) };
	}

	// --- ledger
	const existing = app.db.prepare("SELECT * FROM actions WHERE request_id = ?").get(ctx.requestId) as Record<string, any> | undefined;
	if (existing) {
		if (existing.status === "succeeded") return { output: json(existing.output_json, null), text: textOf(json(existing.output_json, null)), actionId: existing.id, repeated: true };
		if (existing.status === "failed") throw new ReelixError("repeated_failure", `This request already ran and failed: ${existing.error}`);
		if (existing.status === "pending") throw new ReelixError("in_progress", "This request is already running.");
		if (existing.status === "unknown") {
			const settled = await reconcileAction(app, existing.id);
			if (settled === "succeeded") {
				const row = app.db.prepare("SELECT output_json FROM actions WHERE id = ?").get(existing.id) as { output_json: string };
				return { output: json(row.output_json, null), text: textOf(json(row.output_json, null)), actionId: existing.id, repeated: true };
			}
			if (settled === "unknown") throw new ReelixError("outcome_unknown", "An earlier attempt of this request has an unknown outcome and cannot be checked automatically. Look at the current state before retrying with a new request.");
			// failed: fall through and run again under a fresh ledger row
			app.db.prepare("UPDATE actions SET request_id = request_id || ':' || id WHERE id = ?").run(existing.id);
		}
	}
	const started = nowIso();
	const info = app.db
		.prepare("INSERT INTO actions (request_id, op, effect, actor, input_json, status, title_id, started_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)")
		.run(ctx.requestId, op.name, op.effect, ctx.actor, app.redact(JSON.stringify(input)), safeTitle(op, input), started);
	const actionId = Number(info.lastInsertRowid);
	app.emit({ type: "action", action: { id: actionId, op: op.name, actor: ctx.actor, status: "pending", started_at: started } });
	try {
		const output = await op.run(ctx, input as never);
		const title = safeTitle(op, input, output);
		app.db.prepare("UPDATE actions SET status = 'succeeded', output_json = ?, finished_at = ?, title_id = COALESCE(?, title_id) WHERE id = ?").run(JSON.stringify(output ?? null), nowIso(), title ?? null, actionId);
		app.emit({ type: "action", action: { id: actionId, op: op.name, actor: ctx.actor, status: "succeeded" } });
		return { output, text: textOf(output), actionId };
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
	const op = registry.get(row.op);
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
		app.db.prepare("UPDATE actions SET status = ?, output_json = COALESCE(?, output_json), error = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?").run(r.status, r.output === undefined ? null : JSON.stringify(r.output), r.error ?? null, nowIso(), id);
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
