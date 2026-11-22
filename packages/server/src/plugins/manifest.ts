import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { type Catalog, type Effect, HOOK_IDS, LANGUAGES, type Messages, MODEL_ROLES, type ModelRole, type OwnedSeamDeclaration, PLUGIN_EVENTS, type PluginDeclarations, SEAM_IDS } from "@reelix/core";
import type { HookId, PluginManifest, SeamId } from "@reelix/plugin";
import { satisfies, understoodRange } from "./semver.ts";

/** The plugin API of this Reelix (docs/plugins.md §5.1). `0` until the review gate. */
export const PLUGIN_API = 0;
export const REELIX_VERSION = (JSON.parse(readFileSync(new URL("../../../core/package.json", import.meta.url), "utf8")) as { version: string }).version;

type Uses = Required<NonNullable<PluginManifest["uses"]>>;

/** An event a plugin owns, as its manifest declares it: what it means and a JSON Schema of its payload. */
export type OwnedEventDeclaration = { summary: string; payload: Record<string, unknown> };

export type Manifest = Omit<PluginManifest, "uses" | "requires" | "settings" | "entry" | "owns" | "env" | "describe" | "screen"> & {
	/** Absent for a skill pack. */
	entry?: string;
	/** The copy of the settings schema, a path inside the folder; absent when it ships none. */
	settings?: string;
	version: string;
	description: string;
	/** `plugins`: id to version range (docs/plugins.md §7.11). */
	requires: { seams: SeamId[]; plugins: Record<string, string> };
	/** Seams and events this plugin owns, full names. */
	owns: { seams: Record<string, OwnedSeamDeclaration>; events: Record<string, OwnedEventDeclaration> };
	/** Environment variable to the path of the setting it fills, inside the plugin's settings. */
	env: Record<string, string>;
	describe?: string;
	/** Reelix works fully without it: "not used" until any of its required setup is filled in. */
	optional: boolean;
	/** Its screen: the HTML file inside the folder, and its English title. */
	screen?: { entry: string; title: string };
	uses: {
		/** Reelix's seams, and seams other plugins own (`<id>:<name>@<n>`). */
		provides: string[];
		hooks: HookId[];
		/** Short names; `effects` holds what each declares. */
		operations: string[];
		effects: Record<string, Effect>;
		tools: string[];
		jobs: string[];
		events: string[];
		runs: string[];
		network: string[];
		secrets: SecretDeclaration[];
		agent: boolean;
		inbox: boolean;
		skills: boolean;
		model: boolean;
		/** Model roles besides `background` it asks for, and whether it asks for no daily budget (docs/plugins.md §10.2). */
		modelRoles: ModelRole[];
		unmetered: boolean;
		pi: boolean;
		native: boolean;
	};
};

const ID = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
/** A seam a plugin owns, `<id>:<name>@<version>`, and an event, `<id>:<name>`. */
const PLUGIN_SEAM = /^([a-z][a-z0-9-]{0,38}[a-z0-9]):([a-z][a-z0-9.-]{0,39})@([1-9]\d*)$/;
const PLUGIN_EVENT = /^([a-z][a-z0-9-]{0,38}[a-z0-9]):([a-z][a-z0-9.-]{0,39})$/;
const ENV_NAME = /^REELIX_[A-Z0-9_]+$/;
const SETTING_PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const SUMMARY_LIMIT = 300;
const DESCRIBE_LIMIT = 200;
const MAX_LIMIT_MS = 10 * 60_000;
/** Typed agent tools per plugin; the rest of its operations go through the `reelix` tool (§6.1). */
export const MAX_TYPED_TOOLS = 3;
const NETWORK = /^(\*|config:[A-Za-z0-9_.]+|(\*\.)?[A-Za-z0-9.-]+)$/;
const EFFECTS: readonly Effect[] = ["read", "write", "destructive", "admin"];

function stringList(value: unknown, key: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error(`reelix.${key} must be a list of names`);
	return value;
}

