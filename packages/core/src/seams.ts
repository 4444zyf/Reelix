import { type Call, type Outcome, type PluginSeamId, type SeamAnswer, type SeamContracts, type SeamId, isOutcome, isOutcomeError } from "@reelix/plugin";
import { Value } from "typebox/value";
import type { Reelix } from "./app.ts";
import { ReelixError, errorMessage, nowIso } from "./util.ts";

/**
 * Seams, the contracts for outside services (docs/plugins.md §7). Plugins register providers here;
 * core reaches every provider through `app.seams`, which applies the time limits, checks results,
 * records outcomes and tells the plugin kernel about failures (§11.6).
 */
const DEFAULT_LIMIT_MS = 60_000;
const OUTCOMES_KEPT_DAYS = 7;

/** What is wrong with a value (a result, given the arguments of the call); nothing when it fits the contract. */
type Check = (value: any, args?: any[]) => string | undefined;
type MethodSpec = {
	/** What `call.deadline` allows. */
	limitMs?: number;
	/** Extra time before Reelix gives up on a provider that promised to stop at the deadline by itself. */
	graceMs?: number;
	/** The result may be a typed outcome (§7). */
	outcomes: boolean;
	optional?: boolean;
	/** A success worth counting in the provider's record (downloads of the day). */
	recordSuccess?: boolean;
	check: Check;
};
/** `many`: every provider is used; `one`: the owner picks the active provider, and Reelix never switches by itself (§7). */
type SeamSpec = { kind: "many" | "one"; data: Check; methods: Record<string, MethodSpec> };

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const optional = (v: unknown, type: string) => v === undefined || typeof v === type;
const list = (v: unknown, of: (x: unknown) => boolean) => Array.isArray(v) && v.every(of);
const bad = (cond: boolean, what: string) => (cond ? undefined : what);
const KINDS = ["movie", "show", "anime"];
const kindList = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((k) => KINDS.includes(k as string));

function checkHit(h: any): string | undefined {
	if (!str(h?.ref)) return "a hit has no ref";
	if (typeof h.name !== "string") return `hit ${h.ref} has no name`;
	if (!list(h.languages, (l) => typeof l === "string")) return `hit ${h.ref}: languages must be a list of strings`;
	return bad(optional(h.season, "number") && optional(h.episode, "number"), `hit ${h.ref}: season and episode must be numbers`);
}
const firstProblem = (items: unknown[], check: Check) => {
	for (const i of items) {
		const p = check(i);
		if (p) return p;
	}
	return undefined;
};

function checkRelease(h: any): string | undefined {
	if (!str(h?.ref) || typeof h.title !== "string" || !str(h.site)) return "a hit needs ref, title and site";
	return bad(typeof h.hasMagnet === "boolean" && optional(h.size, "number") && optional(h.seeders, "number"), `hit ${h.title}: wrong field types`);
}

const checkSiteResult: Check = (s) => bad(str(s?.site) && typeof s.ok === "boolean" && typeof s.count === "number" && typeof s.ms === "number" && (s.outcome === undefined || isOutcome(s.outcome)), "a site result needs site, ok, count and ms");

const HASH = /^[0-9a-f]{40}$/;
const STATES = ["queued", "checking", "downloading", "seeding", "stopped", "error"];
const isoTime = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const optionalNumber = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);

