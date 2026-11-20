# Plugin reference

Generated from the code by `npm run plugin-reference`. Do not edit: `npm test` fails when this file differs. The design is in [plugins.md](plugins.md).

## Seams

Each provider method has the time limit shown. A method marked *outcome* may answer with a typed outcome instead of a result; the others throw `OutcomeError` for an expected answer of the service. Of a seam of the kind *many* every provider is used; of one of the kind *one of several* the owner picks the active provider, and Reelix never switches by itself.

### `reelix:subtitle.source@1`

Kind: many. Contract: `SubtitleSource`

```ts
export type SubtitleSource = { id: string; label: string; kinds: Kind[]; languages: string[]; needsSecrets?: string[]; search(q: SubtitleQuery, call: Call): Promise<SubtitleHit[] | Outcome>; files?(ref: string, call: Call): Promise<{ name: string; size?: number }[] | Outcome>; download(ref: string, call: Call): Promise<{ bytes: Uint8Array; filename: string } | Outcome>; };
```

| Method | Limit | Outcome | Optional |
| --- | --- | --- | --- |
| `search` | 60 s | yes | no |
| `files` | 60 s | yes | yes |
| `download` | 60 s | yes | no |

### `reelix:indexer@1`

Kind: many. Contract: `Indexer`

```ts
export type Indexer = { id: string; label: string; kinds: Kind[]; sites(call: Call): Promise<Site[] | Outcome>; search(q: IndexerQuery, call: Call): Promise<{ hits: ReleaseHit[]; sites: SiteResult[] }>; fetch(ref: string, call: Call): Promise<{ torrent?: Uint8Array; magnet?: string } | Outcome>; };
```

| Method | Limit | Outcome | Optional |
| --- | --- | --- | --- |
| `sites` | 60 s | yes | no |
| `search` | 35 s | no | no |
| `fetch` | 60 s | yes | no |

### `reelix:notifier@1`

Kind: many. Contract: `Notifier`

```ts
export type Notifier = { id: string; label: string; can: { images: boolean; update: boolean; answers: boolean }; send(n: Notice, call: Call): Promise<{ ref?: string } | Outcome>; update?(ref: string, n: Notice, closed: { status: string; answer?: string }, call: Call): Promise<void | Outcome>; };
```

| Method | Limit | Outcome | Optional |
| --- | --- | --- | --- |
| `send` | 60 s | yes | no |
| `update` | 60 s | yes | yes |

### `reelix:chat.channel@1`

Kind: many. Contract: `ChatChannel`

```ts
export type ChatChannel = { id: string; label: string; can: { buttons: boolean; images: boolean; typing: boolean }; say(m: ChatOut, call: Call): Promise<void | Outcome>; };
```

| Method | Limit | Outcome | Optional |
| --- | --- | --- | --- |
| `say` | 60 s | yes | no |

### `reelix:downloader@1`

Kind: one of several. Contract: `Downloader`

```ts
export type Downloader = { id: string; label: string; add(src: { torrent: Uint8Array } | { magnet: string }, o: AddOptions, call: Call): Promise<AddResult | Outcome>; get(id: string, call: Call): Promise<Transfer | undefined>; list(o: { ids?: string[]; mark?: string }, call: Call): Promise<Transfer[]>; changes?(cursor: string | undefined, call: Call): Promise<TransferChanges>; files(id: string, call: Call): Promise<TransferFile[]>; setWanted(id: string, indexes: number[], wanted: boolean, call: Call): Promise<void>; start(ids: string[], call: Call): Promise<void>; stop(ids: string[], call: Call): Promise<void>; remove(ids: string[], o: { deleteFiles: boolean }, call: Call): Promise<void>; addMark(ids: string[], mark: string, call: Call): Promise<void>; freeSpace(call: Call): Promise<number | undefined>; defaultFolder(call: Call): Promise<string>; };
```

