/**
 * The contracts of the seams (docs/plugins.md §7). A provider implements one of these types and
 * passes it to `ctx.provide`. Everything crossing the seam is plain data: JSON values and bytes.
 */
export type Kind = "movie" | "show" | "anime";
export type Ids = { tmdb?: number; imdb?: string; tvdb?: number; bangumi?: number; douban?: string };

/** The last argument of every seam method. */
export type Call = {
	signal: AbortSignal;
	/** When Reelix stops waiting, in milliseconds since the epoch: a provider with several steps plans its time by it. */
	deadline: number;
	/** The result of a human check the owner passed at the `url` of `needs_verification`. */
	verification?: string;
};

/** An expected answer of an outside service. Shown to the owner and the agent; never counted as a failure. */
export type Outcome =
	| { outcome: "rate_limited"; until?: string }
	| { outcome: "needs_auth" }
	| { outcome: "needs_verification"; url: string }
	| { outcome: "unavailable"; message: string };

const OUTCOME_ERROR = Symbol.for("reelix.outcome-error");

/**
 * An expected answer of the service from a seam method whose type does not list `Outcome` (§7): thrown, it
 * is shown like a returned outcome and is not counted as a failure of the plugin.
 */
export class OutcomeError extends Error {
	outcome: Outcome;
	readonly [OUTCOME_ERROR] = true;
	constructor(outcome: Outcome) {
		super(outcome.outcome === "unavailable" ? outcome.message : outcome.outcome);
		this.outcome = outcome;
	}
}

/** Works across copies of this package: a plugin's is loaded apart from Reelix's. */
export const isOutcomeError = (e: unknown): e is OutcomeError => typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[OUTCOME_ERROR] === true && isOutcome((e as OutcomeError).outcome);

export function isOutcome(v: unknown): v is Outcome {
	const o = v as { outcome?: unknown; url?: unknown; message?: unknown } | null;
	if (typeof o !== "object" || o === null) return false;
	if (o.outcome === "rate_limited" || o.outcome === "needs_auth") return true;
	if (o.outcome === "needs_verification") return typeof o.url === "string";
	return o.outcome === "unavailable" && typeof o.message === "string";
}

// ---------------------------------------------------------------- reelix:subtitle.source@1 (§7.1)

export type SubtitleQuery = {
	/** Every known name of the title, the display name first. */
	names: string[];
	year?: number;
	ids: Ids;
	kind: Kind;
	/** A title with seasons and episodes, whatever its kind (an anime can be either). */
	series: boolean;
	season?: number;
	episodes?: number[];
	/** The wanted languages this source covers, in the owner's order. */
	languages: string[];
	/** The agent's own search words, when it overrides the names. */
	text?: string;
	videoHash?: string;
};

export type SubtitleHit = {
	/** The provider's own reference; Reelix stores it as "<provider id>:<ref>". */
	ref: string;
	/** The title the site files it under. */
	name: string;
	/** The languages as the site words them (简体, 双语, en). */
	languages: string[];
	/** ISO 639-1 code, when the site states one. */
	language?: string;
	formats?: string[];
	season?: number;
	episode?: number;
	release?: string;
	hashMatch?: boolean;
	machine?: boolean;
	hearingImpaired?: boolean;
	date?: string;
	/** What the site says about it, for choosing: 官方字幕, trusted, season pack. */
	tags?: string[];
	size?: string;
	downloads?: number;
	uploader?: string;
	/** An id the site revealed, e.g. Douban; Reelix records it on the title. */
	ids?: Ids;
};

export type SubtitleSource = {
	id: string;
	label: string;
	kinds: Kind[];
	languages: string[];
	/** Declared secrets it cannot work without. While one is missing it is not asked, and the owner is told. */
	needsSecrets?: string[];
	search(q: SubtitleQuery, call: Call): Promise<SubtitleHit[] | Outcome>;
	files?(ref: string, call: Call): Promise<{ name: string; size?: number }[] | Outcome>;
	/** May return an archive; Reelix unpacks it. */
	download(ref: string, call: Call): Promise<{ bytes: Uint8Array; filename: string } | Outcome>;
};

// ---------------------------------------------------------------- reelix:indexer@1 (§7.2)

export type Site = { id: string; name: string; private?: boolean };

export type IndexerQuery = {
	queries: string[];
	/** Absent for a free-text search that is not about a known title. */
	kind?: Kind;
	ids?: Ids;
	season?: number;
	episode?: number;
	/** Only these sites (ids). */
	sites?: string[];
};

export type SiteResult = { site: string; ok: boolean; count: number; ms: number; outcome?: Outcome };

