import { AsyncLocalStorage } from "node:async_hooks";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CardLayout, type HookId, type ModelAnswer, type PluginContext, type PluginJobResult, type ProposalOutcome, type SeamId, isOperationError } from "@reelix/plugin";
import { type Catalog, type DownloadRow, INSTRUCTION_TEXT_LIMIT, LANGUAGE_LABEL, MODEL_ROLES, type ModelRole, PLUGIN_EVENTS, type PluginModelState, type Reelix, ReelixError, type SpendScope, TMDB_LOCALES, TranslationPaused, addInbox, countTmdbTitles, schemaProblem, createProposal, existingSubtitles, fileMatches, freeSpace, getDownload, getInbox, getTitle, json, kvDelete, kvGet, kvSet, errorMessage as messageOf, messageFrom, ownerLanguage, proxyFor, runOperation, tr, trialCall, videosOf, wantedLanguages } from "@reelix/core";
import type { ChatBridge } from "../chat.ts";
import { CapReached, type JobContext, type JobRunner, Postpone } from "../jobs.ts";
import { pluginCheckResult } from "./checks.ts";
import { type HttpTransport, pluginFetch } from "./http.ts";
import { type Manifest, type OwnedEventDeclaration, declaredSecret } from "./manifest.ts";
import type { PiExtensions } from "./pi.ts";
import type { PluginRoutes } from "./routes.ts";
import { type Scope, ScopeClosed } from "./scope.ts";

/** The owner's models, as the kernel reaches them: the server's model router. */
export type ModelAccess = { complete(role: ModelRole, system: string, user: string, o: { scope: SpendScope; signal?: AbortSignal }): Promise<ModelAnswer> };

type ContextDeps = {
	app: Reelix;
	jobs: JobRunner;
	chat: ChatBridge;
	manifest: Manifest;
	scope: Scope;
	messages: Catalog;
	/** The plugin's settings, checked against its schema. */
	settings: unknown;
	builtIn: boolean;
	/** Where its hook handlers stand in a pipeline. */
	hookOrder: number;
	transport: HttpTransport;
	/** When this plugin last added Inbox items (kept across restarts of the plugin). */
	noticeTimes: number[];
	/** The first wait before a task that ended is started again. */
	taskDelayMs: number;
	/** A registration failed (docs/plugins.md §11.6). `timedOutSince`: it was a timeout of a call begun then. */
	onFailure: (registration: string, error: unknown, timedOutSince?: number) => void;
	/** The owner's models; absent where nothing can answer (a test without a model). */
	model?: ModelAccess;
	/** Its budget, roles and spend today (docs/plugins.md §10.2). */
	modelState: () => PluginModelState;
	routes: PluginRoutes;
	pi: PiExtensions;
	/** An event a running plugin owns, and where such events are emitted (docs/plugins.md §7.11). */
	ownedEvent: (event: string) => { plugin: string; declaration: OwnedEventDeclaration } | undefined;
	ownedEmitter: EventEmitter;
};

/**
 * Every call of `ctx`, and the manifest entry it needs (docs/plugins.md §6). The generated
 * reference is built from this list and from the type `PluginContext`; a test keeps them equal.
 */
/** Plugins that asked for their proxy (a browser they drive themselves): Settings offers the proxy for them too. */
export const readsProxy = new Set<string>();