/** A secret in `uses.secrets`, with its flags filled in. */
export type SecretDeclaration = { name: string; managed: boolean; required: boolean; per?: string };

const SECRET_NAME = /^[a-z][a-z0-9_]{0,39}$/;

function secretList(value: unknown): SecretDeclaration[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("reelix.uses.secrets must be a list");
	const out = value.map((v): SecretDeclaration => {
		if (typeof v === "string") v = { name: v };
		if (!isObject(v) || typeof v.name !== "string" || !SECRET_NAME.test(v.name)) throw new Error("reelix.uses.secrets: each entry is a name (lowercase letters, digits, _) or { name, managed, required, per }");
		if (v.per !== undefined && (typeof v.per !== "string" || !SECRET_NAME.test(v.per))) throw new Error(`reelix.uses.secrets: "per" of ${v.name} must name a list setting`);
		if (v.managed === true && v.required === true) throw new Error(`reelix.uses.secrets: ${v.name} cannot be both managed and required`);
		return { name: v.name, managed: v.managed === true, required: v.required === true, ...(v.per ? { per: v.per as string } : {}) };
	});
	const names = out.map((s) => s.name);
	if (new Set(names).size !== names.length) throw new Error("reelix.uses.secrets: a name appears twice");
	return out;
}

/** The secret's name as the plugin asks for it (`api_key`, or `servers.0.api_key` for one declared per entry), if it is declared. */
export function declaredSecret(secrets: SecretDeclaration[], asked: string): SecretDeclaration | undefined {
	return secrets.find((s) => (s.per ? new RegExp(`^${s.per}\\.\\d+\\.${s.name}$`).test(asked) : s.name === asked));
}