function checkTransfer(t: any): string | undefined {
	if (!HASH.test(String(t?.id))) return "a transfer's id must be its v1 info-hash in 40 lower-case hex digits";
	const at = `transfer ${t.id}`;
	if (typeof t.name !== "string" || !STATES.includes(t.state)) return `${at}: name and a known state are required`;
	if (typeof t.hasMetadata !== "boolean" || typeof t.done !== "boolean") return `${at}: hasMetadata and done must be true or false`;
	if (!(typeof t.progress === "number" && t.progress >= 0 && t.progress <= 1)) return `${at}: progress must be 0..1`;
	if (!optionalNumber(t.size) || !optionalNumber(t.left) || t.size === undefined || t.left === undefined) return `${at}: size and left must be byte counts`;
	if (!t.hasMetadata && (t.size !== 0 || t.left !== 0 || t.done)) return `${at}: before metadata size and left are 0 and it is not done`;
	if (t.done && (t.left !== 0 || t.state === "checking" || t.state === "error")) return `${at}: done, but data is missing, being checked or failed`;
	if (typeof t.folder !== "string" || (t.contentPath !== undefined && typeof t.contentPath !== "string")) return `${at}: folder and contentPath must be paths`;
	if (!list(t.marks, (m) => typeof m === "string")) return `${at}: marks must be a list`;
	if (!isoTime(t.addedAt) || (t.completedAt !== undefined && !isoTime(t.completedAt))) return `${at}: times must be ISO 8601`;
	if (![t.downSpeed, t.upSpeed, t.etaSeconds, t.peersSending, t.ratio, t.seedingSeconds].every(optionalNumber)) return `${at}: speeds, eta, peers, ratio and seeding time must be finite numbers`;
	return bad(t.problem === undefined || ((t.problem.kind === "tracker" || t.problem.kind === "local") && typeof t.problem.message === "string"), `${at}: problem must be { kind: tracker | local, message }`);
}

function checkFiles(r: unknown): string | undefined {
	if (!Array.isArray(r)) return "files must return a list";
	for (const [i, f] of r.entries()) {
		if (f?.index !== i) return "files must be in torrent order, each with its position as index";
		if (typeof f.path !== "string" || !f.path || f.path.startsWith("/") || f.path.includes("\\")) return `file ${i}: path must be relative to the folder, with /`;
		if (!optionalNumber(f.size) || !(f.progress >= 0 && f.progress <= 1) || typeof f.wanted !== "boolean") return `file ${i}: size, progress 0..1 and wanted are required`;
	}
	return undefined;
}

const IDS = ["tmdb", "imdb", "tvdb", "bangumi", "douban"];
function idsProblem(ids: any): string | undefined {
	if (typeof ids !== "object" || ids === null || Array.isArray(ids)) return "ids must be an object";
	for (const [k, v] of Object.entries(ids)) {
		if (!IDS.includes(k)) return `there is no id kind "${k}"`;
		if (v === undefined) continue;
		if (k === "imdb" || k === "douban" ? !str(v) : !(Number.isInteger(v) && (v as number) > 0)) return `ids.${k} has the wrong type`;
	}
	return undefined;
}
const checkRating = (r: any) => r === undefined || (typeof r?.value === "number" && typeof r.scale === "number" && r.scale > 0 && r.value >= 0 && r.value <= r.scale);
const optionalNames = (v: unknown) => v === undefined || list(v, (n) => typeof n === "string");

function checkMetaHit(h: any): string | undefined {
	if (!str(h?.name) || !KINDS.includes(h.kind)) return "a hit needs a name and a known kind";
	const at = `hit ${h.name}`;
	const ids = idsProblem(h.ids);
	if (ids) return `${at}: ${ids}`;
	if (!optionalNames(h.names) || !optional(h.year, "number") || !optional(h.series, "boolean") || !optional(h.episodes, "number") || !optional(h.note, "string")) return `${at}: names, year, series, episodes or note has the wrong type`;
	return bad(checkRating(h.rating), `${at}: rating must be { value, scale } with value in 0..scale`);
}

function checkEnrichment(e: any): string | undefined {
	if (typeof e !== "object" || e === null) return "enrich must return { rating?, episodes? }";
	if (!checkRating(e.rating)) return "rating must be { value, scale } with value in 0..scale";
	return bad(e.episodes === undefined || list(e.episodes, (x: any) => typeof x?.number === "number" && (x.airDate === undefined || /^\d{4}-\d{2}-\d{2}$/.test(x.airDate))), "episodes must be { number, airDate? (YYYY-MM-DD) }[]");
}

function checkTrendHit(h: any): string | undefined {
	if (!str(h?.name) || !KINDS.includes(h.kind)) return "a hit needs a name and a known kind";
	const ids = idsProblem(h.ids);
	if (ids) return `hit ${h.name}: ${ids}`;
	return bad(optionalNames(h.names) && optional(h.year, "number") && optional(h.rating, "number"), `hit ${h.name}: names, year or rating has the wrong type`);
}

