import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import YAML from "yaml";
import { outsideLine } from "@reelix/plugin";
import type { Reelix } from "./app.ts";
import { ReelixError } from "./util.ts";

/** Where Reelix keeps its own state. `/data` in the container; overridable for development. */
export function dataDir(): string {
	return resolve(process.env.REELIX_DATA ?? "/data");
}

export function dataPaths(root = dataDir()) {
	return {
		root,
		config: join(root, "config.yaml"),
		configGood: join(root, ".config.last-good.yaml"),
		secrets: join(root, "secrets.yaml"),
		db: join(root, "reelix.db"),
		notes: join(root, "notes"),
		skills: join(root, "skills"),
		/** Plugins the owner installed (docs/plugins.md §13.1). */
		plugins: join(root, "plugins"),
		themes: join(root, "themes"),
		sessions: join(root, "sessions"),
		pi: join(root, "pi"),
		/** Plugins' own folders for larger files, one per plugin id (docs/plugins.md §6). */
		pluginData: join(root, "plugin-data"),
		workspace: join(root, "workspace"),
		backups: join(root, "backups"),
		/** The owner's socket: Reelix's user only (docs/plugins.md §11.3). */
		socket: join(root, "reelix.sock"),
		/** The agent's socket: every call needs a session's token, and it never counts as the owner. */
		agentSocket: join(root, "agent.sock"),
		ownerToken: join(root, "owner.token"),
		lock: join(root, "reelix.lock"),
		cache: join(root, "cache"),
	};
}

export type DataPaths = ReturnType<typeof dataPaths>;

export function ensureDataDirs(p: DataPaths): void {
	for (const d of [p.root, p.notes, p.skills, p.themes, p.sessions, p.pi, p.workspace, p.backups, p.cache]) mkdirSync(d, { recursive: true });
	// HOME in the image (the container user has no home of its own)
	mkdirSync(join(p.root, "home"), { recursive: true });
	// The agent's browser became the plugin `browser`: its Chromium profile moves into that plugin's folder, once.
	const profile = join(p.root, "browser-profile");
	if (existsSync(profile) && !existsSync(join(p.pluginData, "browser"))) {
		mkdirSync(join(p.pluginData, "browser"), { recursive: true });
		renameSync(profile, join(p.pluginData, "browser", "chromium-profile"));
	}
}

const PathMap = Type.Object({ theirs: Type.String(), ours: Type.String() });

export const LANGUAGES = ["en", "zh", "fr", "ru"] as const;
export const DEFAULT_SUBTITLE_SOURCES = ["subhd", "assrt", "opensubtitles", "subdl", "gestdown", "jimaku"] as const;
export type Language = (typeof LANGUAGES)[number];
/** The owner's language as TMDB asks for it: titles, overviews and posters follow the owner. */
export const TMDB_LOCALES: Record<Language, string> = { en: "en-US", zh: "zh-CN", fr: "fr-FR", ru: "ru-RU" };

