import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { type PluginDefinition, SETTINGS, type SeamId, outsideLine } from "@reelix/plugin";
import { Value } from "typebox/value";
import {
	type Catalog,
	HOOK_DECLARATIONS,
	type Language,
	type Messages,
	PLUGIN_EVENTS,
	type PluginActionResult,
	type PluginConfigureResult,
	type PluginControl,
	type PluginInfo,
	type PluginInspection,
	type PluginProposalView,
	type PluginRequirement,
	type PluginReview,
	type PluginRuntime,
	type PluginSettingsView,
	type PluginState,
	type PluginUpdates,
	type Reelix,
	ReelixError,
	SEAM_DECLARATIONS,
	addInbox,
	dismissInbox,
	applyEnvDefaults,
	errorMessage,
	expireProposals,
	getPath,
	jobPromptPlugins,
	json,
	kvGet,
	kvSet,
	messageFrom,
	ownerLanguage,
	pluginModelState,
	recordAnswer,
	requirementText,
	sameData,
	setTrial,
	trialPlugins,
	trialSummary,
	tr,
	typedToolsOff,
	withSchemaDefaults,
} from "@reelix/core";
import { ChatBridge, type ChatHost } from "../chat.ts";
import { ISOLATION, pluginFolderAccess } from "../isolation.ts";
import type { JobRunner } from "../jobs.ts";
import { CONTEXT_CALLS, type ModelAccess, type Registered, createContext, jobKind, readsProxy, scheduleId } from "./context.ts";
import { type HttpTransport, realTransport } from "./http.ts";
import { type InstallRecord, Installer } from "./install.ts";
import { loadPlugin } from "./loader.ts";
import { type Manifest, type OwnedEventDeclaration, PLUGIN_API, REELIX_VERSION, declaredSecret, declarations, incompatibility, loadMessages, processAllowed, readManifest, skillNames } from "./manifest.ts";
import { type PluginProcess, startProcess } from "./process.ts";
import { ProposalStore } from "./proposed.ts";
import { PiExtensions } from "./pi.ts";
import { PluginRoutes } from "./routes.ts";
import { screenDocument } from "./screen.ts";
import { Scope } from "./scope.ts";
import { satisfies } from "./semver.ts";

const DISABLED_KEY = "plugins.disabled";
const ENABLED_KEY = "plugins.enabled";
const TOOLS_OFF_KEY = "plugins.tools_off";
const JOB_PROMPT_KEY = "plugins.job_prompt";
const MODEL_KEY = "plugins.model";
/** The owner's choice of runtime, by plugin id (docs/plugins.md §11.7). */
const RUNTIME_KEY = "plugins.runtime";
/** A plugin's process that ran this long was healthy: after its next crash it starts again after the first delay. */
const PROCESS_HEALTHY_MS = 60_000;
const PROCESS_MAX_DELAY_MS = 120_000;
const STOP_GRACE_MS = 10_000;
const ACTIVATE_TIMEOUT_MS = 30_000;
const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_MS = 10 * 60_000;
const TASK_DELAY_MS = 2_000;
const HOOK_ORDER_INSTALLED = 1_000_000;
const PROPOSAL_SWEEP_MS = 60_000;
/** States of an installed plugin whose code is not loaded until the owner acts (§13.3, §13.4). */
const HELD: readonly PluginState[] = ["installed", "changed", "incompatible"];

type Schema = Record<string, unknown>;

/** The plugin's strings under these keys, flattened: `settings.servers.url`. */
function stringsUnder(messages: Messages | undefined, roots: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (node: unknown, prefix: string) => {
		if (typeof node === "string") out[prefix] = node;
		else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, `${prefix}.${k}`);
	};
	for (const root of roots) walk(messages?.[root], root);
	return out;
}

type Plugin = {
	id: string;
	dir: string;
	manifest?: Manifest;
	messages: Catalog;
	state: PluginState;
	error?: string;
	scope?: Scope;
	registered?: Registered;
	failures: Map<string, number[]>;
	noticeTimes: number[];
	builtIn: boolean;
	/** A reference plugin: off until the owner switches it on. */
	optIn: boolean;
	/** Its place among the plugins found. */
	found: number;
	/** The settings schema of the code that ran last, as JSON. */
	schema?: Schema;
	/** Installed by the owner into the data folder: hashed, approved, updated and uninstalled (§13). */
	installed: boolean;
	/** Approved or updated since start: the new code is loaded at the next restart. */
	restartNeeded: boolean;
	/** When it last started, how often its process ended in a row, and the restart that waits. */
	startedAt?: number;
	crashes: number;
	restart?: symbol;
};

type PluginManagerOptions = {
	app: Reelix;
	jobs: JobRunner;
	/** The agent side of chat channels. */
	host: ChatHost;
	/** Folders holding one folder per plugin; `examples` inside them holds plugins that start switched off. */
	dirs: string[];
	/** Single plugin folders, loaded as well. */
	plugins?: string[];
	/** Those of `dirs` shipped with Reelix: their providers' labels need no plugin name beside them. */
	builtInDirs?: string[];
	/** Where the owner's plugins are installed (`<data>/plugins`), and npm's cache for installing them. */
	install?: { dir: string; npmCache: string };
	transport?: HttpTransport;
	/** The owner's models (the server's router), for `ctx.model`. */
	model?: ModelAccess;
	/** Where plugins' routes and raw pi extensions go; the web server and the agent host read them. */
	routes?: PluginRoutes;
	pi?: PiExtensions;
	stopGraceMs?: number;
	/** The first wait before a task that ended, or a plugin's process that ended, is started again. */
	taskDelayMs?: number;
};

/** Finds, starts and stops plugins (docs/plugins.md §5.3, §7.11, §11.6). */
export class PluginManager implements PluginControl {
	private app: Reelix;
	private jobs: JobRunner;
	private options: PluginManagerOptions;
	private chat: ChatBridge;
	private stopGraceMs: number;
	private plugins = new Map<string, Plugin>();
	/** Starting and stopping happen one at a time. */
	private queue: Promise<unknown> = Promise.resolve();
	/** When a timeout last switched a plugin off: one incident takes at most one plugin (§11.6). */
	private lastTimeoutOff = 0;
	private proposalSweep?: NodeJS.Timeout;
	private installer?: Installer;
	private proposals?: ProposalStore;
	readonly routes: PluginRoutes;
	readonly pi: PiExtensions;
	/** Events plugins own, while their owner runs, and where they are emitted. */
	private ownedEvents = new Map<string, { plugin: string; declaration: OwnedEventDeclaration }>();
	private ownedEmitter = new EventEmitter().setMaxListeners(100);

	private onConfig = ({ paths }: { paths: string[] }) => this.settingsChanged(paths.flatMap((p) => /^plugins\.([^.]+)/.exec(p)?.[1] ?? []));
	private onEvent = (e: { type: string; keys?: unknown; byPlugin?: unknown }) => {
		// A plugin that stored a value itself already knows it.
		if (e.type === "secrets") this.settingsChanged((e.keys as string[]).flatMap((k) => /^plugins\.([^.]+)\./.exec(k)?.[1] ?? []).filter((id) => id !== e.byPlugin));
	};

	constructor(o: PluginManagerOptions) {
		this.app = o.app;
		this.jobs = o.jobs;
		this.options = o;
		this.stopGraceMs = o.stopGraceMs ?? STOP_GRACE_MS;
		this.chat = new ChatBridge(o.app, o.host);
		this.routes = o.routes ?? new PluginRoutes();
		this.pi = o.pi ?? new PiExtensions();
		if (o.install) {
			this.installer = new Installer({ root: o.install.dir, npmCache: o.install.npmCache, reservedWords: () => this.app.operations.reservedWords() });
			this.proposals = new ProposalStore({ root: join(o.install.dir, ".proposed"), reservedWords: () => this.app.operations.reservedWords() });
		}
	}