| Method | Limit | Outcome | Optional |
| --- | --- | --- | --- |
| `add` | 60 s | yes | no |
| `get` | 30 s | no | no |
| `list` | 30 s | no | no |
| `changes` | 30 s | no | yes |
| `files` | 30 s | no | no |
| `setWanted` | 60 s | no | no |
| `start` | 60 s | no | no |
| `stop` | 60 s | no | no |
| `remove` | 60 s | no | no |
| `addMark` | 60 s | no | no |
| `freeSpace` | 30 s | no | no |
| `defaultFolder` | 30 s | no | no |

### `reelix:media.server@1`

Kind: one of several. Contract: `MediaServer`

```ts
export type MediaServer = { id: string; label: string; watchUsers?: string[]; info(call: Call): Promise<{ serverId: string; name: string; version: string; publicUrl?: string }>; libraries(call: Call): Promise<ServerLibrary[]>; users(call: Call): Promise<ServerUser[]>; changed(paths: { path: string; change: "created" | "deleted" }[], call: Call): Promise<void>; refreshAll(call: Call): Promise<void>; items(q: ServerItemsQuery, call: Call): Promise<ServerItem[]>; episodes(o: { userId: string; showId: string }, call: Call): Promise<ServerEpisode[]>; nextUp(userId: string, call: Call): Promise<ServerEpisode[]>; };
```

| Method | Limit | Outcome | Optional |
| --- | --- | --- | --- |
| `info` | 15 s | no | no |
| `libraries` | 15 s | no | no |
| `users` | 15 s | no | no |
| `changed` | 30 s | no | no |
| `refreshAll` | 30 s | no | no |
| `items` | 30 s | no | no |
| `episodes` | 30 s | no | no |
| `nextUp` | 30 s | no | no |

### `reelix:player@1`

Kind: many. Contract: `Player`

```ts
export type Player = { id: string; label: string; links(requests: PlayRequest[], call: Call): Promise<(PlayerLink | null)[]>; };
```

| Method | Limit | Outcome | Optional |
| --- | --- | --- | --- |
| `links` | 5 s | no | no |

### `reelix:metadata.source@1`

Kind: many. Contract: `MetadataSource`

```ts
export type MetadataSource = { id: string; label: string; find?(q: { text: string; kind?: Kind; year?: number }, call: Call): Promise<MetaHit[] | Outcome>; fromLink?(text: string, call: Call): Promise<MetaHit | undefined | Outcome>; enrich?(ids: Ids, call: Call): Promise<Enrichment | Outcome>; };
```

| Method | Limit | Outcome | Optional |
| --- | --- | --- | --- |
| `find` | 30 s | yes | yes |
| `fromLink` | 30 s | yes | yes |
| `enrich` | 60 s | yes | yes |

### `reelix:trends.source@1`

Kind: many. Contract: `TrendsSource`

```ts
export type TrendsSource = { id: string; label: string; trending(o: { kind: Kind | "all"; window: "day" | "week" }, call: Call): Promise<TrendHit[] | Outcome>; };
```

| Method | Limit | Outcome | Optional |
| --- | --- | --- | --- |
| `trending` | 30 s | yes | no |

### `reelix:translator@1`

Kind: one of several. Contract: `Translator`

```ts
export type Translator = { id: string; label: string; translate(job: TranslateJob, call: Call): Promise<TranslateResult | Outcome>; };
```

| Method | Limit | Outcome | Optional |
| --- | --- | --- | --- |
| `translate` | 1200 s | yes | no |

### Types used by seams

