import { Type } from "typebox";
import { MODEL_ROLES, type ModelAnswer, type ModelRole, type Operation, type Reelix, type SpendScope, TranslationPaused, errorMessage, recordSpend, roleModels } from "@reelix/core";

/** The part of pi's model runtime the router uses (tests pass a fake). */
export type RuntimeLike = {
	getModel(provider: string, id: string): any;
	getAvailableSnapshot?(): readonly any[];
	completeSimple(model: any, context: { systemPrompt?: string; messages: any[] }, options?: any): Promise<any>;
	registerProvider?(id: string, config: any): void;
	unregisterProvider?(id: string): void;
};

const REST_START_MS = 60_000;
const REST_MAX_MS = 30 * 60_000;

/** Why a model call failed (docs/models.md, "Why a call failed"). */
type FailureClass = "signed_out" | "timeout" | "rate_limited" | "budget" | "capability" | "other";
/** What the owner can do about it: reconnect the provider, try again, wait until a time, choose a model that can. */
type FailureAction = "reconnect" | "retry" | "wait" | "choose_model";
export type ModelFailure = {
	/** The model that failed, as `provider/model`. */
	model?: string;
	class: FailureClass;
	action: FailureAction;
	/** For `capability`: what the model lacks. */
	capability?: "images" | "context";
	/** For `rate_limited` and `budget`: when the model can be used again, when that is known. */
	until?: string;
	/** The provider's own words, secrets blanked out. */
	message: string;
};

const ACTION: Record<FailureClass, FailureAction> = { signed_out: "reconnect", timeout: "retry", rate_limited: "wait", budget: "wait", capability: "choose_model", other: "retry" };

// What providers and gateways say, by class. A quota per minute is a rate limit, not a budget.
const PER_SHORT_TIME = /per[ _-]?(?:minute|second|min|sec)\b|\b[rt]pm\b|\b[rt]ps\b/i;
const BUDGET = /insufficient[_ ]quota|exceeded your current quota|quota[_ ]exceeded|out of budget|budget|spending limit|usage limit|billing|credit balance|insufficient (?:balance|credits?|funds)|payment required|\b402\b|limit (?:has been )?reached/i;
const RATE = /rate[_ .-]?limit|too many requests|\b429\b|throttl|overloaded|resource[_ ]?exhausted|server_busy|at capacity/i;
const IMAGES = /(?:does not|doesn't|do not|cannot|can't) (?:support|accept|read|process) (?:images?|vision)|images? (?:input )?(?:is |are )?not supported|image[_ ]?(?:input|url|content)[^.]*(?:not supported|unsupported)|image(?:_url| input)s? (?:is|are) only supported|vision is not supported/i;
const CONTEXT = /context[_ ](?:length|window)|maximum context|context size|prompt (?:is )?too long|too many tokens|token limit exceeded|input (?:is )?too long|request_too_large|range of input length|longer than the model'?s context|\b413\b/i;
const SIGNED_OUT = /\b401\b|\b403\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|api key (?:is )?(?:invalid|missing|expired|not valid)|no api key|authenticat|token (?:has )?expired|expired token|refresh token|not logged in|log ?in again|sign ?in again|signed out|credentials|forbidden|permission denied|wants a gateway key|not known to pi/i;
const TIMEOUT = /timed? ?out|timeout|no answer within|deadline exceeded|ETIMEDOUT/i;

/**
 * Sort a failed call into the classes the owner can act on (docs/models.md). `reset`: when the
 * model's budget renews, known from elsewhere (magpie's limit), for a budget refusal that does not say.
 */
export function classifyFailure(message: string, o: { model?: string; reset?: string; now?: number } = {}): ModelFailure {
	const text = message || "no answer";
	let cls: FailureClass;
	let capability: ModelFailure["capability"];
	if (BUDGET.test(text) && !PER_SHORT_TIME.test(text)) cls = "budget";
	else if (RATE.test(text) || BUDGET.test(text)) cls = "rate_limited";
	else if (IMAGES.test(text)) (cls = "capability"), (capability = "images");
	else if (CONTEXT.test(text)) (cls = "capability"), (capability = "context");
	else if (SIGNED_OUT.test(text)) cls = "signed_out";
	else if (TIMEOUT.test(text)) cls = "timeout";
	else cls = "other";
	const until = cls === "rate_limited" || cls === "budget" ? (untilFrom(text, o.now ?? Date.now()) ?? (cls === "budget" ? o.reset : undefined)) : undefined;
	return { ...(o.model ? { model: o.model } : {}), class: cls, action: ACTION[cls], ...(capability ? { capability } : {}), ...(until ? { until } : {}), message: text };
}