const checkServerItem = (i: any) =>
	!str(i?.id) || (i.kind !== "movie" && i.kind !== "show") || typeof i.name !== "string" ? "an item needs id, kind (movie or show) and name" : (idsProblem(i.ids) ?? bad([i.plays, i.episodesPlayed].every(optionalNumber) && optional(i.year, "number") && optional(i.favourite, "boolean") && (i.lastPlayedAt === undefined || isoTime(i.lastPlayedAt)), `item ${i.id}: plays, year, favourite or lastPlayedAt has the wrong type`));
const checkServerEpisode = (e: any) => bad(str(e?.id) && str(e.showId) && Number.isInteger(e.season) && Number.isInteger(e.episode), "an episode needs id, showId, season and episode");

/** Schemes a player link may not use: they would run or read something in the page instead of opening an app. */
const UNSAFE_SCHEME = /^(javascript|data|vbscript|file|blob|about):/i;
const checkLink = (l: any) => l === null || (typeof l?.url === "string" && /^[a-z][a-z0-9+.-]*:/i.test(l.url) && !UNSAFE_SCHEME.test(l.url) && l.url.length <= 2000 && typeof l.autoplay === "boolean");

function checkTranslated(r: any, [job]: any[] = []): string | undefined {
	if (!Array.isArray(r?.lines)) return "translate must return { lines }";
	const asked = new Set((job?.lines ?? []).map((l: any) => l.n));
	const seen = new Set<number>();
	for (const l of r.lines) {
		if (!asked.has(l?.n)) return `line ${l?.n} was not asked for`;
		if (seen.has(l.n)) return `line ${l.n} came back twice`;
		seen.add(l.n);
		if (!str(l.text) || !l.text.trim()) return `line ${l.n} is empty`;
		if (!optional(l.unsure, "boolean") || !optional(l.borrowed, "boolean")) return `line ${l.n}: unsure and borrowed must be true or false`;
	}
	if (r.terms !== undefined && !list(r.terms, (t: any) => str(t?.term) && str(t?.as))) return "terms must be { term, as }[]";
	return bad(optional(r.model, "string"), "model must be a name");
}

const canList = (v: any, names: string[]) => typeof v === "object" && v !== null && names.every((n) => typeof v[n] === "boolean");
const nothing: Check = (r) => bad(r === undefined, "it must return nothing or an outcome");