```ts
export type Call = { signal: AbortSignal; deadline: number; verification?: string; };
export type Outcome = | { outcome: "rate_limited"; until?: string } | { outcome: "needs_auth" } | { outcome: "needs_verification"; url: string } | { outcome: "unavailable"; message: string };
export type SubtitleQuery = { names: string[]; year?: number; ids: Ids; kind: Kind; series: boolean; season?: number; episodes?: number[]; languages: string[]; text?: string; videoHash?: string; };
export type SubtitleHit = { ref: string; name: string; languages: string[]; language?: string; formats?: string[]; season?: number; episode?: number; release?: string; hashMatch?: boolean; machine?: boolean; hearingImpaired?: boolean; date?: string; tags?: string[]; size?: string; downloads?: number; uploader?: string; ids?: Ids; };
export type Site = { id: string; name: string; private?: boolean };
export type IndexerQuery = { queries: string[]; kind?: Kind; ids?: Ids; season?: number; episode?: number; sites?: string[]; };
export type SiteResult = { site: string; ok: boolean; count: number; ms: number; outcome?: Outcome };
export type ChatOut = | { type: "text"; text: string } | { type: "card"; kind: string; text: string; image?: Uint8Array } | { type: "ask"; id: string; question: string; options: { id: string; label: string }[] } | { type: "working" };
export type AddOptions = { paused: boolean; mark: string; folder?: string };
export type AddResult = { id: string; duplicate: boolean };
export type Transfer = { id: string; name: string; state: "queued" | "checking" | "downloading" | "seeding" | "stopped" | "error"; hasMetadata: boolean; done: boolean; progress: number; size: number; left: number; folder: string; contentPath?: string; marks: string[]; addedAt: string; completedAt?: string; downSpeed?: number; upSpeed?: number; etaSeconds?: number; peersSending?: number; ratio?: number; seedingSeconds?: number; problem?: { kind: "tracker" | "local"; message: string }; };
export type TransferFile = { index: number; path: string; size: number; progress: number; wanted: boolean };
export type TransferChanges = { cursor: string; full: boolean; changed: Transfer[]; removed: string[]; };
export type ServerUser = { id: string; name: string; admin: boolean; active: boolean };
export type ServerLibrary = { id: string; name: string; paths: string[] };
export type ServerItemsQuery = { userId: string; kinds: ("movie" | "show")[]; filter?: "played" | "favourite"; sort?: "lastPlayed"; limit?: number; };
export type ServerItem = { id: string; kind: "movie" | "show"; name: string; year?: number; ids: Ids; plays?: number; episodesPlayed?: number; favourite?: boolean; lastPlayedAt?: string; };
export type ServerEpisode = { id: string; showId: string; season: number; episode: number };
export type PlayRequest = { ids: Ids; kind: Kind; series: boolean; season?: number; episode?: number; server?: { serverId: string; userId: string; itemId: string; publicUrl?: string }; };
export type PlayerLink = { url: string; autoplay: boolean };
export type Rating = { value: number; scale: number };
export type MetaHit = { ids: Ids; kind: Kind; name: string; names?: string[]; year?: number; series?: boolean; episodes?: number; rating?: Rating; note?: string };
export type Enrichment = { rating?: Rating; episodes?: { number: number; airDate?: string }[] };
export type TrendHit = { ids: Ids; kind: Kind; name: string; names?: string[]; year?: number; rating?: number };
```

## Hooks

Returning nothing means "no opinion". A result outside the limits is dropped and counted as a failure. Pipelines run built-in plugins first, then in order of installation.

### `agent.prompt@1`

Add a section to the prompt of a conversation, before Reelix's own rules. Background jobs get it only when the owner allows it for that plugin.

- Mode: **collect**
- Time limit: 10 s
- Limit: title: one line of at most 80 characters
- Limit: text: at most 1500 characters

```ts
{ input: { session: { kind: string; channel?: string } }; item: { title: string; text: string } }
```

### `release.filter@1`

Hide releases from a search. They stay in the result, marked with the plugin and its reason, and download.add refuses them unless the owner decides otherwise.

- Mode: **guard**
- Time limit: 10 s
- Limit: every ref is one of the releases received
- Limit: reason: 1 to 200 characters

```ts
{ input: HookReleases; item: { ref: string; reason: string }[] }
```

### `release.rank@1`

Set the order of the releases that are not hidden, with optional notes shown as facts. It cannot add or remove releases, and does not apply when the list is sorted by size or date.

