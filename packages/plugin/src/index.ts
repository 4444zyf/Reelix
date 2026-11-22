/**
 * What a Reelix plugin imports (docs/plugins.md §5, §6). At run time Reelix maps this package to
 * its own copy, so a plugin always gets the version of the Reelix it runs in.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type { Notice, Outcome, ReleaseHit, SeamContracts, SeamId } from "./seams.ts";

export { Type } from "typebox";
export * from "./seams.ts";

export type Effect = "read" | "write" | "destructive" | "admin";

/**
 * One value from outside (a file name, a release name) made safe to put in text for the model: it
 * cannot start a line of its own or run on (docs/plugins.md §10.7).
 */
export function outsideLine(text: string, limit = 300): string {
	// Control and format characters (which can reorder displayed text) and line separators.
	const line = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/ {2,}/g, " ").trim();
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * The `reelix` key of a plugin's package.json, as far as this version of Reelix reads it. A skill pack
 * has no `entry`: it is only its `skills` folder (docs/plugins.md §4).
 */
export type PluginManifest = {
	api: 0;
	id: string;
	entry?: string;
	/**
	 * Where its code runs by default: inside Reelix, or in a process of its own that receives only its context
	 * and cannot read Reelix's files (docs/plugins.md §11.7). The owner can choose either for a plugin that
	 * has no raw pi extension (`uses.pi`) and no compiled dependencies (`uses.native`).
	 */
	runtime: "in-process" | "process";
	/**
	 * One screen of its own, shown under Plugins in a sandboxed frame: `entry` is an HTML file in its folder
	 * (the scripts and style sheets it names from its own folder are put inline), `title` its English name (`screen.title` in its
	 * locales for the others). The screen talks to Reelix only through `window.reelix` (docs/plugin-guide.md).
	 */
	screen?: { entry: string; title: string };
	/**
	 * A copy of the `config` schema as JSON, so that the settings form can be shown without loading the
	 * plugin's code (docs/plugins.md §12.2). It must equal the code's schema, or the plugin does not start.
	 */
	settings?: string;
	/**
	 * `seams`: Reelix seams that need a provider switched on. `plugins`: other plugins by id, each with a
	 * version range (`"^0.1.0"`); they start first, and while one is missing, off or of another version this
	 * plugin waits (docs/plugins.md §7.11). A plugin providing a seam or listening to an event that another
	 * plugin owns requires that plugin.
	 */
	requires?: { seams?: SeamId[]; plugins?: Record<string, string> };
	/**
	 * Seams and events this plugin owns (docs/plugins.md §7.11): their names start with its id. Their contract
	 * is data, checked by Reelix: each method's time limit and a JSON Schema of its result; each event's payload.
	 */
	owns?: {
		seams?: Record<PluginSeamId, { summary: string; methods: Record<string, { limitMs?: number; result: Record<string, unknown> }> }>;
		events?: Record<PluginEventId, { summary: string; payload: Record<string, unknown> }>;
	};
	/**
	 * Environment variables that fill one of its settings at start while that setting is empty, by the setting's
	 * path inside its settings (`{ "REELIX_DEFAULT_QBITTORRENT_URL": "url" }`). A URL filled this way is also
	 * checked by Doctor for pointing at Reelix's own container.
	 */
	env?: Record<string, string>;
	/**
	 * One line about its state for the agent's prompt and `reelix config show`: `{path}` is one of its settings
	 * (`{servers.*.url}` every entry's), `{secret:<name>}` says whether that secret is set (one declared per entry: set when every entry has it). Never a secret's value.
	 */
	describe?: string;
	/**
	 * Reelix works fully without it (a chat app, a media server). Until any of its required settings or secrets is
	 * filled in, Settings shows it as "optional, not connected", not as something to fix.
	 */
	optional?: boolean;
	uses?: {
		provides?: (SeamId | PluginSeamId)[];
		hooks?: HookId[];
		/** Its operations by short name, each with its effect: the install screen shows them before any code runs. */
		operations?: Record<string, Effect>;
		/** Operations (short names, at most three) that are also typed agent tools named `<id>_<name>`. */
		tools?: string[];
		jobs?: string[];
		events?: (keyof PluginEvents | PluginEventId)[];
		runs?: string[];
		/** A host, `*.example.com`, `config:<setting>` (the hosts of the URLs in that setting), or `*` (any public host). */
		network?: string[];
		/**
		 * Its secrets, stored as `plugins.<id>.<name>`. A plain name, or `{ name, managed, required, per }`: `managed`, the
		 * plugin makes and renews it itself (never shown as a field); `required`, it cannot work without it; `per`, one
		 * secret for each entry of that list setting, stored as `plugins.<id>.<per>.<n>.<name>` (docs/plugins.md §12.2).
		 */
		secrets?: (string | PluginSecret)[];
		agent?: boolean;
		/** Inbox items and proposals. */
		inbox?: boolean;
		/** Its `skills` folder (pi's layout, `skills/<name>/SKILL.md`) is loaded into the agent's conversations. */
		skills?: boolean;
		/**
		 * The owner's models through `ctx.model` (docs/plugins.md §10.2); shown at install. `roles`: roles besides
		 * `background` it asks for; `unmetered`: it asks to run without a daily budget. The owner can change both
		 * on the plugin's page.
		 */
		model?: boolean | { roles?: ModelRole[]; unmetered?: boolean };
		/** A raw pi extension through `ctx.pi`; shown at install as advanced. */
		pi?: boolean;
		/** Compiled dependencies: installed only when ready-made binaries exist for the owner's platform. */
		native?: boolean;
	};
};

