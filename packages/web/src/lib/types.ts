/** Shapes of the Reelix HTTP API (docs/api.md). Kept loose where the server is loose. */

export type Session = { authenticated: boolean; needsPassword: boolean };

export type Season = { season_number: number; episode_count: number; air_date?: string | null };

export type Title = {
	id: string;
	kind: string;
	tmdb_id?: number | null;
	media_class?: "movie" | "show" | "anime" | string | null;
	name: string;
	original_name?: string | null;
	folder_name?: string | null;
	year?: number | null;
	names?: string[];
	imdb_id?: string | null;
	douban_id?: string | null;
	bangumi_ids?: number[];
	runtime_min?: number | null;
	seasons?: Season[];
	poster_path?: string | null;
	rating?: number | null;
	douban_rating?: number | null;
	overview?: string | null;
	notes?: string | null;
	library_folder?: string | null;
};

export type Candidate = {
	id: string;
	kind: string;
	tmdb_id?: number;
	name: string;
	original_name?: string | null;
	year?: number | null;
	overview?: string | null;
	poster_path?: string | null;
};

export type TitleFind = { resolved?: Title; how?: string; candidates: Candidate[]; note?: string };

export type Episode = { season: number; episode: number };

export type TitleFile = { id: number; dest: string; kind: string; exists: boolean; episodes: Episode[]; download_hash?: string | null };

export type TitleDownload = { hash: string; name: string; state: string; progress: number; reason?: string | null; added_at: string };

export type Follow = { id: string; instruction?: string; [k: string]: unknown };

export type TitleShow = {
	title: Title;
	have: { folder?: string; episodes: Episode[]; files: string[] };
	files: TitleFile[];
	downloads: TitleDownload[];
	follows: Follow[];
};

export type LibraryList = { titles: (Title & { file_count: number })[]; untracked_folders: string[] };

export type ParsedRelease = {
	title?: string;
	resolution?: string;
	source?: string;
	codec?: string;
	hdr?: string[];
	audio?: string[];
	chineseSubs?: string;
	group?: string;
	season?: number;
	seasons?: number[];
	episodes?: number[];
	complete?: boolean;
	confident?: boolean;
	why?: string;
};

export type Release = {
	handle: string;
	title: string;
	size?: number;
	seeders?: number;
	peers?: number;
	indexer?: string;
	publishDate?: string;
	freeleech?: boolean;
	parsed?: ParsedRelease;
	hasMagnet?: boolean;
	titleId?: string;
};

export type IndexerOutcome = { indexer: string; name: string; ok: boolean; count: number; ms: number; error?: string };

export type ReleaseSearch = { title?: string; queries: string[]; total: number; offset: number; releases: Release[]; all: Release[]; indexers: IndexerOutcome[] };

export type LiveTorrent = { state: string; progress: number; dlspeed: number; upspeed: number; eta: number; num_seeds: number; ratio: number; amount_left?: number };

export type Download = {
	hash: string;
	title_id?: string | null;
	title_name?: string | null;
	name: string;
	state: string;
	progress: number;
	size?: number | null;
	reason?: string | null;
	note?: string | null;
	added_at: string;
	filed_at?: string | null;
	live?: LiveTorrent;
};

export type PlanItem = { source: string; dest: string; kind?: string; reason?: string; episodes?: Episode[] };

export type LedgerRow = { id: number; op: string; actor: string; status: string; error?: string | null; title_id?: string | null; started_at: string; finished_at?: string | null; input_json: string };

export type InboxItem = {
	id: string;
	kind: "notice" | "question" | "plan" | "verification" | "summary" | string;
	title: string;
	body: string;
	options: string[];
	image_path?: string | null;
	payload?: unknown;
	source?: string | null;
	job_run_id?: string | null;
	status: "open" | "answered" | "dismissed" | string;
	answer?: string | null;
	created_at: string;
};

export type Status = {
	spend: { usd: number; tokens: number; capUsd: number; capTokens: number; reached: boolean };
	inbox: number;
	models: string[];
	model: { main?: string; background?: string };
	configWarning?: string;
	telegram: { configured: boolean; linked: boolean; running: boolean; bot?: string; error?: string };
	jobs: { queued: number; running: number; parked: number };
	version?: string;
};