export type ReleaseHit = {
	ref: string;
	title: string;
	/** A Site id. */
	site: string;
	size?: number;
	seeders?: number;
	peers?: number;
	infoHash?: string;
	publishedAt?: string;
	hasMagnet: boolean;
	/** 0 = freeleech. */
	downloadFactor?: number;
	uploadFactor?: number;
	minSeedSeconds?: number;
	minRatio?: number;
	attrs?: Record<string, string | number | boolean>;
};

export type Indexer = {
	id: string;
	label: string;
	kinds: Kind[];
	sites(call: Call): Promise<Site[] | Outcome>;
	/** At most 30 seconds per site: a slow site is reported in `sites` and the others' hits survive. */
	search(q: IndexerQuery, call: Call): Promise<{ hits: ReleaseHit[]; sites: SiteResult[] }>;
	fetch(ref: string, call: Call): Promise<{ torrent?: Uint8Array; magnet?: string } | Outcome>;
};

// ---------------------------------------------------------------- reelix:notifier@1 (§7.3)

export type Notice = {
	inboxId: string;
	kind: string;
	title: string;
	body?: string;
	/** How the owner can answer. Option ids are what `ctx.inbox.answer` takes back. */
	answer: { kind: "none" | "choice" | "text"; options: { id: string; label: string }[] };
	image?: Uint8Array;
	/** The item's path inside Reelix; the provider adds its own address. */
	path: string;
	/** Deliver it with priority where the service has such a thing: a choice is waiting, or it was marked urgent. */
	urgent: boolean;
	/** How many Inbox items are open. */
	badge: number;
};

export type Notifier = {
	id: string;
	label: string;
	/** `answers`: it can bring the owner's answer back; without it, `send` gets `answer.kind` "none". */
	can: { images: boolean; update: boolean; answers: boolean };
	/** `ref` is the provider's own name for what it sent; `update` and replies refer to it. */
	send(n: Notice, call: Call): Promise<{ ref?: string } | Outcome>;
	/** The item was closed. Called only with a `ref` from `send`. */
	update?(ref: string, n: Notice, closed: { status: string; answer?: string }, call: Call): Promise<void | Outcome>;
};

// ---------------------------------------------------------------- reelix:chat.channel@1 (§7.4)

/** What the agent says. A question asking for a secret never gets here: the channel is told to use the web app. */
export type ChatOut =
	| { type: "text"; text: string }
	| { type: "card"; kind: string; text: string; image?: Uint8Array }
	| { type: "ask"; id: string; question: string; options: { id: string; label: string }[] }
	| { type: "working" };

export type ChatChannel = {
	id: string;
	label: string;
	can: { buttons: boolean; images: boolean; typing: boolean };
	say(m: ChatOut, call: Call): Promise<void | Outcome>;
};

// ---------------------------------------------------------------- reelix:downloader@1 (§7.5)

/** `mark`: lowercase letters, digits and hyphens. `folder` is as the client names it. */
export type AddOptions = { paused: boolean; mark: string; folder?: string };

/** `duplicate`: the client already had it and ignored the options; Reelix then adds its mark itself. */
export type AddResult = { id: string; duplicate: boolean };

export type Transfer = {
	/** The v1 info-hash, 40 lower-case hex digits. */
	id: string;
	name: string;
	/** `checking` covers verifying and moving data. `error` is only a local failure. */
	state: "queued" | "checking" | "downloading" | "seeding" | "stopped" | "error";
	hasMetadata: boolean;
	/** Metadata present, no wanted data missing, nothing being checked or moved, no local error. Not "a seed limit was reached". */
	done: boolean;
	/** 0..1 of the wanted data. */
	progress: number;
	/** Bytes of the wanted data; 0 before metadata. */
	size: number;
	/** Wanted bytes still missing; 0 before metadata. */
	left: number;
	folder: string;
	/** The single file or the top folder; relied on only when done. */
	contentPath?: string;
	marks: string[];
	addedAt: string;
	completedAt?: string;
	downSpeed?: number;
	upSpeed?: number;
	/** Absent when unknown or unbounded. */
	etaSeconds?: number;
	peersSending?: number;
	/** Absent when undefined or infinite. */
	ratio?: number;
	seedingSeconds?: number;
	/** A tracker's message does not change the state; a local failure is also `state: "error"`. */
	problem?: { kind: "tracker" | "local"; message: string };
};

/** `index`: the file's position in the torrent. `path`: relative to the transfer's folder, with `/`. */
export type TransferFile = { index: number; path: string; size: number; progress: number; wanted: boolean };

export type TransferChanges = {
	cursor: string;
	/** `changed` is every transfer; anything absent is gone. */
	full: boolean;
	changed: Transfer[];
	/** Info-hashes; empty when full. */
	removed: string[];
};