export const ConfigSchema = Type.Object({
	/** The owner's language: web UI, the agent's own messages, inbox notices, chat apps. Unset: the browser's. */
	language: Type.Optional(Type.Union(LANGUAGES.map((l) => Type.Literal(l)), { description: "en, zh, fr or ru" })),
	media_root: Type.String({ default: "/media" }),
	downloads: Type.Optional(Type.String()),
	library: Type.Object(
		{
			movies: Type.Optional(Type.String()),
			shows: Type.Optional(Type.String()),
			anime: Type.Optional(Type.String()),
		},
		{ default: {} },
	),
	path_maps: Type.Object(
		{
			/** Per downloader provider id: how its paths look to Reelix (docs/plugins.md §7.5). */
			downloaders: Type.Record(Type.String(), Type.Array(PathMap), { default: {} }),
			/** Per media server provider id: how Reelix's library paths look to it (docs/plugins.md §7.7). */
			media_servers: Type.Record(Type.String(), Type.Array(PathMap), { default: {} }),
		},
		{ default: { downloaders: {}, media_servers: {} } },
	),
	/** The active downloader, a provider id of reelix:downloader@1. The owner's choice; Reelix never switches by itself. */
	downloader: Type.String({ default: "qbittorrent" }),
	/** The active media server, a provider id of reelix:media.server@1. The owner's choice, like the downloader. */
	media_server: Type.String({ default: "jellyfin" }),
	/** The active translator, a provider id of reelix:translator@1. The owner's choice, like the downloader. */
	translator: Type.String({ default: "model-translator" }),
	/** Players (provider ids of reelix:player@1) in the order their links are offered; others follow. */
	players: Type.Array(Type.String(), { default: ["infuse", "swiftfin", "jellyfin"] }),
	tmdb: Type.Object(
		{
			base_url: Type.String({ default: "https://api.themoviedb.org/3" }),
			image_base_url: Type.String({ default: "https://image.tmdb.org/t/p" }),
		},
		{ default: {} },
	),
	proxy: Type.Object(
		{
			default: Type.Optional(Type.String()),
			use_for: Type.Array(Type.String(), { default: [] }),
			per_service: Type.Record(Type.String(), Type.String(), { default: {} }),
		},
		{ default: {} },
	),
	subtitles: Type.Object(
		{
			/** Subtitle sources in order of preference; each is used only for the languages and kinds it covers. */
			sources: Type.Array(Type.String(), { default: [...DEFAULT_SUBTITLE_SOURCES] }),
			/** Wanted subtitle languages in order (zh, en, fr, ru, ja). Unset: from the owner's language. */
			languages: Type.Optional(Type.Array(Type.String())),
		},
		{ default: {} },
	),
	models: Type.Object(
		{
			roles: Type.Object(
				{
					chat: Type.Array(Type.String(), { default: [], description: "provider/model-id as pi knows it, in order of preference" }),
					background: Type.Array(Type.String(), { default: [] }),
					glossary: Type.Array(Type.String(), { default: [] }),
					translate: Type.Array(Type.String(), { default: [] }),
					review: Type.Array(Type.String(), { default: [] }),
				},
				{ default: {} },
			),
			thinking: Type.String({ default: "low" }),
			main_reads_images: Type.Boolean({ default: true }),
		},
		{ default: {} },
	),
	magpie: Type.Object(
		{
			url: Type.Optional(Type.String({ description: "a magpie gateway, e.g. http://127.0.0.1:3425 (optional; its models appear as magpie/…)" })),
		},
		{ default: {} },
	),
	translation: Type.Object(
		{
			chunk_lines: Type.Number({ default: 60, minimum: 10, maximum: 300 }),
			review_sample: Type.Number({ default: 40, minimum: 0, maximum: 400 }),
			call_timeout_s: Type.Number({ default: 300, minimum: 30, maximum: 3600, description: "one model call longer than this counts as failed (a model that keeps thinking)" }),
		},
		{ default: {} },
	),
	limits: Type.Object(
		{
			background_daily_usd: Type.Number({ default: 1 }),
			background_daily_tokens: Type.Number({ default: 2_000_000 }),
			/** A plugin's daily model budget unless the owner set its own (docs/plugins.md §10.2). */
			plugin_daily_usd: Type.Number({ default: 0.25, minimum: 0 }),
			/** What making "For you" may spend on the model in a day (docs/trends.md §2). */
			suggestions_daily_usd: Type.Number({ default: 0.25, minimum: 0 }),
			shell_timeout_s: Type.Number({ default: 120 }),
			shell_timeout_max_s: Type.Number({ default: 1800 }),
			stalled_after_h: Type.Number({ default: 12 }),
			trash_days: Type.Number({ default: 14 }),
		},
		{ default: {} },
	),
	web: Type.Object(
		{
			host: Type.String({ default: "0.0.0.0" }),
			port: Type.Number({ default: 7878 }),
			allowed_origins: Type.Array(Type.String(), { default: [] }),
		},
		{ default: {} },
	),
	/** Each plugin's own settings, checked against its schema before it starts (docs/plugins.md §12.2). */
	plugins: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
	schedule: Type.Object(
		{
			nightly_at: Type.String({ default: "03:30" }),
			timezone: Type.Optional(Type.String()),
		},
		{ default: {} },
	),
});