- Mode: **pipeline**
- Time limit: 10 s
- Limit: order: every ref received, each exactly once
- Limit: notes: at most 200 characters each, for refs received
- Limit: reason: 1 to 200 characters

```ts
{ input: HookReleases; item: { order: string[]; notes?: { ref: string; note: string }[]; reason: string } }
```

### `organise.name@1`

Change where the files of a plan Reelix made will go, after the plan is made and before it is applied. Plans the agent writes are not passed through it.

- Mode: **pipeline**
- Time limit: 10 s
- Limit: inside the library
- Limit: the title folder stays as it is, with its [tmdbid-N] tag
- Limit: same folder depth
- Limit: same extension
- Limit: legal file names, no two items on one path
- Limit: reason: 1 to 200 characters

```ts
{ input: { title: HookTitle; items: OrganiseItem[] }; item: { items: { source: string; path: string }[]; reason: string } }
```

### `notify.before@1`

Change the wording or picture of a notice on its way to the owner's devices. It cannot suppress a notice or change its path, answers or kind; the notice then says who edited it. Questions asking for an approval are not passed through it.

- Mode: **pipeline**
- Time limit: 10 s
- Limit: title: 1 to 200 characters
- Limit: body: 1 to 4000 characters
- Limit: image: at most 5000000 bytes
- Limit: no other fields
- Limit: reason: 1 to 200 characters

```ts
{ input: Notice; item: { title?: string; body?: string; image?: Uint8Array; reason: string } }
```

### `download.before@1`

Refuse a download, with a reason, after Reelix's own checks and before the transfer starts. A magnet's files are known only once the downloader has loaded it; a refusal then removes it again.

- Mode: **guard**
- Time limit: 10 s
- Limit: reason: 1 to 200 characters

```ts
{ input: DownloadBefore; item: { reason: string } }
```

### `subtitle.pick@1`

Change the scores of the subtitle files in a downloaded archive, before Reelix picks the best for each video. It cannot add or remove files. Choosing which subtitle to download stays with the agent.

- Mode: **pipeline**
- Time limit: 10 s
- Limit: every name is one of the files received
- Limit: score: a finite number
- Limit: reason: 1 to 200 characters

```ts
{ input: SubtitlePick; item: { files: { name: string; score: number }[]; reason: string } }
```

### `agent.tool@1`

Block a tool call of the agent, with a reason the agent is told. It cannot change the input or the result, and it does not see the commands the agent runs in its shell. Reelix removes secrets from the reason after it. Not run in trial.

- Mode: **guard**
- Time limit: 10 s
- Limit: reason: 1 to 200 characters

```ts
{ input: AgentToolCall; item: { reason: string } }
```

### Types used by hooks

```ts
export type HookTitle = { id: string; name: string; kind: "movie" | "tv"; mediaClass: string; year?: number; tmdbId?: number };
export type ParsedFacts = { resolution?: string; source?: string; codec?: string; group?: string; season?: number; episodes?: number[] };
export type HookRelease = Omit<ReleaseHit, "ref"> & ParsedFacts & { ref: string; siteName: string };
export type HookReleases = { title?: HookTitle; releases: HookRelease[]; };
export type OrganiseItem = { source: string; path: string; kind: "video" | "subtitle" | "extra" | "audio" | "disc"; parsed: ParsedFacts };
export type ReleaseHit = { ref: string; title: string; site: string; size?: number; seeders?: number; peers?: number; infoHash?: string; publishedAt?: string; hasMagnet: boolean; downloadFactor?: number; uploadFactor?: number; minSeedSeconds?: number; minRatio?: number; attrs?: Record<string, string | number | boolean>; };
export type Notice = { inboxId: string; kind: string; title: string; body?: string; answer: { kind: "none" | "choice" | "text"; options: { id: string; label: string }[] }; image?: Uint8Array; path: string; urgent: boolean; badge: number; };
export type DownloadBefore = { release?: HookRelease; title?: HookTitle; options: { files: { path: string; size: number; wanted: boolean }[]; size: number; episodes: { season: number; episode: number }[]; }; };
export type SubtitlePick = { files: { name: string; languages: string[]; format: string; score: number }[] };
```