function seamList(value: unknown, key: string): SeamId[] {
	const list = stringList(value, key);
	for (const s of list) if (!SEAM_IDS.includes(s as SeamId)) throw new Error(`reelix.${key}: there is no seam "${s}"`);
	return list as SeamId[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `uses.provides` and `uses.events`: Reelix's own, or another plugin's, which that plugin must be required for. */
function foreignNames(list: string[], key: string, own: string, required: Record<string, string>, core: readonly string[], pattern: RegExp, what: string): string[] {
	for (const name of list) {
		if (core.includes(name)) continue;
		const owner = pattern.exec(name)?.[1];
		if (!owner || owner === "reelix") throw new Error(`reelix.${key}: there is no ${what} "${name}"`);
		if (owner !== own && !Object.hasOwn(required, owner)) throw new Error(`reelix.${key}: "${name}" belongs to the plugin ${owner}; add it to reelix.requires.plugins`);
	}
	return list;
}

function requiredPlugins(value: unknown, own: string): Record<string, string> {
	if (value === undefined) return {};
	if (!isObject(value)) throw new Error('reelix.requires.plugins must map plugin ids to version ranges: { "release-tags": "^0.1.0" }');
	for (const [id, range] of Object.entries(value)) {
		if (!ID.test(id)) throw new Error(`reelix.requires.plugins: "${id}" is not a plugin id`);
		if (id === own) throw new Error("reelix.requires.plugins: a plugin cannot require itself");
		if (typeof range !== "string" || !understoodRange(range)) throw new Error(`reelix.requires.plugins: the range of ${id} (${JSON.stringify(range)}) is not understood; use one such as "^0.1.0" or ">=1.2 <2"`);
	}
	return value as Record<string, string>;
}

const summaryOf = (v: unknown, at: string) => {
	if (typeof v !== "string" || !v.trim() || v.length > SUMMARY_LIMIT) throw new Error(`${at}: summary must be 1 to ${SUMMARY_LIMIT} characters`);
	return v;
};

/** `owns`: each name starts with the plugin's own id; a seam's methods give a time limit and a JSON Schema of the result. */
function owned(value: unknown, own: string): Manifest["owns"] {
	if (value === undefined) return { seams: {}, events: {} };
	if (!isObject(value) || Object.keys(value).some((k) => k !== "seams" && k !== "events")) throw new Error("reelix.owns has seams and events");
	const seams: Record<string, OwnedSeamDeclaration> = {};
	const events: Record<string, OwnedEventDeclaration> = {};
	if (value.seams !== undefined && !isObject(value.seams)) throw new Error("reelix.owns.seams must map seam names to their contracts");
	for (const [name, d] of Object.entries(value.seams ?? {})) {
		const at = `reelix.owns.seams["${name}"]`;
		if (PLUGIN_SEAM.exec(name)?.[1] !== own) throw new Error(`${at}: a seam a plugin owns is named ${own}:<name>@<version>, such as ${own}:tagger@1`);
		if (!isObject(d) || !isObject(d.methods) || !Object.keys(d.methods).length) throw new Error(`${at}: give a summary and at least one method`);
		const methods: OwnedSeamDeclaration["methods"] = {};
		for (const [m, spec] of Object.entries(d.methods)) {
			if (!/^[a-z][A-Za-z0-9]*$/.test(m)) throw new Error(`${at}: "${m}" is not a method name`);
			if (!isObject(spec) || !isObject(spec.result)) throw new Error(`${at}.methods.${m}: result must be a JSON Schema of what the method returns`);
			if (spec.limitMs !== undefined && !(Number.isInteger(spec.limitMs) && (spec.limitMs as number) >= 100 && (spec.limitMs as number) <= MAX_LIMIT_MS)) throw new Error(`${at}.methods.${m}: limitMs must be a whole number from 100 to ${MAX_LIMIT_MS}`);
			methods[m] = { result: spec.result, ...(spec.limitMs === undefined ? {} : { limitMs: spec.limitMs as number }) };
		}
		seams[name] = { summary: summaryOf(d.summary, at), methods };
	}
	if (value.events !== undefined && !isObject(value.events)) throw new Error("reelix.owns.events must map event names to their payloads");
	for (const [name, d] of Object.entries(value.events ?? {})) {
		const at = `reelix.owns.events["${name}"]`;
		if (PLUGIN_EVENT.exec(name)?.[1] !== own) throw new Error(`${at}: an event a plugin owns is named ${own}:<name>`);
		if (!isObject(d) || !isObject(d.payload)) throw new Error(`${at}: give a summary and payload, a JSON Schema`);
		events[name] = { summary: summaryOf(d.summary, at), payload: d.payload };
	}
	return { seams, events };
}

function envMap(value: unknown): Record<string, string> {
	if (value === undefined) return {};
	if (!isObject(value)) throw new Error('reelix.env must map environment variables to settings: { "REELIX_DEFAULT_QBITTORRENT_URL": "url" }');
	for (const [name, path] of Object.entries(value)) {
		if (!ENV_NAME.test(name)) throw new Error(`reelix.env: "${name}" must be REELIX_ followed by capitals, digits and _`);
		if (typeof path !== "string" || !SETTING_PATH.test(path)) throw new Error(`reelix.env: the setting of ${name} must be a path inside the plugin's settings, such as url or servers.0.url`);
	}
	return value as Record<string, string>;
}

function describeLine(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > DESCRIBE_LIMIT || /[\r\n]/.test(value)) throw new Error(`reelix.describe must be one line of at most ${DESCRIBE_LIMIT} characters`);
	return value;
}

function hookList(value: unknown, key: string): HookId[] {
	const list = stringList(value, key);
	for (const h of list) if (!HOOK_IDS.includes(h as HookId)) throw new Error(`reelix.${key}: there is no hook "${h}"`);
	return list as HookId[];
}

function effectMap(value: unknown): Record<string, Effect> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error('reelix.uses.operations must map each operation\'s short name to its effect: { "scan": "read" }');
	for (const [name, effect] of Object.entries(value)) if (!EFFECTS.includes(effect as Effect)) throw new Error(`reelix.uses.operations: the effect of "${name}" must be read, write, destructive or admin`);
	return value as Record<string, Effect>;
}