export type Config = Static<typeof ConfigSchema>;

/**
 * Older settings, carried forward: `tmdb.language` (before Reelix had one language for everything)
 * becomes the owner's `language` when that is not set, and is dropped.
 */
export const MODEL_ROLES = ["chat", "background", "glossary", "translate", "review"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
/** A role with no models of its own uses its parent's. */
export const ROLE_PARENT: Record<ModelRole, ModelRole | undefined> = { chat: undefined, background: "chat", glossary: "background", translate: "background", review: "translate" };

/** The ordered model list a role uses, after inheritance. Empty: pi's default model. */
export function roleModels(c: Config, role: ModelRole): string[] {
	for (let r: ModelRole | undefined = role; r; r = ROLE_PARENT[r]) if (c.models.roles[r].length) return c.models.roles[r];
	return [];
}

function migrateConfig(raw: any): any {
	if (raw?.tmdb && typeof raw.tmdb === "object" && "language" in raw.tmdb) {
		const l = String(raw.tmdb.language ?? "").slice(0, 2).toLowerCase();
		if (!raw.language && (LANGUAGES as readonly string[]).includes(l)) raw.language = l;
		delete raw.tmdb.language;
	}
	// models.main / models.background became the chat and background roles (ordered lists).
	if (raw?.models && typeof raw.models === "object") {
		const m = raw.models;
		m.roles = m.roles && typeof m.roles === "object" ? m.roles : {};
		if (typeof m.main === "string" && m.main && !m.roles.chat?.length) m.roles.chat = [m.main];
		if (typeof m.background === "string" && m.background && !m.roles.background?.length) m.roles.background = [m.background];
		delete m.main;
		delete m.background;
	}
	// The old default list (saved out by earlier versions) gains the sources added since.
	const src = raw?.subtitles?.sources;
	if (Array.isArray(src) && src.length === 2 && src[0] === "subhd" && src[1] === "assrt") raw.subtitles.sources = [...DEFAULT_SUBTITLE_SOURCES];
	return raw;
}

/** Settings of services that became plugins: where they lived, and the defaults that need not move. */
const SUBTITLE_SITE_SETTINGS: Record<string, string> = {
	subhd_url: "https://subhd.me",
	assrt_url: "https://api.assrt.net",
	opensubtitles_url: "https://api.opensubtitles.com/api/v1",
	subdl_url: "https://api.subdl.com/api/v1",
	subdl_download_url: "https://dl.subdl.com",
	gestdown_url: "https://api.gestdown.info",
	jimaku_url: "https://jimaku.cc/api",
};

const TELEGRAM_API = "https://api.telegram.org";
const BANGUMI_API = "https://api.bgm.tv";

/** A chat channel's owner found in old settings; pairing now lives in the database (docs/plugins.md §12.2). */
export type MovedOwner = { channel: string; owner: string };

/** One-time move of a config file's old keys under `plugins.<id>` (docs/plugins.md §12.2). True when it changed anything. */
function moveSettingsToPlugins(raw: any, owners: MovedOwner[]): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	let moved = false;
	const plugin = (id: string) => ((raw.plugins ??= {})[id] ??= {});
	if ("jackett" in raw) {
		if (raw.jackett?.url) (plugin("jackett").servers ??= []).push({ url: raw.jackett.url });
		delete raw.jackett;
		moved = true;
	}
	if ("qbittorrent" in raw) {
		if (raw.qbittorrent?.url) plugin("qbittorrent").url = raw.qbittorrent.url;
		if (raw.qbittorrent?.username && raw.qbittorrent.username !== "admin") plugin("qbittorrent").username = raw.qbittorrent.username;
		delete raw.qbittorrent;
		moved = true;
	}
	if ("jellyfin" in raw) {
		const j = raw.jellyfin ?? {};
		for (const key of ["url", "public_url", "watch_users"]) if (j[key] !== undefined && j[key] !== "" && !(Array.isArray(j[key]) && !j[key].length)) plugin("jellyfin")[key] = j[key];
		delete raw.jellyfin;
		moved = true;
	}
	if ("bangumi" in raw) {
		if (raw.bangumi?.base_url && raw.bangumi.base_url !== BANGUMI_API) plugin("bangumi").base_url = raw.bangumi.base_url;
		delete raw.bangumi;
		moved = true;
	}
	// A path map now belongs to a provider, by its id: a downloader's, or a media server's.
	for (const [old, under] of [["qbittorrent", "downloaders"], ["jellyfin", "media_servers"]] as const) {
		if (!raw.path_maps || typeof raw.path_maps !== "object" || !(old in raw.path_maps)) continue;
		const map = raw.path_maps[old];
		if (Array.isArray(map) && map.length) (raw.path_maps[under] ??= {})[old] ??= map;
		delete raw.path_maps[old];
		moved = true;
	}
	if ("telegram" in raw) {
		if (raw.telegram?.api_url && raw.telegram.api_url !== TELEGRAM_API) plugin("telegram").api_url = raw.telegram.api_url;
		if (raw.telegram?.owner_id) owners.push({ channel: "telegram", owner: String(raw.telegram.owner_id) });
		delete raw.telegram;
		moved = true;
	}
	for (const [key, standard] of Object.entries(SUBTITLE_SITE_SETTINGS)) {
		if (!raw.subtitles || !(key in raw.subtitles)) continue;
		if (raw.subtitles[key] !== standard) plugin("subtitle-sites")[key] = raw.subtitles[key];
		delete raw.subtitles[key];
		moved = true;
	}
	return moved;
}

