import { type CardLayout, type HookId, outsideLine } from "@reelix/plugin";
import { Type } from "typebox";
import type { Reelix } from "./app.ts";
import type { Check } from "./doctor.ts";
import { KNOWN_SECRETS, LANGUAGES, type Language, MODEL_ROLES, type ModelRole } from "./config.ts";
import { json, kvGet, kvSet } from "./db.ts";
import { HOOK_DECLARATIONS, type TrialSummary, setHookOrder, setTrial, trialPlugins } from "./hooks.ts";
import { tr } from "./i18n.ts";
import { type Effect, defineOperation, runOperation } from "./registry.ts";
import { spentToday } from "./spend.ts";
import { ReelixError } from "./util.ts";

/** `installed`: not approved yet; `incompatible`: this Reelix cannot run it; `changed`: its files differ from what the owner approved (docs/plugins.md §5.3, §13.3). */
export type PluginState = "active" | "waiting" | "failed" | "disabled" | "installed" | "incompatible" | "changed";

/** Where an installed plugin came from, pinned (docs/plugins.md §13.1). */
export type PluginSource = { kind: "folder" | "git" | "npm"; location: string; pin?: string };

/** What a plugin declares, read from its manifest only: the install, approval and update screens (docs/plugins.md §11.1). */
export type PluginDeclarations = {
	id: string;
	version: string;
	description: string;
	license?: string;
	/** `skills`: a skill pack, no code. */
	kind: "plugin" | "skills";
	provides: string[];
	requires: string[];
	/** Other plugins it needs, each with a version range (docs/plugins.md §7.11). */
	requiresPlugins: { id: string; range: string }[];
	/** Seams and events it owns, which other plugins provide and listen to. */
	owns: string[];
	hooks: string[];
	events: string[];
	operations: { name: string; effect: Effect; tool?: string }[];
	jobs: string[];
	runs: string[];
	network: string[];
	/** `*` in network: any site on the internet. */
	anyHost: boolean;
	secrets: string[];
	skills: string[];
	/** Files under its skills folder that are not Markdown: the agent may run them. */
	scripts: string[];
	agent: boolean;
	inbox: boolean;
	model: boolean;
	/** Model roles besides `background` it asks for, and whether it asks to run without a daily budget (docs/plugins.md §10.2). */
	modelRoles: string[];
	unmetered: boolean;
	/** A raw pi extension: advanced. */
	pi: boolean;
	native: boolean;
	/** Where its code runs unless the owner chooses otherwise, and whether it can run in a process of its own (docs/plugins.md §11.7). */
	runtime: PluginRuntime;
	processAllowed: boolean;
	/** The title of the screen it ships (docs/plugins.md §16, phase 8). */
	screen?: string;
};

/** Where a plugin's code runs: inside Reelix, or in a process of its own that has only its context (docs/plugins.md §11.7). */
export type PluginRuntime = "in-process" | "process";

const DIFF_LISTS = ["network", "secrets", "skills", "scripts", "operations", "tools", "provides", "plugins", "owns", "hooks", "events", "runs", "jobs", "modelRoles"] as const;
const DIFF_FLAGS = ["agent", "inbox", "model", "unmetered", "pi", "native"] as const;
export type DeclarationDiff = {
	added: Partial<Record<(typeof DIFF_LISTS)[number], string[]>>;
	removed: Partial<Record<(typeof DIFF_LISTS)[number], string[]>>;
	/** Operations whose effect changed, or new ones, with the effect they now claim. */
	effects: { operation: string; from?: Effect; to: Effect }[];
	/** `agent`, `inbox`, `model`, `unmetered`, `pi`, `native` newly asked for; `in-process` when it no longer runs in a process of its own by default, or can no longer run there although the owner chose it (it then stays off until the owner chooses again); `screen` for a new screen. */
	flags: string[];
};

/** What changed in the declarations between two versions (docs/plugins.md §13.3). */
export function declarationDiff(from: PluginDeclarations, to: PluginDeclarations): DeclarationDiff {
	const lists = (d: PluginDeclarations): Record<(typeof DIFF_LISTS)[number], string[]> => ({
		network: d.network,
		secrets: d.secrets,
		skills: d.skills,
		scripts: d.scripts,
		operations: d.operations.map((o) => o.name),
		tools: d.operations.flatMap((o) => o.tool ?? []),
		provides: d.provides,
		plugins: d.requiresPlugins.map((r) => `${r.id} ${r.range}`),
		owns: d.owns,
		hooks: d.hooks,
		events: d.events,
		runs: d.runs,
		jobs: d.jobs,
		modelRoles: d.modelRoles,
	});
	const a = lists(from);
	const b = lists(to);
	const diff: DeclarationDiff = { added: {}, removed: {}, effects: [], flags: [...DIFF_FLAGS.filter((f) => to[f] && !from[f]), ...(from.runtime === "process" && to.runtime === "in-process" ? ["in-process"] : []), ...(to.screen && !from.screen ? ["screen"] : [])] };
	for (const k of DIFF_LISTS) {
		const added = b[k].filter((x) => !a[k].includes(x));
		const removed = a[k].filter((x) => !b[k].includes(x));
		if (added.length) diff.added[k] = added;
		if (removed.length) diff.removed[k] = removed;
	}
	for (const op of to.operations) {
		const before = from.operations.find((o) => o.name === op.name)?.effect;
		if (before !== op.effect) diff.effects.push({ operation: op.name, ...(before ? { from: before } : {}), to: op.effect });
	}
	return diff;
}

