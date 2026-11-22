/** Shapes of the Reelix HTTP API (docs/api.md). Kept loose where the server is loose. */

export type Session = { authenticated: boolean; needsPassword: boolean; language?: string | null };

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
	/** Ratings at the metadata sources, by provider id. */
	ratings?: Record<string, { label: string; value: number; scale: number }>;
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

/** `app`: the player's id, remembered on this device; `label`: its name. */
export type PlayLink = { app: string; label: string; url: string; autoplay: boolean };
export type PlayTarget = { title_id: string; name: string; year?: number; kind: string; poster_path?: string | null; in_library: boolean; season?: number; episode?: number; links: PlayLink[]; episodes?: { season: number; episode: number; links: PlayLink[] }[]; note?: string };

export type PushInfo = { public_key: string; devices: { id: string; label: string; service: string; endpoint_id: string; created_at: string; last_ok_at?: string; last_error?: string }[] };

export type TrendItem = Candidate & { rating?: number; in_library: boolean };
export type Suggestion = TrendItem & { reason: string };
export type Suggestions = {
	suggestions?: { made_at: string; state: "ok" | "no_model" | "nothing_known" | "failed"; items: Suggestion[]; model?: string; error?: string; history?: { users: string[]; titles: number; error?: string } };
	working: boolean;
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
	/** The library folders of the title's media type, and which one it goes to (docs/library-folders.md). */
	library: {
		folders: { path: string; name: string; default: boolean }[];
		choice?: string | null;
		decided: { path: string; how: "there" | "chosen" | "rule" | "only" | "default"; rule?: Record<string, string[]>; text: string } | null;
	};
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
	/** Plugins that hid it, and why. */
	hidden?: { plugin: string; reason: string }[];
	notes?: { plugin: string; note: string }[];
};

export type ReleaseWhyRow = { kind: "hidden" | "moved" | "note" | "provider"; plugin: string; reason: string; detail: { from?: number; to?: number }; at: string };
export type ReleaseWhy = { handle: string; title: string; hidden: boolean; reasons: ReleaseWhyRow[]; providers: ReleaseWhyRow[]; searched_at?: string };

export type IndexerOutcome = { indexer: string; name: string; ok: boolean; count: number; ms: number; error?: string };

export type ReleaseSearch = { title?: string; queries: string[]; total: number; offset: number; releases: Release[]; all: Release[]; hidden: Release[]; search: string; indexers: IndexerOutcome[] };

/** A transfer as the active downloader reports it (reelix:downloader@1, docs/plugins.md §7.5). */
export type Transfer = {
	id: string;
	name: string;
	state: "queued" | "checking" | "downloading" | "seeding" | "stopped" | "error";
	hasMetadata: boolean;
	done: boolean;
	progress: number;
	size: number;
	left: number;
	downSpeed?: number;
	upSpeed?: number;
	etaSeconds?: number;
	peersSending?: number;
	ratio?: number;
	problem?: { kind: "tracker" | "local"; message: string };
};

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
	live?: Transfer;
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

/** Why a model call failed, and what the owner can do about it (docs/models.md). */
export type ModelFailure = {
	model?: string;
	class: "signed_out" | "timeout" | "rate_limited" | "budget" | "capability" | "other";
	action: "reconnect" | "retry" | "wait" | "choose_model";
	capability?: "images" | "context";
	until?: string;
	message: string;
};

/** `model.test`. */
export type ModelTestResult =
	| { ok: true; role: string; model: string; answer: string; ms: number; skipped: ModelFailure[] }
	| { ok: false; role: string; ms: number; failures: ModelFailure[]; message: string };

export type Status = {
	spend: { usd: number; tokens: number; capUsd: number; capTokens: number; reached: boolean };
	inbox: number;
	models: string[];
	model: { roles: Record<string, { own: string[]; uses: string[]; resting: string[] }>; rests: (ModelFailure & { model: string; until: string })[]; magpie: { url?: string; ok: boolean; models: string[]; error?: string; admin?: boolean; limits?: { period: string; cost?: number; costLimit?: number; reset?: string; spent?: boolean }[] } };
	configWarning?: string;
	jobs: { queued: number; running: number; parked: number };
	version?: string;
	/** The folder `reelix plugin dev` loaded; a banner says so on every screen. */
	devPlugin?: string;
};

export type ChatChannelInfo = { id: string; label: string; active: boolean; linked: boolean; may_approve: boolean; last_error?: string; last_error_at?: string };