export const CONTEXT_CALLS: Record<string, string | null> = {
	"ctx.signal": null,
	"ctx.job": "uses.jobs",
	"ctx.jobs.enqueue": null,
	"ctx.operation": "uses.operations",
	"ctx.provide": "uses.provides",
	"ctx.seams.call": "owns.seams",
	"ctx.emit": "owns.events",
	"ctx.check": null,
	"ctx.card": null,
	"ctx.propose": "uses.inbox",
	"ctx.hook": "uses.hooks",
	"ctx.task": null,
	"ctx.on": "uses.events",
	"ctx.kv.get": null,
	"ctx.kv.set": null,
	"ctx.kv.delete": null,
	"ctx.secret.get": "uses.secrets",
	"ctx.secret.set": "uses.secrets",
	"ctx.http.fetch": "uses.network",
	"ctx.agent.run": "uses.agent",
	"ctx.model.complete": "uses.model",
	"ctx.pi": "uses.pi",
	"ctx.route": null,
	"ctx.folder": null,
	"ctx.inbox.add": "uses.inbox",
	"ctx.inbox.answer": null,
	"ctx.owner.pair": null,
	"ctx.owner.of": null,
	"ctx.chat.receive": null,
	"ctx.reelix.run": "uses.runs",
	"ctx.reelix.read.titles": null,
	"ctx.reelix.read.services": null,
	"ctx.reelix.read.freeSpace": null,
	"ctx.reelix.read.title": null,
	"ctx.reelix.read.download": null,
	"ctx.reelix.read.downloads": null,
	"ctx.reelix.read.missingSubtitles": null,
	"ctx.reelix.read.preferences": null,
	"ctx.reelix.read.answer": null,
	"ctx.reelix.read.proxy": null,
	"ctx.log": null,
	"ctx.t": null,
};

/** What one activation registered, for the checker. */
export type Registered = { jobs: string[]; events: string[]; provides: string[]; hooks: string[]; operations: string[]; tools: string[]; checks: string[]; tasks: string[]; cards: string[]; routes: string[]; pi: boolean };

export const jobKind = (pluginId: string, name: string) => `${pluginId}.${name}`;
export const scheduleId = (pluginId: string, name: string) => `plugin:${pluginId}:${name}`;
const kvKey = (pluginId: string, key: string) => `plugin:${pluginId}:${key}`;

/** What one call of `ctx.model.complete` may send (docs/plugins.md §10.2). */
const MODEL_CALL_LIMIT = 100_000;
const NOTICE_LIMIT = 5;
const NOTICE_WINDOW_MS = 60 * 60_000;
/** How long a job waits when its plugin is stopping as the job starts. */
const JOB_RETRY_MS = 30_000;
const TASK_MAX_DELAY_MS = 120_000;
/** A task that ran this long was healthy: its next restart starts from the first delay again. */
const TASK_HEALTHY_MS = 60_000;

/** Only plain data crosses between Reelix and a plugin (§6). */
const plain = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

/** Wait, or stop waiting when the signal fires. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
		if (signal.aborted) done();
	});
}

function checkJobResult(r: PluginJobResult, mayPark: boolean): PluginJobResult {
	const states = mayPark ? ["succeeded", "failed", "parked"] : ["succeeded", "failed"];
	if (!states.includes(r?.state) || typeof r.summary !== "string") throw new Error(`a job must return { state: ${states.map((s) => `"${s}"`).join(" | ")}, summary: string }`);
	return { state: r.state, summary: r.summary };
}

const CARD_TITLE_LIMIT = 120;
const BUTTON_LABEL_LIMIT = 60;

/** A card declaration as data (§12.3): checked once, when it is registered. */
function checkCard(kind: string, l: CardLayout, operations: string[]): CardLayout {
	const field = (v: unknown, what: string) => {
		if (typeof v !== "string" || !v) throw new Error(`card "${kind}": ${what} must name a field of the operation's output`);
		return v;
	};
	if (typeof l?.title !== "string" || !l.title.trim() || l.title.length > CARD_TITLE_LIMIT) throw new Error(`card "${kind}": title must be 1 to ${CARD_TITLE_LIMIT} characters`);
	const buttons = (l.buttons ?? []).map((b) => {
		if (typeof b?.label !== "string" || !b.label.trim() || b.label.length > BUTTON_LABEL_LIMIT) throw new Error(`card "${kind}": a button label must be 1 to ${BUTTON_LABEL_LIMIT} characters`);
		if (!operations.includes(b.operation)) throw new Error(`card "${kind}": a button runs one of the plugin's operations; "${b.operation}" is not in uses.operations`);
		if (b.input !== undefined && (typeof b.input !== "object" || b.input === null || Array.isArray(b.input))) throw new Error(`card "${kind}": a button's input must be an object`);
		return { label: b.label, operation: b.operation, input: b.input };
	});
	if (l.layout === "text") return { layout: "text", title: l.title, text: field(l.text, "text"), buttons };
	if (l.layout !== "list") throw new Error(`card "${kind}": layout must be "list" or "text"`);
	return { layout: "list", title: l.title, items: field(l.items, "items"), primary: field(l.primary, "primary"), secondary: l.secondary === undefined ? undefined : field(l.secondary, "secondary"), empty: typeof l.empty === "string" ? l.empty : undefined, buttons };
}