## Events

| Event | Payload | Meaning |
| --- | --- | --- |
| `config.changed` | `{ paths: string[] }` |  |
| `download.filed` | `{ hash?: string; titleId?: string; paths: string[]; via: "download" \| "organise" \| "adopt" }` | A file reached the library. `hash` is absent when no download was involved. |
| `session.ended` | `{ threadId: string; kind: SessionKind }` | An agent session was closed: its conversation was archived or reloaded, a job's a minute after its run. Whatever was held for it can go. |

## Seams and events plugins own

A plugin declares these in `reelix.owns` of its manifest; other plugins provide the seams and listen to the events, and must require the owner in `reelix.requires.plugins`. The contract is data: Reelix checks every answer against the method's `result` schema and every payload against the event's, and only the owner calls the seam (`ctx.seams.call`) and emits the event (`ctx.emit`). The owner's package exports the matching types. These are the ones of the plugins in this repository.

### Seam `release-tags:tagger@1`

Owner: `release-tags` (`plugins/examples/release-tags`); types: `reelix-plugin-release-tags/contract` (`plugins/examples/release-tags/src/contract.ts`). Reads tags from release names: one call per search, every release at once.

| Method | Limit | Result (JSON Schema) |
| --- | --- | --- |
| `tag` | 5 s | `{"type":"array","maxItems":500,"items":{"type":"object","required":["ref","tags"],"additionalProperties":false,"properties":{"ref":{"type":"string","minLength":1},"tags":{"type":"array","maxItems":10,"items":{"type":"string","minLength":1,"maxLength":40}}}}}` |

### Event `release-tags:tagged`

Owner: `release-tags`. A search found releases with tags: the title searched for, if any, and each tagged release with its tags.

Payload (JSON Schema): `{"type":"object","required":["releases"],"additionalProperties":false,"properties":{"title":{"type":"object","required":["id","name"],"properties":{"id":{"type":"string"},"name":{"type":"string"}}},"releases":{"type":"array","items":{"type":"object","required":["ref","name","tags"],"properties":{"ref":{"type":"string"},"name":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}}}}}}}`

## Settings form

The form is generated from the plugin's `config` schema. These annotations, written in a schema's options as `[SETTINGS.<name>]`, add what plain TypeBox cannot say. A manifest's `settings` names a JSON copy of the schema, so the form can be shown before the code is loaded.

| Name | Key | Meaning |
| --- | --- | --- |
| `optionsFrom` | `x-reelix-options-from` | On a string field: a choice whose options are the output of this operation of the plugin (short name), `{ value, label }[]`. |
| `showWhen` | `x-reelix-show-when` | On a field: show it only while the field `field` of the same object equals `equals`. |
| `buttons` | `x-reelix-buttons` | On the `config` object: buttons that run these operations of the plugin (short names), such as "test" or "link". |

## Context calls