/** Fill defaults and validate. Throws a ReelixError listing every problem. */
export function parseConfig(raw: unknown): Config {
	const v = Value.Default(ConfigSchema, migrateConfig(Value.Clone(raw ?? {})));
	const errors = [...Value.Errors(ConfigSchema, v)];
	if (errors.length) {
		throw new ReelixError(
			"config_invalid",
			"config.yaml is invalid: " + errors.map((e) => `${(e as { instancePath?: string }).instancePath || "/"} ${e.message}`).join("; "),
		);
	}
	return v as Config;
}

/** `keepOwner` stores an owner found in old settings; it runs before the old file is replaced. */
export function loadConfig(p: DataPaths, keepOwner: (o: MovedOwner) => void): { config: Config; warning?: string } {
	if (!existsSync(p.config)) return { config: parseConfig({}) };
	const text = readFileSync(p.config, "utf8");
	const read = (yaml: string) => {
		const raw = YAML.parse(yaml) ?? {};
		const owners: MovedOwner[] = [];
		const moved = moveSettingsToPlugins(raw, owners);
		const config = parseConfig(raw);
		owners.forEach(keepOwner);
		return { config, moved };
	};
	try {
		const { config, moved } = read(text);
		if (moved) saveConfig(p, config);
		else writeFileSync(p.configGood, text);
		return { config };
	} catch (e) {
		// Keep the last good version and say what was wrong.
		if (existsSync(p.configGood)) {
			const { config } = read(readFileSync(p.configGood, "utf8"));
			return { config, warning: `config.yaml was edited and is invalid; using the last good version. ${(e as Error).message}` };
		}
		throw e;
	}
}

