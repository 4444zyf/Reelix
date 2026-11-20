import { AsyncLocalStorage } from "node:async_hooks";
import { extname } from "node:path";
import type { HookId, PluginHooks } from "@reelix/plugin";
import type { Reelix } from "./app.ts";
import { json, kvGet, kvSet } from "./db.ts";
import { tr } from "./i18n.ts";
import { addInbox } from "./inbox.ts";
import { libraryPathProblem } from "./naming.ts";
import type { ProviderOwner } from "./seams.ts";
import { ReelixError, errorMessage, nowIso } from "./util.ts";

/**
 * Hooks, the steps where plugins take part in a decision (docs/plugins.md §8). Every handler is
 * called once per list and has 10 seconds; a result outside the hook's limits is dropped and
 * counted as a failure of that registration.
 */
const HANDLER_LIMIT_MS = 10_000;
const REASON_LIMIT = 200;
const NOTE_LIMIT = 200;
const PROMPT_TEXT_LIMIT = 1_500;
const PROMPT_TITLE_LIMIT = 80;
const NOTICE_TITLE_LIMIT = 200;
const NOTICE_BODY_LIMIT = 4_000;
const NOTICE_IMAGE_LIMIT = 5_000_000;
/** A guard is reported when it hides more than this share over this many calls (§8). */
const GUARD_ALARM_SHARE = 0.9;
const GUARD_ALARM_CALLS = 20;

/** Trial results are kept this long (§8). */
const TRIAL_KEPT_DAYS = 30;
const ORDER_KEY = "hooks.order";
const TRIAL_KEY = "plugins.trial";

type HookMode = "guard" | "pipeline" | "collect";

/** What a handler in trial would have done. */
type TrialEffect = { hidden?: number; firstChanged?: boolean; changed?: number };

type HookSpec<H extends HookId> = {
	mode: HookMode;
	summary: string;
	limits: string[];
	check(item: PluginHooks[H]["item"], input: PluginHooks[H]["input"]): string | undefined;
	/** In trial: what the valid result would have changed. A hook without it is not run in trial. */
	trial?(item: PluginHooks[H]["item"], input: PluginHooks[H]["input"]): TrialEffect;
};

const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const reasonProblem = (r: unknown) => (text(r) && r.length <= REASON_LIMIT ? undefined : `reason must be 1 to ${REASON_LIMIT} characters`);
const firstOf = <T>(items: T[], check: (i: T) => string | undefined) => {
	for (const i of items) {
		const p = check(i);
		if (p) return p;
	}
	return undefined;
};