export type DoctorCheck = { name: string; ok: boolean | null; detail: string; fix?: string };

export type SecretInfo = { key: string; what: string; set: boolean };

export type Job = { id: string; kind: string; schedule?: string | null; payload_json?: string; next_run_at?: string | null; enabled: number; created_at: string };

export type JobRun = { id: string; job_id?: string | null; kind: string; state: string; summary?: string | null; created_at: string; started_at?: string | null; finished_at?: string | null; thread_id?: string | null };

// ------------------------------------------------------------------ chat

export type Thread = {
	id: string;
	name: string;
	kind: "chat" | "telegram" | "job" | "setup" | string;
	title_id?: string | null;
	job_run_id?: string | null;
	updated_at: string;
	running?: boolean;
	pending_question?: boolean;
	archived?: number;
};

export type Ask = { id: string; question: string; kind: "choice" | "confirm" | "text" | "secret"; options?: string[]; secret_key?: string };

export type Card =
	| { kind: "title"; title: Title }
	| { kind: "candidates"; candidates: Candidate[] }
	| { kind: "releases"; releases: Release[]; pick?: string; reason?: string; total?: number; indexers?: IndexerOutcome[] }
	| { kind: "plan"; items: PlanItem[]; results?: unknown; problems?: string[]; mode?: string; reason?: string }
	| { kind: "progress"; hash: string; name?: string }
	| { kind: "downloads"; downloads: Download[] }
	| { kind: "image"; image: string; text?: string; path?: string }
	| { kind: "verification"; image: string; text?: string; path?: string }
	| { kind: "text"; text: string }
	| { kind: string; [k: string]: unknown };

export type ToolCall = { id: string; name: string; label: string; isError?: boolean; summary?: string; card?: Card; done?: boolean };

export type UiMessage =
	| { role: "user"; text: string; images?: number }
	| { role: "assistant"; text: string; tools: ToolCall[]; error?: string };

export type ThreadDetail = { thread: Thread; messages: UiMessage[]; seq: number; running: boolean; pending?: Ask };

/** Events on `GET /api/threads/:id/events` (event name `ui`). */
export type UiEvent = { seq: number; threadId: string; type: string; [k: string]: unknown };

/** Events on `GET /api/events` (event name `app`). */
export type AppEvent =
	| { type: "download"; hash: string; state: string; progress?: number }
	| { type: "inbox"; id: string; status: string }
	| { type: "action"; action: unknown }
	| { type: "job"; id: string; state: string; kind: string }
	| { type: "config" }
	| { type: "notice"; level: string; text: string }
	| { type: "thread"; threadId: string; event: "run_start" | "run_end" | "ask" };

// ------------------------------------------------------------------ added subsystems

export type BrowserTab = { id: string; owner: string; url: string; viewers: number };

export type SubtitleCandidate = { ref: string; source: string; title?: string; release?: string; languages?: string[]; formats?: string[]; tags?: string[]; downloads?: number; date?: string; uploader?: string };

export type SubtitleSearch = {
	title?: string;
	have: { video: string; external: string[]; embeddedChinese: string[] }[];
	candidates: SubtitleCandidate[];
	errors: string[];
	note?: string;
};

export type PlacedSubtitle = { id: number; title_id: string; video_path: string; path: string; source?: string; source_ref?: string; language?: string; format?: string; created_at: string };

export type FollowRow = { id: string; title_id: string; instruction: string; quick_accept?: string | null; season?: number | null; active: number | boolean; summary?: string };

export type AdoptRow = {
	n: number;
	hash: string;
	name: string;
	content_path?: string;
	complete?: boolean;
	title_id?: string;
	title?: string;
	confident: boolean;
	why?: string;
	plan?: { items: PlanItem[] };
	problems: string[];
	status: "pending" | "applied" | "skipped" | "failed" | string;
	error?: string;
};

export type AdoptScan = { id: string; created_at: string; rows: AdoptRow[] };

export type Skill = { name: string; description: string; body: string };