/** The screen the owner approves from (docs/plugins.md §11.1, §13.3). Built from the manifest and the installed files; no code of the plugin has run. */
export type PluginReview = {
	id: string;
	/** `install`: new; `update`: a staged new version; `changed`: its files changed since the owner approved them; `proposal`: the agent wrote it and asks the owner to install it. */
	what: "install" | "update" | "changed" | "proposal";
	/** Of everything that would run. `plugin.approve` takes it back, so the owner approves exactly what they saw. */
	hash: string;
	source: PluginSource;
	declarations: PluginDeclarations;
	/** Packages with compiled code found among its dependencies; each ships a ready-made binary for this platform. */
	nativeFound: string[];
	/** Install scripts of the package and its dependencies. Reelix never runs them. */
	scriptsNotRun: string[];
	/** For an update: the version running now, what changed in the declarations, and the author's changelog. */
	from?: { version: string; source: PluginSource };
	diff?: DeclarationDiff;
	changelog?: string;
	/** Each plugin it requires and whether this Reelix has it at a version in the range (`satisfied`). */
	requirements: (PluginRequirement & { satisfied: boolean })[];
	/** A plugin the agent wrote: its files, and what changed since its previous proposal (docs/plugins.md §10.6, §11.1). */
	proposal?: PluginProposalView;
};

/**
 * A plugin the agent wrote and proposed (docs/plugins.md §16, phase 7): a copy of its folder taken when it was
 * proposed, which only the owner's approval installs. `note` is the agent's, so it is outside text. `files`
 * and `diff` compare it with the previous proposal of the same plugin, or with nothing.
 */
export type PluginProposalView = {
	id: string;
	plugin: string;
	version: string;
	by: string;
	at: string;
	note?: string;
	status: "open" | "approved" | "declined" | "replaced";
	/** The folder it was copied from. */
	folder: string;
	files: { path: string; size: number; change: "added" | "changed" | "removed" | "same" }[];
	/** Since this earlier proposal; absent for the first. */
	diffFrom?: string;
	diff: string;
};

/** A plugin another one requires, and what this Reelix has of it: nothing, or its version and state. */
export type PluginRequirement = { id: string; range: string; version?: string; state?: PluginState };

/** Newer versions of an installed plugin; nothing is installed by looking (docs/plugins.md §13.3). */
export type PluginUpdates = { id: string; version: string; source: PluginSource; available: { to: string; label: string }[]; error?: string };

export type PluginInfo = {
	id: string;
	version: string;
	description: string;
	state: PluginState;
	/** Why it failed or was switched off, or the last error of a running plugin. */
	error?: string;
	/** Failures counted in the last ten minutes. */
	failures: number;
	/** The seams a `waiting` plugin needs and nobody provides. */
	waitingFor: string[];
	/** The plugins a `waiting` plugin needs that are not running at a version in its range: what is there instead, if anything. */
	waitingForPlugins: PluginRequirement[];
	/** Other plugins it needs, each with a version range. */
	requires: { id: string; range: string }[];
	/** Seams and events it owns. */
	owns: string[];
	provides: string[];
	hooks: string[];
	operations: string[];
	jobs: string[];
	events: string[];
	runs: string[];
	/** Full names of the secrets the owner gives it: one per entry for a secret declared per list entry. */
	secrets: string[];
	/** Full names of the secrets it makes and renews itself; never asked for or shown as a field. */
	managedSecrets: string[];
	/** Optional and nothing of it set up: "not used", not "needs setup" (`needsSetup` is empty then). */
	unused: boolean;
	/** What it may reach on the network, as declared (`uses.network`): hosts, `config:<setting>` (the address in that setting), `*` (any site). */
	reach: string[];
	/** It declares network access (`uses.network`) or asked for its proxy: its requests can go through the proxy. */
	network: boolean;
	/** What it cannot work without and is not filled in yet: settings (paths, `servers`) and secret names. Empty for a plugin that is off. */
	needsSetup: string[];
	/** Its typed agent tools (`<id>_<name>`), and whether the owner lets the agent have them. */
	tools: string[];
	toolsOn: boolean;
	/** Its hooks run in trial (docs/plugins.md §8); `trialResult` is what they would have done. */
	trial: boolean;
	trialResult?: TrialSummary;
	/** `skills`: a skill pack. */
	kind: "plugin" | "skills";
	/** Installed by the owner, and from where. */
	source?: PluginSource;
	/** Approved or updated: its code is loaded at the next restart. */
	restartNeeded: boolean;
	/** A staged update waiting for the owner's approval. */
	update?: { version: string };
	skills: string[];
	/** Its setup skill (`setup-<id>`): when the owner switches it on, the agent offers the walkthrough. */
	setup?: string;
	/** Present when it takes part in `agent.prompt`: whether its sections reach background jobs too (off unless the owner allows it). */
	jobPrompt?: boolean;
	/** Present when it uses the owner's models: its budget and what it spent today (docs/plugins.md §10.2). */
	model?: PluginModelState;
	/** Where its code runs now: the owner's choice, else its manifest's (`runtimeDefault`). `processAllowed`: it can run in a process of its own (docs/plugins.md §11.7). */
	runtime: PluginRuntime;
	runtimeDefault: PluginRuntime;
	processAllowed: boolean;
	/** The screen it ships, in the owner's language; shown while it runs (docs/plugins.md §16, phase 8). */
	screen?: { title: string };
	/** Its own checks' last results (Doctor or "Test connection"), kept until it restarts; absent: not tested since. */
	lastCheck?: { at: string; results: Check[] };
};