const HOOKS: { [H in HookId]: HookSpec<H> } = {
	"agent.prompt@1": {
		mode: "collect",
		summary: "Add a section to the prompt of a conversation, before Reelix's own rules. Background jobs get it only when the owner allows it for that plugin.",
		limits: [`title: one line of at most ${PROMPT_TITLE_LIMIT} characters`, `text: at most ${PROMPT_TEXT_LIMIT} characters`],
		check(item) {
			if (typeof item?.title !== "string" || !item.title.trim() || item.title.length > PROMPT_TITLE_LIMIT || /[\r\n]/.test(item.title)) return `title must be one line of at most ${PROMPT_TITLE_LIMIT} characters`;
			if (typeof item.text !== "string" || !item.text.trim()) return "text must not be empty";
			return item.text.length > PROMPT_TEXT_LIMIT ? `text is longer than ${PROMPT_TEXT_LIMIT} characters` : undefined;
		},
	},
	"release.filter@1": {
		mode: "guard",
		summary: "Hide releases from a search. They stay in the result, marked with the plugin and its reason, and download.add refuses them unless the owner decides otherwise.",
		limits: ["every ref is one of the releases received", `reason: 1 to ${REASON_LIMIT} characters`],
		check(item, input) {
			if (!Array.isArray(item)) return "it must return a list of { ref, reason }";
			const refs = new Set(input.releases.map((r) => r.ref));
			return firstOf(item, (h) => (!refs.has(h?.ref) ? `there is no release "${h?.ref}"` : reasonProblem(h.reason)));
		},
		trial: (item) => ({ hidden: new Set(item.map((h) => h.ref)).size }),
	},
	"release.rank@1": {
		mode: "pipeline",
		summary: "Set the order of the releases that are not hidden, with optional notes shown as facts. It cannot add or remove releases, and does not apply when the list is sorted by size or date.",
		limits: ["order: every ref received, each exactly once", `notes: at most ${NOTE_LIMIT} characters each, for refs received`, `reason: 1 to ${REASON_LIMIT} characters`],
		check(item, input) {
			const refs = input.releases.map((r) => r.ref);
			if (!Array.isArray(item?.order) || item.order.length !== refs.length || new Set(item.order).size !== refs.length || item.order.some((r) => !refs.includes(r))) return "order must hold every release received, each exactly once";
			const notes = item.notes ?? [];
			if (!Array.isArray(notes)) return "notes must be a list of { ref, note }";
			return firstOf(notes, (n) => (!refs.includes(n?.ref) ? `there is no release "${n?.ref}"` : text(n.note) && n.note.length <= NOTE_LIMIT ? undefined : `a note must be 1 to ${NOTE_LIMIT} characters`)) ?? reasonProblem(item.reason);
		},
		trial: (item, input) => ({ firstChanged: item.order[0] !== input.releases[0]?.ref, changed: item.order.some((ref, i) => ref !== input.releases[i]?.ref) ? 1 : 0 }),
	},
	"organise.name@1": {
		mode: "pipeline",
		summary: "Change where the files of a plan Reelix made will go, after the plan is made and before it is applied. Plans the agent writes are not passed through it.",
		limits: ["inside the library", "the title folder stays as it is, with its [tmdbid-N] tag", "same folder depth", "same extension", "legal file names, no two items on one path", `reason: 1 to ${REASON_LIMIT} characters`],
		check(item, input) {
			if (!Array.isArray(item?.items)) return "it must return { items, reason }";
			const before = new Map(input.items.map((i) => [i.source, i.path]));
			const after = new Map(before);
			for (const change of item.items) {
				const old = before.get(change?.source);
				if (old === undefined) return `there is no item "${change?.source}"`;
				if (typeof change.path !== "string") return "every path must be a string";
				const problem = libraryPathProblem(change.path, { titleFolders: [old.split("/")[0]!], depths: [old.split("/").length], extension: extname(old) });
				if (problem) return `${change.path}: ${problem}`;
				after.set(change.source, change.path);
			}
			return new Set(after.values()).size === after.size ? reasonProblem(item.reason) : "two items would land on the same path";
		},
		trial: (item, input) => ({ changed: item.items.filter((c) => input.items.find((i) => i.source === c.source)?.path !== c.path).length }),
	},
	"notify.before@1": {
		mode: "pipeline",
		summary: "Change the wording or picture of a notice on its way to the owner's devices. It cannot suppress a notice or change its path, answers or kind; the notice then says who edited it. Questions asking for an approval are not passed through it.",
		limits: [`title: 1 to ${NOTICE_TITLE_LIMIT} characters`, `body: 1 to ${NOTICE_BODY_LIMIT} characters`, `image: at most ${NOTICE_IMAGE_LIMIT} bytes`, "no other fields", `reason: 1 to ${REASON_LIMIT} characters`],
		check(item) {
			const extra = Object.keys(item ?? {}).find((k) => !["title", "body", "image", "reason"].includes(k));
			if (extra) return `it may not change "${extra}"`;
			if (item.title !== undefined && (!text(item.title) || item.title.length > NOTICE_TITLE_LIMIT)) return `title must be 1 to ${NOTICE_TITLE_LIMIT} characters`;
			if (item.body !== undefined && (!text(item.body) || item.body.length > NOTICE_BODY_LIMIT)) return `body must be 1 to ${NOTICE_BODY_LIMIT} characters`;
			if (item.image !== undefined && (!(item.image instanceof Uint8Array) || item.image.length > NOTICE_IMAGE_LIMIT)) return `image must be bytes, at most ${NOTICE_IMAGE_LIMIT}`;
			return reasonProblem(item.reason);
		},
		trial: () => ({ changed: 1 }),
	},
	"download.before@1": {
		mode: "guard",
		summary: "Refuse a download, with a reason, after Reelix's own checks and before the transfer starts. A magnet's files are known only once the downloader has loaded it; a refusal then removes it again.",
		limits: [`reason: 1 to ${REASON_LIMIT} characters`],
		check: (item) => reasonProblem(item?.reason),
	},
	"subtitle.pick@1": {
		mode: "pipeline",
		summary: "Change the scores of the subtitle files in a downloaded archive, before Reelix picks the best for each video. It cannot add or remove files. Choosing which subtitle to download stays with the agent.",
		limits: ["every name is one of the files received", "score: a finite number", `reason: 1 to ${REASON_LIMIT} characters`],
		check(item, input) {
			if (!Array.isArray(item?.files)) return "it must return { files, reason }";
			const names = new Set(input.files.map((f) => f.name));
			return firstOf(item.files, (f) => (!names.has(f?.name) ? `there is no file "${f?.name}"` : Number.isFinite(f.score) ? undefined : `${f.name}: score must be a finite number`)) ?? reasonProblem(item.reason);
		},
		trial: (item, input) => ({ changed: item.files.filter((c) => input.files.find((f) => f.name === c.name)?.score !== c.score).length }),
	},
	"agent.tool@1": {
		mode: "guard",
		summary: "Block a tool call of the agent, with a reason the agent is told. It cannot change the input or the result, and it does not see the commands the agent runs in its shell. Reelix removes secrets from the reason after it. Not run in trial.",
		limits: [`reason: 1 to ${REASON_LIMIT} characters`],
		check: (item) => reasonProblem(item?.reason),
	},
};

