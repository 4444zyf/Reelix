import { DatabaseSync } from "node:sqlite";

// node:sqlite prints an ExperimentalWarning once; silence just that one.
const origEmit = process.emitWarning;
process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
	const msg = typeof warning === "string" ? warning : warning?.message;
	if (msg && msg.includes("SQLite is an experimental feature")) return;
	return (origEmit as (...a: unknown[]) => void).call(process, warning, ...rest);
} as typeof process.emitWarning;

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
	// 1: the main tables (§6.1)
	`
	CREATE TABLE titles (
		id TEXT PRIMARY KEY,                -- "movie:872585", "tv:95396", or "local:xxxx"
		kind TEXT NOT NULL,                 -- movie | tv
		tmdb_id INTEGER,
		media_class TEXT NOT NULL DEFAULT 'auto', -- movie | show | anime
		name TEXT NOT NULL,                 -- display name (zh-CN with fallbacks)
		original_name TEXT,
		folder_name TEXT,                   -- English or original title used for folders
		year INTEGER,
		names_json TEXT NOT NULL DEFAULT '[]',
		imdb_id TEXT, douban_id TEXT, bangumi_ids_json TEXT NOT NULL DEFAULT '[]',
		runtime_min INTEGER,
		seasons_json TEXT,
		poster_path TEXT,
		rating REAL, douban_rating REAL,
		overview TEXT,
		notes TEXT NOT NULL DEFAULT '',
		library_folder TEXT,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE anime_map (
		id INTEGER PRIMARY KEY,
		title_id TEXT NOT NULL,
		bangumi_id INTEGER NOT NULL,
		bgm_from INTEGER NOT NULL, bgm_to INTEGER NOT NULL,
		tmdb_season INTEGER NOT NULL, tmdb_start INTEGER NOT NULL,
		exceptions_json TEXT NOT NULL DEFAULT '{}',
		source TEXT NOT NULL DEFAULT 'auto'
	);
	CREATE TABLE lookups (
		key TEXT PRIMARY KEY,               -- source:query
		result_json TEXT,
		found INTEGER NOT NULL,
		expires_at TEXT NOT NULL
	);
	CREATE TABLE downloads (
		hash TEXT PRIMARY KEY,
		title_id TEXT,
		name TEXT NOT NULL,
		episodes_json TEXT NOT NULL DEFAULT '[]',  -- [{season,episode}] wanted; [] = whole thing
		release_json TEXT NOT NULL DEFAULT '{}',
		reason TEXT,
		state TEXT NOT NULL,                -- added | downloading | complete | filed | needs_agent | gone | removed | stalled
		content_path TEXT,                  -- read at completion, ours
		save_path TEXT,
		progress REAL NOT NULL DEFAULT 0,
		size INTEGER,
		last_progress_at TEXT,
		added_at TEXT NOT NULL,
		completed_at TEXT, filed_at TEXT,
		note TEXT
	);
	CREATE TABLE files (
		id INTEGER PRIMARY KEY,
		title_id TEXT,
		download_hash TEXT,
		source TEXT,
		dest TEXT NOT NULL UNIQUE,
		kind TEXT NOT NULL,                 -- video | subtitle | extra | audio | disc
		version_label TEXT,
		linked INTEGER NOT NULL DEFAULT 1,  -- 1 = hard link; 0 = ordinary file (subtitle, unpacked copy)
		created_at TEXT NOT NULL
	);
	CREATE TABLE file_episodes (file_id INTEGER NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL, PRIMARY KEY (file_id, season, episode));
	CREATE TABLE follows (
		id TEXT PRIMARY KEY,
		title_id TEXT NOT NULL,
		instruction TEXT NOT NULL,
		quick_accept TEXT,
		season INTEGER,
		active INTEGER NOT NULL DEFAULT 1,
		created_at TEXT NOT NULL
	);
	CREATE TABLE follow_episodes (
		follow_id TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL,
		air_date TEXT, state TEXT NOT NULL DEFAULT 'wanted', -- wanted | grabbed | filed
		next_check_at TEXT, misses INTEGER NOT NULL DEFAULT 0, download_hash TEXT,
		PRIMARY KEY (follow_id, season, episode)
	);
	CREATE TABLE subtitles (
		id INTEGER PRIMARY KEY,
		title_id TEXT, video_path TEXT NOT NULL, path TEXT NOT NULL,
		source TEXT, source_ref TEXT, language TEXT, format TEXT,
		checks_json TEXT NOT NULL DEFAULT '{}',
		created_at TEXT NOT NULL
	);
	CREATE TABLE actions (
		id INTEGER PRIMARY KEY,
		request_id TEXT NOT NULL UNIQUE,
		op TEXT NOT NULL,
		effect TEXT NOT NULL,
		actor TEXT NOT NULL,                -- owner:web | owner:cli | owner:telegram | agent:<thread> | job:<id>
		input_json TEXT NOT NULL,
		status TEXT NOT NULL,               -- pending | succeeded | failed | unknown
		output_json TEXT, error TEXT,
		title_id TEXT,
		started_at TEXT NOT NULL, finished_at TEXT
	);
	CREATE INDEX actions_started ON actions(started_at);
	CREATE TABLE inbox (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL,                 -- notice | question | plan | verification | summary
		title TEXT NOT NULL,
		body TEXT NOT NULL DEFAULT '',
		options_json TEXT NOT NULL DEFAULT '[]',
		image_path TEXT,
		payload_json TEXT NOT NULL DEFAULT '{}',
		source TEXT,                        -- job:<id> | agent:<thread> | system
		job_run_id TEXT,
		status TEXT NOT NULL DEFAULT 'open',-- open | answered | dismissed
		answer TEXT,
		telegram_message_id INTEGER,
		created_at TEXT NOT NULL, answered_at TEXT
	);
	CREATE TABLE jobs (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL,                 -- nightly | follow_check | stalled | organise | agent_task
		schedule TEXT,                      -- "daily HH:MM" | null for one-off
		payload_json TEXT NOT NULL DEFAULT '{}',
		next_run_at TEXT,
		enabled INTEGER NOT NULL DEFAULT 1,
		created_at TEXT NOT NULL
	);
	CREATE TABLE job_runs (
		id TEXT PRIMARY KEY,
		job_id TEXT,
		kind TEXT NOT NULL,
		payload_json TEXT NOT NULL DEFAULT '{}',
		state TEXT NOT NULL,                -- queued | running | parked | succeeded | failed | interrupted
		lease_until TEXT,
		session_file TEXT,
		attempts INTEGER NOT NULL DEFAULT 0,
		summary TEXT,
		created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
	);
	CREATE TABLE threads (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'chat',  -- chat | telegram | job | setup
		session_file TEXT,
		title_id TEXT,
		job_run_id TEXT,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		archived INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE runs (
		id TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL,
		state TEXT NOT NULL,                -- running | done | interrupted | failed
		prompt TEXT,
		started_at TEXT NOT NULL, finished_at TEXT
	);
	CREATE TABLE site_state (
		site TEXT PRIMARY KEY,
		state_json TEXT NOT NULL DEFAULT '{}',
		updated_at TEXT NOT NULL
	);
	CREATE TABLE spend (
		day TEXT NOT NULL, scope TEXT NOT NULL,  -- scope: background | chat
		usd REAL NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (day, scope)
	);
	CREATE TABLE removed (
		id INTEGER PRIMARY KEY,
		title_id TEXT, source TEXT, dest TEXT NOT NULL, kind TEXT,
		trash_path TEXT,                    -- set when the last copy went to trash
		removed_at TEXT NOT NULL, expires_at TEXT, restored_at TEXT
	);
	CREATE TABLE handles (
		id TEXT PRIMARY KEY,                -- short id the model sees, e.g. r7Kp2
		payload_json TEXT NOT NULL,         -- the real link and release details (never shown to the model)
		created_at TEXT NOT NULL
	);
	CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
	`,
];

export function openDb(path: string): Db {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
	db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
	const row = db.prepare("SELECT v FROM schema_version").get() as { v: number } | undefined;
	let v = row?.v ?? 0;
	if (!row) db.prepare("INSERT INTO schema_version (v) VALUES (0)").run();
	while (v < MIGRATIONS.length) {
		db.exec("BEGIN");
		try {
			db.exec(MIGRATIONS[v]!);
			v++;
			db.prepare("UPDATE schema_version SET v = ?").run(v);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
	}
	return db;
}

export function kvGet(db: Db, k: string): string | undefined {
	return (db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined)?.v;
}

export function kvSet(db: Db, k: string, v: string): void {
	db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

export function json<T>(s: string | null | undefined, fallback: T): T {
	if (s == null) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}