/**
 * What the settings form reads beyond plain TypeBox (docs/plugins.md §12.2). The form is generated from
 * `config`: a string is a text field, a number a number field, a boolean a switch, a union of literals a
 * choice, an array of objects a list of entries, an array of strings a list of words. Labels and help
 * come from the plugin's locales: under `settings`, the keys `<field>`, `<field>_help` and, for a choice,
 * `<field>_<value>`; a field inside a list as the key `"<list>.<field>"` (a key with a dot in it). Under
 * `buttons`, `<operation>`; under `secrets`, `<name>`. A missing label shows the field's name.
 * Put the annotations in a schema's options, e.g. `Type.Number({ [SETTINGS.showWhen]: { field: "schedule", equals: "daily" } })`.
 */
export const SETTINGS = {
	/** On a string field: a choice whose options are the output of this operation of the plugin (short name), `{ value, label }[]`. */
	optionsFrom: "x-reelix-options-from",
	/** On a field: show it only while the field `field` of the same object equals `equals`. */
	showWhen: "x-reelix-show-when",
	/** On the `config` object: buttons that run these operations of the plugin (short names), such as "test" or "link". */
	buttons: "x-reelix-buttons",
	/** On a field: the plugin cannot work while it is empty (a list: while it has no entry). Settings shows "needs setup" until it is filled in. */
	required: "x-reelix-required",
	/** On a field: rarely needed (another address for a site, a program's path); Settings shows it under Advanced. */
	advanced: "x-reelix-advanced",
} as const;

/** A secret in `uses.secrets` with what Settings needs to know about it. */
export type PluginSecret = { name: string; managed?: boolean; required?: boolean; per?: string };

export type SettingOption = { value: string; label: string };

/**
 * What an operation would do, as plain data (docs/plugins.md §6.1, §10.3). `text` says it in one line
 * with names, sizes and paths. `target` is what the step acts on: just before an approved step runs,
 * its preview is made again and the step is skipped when `target` differs. `counts` are added up for
 * a proposal's totals: `downloads`, `titles`, `files`, `bytes`.
 */
export type OperationPreview = { text: string; target: unknown; counts?: Partial<Record<"downloads" | "titles" | "files" | "bytes", number>> };

/**
 * A chat card as data (docs/plugins.md §12.3). An operation names the card kind that shows its result.
 * `list` shows the array in the output field `items`, one line per entry from its field `primary`, with
 * `secondary` below; `text` shows the output field `text`. `buttons` run operations of the plugin (short
 * names) with the given input, as `plugin:<id>`. Titles and labels are plain text: pass them through `ctx.t`.
 */
export type CardLayout =
	| { layout: "list"; title: string; items: string; primary: string; secondary?: string; empty?: string; buttons?: CardButton[] }
	| { layout: "text"; title: string; text: string; buttons?: CardButton[] };
export type CardButton = { label: string; operation: string; input?: Record<string, unknown> };