/**
 * A plugin's use of the owner's models today (docs/plugins.md §10.2). `spentUsd`: what its own model calls and
 * the agent turns of its jobs cost since local midnight. `reached`: its calls answer `unavailable` until midnight.
 * `roles`: those it may use; `unmetered`: no daily budget.
 */
export type PluginModelState = { budgetUsd: number; unmetered: boolean; roles: ModelRole[]; spentUsd: number; tokens: number; reached: boolean };

/** What the owner set for a plugin's model use; what is not set follows the manifest and `limits.plugin_daily_usd`. */
type PluginModelSettings = { daily_usd?: number; roles?: ModelRole[]; unmetered?: boolean };

/** What the generated settings form needs (docs/plugins.md §12.2). Never a secret's value. */
export type PluginSettingsView = {
	id: string;
	state: PluginState;
	/** The JSON Schema of its settings. Absent when it has none, or when it cannot be read before the plugin has run. */
	schema?: Record<string, unknown>;
	/** Its settings now, defaults filled in. */
	values: Record<string, unknown>;
	/** The plugin's own strings for the form in the asked language: `settings.*`, `buttons.*` and `secrets.*`. */
	strings: Record<string, string>;
	/** One row per secret; for a secret declared per list entry, one per entry (`entry`: its index). */
	secrets: { name: string; key: string; set: boolean; managed: boolean; required: boolean; per?: string; entry?: number }[];
	/** Secrets declared per entry of a list setting, so a new entry gets its fields. */
	perEntry: { per: string; name: string; required: boolean }[];
	/** Buttons: operations of the plugin, full names. */
	buttons: string[];
	note?: string;
};

export type PluginConfigureResult = PluginActionResult & { errors?: { path: string; message: string }[] };

/** What `plugin_inspect` reads (docs/plugins.md §10.6): the catalogue and the live state. */
export type PluginInspection = Record<string, unknown>;

/**
 * `needs_confirmation`: nothing was done; `dependents` stop too if the owner confirms. `saved-restart-needed`:
 * done, and code is loaded at the next restart; `next` says how to restart.
 */
export type PluginActionResult = { id: string; result: "applied" | "failed" | "needs_confirmation" | "saved-restart-needed"; state: PluginState; next: string; dependents?: string[] };

/** What the running server's plugin manager offers to operations (docs/plugins.md §5.3). */
export type PluginControl = {
	list(): PluginInfo[];
	enable(id: string): Promise<PluginActionResult>;
	disable(id: string, options?: { withDependents?: boolean }): Promise<PluginActionResult>;
	settings(id: string, lang: Language): PluginSettingsView;
	configure(id: string, settings: unknown, secrets?: Record<string, string | null>, origins?: Record<string, (number | null)[]>): Promise<PluginConfigureResult>;
	inspect(id?: string): PluginInspection;
	/** What a declared secret is, in the owner's language. */
	secretLabel(key: string): string | undefined;
	/** Fetch, check and put in place a plugin from a pinned source; it is `installed` and off until approved (§13.3). */
	install(source: string): Promise<PluginReview>;
	/** The approval screen of a plugin that waits for the owner: new, changed, or with a staged update. */
	review(id: string): PluginReview;
	/** The owner approves exactly what `review` showed (`hash`). */
	approve(id: string, hash: string, by: string): Promise<PluginActionResult>;
	/** Removes the code; settings, secrets and stored data only when `deleteData` (§12.4). */
	uninstall(id: string, deleteData: boolean): Promise<PluginActionResult & { deleted: boolean }>;
	checkUpdates(id?: string): Promise<PluginUpdates[]>;
	/** Fetch and stage a newer version; it replaces the running one only when approved. */
	update(id: string, to?: string): Promise<PluginReview>;
	/** The skill folders of running plugins and skill packs, each folder named explicitly (docs/plugins.md §10.7). */
	skillFolders(): { plugin: string; dirs: string[] }[];
	/** The agent (or the owner) asks the owner to install a plugin from a folder; nothing is installed (docs/plugins.md §16, phase 7). */
	propose(folder: string, by: string, note?: string): Promise<PluginProposalView>;
	/** A proposal's approval screen: the manifest's declarations, the files and the difference. */
	proposal(id: string): Promise<PluginReview>;
	/** The owner approves exactly what `proposal` showed (`hash`), which installs it as a folder and approves it; or declines. */
	decideProposal(id: string, approve: boolean, hash: string | undefined, by: string): Promise<PluginActionResult>;
	/** One line per running plugin that describes its state (`reelix.describe`), its settings filled in; never a secret's value. */
	describe(): { plugin: string; line: string }[];
	/** Settings that environment variables fill at start (`reelix.env`), by their full path. */
	envSettings(): { plugin: string; variable: string; path: string }[];
	/** The owner chooses where a plugin's code runs; a running plugin starts again there (docs/plugins.md §11.7). */
	setRuntime(id: string, runtime: PluginRuntime): Promise<PluginActionResult>;
	/** A running plugin's screen, as one document for a sandboxed frame (docs/plugins.md §16, phase 8). */
	screen(id: string, lang: Language): { title: string; html: string };
};

const TOOLS_OFF_KEY = "plugins.tools_off";
const JOB_PROMPT_KEY = "plugins.job_prompt";
const MODEL_KEY = "plugins.model";

const modelSettings = (app: Reelix): Record<string, PluginModelSettings> => json(kvGet(app.db, MODEL_KEY), {});

