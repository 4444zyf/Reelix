import { EventEmitter } from "node:events";
import type { PluginEvents } from "@reelix/plugin";
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { TmdbClient } from "./clients/tmdb.ts";
import {
	type Config,
	type DataPaths,
	type MovedOwner,
	type Secrets,
	changedPaths,
	dataPaths,
	ensureDataDirs,
	getPath,
	loadConfig,
	loadSecrets,
	parseConfig,
	saveConfig,
	saveSecrets,
	setPath,
	TMDB_LOCALES,
} from "./config.ts";
import { adoptChannelOwner } from "./channels.ts";
import { type Db, openDb } from "./db.ts";
import { proxyFor } from "./http.ts";
import { HookHub } from "./hooks.ts";
import { NotificationDispatcher } from "./notify.ts";
import { CORE_OPERATIONS } from "./ops/index.ts";
import type { Check } from "./doctor.ts";
import type { PluginCardKind, PluginControl } from "./plugins.ts";
import { OperationRegistry } from "./registry.ts";
import { SeamHub } from "./seams.ts";

export type AppEvent =
	| { type: "action"; action: Record<string, unknown> }
	| { type: "download"; hash: string; state: string; progress?: number }
	| { type: "inbox"; id: string; status: string }
	| { type: "config" }
	| { type: "notice"; level: "info" | "warn" | "error"; text: string }
	| { type: string; [k: string]: unknown };

/** The events plugins can listen to (docs/plugins.md §9). The internal stream above is not one of them. */
export type PluginEventMap = { [E in keyof PluginEvents]: [PluginEvents[E]] };
export const PLUGIN_EVENTS: readonly string[] = ["config.changed", "download.filed", "session.ended"] satisfies (keyof PluginEventMap)[];

/**
 * The core's shared state: settings, secrets, database, clients, event bus.
 * No pi, no HTTP server (§3.1).
 */
export class Reelix {
	paths: DataPaths;
	db: Db;
	config: Config;
	secrets: Secrets;
	configWarning?: string;
	/** What this process is running on which model right now (set by the agent host; docs/magpie.md). */
	modelsInUse?: () => { actor: string; spec: string; label: string }[];
	/** The running server's plugins; absent when the CLI works without a server. */
	plugins?: PluginControl;
	/** Every operation of this running Reelix (docs/plugins.md §15). */
	operations = new OperationRegistry(CORE_OPERATIONS);
	/** Providers of the seams, registered by plugins. */
	seams = new SeamHub(this);
	/** Hooks plugins take part in. */
	hooks = new HookHub(this);
	/** Sends what needs the owner to every notifier; started with the plugins. */
	notifications = new NotificationDispatcher(this);
	private otherSecrets = new Map<string, string>();
	/** Chat card kinds registered by plugins, as `<plugin>.<kind>` (docs/plugins.md §12.3). */
	cards = new Map<string, PluginCardKind>();
	/** Doctor checks registered by plugins. */
	checks = new Map<string, (o: { quick: boolean }) => Promise<Omit<Check, "name"> | undefined>>();
	events = new EventEmitter();
	pluginEvents = new EventEmitter<PluginEventMap>();
	private clients = new Map<string, unknown>();
	private watcher?: FSWatcher;
	private configMtime = 0;

	constructor(root?: string) {
		this.paths = dataPaths(root);
		ensureDataDirs(this.paths);
		this.db = openDb(this.paths.db);
		const { config, warning } = loadConfig(this.paths, this.keepOwner);
		this.config = config;
		this.configWarning = warning;
		this.secrets = loadSecrets(this.paths);
		this.events.setMaxListeners(100);
		this.pluginEvents.setMaxListeners(100);
	}

	private keepOwner = (o: MovedOwner) => adoptChannelOwner(this.db, o);

	emit(e: AppEvent): void {
		this.events.emit("event", e);
	}

	/** Notice hand edits of config.yaml (§10): validate, keep the last good version if invalid. */
	watchConfig(): void {
		if (this.watcher || !existsSync(this.paths.config)) return;
		this.configMtime = statSync(this.paths.config).mtimeMs;
		this.watcher = watch(this.paths.config, () => {
			try {
				const m = statSync(this.paths.config).mtimeMs;
				if (m === this.configMtime) return;
				this.configMtime = m;
				this.reload();
				if (this.configWarning) this.emit({ type: "notice", level: "warn", text: this.configWarning });
			} catch {
				/* file mid-write */
			}
		});
	}

	reload(): void {
		const before = this.config;
		const secretsBefore = this.secrets;
		const { config, warning } = loadConfig(this.paths, this.keepOwner);
		this.config = config;
		this.configWarning = warning;
		this.secrets = loadSecrets(this.paths);
		this.configApplied(before);
		const changed = changedPaths(secretsBefore, this.secrets);
		if (changed.length) this.emit({ type: "secrets", keys: changed });
	}

	private configApplied(before: Config): void {
		this.clients.clear();
		this.emit({ type: "config" });
		const paths = changedPaths(before, this.config);
		if (paths.length) this.pluginEvents.emit("config.changed", { paths });
	}

	getConfig(path: string): unknown {
		return getPath(this.config, path);
	}

	setConfig(path: string, value: unknown): Config {
		const next = structuredClone(this.config) as Record<string, unknown>;
		setPath(next, path, value);
		const parsed = parseConfig(next);
		saveConfig(this.paths, parsed);
		try {
			this.configMtime = statSync(this.paths.config).mtimeMs;
		} catch {}
		const before = this.config;
		this.config = parsed;
		this.configWarning = undefined;
		this.configApplied(before);
		return parsed;
	}

	/** `byPlugin`: the plugin stored it itself, and need not restart for it. */
	setSecret(key: string, value: string | undefined, byPlugin?: string): void {
		const next = { ...this.secrets };
		if (value === undefined || value === "") delete next[key];
		else next[key] = value;
		saveSecrets(this.paths, next);
		this.secrets = next;
		this.clients.clear();
		this.emit({ type: "secrets", keys: [key], byPlugin });
	}

	/** A secret that lives outside secrets.yaml (the owner's socket token): `redact` blanks it too. */
	addRedaction(name: string, value: string): void {
		this.otherSecrets.set(name, value);
	}

	/** Blank known secret values out of text before it reaches the model (§9). A cheap filter, not a guarantee. */
	redact(text: string): string {
		let out = text;
		for (const [k, v] of [...Object.entries(this.secrets), ...this.otherSecrets]) {
			if (!v || v.length < 6 || k === "web.password_hash") continue;
			if (out.includes(v)) out = out.split(v).join(`[secret:${k}]`);
		}
		// API keys embedded in URLs (Jackett links, passkeys)
		out = out.replace(/([?&](?:apikey|api_key|passkey|token|jackett_apikey)=)[^&\s"']+/gi, "$1[redacted]");
		return out;
	}

	private client<T>(name: string, make: () => T): T {
		let c = this.clients.get(name) as T | undefined;
		if (!c) {
			c = make();
			this.clients.set(name, c);
		}
		return c;
	}

	tmdb(): TmdbClient {
		return this.client("tmdb", () => new TmdbClient({ key: this.secrets["tmdb.api_key"] ?? "", baseUrl: this.config.tmdb.base_url, language: TMDB_LOCALES[this.config.language ?? "en"], proxy: proxyFor(this.config, "tmdb") }));
	}

	close(): void {
		this.watcher?.close();
		this.db.close();
	}
}