const SEAMS: { [S in SeamId]: SeamSpec } = {
	"reelix:subtitle.source@1": {
		kind: "many",
		data: (p) => bad(kindList(p.kinds) && list(p.languages, str) && (p.needsSecrets === undefined || list(p.needsSecrets, str)), "kinds, languages and needsSecrets must be lists"),
		methods: {
			search: { outcomes: true, check: (r) => (Array.isArray(r) ? firstProblem(r, checkHit) : "search must return a list of hits") },
			files: { outcomes: true, optional: true, check: (r) => bad(list(r, (f: any) => typeof f?.name === "string"), "files must return a list of { name }") },
			download: { outcomes: true, recordSuccess: true, check: (r) => bad(r?.bytes instanceof Uint8Array && str(r.filename), "download must return { bytes, filename }") },
		},
	},
	"reelix:indexer@1": {
		kind: "many",
		data: (p) => bad(kindList(p.kinds), "kinds must be a list"),
		methods: {
			sites: { outcomes: true, check: (r) => bad(list(r, (s: any) => str(s?.id) && str(s?.name)), "sites must return a list of { id, name }") },
			// 30 seconds per site; the provider returns what it has when the time is up.
			search: { outcomes: false, limitMs: 30_000, graceMs: 5_000, check: (r) => (!Array.isArray(r?.hits) || !Array.isArray(r?.sites) ? "search must return { hits, sites }" : (firstProblem(r.hits, checkRelease) ?? firstProblem(r.sites, checkSiteResult))) },
			fetch: { outcomes: true, check: (r) => bad(r?.torrent instanceof Uint8Array || str(r?.magnet), "fetch must return { torrent } or { magnet }") },
		},
	},
	"reelix:notifier@1": {
		kind: "many",
		data: (p) => bad(canList(p.can, ["images", "update", "answers"]), "can must say images, update and answers"),
		methods: {
			send: { outcomes: true, check: (r) => bad(typeof r === "object" && r !== null && optional(r.ref, "string"), "send must return { ref? }") },
			update: { outcomes: true, optional: true, check: nothing },
		},
	},
	"reelix:chat.channel@1": {
		kind: "many",
		data: (p) => bad(canList(p.can, ["buttons", "images", "typing"]), "can must say buttons, images and typing"),
		methods: { say: { outcomes: true, check: nothing } },
	},
	"reelix:downloader@1": {
		kind: "one",
		data: () => undefined,
		methods: {
			add: { outcomes: true, check: (r) => bad(HASH.test(String(r?.id)) && typeof r.duplicate === "boolean", "add must return { id: the info-hash, duplicate }") },
			get: { outcomes: false, limitMs: 30_000, check: (r) => (r === undefined ? undefined : checkTransfer(r)) },
			list: { outcomes: false, limitMs: 30_000, check: (r) => (Array.isArray(r) ? firstProblem(r, checkTransfer) : "list must return a list of transfers") },
			changes: {
				outcomes: false,
				optional: true,
				limitMs: 30_000,
				check: (r) => (typeof r?.cursor !== "string" || typeof r.full !== "boolean" || !Array.isArray(r.changed) || !list(r.removed, (h) => HASH.test(String(h))) ? "changes must return { cursor, full, changed, removed }" : r.full && r.removed.length ? "a full answer has no removed list" : firstProblem(r.changed, checkTransfer)),
			},
			files: { outcomes: false, limitMs: 30_000, check: checkFiles },
			setWanted: { outcomes: false, check: nothing },
			start: { outcomes: false, check: nothing },
			stop: { outcomes: false, check: nothing },
			remove: { outcomes: false, check: nothing },
			addMark: { outcomes: false, check: nothing },
			freeSpace: { outcomes: false, limitMs: 30_000, check: (r) => bad(optionalNumber(r), "freeSpace must return a byte count or nothing") },
			defaultFolder: { outcomes: false, limitMs: 30_000, check: (r) => bad(typeof r === "string" && r.length > 0, "defaultFolder must return a path") },
		},
	},
	"reelix:media.server@1": {
		kind: "one",
		data: (p) => bad(p.watchUsers === undefined || list(p.watchUsers, str), "watchUsers must be a list of names"),
		methods: {
			info: { outcomes: false, limitMs: 15_000, check: (r) => bad(str(r?.serverId) && typeof r.name === "string" && typeof r.version === "string" && optional(r.publicUrl, "string"), "info must return { serverId, name, version, publicUrl? }") },
			libraries: { outcomes: false, limitMs: 15_000, check: (r) => bad(list(r, (l: any) => str(l?.id) && typeof l.name === "string" && list(l.paths, str)), "libraries must return { id, name, paths }[]") },
			users: { outcomes: false, limitMs: 15_000, check: (r) => bad(list(r, (u: any) => str(u?.id) && typeof u.name === "string" && typeof u.admin === "boolean" && typeof u.active === "boolean"), "users must return { id, name, admin, active }[]") },
			changed: { outcomes: false, limitMs: 30_000, check: nothing },
			refreshAll: { outcomes: false, limitMs: 30_000, check: nothing },
			items: { outcomes: false, limitMs: 30_000, check: (r) => (Array.isArray(r) ? firstProblem(r, checkServerItem) : "items must return a list") },
			episodes: { outcomes: false, limitMs: 30_000, check: (r) => (Array.isArray(r) ? firstProblem(r, checkServerEpisode) : "episodes must return a list") },
			nextUp: { outcomes: false, limitMs: 30_000, check: (r) => (Array.isArray(r) ? firstProblem(r, checkServerEpisode) : "nextUp must return a list") },
		},
	},
	"reelix:player@1": {
		kind: "many",
		data: () => undefined,
		// Links are built, not fetched: a player that needs long is broken.
		methods: { links: { outcomes: false, limitMs: 5_000, check: (r) => bad(list(r, checkLink), "links must return one { url, autoplay } or null per request, with an app's link (never javascript:, data: or file:)") } },
	},
	"reelix:metadata.source@1": {
		kind: "many",
		data: (p) => bad(["find", "fromLink", "enrich"].some((m) => typeof p[m] === "function"), "it must have at least one of find, fromLink and enrich"),
		methods: {
			find: { outcomes: true, optional: true, limitMs: 30_000, check: (r) => (Array.isArray(r) ? firstProblem(r, checkMetaHit) : "find must return a list of hits") },
			fromLink: { outcomes: true, optional: true, limitMs: 30_000, check: (r) => (r === undefined ? undefined : checkMetaHit(r)) },
			enrich: { outcomes: true, optional: true, check: checkEnrichment },
		},
	},
	"reelix:trends.source@1": {
		kind: "many",
		data: () => undefined,
		methods: { trending: { outcomes: true, limitMs: 30_000, check: (r) => (Array.isArray(r) ? firstProblem(r, checkTrendHit) : "trending must return a list of hits") } },
	},
	"reelix:translator@1": {
		kind: "one",
		data: () => undefined,
		// A model may think for minutes, and a provider may try several (translation.call_timeout_s each).
		methods: { translate: { outcomes: true, limitMs: 20 * 60_000, check: checkTranslated } },
	},
};