export const HOOK_IDS = Object.keys(HOOKS) as HookId[];

/** What the generated reference says about each hook (§14.1). */
export const HOOK_DECLARATIONS = HOOK_IDS.map((id) => ({ id, mode: HOOKS[id].mode, summary: HOOKS[id].summary, limits: HOOKS[id].limits, limitMs: HANDLER_LIMIT_MS }));

type Handler = { owner: ProviderOwner; run(input: unknown): unknown };
type HookResult<H extends HookId> = { plugin: string; item: PluginHooks[H]["item"] };

/** Set while a handler runs in trial: what it adds to the Inbox or proposes is dropped (§8). Holds the plugin's id. */
export const trialCall = new AsyncLocalStorage<string>();

/** The plugins whose hooks run in trial. */
export const trialPlugins = (app: Reelix): string[] => json<string[]>(kvGet(app.db, TRIAL_KEY), []);

/** Switch trial on or off for a plugin; switching it on starts a new record. */
export function setTrial(app: Reelix, plugin: string, on: boolean): void {
	const rest = trialPlugins(app).filter((p) => p !== plugin);
	kvSet(app.db, TRIAL_KEY, JSON.stringify(on ? [...rest, plugin] : rest));
	if (on) app.db.prepare("DELETE FROM trial_results WHERE plugin = ?").run(plugin);
}

/** The owner's order of plugins per hook (§8). */
const ownerHookOrder = (app: Reelix): Partial<Record<HookId, string[]>> => json(kvGet(app.db, ORDER_KEY), {});

export function setHookOrder(app: Reelix, hook: HookId, plugins: string[]): void {
	if (!HOOKS[hook]) throw new ReelixError("invalid_input", `There is no hook "${hook}".`);
	kvSet(app.db, ORDER_KEY, JSON.stringify({ ...ownerHookOrder(app), [hook]: [...new Set(plugins)] }));
}

export type TrialSummary = { calls: number; hidden: number; firstChanged: number; changed: number; since?: string };