/**
 * A torrent client. Rules every provider follows (checked by the conformance suite): an empty list of ids or
 * indexes never reaches the service; `list` combines `ids` and `mark` with AND and leaves unknown ids out; after
 * `add` the transfer exists with its mark; `paused` requests no payload until `start`; `files` is `[]` before
 * metadata, in torrent order; `addMark` keeps existing marks; `remove` may return before the files are gone;
 * an undefined or unusable cursor gives a full answer. Times are ISO 8601; paths are as the client names them.
 * Methods without `Outcome` in their type throw `OutcomeError` for an expected answer of the service.
 */
export type Downloader = {
	id: string;
	label: string;
	add(src: { torrent: Uint8Array } | { magnet: string }, o: AddOptions, call: Call): Promise<AddResult | Outcome>;
	get(id: string, call: Call): Promise<Transfer | undefined>;
	list(o: { ids?: string[]; mark?: string }, call: Call): Promise<Transfer[]>;
	changes?(cursor: string | undefined, call: Call): Promise<TransferChanges>;
	files(id: string, call: Call): Promise<TransferFile[]>;
	/** Needs `hasMetadata`. */
	setWanted(id: string, indexes: number[], wanted: boolean, call: Call): Promise<void>;
	start(ids: string[], call: Call): Promise<void>;
	stop(ids: string[], call: Call): Promise<void>;
	remove(ids: string[], o: { deleteFiles: boolean }, call: Call): Promise<void>;
	addMark(ids: string[], mark: string, call: Call): Promise<void>;
	/** Bytes free at `defaultFolder`; undefined when unknown. */
	freeSpace(call: Call): Promise<number | undefined>;
	/** As the client names it. */
	defaultFolder(call: Call): Promise<string>;
};

// ---------------------------------------------------------------- reelix:media.server@1 (§7.7)

export type ServerUser = { id: string; name: string; admin: boolean; active: boolean };

/** `paths`: the library's folders as the server names them. */
export type ServerLibrary = { id: string; name: string; paths: string[] };

export type ServerItemsQuery = {
	userId: string;
	kinds: ("movie" | "show")[];
	/** `played`: a film the user played, or a show with at least one played episode. */
	filter?: "played" | "favourite";
	/** `lastPlayed`: the most recently played first. */
	sort?: "lastPlayed";
	limit?: number;
};

/** For a show, `episodesPlayed` and `lastPlayedAt` are about its episodes. */
export type ServerItem = {
	id: string;
	kind: "movie" | "show";
	name: string;
	year?: number;
	ids: Ids;
	plays?: number;
	episodesPlayed?: number;
	favourite?: boolean;
	lastPlayedAt?: string;
};

export type ServerEpisode = { id: string; showId: string; season: number; episode: number };

/**
 * A media server. Rules every provider follows (checked by the conformance suite): an empty list of changed
 * paths never reaches the server; `items`, `episodes` and `nextUp` are about one user and leave out what that
 * user may not see; paths are as the server names them. Methods throw `OutcomeError` for an expected answer of
 * the service.
 */
export type MediaServer = {
	id: string;
	label: string;
	/** Whose watch history counts, by user name, as the owner set it. Absent: the only user, else the administrators. */
	watchUsers?: string[];
	/** `serverId`: the server's own id, which some players need; `publicUrl`: the address the owner's devices open. */
	info(call: Call): Promise<{ serverId: string; name: string; version: string; publicUrl?: string }>;
	libraries(call: Call): Promise<ServerLibrary[]>;
	users(call: Call): Promise<ServerUser[]>;
	/** Folders or files that appeared or went, so the server looks at them without scanning everything. */
	changed(paths: { path: string; change: "created" | "deleted" }[], call: Call): Promise<void>;
	refreshAll(call: Call): Promise<void>;
	items(q: ServerItemsQuery, call: Call): Promise<ServerItem[]>;
	episodes(o: { userId: string; showId: string }, call: Call): Promise<ServerEpisode[]>;
	/** The next episode to watch of each show the user has started. */
	nextUp(userId: string, call: Call): Promise<ServerEpisode[]>;
};

// ---------------------------------------------------------------- reelix:player@1 (§7.9)

/** A title to open. `server`: where the active media server has it, for players that play from that server. */
export type PlayRequest = {
	ids: Ids;
	kind: Kind;
	/** A title with seasons and episodes, whatever its kind (an anime can be either). */
	series: boolean;
	season?: number;
	episode?: number;
	server?: { serverId: string; userId: string; itemId: string; publicUrl?: string };
};