/**
 * A plugin's budget, roles and spend today. `asked`: what its manifest asks for, which is what it gets until the
 * owner decides otherwise; `background` is always allowed.
 */
export function pluginModelState(app: Reelix, id: string, asked: { roles: ModelRole[]; unmetered: boolean }): PluginModelState {
	const own = modelSettings(app)[id] ?? {};
	const budgetUsd = own.daily_usd ?? app.config.limits.plugin_daily_usd;
	const unmetered = own.unmetered ?? asked.unmetered;
	const roles = [...new Set<ModelRole>(["background", ...(own.roles ?? asked.roles)])];
	const { usd, tokens } = spentToday(app, `plugin:${id}`);
	return { budgetUsd, unmetered, roles, spentUsd: usd, tokens, reached: !unmetered && usd >= budgetUsd };
}

/**
 * A settings value with the defaults of a JSON Schema filled in, the way the plugin will see it. Works on
 * a schema read from a file, which TypeBox's own `Value.Default` does not.
 */
export function withSchemaDefaults(schema: unknown, value: unknown): unknown {
	const s = schema as { type?: string; default?: unknown; properties?: Record<string, unknown>; items?: unknown } | undefined;
	if (value === undefined && s && "default" in s) value = structuredClone(s.default);
	if (s?.type === "object" && s.properties && typeof value === "object" && value !== null && !Array.isArray(value)) {
		const out = { ...(value as Record<string, unknown>) };
		for (const [k, sub] of Object.entries(s.properties)) {
			const v = withSchemaDefaults(sub, out[k]);
			if (v !== undefined) out[k] = v;
		}
		return out;
	}
	if (s?.type === "array" && s.items && Array.isArray(value)) return value.map((v) => withSchemaDefaults(s.items, v));
	return value;
}

/** Plugins whose typed tools the owner switched off (docs/plugins.md §6.1). */
export const typedToolsOff = (app: Reelix): string[] => json<string[]>(kvGet(app.db, TOOLS_OFF_KEY), []);

/** Plugins whose `agent.prompt` sections the owner lets into background jobs (docs/plugins.md §8). */
export const jobPromptPlugins = (app: Reelix): string[] => json<string[]>(kvGet(app.db, JOB_PROMPT_KEY), []);

/** Whether a secret is one a plugin declares (docs/plugins.md §12.2). */
export const pluginSecret = (app: Reelix, key: string): boolean => !!app.plugins?.list().some((p) => p.secrets.includes(key));

/** Whether the agent may ask the owner for this secret: one Reelix or a plugin names, never the web login. */
export const askableSecret = (app: Reelix, key: string): boolean => !key.startsWith("web.") && (Object.hasOwn(KNOWN_SECRETS, key) || pluginSecret(app, key));

function control(app: Reelix): PluginControl {
	if (!app.plugins) throw new ReelixError("needs_server", "Plugins run inside the Reelix server, and this needs the running server. Start it with `reelix serve`.");
	return app.plugins;
}

const actionText = (o: PluginActionResult) => (o.result === "needs_confirmation" ? o.next : `${o.id}: ${o.result === "failed" ? "failed" : o.result === "saved-restart-needed" ? "saved, restart needed" : o.state}. ${o.next}`);

const yes = (b: boolean) => (b ? "yes" : "no");

/** "release-tags ^0.1.0 (off, 0.1.0)" */
export const requirementText = (q: PluginRequirement) => `${q.id} ${q.range} (${q.version === undefined ? "not installed" : `${q.state}, ${q.version}`})`;

