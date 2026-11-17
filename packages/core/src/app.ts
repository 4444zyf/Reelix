import { EventEmitter } from "node:events";
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { QbClient } from "./clients/qbittorrent.ts";
import { JackettClient } from "./clients/jackett.ts";
import { TmdbClient } from "./clients/tmdb.ts";
import { BangumiClient } from "./clients/bangumi.ts";
import { JellyfinClient } from "./clients/jellyfin.ts";
import { TelegramClient } from "./clients/telegram.ts";
import {
	type Config,
	type DataPaths,
	type Secrets,
	dataPaths,
	ensureDataDirs,
	getPath,
	loadConfig,
	loadSecrets,
	parseConfig,
	saveConfig,
	saveSecrets,
	setPath,
} from "./config.ts";
import { type Db, openDb } from "./db.ts";
import { proxyFor } from "./http.ts";
import { ReelixError } from "./util.ts";

export type AppEvent =
	| { type: "action"; action: Record<string, unknown> }
	| { type: "download"; hash: string; state: string; progress?: number }
	| { type: "inbox"; id: string; status: string }
	| { type: "config" }
	| { type: "notice"; level: "info" | "warn" | "error"; text: string }
	| { type: string; [k: string]: unknown };

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
	events = new EventEmitter();
	private clients = new Map<string, unknown>();
	private watcher?: FSWatcher;
	private configMtime = 0;

	constructor(root?: string) {
		this.paths = dataPaths(root);
		ensureDataDirs(this.paths);
		this.db = openDb(this.paths.db);
		const { config, warning } = loadConfig(this.paths);
		this.config = config;
		this.configWarning = warning;
		this.secrets = loadSecrets(this.paths);
		this.events.setMaxListeners(100);
	}

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
		const { config, warning } = loadConfig(this.paths);
		this.config = config;
		this.configWarning = warning;
		this.secrets = loadSecrets(this.paths);
		this.clients.clear();
		this.emit({ type: "config" });
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
		this.config = parsed;
		this.configWarning = undefined;
		this.clients.clear();
		this.emit({ type: "config" });
		return parsed;
	}

	setSecret(key: string, value: string | undefined): void {
		const next = { ...this.secrets };
		if (value === undefined || value === "") delete next[key];
		else next[key] = value;
		saveSecrets(this.paths, next);
		this.secrets = next;
		this.clients.clear();
	}

	/** Blank known secret values out of text before it reaches the model (§9). A cheap filter, not a guarantee. */
	redact(text: string): string {
		let out = text;
		for (const [k, v] of Object.entries(this.secrets)) {
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

	qb(): QbClient {
		return this.client("qb", () => {
			const c = this.config.qbittorrent;
			if (!c?.url) throw new ReelixError("not_configured", "qBittorrent is not configured. Set it with `reelix config set qbittorrent.url http://host:8080`.");
			return new QbClient({ url: c.url, username: c.username, password: this.secrets["qbittorrent.password"] });
		});
	}

	jackett(): JackettClient {
		return this.client("jackett", () => {
			const c = this.config.jackett;
			if (!c?.url) throw new ReelixError("not_configured", "Jackett is not configured. Set it with `reelix config set jackett.url http://host:9117`.");
			const key = this.secrets["jackett.api_key"];
			if (!key) throw new ReelixError("not_configured", "The Jackett API key is missing (secret jackett.api_key).");
			const j = new JackettClient({ url: c.url, apiKey: key });
			j.proxy = proxyFor(this.config, "jackett");
			return j;
		});
	}

	tmdb(): TmdbClient {
		return this.client("tmdb", () => new TmdbClient({ key: this.secrets["tmdb.api_key"] ?? "", baseUrl: this.config.tmdb.base_url, language: this.config.tmdb.language, proxy: proxyFor(this.config, "tmdb") }));
	}

	bangumi(): BangumiClient {
		return this.client("bangumi", () => new BangumiClient({ baseUrl: this.config.bangumi.base_url, proxy: proxyFor(this.config, "bangumi") }));
	}

	jellyfin(): JellyfinClient | undefined {
		const c = this.config.jellyfin;
		const key = this.secrets["jellyfin.api_key"];
		if (!c?.url || !key) return undefined;
		return this.client("jellyfin", () => new JellyfinClient({ url: c.url, apiKey: key }));
	}

	telegram(): TelegramClient | undefined {
		const token = this.secrets["telegram.bot_token"];
		if (!token) return undefined;
		return this.client("telegram", () => new TelegramClient({ token, apiUrl: this.config.telegram.api_url, proxy: proxyFor(this.config, "telegram") }));
	}

	close(): void {
		this.watcher?.close();
		this.db.close();
	}
}