	start(): Promise<void> {
		return this.serial(async () => {
			this.installer?.clearScratch();
			this.discover();
			// Addresses docker-compose.yml passes, into empty settings of the plugins shipped with Reelix or named at start.
			const env = Object.fromEntries(this.envSettings().map((e) => [e.variable, e.path]));
			for (const a of applyEnvDefaults(this.app, env)) console.log(`Setting from the environment: ${a}`);
			const off = this.disabledIds();
			const on = this.enabledIds();
			for (const p of this.plugins.values()) {
				if (p.state === "failed" || p.state === "incompatible") continue;
				const held = this.heldState(p);
				if (held) p.state = held;
				else if (p.optIn ? !on.includes(p.id) : Object.hasOwn(off, p.id)) {
					p.state = "disabled";
					p.error = off[p.id] ?? undefined;
				} else p.state = "waiting";
			}
			this.refuseCycles();
			await this.settle();
			this.dropOrphans();
			for (const p of this.plugins.values()) console.log(`Plugin ${p.id}: ${p.state}${p.error ? ` (${p.error})` : ""}`);
			this.app.pluginEvents.on("config.changed", this.onConfig);
			this.app.events.on("event", this.onEvent);
			this.app.notifications.start();
			for (const p of this.plugins.values()) if (p.state === "active") this.app.notifications.catchUp(p.id);
			this.chat.start();
			// A plugin waiting on a proposal learns of its expiry (§10.3).
			this.proposalSweep = setInterval(() => expireProposals(this.app), PROPOSAL_SWEEP_MS);
			this.proposalSweep.unref();
		});
	}

	/** Reelix is shutting down: undo everything without waiting, and remember nothing. */
	stop(): Promise<void> {
		this.app.pluginEvents.off("config.changed", this.onConfig);
		this.app.events.off("event", this.onEvent);
		this.app.notifications.stop();
		this.chat.stop();
		clearInterval(this.proposalSweep);
		return this.serial(async () => {
			// Those that need another stop before it.
			for (const p of this.ordered().reverse()) await this.dispose(p, 0);
		});
	}