/** The approval screen as text, for the terminal (docs/plugins.md §11.1). The web app shows the same data. */
export function reviewText(r: PluginReview): string {
	const d = r.declarations;
	const list = (label: string, items: string[]) => (items.length ? [`  ${label}: ${items.join(", ")}`] : []);
	const lines = [
		`${r.what === "update" ? "Update" : r.what === "changed" ? "Changed files" : r.what === "proposal" ? `Proposed by ${r.proposal!.by} (proposal ${r.proposal!.id}, ${r.proposal!.status})` : "Install"}: ${d.id} ${d.version}${r.from ? ` (now ${r.from.version})` : ""}${d.kind === "skills" ? " — a skill pack" : ""}`,
		`  from ${r.source.kind} ${r.source.location}${r.source.pin ? ` @ ${r.source.pin}` : ""}`,
		d.description ? `  ${d.description}` : "",
		d.kind === "plugin" ? (d.runtime === "process" ? "  Its code runs in a process of its own, with only its context. Node keeps it from Reelix's data folder, database and secrets, from starting programs and from compiled addons; Reelix's code in that process keeps it off the network except through Reelix, to the hosts it declares. That holds a careless plugin, not yet a hostile one (docs/plugins.md §11.7)." : `  Its code runs inside Reelix and can do anything Reelix can. What it declares below is the author's claim, not a limit.${d.processAllowed ? " You can run it in a process of its own on its plugin page." : ""}`) : "",
		...list("provides", d.provides),
		...list("requires", d.requires),
		...list("requires plugins", r.requirements.map((q) => `${q.id} ${q.range} (${q.version === undefined ? "not installed" : `${q.satisfied ? "has" : "has only"} ${q.version}, ${q.state}`})`)),
		...list("owns", d.owns),
		...list("hooks", d.hooks),
		...list("events", d.events),
		...list("operations", d.operations.map((o) => `${o.name} (${o.effect}${o.tool ? `, agent tool ${o.tool}` : ""})`)),
		...list("jobs", d.jobs),
		...list("runs core operations", d.runs),
		...list("network", d.network.map((n) => (n === "*" ? "any site on the internet" : n))),
		...list("secrets", d.secrets),
		...list("skills", d.skills),
		...(d.scripts.length ? [`  contains scripts the agent may run: ${d.scripts.join(", ")}`] : []),
		...(d.kind === "plugin" ? [`  background agent turns: ${yes(d.agent)}; Inbox and proposals: ${yes(d.inbox)}; the owner's model: ${yes(d.model)}${d.modelRoles.length ? ` (also the roles ${d.modelRoles.join(", ")})` : ""}${d.unmetered ? "; asks to run without a daily budget" : ""}; raw pi extension (advanced): ${yes(d.pi)}; compiled dependencies: ${yes(d.native)}`] : []),
		...list("compiled code found (ready-made binaries; nothing is compiled here)", r.nativeFound),
		...list("install scripts (never run)", r.scriptsNotRun),
		...(d.kind === "plugin" ? [`  runs: ${d.runtime === "process" ? "in a process of its own" : "inside Reelix"}${d.processAllowed ? "" : " (it cannot run in a process of its own: it has a raw pi extension or compiled dependencies)"}`] : []),
		...(d.screen ? [`  a screen: ${d.screen} (shown in a sandboxed frame)`] : []),
	];
	if (r.diff) {
		const diff = r.diff;
		lines.push("  What changed in its declarations:");
		for (const [k, v] of Object.entries(diff.added)) lines.push(`    new ${k}: ${v.join(", ")}`);
		for (const [k, v] of Object.entries(diff.removed)) lines.push(`    no longer ${k}: ${v.join(", ")}`);
		for (const e of diff.effects) lines.push(`    ${e.operation}: ${e.from ? `${e.from} -> ` : "new, "}${e.to}`);
		if (diff.flags.length) lines.push(`    now also: ${diff.flags.join(", ")}`);
		if (!Object.keys(diff.added).length && !Object.keys(diff.removed).length && !diff.effects.length && !diff.flags.length) lines.push("    nothing");
	}
	if (r.changelog) lines.push("  Changelog (from the author):", ...r.changelog.split("\n").slice(0, 40).map((l) => `    ${l}`));
	if (r.proposal) {
		const p = r.proposal;
		if (p.note) lines.push(`  The proposer's note: ${outsideLine(p.note, 1_000)}`);
		lines.push(`  Files${p.diffFrom ? ` (compared with proposal ${p.diffFrom})` : ""}:`, ...p.files.map((f) => `    ${f.change.padEnd(7)} ${f.path} (${f.size} bytes)`));
		lines.push(`  Approve with: reelix plugin proposal_decide ${p.id} ${r.hash} --approve`, "  Difference:", p.diff || "    (none)");
	}
	return lines.filter(Boolean).join("\n");
}

const Source = Type.String({ description: "a pinned source: a folder path; a git URL with #<full commit id> (git+https://…/repo.git#<40 hex>); npm:<name>@<exact version>" });

defineOperation({
	name: "plugin.list",
	summary: "The plugins of this Reelix: state, version, what each runs, last error",
	effect: "read",
	input: Type.Object({}),
	async run(ctx) {
		return control(ctx.app).list();
	},
	toText: (o: PluginInfo[]) => o.map((p) => `${p.id} ${p.version} | ${p.state}${p.waitingFor.length || p.waitingForPlugins.length ? ` | waiting for ${[...p.waitingFor, ...p.waitingForPlugins.map(requirementText)].join(", ")}` : ""}${p.error ? ` | ${p.error}` : ""}`).join("\n") || "No plugins.",
});

defineOperation({
	name: "plugin.enable",
	summary: "Switch a plugin on (takes effect at once)",
	effect: "admin",
	input: Type.Object({ id: Type.String() }),
	positional: ["id"],
	async run(ctx, i) {
		return control(ctx.app).enable(i.id);
	},
	toText: actionText,
});

defineOperation({
	name: "plugin.disable",
	summary: "Switch a plugin off (takes effect at once, stays off after a restart). If others depend on it, says who; with_dependents switches them off too",
	effect: "admin",
	input: Type.Object({ id: Type.String(), with_dependents: Type.Optional(Type.Boolean()) }),
	positional: ["id"],
	async run(ctx, i) {
		return control(ctx.app).disable(i.id, { withDependents: i.with_dependents });
	},
	toText: actionText,
});

const PluginId = Type.String({ description: "plugin id, from plugin.list" });

defineOperation({
	name: "plugin.settings",
	summary: "A plugin's settings form: its schema, current values, declared secrets (set or not, never the value) and buttons",
	effect: "read",
	input: Type.Object({ id: PluginId, lang: Type.Optional(Type.String({ description: "language of the labels: en, zh, fr or ru; default the owner's" })) }),
	positional: ["id"],
	async run(ctx, i) {
		const lang = (LANGUAGES as readonly string[]).includes(i.lang ?? "") ? (i.lang as Language) : (ctx.app.config.language ?? "en");
		return control(ctx.app).settings(i.id, lang);
	},
	toText: (o: PluginSettingsView) => [`${o.id} (${o.state})`, JSON.stringify(o.values, null, 1), ...o.secrets.map((s) => `secret ${s.key}: ${s.set ? "set" : "missing"}`), o.note ?? ""].filter(Boolean).join("\n"),
});