export function saveConfig(p: DataPaths, config: Config): void {
	parseConfig(config);
	const doc = new YAML.Document(config);
	const text = "# Reelix settings. Edit by hand or with `reelix config set`. Secrets live in secrets.yaml.\n" + doc.toString();
	mkdirSync(dirname(p.config), { recursive: true });
	const tmp = p.config + ".tmp";
	// Reelix's user only, like the rest of the data folder (docs/plugins.md §11.3); the agent has `reelix config`.
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, p.config);
	writeFileSync(p.configGood, text, { mode: 0o600 });
}

/** The web app's own address, or one the owner listed: the only pages that may talk to this Reelix. */
export function originAllowed(app: { config: Config }, origin: string, host: string | undefined): boolean {
	try {
		return new URL(origin).host === host || app.config.web.allowed_origins.includes(origin);
	} catch {
		return false;
	}
}

/** Path segments that would walk into an object's prototype instead of its data. */
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const isUnsafePath = (keys: string[]) => keys.some((k) => UNSAFE_SEGMENTS.has(k));

/** Whether a dotted path names a real setting (records accept any key below them). */
export function isKnownConfigPath(path: string): boolean {
	const keys = path.split(".");
	if (isUnsafePath(keys)) return false;
	let s: any = ConfigSchema;
	for (const k of keys) {
		if (s?.type === "object" && s.properties && Object.hasOwn(s.properties, k)) s = s.properties[k];
		else if (s?.patternProperties || (s?.type === "object" && s.additionalProperties && typeof s.additionalProperties === "object")) return true;
		else if (s?.type === "array" && /^\d+$/.test(k)) s = s.items;
		else return false;
	}
	return true;
}

/** Get a value by dotted path, e.g. "limits.shell_timeout_s". */
export function getPath(obj: unknown, path: string): unknown {
	const keys = path.split(".");
	if (isUnsafePath(keys)) return undefined;
	let cur: unknown = obj;
	for (const k of keys) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[k];
	}
	return cur;
}

