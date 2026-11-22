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
		actor TEXT NOT NULL,                -- owner:web | owner:cli | owner:telegram | agent:<thread> | agent:cli | agent:socket | job:<id> | plugin:<id>
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
		telegram_message_id INTEGER,        -- dropped by migration 7
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
		kind TEXT NOT NULL DEFAULT 'chat',  -- chat | channel | job | setup (migration 7 renames telegram)
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
	// 2: subtitle translation (requests with per-video checkpoints, and glossaries)
	`
	CREATE TABLE translations (
		id TEXT PRIMARY KEY,
		title_id TEXT, season INTEGER,
		target TEXT NOT NULL,               -- free text: "French", "Klingon", "pirate English"
		code TEXT NOT NULL,                 -- language code for the file name: fr, tlh, x-pirate
		options_json TEXT NOT NULL DEFAULT '{}',
		state TEXT NOT NULL,                -- queued | running | paused | succeeded | failed | cancelled
		note TEXT,                          -- why it is paused / what failed
		thread_id TEXT,                     -- chat thread to report back to
		report_json TEXT,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL
	);
	CREATE TABLE translation_items (
		id INTEGER PRIMARY KEY,
		translation_id TEXT NOT NULL REFERENCES translations(id) ON DELETE CASCADE,
		video_path TEXT NOT NULL, episode INTEGER,
		source_json TEXT NOT NULL,          -- { kind: file|embedded, path, index, language }
		state TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
		lines_total INTEGER NOT NULL DEFAULT 0, lines_done INTEGER NOT NULL DEFAULT 0,
		work_json TEXT,                     -- checkpoint: translated lines so far, flags
		placed TEXT, error TEXT
	);
	CREATE INDEX translation_items_tr ON translation_items(translation_id);
	CREATE TABLE glossaries (
		title_id TEXT NOT NULL, target TEXT NOT NULL,
		entries_json TEXT NOT NULL DEFAULT '[]', -- [{ source, target, note? }]
		tone TEXT,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (title_id, target)
	);
	`,
	// 3: the language metadata was last read in now belongs to the metadata-refresh plugin (docs/plugins.md §12.2)
	`
	INSERT OR REPLACE INTO kv (k, v) SELECT 'plugin:metadata-refresh:locale', json_quote(v) FROM kv WHERE k = 'metadata.locale';
	DELETE FROM kv WHERE k = 'metadata.locale';
	UPDATE job_runs SET state = 'interrupted', lease_until = NULL, summary = 'replaced by the metadata-refresh plugin' WHERE kind = 'metadata_refresh' AND state IN ('queued', 'running');
	`,
	// 4: the ledger used to keep the value given to secret.set; it no longer does, and old rows lose it
	`UPDATE actions SET input_json = json_set(input_json, '$.value', '[secret]') WHERE op = 'secret.set' AND json_valid(input_json);`,
	// 5: the owner's approvals, each good for one run of one operation with one input (docs/plugins.md §11.2)
	`
	CREATE TABLE approvals (
		id TEXT PRIMARY KEY,
		operation TEXT NOT NULL,
		input_hash TEXT NOT NULL,
		requested_by TEXT NOT NULL,
		approved_by TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		used_at TEXT
	);
	CREATE INDEX approvals_lookup ON approvals(operation, input_hash, requested_by);
	`,
	// 6: subtitle sites and Jackett became plugins: site_state turns into recorded provider outcomes,
	// the rest into the plugins' stores, and release handles record their provider (docs/plugins.md §12.2)
	`
	CREATE TABLE provider_outcomes (
		id INTEGER PRIMARY KEY,
		seam TEXT NOT NULL,
		provider TEXT NOT NULL,
		method TEXT NOT NULL,
		outcome TEXT NOT NULL,              -- rate_limited | needs_auth | needs_verification | unavailable | ok
		detail_json TEXT NOT NULL DEFAULT '{}',
		at TEXT NOT NULL
	);
	CREATE INDEX provider_outcomes_lookup ON provider_outcomes(seam, provider, at);
	INSERT INTO provider_outcomes (seam, provider, method, outcome, detail_json, at)
		SELECT 'reelix:subtitle.source@1', site, 'download', 'rate_limited', json_object('until', json_extract(state_json, '$.dailyLimitUntil')), updated_at
		FROM site_state WHERE json_extract(state_json, '$.dailyLimitUntil') IS NOT NULL;
	INSERT INTO provider_outcomes (seam, provider, method, outcome, detail_json, at)
		SELECT 'reelix:subtitle.source@1', site, 'download', 'needs_verification', json_object('url', ''), json_extract(state_json, '$.verificationSince')
		FROM site_state WHERE json_extract(state_json, '$.verificationSince') IS NOT NULL;
	WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
	INSERT INTO provider_outcomes (seam, provider, method, outcome, at)
		SELECT 'reelix:subtitle.source@1', site, 'download', 'ok', updated_at
		FROM site_state JOIN n ON i <= json_extract(state_json, '$.downloadsToday')
		WHERE json_extract(state_json, '$.day') = substr(updated_at, 1, 10);
	INSERT OR REPLACE INTO kv (k, v)
		SELECT 'plugin:subtitle-sites:pace.' || site, json_extract(state_json, '$.lastRequestAt') FROM site_state WHERE json_extract(state_json, '$.lastRequestAt') IS NOT NULL;
	INSERT OR REPLACE INTO kv (k, v)
		SELECT 'plugin:subtitle-sites:subhd.limit_until', json_quote(json_extract(state_json, '$.dailyLimitUntil')) FROM site_state WHERE site = 'subhd' AND json_extract(state_json, '$.dailyLimitUntil') IS NOT NULL;
	DROP TABLE site_state;
	INSERT OR REPLACE INTO kv (k, v) SELECT 'plugin:subtitle-sites:opensubtitles.token', json_quote(v) FROM kv WHERE k = 'opensubtitles.token';
	DELETE FROM kv WHERE k = 'opensubtitles.token';
	INSERT OR REPLACE INTO kv (k, v) SELECT 'plugin:auto-subtitles:' || k, json_quote(v) FROM kv WHERE k LIKE 'translate.offered:%';
	DELETE FROM kv WHERE k LIKE 'translate.offered:%';
	UPDATE job_runs SET kind = 'auto-subtitles.find' WHERE kind = 'subtitles' AND state IN ('queued', 'running');
	UPDATE handles SET payload_json = json_remove(
		json_set(payload_json, '$.provider', 'jackett', '$.ref', json_object('link', json_extract(payload_json, '$.link'), 'magnet', json_extract(payload_json, '$.magnet')) || '', '$.hasMagnet', json(CASE WHEN json_extract(payload_json, '$.magnet') IS NULL THEN 'false' ELSE 'true' END)),
		'$.link', '$.magnet', '$.details')
		WHERE json_extract(payload_json, '$.link') IS NOT NULL;
	`,
	// 7: push and Telegram became plugins: one dispatcher records every delivery, and core keeps each
	// chat channel's owner and conversation (docs/plugins.md §7.3, §7.4, §12.2)
	`
	CREATE TABLE notice_deliveries (
		inbox_id TEXT NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
		provider TEXT NOT NULL,
		state TEXT NOT NULL,                -- sent | failed | rate_limited | needs_auth | needs_verification | unavailable
		ref TEXT,                           -- the provider's own name for what it sent
		error TEXT,
		attempts INTEGER NOT NULL DEFAULT 1,
		updated_at TEXT NOT NULL,
		closed_at TEXT,                     -- when the provider was told the item closed
		PRIMARY KEY (inbox_id, provider)
	);
	CREATE INDEX notice_deliveries_ref ON notice_deliveries(provider, ref);
	INSERT INTO notice_deliveries (inbox_id, provider, state, ref, updated_at, closed_at)
		SELECT id, 'telegram', 'sent', CAST(telegram_message_id AS TEXT), created_at, answered_at FROM inbox WHERE telegram_message_id IS NOT NULL;
	ALTER TABLE inbox DROP COLUMN telegram_message_id;
	CREATE TABLE chat_channels (
		id TEXT PRIMARY KEY,
		owner TEXT,                         -- the sender paired with it
		may_approve INTEGER NOT NULL DEFAULT 0,
		thread_id TEXT,                     -- its standing conversation
		paired_at TEXT,
		last_error TEXT, last_error_at TEXT
	);
	CREATE INDEX chat_channels_thread ON chat_channels(thread_id);
	INSERT INTO chat_channels (id, thread_id) SELECT 'telegram', v FROM kv WHERE k = 'telegram.thread';
	DELETE FROM kv WHERE k = 'telegram.thread';
	UPDATE threads SET kind = 'channel' WHERE kind = 'telegram';
	INSERT OR REPLACE INTO kv (k, v) SELECT 'plugin:telegram:offset', v FROM kv WHERE k = 'telegram.offset';
	DELETE FROM kv WHERE k = 'telegram.offset';
	INSERT OR REPLACE INTO kv (k, v) SELECT 'plugin:push:devices', v FROM kv WHERE k = 'push.devices';
	DELETE FROM kv WHERE k = 'push.devices';
	`,
	// 8: why Reelix did what it did: hook changes, hidden releases, provider outcomes (docs/plugins.md §10.1)
	`
	CREATE TABLE reasons (
		id INTEGER PRIMARY KEY,
		subject TEXT NOT NULL,              -- release:<handle> | search:<id> | plan:<hash or title> | notice:<inbox id>
		kind TEXT NOT NULL,                 -- hidden | moved | note | provider | renamed | edited
		plugin TEXT NOT NULL,
		reason TEXT NOT NULL,
		detail_json TEXT NOT NULL DEFAULT '{}',
		at TEXT NOT NULL
	);
	CREATE INDEX reasons_subject ON reasons(subject, id);
	CREATE INDEX reasons_at ON reasons(at);
	`,
	// 9: proposals from plugins (docs/plugins.md §10.3) and what hooks in trial would have changed (§8)
	`
	CREATE TABLE proposals (
		id TEXT PRIMARY KEY,
		plugin TEXT NOT NULL,
		key TEXT NOT NULL,
		title TEXT NOT NULL,
		why TEXT NOT NULL,
		steps_json TEXT NOT NULL,           -- [{ operation, input, effect, preview }]
		status TEXT NOT NULL,               -- open | approved | declined | expired | replaced
		inbox_id TEXT,
		results_json TEXT,                  -- [{ operation, status, text }] once decided
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		decided_at TEXT,
		decided_by TEXT
	);
	CREATE INDEX proposals_open ON proposals(status, plugin, key);
	CREATE TABLE trial_results (
		id INTEGER PRIMARY KEY,
		plugin TEXT NOT NULL,
		hook TEXT NOT NULL,
		hidden INTEGER NOT NULL DEFAULT 0,          -- releases a guard would have hidden
		first_changed INTEGER NOT NULL DEFAULT 0,   -- 1 when a ranking would have changed the first candidate
		changed INTEGER NOT NULL DEFAULT 0,         -- items a pipeline would have changed
		at TEXT NOT NULL
	);
	CREATE INDEX trial_results_plugin ON trial_results(plugin, at);
	`,
	// 10: qBittorrent became a plugin behind reelix:downloader@1 (docs/plugins.md §7.5, §12.2): each download
	// records the provider that holds it
	`
	ALTER TABLE downloads ADD COLUMN downloader TEXT;
	UPDATE downloads SET downloader = 'qbittorrent';
	UPDATE inbox SET payload_json = json_set(payload_json, '$.dedupeKey', 'downloader-unreachable:qbittorrent') WHERE json_extract(payload_json, '$.dedupeKey') = 'qb-unreachable';
	`,
	// 11: Douban and Bangumi became metadata sources (docs/plugins.md §7.6): a title keeps a rating per source
	`
	ALTER TABLE titles ADD COLUMN ratings_json TEXT NOT NULL DEFAULT '{}';
	UPDATE titles SET ratings_json = json_object('douban', json_object('value', douban_rating, 'scale', 10, 'label', 'Douban', 'at', updated_at)) WHERE douban_rating IS NOT NULL;
	ALTER TABLE titles DROP COLUMN douban_rating;
	`,
	// 12: several library folders per media type (docs/library-folders.md): the TMDB facts the rules match,
	// and the folder the owner (or the agent) chose for a title before it is filed
	`
	ALTER TABLE titles ADD COLUMN original_language TEXT;
	ALTER TABLE titles ADD COLUMN origin_country_json TEXT NOT NULL DEFAULT '[]';
	ALTER TABLE titles ADD COLUMN genres_json TEXT NOT NULL DEFAULT '[]';
	ALTER TABLE titles ADD COLUMN library_choice TEXT;
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

export function kvDelete(db: Db, k: string): void {
	db.prepare("DELETE FROM kv WHERE k = ?").run(k);
}

export function json<T>(s: string | null | undefined, fallback: T): T {
	if (s == null) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}