defineOperation({
	name: "plugin.configure",
	summary: "Replace a plugin's settings, checked against its schema; the plugin starts again with them",
	effect: "admin",
	input: Type.Object({
		id: PluginId,
		settings: Type.Optional(Type.Unknown({ description: "the whole settings object" })),
		secrets: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), { description: "owner only (the web form): secrets by name, a value or null to remove; stored with the settings, one restart" })),
		origins: Type.Optional(Type.Record(Type.String(), Type.Array(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])), { description: "for a list with a secret per entry: each entry's index before the change, null for a new one" })),
	}),
	positional: ["id"],
	recordInput: (i) => ({ ...i, ...(i.secrets ? { secrets: Object.fromEntries(Object.keys(i.secrets).map((k) => [k, i.secrets![k] === null ? null : "[secret]"])) } : {}) }),
	async run(ctx, i) {
		return control(ctx.app).configure(i.id, i.settings, i.secrets, i.origins);
	},
	toText: (o: PluginConfigureResult) => [actionText(o), ...(o.errors ?? []).map((e) => `${e.path}: ${e.message}`)].join("\n"),
});

type HookView = { hook: HookId; mode: string; plugins: { plugin: string; trial: boolean }[] };
const hookViews = (app: Reelix): HookView[] => HOOK_DECLARATIONS.map((h) => ({ hook: h.id, mode: h.mode, plugins: app.hooks.participants(h.id) })).filter((h) => h.plugins.length);

defineOperation({
	name: "plugin.hooks",
	summary: "The hooks plugins take part in, each with its plugins in the order they run, and which are in trial",
	effect: "read",
	input: Type.Object({}),
	async run(ctx) {
		return hookViews(ctx.app);
	},
	toText: (o: HookView[]) => o.map((h) => `${h.hook} (${h.mode}): ${h.plugins.map((p) => `${p.plugin}${p.trial ? " [trial]" : ""}`).join(" → ")}`).join("\n") || "No plugin takes part in a hook.",
});

defineOperation({
	name: "plugin.hook_order",
	summary: "Set the order in which plugins run in one hook (it matters for pipeline hooks)",
	effect: "admin",
	input: Type.Object({ hook: Type.String({ description: "e.g. release.rank@1" }), plugins: Type.Array(Type.String(), { description: "plugin ids, first runs first" }) }),
	positional: ["hook"],
	async run(ctx, i) {
		setHookOrder(ctx.app, i.hook as HookId, i.plugins);
		return { hooks: hookViews(ctx.app), next: tr(ctx.app, "plugins.orderSaved") };
	},
	toText: (o: { next: string }) => o.next,
});

defineOperation({
	name: "plugin.trial",
	summary: "Run a plugin's hooks in trial (record what they would change, apply nothing), or end the trial",
	effect: "admin",
	input: Type.Object({ id: PluginId, on: Type.Boolean() }),
	positional: ["id"],
	async run(ctx, i) {
		if (!control(ctx.app).list().some((p) => p.id === i.id)) throw new ReelixError("unknown_plugin", `There is no plugin "${i.id}".`);
		setTrial(ctx.app, i.id, i.on);
		return { id: i.id, trial: trialPlugins(ctx.app).includes(i.id), next: tr(ctx.app, i.on ? "plugins.trialOn" : "plugins.trialOff") };
	},
	toText: (o: { id: string; next: string }) => `${o.id}: ${o.next}`,
});

defineOperation({
	name: "plugin.tools",
	summary: "Let the agent have a plugin's typed tools, or not (its operations stay reachable through the reelix tool)",
	effect: "admin",
	input: Type.Object({ id: PluginId, on: Type.Boolean() }),
	positional: ["id"],
	async run(ctx, i) {
		if (!control(ctx.app).list().some((p) => p.id === i.id)) throw new ReelixError("unknown_plugin", `There is no plugin "${i.id}".`);
		const rest = typedToolsOff(ctx.app).filter((p) => p !== i.id);
		kvSet(ctx.app.db, TOOLS_OFF_KEY, JSON.stringify(i.on ? rest : [...rest, i.id]));
		return { id: i.id, toolsOn: i.on, next: tr(ctx.app, i.on ? "plugins.toolsOn" : "plugins.toolsOff") };
	},
	toText: (o: { id: string; next: string }) => `${o.id}: ${o.next}`,
});

defineOperation({
	name: "plugin.runtime",
	summary: "Run a plugin inside Reelix or in a process of its own (only its context, none of Reelix's files); it starts again there",
	effect: "admin",
	input: Type.Object({ id: PluginId, runtime: Type.Union([Type.Literal("in-process"), Type.Literal("process")]) }),
	positional: ["id", "runtime"],
	async run(ctx, i) {
		return control(ctx.app).setRuntime(i.id, i.runtime);
	},
	toText: actionText,
});

defineOperation({
	name: "plugin.inspect",
	summary: "What plugins can do and what they do now: seams and providers, hooks, events, context calls, operations, a plugin's state, last error and settings schema",
	effect: "read",
	tool: "plugin_inspect",
	input: Type.Object({ id: Type.Optional(Type.String({ description: "a plugin id for its details; leave out for the catalogue and the list" })) }),
	positional: ["id"],
	async run(ctx, i) {
		return control(ctx.app).inspect(i.id);
	},
	toText: (o: PluginInspection) => JSON.stringify(o, null, 1),
});