/** The dotted paths whose value differs between two settings objects. */
export function changedPaths(before: unknown, after: unknown, prefix = ""): string[] {
	const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
	if (isObject(before) && isObject(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((k) => changedPaths(before[k], after[k], prefix ? `${prefix}.${k}` : k));
	return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
	const keys = path.split(".");
	if (isUnsafePath(keys)) throw new ReelixError("invalid_path", `"${path}" is not a usable name.`);
	let cur: Record<string, unknown> = obj;
	keys.slice(0, -1).forEach((k, i) => {
		// A number as the next key means a list: plugins.jackett.servers.0.url
		if (cur[k] == null || typeof cur[k] !== "object") cur[k] = /^\d+$/.test(keys[i + 1]!) ? [] : {};
		cur = cur[k] as Record<string, unknown>;
	});
	const last = keys[keys.length - 1]!;
	if (value === undefined) delete cur[last];
	else cur[last] = value;
}

type ConfigAndSecrets = { config: Config; secrets: Secrets };

/**
 * Settings that are the owner's even within `config.set`: where Reelix and its plugins connect (changing
 * one can send a secret elsewhere), and the agent's own spending and time limits.
 */
const OWNER_SETTINGS = new Set(["plugins", "proxy", "web", "limits", "downloader", "media_server", "translator"]);
/** A service's address, and the secrets Reelix sends to it. */
const SERVICE_SECRETS: [url: string, secrets: string[]][] = [
	["magpie.url", ["magpie.api_key", "magpie.admin_key", "magpie.new_provider_key"]],
	["tmdb.base_url", ["tmdb.api_key"]],
];

/** Whether this change is the owner's alone (docs/plugins.md §11.2). An address no secret goes to yet is not. */
function settingNeedsOwner(c: ConfigAndSecrets, path: string, value: unknown): boolean {
	if (OWNER_SETTINGS.has(path.split(".")[0]!)) return true;
	const next = structuredClone(c.config) as Record<string, unknown>;
	setPath(next, path, value);
	return SERVICE_SECRETS.some(([url, secrets]) => secrets.some((s) => c.secrets[s]) && getPath(c.config, url) !== getPath(next, url));
}

/** What a `config.set` would do, after refusing what it can never do. */
export function configChange(c: ConfigAndSecrets & { plugins?: { list(): { secrets: string[] }[] } }, i: { path: string; value?: unknown }): { value: unknown; needsOwner: boolean } {
	if (i.path.startsWith("secrets") || Object.hasOwn(KNOWN_SECRETS, i.path) || c.plugins?.list().some((p) => p.secrets.includes(i.path))) throw new ReelixError("use_secret", `"${i.path}" is a secret; use secret.set (the secret field), not config.`);
	if (!isKnownConfigPath(i.path)) throw new ReelixError("unknown_setting", `There is no setting "${i.path}". See \`reelix config show\`.`);
	const value = i.value === "" || i.value === null ? undefined : typeof i.value === "string" ? parseLooseValue(i.value) : i.value;
	return { value, needsOwner: settingNeedsOwner(c, i.path, value) };
}

/** Parse a CLI value: JSON if it parses, otherwise a plain string. */
export function parseLooseValue(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}

// ---------------------------------------------------------------- secrets

export type Secrets = Record<string, string>;

export const KNOWN_SECRETS: Record<string, string> = {
	"tmdb.api_key": "TMDB API key (v3) or read access token",
	"magpie.api_key": "magpie gateway key (optional: a model router; set a spending limit on this key in magpie)",
	"magpie.admin_key": "a second magpie gateway key the owner allowed to manage magpie (lets Reelix change routing groups and providers, carefully)",
	"magpie.new_provider_key": "a provider's API key waiting to be added to magpie (used once, then deleted)",
	"web.password_hash": "Web UI password hash",
	"web.session_secret": "Web UI session signing secret",
};

/** Secrets of services that became plugins (docs/plugins.md §12.2). */
const MOVED_SECRETS: Record<string, string> = {
	"jackett.api_key": "plugins.jackett.api_key",
	"qbittorrent.password": "plugins.qbittorrent.password",
	"jellyfin.api_key": "plugins.jellyfin.api_key",
	"assrt.token": "plugins.subtitle-sites.assrt_token",
	"opensubtitles.api_key": "plugins.subtitle-sites.opensubtitles_api_key",
	"opensubtitles.username": "plugins.subtitle-sites.opensubtitles_username",
	"opensubtitles.password": "plugins.subtitle-sites.opensubtitles_password",
	"subdl.api_key": "plugins.subtitle-sites.subdl_api_key",
	"jimaku.api_key": "plugins.subtitle-sites.jimaku_api_key",
	"telegram.bot_token": "plugins.telegram.bot_token",
	"push.vapid_private": "plugins.push.vapid_private",
};

export function loadSecrets(p: DataPaths): Secrets {
	if (!existsSync(p.secrets)) return {};
	const raw = YAML.parse(readFileSync(p.secrets, "utf8")) ?? {};
	const out: Secrets = {};
	const walk = (o: unknown, prefix: string) => {
		if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, prefix ? `${prefix}.${k}` : k);
		else if (o != null && prefix) out[prefix] = String(o);
	};
	walk(raw, "");
	let moved = false;
	for (const [from, to] of Object.entries(MOVED_SECRETS)) {
		if (out[from] === undefined) continue;
		out[to] ??= out[from]!;
		delete out[from];
		moved = true;
	}
	if (moved) saveSecrets(p, out);
	return out;
}

export function saveSecrets(p: DataPaths, secrets: Secrets): void {
	const nested: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(secrets).sort()) setPath(nested, k, v);
	const tmp = p.secrets + ".tmp";
	writeFileSync(tmp, "# Reelix secrets. Readable only by Reelix's user. Do not paste into chat.\n" + YAML.stringify(nested), { mode: 0o600 });
	renameSync(tmp, p.secrets);
	chmodSync(p.secrets, 0o600);
}