| Call | Needs in the manifest | Signature | Meaning |
| --- | --- | --- | --- |
| `ctx.signal` |  | `AbortSignal` | Aborted when the plugin stops. |
| `ctx.job` | `uses.jobs` | `(job: { name: string; every?: `${number}m`; run(run: PluginJobRun): Promise<PluginJobResult> }): Promise<void>;` | Register a job. Its kind in the job list is `<plugin id>.<name>`. `every`: run it every so many minutes ("60m"). |
| `ctx.jobs.enqueue` |  | `(name: string, payload: Record<string, unknown>, options?: { dedupe?: string }): Promise<string>;` | Queue one run of this plugin's own job; returns the run id. |
| `ctx.operation` | `uses.operations` | `<S extends TSchema>(op: { name: string; summary: string; effect: Effect; agentMay?: boolean; input: S; run(input: Static<S>, call: OperationCall): Promise<unknown>; toText?(output: any): string; tool?: boolean; preview?(input: Static<S>): Promise<OperationPreview>; card?: string; recordInput?(input: Static<S>): unknown; recordOutput?(output: any): unknown; }): Promise<void>;` | Register the operation `<plugin id>.<name>`, listed in `uses.operations` by its short name. |
| `ctx.provide` | `uses.provides` | `<S extends SeamId \| PluginSeamId>(seam: S, provider: S extends SeamId ? SeamContracts[S] : PluginSeamProvider): Promise<void>;` | Become a provider of a seam listed in `uses.provides`: one of Reelix's, or one another plugin owns (its type comes from that plugin's package). |
| `ctx.seams.call` | `owns.seams` | `<R = unknown>(seam: PluginSeamId, method: string, args: unknown[]): Promise<SeamAnswer<R>[]>` |  |
| `ctx.emit` | `owns.events` | `(event: PluginEventId, payload: unknown): Promise<void>;` | Emit an event this plugin owns (`owns.events`); the payload is checked against its schema. Listeners cannot delay it. |
| `ctx.check` |  | `(name: string, run: (o: { quick: boolean }) => Promise<PluginCheckResult \| undefined>): Promise<void>;` | A check shown in Doctor. Returning nothing leaves it out of this run. |
| `ctx.card` |  | `(kind: string, layout: CardLayout): Promise<void>;` | A chat card kind for the results of this plugin's operations. |
| `ctx.propose` | `uses.inbox` | `(proposal: Proposal): Promise<ProposalOutcome>;` | Ask the owner to approve a list of operations (needs `uses.inbox`). Reelix writes the card from the steps' previews. A refusal rejects at once; otherwise it settles when the owner decides, the proposal expires, or a new one with the same key replaces it. It need not be awaited. |
| `ctx.hook` | `uses.hooks` | `<H extends HookId>(name: H, handler: (input: PluginHooks[H]["input"]) => PluginHooks[H]["item"] \| undefined \| Promise<PluginHooks[H]["item"] \| undefined>): Promise<void>;` | Take part in a hook listed in `uses.hooks`. A handler has 10 seconds. |
| `ctx.task` |  | `(name: string, run: (task: { signal: AbortSignal }) => Promise<void>): Promise<void>;` | A long-running loop, such as a chat app's long poll. If it ends it is started again after a growing delay; a throw also counts as a failure. |
| `ctx.on` | `uses.events` | `<E extends keyof PluginEvents \| PluginEventId>(event: E, listener: (payload: E extends keyof PluginEvents ? PluginEvents[E] : unknown) => void \| Promise<void>): Promise<void>;` | Listen to an event listed in `uses.events`: one of Reelix's, or one another plugin owns (its payload type comes from that plugin's package). |
| `ctx.kv.get` |  | `<T = unknown>(key: string): Promise<T \| undefined>;` |  |
| `ctx.kv.set` |  | `(key: string, value: unknown): Promise<void>;` |  |
| `ctx.kv.delete` |  | `(key: string): Promise<void>;` |  |
| `ctx.secret.get` | `uses.secrets` | `(name: string): Promise<string \| undefined>;` |  |
| `ctx.secret.set` | `uses.secrets` | `(name: string, value: string): Promise<void>;` | For values the plugin obtains itself (a generated key). Does not restart the plugin. |
| `ctx.http.fetch` | `uses.network` | `(url: string, init?: PluginFetchInit): Promise<PluginFetchResponse>` |  |
| `ctx.agent.run` | `uses.agent` | `(turn: { prompt: string; title?: string }): Promise<PluginAgentOutcome>` |  |
| `ctx.model.complete` | `uses.model` | `(request: ModelRequest): Promise<ModelAnswer \| Outcome>` |  |
| `ctx.pi` | `uses.pi` | `(extension: PiExtension): Promise<void>;` | A raw pi extension (`uses.pi`, docs/plugins.md §10.4), loaded into every agent session from now on. Its tools must be named `<id>_<name>`; one that collides with a Reelix tool or another plugin's is refused. Reelix's own redaction and marking of outside text run after every plugin's handlers. |
| `ctx.route` |  | `(method: "GET" \| "POST", path: string, handler: (request: RouteRequest) => Promise<RouteResponse>): Promise<void>;` | HTTP under `/api/plugins/<id>/<path>`, behind the owner's sign-in. `path` may hold `:name` parts, given in `params`. |
| `ctx.folder` |  | `(): Promise<string>;` | The plugin's own folder for larger files (`<data>/plugin-data/<id>`): kept while it is off, deleted with its data at uninstall. |
| `ctx.inbox.add` | `uses.inbox` | `(item: { title: string; body?: string; key?: string }): Promise<{ added: boolean }>;` |  |
| `ctx.inbox.answer` |  | `(inboxId: string, answer: { optionId: string; sender: string }): Promise<ChatReceipt>;` | The owner pressed a button on a notice in this plugin's chat app. Only the sender paired with one of its channels counts. |
| `ctx.owner.pair` |  | `(): Promise<{ code: string; expiresAt: string }>;` | A one-time code for the owner to send from the chat app. Refused while every channel of the plugin has its owner. |
| `ctx.owner.of` |  | `(channel: string): Promise<string \| undefined>;` | The sender paired with a channel of this plugin: whom to send to. |
| `ctx.chat.receive` |  | `(message: ChatIncoming): Promise<ChatReceipt>;` | Hand over one incoming message. Anything not from the channel's owner stops here. |
| `ctx.reelix.run` | `uses.runs` | `<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T>;` | Run a core operation listed in `uses.runs`; recorded under `plugin:<id>`. |
| `ctx.reelix.read.titles` |  | `(): Promise<{ withTmdb: number }>;` |  |
| `ctx.reelix.read.services` |  | `(): Promise<{ metadataLocale: string; tmdbKey: boolean }>;` | State of services. Never contains a secret value. |
| `ctx.reelix.read.freeSpace` |  | `(): Promise<{ bytes?: number }>;` | Bytes free at the download folder; absent when unknown. |
| `ctx.reelix.read.title` |  | `(id: string): Promise<{ id: string; name: string; series: boolean } \| undefined>;` |  |
| `ctx.reelix.read.download` |  | `(hash: string): Promise<{ name: string; titleId?: string; seasons: number[] } \| undefined>;` |  |
| `ctx.reelix.read.downloads` |  | `(): Promise<DownloadRecord[]>;` | Every download Reelix is looking after. |
| `ctx.reelix.read.missingSubtitles` |  | `(titleId: string, seasons: number[]): Promise<MissingSubtitles>;` |  |
| `ctx.reelix.read.preferences` |  | `(): Promise<string>;` | The owner's preferences note. |
| `ctx.reelix.read.answer` |  | `(inboxId: string): Promise<{ status: "open" \| "answered" \| "dismissed"; answer?: string } \| undefined>;` | An Inbox item's state and the owner's answer, for a question asked with `notify` that a tool waits on. |
| `ctx.reelix.read.proxy` |  | `(): Promise<{ url?: string }>;` | The owner's proxy for this plugin (its id in the proxy settings), for a program the plugin starts itself; `ctx.http.fetch` uses it already. |
| `ctx.log` |  | `(message: string): void;` |  |
| `ctx.t` |  | `(key: string, vars?: Record<string, unknown>): string;` | A string from the plugin's `locales/<lang>.json`, in the owner's language. |