	list(): PluginInfo[] {
		const jobPrompt = jobPromptPlugins(this.app);
		return [...this.plugins.values()]
			.map((p) => {
				const record = p.installed ? this.installer?.get(p.id) : undefined;
				const skills = p.manifest?.uses.skills ? skillNames(p.dir) : [];
				return {
					id: p.id,
					version: p.manifest?.version ?? "",
					description: messageFrom(p.messages, ownerLanguage(this.app), "description") ?? p.manifest?.description ?? "",
					state: p.state,
					error: p.error,
					failures: [...p.failures.values()].reduce((n, times) => n + recent(times).length, 0),
					waitingFor: p.state === "waiting" ? this.missingSeams(p) : [],
					waitingForPlugins: p.state === "waiting" ? this.missingPlugins(p) : [],
					requires: Object.entries(p.manifest?.requires.plugins ?? {}).map(([rid, range]) => ({ id: rid, range })),
					owns: p.manifest ? [...Object.keys(p.manifest.owns.seams), ...Object.keys(p.manifest.owns.events)] : [],
					provides: p.manifest?.uses.provides ?? [],
					hooks: p.manifest?.uses.hooks ?? [],
					operations: (p.manifest?.uses.operations ?? []).map((o) => `${p.id}.${o}`),
					jobs: p.manifest?.uses.jobs ?? [],
					events: p.manifest?.uses.events ?? [],
					runs: p.manifest?.uses.runs ?? [],
					secrets: this.secretRows(p).filter((s) => !s.managed).map((s) => s.key),
					managedSecrets: this.secretRows(p).filter((s) => s.managed).map((s) => s.key),
					reach: p.manifest?.uses.network ?? [],
					network: (p.manifest?.uses.network.length ?? 0) > 0 || readsProxy.has(p.id),
					...this.setupState(p),
					tools: (p.manifest?.uses.tools ?? []).map((t) => `${p.id}_${t}`),
					toolsOn: !typedToolsOff(this.app).includes(p.id),
					trial: trialPlugins(this.app).includes(p.id),
					trialResult: p.manifest?.uses.hooks.length ? trialSummary(this.app, p.id) : undefined,
					kind: p.manifest && !p.manifest.entry ? ("skills" as const) : ("plugin" as const),
					source: record?.source,
					restartNeeded: p.restartNeeded,
					update: record?.update && { version: record.update.version },
					skills,
					setup: skills.includes(`setup-${p.id}`) ? `setup-${p.id}` : undefined,
					jobPrompt: p.manifest?.uses.hooks.includes("agent.prompt@1") ? jobPrompt.includes(p.id) : undefined,
					model: p.manifest?.uses.model ? this.modelState(p) : undefined,
					runtime: this.runtimeOf(p),
					runtimeDefault: p.manifest?.runtime ?? "in-process",
					processAllowed: !!p.manifest && processAllowed(p.manifest),
					screen: p.manifest?.screen && { title: messageFrom(p.messages, ownerLanguage(this.app), "screen.title") ?? p.manifest.screen.title },
					lastCheck: this.app.lastChecks.get(p.id),
				};
			})
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	private modelState(p: Plugin) {
		return pluginModelState(this.app, p.id, { roles: p.manifest?.uses.modelRoles ?? [], unmetered: p.manifest?.uses.unmetered ?? false });
	}

	/** The settings schema without running any code: the copy the manifest names, else what the running code declared (§12.2). */
	private schemaOf(p: Plugin): Schema | undefined {
		if (!p.manifest?.settings) return p.schema;
		this.assertApproved(p);
		return JSON.parse(readFileSync(join(p.dir, p.manifest.settings), "utf8")) as Schema;
	}

	/** An approved plugin's files are read only while they are what the owner approved (§13.3): checked again before each read. */
	private assertApproved(p: Plugin): void {
		if (!p.installed || !this.installer!.get(p.id)?.approved) return;
		if (this.heldState(p)) throw new ReelixError("changed", tr(this.app, "plugins.changedBody", { id: p.id }));
	}

	settings(id: string, lang: Language): PluginSettingsView {
		const p = this.get(id);
		const schema = this.schemaOf(p);
		const raw = structuredClone((this.app.config.plugins[id] ?? {}) as Record<string, unknown>);
		const roots = ["settings", "secrets", "buttons"];
		const strings = { ...stringsUnder(p.messages.en, roots), ...stringsUnder(p.messages[lang], roots) };
		const secrets = this.secretRows(p);
		const buttons = ((schema?.[SETTINGS.buttons] as string[] | undefined) ?? []).map((b) => `${id}.${b}`);
		const note = schema ? undefined : tr(this.app, p.state === "active" ? "plugins.noSettings" : "plugins.settingsLater");
		const perEntry = (p.manifest?.uses.secrets ?? []).flatMap((d) => (d.per ? [{ per: d.per, name: d.name, required: d.required }] : []));
		return { id, state: p.state, schema, values: schema ? (withSchemaDefaults(schema, raw) as Record<string, unknown>) : raw, strings, secrets, perEntry, buttons, note };
	}

	/** Its secrets as rows: one per declared secret, and for one declared per list entry, one per entry of the list now. */
	private secretRows(p: Plugin, settings?: Record<string, unknown>): PluginSettingsView["secrets"] {
		const values = settings ?? ((this.app.config.plugins[p.id] ?? {}) as Record<string, unknown>);
		return (p.manifest?.uses.secrets ?? []).flatMap((d) => {
			const row = (name: string, entry?: number) => {
				const key = `plugins.${p.id}.${name}`;
				return { name: d.name, key, set: !!this.app.secrets[key], managed: d.managed, required: d.required, ...(d.per ? { per: d.per, entry } : {}) };
			};
			if (!d.per) return [row(d.name)];
			const list = Array.isArray(values[d.per]) ? (values[d.per] as unknown[]) : [];
			return list.map((_, i) => row(`${d.per}.${i}.${d.name}`, i));
		});
	}

	/** What a plugin that is on still needs; an optional one with nothing set up is unused instead (docs/settings.md, "States"). */
	private setupState(p: Plugin): { needsSetup: string[]; unused: boolean } {
		if (p.state === "disabled") return { needsSetup: [], unused: false };
		const { missing, required } = this.requiredSetup(p);
		return p.manifest?.optional && required > 0 && missing.length === required ? { needsSetup: [], unused: true } : { needsSetup: missing, unused: false };
	}

	/** Required settings (`x-reelix-required`) that are empty and required secrets that are missing, by name, and how many are required. */
	private requiredSetup(p: Plugin): { missing: string[]; required: number } {
		let schema: Schema | undefined;
		try {
			schema = this.schemaOf(p);
		} catch {
			return { missing: [], required: 0 };
		}
		const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
		const missing: string[] = [];
		let required = 0;
		const walk = (s: Schema | undefined, value: unknown, path: string[]) => {
			for (const [k, f] of Object.entries((s?.properties ?? {}) as Record<string, Schema>)) {
				const v = (value as Record<string, unknown> | undefined)?.[k];
				if (f[SETTINGS.required]) required++;
				if (f[SETTINGS.required] && empty(v)) missing.push([...path, k].join("."));
				if (f.type === "array" && Array.isArray(v)) v.forEach((entry, i) => walk(f.items as Schema | undefined, entry, [...path, k, String(i)]));
			}
		};
		const values = schema ? withSchemaDefaults(schema, structuredClone(this.app.config.plugins[p.id] ?? {})) : {};
		walk(schema, values, []);
		for (const r of this.secretRows(p, values as Record<string, unknown>).filter((x) => x.required)) {
			required++;
			if (!r.set) missing.push(r.key.slice(`plugins.${p.id}.`.length));
		}
		return { missing, required };
	}

	/**
	 * Replace a plugin's settings after checking them against its schema, and store its secrets with them; a running
	 * plugin starts again once (§5.3). `secrets`: by name as the plugin asks for it (`password`, `servers.1.api_key`),
	 * a value to store or null to remove. `origins`: for a list whose entries have their own secrets, where each entry
	 * was before the change (null: new), so a key follows its entry when one above it is removed.
	 */
	async configure(id: string, settings: unknown, secrets: Record<string, string | null> = {}, origins: Record<string, (number | null)[]> = {}): Promise<PluginConfigureResult> {
		const p = this.get(id);
		const schema = this.schemaOf(p);
		const declared = p.manifest?.uses.secrets ?? [];
		for (const name of Object.keys(secrets)) {
			const d = declaredSecret(declared, name);
			if (!d || d.managed) return { ...this.result(p, "failed", "plugins.invalidSettings"), errors: [{ path: `/secrets/${name}`, message: d ? "made by the plugin itself" : "not a secret of this plugin" }] };
		}
		let value: Record<string, unknown> | undefined;
		if (settings !== undefined) {
			if (!schema) return this.result(p, "failed", p.state === "active" ? "plugins.noSettings" : "plugins.settingsLater");
			if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return { ...this.result(p, "failed", "plugins.invalidSettings"), errors: [{ path: "/", message: "must be an object" }] };
			value = withSchemaDefaults(schema, structuredClone(settings)) as Record<string, unknown>;
			const errors = [...Value.Errors(schema, value)].map((e) => ({ path: (e as { instancePath?: string }).instancePath || "/", message: e.message }));
			if (errors.length) return { ...this.result(p, "failed", "plugins.invalidSettings"), errors };
		}
		// The keys of entries that moved go with them; those of removed entries go.
		const changes: Record<string, string | undefined> = {};
		for (const d of declared.filter((x) => x.per && origins[x.per])) {
			const key = (i: number) => `plugins.${id}.${d.per}.${i}.${d.name}`;
			const before = Object.keys(this.app.secrets).filter((k) => new RegExp(`^plugins\\.${id}\\.${d.per}\\.\\d+\\.${d.name}$`).test(k));
			for (const k of before) changes[k] = undefined;
			origins[d.per!]!.forEach((from, to) => {
				if (from !== null && this.app.secrets[key(from)]) changes[key(to)] = this.app.secrets[key(from)];
			});
		}
		for (const [name, v] of Object.entries(secrets)) changes[`plugins.${id}.${name}`] = v || undefined;
		const secretsChanged = Object.entries(changes).some(([k, v]) => this.app.secrets[k] !== v);
		// Stored without a restart of their own: the settings below restart the plugin, or the line after them does.
		if (secretsChanged) this.app.setSecrets(changes, id);
		const before = structuredClone(this.app.config.plugins[id] ?? null);
		if (value !== undefined) this.app.setConfig(`plugins.${id}`, value);
		if (secretsChanged && sameData(before, this.app.config.plugins[id] ?? null)) this.settingsChanged([id]);
		await this.serial(async () => undefined); // the restart the change started
		if (p.state === "disabled") return this.result(p, "applied", "plugins.configuredOff");
		if (p.state === "failed") return { ...this.result(p, "failed", "plugins.failedNext"), next: p.error ?? tr(this.app, "plugins.failedNext") };
		return this.result(p, "applied", "plugins.configured");
	}

	secretLabel(key: string): string | undefined {
		for (const p of this.plugins.values()) {
			const row = this.secretRows(p).find((s) => s.key === key);
			if (row) return messageFrom(p.messages, ownerLanguage(this.app), `secrets.${row.name}`) ?? `${p.id}: ${row.name}`;
		}
		return undefined;
	}

	/** For `plugin_inspect` (§10.6). What a plugin wrote itself is passed through as outside text. */
	inspect(id?: string): PluginInspection {
		const outside = (text: string | undefined, limit = 300) => (text === undefined ? undefined : outsideLine(this.app.redact(text), limit));
		const plugins = this.list().map((p) => ({ id: p.id, version: p.version, state: p.state, description: outside(p.description), error: outside(p.error, 600), provides: p.provides, hooks: p.hooks, tools: p.tools, waitingFor: p.waitingFor, waitingForPlugins: p.waitingForPlugins, requires: p.requires, owns: p.owns }));
		if (id === undefined) {
			return {
				reelix: { version: REELIX_VERSION, pluginApi: PLUGIN_API },
				reference: "docs/plugin-reference.md is generated from the same declarations",
				plugins,
				seams: SEAM_DECLARATIONS.map((s) => ({ ...s, providers: this.app.seams.providers(s.id).map((x) => ({ id: x.id, plugin: x.plugin, label: outside(x.impl.label, 80) })) })),
				hooks: HOOK_DECLARATIONS.map((h) => ({ ...h, plugins: this.app.hooks.participants(h.id) })),
				events: PLUGIN_EVENTS,
				...this.ownedCatalogue(outside),
				context: CONTEXT_CALLS,
			};
		}
		const p = this.get(id);
		const info = this.list().find((x) => x.id === id)!;
		const operations = this.app.operations.list().filter((o) => o.plugin === id).map((o) => ({ name: o.name, summary: outside(o.summary), effect: o.effect, input: o.input, tool: o.tool, preview: !!o.preview, card: o.card }));
		return {
			...plugins.find((x) => x.id === id),
			failures: info.failures,
			manifest: p.manifest && { requires: p.manifest.requires, uses: p.manifest.uses },
			settings: { schema: this.schemaOf(p), values: this.settings(id, ownerLanguage(this.app)).values },
			secrets: this.settings(id, ownerLanguage(this.app)).secrets.map(({ key, set }) => ({ key, set })),
			operations,
			registered: p.registered,
			toolsOn: info.toolsOn,
			trial: info.trial,
			trialResult: info.trialResult,
		};
	}

	/**
	 * Seams and events plugins own (docs/plugins.md §7.11), from the manifests of every plugin found, with who
	 * provides and listens to each now. What an owner wrote is outside text.
	 */
	private ownedCatalogue(outside: (text: string | undefined, limit?: number) => string | undefined) {
		const all = [...this.plugins.values()].filter((p) => p.manifest);
		const live = new Map(this.app.seams.ownedSeams().map((s) => [s.id, s]));
		return {
			pluginSeams: all.flatMap((p) =>
				Object.entries(p.manifest!.owns.seams).map(([id, d]) => ({
					id,
					owner: p.id,
					ownerState: p.state,
					summary: outside(d.summary),
					methods: Object.entries(d.methods).map(([name, m]) => ({ name, limitMs: m.limitMs ?? 60_000, result: m.result })),
					providers: (live.get(id)?.providers ?? []).map((x) => ({ id: x.id, plugin: x.plugin, label: outside(x.impl.label, 80) })),
				})),
			),
			pluginEvents: all.flatMap((p) =>
				Object.entries(p.manifest!.owns.events).map(([id, d]) => ({ id, owner: p.id, ownerState: p.state, summary: outside(d.summary), payload: d.payload, listeners: all.filter((q) => q.manifest!.uses.events.includes(id)).map((q) => q.id) })),
			),
		};
	}

	describe(): { plugin: string; line: string }[] {
		return [...this.plugins.values()].flatMap((p) => (p.state === "active" && p.manifest?.describe ? [{ plugin: p.id, line: this.filled(p, p.manifest.describe) }] : []));
	}

	/** `{path}` is a setting (`*` for every entry of a list), `{secret:<name>}` whether that secret is set. */
	private filled(p: Plugin, template: string): string {
		const settings = this.settings(p.id, ownerLanguage(this.app)).values;
		const at = (value: unknown, parts: string[]): unknown[] => {
			if (!parts.length) return [value];
			const [first, ...rest] = parts;
			if (first === "*") return Array.isArray(value) ? value.flatMap((v) => at(v, rest)) : [];
			return at(getPath(value, first!), rest);
		};
		return template.replace(/\{([^{}]+)\}/g, (_m, key: string) => {
			if (key.startsWith("secret:")) {
				const name = key.slice(7);
				// A secret declared per entry is "set" when every entry has it.
				const per = p.manifest!.uses.secrets.find((s) => s.per && s.name === name);
				if (per) {
					const rows = this.secretRows(p).filter((r) => r.name === name);
					return rows.length && rows.every((r) => r.set) ? "set" : "missing";
				}
				return declaredSecret(p.manifest!.uses.secrets, name) ? (this.app.secrets[`plugins.${p.id}.${name}`] ? "set" : "missing") : "(not declared)";
			}
			const values = at(settings, key.split(".")).filter((v) => v !== undefined && v !== null && v !== "");
			return values.length ? values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ") : "(not set)";
		});
	}

	envSettings(): { plugin: string; variable: string; path: string }[] {
		// An installed plugin cannot read the server's environment this way: only those shipped with Reelix or named at start.
		return [...this.plugins.values()].flatMap((p) => (p.installed || !p.manifest ? [] : Object.entries(p.manifest.env).map(([variable, path]) => ({ plugin: p.id, variable, path: `plugins.${p.id}.${path}` }))));
	}

	/** What a running plugin registered, against which its declarations are checked. */
	registrations(id: string): Registered | undefined {
		return this.plugins.get(id)?.registered;
	}

	enable(id: string): Promise<PluginActionResult> {
		return this.serial(async () => {
			const p = this.get(id);
			if (p.state === "active") return this.result(p, "applied", "plugins.alreadyOn");
			if (p.restartNeeded && p.state === "installed") return this.restartResult(p, "applied");
			if (p.state === "installed") return this.result(p, "failed", "plugins.approveFirst");
			if (p.state === "changed") return this.result(p, "failed", "plugins.reapprove");
			if (p.state === "incompatible") return { ...this.result(p, "failed", "plugins.failedNext"), next: p.error ?? "" };
			const cycle = this.cycleOf(p);
			if (cycle) {
				p.state = "failed";
				p.error = tr(this.app, "plugins.cycle", { cycle: cycle.join(" → ") });
				return { ...this.result(p, "failed", "plugins.failedNext"), next: p.error };
			}
			this.setDisabled(p, false);
			p.failures.clear();
			p.error = undefined;
			p.state = "waiting";
			await this.settle();
			if (p.state === "waiting") return { ...this.result(p, "applied", "plugins.waitingNext"), next: tr(this.app, "plugins.waitingNext", { seams: [...this.missingSeams(p), ...this.missingPlugins(p).map(requirementText)].join(", ") }) };
			return p.state === "active" ? this.result(p, "applied", "plugins.enabled") : this.result(p, "failed", "plugins.failedNext");
		});
	}

	disable(id: string, options: { withDependents?: boolean } = {}): Promise<PluginActionResult> {
		return this.serial(async () => {
			const p = this.get(id);
			if (p.state === "disabled" || HELD.includes(p.state)) return this.result(p, "applied", "plugins.alreadyOff");
			const dependents = this.dependentsOf(p);
			if (dependents.length && !options.withDependents) {
				const names = dependents.map((d) => d.id);
				return { id, result: "needs_confirmation", state: p.state, dependents: names, next: tr(this.app, "plugins.dependents", { id, names: names.join(", ") }) };
			}
			for (const d of [...dependents, p]) {
				await this.switchOff(d);
				d.error = undefined;
				this.setDisabled(d, true);
			}
			await this.settle();
			return { ...this.result(p, "applied", "plugins.disabled"), dependents: dependents.length ? dependents.map((d) => d.id) : undefined };
		});
	}

	/**
	 * Where a plugin's code runs: the owner's choice, else its manifest's (docs/plugins.md §11.7). A version that
	 * cannot run where the owner chose does not start until the owner chooses again (`activate`).
	 */
	private runtimeOf(p: Plugin): PluginRuntime {
		if (!p.manifest) return "in-process";
		return this.chosenRuntime(p.id) ?? p.manifest.runtime;
	}

	private chosenRuntime(id: string): PluginRuntime | undefined {
		return json<Record<string, PluginRuntime>>(kvGet(this.app.db, RUNTIME_KEY), {})[id];
	}

	setRuntime(id: string, runtime: PluginRuntime): Promise<PluginActionResult> {
		return this.serial(async () => {
			const p = this.get(id);
			if (runtime === "process" && !(p.manifest && processAllowed(p.manifest))) return this.result(p, "failed", "plugins.runtimeRefused");
			const chosen = json<Record<string, PluginRuntime>>(kvGet(this.app.db, RUNTIME_KEY), {});
			if (runtime === p.manifest?.runtime) delete chosen[id];
			else chosen[id] = runtime;
			kvSet(this.app.db, RUNTIME_KEY, JSON.stringify(chosen));
			// Like a change of its settings: a plugin that runs, waits or failed starts again where it now belongs.
			if (p.state !== "disabled" && !HELD.includes(p.state)) {
				await this.dispose(p, this.stopGraceMs);
				p.error = undefined;
				p.state = "waiting";
				await this.settle();
			}
			if (p.state === "failed") return { ...this.result(p, "failed", "plugins.failedNext"), next: p.error ?? tr(this.app, "plugins.failedNext") };
			return this.result(p, "applied", runtime === "process" ? "plugins.runtimeProcess" : "plugins.runtimeInProcess");
		});
	}

	screen(id: string, lang: Language): { title: string; html: string } {
		const p = this.get(id);
		if (!p.manifest?.screen) throw new ReelixError("not_found", `${id} has no screen.`);
		if (p.state !== "active") throw new ReelixError("not_found", tr(this.app, "plugins.screenOff", { id }));
		this.assertApproved(p);
		return { title: messageFrom(p.messages, lang, "screen.title") ?? p.manifest.screen.title, html: screenDocument(p.dir, p.manifest.screen.entry, lang) };
	}

	/** Start the plugin in its own process; disposing its scope ends the process, after everything else is undone. */
	private async startProcess(p: Plugin, manifest: Manifest, scope: Scope): Promise<PluginProcess> {
		const child = await startProcess({
			id: p.id,
			dir: p.dir,
			entry: manifest.entry!,
			dataDir: join(this.app.paths.pluginData, p.id),
			messages: p.messages,
			language: ownerLanguage(this.app),
			calls: Object.keys(CONTEXT_CALLS),
			output: (line) => console.log(`[plugin ${p.id}] ${this.app.redact(line)}`),
			crashed: (error) => this.crashed(p, scope, error),
		});
		scope.add(() => child.kill());
		const language = ({ paths }: { paths: string[] }) => {
			if (paths.includes("language")) child.language(ownerLanguage(this.app));
		};
		this.app.pluginEvents.on("config.changed", language);
		scope.add(() => void this.app.pluginEvents.off("config.changed", language));
		return child;
	}

	/** Its process ended by itself: a failure (§11.6), and it starts again after a growing delay unless that switched it off. */
	private crashed(p: Plugin, scope: Scope, error: Error): void {
		if (p.scope !== scope || p.state !== "active") return;
		this.onFailure(p, scope, "process", error);
		if (Date.now() - (p.startedAt ?? 0) >= PROCESS_HEALTHY_MS) p.crashes = 0;
		const delay = Math.min((this.options.taskDelayMs ?? TASK_DELAY_MS) * 2 ** p.crashes, PROCESS_MAX_DELAY_MS);
		p.crashes++;
		const restart = Symbol(p.id);
		void this.serial(async () => {
			if (p.scope !== scope) return; // switched off by now
			await this.dispose(p, 0);
			p.state = "failed";
			p.error = tr(this.app, "plugins.processEnded", { error: this.app.redact(error.message), seconds: Math.ceil(delay / 1000) });
			p.restart = restart;
			setTimeout(() => {
				void this.serial(async () => {
					if (p.restart !== restart || p.state !== "failed") return;
					p.restart = undefined;
					p.error = undefined;
					p.state = "waiting";
					await this.settle();
				});
			}, delay).unref();
		});
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private get(id: string): Plugin {
		const p = this.plugins.get(id);
		if (!p) throw new ReelixError("unknown_plugin", `There is no plugin "${id}". See \`reelix plugin list\`.`);
		return p;
	}

	private result(p: Plugin, result: PluginActionResult["result"], next: string): PluginActionResult {
		return { id: p.id, result, state: p.state, next: tr(this.app, next) };
	}

	private discover(): void {
		const folders = (root: string) =>
			readdirSync(root, { withFileTypes: true })
				.filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
				.map((e) => e.name)
				.sort((a, b) => a.localeCompare(b));
		for (const root of this.options.dirs) {
			if (!existsSync(root)) continue;
			const builtIn = !!this.options.builtInDirs?.includes(root);
			for (const name of folders(root)) {
				if (name !== "examples") {
					this.addFolder(join(root, name), builtIn, false);
					continue;
				}
				for (const example of folders(join(root, name))) if (existsSync(join(root, name, example, "package.json"))) this.addFolder(join(root, name, example), builtIn, true);
			}
		}
		for (const dir of this.options.plugins ?? []) this.addFolder(dir, false, false);
		// The owner's plugins: only folders with an install record, never a folder that merely appeared (§13.3).
		for (const r of this.installer?.list() ?? []) this.addFolder(this.installer!.dirOf(r.id), false, false, r);
	}

	private addFolder(dir: string, builtIn: boolean, optIn: boolean, record?: InstallRecord): Plugin {
		const base = { dir, failures: new Map<string, number[]>(), noticeTimes: [], builtIn, optIn, found: this.plugins.size, installed: !!record, restartNeeded: false, crashes: 0 };
		const failed = (id: string, error: string) => {
			const p: Plugin = { ...base, id, messages: {}, state: "failed", error };
			this.plugins.set(id, p);
			return p;
		};
		let manifest: Manifest;
		let messages: Catalog;
		try {
			if (record) {
				if (!existsSync(dir)) return failed(record.id, `its files are missing from ${dir}; uninstall it and install it again`);
				const why = incompatibility(dir);
				if (why) {
					const p: Plugin = { ...base, id: record.id, messages: loadMessages(dir), state: "incompatible", error: why };
					this.plugins.set(record.id, p);
					// After an image update: said once per version of Reelix (§13.4).
					addInbox(this.app, { kind: "notice", title: tr(this.app, "plugins.incompatibleTitle", { id: record.id }), body: tr(this.app, "plugins.incompatibleBody", { id: record.id, why, version: REELIX_VERSION }), source: `plugin:${record.id}`, dedupeKey: `plugin-incompatible:${record.id}:${REELIX_VERSION}` });
					return p;
				}
			}
			manifest = readManifest(dir, this.app.operations.reservedWords());
			messages = loadMessages(dir);
		} catch (e) {
			return failed(record?.id ?? basename(dir), errorMessage(e));
		}
		if (record && manifest.id !== record.id) return failed(record.id, `its manifest now says the id is "${manifest.id}"`);
		if (this.plugins.has(manifest.id)) return failed(`${manifest.id} (${basename(dir)})`, `another plugin already has the id "${manifest.id}"`);
		const p: Plugin = { ...base, id: manifest.id, manifest, messages, state: "disabled" };
		this.plugins.set(manifest.id, p);
		return p;
	}

	/** An installed plugin that may not run now: not approved, or its files differ from what was approved (§13.3). */
	private heldState(p: Plugin): PluginState | undefined {
		if (!p.installed) return undefined;
		const record = this.installer!.get(p.id);
		if (!record?.approved) return "installed";
		if (this.installer!.intact(p.id)) return undefined;
		p.error = tr(this.app, "plugins.changedBody", { id: p.id });
		addInbox(this.app, { kind: "notice", title: tr(this.app, "plugins.changedTitle", { id: p.id }), body: p.error, source: `plugin:${p.id}`, payload: { urgent: true }, dedupeKey: `plugin-changed:${p.id}` });
		return "changed";
	}

	private canRestart(): boolean {
		return !!this.app.operations.get("server.restart");
	}

	private restartResult(p: Plugin, result: PluginActionResult["result"] = "saved-restart-needed"): PluginActionResult {
		return { id: p.id, result, state: p.state, next: tr(this.app, this.canRestart() ? "plugins.restartButton" : "plugins.restartManual") };
	}

	private needInstaller(): Installer {
		if (!this.installer) throw new ReelixError("not_available", "This Reelix has no folder for installed plugins.");
		return this.installer;
	}

	private installedPlugin(id: string): Plugin {
		const p = this.get(id);
		if (!p.installed) throw new ReelixError("not_installed", `${id} is shipped with Reelix: it cannot be installed, updated or uninstalled; switch it off instead.`);
		return p;
	}

	async install(source: string): Promise<PluginReview> {
		const installer = this.needInstaller();
		// Fetching and npm can take minutes; switching plugins on and off goes on meanwhile.
		const record = await installer.install(source, (id) => this.plugins.has(id));
		return this.serial(async () => {
			const p = this.addFolder(installer.dirOf(record.id), false, false, record);
			if (p.state !== "failed" && p.state !== "incompatible") p.state = this.heldState(p) ?? "installed";
			return this.withRequirements(installer.review(record.id, "installed"));
		});
	}

	review(id: string): PluginReview {
		const p = this.installedPlugin(id);
		return this.withRequirements(this.needInstaller().review(id, p.state === "changed" ? "changed" : p.state === "installed" && !p.restartNeeded ? "installed" : "other"));
	}

	approve(id: string, hash: string, by: string): Promise<PluginActionResult> {
		return this.serial(async () => {
			const p = this.installedPlugin(id);
			const installer = this.needInstaller();
			if (!installer.get(id)?.update && !(p.state === "installed" || p.state === "changed")) throw new ReelixError("nothing_to_approve", `${id} is approved and has no staged update.`);
			installer.approve(id, hash, by);
			p.restartNeeded = true;
			if (p.state === "changed") p.state = "installed";
			p.error = undefined;
			return this.restartResult(p);
		});
	}

	uninstall(id: string, deleteData: boolean): Promise<PluginActionResult & { deleted: boolean }> {
		return this.serial(async () => {
			const p = this.installedPlugin(id);
			await this.switchOff(p);
			this.needInstaller().remove(id);
			this.plugins.delete(id);
			const off = this.disabledIds();
			delete off[id];
			kvSet(this.app.db, DISABLED_KEY, JSON.stringify(off));
			if (deleteData) this.deleteData(id);
			await this.settle();
			return { ...this.result(p, "applied", deleteData ? "plugins.uninstalledAll" : "plugins.uninstalledKept"), deleted: deleteData };
		});
	}

	/** Its settings, secrets and stored data, when the owner asks for them to go too (§12.4). */
	private deleteData(id: string): void {
		if (id in this.app.config.plugins) {
			const rest = { ...this.app.config.plugins };
			delete rest[id];
			this.app.setConfig("plugins", rest);
		}
		for (const key of Object.keys(this.app.secrets)) if (key.startsWith(`plugins.${id}.`)) this.app.setSecret(key, undefined);
		this.app.db.prepare("DELETE FROM kv WHERE k LIKE ? ESCAPE '\\'").run(`plugin:${id.replace(/[\\%_]/g, "\\$&")}:%`);
		this.app.db.prepare("DELETE FROM trial_results WHERE plugin = ?").run(id);
		setTrial(this.app, id, false);
		for (const key of [TOOLS_OFF_KEY, JOB_PROMPT_KEY]) kvSet(this.app.db, key, JSON.stringify(json<string[]>(kvGet(this.app.db, key), []).filter((x) => x !== id)));
		const model = json<Record<string, unknown>>(kvGet(this.app.db, MODEL_KEY), {});
		delete model[id];
		kvSet(this.app.db, MODEL_KEY, JSON.stringify(model));
		rmSync(join(this.app.paths.pluginData, id), { recursive: true, force: true });
	}

	async checkUpdates(id?: string): Promise<PluginUpdates[]> {
		const installer = this.needInstaller();
		const ids = id === undefined ? installer.list().map((r) => r.id) : [this.installedPlugin(id).id];
		return Promise.all(ids.map((x) => installer.newer(x)));
	}

	async update(id: string, to?: string): Promise<PluginReview> {
		this.installedPlugin(id);
		const installer = this.needInstaller();
		await installer.stageUpdate(id, to);
		return this.withRequirements(installer.review(id, "other"));
	}

	/** An update that cannot run where the owner chose says so in its difference: it would leave its own process (§11.7). */
	private withRuntimeChoice(review: Omit<PluginReview, "requirements">): Omit<PluginReview, "requirements"> {
		const diff = review.diff;
		if (!diff || this.chosenRuntime(review.id) !== "process" || review.declarations.processAllowed || diff.flags.includes("in-process")) return review;
		return { ...review, diff: { ...diff, flags: [...diff.flags, "in-process"] } };
	}

	private needProposals(): ProposalStore {
		if (!this.proposals) throw new ReelixError("not_available", "This Reelix has no folder for installed plugins, so it takes no proposals.");
		return this.proposals;
	}

	/**
	 * A plugin the agent wrote, copied as it is now and waiting in the owner's Inbox (docs/plugins.md §16, phase 7).
	 * Nothing is installed: `decideProposal` is the owner's.
	 */
	async propose(folder: string, by: string, note?: string): Promise<PluginProposalView> {
		const store = this.needProposals();
		const dir = isAbsolute(folder) ? folder : resolve(this.app.paths.workspace, folder);
		const taken = (id: string) => this.plugins.has(id) || !!this.installer!.get(id);
		const { record, replaced } = store.create(dir, by, note, taken);
		if (replaced?.inboxId) dismissInbox(this.app, replaced.inboxId);
		// Reelix's words, not the proposer's: the note is shown on the screen as a quotation (§10.3).
		const item = addInbox(this.app, { kind: "proposal", title: tr(this.app, "plugins.proposedTitle", { id: record.plugin, version: record.version }), body: tr(this.app, "plugins.proposedBody", { by }), source: by, payload: { pluginProposal: record.id, urgent: true } });
		store.save({ ...record, inboxId: item.id });
		return store.view(record);
	}

	/** The approval screen of a proposal: from its copy's manifest, never its code (§11.1). */
	async proposal(id: string): Promise<PluginReview> {
		const store = this.needProposals();
		const record = store.get(id);
		const manifest = store.manifest(id);
		return this.withRequirements({ id: manifest.id, what: "proposal", hash: store.hashNow(id), source: { kind: "folder", location: record.folder }, declarations: declarations(store.dirOf(id), manifest), nativeFound: [], scriptsNotRun: [], proposal: await store.view(record) });
	}

	async decideProposal(id: string, approve: boolean, hash: string | undefined, by: string): Promise<PluginActionResult> {
		const store = this.needProposals();
		const record = store.get(id);
		if (record.status !== "open") throw new ReelixError("not_open", `${id} is ${record.status}.`);
		const answered = (answer: string) => record.inboxId && recordAnswer(this.app, record.inboxId, answer, by);
		if (!approve) {
			store.save({ ...record, status: "declined" });
			answered("declined");
			return { id: record.plugin, result: "applied", state: this.plugins.get(record.plugin)?.state ?? "installed", next: tr(this.app, "plugins.proposalDeclined", { id: record.plugin }) };
		}
		// Exactly what the owner was shown: the copy may not have changed since.
		if (!hash || store.hashNow(id) !== hash || record.hash !== hash) throw new ReelixError("changed", "The proposed files are not what was shown; look at them again.");
		const installer = this.needInstaller();
		const installed = await installer.install(store.dirOf(id), (pid) => this.plugins.has(pid), { kind: "folder", location: record.folder });
		return this.serial(async () => {
			if (installed.hash !== hash) {
				installer.remove(installed.id);
				throw new ReelixError("changed", "What was installed differs from what was shown; nothing is installed.");
			}
			const p = this.addFolder(installer.dirOf(installed.id), false, false, installed);
			installer.approve(installed.id, hash, by);
			p.state = "installed";
			p.restartNeeded = true;
			store.save({ ...record, status: "approved" });
			store.forget(record.plugin);
			answered("approved");
			return this.restartResult(p);
		});
	}

	skillFolders(): { plugin: string; dirs: string[] }[] {
		return [...this.plugins.values()]
			.filter((p) => p.state === "active" && p.manifest?.uses.skills)
			.map((p) => ({ plugin: p.id, dirs: skillNames(p.dir).map((n) => join(p.dir, "skills", n)) }));
	}

	/** The approval screen with what this Reelix has of each plugin the reviewed one requires (§13). */
	private withRequirements(shown: Omit<PluginReview, "requirements">): PluginReview {
		const review = this.withRuntimeChoice(shown);
		const requirements = review.declarations.requiresPlugins.map(({ id, range }) => {
			const q = this.plugins.get(id);
			const version = q?.manifest?.version;
			return { id, range, ...(q && { version, state: q.state }), satisfied: version !== undefined && satisfies(version, range) };
		});
		return { ...review, requirements };
	}

	private missingSeams(p: Plugin): SeamId[] {
		return (p.manifest?.requires.seams ?? []).filter((s) => !this.app.seams.hasProvider(s, p.id));
	}

	/** The plugins `p` requires that are not running at a version in its range (§7.11). */
	private missingPlugins(p: Plugin): PluginRequirement[] {
		return Object.entries(p.manifest?.requires.plugins ?? {}).flatMap(([id, range]) => {
			const q = this.plugins.get(id);
			if (q?.state === "active" && satisfies(q.manifest!.version, range)) return [];
			return [{ id, range, ...(q ? { version: q.manifest?.version ?? "", state: q.state } : {}) }];
		});
	}

	/** The plugins in an order where each comes after those it requires; a cycle is broken anywhere (its plugins have failed). */
	private ordered(): Plugin[] {
		const out: Plugin[] = [];
		const seen = new Set<Plugin>();
		const visit = (p: Plugin, path: Set<Plugin>) => {
			if (seen.has(p) || path.has(p)) return;
			path.add(p);
			for (const id of Object.keys(p.manifest?.requires.plugins ?? {})) {
				const q = this.plugins.get(id);
				if (q) visit(q, path);
			}
			path.delete(p);
			seen.add(p);
			out.push(p);
		};
		for (const p of this.plugins.values()) visit(p, new Set());
		return out;
	}

	/** The cycle of requirements `p` is part of, as ids from `p` back to `p`, or nothing. */
	private cycleOf(p: Plugin): string[] | undefined {
		const walk = (q: Plugin, path: string[]): string[] | undefined => {
			for (const id of Object.keys(q.manifest?.requires.plugins ?? {})) {
				if (id === p.id) return [...path, id];
				const next = this.plugins.get(id);
				if (next && !path.includes(id)) {
					const found = walk(next, [...path, id]);
					if (found) return found;
				}
			}
			return undefined;
		};
		return walk(p, [p.id]);
	}

	/** Plugins whose requirements go round in a circle cannot start in any order: each fails, naming the circle (§7.11). */
	private refuseCycles(): void {
		for (const p of this.plugins.values()) {
			if (!p.manifest || p.state === "disabled" || HELD.includes(p.state)) continue;
			const cycle = this.cycleOf(p);
			if (!cycle) continue;
			p.state = "failed";
			p.error = tr(this.app, "plugins.cycle", { cycle: cycle.join(" → ") });
		}
	}

	/** Bring every plugin in line with who provides what (§7.11): nothing waits silently, nothing runs without its seams. */
	private async settle(): Promise<void> {
		const missing = (p: Plugin) => this.missingSeams(p).length + this.missingPlugins(p).length;
		for (let changed = true; changed; ) {
			changed = false;
			// Those a plugin requires start before it, and a plugin left without one stops (§7.11).
			for (const p of this.ordered()) {
				if (p.state === "active" && missing(p)) {
					await this.dispose(p, this.stopGraceMs);
					p.state = "waiting";
					changed = true;
				} else if (p.state === "waiting" && !missing(p)) {
					await this.activate(p);
					changed = true;
				}
			}
		}
	}

	/** Active and waiting plugins that would be left without a seam or a plugin they require if `p` stopped, directly or through another. */
	private dependentsOf(p: Plugin): Plugin[] {
		const stopping = new Set([p]);
		for (let grew = true; grew; ) {
			grew = false;
			const lost = (seam: SeamId) => {
				const others = [...this.plugins.values()].filter((o) => !stopping.has(o) && o.state === "active" && this.app.seams.providedBy(o.id).includes(seam));
				return !others.length;
			};
			for (const o of this.plugins.values()) {
				if (stopping.has(o) || (o.state !== "active" && o.state !== "waiting")) continue;
				const needsStopping = Object.keys(o.manifest?.requires.plugins ?? {}).some((id) => [...stopping].some((x) => x.id === id));
				if (needsStopping || (o.manifest?.requires.seams ?? []).some((s) => [...stopping].some((x) => this.app.seams.providedBy(x.id).includes(s)) && lost(s))) {
					stopping.add(o);
					grew = true;
				}
			}
		}
		stopping.delete(p);
		return [...stopping];
	}

	/** Settings or a secret of these plugins changed: they start again with the new values (§5.3). */
	private settingsChanged(ids: string[]): void {
		for (const id of new Set(ids)) {
			const p = this.plugins.get(id);
			// Held plugins wait for the owner or a restart, whatever their settings say.
			if (!p || p.state === "disabled" || HELD.includes(p.state)) continue;
			void this.serial(async () => {
				if (p.state === "disabled" || HELD.includes(p.state)) return;
				await this.dispose(p, this.stopGraceMs);
				p.error = undefined;
				p.state = "waiting";
				await this.settle();
			});
		}
	}

	/** The code's settings schema as JSON. The copy the manifest names must be the same (§12.2). */
	private checkedSchema(p: Plugin, definition: PluginDefinition): Schema | undefined {
		const schema = definition.config === undefined ? undefined : (JSON.parse(JSON.stringify(definition.config)) as Schema);
		if (p.manifest?.settings && !sameData(JSON.parse(readFileSync(join(p.dir, p.manifest.settings), "utf8")), schema ?? null)) {
			throw new Error(`${p.manifest.settings} differs from the settings schema in the code; write it again with \`reelix plugin check <folder> --write-settings\` (for the plugins in this repository, \`npm run plugin-reference\`)`);
		}
		return schema;
	}

	private settingsFor(p: Plugin, definition: PluginDefinition): unknown {
		const raw = structuredClone((this.app.config.plugins[p.id] ?? {}) as object);
		if (!definition.config) return raw;
		const value = Value.Default(definition.config, raw);
		const errors = [...Value.Errors(definition.config, value)];
		if (errors.length) throw new Error(`the settings under plugins.${p.id} are invalid: ${errors.map((e) => `${(e as { instancePath?: string }).instancePath || "/"} ${e.message}`).join("; ")}`);
		return value;
	}

	/** Built-in plugins first, then order of installation: for a reference plugin, when the owner switched it on (§8). */
	private hookOrder(p: Plugin): number {
		if (p.builtIn && !p.optIn) return p.found;
		const enabled = this.enabledIds().indexOf(p.id);
		return HOOK_ORDER_INSTALLED + (enabled >= 0 ? enabled : this.enabledIds().length + p.found);
	}

	/** Returns whether the plugin is now running. */
	private async activate(p: Plugin): Promise<boolean> {
		// Checked at every load, not only at start: files changed since approval are not loaded (§13.3).
		if (p.installed) {
			const held = this.heldState(p);
			if (held) {
				p.state = held;
				return false;
			}
		}
		const scope = new Scope();
		try {
			const manifest = readManifest(p.dir, this.app.operations.reservedWords());
			if (manifest.id !== p.id) throw new Error(`the plugin's id changed to "${manifest.id}"; restart Reelix`);
			p.manifest = manifest;
			p.messages = loadMessages(p.dir);
			if (!manifest.entry) {
				// A skill pack: no code; its skills reach conversations that load from now on.
				p.registered = undefined;
				p.state = "active";
				p.error = undefined;
				return true;
			}
			if (this.runtimeOf(p) === "process" && !processAllowed(manifest)) throw new Error(tr(this.app, "plugins.processChoiceLost", { id: p.id }));
			const ownProcess = this.runtimeOf(p) === "process";
			// Inside Reelix its folder is closed again to the plugins' user, which a process of its own had opened it to.
			if (!ownProcess && ISOLATION) pluginFolderAccess(join(this.app.paths.pluginData, p.id), ISOLATION, false);
			const definition = ownProcess ? await this.startProcess(p, manifest, scope) : await loadPlugin(p.dir, manifest.entry);
			p.schema = this.checkedSchema(p, definition);
			const settings = this.settingsFor(p, definition);
			// What it owns exists while it runs: its providers and listeners start after it (§7.11).
			for (const [seam, d] of Object.entries(manifest.owns.seams)) scope.add(this.app.seams.define(seam as never, d, p.id));
			for (const [event, declaration] of Object.entries(manifest.owns.events)) {
				const entry = { plugin: p.id, declaration };
				this.ownedEvents.set(event, entry);
				scope.add(() => {
					if (this.ownedEvents.get(event) === entry) this.ownedEvents.delete(event);
				});
			}
			const { ctx, registered } = createContext({
				app: this.app,
				jobs: this.jobs,
				chat: this.chat,
				manifest,
				scope,
				messages: p.messages,
				settings,
				builtIn: p.builtIn,
				hookOrder: this.hookOrder(p),
				transport: this.options.transport ?? realTransport,
				noticeTimes: p.noticeTimes,
				taskDelayMs: this.options.taskDelayMs ?? TASK_DELAY_MS,
				onFailure: (registration, error, timedOutSince) => this.onFailure(p, scope, registration, error, timedOutSince),
				model: this.options.model,
				modelState: () => this.modelState(p),
				routes: this.routes,
				pi: this.pi,
				ownedEvent: (event) => this.ownedEvents.get(event),
				ownedEmitter: this.ownedEmitter,
			});
			p.scope = scope;
			let timer!: NodeJS.Timeout;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`activate did not finish within ${ACTIVATE_TIMEOUT_MS / 1000} seconds`)), ACTIVATE_TIMEOUT_MS);
			});
			await Promise.race([scope.track(() => definition.activate(ctx, settings as never)), timeout]).finally(() => clearTimeout(timer));
			p.registered = registered;
			p.state = "active";
			p.error = undefined;
			p.startedAt = Date.now();
			p.restart = undefined;
			this.app.notifications.catchUp(p.id);
			return true;
		} catch (e) {
			p.scope = undefined;
			await scope.dispose(0, (undoError) => this.logUndoError(p, undoError));
			p.state = "failed";
			p.error = this.app.redact(errorMessage(e));
			return false;
		}
	}

	private async dispose(p: Plugin, graceMs: number): Promise<void> {
		const scope = p.scope;
		p.scope = undefined;
		p.registered = undefined;
		await scope?.dispose(graceMs, (e) => this.logUndoError(p, e));
	}

	/** Stop a plugin for good: its queued runs must not wait for it, and its repeating jobs end. */
	private async switchOff(p: Plugin): Promise<void> {
		for (const name of p.manifest?.uses.jobs ?? []) {
			this.jobs.cancelQueued(jobKind(p.id, name), tr(this.app, "plugins.jobCancelled"));
			this.jobs.unschedule(scheduleId(p.id, name));
		}
		await this.dispose(p, this.stopGraceMs);
		p.state = "disabled";
	}

	/** At start: repeating jobs of plugins that are not running, and queued runs nothing will ever take. */
	private dropOrphans(): void {
		const rows = this.app.db.prepare("SELECT id FROM jobs WHERE id LIKE 'plugin:%'").all() as { id: string }[];
		const wanted = new Set([...this.plugins.values()].filter((p) => p.state === "active").flatMap((p) => (p.manifest?.uses.jobs ?? []).map((j) => scheduleId(p.id, j))));
		for (const r of rows) if (!wanted.has(r.id)) this.jobs.unschedule(r.id);
		const queued = this.app.db.prepare("SELECT DISTINCT kind FROM job_runs WHERE state = 'queued' AND kind LIKE '%.%'").all() as { kind: string }[];
		for (const { kind } of queued) {
			const dot = kind.indexOf(".");
			const p = this.plugins.get(kind.slice(0, dot));
			if (!p || p.state === "disabled" || (p.state === "active" && !p.registered?.jobs.includes(kind.slice(dot + 1)))) this.jobs.cancelQueued(kind, tr(this.app, "plugins.jobCancelled"));
		}
	}

	private logUndoError(p: Plugin, e: unknown): void {
		console.warn(`Plugin ${p.id}: an undo step failed: ${this.app.redact(errorMessage(e))}`);
	}

	/** Five failures of one registration in ten minutes switch the plugin off (§11.6). */
	private onFailure(p: Plugin, scope: Scope, registration: string, error: unknown, timedOutSince?: number): void {
		if (p.scope !== scope) return;
		const message = this.app.redact(errorMessage(error));
		p.error = `${registration}: ${message}`;
		console.warn(`Plugin ${p.id}: ${p.error}`);
		// A timeout from the incident that already cost a plugin its place is not counted against another.
		if (timedOutSince !== undefined && timedOutSince <= this.lastTimeoutOff) return;
		const times = [...recent(p.failures.get(registration) ?? []), Date.now()];
		p.failures.set(registration, times);
		if (times.length < FAILURE_LIMIT) return;
		if (timedOutSince !== undefined) this.lastTimeoutOff = Date.now();
		void this.serial(async () => {
			if (p.scope !== scope) return;
			await this.switchOff(p);
			p.error = tr(this.app, "plugins.autoOffBody", { registration, times: times.length, error: message });
			this.setDisabled(p, true, p.error);
			addInbox(this.app, { kind: "notice", title: tr(this.app, "plugins.autoOffTitle", { id: p.id }), body: p.error, source: `plugin:${p.id}`, dedupeKey: `plugin-off:${p.id}` });
			await this.settle();
		});
	}

	private disabledIds(): Record<string, string | null> {
		return json<Record<string, string | null>>(kvGet(this.app.db, DISABLED_KEY), {});
	}

	private enabledIds(): string[] {
		return json<string[]>(kvGet(this.app.db, ENABLED_KEY), []);
	}

	private setDisabled(p: Plugin, disabled: boolean, reason?: string): void {
		if (p.optIn) {
			const on = this.enabledIds().filter((id) => id !== p.id);
			kvSet(this.app.db, ENABLED_KEY, JSON.stringify(disabled ? on : [...on, p.id]));
		}
		const off = this.disabledIds();
		if (disabled && !p.optIn) off[p.id] = reason ?? null;
		else delete off[p.id];
		kvSet(this.app.db, DISABLED_KEY, JSON.stringify(off));
	}
}

const recent = (times: number[]) => times.filter((t) => t > Date.now() - FAILURE_WINDOW_MS);