/** `uses.model`: `true`, or what it asks for beyond the background role and the daily budget. */
function modelUse(value: unknown): { model: boolean; modelRoles: ModelRole[]; unmetered: boolean } {
	if (value === undefined || value === false) return { model: false, modelRoles: [], unmetered: false };
	if (value === true) return { model: true, modelRoles: [], unmetered: false };
	const v = value as { roles?: unknown; unmetered?: unknown };
	if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(v).some((k) => k !== "roles" && k !== "unmetered")) throw new Error('reelix.uses.model must be true or { "roles": [...], "unmetered": true }');
	const roles = stringList(v.roles, "uses.model.roles");
	for (const r of roles) if (!MODEL_ROLES.includes(r as ModelRole)) throw new Error(`reelix.uses.model.roles: there is no role "${r}"; the roles are ${MODEL_ROLES.join(", ")}`);
	if (v.unmetered !== undefined && typeof v.unmetered !== "boolean") throw new Error("reelix.uses.model.unmetered must be true or false");
	return { model: true, modelRoles: roles.filter((r) => r !== "background") as ModelRole[], unmetered: v.unmetered === true };
}

/** Whether the plugin can run in a process of its own: a raw pi extension and compiled code cannot (docs/plugins.md §10.4, §11.7). */
export const processAllowed = (m: Manifest): boolean => !!m.entry && !m.uses.pi && !m.uses.native;

const SCREEN_TITLE_LIMIT = 40;

/** `screen`: an HTML file inside the folder and a short title. */
function screenOf(dir: string, value: unknown): Manifest["screen"] {
	if (value === undefined) return undefined;
	const v = value as { entry?: unknown; title?: unknown };
	if (!isObject(value) || Object.keys(value).some((k) => k !== "entry" && k !== "title")) throw new Error('reelix.screen must be { "entry": "screen/index.html", "title": "…" }');
	if (typeof v.entry !== "string" || !v.entry.endsWith(".html")) throw new Error("reelix.screen.entry must name an .html file");
	const file = normalize(v.entry);
	if (isAbsolute(file) || file.split(sep).some((part) => part === ".." || part === "node_modules")) throw new Error("reelix.screen.entry must be inside the plugin's folder");
	if (!existsSync(join(dir, file))) throw new Error(`the screen file ${v.entry} does not exist`);
	if (typeof v.title !== "string" || !v.title.trim() || v.title.length > SCREEN_TITLE_LIMIT || /[\r\n]/.test(v.title)) throw new Error(`reelix.screen.title must be one line of 1 to ${SCREEN_TITLE_LIMIT} characters`);
	return { entry: file, title: v.title };
}