export const SEAM_IDS = Object.keys(SEAMS) as SeamId[];

/** What the generated reference says about each seam (docs/plugins.md §14.1). */
export const SEAM_DECLARATIONS = SEAM_IDS.map((id) => ({
	id,
	kind: SEAMS[id].kind,
	methods: Object.entries(SEAMS[id].methods).map(([name, m]) => ({ name, limitMs: (m.limitMs ?? DEFAULT_LIMIT_MS) + (m.graceMs ?? 0), outcomes: m.outcomes, optional: !!m.optional })),
}));

/**
 * A seam a plugin owns, as its manifest declares it (docs/plugins.md §7.11): each method's time limit and a
 * JSON Schema of its result. It is of the kind many, and only its owner calls it.
 */
export type OwnedSeamDeclaration = { summary: string; methods: Record<string, { limitMs?: number; result: Record<string, unknown> }> };

/** The first way a value breaks a JSON Schema, or nothing. */
export function schemaProblem(schema: Record<string, unknown>, value: unknown): string | undefined {
	for (const e of Value.Errors(schema, value)) return `${(e as { instancePath?: string }).instancePath || "/"} ${e.message}`;
	return undefined;
}

function ownedSpec(d: OwnedSeamDeclaration): SeamSpec {
	const methods: Record<string, MethodSpec> = {};
	for (const [name, m] of Object.entries(d.methods)) methods[name] = { outcomes: false, limitMs: m.limitMs, check: (r) => schemaProblem(m.result, r) };
	return { kind: "many", data: () => undefined, methods };
}

/** What a seam method did wrong, for the kernel's failure count. */
type SeamFailure = { method: string; error: unknown; timedOutSince?: number };

/** The registering plugin, as the hub sees it. */
export type ProviderOwner = {
	plugin: string;
	builtIn: boolean;
	/** Where its hook handlers stand in a pipeline: built-in plugins first, then order of installation. */
	order: number;
	/** Run provider code so that stopping the plugin waits for it. */
	track<T>(fn: () => Promise<T>): Promise<T>;
	isOpen(): boolean;
	/** Fires when the plugin stops; every call it is running ends with it. */
	signal: AbortSignal;
	onFailure(registration: string, failure: SeamFailure): void;
};

type MethodsOf<S extends SeamId> = { [M in keyof SeamContracts[S] as SeamContracts[S][M] extends ((...a: any[]) => any) | undefined ? M : never]-?: NonNullable<SeamContracts[S][M]> };
type ArgsOf<F> = F extends (...a: [...infer A, Call]) => any ? A : never;
type ResultOf<F> = F extends (...a: any[]) => Promise<infer R> ? R : never;

type CallOptions = { signal?: AbortSignal; verification?: string };
export type RecordedOutcome = { outcome: string; until?: string; url?: string; message?: string; at: string };

/** One registered provider. `call` is the only way core reaches its code. */
export class Provider<S extends SeamId = SeamId> {
	readonly id: string;
	/** For display: a third-party provider's label always names its plugin (§7). */
	readonly label: string;
	readonly plugin: string;
	readonly seam: S;
	readonly impl: SeamContracts[S];
	private hub: SeamHub;
	private owner: ProviderOwner;