defineOperation({
	name: "plugin.install",
	summary: "Install a plugin or skill pack from a pinned source. It stays off until the owner approves what it declares (plugin.approve)",
	effect: "admin",
	input: Type.Object({ source: Source }),
	positional: ["source"],
	async run(ctx, i) {
		return control(ctx.app).install(i.source);
	},
	toText: reviewText,
});

defineOperation({
	name: "plugin.review",
	summary: "The approval screen of a plugin that waits for the owner (new, changed files, or a staged update): what it declares, from its manifest only",
	effect: "read",
	input: Type.Object({ id: PluginId }),
	positional: ["id"],
	async run(ctx, i) {
		return control(ctx.app).review(i.id);
	},
	toText: reviewText,
});

defineOperation({
	name: "plugin.approve",
	summary: "Approve what plugin.review showed (its hash): a new plugin, changed files, or a staged update. Code is loaded at the next restart",
	effect: "admin",
	input: Type.Object({ id: PluginId, hash: Type.String({ description: "the hash plugin.review showed" }) }),
	positional: ["id", "hash"],
	async run(ctx, i) {
		return control(ctx.app).approve(i.id, i.hash, ctx.actor);
	},
	toText: actionText,
});

defineOperation({
	name: "plugin.uninstall",
	summary: "Uninstall a plugin the owner installed: its code goes; its settings, secrets and stored data are kept unless delete_data",
	effect: "admin",
	input: Type.Object({ id: PluginId, delete_data: Type.Optional(Type.Boolean({ description: "also delete its settings, secrets and stored data" })) }),
	positional: ["id"],
	async run(ctx, i) {
		return control(ctx.app).uninstall(i.id, i.delete_data === true);
	},
	toText: actionText,
});

defineOperation({
	name: "plugin.check_updates",
	summary: "Look for newer versions of installed plugins (git: the remote's newest commit and tags; npm: the registry's versions). Installs nothing",
	effect: "admin",
	input: Type.Object({ id: Type.Optional(PluginId) }),
	positional: ["id"],
	async run(ctx, i) {
		return control(ctx.app).checkUpdates(i.id);
	},
	toText: (o: PluginUpdates[]) =>
		o.map((u) => `${u.id} ${u.version}: ${u.error ? `could not check: ${u.error}` : u.available.length ? u.available.map((a) => `${a.label} (reelix plugin update ${u.id} ${a.to})`).join("; ") : "up to date"}`).join("\n") || "No installed plugins.",
});

defineOperation({
	name: "plugin.update",
	summary: "Fetch and stage a newer version (git: a full commit id; npm: an exact version; a folder: copied again). Shows the changelog and what changed in its declarations; runs only once approved",
	effect: "admin",
	input: Type.Object({ id: PluginId, to: Type.Optional(Type.String({ description: "from plugin.check_updates" })) }),
	positional: ["id", "to"],
	async run(ctx, i) {
		return control(ctx.app).update(i.id, i.to);
	},
	toText: reviewText,
});

defineOperation({
	name: "plugin.propose",
	summary: "Ask the owner to install a plugin you wrote (after `reelix plugin check <folder>` passed). Installs nothing: the owner sees what it declares, its files and the difference, and decides",
	description: "The folder is copied as it is now; later changes to it are not part of the proposal. A new proposal of the same plugin replaces the open one. It has no dependencies of its own.",
	effect: "write",
	input: Type.Object({ folder: Type.String({ description: "the plugin's folder: absolute, or relative to the agent's workspace" }), note: Type.Optional(Type.String({ maxLength: 1_000, description: "for the owner: what it does and why" })) }),
	positional: ["folder"],
	async run(ctx, i) {
		// A request, not an install: the agent and the owner may make one; a plugin may not.
		if (ctx.actor.startsWith("plugin:")) throw new ReelixError("not_allowed", "A plugin cannot propose plugins.");
		return control(ctx.app).propose(i.folder, ctx.actor, i.note);
	},
	toText: (o: PluginProposalView) => `Proposed ${o.plugin} ${o.version} as ${o.id}: it waits in the owner's Inbox. Nothing is installed until the owner approves it; you cannot approve it. ${o.files.length} files${o.diffFrom ? `, compared with ${o.diffFrom}` : ""}.`,
});

defineOperation({
	name: "plugin.proposal",
	summary: "A proposed plugin's approval screen: what its manifest declares, its files and the difference to its previous proposal",
	effect: "read",
	input: Type.Object({ id: Type.String({ description: "the proposal id (pp_…)" }) }),
	positional: ["id"],
	async run(ctx, i) {
		return control(ctx.app).proposal(i.id);
	},
	toText: reviewText,
});

defineOperation({
	name: "plugin.proposal_decide",
	summary: "Approve a proposed plugin (exactly what plugin.proposal showed: its hash), which installs it from its copy; or decline it. Code is loaded at the next restart",
	effect: "admin",
	input: Type.Object({ id: Type.String(), approve: Type.Boolean(), hash: Type.Optional(Type.String({ description: "the hash plugin.proposal showed; needed to approve" })) }),
	positional: ["id", "hash"],
	async run(ctx, i) {
		return control(ctx.app).decideProposal(i.id, i.approve, i.hash, ctx.actor);
	},
	toText: actionText,
});