/** One step of a proposal: an operation and its input. */
export type ProposalStep = { operation: string; input: Record<string, unknown> };
export type Proposal = {
	/** A new proposal with the same key replaces the open one. */
	key: string;
	/** Shown under Reelix's own summary, as a quotation from the plugin. */
	title: string;
	why: string;
	/** At most 50. Each operation needs a `preview`; a core operation must be in `uses.runs`. */
	steps: ProposalStep[];
	/** Default: in seven days. */
	expiresAt?: string;
};
/** `skipped`: the target changed after approval. `not_approved`: the owner unticked it. */
export type ProposalStepResult = { operation: string; status: "succeeded" | "failed" | "skipped" | "not_approved" | "declined" | "expired"; text?: string };
/** `dropped`: made from inside a hook in trial, so never shown. */
export type ProposalOutcome = { id: string; status: "approved" | "declined" | "expired" | "replaced" | "dropped"; steps: ProposalStepResult[] };

/** A download Reelix added or adopted, in words that fit any downloader. Times are ISO strings. */
export type DownloadRecord = {
	hash: string;
	name: string;
	titleId?: string;
	/** Reelix's own state: `downloading`, `complete`, `filed`, `stalled`, `needs_agent`. Removed downloads are not listed. */
	state: string;
	sizeBytes?: number;
	addedAt: string;
	/** When it finished downloading; from then on it is seeding unless it was stopped. */
	completedAt?: string;
	filedAt?: string;
};

/** A seam a plugin owns: `<owner id>:<name>@<version>` (docs/plugins.md §7.11). */
export type PluginSeamId = `${string}:${string}@${number}`;
/** An event a plugin owns: `<owner id>:<name>`. Only the owner emits it. */
export type PluginEventId = `${string}:${string}`;
/** What every provider of a plugin's seam has; the owner's package exports the rest of its contract as a type. */
export type PluginSeamProvider = { id: string; label: string };
/** One provider's answer to `ctx.seams.call`: its result, checked against the owner's contract, or why there is none. */
export type SeamAnswer<R = unknown> = { provider: string; label: string; plugin: string; result?: R; error?: string };

/** The event catalogue (§9). */
export type PluginEvents = {
	"config.changed": { paths: string[] };
	/** A file reached the library. `hash` is absent when no download was involved. */
	"download.filed": { hash?: string; titleId?: string; paths: string[]; via: "download" | "organise" | "adopt" };
	/** An agent session was closed: its conversation was archived or reloaded, a job's a minute after its run. Whatever was held for it can go. */
	"session.ended": { threadId: string; kind: SessionKind };
};

/** What an agent session is for: a conversation in the web app, a chat channel's, a background job's, or a plugin's setup. */
export type SessionKind = "chat" | "channel" | "job" | "setup";

/** The session a raw pi extension is loaded into (docs/plugins.md §10.4). `threadId` is Reelix's conversation id. */
export type AgentSessionInfo = {
	threadId: string;
	kind: SessionKind;
	/** Put a short line into the conversation for the owner to see (not for the model). */
	notice(text: string): void;
};

/** A raw pi extension: called once for every agent session, with pi's extension API (from `@earendil-works/pi-coding-agent`). */
export type PiExtension = (pi: ExtensionAPI, session: AgentSessionInfo) => void;

/** A tool call the agent is about to make, as `agent.tool` sees it. `operation`: the Reelix operation it runs, for a typed tool and the `reelix` tool. */
export type AgentToolCall = {
	tool: string;
	input: unknown;
	operation?: { name: string; effect: Effect };
	session: { threadId: string; kind: SessionKind };
};

/** The roles of the owner's models (docs/models.md). */
export type ModelRole = "chat" | "background" | "glossary" | "translate" | "review";

/** One question to the owner's model and its answer. `model`: which one answered, as `provider/id`. */
export type ModelRequest = { role?: ModelRole; system: string; user: string; signal?: AbortSignal };
export type ModelAnswer = { text: string; model: string };

/** An HTTP request to one of the plugin's routes (`/api/plugins/<id>/<path>`), from the signed-in owner. `body`: a POST's JSON. `signal`: the caller went away. */
export type RouteRequest = { params: Record<string, string>; query: Record<string, string>; body?: unknown; signal: AbortSignal };

/**
 * What a route answers: JSON, a download, or a stream of events (server-sent events), never a page. A
 * download is always an attachment; an HTML, SVG, XML or script type is refused. The stream ends when the
 * iterable does or the caller goes away.
 */