/** What a plugin's hooks in trial would have done, over the kept results. */
export function trialSummary(app: Reelix, plugin: string): TrialSummary {
	const r = app.db.prepare("SELECT COUNT(*) calls, COALESCE(SUM(hidden), 0) hidden, COALESCE(SUM(first_changed), 0) first, COALESCE(SUM(changed), 0) changed, MIN(at) since FROM trial_results WHERE plugin = ? AND at > ?").get(plugin, keptSince()) as { calls: number; hidden: number; first: number; changed: number; since: string | null };
	return { calls: r.calls, hidden: r.hidden, firstChanged: r.first, changed: r.changed, since: r.since ?? undefined };
}

const keptSince = () => new Date(Date.now() - TRIAL_KEPT_DAYS * 86_400_000).toISOString();

export class HookHub {
	/** Replaces the handler time limit (tests of what happens at the limit). */
	limitMs?: number;
	private handlers = new Map<HookId, Handler[]>();
	private guardCalls = new Map<string, { seen: number; hidden: number }[]>();
	private app: Reelix;

	constructor(app: Reelix) {
		this.app = app;
	}

	/** Add a handler; returns the step that removes it. A plugin has one per hook. */
	register<H extends HookId>(name: H, run: (input: PluginHooks[H]["input"]) => unknown, owner: ProviderOwner): () => void {
		if (!HOOKS[name]) throw new Error(`there is no hook "${name}"`);
		const list = this.handlers.get(name) ?? [];
		if (list.some((h) => h.owner.plugin === owner.plugin)) throw new Error(`hook "${name}" is already registered by this plugin`);
		const handler: Handler = { owner, run: run as Handler["run"] };
		this.handlers.set(name, [...list, handler]);
		return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((h) => h !== handler));
	}

	/** The owner's order where they set one; otherwise built-in plugins first, then order of installation (§8). */
	private ordered(name: HookId): Handler[] {
		const chosen = ownerHookOrder(this.app)[name] ?? [];
		const place = (h: Handler) => {
			const i = chosen.indexOf(h.owner.plugin);
			return i < 0 ? chosen.length : i;
		};
		return [...(this.handlers.get(name) ?? [])].sort((a, b) => place(a) - place(b) || a.owner.order - b.owner.order);
	}

	/** The plugins whose decisions in a hook apply, in order. Plugins in trial are not among them. */
	plugins(name: HookId): string[] {
		const trial = trialPlugins(this.app);
		return this.ordered(name).map((h) => h.owner.plugin).filter((p) => !trial.includes(p));
	}

	/** Every plugin taking part in a hook, in order, with whether it is in trial. */
	participants(name: HookId): { plugin: string; trial: boolean }[] {
		const trial = trialPlugins(this.app);
		return this.ordered(name).map((h) => ({ plugin: h.owner.plugin, trial: trial.includes(h.owner.plugin) }));
	}

	/** Whether anything takes part, applied or in trial: whether the step should call the hook at all. */
	has(name: HookId): boolean {
		return !!this.handlers.get(name)?.length;
	}

	/** Every handler (of the plugins in `only`, when given) with the same input, at once: how `guard` and `collect` hooks run. Each valid result that applies, in plugin order. */
	async each<H extends HookId>(name: H, input: PluginHooks[H]["input"], only?: string[]): Promise<HookResult<H>[]> {
		const trial = trialPlugins(this.app);
		const handlers = this.ordered(name).filter((h) => (!trial.includes(h.owner.plugin) || HOOKS[name].trial) && (!only || only.includes(h.owner.plugin)));
		const got = await Promise.all(
			handlers.map(async (h) => {
				if (!trial.includes(h.owner.plugin)) return { plugin: h.owner.plugin, item: await this.call(name, h, input) };
				await this.inTrial(name, h, input);
				return { plugin: h.owner.plugin, item: undefined };
			}),
		);
		return got.filter((g): g is HookResult<H> => g.item !== undefined);
	}

	/** A `pipeline` hook: each handler receives the value so far; `apply` makes the next one from its result. One in trial changes nothing. */
	async pipeline<H extends HookId>(name: H, input: PluginHooks[H]["input"], apply: (value: PluginHooks[H]["input"], item: PluginHooks[H]["item"], plugin: string) => PluginHooks[H]["input"]): Promise<PluginHooks[H]["input"]> {
		const trial = trialPlugins(this.app);
		let value = input;
		for (const h of this.ordered(name)) {
			if (trial.includes(h.owner.plugin)) {
				await this.inTrial(name, h, value);
				continue;
			}
			const item = await this.call(name, h, value);
			if (item !== undefined) value = apply(value, item, h.owner.plugin);
		}
		return value;
	}

	/** Call a handler in trial and record what it would have changed (§8). */
	private async inTrial<H extends HookId>(name: H, h: Handler, input: PluginHooks[H]["input"]): Promise<void> {
		const spec = HOOKS[name] as HookSpec<H>;
		if (!spec.trial) return;
		const item = await trialCall.run(h.owner.plugin, () => this.call(name, h, input));
		const e = item === undefined ? {} : spec.trial(item, input);
		this.app.db.prepare("DELETE FROM trial_results WHERE plugin = ? AND at < ?").run(h.owner.plugin, keptSince());
		this.app.db.prepare("INSERT INTO trial_results (plugin, hook, hidden, first_changed, changed, at) VALUES (?, ?, ?, ?, ?, ?)").run(h.owner.plugin, name, e.hidden ?? 0, e.firstChanged ? 1 : 0, e.changed ?? 0, nowIso());
	}

	/** Count one call of a guard. One that hides nearly everything is reported to the owner (§8). */
	countGuard(name: HookId, plugin: string, seen: number, hidden: number): void {
		if (!seen) return;
		const key = `${name} ${plugin}`;
		const calls = [...(this.guardCalls.get(key) ?? []), { seen, hidden }].slice(-GUARD_ALARM_CALLS);
		this.guardCalls.set(key, calls);
		if (calls.length < GUARD_ALARM_CALLS) return;
		const total = calls.reduce((n, c) => n + c.seen, 0);
		const gone = calls.reduce((n, c) => n + c.hidden, 0);
		if (gone / total <= GUARD_ALARM_SHARE) return;
		this.guardCalls.delete(key);
		addInbox(this.app, { kind: "notice", title: tr(this.app, "hooks.guardAlarmTitle", { plugin }), body: tr(this.app, "hooks.guardAlarmBody", { plugin, hidden: gone, total, calls: calls.length }), source: `plugin:${plugin}`, dedupeKey: `guard-alarm:${name}:${plugin}` });
	}

	/** One handler. Whatever goes wrong stays here: a hook never stops the step it belongs to. */
	private async call<H extends HookId>(name: H, h: Handler, input: PluginHooks[H]["input"]): Promise<PluginHooks[H]["item"] | undefined> {
		const registration = `hook ${name}`;
		const limit = this.limitMs ?? HANDLER_LIMIT_MS;
		const startedAt = Date.now();
		let timer!: NodeJS.Timeout;
		let timedOut = false;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				reject(new ReelixError("hook_timeout", `did not answer within ${Math.round(limit / 1000)} seconds`));
			}, limit);
		});
		try {
			const running = h.owner.track(async () => h.run(structuredClone(input)));
			running.catch(() => undefined); // it may lose the race below and fail later
			const item = structuredClone(await Promise.race([running, timeout])) as PluginHooks[H]["item"] | undefined;
			if (item === undefined || item === null) return undefined;
			const problem = (HOOKS[name].check as (i: unknown, input: unknown) => string | undefined)(item, input);
			if (problem) throw new ReelixError("hook_contract", `broke the ${name} limits: ${problem}`);
			return item;
		} catch (e) {
			if (!h.owner.isOpen() || (timedOut && this.app.seams.wasBusySince(startedAt))) return undefined;
			h.owner.onFailure(registration, { method: name, error: e, timedOutSince: timedOut ? startedAt : undefined });
			console.warn(`Plugin ${h.owner.plugin}: ${registration}: ${this.app.redact(errorMessage(e))}`);
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}
}