defineOperation({
	name: "plugin.job_prompt",
	summary: "Let a plugin's agent.prompt sections into background jobs too, or not (they are left out unless the owner allows it)",
	effect: "admin",
	input: Type.Object({ id: PluginId, on: Type.Boolean() }),
	positional: ["id"],
	async run(ctx, i) {
		const p = control(ctx.app).list().find((x) => x.id === i.id);
		if (!p) throw new ReelixError("unknown_plugin", `There is no plugin "${i.id}".`);
		if (p.jobPrompt === undefined) throw new ReelixError("not_applicable", `${i.id} adds nothing to the agent's prompt.`);
		const rest = jobPromptPlugins(ctx.app).filter((x) => x !== i.id);
		kvSet(ctx.app.db, JOB_PROMPT_KEY, JSON.stringify(i.on ? [...rest, i.id] : rest));
		return { id: i.id, jobPrompt: i.on, next: tr(ctx.app, i.on ? "plugins.jobPromptOn" : "plugins.jobPromptOff") };
	},
	toText: (o: { id: string; next: string }) => `${o.id}: ${o.next}`,
});

defineOperation({
	name: "plugin.model",
	summary: "Set a plugin's use of the owner's models: its daily budget in US dollars, the roles it may use besides background, or no daily budget at all",
	effect: "admin",
	input: Type.Object({
		id: PluginId,
		daily_usd: Type.Optional(Type.Number({ minimum: 0, description: "the daily budget; it resets at local midnight" })),
		roles: Type.Optional(Type.Array(Type.Union(MODEL_ROLES.map((r) => Type.Literal(r))), { description: "roles it may use; background is always allowed" })),
		unmetered: Type.Optional(Type.Boolean({ description: "no daily budget (translation's exemption from the cap)" })),
	}),
	positional: ["id"],
	async run(ctx, i) {
		const p = control(ctx.app).list().find((x) => x.id === i.id);
		if (!p) throw new ReelixError("unknown_plugin", `There is no plugin "${i.id}".`);
		if (!p.model) throw new ReelixError("not_applicable", `${i.id} does not use the owner's models.`);
		const all = modelSettings(ctx.app);
		const own = { ...all[i.id] };
		if (i.daily_usd !== undefined) own.daily_usd = i.daily_usd;
		if (i.roles !== undefined) own.roles = i.roles.filter((r) => r !== "background");
		if (i.unmetered !== undefined) own.unmetered = i.unmetered;
		kvSet(ctx.app.db, MODEL_KEY, JSON.stringify({ ...all, [i.id]: own }));
		const now = control(ctx.app).list().find((x) => x.id === i.id)!.model!;
		return { id: i.id, model: now, next: tr(ctx.app, now.unmetered ? "plugins.modelSetUnmetered" : "plugins.modelSet", { usd: now.budgetUsd, roles: now.roles.join(", ") }) };
	},
	toText: (o: { id: string; next: string }) => `${o.id}: ${o.next}`,
});

/** A card kind a plugin registered. Its buttons name the plugin's operations by short name. */
export type PluginCardKind = CardLayout & { plugin: string };

const CARD_ROWS = 50;

/** A plugin card as the web app and chat apps show it: plain text only, built by Reelix from the declaration (§12.3). */
export type PluginCard = {
	kind: "plugin";
	card: string;
	plugin: string;
	layout: "list" | "text";
	title: string;
	rows?: { primary: string; secondary?: string }[];
	more?: number;
	text?: string;
	empty?: string;
	buttons: { label: string; index: number }[];
};

/** The card an operation's result is shown in, when its plugin declared one. */
export function pluginCard(app: Reelix, operation: string, output: unknown): PluginCard | undefined {
	const op = app.operations.get(operation);
	const kind = op?.card ? app.cards.get(op.card) : undefined;
	if (!op?.card || !kind) return undefined;
	const o = (output ?? {}) as Record<string, unknown>;
	const line = (v: unknown, n: number) => outsideLine(app.redact(typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v)), n);
	const base = { kind: "plugin" as const, card: op.card, plugin: kind.plugin, layout: kind.layout, title: line(kind.title, 120), buttons: (kind.buttons ?? []).map((b, index) => ({ label: line(b.label, 60), index })) };
	if (kind.layout === "text") return { ...base, text: app.redact(String(o[kind.text] ?? "")).slice(0, 4_000) };
	const list = Array.isArray(o[kind.items]) ? (o[kind.items] as Record<string, unknown>[]) : [];
	const rows = list.slice(0, CARD_ROWS).map((r) => ({ primary: line(r?.[kind.primary], 200), secondary: kind.secondary && r?.[kind.secondary] !== undefined ? line(r[kind.secondary], 300) : undefined }));
	return { ...base, rows, more: list.length > CARD_ROWS ? list.length - CARD_ROWS : undefined, empty: kind.empty ? line(kind.empty, 200) : undefined };
}

defineOperation({
	name: "plugin.press",
	summary: "Press a button on a plugin's card: runs the plugin's operation it names, as the plugin",
	effect: "write",
	input: Type.Object({ card: Type.String({ description: "<plugin>.<kind>" }), button: Type.Integer({ minimum: 0 }) }),
	async run(ctx, i) {
		const kind = ctx.app.cards.get(i.card);
		const button = kind?.buttons?.[i.button];
		if (!kind || !button) throw new ReelixError("not_found", "That button is not available now; its plugin may be off.");
		const operation = `${kind.plugin}.${button.operation}`;
		// As the plugin: a destructive operation is refused here, so it has to go through a proposal (§12.3).
		const r = await runOperation(ctx.app, operation, button.input ?? {}, { actor: `plugin:${kind.plugin}`, requestId: `${ctx.requestId}:press` });
		return { operation, text: r.text, output: r.output, card: pluginCard(ctx.app, operation, r.output) };
	},
	toText: (o: { text: string }) => o.text,
});