/** Doctor (docs/settings.md, "Status and Doctor"): data the UI words from the `doctor` strings; `text`: a plugin's message, already worded. */
export type CheckState = "passed" | "failed" | "skipped" | "not_tested" | "not_used" | "degraded";
export type CheckMessage = { key: string; values?: Record<string, string | number>; text?: string };
/** `anchor`: a section id, `field-<config path>`, `secret-<secret key>` or `plugin-<id>`. */
export type CheckAction = { label: CheckMessage; anchor: string } | { label: CheckMessage; operation: string; input?: Record<string, unknown> };
export type DoctorCheck = { name: string; state: CheckState; cause: CheckMessage; impact?: CheckMessage; action?: CheckAction; cli?: string; raw?: string; cause_id?: string; also?: string[] };
export type FolderResult = { state: CheckState; cause: CheckMessage; raw?: string };
export type FolderCheck = { path: string; kind: "downloads" | "library" | "other"; label: string; exists: FolderResult; writable: FolderResult; hardlink: FolderResult; media_server: FolderResult };

export type SecretInfo = { key: string; what: string; set: boolean };

export type TrialSummary = { calls: number; hidden: number; firstChanged: number; changed: number; since?: string };
export type PluginSource = { kind: "folder" | "git" | "npm"; location: string; pin?: string };
export type PluginInfo = {
	id: string;
	version: string;
	description: string;
	state: "active" | "waiting" | "failed" | "disabled" | "installed" | "incompatible" | "changed";
	error?: string;
	failures: number;
	waitingFor: string[];
	/** Plugins it requires that are not running at a version in its range: what there is instead, if anything. */
	waitingForPlugins: PluginRequirement[];
	requires: { id: string; range: string }[];
	owns: string[];
	provides: string[];
	hooks: string[];
	operations: string[];
	jobs: string[];
	events: string[];
	runs: string[];
	/** Secrets the owner gives it (full keys); one per entry for a secret declared per list entry. */
	secrets: string[];
	/** Secrets it makes itself: shown as a state, never as a field. */
	managedSecrets: string[];
	network: boolean;
	/** Optional and nothing of it set up yet: shown as "optional, not connected". */
	unused: boolean;
	/** Required settings and secrets that are empty, by name (`servers.0.api_key`); empty while it is off. */
	needsSetup: string[];
	tools: string[];
	toolsOn: boolean;
	trial: boolean;
	trialResult?: TrialSummary;
	kind: "plugin" | "skills";
	source?: PluginSource;
	restartNeeded: boolean;
	update?: { version: string };
	skills: string[];
	setup?: string;
	jobPrompt?: boolean;
	/** Its use of the owner's models today (docs/plugins.md §10.2). */
	model?: { budgetUsd: number; unmetered: boolean; roles: string[]; spentUsd: number; tokens: number; reached: boolean };
	/** Where its code runs: inside Reelix or in a process of its own (docs/plugins.md §11.7). */
	runtime: PluginRuntime;
	runtimeDefault: PluginRuntime;
	processAllowed: boolean;
	/** The screen it ships, shown under Plugins while it runs. */
	screen?: { title: string };
	/** Its own checks' last results, until it restarts; absent: not tested since. */
	lastCheck?: { at: string; results: DoctorCheck[] };
};
export type PluginRuntime = "in-process" | "process";
export type PluginRequirement = { id: string; range: string; version?: string; state?: PluginInfo["state"] };
export type PluginActionResult = {
	id: string;
	result: "applied" | "failed" | "needs_confirmation" | "saved-restart-needed";
	state: PluginInfo["state"];
	next: string;
	dependents?: string[];
	errors?: { path: string; message: string }[];
};
type Effect = "read" | "write" | "destructive" | "admin";
/** What a plugin declares, from its manifest only (docs/plugins.md §11.1). */
export type PluginDeclarations = {
	id: string;
	version: string;
	description: string;
	license?: string;
	kind: "plugin" | "skills";
	provides: string[];
	requires: string[];
	requiresPlugins: { id: string; range: string }[];
	owns: string[];
	hooks: string[];
	events: string[];
	operations: { name: string; effect: Effect; tool?: string }[];
	jobs: string[];
	runs: string[];
	network: string[];
	anyHost: boolean;
	secrets: string[];
	skills: string[];
	scripts: string[];
	agent: boolean;
	inbox: boolean;
	model: boolean;
	modelRoles: string[];
	unmetered: boolean;
	pi: boolean;
	native: boolean;
	runtime: PluginRuntime;
	processAllowed: boolean;
	screen?: string;
};
export type DeclarationDiff = { added: Record<string, string[]>; removed: Record<string, string[]>; effects: { operation: string; from?: Effect; to: Effect }[]; flags: string[] };
/** A plugin the agent wrote and proposed: its files and what changed since its previous proposal. */
export type PluginProposal = {
	id: string;
	plugin: string;
	version: string;
	by: string;
	at: string;
	note?: string;
	status: "open" | "approved" | "declined" | "replaced";
	folder: string;
	files: { path: string; size: number; change: "added" | "changed" | "removed" | "same" }[];
	diffFrom?: string;
	diff: string;
};
export type PluginReview = {
	id: string;
	what: "install" | "update" | "changed" | "proposal";
	hash: string;
	source: PluginSource;
	declarations: PluginDeclarations;
	nativeFound: string[];
	scriptsNotRun: string[];
	from?: { version: string; source: PluginSource };
	diff?: DeclarationDiff;
	changelog?: string;
	requirements: (PluginRequirement & { satisfied: boolean })[];
	proposal?: PluginProposal;
};
export type PluginUpdates = { id: string; version: string; source: PluginSource; available: { to: string; label: string }[]; error?: string };