	constructor(hub: SeamHub, seam: S, impl: SeamContracts[S], owner: ProviderOwner) {
		this.hub = hub;
		this.seam = seam;
		this.impl = impl;
		this.owner = owner;
		this.id = impl.id;
		this.label = owner.builtIn ? impl.label : `${impl.label} (${owner.plugin})`;
		this.plugin = owner.plugin;
	}

	/** The full names of the secrets it says it needs and does not have. */
	missingSecrets(secrets: Record<string, string>): string[] {
		const names = (this.impl as { needsSecrets?: string[] }).needsSecrets ?? [];
		return names.map((n) => `plugins.${this.plugin}.${n}`).filter((k) => !secrets[k]);
	}

	has(method: keyof MethodsOf<S> & string): boolean {
		return typeof (this.impl as any)[method] === "function";
	}

	async call<M extends keyof MethodsOf<S> & string>(method: M, args: ArgsOf<MethodsOf<S>[M]>, o: CallOptions = {}): Promise<ResultOf<MethodsOf<S>[M]>> {
		const spec = this.hub.specOf(this.seam)?.methods[method];
		if (!spec) throw new ReelixError("no_such_method", `${this.seam} has no method ${method}, or its owner has stopped.`);
		const registration = `provider ${this.id} (${this.seam})`;
		const limit = this.hub.limitMs ?? spec.limitMs ?? DEFAULT_LIMIT_MS;
		const grace = this.hub.limitMs ? 0 : (spec.graceMs ?? 0);
		const startedAt = Date.now();
		const stop = new AbortController();
		const signal = AbortSignal.any([this.owner.signal, stop.signal, ...(o.signal ? [o.signal] : [])]);
		const call: Call = { signal, deadline: startedAt + limit, verification: o.verification };
		let timer!: NodeJS.Timeout;
		let timedOut = false;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				stop.abort();
				reject(new ReelixError("provider_timeout", `${this.label} did not answer within ${Math.round((limit + grace) / 1000)} seconds.`));
			}, limit + grace);
		});
		let result: unknown;
		try {
			const running = this.owner.track(async () => (this.impl as any)[method](...structuredClone(args), call));
			running.catch(() => undefined); // it may lose the race below and fail later
			result = structuredClone(await Promise.race([running, timeout]));
		} catch (e) {
			if (!this.owner.isOpen()) throw new ReelixError("provider_gone", `${this.label} has been switched off.`);
			if (o.signal?.aborted) throw e;
			// An expected answer of the service, from a method whose type has no room for it (§7).
			if (isOutcomeError(e) && !timedOut) {
				this.hub.record(this.seam, this.id, method, e.outcome);
				throw outcomeAsError(this.label, e.outcome);
			}
			// Time Reelix itself spent busy is not held against the plugin (§11.6).
			if (timedOut && this.hub.wasBusySince(startedAt)) throw e;
			this.owner.onFailure(registration, { method, error: e, timedOutSince: timedOut ? startedAt : undefined });
			if (e instanceof ReelixError) throw e;
			throw new ReelixError("provider_error", `${this.label}: ${errorMessage(e)}`);
		} finally {
			clearTimeout(timer);
		}
		if (spec.outcomes && isOutcome(result)) {
			this.hub.record(this.seam, this.id, method, result);
			return result as never;
		}
		const problem = spec.check(result, args);
		if (problem) {
			const error = new ReelixError("provider_contract", `${this.label} broke the ${this.seam} contract: ${problem}`);
			this.owner.onFailure(registration, { method, error });
			throw error;
		}
		if (spec.recordSuccess) this.hub.recordSuccess(this.seam, this.id, method);
		return result as never;
	}
}

/** Long gaps in the event loop: time in which Reelix could not have noticed an answer. */
class LoopWatch {
	private stalls: { at: number; ms: number }[] = [];
	private timer?: NodeJS.Timeout;
	private last = 0;