/** "try again in 20s", "retry after 90 seconds", "resets at 2026-11-23T00:00:00Z": the time it names. */
function untilFrom(text: string, now: number): string | undefined {
	const at = /reset(?:s|ting)?(?: at| on)?\s+(\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
	if (at) {
		const t = Date.parse(at[1]!);
		if (!Number.isNaN(t)) return new Date(t).toISOString();
	}
	const rel = /(?:try again|retry|retry-after|resets?|wait)\D{0,20}?((?:\d+(?:\.\d+)?\s*(?:ms|hours?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*)+)/i.exec(text);
	if (!rel) return undefined;
	let ms = 0;
	for (const [, n, unit] of rel[1]!.matchAll(/(\d+(?:\.\d+)?)\s*(ms|hours?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
		const u = unit!.toLowerCase();
		ms += Number(n) * (u === "ms" ? 1 : u.startsWith("h") ? 3_600_000 : u.startsWith("m") ? 60_000 : 1000);
	}
	return ms > 0 ? new Date(now + ms).toISOString() : undefined;
}

/** No model of a role could answer: each one's failure, classified. Still a pause for translation. */
export class ModelsUnavailable extends TranslationPaused {
	failures: ModelFailure[];
	constructor(message: string, failures: ModelFailure[]) {
		super(message);
		this.failures = failures;
	}
}

/** What a direct call answered, and the role's models that failed before it. */
type RoutedAnswer = ModelAnswer & { skipped: ModelFailure[] };

/**
 * Which model does a piece of work use (docs/models.md)? Each role has an ordered list; a call
 * that fails before answering goes to the next model, and a model that just failed is skipped for
 * a while. Smarter routing, quotas and budgets belong to magpie, which is just another provider.
 */
export class ModelRouter {
	app: Reelix;
	private runtime: () => RuntimeLike | undefined;
	private resting = new Map<string, { until: number; strikes: number; failure: ModelFailure }>();
	magpie: { url?: string; ok: boolean; models: string[]; error?: string; admin?: boolean; limits?: { period: string; cost?: number; costLimit?: number; reset?: string; spent?: boolean }[] } = { ok: false, models: [] };
	/** Direct calls in flight, by model (so a magpie change can see what it would cut). */
	active = new Map<string, { count: number; role: ModelRole; scope: SpendScope }>();

	constructor(app: Reelix, runtime: () => RuntimeLike | undefined) {
		this.app = app;
		this.runtime = runtime;
	}

	specs(role: ModelRole): string[] {
		return roleModels(this.app.config, role);
	}

	resolve(spec: string): any {
		const [provider, ...rest] = spec.split("/");
		return this.runtime()?.getModel(provider!, rest.join("/"));
	}

	isResting(spec: string): boolean {
		const r = this.resting.get(spec);
		return !!r && r.until > Date.now();
	}

	/**
	 * A model failed: skip it for a minute, doubling up to half an hour while it keeps failing, or
	 * until the time its provider named (a rate limit or budget).
	 */
	rest(spec: string, failure: ModelFailure): void {
		const strikes = (this.resting.get(spec)?.strikes ?? 0) + 1;
		const backoff = Date.now() + Math.min(REST_MAX_MS, REST_START_MS * 2 ** (strikes - 1));
		const named = failure.until ? Date.parse(failure.until) : Number.NaN;
		this.resting.set(spec, { until: Number.isNaN(named) ? backoff : Math.max(backoff, named), strikes, failure: { ...failure, model: spec } });
	}

	/** Classify a failed call of `spec`; a budget refusal through magpie waits for magpie's renewal. */
	classify(spec: string, message: string): ModelFailure {
		const reset = spec.startsWith("magpie/") ? this.magpie.limits?.find((l) => l.spent && l.reset)?.reset : undefined;
		return classifyFailure(this.app.redact(message).slice(0, 300), { model: spec, reset });
	}

	ok(spec: string): void {
		this.resting.delete(spec);
	}

	/**
	 * The model a new agent conversation uses: the first one in the role's list that pi knows and
	 * that has not just failed. Undefined when the role has no list (pi's default model).
	 */
	pick(role: ModelRole): { spec: string; model: any } | undefined {
		const specs = this.specs(role);
		if (!specs.length) return undefined;
		const known = specs.map((spec) => ({ spec, model: this.resolve(spec) })).filter((x) => x.model);
		if (!known.length) throw new Error(`None of the models set for "${role}" is known to pi: ${specs.join(", ")}. Check Settings → Models.`);
		return known.find((x) => !this.isResting(x.spec)) ?? known[0];
	}

	/**
	 * One question, one answer, no tools. Tries the role's models in order, and only those (pi's default
	 * when the role has none); what it costs is recorded under `scope` (src/spend.ts in core). When none
	 * can answer, throws ModelsUnavailable (a TranslationPaused) so the caller waits and tries again
	 * instead of failing. `timeoutS`: one call's time limit, by default `translation.call_timeout_s`.
	 */
	async complete(role: ModelRole, system: string, user: string, o: { scope: SpendScope; signal?: AbortSignal; timeoutS?: number }): Promise<RoutedAnswer> {
		const signal = o.signal;
		const rt = this.runtime();
		if (!rt) throw new ModelsUnavailable("The model runtime is not available.", []);
		let candidates = this.specs(role).map((spec) => ({ spec, model: this.resolve(spec) }));
		if (!candidates.length) {
			const d = rt.getAvailableSnapshot?.()[0];
			if (!d) throw new ModelsUnavailable(`No model is set for "${role}" and pi has no default. Set one under Settings → Models.`, [{ class: "signed_out", action: "reconnect", message: "no model provider is signed in" }]);
			candidates = [{ spec: `${d.provider}/${d.id}`, model: d }];
		}
		const errors: string[] = [];
		const failures: ModelFailure[] = [];
		// Models that are not resting first; resting ones are still tried last rather than giving up.
		const ordered = [...candidates.filter((c) => !this.isResting(c.spec)), ...candidates.filter((c) => this.isResting(c.spec))];
		for (const c of ordered) {
			if (signal?.aborted) throw new Error("aborted");
			if (!c.model) {
				errors.push(`${c.spec}: not known to pi`);
				failures.push(classifyFailure("not known to pi (its provider is signed out, or the name is wrong)", { model: c.spec }));
				continue;
			}
			// A model that keeps thinking must not hold the job forever.
			const limitS = o.timeoutS ?? this.app.config.translation.call_timeout_s;
			const timer = AbortSignal.timeout(limitS * 1000);
			const both = signal ? AbortSignal.any([signal, timer]) : timer;
			const a = this.active.get(c.spec) ?? { count: 0, role, scope: o.scope };
			a.count++;
			this.active.set(c.spec, a);
			try {
				const m = await rt.completeSimple(c.model, { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] }, { signal: both });
				if (timer.aborted && !signal?.aborted) throw new Error(`no answer within ${limitS} s (a reasoning model may need its thinking switched off for this role)`);
				const text = (m?.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
				if (m?.stopReason === "error" || m?.stopReason === "aborted" || !text.trim()) throw new Error(m?.errorMessage || `no answer (${m?.stopReason ?? "empty"})`);
				recordSpend(this.app, o.scope, m.usage);
				this.ok(c.spec);
				return { text, model: c.spec, skipped: failures };
			} catch (e) {
				if (signal?.aborted) throw new Error("aborted");
				const failure = this.classify(c.spec, timer.aborted ? `no answer within ${limitS} s (a reasoning model may need its thinking switched off for this role)` : errorMessage(e));
				errors.push(`${c.spec}: ${failure.message}`);
				failures.push(failure);
				this.rest(c.spec, failure);
			} finally {
				if (--a.count <= 0) this.active.delete(c.spec);
			}
		}
		throw new ModelsUnavailable(`No model for "${role}" could answer. ${errors.join("; ")}`, failures);
	}

	/**
	 * Make the magpie gateway's models and routing groups known to pi as provider "magpie"
	 * (magpie/group/<id>, magpie/<provider>/<model>). Changes go through @reelix/core's magpie plans.
	 */
	async registerMagpie(fetchImpl: typeof fetch = fetch): Promise<typeof this.magpie> {
		this.magpieReadAt = Date.now();
		const rt = this.runtime();
		const url = this.app.config.magpie.url?.replace(/\/+$/, "");
		if (!url) {
			if (this.magpie.url) rt?.unregisterProvider?.("magpie");
			return (this.magpie = { ok: false, models: [] });
		}
		const key = this.app.secrets["magpie.api_key"];
		try {
			const res = await fetchImpl(`${url}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000) });
			if (!res.ok) throw new Error(`the gateway answered ${res.status}${res.status === 401 || res.status === 403 ? " (it wants a gateway key: add the gateway key under Settings → Services → magpie)" : ""}`);
			const body = (await res.json()) as { data?: { id?: string }[] };
			const models = (body.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
			rt?.registerProvider?.("magpie", { name: "magpie", baseUrl: `${url}/v1`, api: "openai-completions", apiKey: key || "local", models: models.map((id) => ({ id })) });
			this.magpie = { url, ok: true, models, admin: !!this.app.secrets["magpie.admin_key"] };
			// Reelix's own limit, for Settings (a plain gateway route, not the management API).
			if (key) {
				const l = await fetchImpl(`${url}/v1/magpie/limit`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
				if (l?.ok) {
					const b: any = await l.json().catch(() => ({}));
					this.magpie.limits = (b.limits ?? (b.limit ? [b.limit] : [])).map((x: any) => ({ period: String(x.period), cost: x.cost, costLimit: x.costLimit, reset: x.reset, spent: !!x.spent }));
				}
			}
		} catch (e) {
			this.magpie = { url, ok: false, models: [], error: this.app.redact(errorMessage(e)) };
		}
		return this.magpie;
	}

	private magpieReadAt = 0;

	/** Read magpie again when the last read is older than maxAgeMs (for Settings' spending line). */
	async refreshMagpie(maxAgeMs: number): Promise<void> {
		if (!this.app.config.magpie.url || Date.now() - this.magpieReadAt < maxAgeMs) return;
		await this.registerMagpie();
	}

	/** For Settings and `reelix site status`. `rests`: each resting model, why and until when. */
	describe(): { roles: Record<string, { own: string[]; uses: string[]; resting: string[] }>; rests: (ModelFailure & { model: string; until: string })[]; magpie: ModelRouter["magpie"] } {
		const roles: Record<string, { own: string[]; uses: string[]; resting: string[] }> = {};
		for (const r of MODEL_ROLES) {
			const uses = this.specs(r);
			roles[r] = { own: this.app.config.models.roles[r], uses, resting: uses.filter((s) => this.isResting(s)) };
		}
		const rests = [...this.resting].filter(([spec]) => this.isResting(spec)).map(([model, r]) => ({ ...r.failure, model, until: new Date(r.until).toISOString() }));
		return { roles, rests, magpie: this.magpie };
	}
}

/** Where a role's spending counts: chat on its own, translation's roles under translation, the rest in the background. */
const ROLE_SCOPE: Record<ModelRole, SpendScope> = { chat: "chat", background: "background", glossary: "translation", translate: "translation", review: "translation" };
const TEST_TIMEOUT_S = 60;
const TEST_INPUT = Type.Object({ role: Type.Optional(Type.Union(MODEL_ROLES.map((r) => Type.Literal(r)), { description: "the role to test (default chat)" })) });

type ModelTestResult =
	| { ok: true; role: ModelRole; model: string; answer: string; ms: number; skipped: ModelFailure[] }
	| { ok: false; role: ModelRole; ms: number; failures: ModelFailure[]; message: string };

/** `model.test`: one short call through a role, for Settings' Test button and `reelix model test` (docs/api.md). */
export function modelTestOperation(router: ModelRouter): Operation<typeof TEST_INPUT, ModelTestResult> {
	return {
		name: "model.test",
		summary: "Ask a role's models one short question: the answer, the model that gave it, how long it took, and why any model failed",
		effect: "read",
		input: TEST_INPUT,
		positional: ["role"],
		async run(ctx, i) {
			const role = (i.role ?? "chat") as ModelRole;
			const start = Date.now();
			try {
				const a = await router.complete(role, "You are checking that a connection works. Reply with one short sentence.", "Say hello.", { scope: ROLE_SCOPE[role], signal: ctx.signal, timeoutS: TEST_TIMEOUT_S });
				return { ok: true, role, model: a.model, answer: a.text.trim().slice(0, 500), ms: Date.now() - start, skipped: a.skipped };
			} catch (e) {
				if (!(e instanceof ModelsUnavailable)) throw e;
				return { ok: false, role, ms: Date.now() - start, failures: e.failures, message: e.message };
			}
		},
		toText: (r) => {
			const failed = (r.ok ? r.skipped : r.failures).map((f) => `${f.model ?? "pi's default"} failed (${f.class}${f.until ? ` until ${f.until}` : ""}; do: ${f.action}): ${f.message}`);
			return [r.ok ? `${r.role}: ${r.model} answered in ${(r.ms / 1000).toFixed(1)} s: ${r.answer}` : `${r.role}: no model answered (${(r.ms / 1000).toFixed(1)} s).`, ...failed].join("\n");
		},
	};
}