/** A JSON Schema as the settings form reads it (docs/plugins.md §12.2). */
export type SettingSchema = {
	type?: string;
	default?: unknown;
	minimum?: number;
	maximum?: number;
	maxItems?: number;
	properties?: Record<string, SettingSchema>;
	items?: SettingSchema;
	anyOf?: { const?: unknown }[];
	enum?: unknown[];
	"x-reelix-options-from"?: string;
	"x-reelix-show-when"?: { field: string; equals: unknown };
	"x-reelix-buttons"?: string[];
	"x-reelix-required"?: boolean;
	"x-reelix-advanced"?: boolean;
};
export type PluginSecretRow = { name: string; key: string; set: boolean; managed: boolean; required: boolean; per?: string; entry?: number };
export type PluginSettings = {
	id: string;
	state: PluginInfo["state"];
	schema?: SettingSchema;
	values: Record<string, unknown>;
	strings: Record<string, string>;
	secrets: PluginSecretRow[];
	perEntry: { per: string; name: string; required: boolean }[];
	buttons: string[];
	note?: string;
};
export type HookView = { hook: string; mode: "guard" | "pipeline" | "collect"; plugins: { plugin: string; trial: boolean }[] };

export type ProposalStepResult = { operation: string; status: "succeeded" | "failed" | "skipped" | "not_approved" | "declined" | "expired"; text?: string };
export type Proposal = {
	id: string;
	plugin: string;
	title: string;
	why: string;
	status: "open" | "approved" | "declined" | "expired" | "replaced";
	summary: string;
	destructive: number;
	steps: { operation: string; effect: string; preview: { text: string; counts?: Record<string, number> }; result?: ProposalStepResult }[];
	created_at: string;
	expires_at: string;
	decided_at?: string;
};

/** A plugin's card, built by Reelix from its declaration (docs/plugins.md §12.3). */
export type PluginCardData = { kind: "plugin"; card: string; plugin: string; layout: "list" | "text"; title: string; rows?: { primary: string; secondary?: string }[]; more?: number; text?: string; empty?: string; buttons: { label: string; index: number }[] };

export type Job = { id: string; kind: string; schedule?: string | null; payload_json?: string; next_run_at?: string | null; enabled: number; created_at: string };

export type JobRun = { payload_json?: string; id: string; job_id?: string | null; kind: string; state: string; summary?: string | null; models_json?: string | null; created_at: string; started_at?: string | null; finished_at?: string | null; thread_id?: string | null };

// ------------------------------------------------------------------ chat

export type Thread = {
	id: string;
	name: string;
	kind: "chat" | "channel" | "job" | "setup" | string;
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
	| { kind: "play"; play: PlayTarget }
	| { kind: "candidates"; candidates: Candidate[] }
	| { kind: "releases"; releases: Release[]; pick?: string; reason?: string; total?: number; indexers?: IndexerOutcome[] }
	| { kind: "plan"; items: PlanItem[]; results?: unknown; problems?: string[]; mode?: string; reason?: string }
	| { kind: "progress"; hash: string; name?: string }
	| { kind: "downloads"; downloads: Download[] }
	| { kind: "image"; image: string; text?: string; path?: string }
	| { kind: "verification"; image: string; text?: string; path?: string }
	| { kind: "text"; text: string }
	| PluginCardData
	| { kind: string; [k: string]: unknown };

export type ToolCall = { id: string; name: string; label: string; isError?: boolean; summary?: string; card?: Card; done?: boolean };

export type UiMessage =
	| { role: "user"; text: string; images?: number }
	| { role: "assistant"; text: string; tools: ToolCall[]; error?: string; model?: string; failure?: ModelFailure; fallback?: ModelFailure };

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

export type SubtitleCandidate = { ref: string; source: string; title?: string; release?: string; languages?: string[]; formats?: string[]; tags?: string[]; downloads?: number; date?: string; uploader?: string; language?: string; season?: number; episode?: number; hearingImpaired?: boolean; machine?: boolean; hashMatch?: boolean };

export type SubtitleSearch = {
	title?: string;
	languages?: string[];
	have: { video: string; external: string[]; embeddedWanted: string[] }[];
	candidates: SubtitleCandidate[];
	errors: string[];
	/** Sources not asked because they need a key. */
	skipped?: { source: string; label: string; needs: string[] }[];
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