function readPackage(dir: string): Record<string, any> {
	const file = join(dir, "package.json");
	if (!existsSync(file)) throw new Error("the folder has no package.json");
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		throw new Error(`package.json cannot be read: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Why this Reelix cannot run the plugin in `dir`, or nothing (docs/plugins.md §13.4): its `api` differs,
 * or its `engines.reelix` does not include this version. Reads package.json only.
 */
export function incompatibility(dir: string): string | undefined {
	const pkg = readPackage(dir);
	const api = pkg.reelix?.api;
	if (api !== PLUGIN_API) return `it is written for plugin API ${JSON.stringify(api)}; this Reelix has API ${PLUGIN_API}`;
	const range = pkg.engines?.reelix;
	if (range === undefined) return undefined;
	if (typeof range !== "string" || !satisfies(REELIX_VERSION, range)) return `it needs Reelix ${JSON.stringify(range)}; this is Reelix ${REELIX_VERSION}`;
	return undefined;
}

/** The skills of a package: each folder under `skills/` holding a SKILL.md, by name. */
export function skillNames(dir: string): string[] {
	const root = join(dir, "skills");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory() && existsSync(join(root, e.name, "SKILL.md")))
		.map((e) => e.name)
		.sort();
}

/** Everything under `skills/` that is not Markdown: what the agent may run (docs/plugins.md §11.1). */
export function skillScripts(dir: string): string[] {
	const root = join(dir, "skills");
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (!e.name.toLowerCase().endsWith(".md")) out.push(relative(dir, p).split(sep).join("/"));
		}
	};
	if (existsSync(root)) walk(root);
	return out.sort();
}

/** Read and check the `reelix` key of a plugin folder's package.json (docs/plugins.md §5.1). Unknown keys are ignored. */
export function readManifest(dir: string, reservedWords: ReadonlySet<string>): Manifest {
	const pkg = readPackage(dir);
	const r = pkg.reelix;
	if (typeof r !== "object" || r === null) throw new Error('package.json has no "reelix" section');
	if (typeof r.id !== "string" || !ID.test(r.id)) throw new Error(`"${r.id}" is not a valid plugin id: use 2 to 40 lowercase letters, digits and hyphens, starting with a letter`);
	if (reservedWords.has(r.id)) throw new Error(`the id "${r.id}" is taken: Reelix's own operations start with that word`);
	if (r.api !== PLUGIN_API) throw new Error(`this plugin is written for plugin API ${JSON.stringify(r.api)}; this Reelix has API ${PLUGIN_API}`);
	const uses = typeof r.uses === "object" && r.uses !== null ? r.uses : {};
	const requires = typeof r.requires === "object" && r.requires !== null ? r.requires : {};
	const skills = skillNames(dir);
	let entry: string | undefined;
	if (r.entry === undefined) {
		// A skill pack: its skills and nothing else.
		if (!skills.length) throw new Error("a skill pack (no reelix.entry) needs a skills folder with at least one skills/<name>/SKILL.md");
		const extra = [...Object.keys(uses).filter((k) => k !== "skills").map((k) => `uses.${k}`), ...Object.keys(requires).map((k) => `requires.${k}`), ...["settings", "owns", "env", "describe", "screen"].filter((k) => r[k] !== undefined)];
		if (extra.length) throw new Error(`a skill pack has no code, so it declares nothing but skills; remove ${extra.join(", ")}`);
	} else {
		if (r.runtime !== "in-process" && r.runtime !== "process") throw new Error(`runtime ${JSON.stringify(r.runtime)} is not supported; use "in-process" or "process"`);
		if (r.runtime === "process" && (uses.pi === true || uses.native === true)) throw new Error(`runtime "process" cannot run ${uses.pi === true ? "a raw pi extension (uses.pi)" : "compiled dependencies (uses.native)"}; use "in-process"`);
		if (typeof r.entry !== "string" || !/\.(ts|mts|js|mjs)$/.test(r.entry)) throw new Error("reelix.entry must name a .ts or .js file");
		entry = normalize(r.entry);
		if (isAbsolute(entry) || entry.split(sep).some((part) => part === ".." || part === "node_modules")) throw new Error("reelix.entry must be inside the plugin's folder and not under node_modules");
		if (!existsSync(join(dir, entry))) throw new Error(`the entry file ${r.entry} does not exist`);
		if (uses.skills === true && !skills.length) throw new Error("reelix.uses.skills is set but there is no skills/<name>/SKILL.md");
		if (uses.skills !== true && existsSync(join(dir, "skills")) && statSync(join(dir, "skills")).isDirectory()) throw new Error("the plugin has a skills folder; declare it with reelix.uses.skills: true");
	}
	let settings: string | undefined;
	if (r.settings !== undefined) {
		if (typeof r.settings !== "string" || !r.settings.endsWith(".json")) throw new Error("reelix.settings must name a .json file");
		settings = normalize(r.settings);
		if (isAbsolute(settings) || settings.split(sep).includes("..")) throw new Error("reelix.settings must be inside the plugin's folder");
		if (!existsSync(join(dir, settings))) throw new Error(`the settings file ${r.settings} does not exist`);
	}
	const network = stringList(uses.network, "uses.network");
	for (const n of network) if (!NETWORK.test(n)) throw new Error(`reelix.uses.network: "${n}" is not a host, *.host, config:<setting> or *`);
	const effects = effectMap(uses.operations);
	const operations = Object.keys(effects);
	const tools = stringList(uses.tools, "uses.tools");
	for (const t of tools) if (!operations.includes(t)) throw new Error(`reelix.uses.tools: "${t}" must also be in uses.operations`);
	if (tools.length > MAX_TYPED_TOOLS) throw new Error(`reelix.uses.tools: a plugin has at most ${MAX_TYPED_TOOLS} typed tools; reach the others through the reelix tool`);
	const plugins = requiredPlugins(requires.plugins, r.id);
	return {
		api: PLUGIN_API,
		id: r.id,
		entry,
		runtime: entry === undefined ? "in-process" : r.runtime,
		settings,
		version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
		description: typeof pkg.description === "string" ? pkg.description : "",
		requires: { seams: seamList(requires.seams, "requires.seams"), plugins },
		owns: owned(r.owns, r.id),
		env: envMap(r.env),
		describe: describeLine(r.describe),
		optional: r.optional === true,
		screen: screenOf(dir, r.screen),
		uses: {
			provides: foreignNames(stringList(uses.provides, "uses.provides"), "uses.provides", r.id, plugins, SEAM_IDS, PLUGIN_SEAM, "seam"),
			hooks: hookList(uses.hooks, "uses.hooks"),
			operations,
			effects,
			tools,
			jobs: stringList(uses.jobs, "uses.jobs"),
			events: foreignNames(stringList(uses.events, "uses.events"), "uses.events", r.id, plugins, PLUGIN_EVENTS, PLUGIN_EVENT, "event"),
			runs: stringList(uses.runs, "uses.runs"),
			network,
			secrets: secretList(uses.secrets),
			agent: uses.agent === true,
			inbox: uses.inbox === true,
			skills: entry === undefined || uses.skills === true,
			...modelUse(uses.model),
			pi: uses.pi === true,
			native: uses.native === true,
		} satisfies Record<keyof Uses | "effects" | "modelRoles" | "unmetered", unknown>,
	};
}

/** What the install and approval screens show: the manifest's declarations, never anything from the code (docs/plugins.md §11.1). */
export function declarations(dir: string, m: Manifest): PluginDeclarations {
	const pkg = readPackage(dir);
	return {
		id: m.id,
		version: m.version,
		description: m.description,
		license: typeof pkg.license === "string" ? pkg.license : undefined,
		kind: m.entry === undefined ? "skills" : "plugin",
		provides: m.uses.provides,
		requires: m.requires.seams,
		requiresPlugins: Object.entries(m.requires.plugins).map(([id, range]) => ({ id, range })),
		owns: [...Object.keys(m.owns.seams), ...Object.keys(m.owns.events)],
		hooks: m.uses.hooks,
		events: m.uses.events,
		operations: m.uses.operations.map((name) => ({ name: `${m.id}.${name}`, effect: m.uses.effects[name]!, ...(m.uses.tools.includes(name) ? { tool: `${m.id}_${name}` } : {}) })),
		jobs: m.uses.jobs,
		runs: m.uses.runs,
		network: m.uses.network,
		anyHost: m.uses.network.includes("*"),
		secrets: m.uses.secrets.map((s) => `plugins.${m.id}.${s.per ? `${s.per}.<n>.` : ""}${s.name}`),
		skills: m.uses.skills ? skillNames(dir) : [],
		scripts: m.uses.skills ? skillScripts(dir) : [],
		agent: m.uses.agent,
		inbox: m.uses.inbox,
		model: m.uses.model,
		modelRoles: m.uses.modelRoles,
		unmetered: m.uses.unmetered,
		pi: m.uses.pi,
		native: m.uses.native,
		runtime: m.runtime,
		processAllowed: processAllowed(m),
		screen: m.screen?.title,
	};
}

/** The plugin's `locales/<lang>.json` files. English is the fallback; the others are optional (§6). */
export function loadMessages(dir: string): Catalog {
	const catalog: Catalog = {};
	for (const lang of LANGUAGES) {
		const file = join(dir, "locales", `${lang}.json`);
		if (existsSync(file)) catalog[lang] = JSON.parse(readFileSync(file, "utf8")) as Messages;
	}
	return catalog;
}