export type RouteResponse =
	| { status?: number; json: unknown }
	| { download: { bytes: Uint8Array; filename: string; type?: string } }
	| { events: AsyncIterable<{ event?: string; data: unknown }> };

/** The title a hook's decision is about. */
export type HookTitle = { id: string; name: string; kind: "movie" | "tv"; mediaClass: string; year?: number; tmdbId?: number };

/** What Reelix reads from a release name. */
export type ParsedFacts = { resolution?: string; source?: string; codec?: string; group?: string; season?: number; episodes?: number[] };

/** A release in a hook: the indexer's hit plus the parsed facts. `ref` is Reelix's handle, never the indexer's own reference. */
export type HookRelease = Omit<ReleaseHit, "ref"> & ParsedFacts & { ref: string; siteName: string };

export type HookReleases = {
	/** Absent for a free-text search. */
	title?: HookTitle;
	releases: HookRelease[];
};

/** One file of a plan Reelix made. `path` is relative to the library folder and starts with the title folder. */
export type OrganiseItem = { source: string; path: string; kind: "video" | "subtitle" | "extra" | "audio" | "disc"; parsed: ParsedFacts };

/** A download Reelix is about to start, once its contents are known (§8). */
export type DownloadBefore = {
	/** Absent for a magnet link given directly. */
	release?: HookRelease;
	title?: HookTitle;
	options: {
		/** Every file of the torrent, in its order, and whether it will be downloaded. */
		files: { path: string; size: number; wanted: boolean }[];
		/** Bytes that will be downloaded. */
		size: number;
		/** Episodes wanted from it; empty for a film or a whole pack. */
		episodes: { season: number; episode: number }[];
	};
};

/**
 * The subtitle files of one archive, before Reelix picks the best for each video. `name` is the file's path
 * inside the archive; `languages` as detected from the text (ISO 639-1, `zh-TW` for traditional Chinese, two
 * for a bilingual file, none when unknown); `score` is Reelix's: at least ten points per step up the owner's
 * language list (and between bilingual, simplified and traditional Chinese), then 2 for ASS and 1 for SRT. The
 * highest score wins.
 */
export type SubtitlePick = { files: { name: string; languages: string[]; format: string; score: number }[] };

/** The hooks (§8): what a handler receives, and what it may return. Returning nothing means "no opinion". */
export type PluginHooks = {
	/** Collected when a conversation loads; never for background jobs. `channel`: the chat channel it belongs to. */
	"agent.prompt@1": { input: { session: { kind: string; channel?: string } }; item: { title: string; text: string } };
	/** Hide releases. They stay in the result, marked with the plugin and its reason. */
	"release.filter@1": { input: HookReleases; item: { ref: string; reason: string }[] };
	/** Order the releases that are not hidden. `order` holds every `ref` exactly once; `notes` are shown as facts. */
	"release.rank@1": { input: HookReleases; item: { order: string[]; notes?: { ref: string; note: string }[]; reason: string } };
	/** Change where files of a plan Reelix made will go. List only the items that change. */
	"organise.name@1": { input: { title: HookTitle; items: OrganiseItem[] }; item: { items: { source: string; path: string }[]; reason: string } };
	/** Change the wording or picture of a notice on its way to the owner's devices. */
	"notify.before@1": { input: Notice; item: { title?: string; body?: string; image?: Uint8Array; reason: string } };
	/** Refuse a download, after Reelix's own checks. A magnet's files are known only once the downloader has loaded it; a refusal then removes it again. */
	"download.before@1": { input: DownloadBefore; item: { reason: string } };
	/** Change the scores of subtitle files in an archive. List only the files whose score changes; files cannot be added or removed. */
	"subtitle.pick@1": { input: SubtitlePick; item: { files: { name: string; score: number }[]; reason: string } };
	/** Block a tool call of the agent, with a reason the agent is told. It cannot change the input or the result, and it does not see commands the agent runs in its shell. */
	"agent.tool@1": { input: AgentToolCall; item: { reason: string } };
};
export type HookId = keyof PluginHooks;

export type PluginJobRun = { id: string; payload: Record<string, unknown> };
/** `parked`: the job's agent turn is waiting for the owner; it resumes on the answer. */
export type PluginJobResult = { state: "succeeded" | "failed" | "parked"; summary: string };

/**
 * How a Doctor check came out. `skipped`: a prerequisite is missing; `not_tested`: set up, but the test
 * that would tell has not run; `not_used`: optional and not set up; `degraded`: works, with something missing.
 */