### Types used by context calls

```ts
export type PluginSeamId = `${string}:${string}@${number}`;
export type PluginEventId = `${string}:${string}`;
export type PluginSeamProvider = { id: string; label: string };
export type SeamAnswer<R = unknown> = { provider: string; label: string; plugin: string; result?: R; error?: string };
export type OperationPreview = { text: string; target: unknown; counts?: Partial<Record<"downloads" | "titles" | "files" | "bytes", number>> };
export type CardLayout = | { layout: "list"; title: string; items: string; primary: string; secondary?: string; empty?: string; buttons?: CardButton[] } | { layout: "text"; title: string; text: string; buttons?: CardButton[] };
export type CardButton = { label: string; operation: string; input?: Record<string, unknown> };
export type Proposal = { key: string; title: string; why: string; steps: ProposalStep[]; expiresAt?: string; };
export type ProposalStep = { operation: string; input: Record<string, unknown> };
export type ProposalOutcome = { id: string; status: "approved" | "declined" | "expired" | "replaced" | "dropped"; steps: ProposalStepResult[] };
export type ProposalStepResult = { operation: string; status: "succeeded" | "failed" | "skipped" | "not_approved" | "declined" | "expired"; text?: string };
export type DownloadRecord = { hash: string; name: string; titleId?: string; state: string; sizeBytes?: number; addedAt: string; completedAt?: string; filedAt?: string; };
export type SettingOption = { value: string; label: string };
```

