import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import YAML from "yaml";
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
		sessions: join(root, "sessions"),
		pi: join(root, "pi"),
		browserProfile: join(root, "browser-profile"),
		workspace: join(root, "workspace"),
		backups: join(root, "backups"),
		socket: join(root, "reelix.sock"),
		lock: join(root, "reelix.lock"),
		cache: join(root, "cache"),
	};
}

export type DataPaths = ReturnType<typeof dataPaths>;

export function ensureDataDirs(p: DataPaths): void {
	for (const d of [p.root, p.notes, p.skills, p.sessions, p.pi, p.workspace, p.backups, p.cache]) mkdirSync(d, { recursive: true });
}

const PathMap = Type.Object({ theirs: Type.String(), ours: Type.String() });
const Service = Type.Object({ url: Type.String(), username: Type.Optional(Type.String()) });

export const ConfigSchema = Type.Object({
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
			qbittorrent: Type.Array(PathMap, { default: [] }),
			jellyfin: Type.Array(PathMap, { default: [] }),
		},
		{ default: { qbittorrent: [], jellyfin: [] } },
	),
	qbittorrent: Type.Optional(Service),
	jackett: Type.Optional(Service),
	jellyfin: Type.Optional(Service),
	tmdb: Type.Object(
		{
			language: Type.String({ default: "zh-CN" }),
			base_url: Type.String({ default: "https://api.themoviedb.org/3" }),
			image_base_url: Type.String({ default: "https://image.tmdb.org/t/p" }),
		},
		{ default: {} },
	),
	bangumi: Type.Object({ base_url: Type.String({ default: "https://api.bgm.tv" }) }, { default: {} }),
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
			sources: Type.Array(Type.String(), { default: ["subhd", "assrt"] }),
			subhd_url: Type.String({ default: "https://subhd.me" }),
			assrt_url: Type.String({ default: "https://api.assrt.net" }),
		},
		{ default: {} },
	),
	telegram: Type.Object(
		{
			owner_id: Type.Optional(Type.Number()),
			api_url: Type.String({ default: "https://api.telegram.org" }),
		},
		{ default: {} },
	),
	models: Type.Object(
		{
			main: Type.Optional(Type.String({ description: "provider/model-id as pi knows it" })),
			background: Type.Optional(Type.String()),
			thinking: Type.String({ default: "low" }),
			main_reads_images: Type.Boolean({ default: true }),
		},
		{ default: {} },
	),
	limits: Type.Object(
		{
			background_daily_usd: Type.Number({ default: 1 }),
			background_daily_tokens: Type.Number({ default: 2_000_000 }),
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
	schedule: Type.Object(
		{
			nightly_at: Type.String({ default: "03:30" }),
			timezone: Type.Optional(Type.String()),
		},
		{ default: {} },
	),
});

export type Config = Static<typeof ConfigSchema>;

/** Fill defaults and validate. Throws a ReelixError listing every problem. */
export function parseConfig(raw: unknown): Config {
	const v = Value.Default(ConfigSchema, Value.Clone(raw ?? {}));
	const errors = [...Value.Errors(ConfigSchema, v)];
	if (errors.length) {
		throw new ReelixError(
			"config_invalid",
			"config.yaml is invalid: " + errors.map((e) => `${(e as { instancePath?: string }).instancePath || "/"} ${e.message}`).join("; "),
		);
	}
	return v as Config;
}

export function loadConfig(p: DataPaths): { config: Config; warning?: string } {
	if (!existsSync(p.config)) return { config: parseConfig({}) };
	const text = readFileSync(p.config, "utf8");
	try {
		const config = parseConfig(YAML.parse(text) ?? {});
		writeFileSync(p.configGood, text);
		return { config };
	} catch (e) {
		// Keep the last good version and say what was wrong.
		if (existsSync(p.configGood)) {
			const config = parseConfig(YAML.parse(readFileSync(p.configGood, "utf8")) ?? {});
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
	writeFileSync(tmp, text);
	renameSync(tmp, p.config);
	writeFileSync(p.configGood, text);
}

/** Whether a dotted path names a real setting (records accept any key below them). */
export function isKnownConfigPath(path: string): boolean {
	let s: any = ConfigSchema;
	for (const k of path.split(".")) {
		if (s?.type === "object" && s.properties && k in s.properties) s = s.properties[k];
		else if (s?.patternProperties || (s?.type === "object" && s.additionalProperties && typeof s.additionalProperties === "object")) return true;
		else if (s?.type === "array" && /^\d+$/.test(k)) s = s.items;
		else return false;
	}
	return true;
}

/** Get a value by dotted path, e.g. "limits.shell_timeout_s". */
export function getPath(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const k of path.split(".")) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[k];
	}
	return cur;
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
	const keys = path.split(".");
	let cur: Record<string, unknown> = obj;
	for (const k of keys.slice(0, -1)) {
		if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
		cur = cur[k] as Record<string, unknown>;
	}
	const last = keys[keys.length - 1]!;
	if (value === undefined) delete cur[last];
	else cur[last] = value;
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
	"qbittorrent.password": "qBittorrent WebUI password",
	"jackett.api_key": "Jackett API key",
	"jellyfin.api_key": "Jellyfin API key",
	"tmdb.api_key": "TMDB API key (v3) or read access token",
	"assrt.token": "ASSRT API token",
	"telegram.bot_token": "Telegram bot token",
	"web.password_hash": "Web UI password hash",
	"web.session_secret": "Web UI session signing secret",
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

/** Summary of settings for the system prompt and `reelix config show`. Never includes secrets. */
export function describeConfig(c: Config, secrets: Secrets): string {
	const has = (k: string) => (secrets[k] ? "set" : "missing");
	return [
		`downloads: ${c.downloads ?? "(not set)"}`,
		`library: movies=${c.library.movies ?? "-"} shows=${c.library.shows ?? "-"} anime=${c.library.anime ?? "-"}`,
		`qbittorrent: ${c.qbittorrent?.url ?? "(not set)"} (password ${has("qbittorrent.password")}); path map ${JSON.stringify(c.path_maps.qbittorrent)}`,
		`jackett: ${c.jackett?.url ?? "(not set)"} (api key ${has("jackett.api_key")})`,
		`jellyfin: ${c.jellyfin?.url ?? "(not set)"} (api key ${has("jellyfin.api_key")}); path map ${JSON.stringify(c.path_maps.jellyfin)}`,
		`tmdb: key ${has("tmdb.api_key")}, language ${c.tmdb.language}`,
		`proxy: ${c.proxy.default ?? "none"} for [${c.proxy.use_for.join(", ")}]`,
		`subtitles: ${c.subtitles.sources.join(" > ")}, subhd at ${c.subtitles.subhd_url}`,
		`telegram: ${c.telegram.owner_id ? "linked" : "not linked"} (bot token ${has("telegram.bot_token")})`,
		`models: main=${c.models.main ?? "(pi default)"} background=${c.models.background ?? "(same as main)"}`,
		`limits: background $${c.limits.background_daily_usd}/day and ${c.limits.background_daily_tokens} tokens/day; shell ${c.limits.shell_timeout_s}s default`,
	].join("\n");
}