export type CheckState = "passed" | "failed" | "skipped" | "not_tested" | "not_used" | "degraded";
/** A message from the plugin's own strings (`locales/<lang>.json`): its key and values. Reelix words it in the owner's language. */
export type PluginMessage = { key: string; values?: Record<string, string | number> };
/**
 * A Doctor check's result (docs/plugins.md §6). `cause`: what the check found, for a failure why;
 * `impact`: what that stops or leaves working; `action`: the one thing to do, a setting or secret of
 * this plugin to fill in, or one of its operations to run (default: its card in Settings); `cli`: the
 * command for the command line; `raw`: the details (addresses, raw errors); `cause_id`: results with the
 * same cause are shown once (`setup`: its settings are incomplete; `unreachable`: its service does not answer).
 */
export type PluginCheck = {
	state: CheckState;
	cause: PluginMessage;
	impact?: PluginMessage;
	action?: { label?: PluginMessage; setting?: string; secret?: string; operation?: string; input?: Record<string, unknown> };
	cli?: string;
	raw?: string;
	cause_id?: string;
};
/** A structured result, or the earlier shape, which keeps working: its `detail` becomes the details and the cause reads "check failed". */
export type PluginCheckResult = PluginCheck | { ok: boolean | null; detail: string; fix?: string };

export type PluginFetchInit = {
	method?: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array;
	signal?: AbortSignal;
	/** Default 20 seconds, at most two minutes. */
	timeoutMs?: number;
	/** `manual` hands a redirect back instead of following it. */
	redirect?: "follow" | "manual";
	/** The service name looked up in the owner's proxy settings; default the plugin's id. */
	service?: string;
};

export type PluginFetchResponse = {
	status: number;
	ok: boolean;
	url: string;
	/** Lower-case names. */
	headers: Record<string, string>;
	/** Every `set-cookie` header. */
	cookies: string[];
	bytes: Uint8Array;
};

export type PluginAgentOutcome = { state: string; text: string; parkedOn?: string };

export type MissingSubtitles = {
	/** The wanted languages in order: code and name. */
	wanted: { code: string; label: string }[];
	/** Videos of the title that lack the first wanted language. */
	missing: string[];
};

/** Who is running a plugin's operation. `request.origin`: the checked web origin of a signed-in browser's request. */
export type OperationCall = { actor: string; request?: { origin?: string } };

/** A message from a chat app (§7.4). */
export type ChatIncoming = {
	channel: string;
	/** The chat app's id of the person. The plugin vouches for it; Reelix cannot check it. */
	sender: string;
	text?: string;
	images?: { data: Uint8Array; mimeType: string }[];
	/** The id of the question being answered, or the `ref` of the notice being replied to. */
	answerTo?: string;
	/** The button pressed on the question in `answerTo`. */
	optionId?: string;
};

/**
 * What became of an incoming message or answer. `ignored`: not the channel's owner. `closed`: the question
 * is no longer open. `approve_in_web`: this channel may not approve destructive actions (§11.2).
 */
export type ChatReceipt = { status: "ignored" | "paired" | "sent" | "closed" | "approve_in_web" } | { status: "answered"; answer: string };