/** `autoplay`: opening it starts playing, rather than showing the title's page. */
export type PlayerLink = { url: string; autoplay: boolean };

/** An app that plays. It builds links only: nothing is played or sent anywhere. */
export type Player = {
	id: string;
	label: string;
	/** It needs the media server's item ids (`PlayRequest.server`); Settings says so while no media server is connected. */
	needsMediaServer?: boolean;
	/** One answer per request, in the same order; null where this player cannot open it. */
	links(requests: PlayRequest[], call: Call): Promise<(PlayerLink | null)[]>;
};

// ---------------------------------------------------------------- reelix:metadata.source@1 (§7.6)

export type Rating = { value: number; scale: number };

/** `names`: other names of the title; `series`: whether it has episodes, when the source says; `note`: what the agent should know about this entry. */
export type MetaHit = { ids: Ids; kind: Kind; name: string; names?: string[]; year?: number; series?: boolean; episodes?: number; rating?: Rating; note?: string };

/** `episodes`: the main story in the source's own numbering, with air dates (YYYY-MM-DD). */
export type Enrichment = { rating?: Rating; episodes?: { number: number; airDate?: string }[] };

/**
 * A source of facts about titles beside TMDB, which stays Reelix's identity for a title. Every method is
 * optional; one that does not know the title answers with nothing rather than guessing.
 */
export type MetadataSource = {
	id: string;
	label: string;
	find?(q: { text: string; kind?: Kind; year?: number }, call: Call): Promise<MetaHit[] | Outcome>;
	/** A link or short id the owner gave (`https://…/subject/1`, `douban:1`); undefined when it is not this source's. */
	fromLink?(text: string, call: Call): Promise<MetaHit | undefined | Outcome>;
	/** Details for the entry named by `ids`; nothing for ids of other sources. */
	enrich?(ids: Ids, call: Call): Promise<Enrichment | Outcome>;
};

// ---------------------------------------------------------------- reelix:trends.source@1 (§7.10)

export type TrendHit = { ids: Ids; kind: Kind; name: string; names?: string[]; year?: number; rating?: number };

/** What is popular at a source, as candidates. Reelix finds each in TMDB and leaves out what it cannot. */
export type TrendsSource = {
	id: string;
	label: string;
	trending(o: { kind: Kind | "all"; window: "day" | "week" }, call: Call): Promise<TrendHit[] | Outcome>;
};

// ---------------------------------------------------------------- reelix:translator@1 (§7.8)

/**
 * One chunk of subtitle lines to translate. `to`: the target in the owner's words ("French", "Klingon",
 * "pirate English"); `novelty`: a constructed language or a style, where words without an equivalent stay as
 * they are and such lines are marked `borrowed`; `sign`: on-screen text, translated tersely; `glossary`: binding;
 * `context`: the lines just before, already translated; `instructions`: the owner's own words for this translation.
 */
export type TranslateJob = {
	to: string;
	novelty: boolean;
	lines: { n: number; text: string; sign?: boolean }[];
	glossary: { term: string; as: string; note?: string }[];
	tone?: string;
	context: { text: string; translated: string }[];
	instructions?: string;
};

/** `unsure`: the translator doubts this line, so the review looks at it; `borrowed`: it keeps words of the source (novelty only). */
export type TranslatedLine = { n: number; text: string; unsure?: boolean; borrowed?: boolean };

/**
 * Lines asked for and translated, each at most once; a line left out is asked for again. `terms`: names or
 * recurring terms met that the glossary lacks, as written; `model`: what translated, for the report.
 */
export type TranslateResult = { lines: TranslatedLine[]; terms?: { term: string; as: string }[]; model?: string };

/**
 * Translates one chunk of subtitle lines. Glossary, review, pacing, resuming and the file stay with Reelix.
 * An answer that cannot be used is an empty `lines`, not a throw; a translator that cannot work now answers
 * with an outcome, and the translation pauses.
 */
export type Translator = {
	id: string;
	label: string;
	translate(job: TranslateJob, call: Call): Promise<TranslateResult | Outcome>;
};

/** The seams this version of Reelix has, by id. */
export type SeamContracts = {
	"reelix:subtitle.source@1": SubtitleSource;
	"reelix:indexer@1": Indexer;
	"reelix:notifier@1": Notifier;
	"reelix:chat.channel@1": ChatChannel;
	"reelix:downloader@1": Downloader;
	"reelix:media.server@1": MediaServer;
	"reelix:player@1": Player;
	"reelix:metadata.source@1": MetadataSource;
	"reelix:trends.source@1": TrendsSource;
	"reelix:translator@1": Translator;
};

export type SeamId = keyof SeamContracts;
