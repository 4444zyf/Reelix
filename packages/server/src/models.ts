import { type ModelAnswer, type ModelRole, type Reelix, type SpendScope, TranslationPaused, errorMessage, recordSpend, roleModels } from "@reelix/core";

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

/**
 * Which model does a piece of work use (docs/models.md)? Each role has an ordered list; a call
 * that fails before answering goes to the next model, and a model that just failed is skipped for
 * a while. Smarter routing, quotas and budgets belong to magpie, which is just another provider.
 */
export class ModelRouter {
	app: Reelix;
	private runtime: () => RuntimeLike | undefined;
	private resting = new Map<string, { until: number; strikes: number; why: string }>();
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

	/** A model failed: skip it for a minute, doubling up to half an hour while it keeps failing. */
	rest(spec: string, why: string): void {
		const strikes = (this.resting.get(spec)?.strikes ?? 0) + 1;
		this.resting.set(spec, { until: Date.now() + Math.min(REST_MAX_MS, REST_START_MS * 2 ** (strikes - 1)), strikes, why });
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
	 * One question, one answer, no tools. Tries the role's models in order; what it costs is recorded under
	 * `scope` (src/spend.ts in core). When none can answer, throws TranslationPaused so the caller waits and
	 * tries again instead of failing.
	 */
	async complete(role: ModelRole, system: string, user: string, o: { scope: SpendScope; signal?: AbortSignal }): Promise<ModelAnswer> {
		const signal = o.signal;
		const rt = this.runtime();
		if (!rt) throw new TranslationPaused("The model runtime is not available.");
		let candidates = this.specs(role).map((spec) => ({ spec, model: this.resolve(spec) }));
		if (!candidates.length) {
			const d = rt.getAvailableSnapshot?.()[0];
			if (!d) throw new TranslationPaused(`No model is set for "${role}" and pi has no default. Set one under Settings → Models.`);
			candidates = [{ spec: `${d.provider}/${d.id}`, model: d }];
		}
		const errors: string[] = [];
		// Models that are not resting first; resting ones are still tried last rather than giving up.
		const ordered = [...candidates.filter((c) => !this.isResting(c.spec)), ...candidates.filter((c) => this.isResting(c.spec))];
		for (const c of ordered) {
			if (signal?.aborted) throw new Error("aborted");
			if (!c.model) {
				errors.push(`${c.spec}: not known to pi`);
				continue;
			}
			// A model that keeps thinking must not hold the job forever.
			const limitS = this.app.config.translation.call_timeout_s;
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
				return { text, model: c.spec };
			} catch (e) {
				if (signal?.aborted) throw new Error("aborted");
				const why = timer.aborted ? `no answer within ${limitS} s (a reasoning model may need its thinking switched off for this role)` : this.app.redact(errorMessage(e)).slice(0, 300);
				errors.push(`${c.spec}: ${why}`);
				this.rest(c.spec, why);
			} finally {
				if (--a.count <= 0) this.active.delete(c.spec);
			}
		}
		throw new TranslationPaused(`No model for "${role}" could answer. ${errors.join("; ")}`);
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
			if (!res.ok) throw new Error(`the gateway answered ${res.status}${res.status === 401 || res.status === 403 ? " (it wants a gateway key: add magpie.api_key under Settings → Secrets)" : ""}`);
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

	/** For Settings and `reelix site status`. */
	describe(): { roles: Record<string, { own: string[]; uses: string[]; resting: string[] }>; magpie: ModelRouter["magpie"] } {
		const roles: Record<string, { own: string[]; uses: string[]; resting: string[] }> = {};
		for (const r of ["chat", "background", "glossary", "translate", "review"] as const) {
			const uses = this.specs(r);
			roles[r] = { own: this.app.config.models.roles[r], uses, resting: uses.filter((s) => this.isResting(s)) };
		}
		return { roles, magpie: this.magpie };
	}
}