export type PluginContext = {
	/** Aborted when the plugin stops. */
	signal: AbortSignal;
	/** Register a job. Its kind in the job list is `<plugin id>.<name>`. `every`: run it every so many minutes ("60m"). */
	job(job: { name: string; every?: `${number}m`; run(run: PluginJobRun): Promise<PluginJobResult> }): Promise<void>;
	jobs: {
		/** Queue one run of this plugin's own job; returns the run id. */
		enqueue(name: string, payload: Record<string, unknown>, options?: { dedupe?: string }): Promise<string>;
	};
	/** Register the operation `<plugin id>.<name>`, listed in `uses.operations` by its short name. */
	operation<S extends TSchema>(op: {
		name: string;
		summary: string;
		effect: Effect;
		/** For an `admin` operation: the agent may run it too (plugins never may). The owner's setup in chat relies on such operations. */
		agentMay?: boolean;
		input: S;
		run(input: Static<S>, call: OperationCall): Promise<unknown>;
		toText?(output: any): string;
		/** Also a typed agent tool `<id>_<name>`; the name must be in `uses.tools`. */
		tool?: boolean;
		/** What it would do, without doing it. Needed for a step of a proposal. */
		preview?(input: Static<S>): Promise<OperationPreview>;
		/** The card kind (registered with `ctx.card`) that shows its result in chat. */
		card?: string;
		/** What the ledger keeps of the input, when part of it must never be stored. */
		recordInput?(input: Static<S>): unknown;
		/** What the ledger keeps of the output, when part of it must never be stored. */
		recordOutput?(output: any): unknown;
	}): Promise<void>;
	/** Become a provider of a seam listed in `uses.provides`: one of Reelix's, or one another plugin owns (its type comes from that plugin's package). */
	provide<S extends SeamId | PluginSeamId>(seam: S, provider: S extends SeamId ? SeamContracts[S] : PluginSeamProvider): Promise<void>;
	/** For a seam this plugin owns (`owns.seams`): call one method on every provider, each within the method's time limit. Results that break the contract come back as errors. */
	seams: { call<R = unknown>(seam: PluginSeamId, method: string, args: unknown[]): Promise<SeamAnswer<R>[]> };
	/** Emit an event this plugin owns (`owns.events`); the payload is checked against its schema. Listeners cannot delay it. */
	emit(event: PluginEventId, payload: unknown): Promise<void>;
	/** A check shown in Doctor. Returning nothing leaves it out of this run. */
	check(name: string, run: (o: { quick: boolean }) => Promise<PluginCheckResult | undefined>): Promise<void>;
	/** Take part in a hook listed in `uses.hooks`. A handler has 10 seconds. */
	hook<H extends HookId>(name: H, handler: (input: PluginHooks[H]["input"]) => PluginHooks[H]["item"] | undefined | Promise<PluginHooks[H]["item"] | undefined>): Promise<void>;
	/** A chat card kind for the results of this plugin's operations. */
	card(kind: string, layout: CardLayout): Promise<void>;
	/**
	 * Ask the owner to approve a list of operations (needs `uses.inbox`). Reelix writes the card from the
	 * steps' previews. A refusal rejects at once; otherwise it settles when the owner decides, the
	 * proposal expires, or a new one with the same key replaces it. It need not be awaited.
	 */
	propose(proposal: Proposal): Promise<ProposalOutcome>;
	/** A long-running loop, such as a chat app's long poll. If it ends it is started again after a growing delay; a throw also counts as a failure. */
	task(name: string, run: (task: { signal: AbortSignal }) => Promise<void>): Promise<void>;
	/** Listen to an event listed in `uses.events`: one of Reelix's, or one another plugin owns (its payload type comes from that plugin's package). */
	on<E extends keyof PluginEvents | PluginEventId>(event: E, listener: (payload: E extends keyof PluginEvents ? PluginEvents[E] : unknown) => void | Promise<void>): Promise<void>;
	/** The plugin's own small store. Values are JSON. */
	kv: {
		get<T = unknown>(key: string): Promise<T | undefined>;
		set(key: string, value: unknown): Promise<void>;
		delete(key: string): Promise<void>;
	};
	/** Secrets listed in `uses.secrets`; stored as `plugins.<id>.<name>` and blanked out of logs and model input. A secret declared `per` a list is named `<per>.<n>.<name>` (e.g. `servers.0.api_key`). */
	secret: {
		get(name: string): Promise<string | undefined>;
		/** For values the plugin obtains itself (a generated key). Does not restart the plugin. */
		set(name: string, value: string): Promise<void>;
	};
	/** Reelix's fetch (§11.4): the owner's proxy, time limits, and only the hosts in `uses.network`. */
	http: { fetch(url: string, init?: PluginFetchInit): Promise<PluginFetchResponse> };
	/**
	 * The owner's models (`uses.model`, docs/plugins.md §10.2): one question, one answer, no tools, on the models
	 * of `role` (default `background`; another only when the owner allows it). Metered under the plugin's daily
	 * budget; when that is used up, or no model can answer now, the answer is the outcome `unavailable`. At most
	 * 100,000 characters of `system` and `user` together.
	 */
	model: { complete(request: ModelRequest): Promise<ModelAnswer | Outcome> };
	/**
	 * A raw pi extension (`uses.pi`, docs/plugins.md §10.4), loaded into every agent session from now on. Its
	 * tools must be named `<id>_<name>`; one that collides with a Reelix tool or another plugin's is refused.
	 * Reelix's own redaction and marking of outside text run after every plugin's handlers.
	 */
	pi(extension: PiExtension): Promise<void>;
	/** The plugin's own folder for larger files (`<data>/plugin-data/<id>`): kept while it is off, deleted with its data at uninstall. */
	folder(): Promise<string>;
	/** HTTP under `/api/plugins/<id>/<path>`, behind the owner's sign-in. `path` may hold `:name` parts, given in `params`. */
	route(method: "GET" | "POST", path: string, handler: (request: RouteRequest) => Promise<RouteResponse>): Promise<void>;
	/** Inside a job (with `uses.agent`): one background agent turn. Return `parked` when `parkedOn` is set. */
	agent: { run(turn: { prompt: string; title?: string }): Promise<PluginAgentOutcome> };
	/** Needs `uses.inbox`. `key` keeps one open item per key. Too many notices in an hour are dropped: `added` is false. */
	inbox: {
		add(item: { title: string; body?: string; key?: string }): Promise<{ added: boolean }>;
		/** The owner pressed a button on a notice in this plugin's chat app. Only the sender paired with one of its channels counts. */
		answer(inboxId: string, answer: { optionId: string; sender: string }): Promise<ChatReceipt>;
	};
	/** Pairing lives in Reelix (§7.4). */
	owner: {
		/** A one-time code for the owner to send from the chat app. Refused while every channel of the plugin has its owner. */
		pair(): Promise<{ code: string; expiresAt: string }>;
		/** The sender paired with a channel of this plugin: whom to send to. */
		of(channel: string): Promise<string | undefined>;
	};
	chat: {
		/** Hand over one incoming message. Anything not from the channel's owner stops here. */
		receive(message: ChatIncoming): Promise<ChatReceipt>;
	};
	reelix: {
		/** Run a core operation listed in `uses.runs`; recorded under `plugin:<id>`. */
		run<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T>;
		read: {
			titles(): Promise<{ withTmdb: number }>;
			/** State of services. Never contains a secret value. */
			services(): Promise<{ metadataLocale: string; tmdbKey: boolean }>;
			/** Bytes free at the download folder; absent when unknown. */
			freeSpace(): Promise<{ bytes?: number }>;
			title(id: string): Promise<{ id: string; name: string; series: boolean } | undefined>;
			download(hash: string): Promise<{ name: string; titleId?: string; seasons: number[] } | undefined>;
			/** Every download Reelix is looking after. */
			downloads(): Promise<DownloadRecord[]>;
			missingSubtitles(titleId: string, seasons: number[]): Promise<MissingSubtitles>;
			/** The owner's preferences note. */
			preferences(): Promise<string>;
			/** An Inbox item's state and the owner's answer, for a question asked with `notify` that a tool waits on. */
			answer(inboxId: string): Promise<{ status: "open" | "answered" | "dismissed"; answer?: string } | undefined>;
			/** The owner's proxy for this plugin (its id in the proxy settings), for a program the plugin starts itself; `ctx.http.fetch` uses it already. */
			proxy(): Promise<{ url?: string }>;
		};
	};
	log(message: string): void;
	/** A string from the plugin's `locales/<lang>.json`, in the owner's language. */
	t(key: string, vars?: Record<string, unknown>): string;
};

export type PluginDefinition<S extends TSchema = TSchema> = {
	/** The settings under `plugins.<id>` in config.yaml; checked before `activate`, defaults filled in. */
	config?: S;
	activate(ctx: PluginContext, config: Static<S>): Promise<void> | void;
};

const REFUSAL = Symbol.for("reelix.operation-error");

/** An operation refuses, for a reason the caller can act on. Shown as it is; not counted as a failure of the plugin. */
export class OperationError extends Error {
	code: string;
	readonly [REFUSAL] = true;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** Works across copies of this package: a plugin's is loaded apart from Reelix's. */
export const isOperationError = (e: unknown): e is OperationError => typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[REFUSAL] === true;

const MARK = Symbol.for("reelix.plugin");

/** The default export of a plugin's entry file. */
export function definePlugin<S extends TSchema>(definition: PluginDefinition<S>): PluginDefinition<S> {
	return Object.assign({ [MARK]: true }, definition);
}

export function isPluginDefinition(value: unknown): value is PluginDefinition {
	return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[MARK] === true && typeof (value as PluginDefinition).activate === "function";
}