## Runtimes

`runtime`: Where its code runs by default: inside Reelix, or in a process of its own that receives only its context and cannot read Reelix's files (docs/plugins.md §11.7). The owner can choose either for a plugin that has no raw pi extension (`uses.pi`) and no compiled dependencies (`uses.native`).

In a process of its own, the plugin is started with Node's permission model, enforced by Node, not by the operating system: it may read only its own folder (with its own `node_modules`), `@reelix/plugin` and the few files of Reelix and its packages the process runs, and write only its own data folder (`ctx.folder()`); its working folder is `/`; it cannot start programs or workers or load compiled addons; its environment holds none of Reelix's variables. Node 22's permission model does not cover the network, signals or `node:sqlite`, so Reelix's code in the process allows only these of Node's modules: `assert`, `assert/strict`, `buffer`, `console`, `crypto`, `events`, `fs`, `fs/promises`, `path`, `path/posix`, `path/win32`, `perf_hooks`, `process`, `querystring`, `stream`, `stream/consumers`, `stream/promises`, `stream/web`, `string_decoder`, `timers`, `timers/promises`, `url`, `util`, `util/types`, `zlib`; refuses module hooks of the plugin's own and signals to other processes; and removes Node's own `fetch`, `WebSocket` and `EventSource`. That part is Reelix's code inside the process, not a guarantee of the operating system: a determined plugin may find a way past it (docs/plugins.md §11.7). The network is `ctx.http.fetch`, which Reelix runs with its rules. Everything crosses as plain data, at most 80 MB in one message from the plugin; an ended process is a failure and starts again after a growing delay.

Plugins in this repository that run in a process of their own by default: `jackett`.

## Screens

`screen`: One screen of its own, shown under Plugins in a sandboxed frame: `entry` is an HTML file in its folder (the scripts and style sheets it names from its own folder are put inline), `title` its English name (`screen.title` in its locales for the others). The screen talks to Reelix only through `window.reelix` (docs/plugin-guide.md).

The frame is `<iframe sandbox="allow-scripts">` with the document as `srcdoc`: no origin of its own, so no cookies, no storage of Reelix's, no calls to `/api` with the owner's session, no forms, pop-ups or navigation of the page around it. Reelix puts this Content-Security-Policy before anything the plugin wrote: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`.

`window.reelix`: `run(operation, input)` runs one of the plugin's own operations (as the plugin) and resolves with `{ output, text }`; `lang`, `theme`, `scheme` and `onContext(fn)` follow the owner's language and theme tokens, which are also set as CSS variables (`--bg`, `--fg`, `--primary`, …). It says `ready` to the page once; the page answers with a message port, and everything after goes over that port. A document the frame navigates to later never has the port (docs/plugins.md §16, phase 8).

Plugins in this repository with a screen: `finished-cleanup` (Finished downloads).