	start(): void {
		if (this.timer) return;
		this.last = Date.now();
		this.timer = setInterval(() => {
			const now = Date.now();
			const late = now - this.last - 100;
			this.last = now;
			if (late < 100) return;
			this.stalls.push({ at: now, ms: late });
			this.stalls = this.stalls.filter((s) => s.at > now - 10 * 60_000);
		}, 100);
		this.timer.unref();
	}

	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	busySince(since: number): boolean {
		this.tick();
		const elapsed = Date.now() - since;
		const stalled = this.stalls.filter((s) => s.at >= since).reduce((n, s) => n + s.ms, 0);
		return stalled >= Math.max(100, elapsed * 0.1);
	}

	/** A timer can fire before the interval that would have measured the gap. */
	private tick(): void {
		if (!this.timer) return;
		const now = Date.now();
		const late = now - this.last - 100;
		if (late >= 100) {
			this.stalls.push({ at: now, ms: late });
			this.last = now;
		}
	}
}

export class SeamHub {
	/** Replaces every method's time limit (tests of what happens at the limit). */
	limitMs?: number;
	private byId = new Map<string, Provider<any>>();
	/** Seams plugins own, while their owner runs. */
	private owned = new Map<string, { plugin: string; declaration: OwnedSeamDeclaration; spec: SeamSpec }>();
	private watch = new LoopWatch();
	private app: Reelix;

	constructor(app: Reelix) {
		this.app = app;
	}

	/** A seam's rules: Reelix's own, or one a running plugin owns. */
	specOf(seam: string): SeamSpec | undefined {
		return Object.hasOwn(SEAMS, seam) ? SEAMS[seam as SeamId] : this.owned.get(seam)?.spec;
	}

	/** A plugin's own seam, from its manifest; returns the step that removes it when the owner stops. */
	define(seam: PluginSeamId, declaration: OwnedSeamDeclaration, plugin: string): () => void {
		if (this.specOf(seam)) throw new Error(`there is already a seam "${seam}"`);
		const entry = { plugin, declaration, spec: ownedSpec(declaration) };
		this.owned.set(seam, entry);
		return () => {
			if (this.owned.get(seam) === entry) this.owned.delete(seam);
		};
	}

	/** The seams running plugins own, with their providers, for inspection and the reference. */
	ownedSeams(): { id: string; owner: string; summary: string; methods: { name: string; limitMs: number }[]; providers: Provider<any>[] }[] {
		return [...this.owned].map(([id, o]) => ({ id, owner: o.plugin, summary: o.declaration.summary, methods: Object.entries(o.declaration.methods).map(([name, m]) => ({ name, limitMs: m.limitMs ?? DEFAULT_LIMIT_MS })), providers: [...this.byId.values()].filter((p) => p.seam === id) }));
	}

	/**
	 * The owner of a plugin seam calls one method on every provider (`ctx.seams.call`). Each answer is checked
	 * against the declared result; a provider that fails or breaks the contract answers with an error.
	 */
	async callOwned(seam: PluginSeamId, plugin: string, method: string, args: unknown[], signal?: AbortSignal): Promise<SeamAnswer[]> {
		const owned = this.owned.get(seam);
		if (!owned || owned.plugin !== plugin) throw new ReelixError("not_owner", `Only the plugin that owns ${seam} calls its providers.`);
		if (!owned.spec.methods[method]) throw new ReelixError("no_such_method", `${seam} declares no method "${method}".`);
		if (!Array.isArray(args)) throw new ReelixError("invalid_input", "args must be a list.");
		const providers = [...this.byId.values()].filter((p) => p.seam === seam);
		return Promise.all(
			providers.map(async (p) => {
				const base = { provider: p.id, label: p.label, plugin: p.plugin };
				try {
					return { ...base, result: await (p as Provider<any>).call(method as never, args as never, { signal }) };
				} catch (e) {
					return { ...base, error: errorMessage(e) };
				}
			}),
		);
	}