/** The `ctx` a plugin receives: the only way it touches Reelix (§6). */
export function createContext(d: ContextDeps): { ctx: PluginContext; registered: Registered } {
	const { app, jobs, manifest, scope } = d;
	const { id, uses } = manifest;
	const refuse = (what: string, key: string) => new Error(`${what} is not declared in reelix.uses.${key} of package.json`);
	/** Settled when the plugin's model calls so far have ended (docs/plugins.md §10.2). */
	let modelTurn: Promise<unknown> = Promise.resolve();
	const registered: Registered = { jobs: [], events: [], provides: [], hooks: [], operations: [], tools: [], checks: [], tasks: [], cards: [], routes: [], pi: false };
	const currentJob = new AsyncLocalStorage<JobContext>();

	/** Run a registered handler: failures are counted, except a refusal and those caused by the plugin stopping or the day's spending cap. */
	const guarded = async <T>(registration: string, fn: () => T | Promise<T>): Promise<T> => {
		try {
			return await scope.track(fn);
		} catch (e) {
			if (isOperationError(e)) throw new ReelixError(e.code, e.message);
			if (!(e instanceof ScopeClosed) && !(e instanceof CapReached)) d.onFailure(registration, e);
			throw e;
		}
	};

	const owner = {
		plugin: id,
		builtIn: d.builtIn,
		order: d.hookOrder,
		track: <T>(fn: () => Promise<T>) => scope.track(fn),
		isOpen: () => scope.open,
		signal: scope.signal,
		onFailure: (registration: string, f: { error: unknown; timedOutSince?: number }) => d.onFailure(registration, f.error, f.timedOutSince),
	};

	const ctx: PluginContext = {
		signal: scope.signal,
		async job({ name, run, every }) {
			scope.assertOpen();
			if (!uses.jobs.includes(name)) throw refuse(`job "${name}"`, "jobs");
			if (registered.jobs.includes(name)) throw new Error(`job "${name}" is already registered`);
			if (every !== undefined && !/^[1-9]\d*m$/.test(every)) throw new Error(`job "${name}": every must be a number of minutes such as "60m"`);
			const kind = jobKind(id, name);
			jobs.register(kind, async (job) => {
				if (!scope.open) throw new Postpone(`the plugin ${id} is restarting`, new Date(Date.now() + JOB_RETRY_MS));
				return currentJob.run(job, () =>
					guarded(`job ${name}`, async () => {
						const payload = plain(job.payload) as Record<string, unknown>;
						delete payload.dedupe;
						return checkJobResult(plain(await run({ id: job.run.id, payload })), uses.agent);
					}),
				);
			});
			registered.jobs.push(name);
			scope.add(() => {
				jobs.unregister(kind);
				registered.jobs.splice(registered.jobs.indexOf(name), 1);
			});
			// The schedule outlives a restart of the plugin; switching the plugin off removes it.
			if (every) jobs.schedule(scheduleId(id, name), kind, `every ${every}`);
			else jobs.unschedule(scheduleId(id, name));
		},
		jobs: {
			async enqueue(name, payload, options) {
				scope.assertOpen();
				if (!registered.jobs.includes(name)) throw new Error(`job "${name}" is not registered by this plugin`);
				return jobs.enqueue(jobKind(id, name), plain(payload), { dedupe: options?.dedupe === undefined ? undefined : `${id}:${options.dedupe}` });
			},
		},
		async operation({ name, summary, effect, agentMay, input, run, toText, recordInput, recordOutput, tool, preview, card }) {
			scope.assertOpen();
			if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`operation "${name}": give the short name; the full name is always ${id}.<name>`);
			if (!uses.operations.includes(name)) throw refuse(`operation "${name}"`, "operations");
			// The install screen showed the declared effect; the code may not claim another (§6.1).
			if (uses.effects[name] !== effect) throw new Error(`operation "${name}": its effect is "${effect}" but the manifest declares "${uses.effects[name]}"`);
			if (agentMay && effect !== "admin") throw new Error(`operation "${name}": agentMay is only for admin operations`);
			if (summary.length > INSTRUCTION_TEXT_LIMIT) throw new Error(`operation "${name}": the summary is longer than ${INSTRUCTION_TEXT_LIMIT} characters`);
			// A typed tool (§6.1): declared, and at most three per plugin (the manifest is checked for that).
			if (tool && !uses.tools.includes(name)) throw refuse(`typed tool "${name}"`, "tools");
			if (card !== undefined && !registered.cards.includes(card)) throw new Error(`operation "${name}": register the card "${card}" with ctx.card first`);
			scope.add(
				app.operations.add({
					name: `${id}.${name}`,
					plugin: id,
					summary,
					effect,
					agentMay: agentMay || undefined,
					input,
					tool: tool ? `${id}_${name}` : undefined,
					card: card === undefined ? undefined : `${id}.${card}`,
					preview: preview && ((_op, i) => guarded(`preview ${name}`, async () => plain(await preview(plain(i) as never)))),
					run: (op, i) => guarded(`operation ${name}`, async () => plain(await run(plain(i) as never, { actor: op.actor, request: op.request }))),
					toText,
					recordInput: recordInput as ((i: unknown) => unknown) | undefined,
					recordOutput,
				}),
			);
			registered.operations.push(name);
			if (tool) registered.tools.push(name);
		},
		async provide(seam, provider) {
			scope.assertOpen();
			if (!uses.provides.includes(seam)) throw refuse(`seam "${seam}"`, "provides");
			scope.add(app.seams.register(seam as SeamId, provider as never, owner));
			registered.provides.push(seam);
		},
		seams: {
			async call(seam, method, args) {
				scope.assertNotClosed();
				if (!Object.hasOwn(manifest.owns.seams, seam)) throw new Error(`${id} does not own the seam "${seam}"; declare it in reelix.owns.seams of package.json`);
				return plain(await app.seams.callOwned(seam, id, method, plain(args), scope.signal)) as never;
			},
		},
		async emit(event, payload) {
			scope.assertNotClosed();
			const declared = manifest.owns.events[event];
			if (!declared) throw new Error(`${id} does not own the event "${event}"; declare it in reelix.owns.events of package.json`);
			const value = plain(payload);
			const problem = schemaProblem(declared.payload, value);
			if (problem) throw new Error(`event "${event}": the payload does not fit its declared schema: ${problem}`);
			if (trialCall.getStore() === id) return; // emitted from inside a hook in trial: nothing happened
			d.ownedEmitter.emit(event, value);
		},
		async hook<H extends HookId>(name: H, handler: Parameters<PluginContext["hook"]>[1]) {
			scope.assertOpen();
			if (!uses.hooks.includes(name)) throw refuse(`hook "${name}"`, "hooks");
			scope.add(app.hooks.register(name, handler as never, owner));
			registered.hooks.push(name);
		},
		async task(name, run) {
			scope.assertOpen();
			if (registered.tasks.includes(name)) throw new Error(`task "${name}" is already registered`);
			registered.tasks.push(name);
			const supervise = async () => {
				let delay = d.taskDelayMs;
				while (scope.open) {
					const startedAt = Date.now();
					await guarded(`task ${name}`, () => run({ signal: scope.signal })).catch((e: unknown) => {
						if (scope.open) console.warn(`Plugin ${id}: task ${name}: ${app.redact(messageOf(e))}`);
					});
					if (Date.now() - startedAt >= TASK_HEALTHY_MS) delay = d.taskDelayMs;
					await pause(delay, scope.signal);
					delay = Math.min(delay * 2, TASK_MAX_DELAY_MS);
				}
			};
			setImmediate(() => void supervise()); // after `activate` has finished
		},
		async card(kind, layout) {
			scope.assertOpen();
			if (!/^[a-z][a-z0-9_-]*$/.test(kind)) throw new Error(`card "${kind}": use lowercase letters, digits, - and _; the full kind is always ${id}.<kind>`);
			if (registered.cards.includes(kind)) throw new Error(`card "${kind}" is already registered`);
			const declared = checkCard(kind, plain(layout), uses.operations);
			app.cards.set(`${id}.${kind}`, { ...declared, plugin: id });
			registered.cards.push(kind);
			scope.add(() => void app.cards.delete(`${id}.${kind}`));
		},
		async propose(proposal) {
			scope.assertNotClosed();
			if (!uses.inbox) throw new Error("proposals are not declared: set reelix.uses.inbox to true in package.json");
			// Made inside a hook in trial: never shown (§8).
			if (trialCall.getStore() === id) {
				console.warn(`Plugin ${id}: a proposal made in trial was dropped`);
				return { id: "", status: "dropped", steps: [] };
			}
			const made = await createProposal(app, id, uses.runs, plain(proposal));
			return new Promise<ProposalOutcome>((resolve) => {
				const done = () => app.events.off("event", listen);
				const listen = (e: { type?: string; id?: string; outcome?: ProposalOutcome }) => {
					if (e.type !== "proposal" || e.id !== made.id || !e.outcome) return;
					done();
					resolve(plain(e.outcome));
				};
				app.events.on("event", listen);
				// The plugin stopped: nobody is left to tell. The proposal itself stays.
				scope.signal.addEventListener("abort", done, { once: true });
			});
		},
		async check(name, run) {
			scope.assertOpen();
			if (app.checks.has(name)) throw new Error(`there is already a Doctor check named "${name}"`);
			const shape = { plugin: id, messages: d.messages, operations: uses.operations };
			app.checks.set(name, { plugin: id, run: (o) => guarded(`check ${name}`, async () => pluginCheckResult({ ...shape, language: ownerLanguage(app) }, plain(await run(o)))) });
			registered.checks.push(name);
			scope.add(() => {
				app.checks.delete(name);
				app.lastChecks.delete(id);
			});
		},
		async on(event: string, fn: (payload: never) => void | Promise<void>) {
			scope.assertOpen();
			const core = PLUGIN_EVENTS.includes(event);
			if (!core && !d.ownedEvent(event)) throw new Error(`there is no event "${event}"${event.includes(":") ? `; its owner ${event.split(":")[0]} does not declare it, or is not running` : ""}`);
			if (!uses.events.includes(event)) throw refuse(`event "${event}"`, "events");
			// A listener cannot delay Reelix or the plugin that emits, and its errors stay here (§9).
			const listener = (payload: unknown) => {
				setImmediate(() => {
					if (scope.open) guarded(`event ${event}`, () => fn(plain(payload) as never)).catch(() => undefined);
				});
			};
			const events = (core ? app.pluginEvents : d.ownedEmitter) as unknown as { on(e: string, l: unknown): void; off(e: string, l: unknown): void };
			events.on(event, listener);
			registered.events.push(event);
			scope.add(() => events.off(event, listener));
		},
		kv: {
			async get<T>(key: string) {
				scope.assertNotClosed();
				const raw = kvGet(app.db, kvKey(id, key));
				return raw === undefined ? undefined : (JSON.parse(raw) as T);
			},
			async set(key, value) {
				scope.assertNotClosed();
				kvSet(app.db, kvKey(id, key), JSON.stringify(value));
			},
			async delete(key) {
				scope.assertNotClosed();
				kvDelete(app.db, kvKey(id, key));
			},
		},
		secret: {
			async get(name) {
				scope.assertNotClosed();
				if (!declaredSecret(uses.secrets, name)) throw refuse(`secret "${name}"`, "secrets");
				return app.secrets[`plugins.${id}.${name}`];
			},
			async set(name, value) {
				scope.assertNotClosed();
				if (!declaredSecret(uses.secrets, name)) throw refuse(`secret "${name}"`, "secrets");
				app.setSecret(`plugins.${id}.${name}`, value, id);
			},
		},
		http: {
			fetch: (() => {
				const fetch = pluginFetch(app, manifest, d.settings, d.transport);
				return async (url, init) => {
					scope.assertNotClosed();
					return fetch(url, init);
				};
			})(),
		},
		agent: {
			async run({ prompt, title }) {
				scope.assertNotClosed();
				if (!uses.agent) throw new Error("background agent turns are not declared: set reelix.uses.agent to true in package.json");
				const job = currentJob.getStore();
				if (!job) throw new Error("ctx.agent.run works only inside one of this plugin's jobs");
				return plain(await job.agent(prompt, title));
			},
		},
		model: {
			async complete(request) {
				scope.assertNotClosed();
				if (!uses.model) throw new Error("the owner's models are not declared: set reelix.uses.model in package.json");
				const { role = "background", system, user, signal } = request ?? ({} as never);
				if (!MODEL_ROLES.includes(role as ModelRole)) throw new Error(`there is no model role "${role}"; the roles are ${MODEL_ROLES.join(", ")}`);
				if (typeof system !== "string" || typeof user !== "string") throw new Error("system and user must be text");
				if (system.length + user.length > MODEL_CALL_LIMIT) throw new Error(`a model call is at most ${MODEL_CALL_LIMIT} characters of system and user together; this one has ${system.length + user.length}`);
				const stop = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal;
				// One call at a time: each is checked against the budget after the one before has recorded what it spent.
				const before = modelTurn;
				let done!: () => void;
				const mine = new Promise<void>((resolve) => (done = resolve));
				modelTurn = before.then(() => mine);
				try {
					await new Promise<void>((resolve, reject) => {
						const aborted = () => reject(stop.reason);
						if (stop.aborted) return aborted();
						stop.addEventListener("abort", aborted, { once: true });
						void before.then(() => {
							stop.removeEventListener("abort", aborted);
							resolve();
						});
					});
					const state = d.modelState();
					if (!state.roles.includes(role as ModelRole)) return { outcome: "unavailable", message: tr(app, "plugins.roleRefused", { id, role }) };
					if (state.reached) return { outcome: "unavailable", message: tr(app, "plugins.budgetReached", { id, usd: state.budgetUsd }) };
					if (!d.model) return { outcome: "unavailable", message: "The model runtime is not available." };
					const { text, model } = await d.model.complete(role as ModelRole, system, user, { scope: `plugin:${id}`, signal: stop });
					return { text, model };
				} catch (e) {
					// No model could answer for now: an expected answer, not a broken plugin.
					if (e instanceof TranslationPaused) return { outcome: "unavailable", message: app.redact(e.message) };
					throw e;
				} finally {
					done();
				}
			},
		},
		async pi(extension) {
			scope.assertOpen();
			if (!uses.pi) throw new Error("a raw pi extension is not declared: set reelix.uses.pi to true in package.json");
			if (typeof extension !== "function") throw new Error("ctx.pi takes the extension: (pi, session) => void");
			if (registered.pi) throw new Error("a plugin has one pi extension");
			scope.add(
				d.pi.add({
					plugin: id,
					extension,
					isOpen: () => scope.open,
					track: (fn) => scope.track(fn),
					onFailure: (e) => {
						console.warn(`Plugin ${id}: pi extension: ${app.redact(messageOf(e))}`);
						d.onFailure("pi extension", e);
					},
				}),
			);
			registered.pi = true;
		},
		async route(method, path, handler) {
			scope.assertOpen();
			const name = `${method} ${path}`;
			scope.add(
				d.routes.add({
					plugin: id,
					method,
					path,
					handler: (request) => guarded(`route ${name}`, async () => handler(request)),
					onFailure: (e) => d.onFailure(`route ${name}`, e),
				}),
			);
			registered.routes.push(name);
		},
		async folder() {
			scope.assertNotClosed();
			const dir = join(app.paths.pluginData, id);
			// Closed to other users: a plugin in its own process finds it already opened to its group (docs/plugins.md §11.3).
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			return dir;
		},
		inbox: {
			async add({ title, body, key }) {
				scope.assertNotClosed();
				if (!uses.inbox) throw new Error("Inbox items are not declared: set reelix.uses.inbox to true in package.json");
				if (trialCall.getStore() === id) return { added: false };
				const now = Date.now();
				const recent = d.noticeTimes.filter((t) => t > now - NOTICE_WINDOW_MS);
				if (recent.length >= NOTICE_LIMIT) {
					d.noticeTimes.splice(0, d.noticeTimes.length, ...recent);
					console.warn(`Plugin ${id}: too many Inbox notices; dropped "${app.redact(title)}"`);
					return { added: false };
				}
				d.noticeTimes.splice(0, d.noticeTimes.length, ...recent, now);
				addInbox(app, { kind: "notice", title: app.redact(title), body, source: `plugin:${id}`, dedupeKey: key === undefined ? undefined : `plugin:${id}:${key}` });
				return { added: true };
			},
			async answer(inboxId, answer) {
				scope.assertNotClosed();
				return d.chat.answerInbox(id, inboxId, plain(answer));
			},
		},
		owner: {
			async pair() {
				scope.assertNotClosed();
				return d.chat.pair(id);
			},
			async of(channel) {
				scope.assertNotClosed();
				return d.chat.ownerOf(id, channel);
			},
		},
		chat: {
			async receive(message) {
				scope.assertNotClosed();
				return d.chat.receive(id, structuredClone(message));
			},
		},
		reelix: {
			async run<T>(operation: string, input: Record<string, unknown>) {
				scope.assertNotClosed();
				if (!uses.runs.includes(operation)) throw refuse(`operation "${operation}"`, "runs");
				const r = await runOperation(app, operation, plain(input), { actor: `plugin:${id}` });
				return plain(r.output) as T;
			},
			read: {
				async titles() {
					scope.assertNotClosed();
					return { withTmdb: countTmdbTitles(app) };
				},
				async services() {
					scope.assertNotClosed();
					return { metadataLocale: TMDB_LOCALES[ownerLanguage(app)], tmdbKey: !!app.secrets["tmdb.api_key"] };
				},
				async freeSpace() {
					scope.assertNotClosed();
					return { bytes: freeSpace(app) };
				},
				async title(titleId) {
					scope.assertNotClosed();
					const t = getTitle(app, titleId);
					return t && { id: t.id, name: t.name, series: t.kind === "tv" };
				},
				async download(hash) {
					scope.assertNotClosed();
					const row = getDownload(app, hash);
					if (!row) return undefined;
					const seasons = [...new Set(json<{ season: number }[]>(row.episodes_json, []).map((e) => e.season))];
					return { name: row.name, titleId: row.title_id ?? undefined, seasons };
				},
				async downloads() {
					scope.assertNotClosed();
					const rows = app.db.prepare("SELECT * FROM downloads WHERE state NOT IN ('removed', 'gone') ORDER BY added_at").all() as DownloadRow[];
					return rows.map((r) => ({ hash: r.hash, name: r.name, titleId: r.title_id ?? undefined, state: r.state, sizeBytes: r.size ?? undefined, addedAt: r.added_at, completedAt: r.completed_at ?? undefined, filedAt: r.filed_at ?? undefined }));
				},
				async missingSubtitles(titleId, seasons) {
					scope.assertNotClosed();
					// Only the first wanted language counts as "has subtitles".
					const wanted = wantedLanguages(app);
					const first = wanted.slice(0, 1);
					const missing: string[] = [];
					for (const season of seasons.length ? seasons : [undefined]) {
						for (const h of await existingSubtitles(videosOf(app, titleId, season), first)) if (!h.embeddedWanted.length && !h.external.some((n) => fileMatches(n, first))) missing.push(h.video);
					}
					return { wanted: wanted.map((code) => ({ code, label: LANGUAGE_LABEL[code] })), missing };
				},
				async preferences() {
					scope.assertNotClosed();
					const file = join(app.paths.notes, "preferences.md");
					return existsSync(file) ? readFileSync(file, "utf8") : "";
				},
				async answer(inboxId) {
					scope.assertNotClosed();
					const it = getInbox(app, inboxId);
					return it && { status: it.status as "open" | "answered" | "dismissed", answer: it.answer ?? undefined };
				},
				async proxy() {
					scope.assertNotClosed();
					readsProxy.add(id);
					return { url: proxyFor(app.config, id) };
				},
			},
		},
		log(message) {
			console.log(`[plugin ${id}] ${app.redact(message)}`);
		},
		t(key, vars) {
			return messageFrom(d.messages, ownerLanguage(app), key, vars) ?? key;
		},
	};
	return { ctx, registered };
}