// ---------------------------------------------------------------- path maps

export type PathMapEntry = { theirs: string; ours: string };

function underPrefix(path: string, prefix: string): string | undefined {
	const pre = prefix.replace(/\/+$/, "");
	if (path === pre) return "";
	if (path.startsWith(pre + "/")) return path.slice(pre.length);
	return undefined;
}

/** Translate a path as another service reports it into one Reelix can open. Longest prefix wins. */
export function toOurs(maps: PathMapEntry[], theirs: string): string {
	let best: { rest: string; m: PathMapEntry } | undefined;
	for (const m of maps) {
		const rest = underPrefix(theirs, m.theirs);
		if (rest !== undefined && (!best || m.theirs.length > best.m.theirs.length)) best = { rest, m };
	}
	return best ? best.m.ours.replace(/\/+$/, "") + best.rest : theirs;
}

export function toTheirs(maps: PathMapEntry[], ours: string): string {
	let best: { rest: string; m: PathMapEntry } | undefined;
	for (const m of maps) {
		const rest = underPrefix(ours, m.ours);
		if (rest !== undefined && (!best || m.ours.length > best.m.ours.length)) best = { rest, m };
	}
	return best ? best.m.theirs.replace(/\/+$/, "") + best.rest : ours;
}

/**
 * Summary of settings for the system prompt and `reelix config show`. Never includes secrets. Each running
 * plugin describes itself in one line (its manifest's `describe`), marked as outside text (docs/plugins.md §10.7).
 */
export function describeConfig(app: Reelix): string {
	const c = app.config;
	const has = (k: string) => (app.secrets[k] ? "set" : "missing");
	return [
		`downloads: ${c.downloads ?? "(not set)"}`,
		`library: movies=${c.library.movies ?? "-"} shows=${c.library.shows ?? "-"} anime=${c.library.anime ?? "-"}`,
		`downloader: ${c.downloader}; path map ${JSON.stringify(c.path_maps.downloaders[c.downloader] ?? [])}`,
		`media server: ${c.media_server}; path map ${JSON.stringify(c.path_maps.media_servers[c.media_server] ?? [])}`,
		`players: ${c.players.join(" > ")}`,
		`language: ${c.language ?? "not set (English for messages; the web UI follows the browser)"}; TMDB metadata in ${TMDB_LOCALES[c.language ?? "en"]}`,
		`tmdb: key ${has("tmdb.api_key")}`,
		`proxy: ${c.proxy.default ?? "none"} for [${c.proxy.use_for.join(", ")}]`,
		`subtitles: sources ${c.subtitles.sources.join(" > ")}; languages ${(c.subtitles.languages?.length ? c.subtitles.languages : ["(from the owner's language)"]).join(" > ")}`,
		`models: ${MODEL_ROLES.map((r) => `${r}=${c.models.roles[r].length ? c.models.roles[r].join(" > ") : ROLE_PARENT[r] ? `(as ${ROLE_PARENT[r]})` : "(pi default)"}`).join("; ")}${c.magpie.url ? `; magpie at ${c.magpie.url} (key ${has("magpie.api_key")}, admin key ${has("magpie.admin_key")})` : ""}`,
		`translator: ${c.translator}`,
		`limits: background $${c.limits.background_daily_usd}/day and ${c.limits.background_daily_tokens} tokens/day; plugins $${c.limits.plugin_daily_usd}/day each unless set on their page; "For you" $${c.limits.suggestions_daily_usd}/day; shell ${c.limits.shell_timeout_s}s default`,
		...(app.plugins?.describe() ?? []).map((d) => `plugin ${d.plugin}: ${outsideLine(d.line, 300)}`),
	].join("\n");
}