	/** Add a provider; returns the step that removes it. Refuses anything that does not fit the contract. */
	register<S extends SeamId>(seam: S, impl: SeamContracts[S], owner: ProviderOwner): () => void {
		const spec = this.specOf(seam);
		if (!spec) throw new Error(`there is no seam "${seam}"${seam.startsWith("reelix:") ? "" : "; its owner may not be running"}`);
		if (!/^[a-z0-9][a-z0-9-]*$/.test(String(impl?.id))) throw new Error(`provider id ${JSON.stringify(impl?.id)} must use lowercase letters, digits and hyphens`);
		if (!str(impl.label) || impl.label.length > 80) throw new Error(`provider ${impl.id}: label must be 1 to 80 characters`);
		const key = `${seam} ${impl.id}`;
		if (this.byId.has(key)) throw new Error(`there is already a ${seam} provider "${impl.id}"`);
		const problem = spec.data(impl);
		if (problem) throw new Error(`provider ${impl.id}: ${problem}`);
		for (const [name, m] of Object.entries(spec.methods)) if (!m.optional && typeof (impl as any)[name] !== "function") throw new Error(`provider ${impl.id}: ${seam} requires the method ${name}`);
		const provider = new Provider(this, seam, impl, owner);
		this.byId.set(key, provider);
		this.watch.start();
		return () => {
			if (this.byId.get(key) === provider) this.byId.delete(key);
			if (!this.byId.size) this.watch.stop();
		};
	}

	/** Every provider of a seam. Providers live in plugins, so this needs the running server. */
	providers<S extends SeamId>(seam: S): Provider<S>[] {
		if (!this.app.plugins) throw new ReelixError("needs_server", "This needs a plugin, and plugins run inside the Reelix server. Start it with `reelix serve`.");
		return [...this.byId.values()].filter((p) => p.seam === seam) as unknown as Provider<S>[];
	}

	provider<S extends SeamId>(seam: S, id: string): Provider<S> | undefined {
		return this.providers(seam).find((p) => p.id === id);
	}

	/** The seams a plugin currently provides. */
	providedBy(plugin: string): string[] {
		return [...new Set([...this.byId.values()].filter((p) => p.plugin === plugin).map((p) => p.seam))];
	}

	hasProvider(seam: string, exceptPlugin?: string): boolean {
		return [...this.byId.values()].some((p) => p.seam === seam && p.plugin !== exceptPlugin);
	}

	wasBusySince(since: number): boolean {
		return this.watch.busySince(since);
	}

	record(seam: SeamId, provider: string, method: string, o: Outcome): void {
		this.insert(seam, provider, method, o.outcome, o);
	}

	recordSuccess(seam: SeamId, provider: string, method: string): void {
		this.insert(seam, provider, method, "ok", {});
	}

	private insert(seam: SeamId, provider: string, method: string, outcome: string, detail: object): void {
		const { outcome: _o, ...rest } = detail as Record<string, unknown>;
		this.app.db.prepare("DELETE FROM provider_outcomes WHERE at < ?").run(new Date(Date.now() - OUTCOMES_KEPT_DAYS * 86_400_000).toISOString());
		this.app.db.prepare("INSERT INTO provider_outcomes (seam, provider, method, outcome, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)").run(seam, provider, method, outcome, this.app.redact(JSON.stringify(rest)), nowIso());
	}

	/** What a provider answered since a time, newest first. */
	outcomes(seam: SeamId, provider: string, since: string): RecordedOutcome[] {
		const rows = this.app.db.prepare("SELECT outcome, detail_json, at FROM provider_outcomes WHERE seam = ? AND provider = ? AND at >= ? ORDER BY id DESC").all(seam, provider, since) as { outcome: string; detail_json: string; at: string }[];
		return rows.map((r) => ({ outcome: r.outcome, at: r.at, ...(JSON.parse(r.detail_json) as object) }));
	}
}

/** An outcome where the caller cannot take one: an error with the outcome as its code. Not a failure of the plugin. */
export function outcomeAsError(label: string, o: Outcome): ReelixError {
	return new ReelixError(o.outcome, outcomeText(label, o));
}

/** An outcome in words, for the owner and the agent. */
export function outcomeText(label: string, o: Outcome): string {
	switch (o.outcome) {
		case "rate_limited":
			return `${label}: limit reached${o.until ? ` until ${o.until.slice(0, 16)}` : ""}.`;
		case "needs_auth":
			return `${label}: refused the login or key.`;
		case "needs_verification":
			return `${label} asks for a human check at ${o.url}.`;
		case "unavailable":
			return `${label}: ${o.message}`;
	}
}
