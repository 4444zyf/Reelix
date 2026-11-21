# Plugins

Date: 2026-11-18
Status: **design agreed by the owner's instruction to build it (2026-11-19); being implemented phase by phase, see §21.** It records the interview of 2026-11-18 (questions Q1 to Q46) and adds to it. It was reviewed three times before the owner saw it (against the code, against the 46 decisions, and from a contributor's and an attacker's side) and rewritten with the findings.

- §18 lists everything that goes beyond the interview and every place where an agreed answer changed. The larger additions are also marked **[new]** where they appear.
- §19 lists the decisions the owner still has to make.
- §20 maps each interview question to the section that records it.
- Background on the systems studied: [plugins-study.md](plugins-study.md).

## 1. Purpose and principles

The owner wants others to be able to join the development. A plugin system lets them join without understanding, or being trusted with, the whole of Reelix.

Who it serves, in order (Q1): people adding a service Reelix does not support; people changing how Reelix decides; later, people adding whole features with their own screens.

Principles:

1. **One definition, every surface.** A plugin's main building block is a Reelix *operation*: defined once, it is an agent tool, a CLI command, an HTTP call and a ledger record (Q4).
2. **The runtime owns cleanup.** Everything a plugin registers goes through a context bound to that plugin and is undone when the plugin stops (Q3). The idea is taken from Cordis; Reelix does not depend on Cordis.
3. **Named contracts, not internals.** Plugins reach Reelix through seams, hooks, events and operations, never by importing its internals (Q5).
4. **No private path.** Reelix's own outside-facing features are plugins on the same API (Q6). §3 says exactly what stays in the core.
5. **Fail loudly and locally.** A broken plugin says why in Settings and never stops downloads or the agent (Q15).
6. **Honest about trust.** In-process code can do anything Reelix can. The owner decides what runs (Q2). §11 says which protections are real and which only prevent mistakes.
7. **Built for a long life.** Plugins exchange only plain data with Reelix, and each manifest lists what the plugin uses. Because of this, a plugin can later run in its own process with no change to its code (Q45, Q46).
8. **Explainable.** Every decision a plugin takes part in carries a reason the owner can read.
9. **No dead code.** See §2.

### Terms

| Term | Meaning |
| --- | --- |
| Operation | A named action of Reelix with a typed input, such as `download.add`. Runs from the agent, the CLI, the web UI or a plugin. |
| Ledger | The record of every operation that changed something: who ran it, with what, and how it ended. Shown in Activity. |
| Actor | Who ran an operation: `owner:web`, `agent:<thread>`, `job:<run>`, `plugin:<id>`. |
| Seam | A named contract for one kind of outside service (an indexer, a downloader). Code that fulfils it is a *provider*. |
| Hook | A named step where plugins take part in a decision before it is made. |
| Event | A notice that something has happened. Cannot change anything. |
| Context | The object a plugin receives (`ctx`). The only way a plugin touches Reelix. |
| Scope | Everything one plugin registered through its context. Disposing the scope undoes it all. |
| Conformance suite | A set of tests any provider of a seam must pass. |
| pi | The agent library Reelix embeds. A *pi extension* is code that changes the agent itself. |
| Typed tool | An operation the agent sees as its own tool with named inputs. The other operations are reached through one generic tool called `reelix`. |
| Handle | Reelix's stored record of one search result (a release). The agent sees the handle, never the link. |
| Quick accept | A rule on a follow: when a new release matches the owner's pattern, download it without asking. |
| Inbox | Where Reelix puts questions and notices for the owner. |
| Doctor | Reelix's self-check of its settings and services. |
| Magpie | The separate model gateway Reelix can manage (see `magpie.md`). |
| Review gate | The stop after phase 2 where the owner reviews the plugin API before it is declared stable. |

## 2. No dead code

A hard restriction, set by the owner on 2026-11-18 and recorded project-wide in `CLAUDE.md`.

- When built-in code moves onto the plugin API, the old path is deleted in the same change.
- No compatibility shims, no re-exports kept "for now", never two generations of the plugin API in the code.
- **Every extension point is built together with its first user.** A context call, seam, hook or event enters the code in the same change as code that uses it. The user is either a built-in plugin or a *reference plugin*: a small plugin in `plugins/examples/`, tested by `npm test`, shipped switched off, and used as a recipe in the guide. §16 names the first user of everything.
- This document may *reserve a name* for a later phase. A reserved name has no code. Reserved names are listed in §16.
- Each phase ends with a check for what it orphaned.

## 3. Core and plugins

"Everything is a plugin" is not the goal; DeepSeek Harness went that way and needs about 400 packages. The line is:

**Core** is the engine: titles and the library, the download and filing engine, naming and organising, searching for releases and subtitles, following, translating, the ledger, jobs, the Inbox, the agent host, settings, and the plugin kernel. The operations of the engine (`title.*`, `release.*`, `download.*`, `subtitle.*`, `follow.*`, `organise`, and the rest, such as `library.*`, `adopt.*`, `anime.*`, `inbox.*`, `config.*`, `magpie.*`) stay in core under their present names. Core talks to three outside things only, and they are not replaceable in `api: 1`: the owner's models, the TMDB catalogue (§7.6), and Magpie.

**Plugins** are everything else that talks to an outside service, and automations that react to Reelix's events with a policy of their own.

A plugin id may not equal the first word of a core operation, so a plugin can never be mistaken for the engine.

Built-in plugins (in `plugins/` of this repository, shipped in the Docker image, switched on by default, Q21). All can be switched off (Q41).

| Plugin id | Is today | Registers | Its own operations | Phase |
| --- | --- | --- | --- | --- |
| `metadata-refresh` | `plugins/metadata-refresh` (was `server/metadata.ts`) | A job that re-reads titles when the language changes | none (runs core's `title.refresh_metadata`) | 1 |
| `subtitle-sites` | the six sites in `subtitles/` | Six `subtitle.source` providers | none | 2 |
| `auto-subtitles` | `server/subtitles.ts` | A job after filing that asks the agent to fetch subtitles | none | 2 |
| `jackett` | `clients/jackett.ts` | `indexer` | `jackett.indexers` | 2 |
| `push` | `core/push.ts` | `notifier` | `push.devices`, `push.subscribe`, `push.unsubscribe`, `push.test` | 2 |
| `telegram` | `clients/telegram.ts`, `server/telegram.ts` | `notifier` and `chat.channel`; an `agent.prompt` section for its conversation | `telegram.link`, `telegram.test`, `telegram.status` | 2 |
| `bangumi`, `douban` | `clients/bangumi.ts`, the Douban page reader | `metadata.source`; `bangumi` also `trends.source` | `douban.rating` (was a core operation); `bangumi` none | 6 |
| `qbittorrent` | `clients/qbittorrent.ts` | `downloader` | `qbittorrent.prefs`, `.set_prefs`, `.torrents` (today `qb.*`) | 6 |
| `jellyfin` | `clients/jellyfin.ts` | `media.server` | `jellyfin.refresh` | 6 |
| `model-translator` | the chunk step in `subtitles/translate.ts` | `translator` | none | 6 |
| `players` | link builders in `playback.ts` | `player` (Infuse, Swiftfin, Jellyfin web) | none | 6 |
| `browser` | `server/browser.ts` | The agent's browser tools and live view | none (its ten tools go through the raw pi extension) | 6 |

What changes relative to Q6 (§18, change C5):

- Q6 named five subsystems to move first. Two of them, **follows and translation, are engine and stay in core**: they talk to no outside service. Their wiring files (`server/follows.ts`, `server/translation.ts`) become plain engine code started from `main.ts`; they stay in the server package because they need its job runner and agent host.
- `browser` moves last, because it needs tools that live inside an agent session, which arrive with raw pi extensions.
- **The `Subsystem` mechanism is deleted in phase 2**, when the metadata and subtitle wiring have moved into plugins and the other two are core. Until `browser` moves in phase 6 it is plain core code wired in `main.ts`, not a second plugin mechanism.

The web UI reaches a plugin only through its operations. `push`'s four HTTP routes and Telegram's one become operations.

## 4. What a contributor can make

| Kind | Contains | Runs where | Phase |
| --- | --- | --- | --- |
| **Plugin** | A TypeScript or JavaScript module, no build step (Q8) | Inside Reelix | 1 |
| **Skill pack** | `SKILL.md` files, optional scripts that call the `reelix` CLI (Q7) | Text is read by the agent; scripts run in the agent's shell | 4 |
| **Plugin with a raw pi extension** | A plugin plus a pi extension factory (Q30). Labelled *advanced*. | Inside the agent session | 6 |
| **Declarative provider** | A data file describing a service for a seam | Interpreted by Reelix | reserved |

A package may mix kinds. A plugin package is also a valid pi package, so its skills use pi's folder layout. `skills/subtitles` stays a core skill: it describes core operations, and the agent needs it in chat when `auto-subtitles` is off. A plugin's own skills and skill packs both arrive in phase 4.

**[new] Declarative providers** (a webhook notifier or an indexer described in a data file, with no code from the author) are the cheapest contribution after a skill pack. They are reserved: the file format is written when the first one is built, against a real service.

**[new] Setup skill.** A plugin may ship `skills/setup-<id>/SKILL.md`. When the owner switches the plugin on, the agent offers to walk them through its settings in chat. For a secret the agent shows the existing secret field; the value never enters the conversation. Phase 4.

## 5. Anatomy

### 5.1 Manifest

In `package.json`:

```json
{
  "name": "reelix-plugin-podnapisi",
  "version": "1.2.0",
  "license": "MIT",
  "keywords": ["reelix-plugin"],
  "engines": { "reelix": ">=0.4 <1" },
  "peerDependencies": { "@reelix/plugin": "*" },
  "reelix": {
    "api": 1,
    "id": "podnapisi",
    "entry": "./src/index.ts",
    "runtime": "in-process",
    "requires": { "seams": [] },
    "uses": {
      "provides": ["reelix:subtitle.source@1"],
      "hooks": [],
      "events": [],
      "operations": {},
      "tools": [],
      "jobs": [],
      "routes": false,
      "network": ["www.podnapisi.net", "*.podnapisi.net"],
      "secrets": ["api_key"],
      "runs": [],
      "skills": false,
      "agent": false,
      "inbox": false,
      "model": false,
      "pi": false,
      "native": false
    }
  }
}
```

- `id`: short lowercase name, unique in an installation, never a built-in's id or the first word of a core operation (§3). It comes from the manifest, not from a folder or class name. The package name `reelix-plugin-<id>` is a convention only (Q34).
- `api`: a whole number covering the manifest and the context. Before the review gate (§16) it is `0` and may change freely; the gate declares `1` (Q26). Seams and hooks carry their own versions (§13.4).
- `runtime`: `in-process` or `process` (§11.7); the loader refuses anything else (Q37). `process` is refused for a plugin with `uses.pi` or `uses.native`. The owner can choose either for any other plugin; the manifest's value is the default.
- `uses`: everything that gives the plugin reach or adds to what the agent and the owner see: what it provides, hooks (`release.rank@1`), events, its operations (each with its effect: `{ "scan": "read" }`, so the install screen can show effects before any code runs) and typed tools, jobs, routes, network, secrets, core operations it runs (`runs`), skills, background agent turns (`agent`), Inbox items and proposals (`inbox`), the model, a raw pi extension (`pi`), compiled dependencies (`native`). A registration that is not declared is refused at activation. A declaration that is never registered is a warning from the checker (Q46). Tasks, Doctor checks and cards need no declaration: they add no reach.
  - `network` entries are a host, a wildcard such as `*.example.com`, `config:<field>` (the host of a URL the owner typed into that settings field), or `*` (any public host) (§11.4).
  - `runs` lists the core operations the plugin calls through `ctx.reelix.run`.
- Unknown keys are ignored without error, so a newer manifest loads on an older Reelix that satisfies `engines` (Q44).
- A skill pack has `id` and `api` and no `entry`.

### 5.2 Entry

```ts
import { definePlugin, Type } from "@reelix/plugin";

export default definePlugin({
	config: Type.Object({
		languages: Type.Array(Type.String(), { default: ["en"] }),
	}),
	async activate(ctx, config) {
		await ctx.provide("reelix:subtitle.source@1", {
			id: "podnapisi",
			label: "Podnapisi",
			kinds: ["movie", "show"],
			languages: config.languages,
			search: (query, call) => search(ctx, query, call.signal),
			download: (ref, call) => download(ctx, ref, call.signal),
		});
	},
});
```

- `activate` is the only required member. There are no empty stubs to write.
- The entry file has exactly one export, the default. The loader refuses anything else, so it never has to guess which export is the plugin.
- State lives in variables inside `activate` (that is the scope) or in the key-value store. Never in module-level variables, which would survive a restart of the plugin.

### 5.3 Lifecycle

States: `active`, `waiting` (a requirement is missing; the state says which), `failed` (with the error), `disabled`. Phase 4 adds the states of installed plugins: `installed` (not yet approved), `incompatible`, `changed` (§13.3, §13.4).

- **Switching on, switching off, and changing settings or a secret are live** (Q16): the scope is disposed, then `activate` runs again. `activate` is never called twice on one scope.
- **What "live" means for the agent:** tools, skills and prompt text are fixed when a conversation loads. A change reaches a conversation the next time it loads; running conversations keep what they had.
- **Installing or updating code needs a restart** (Q16).
- **Disposal** has three steps. First, `ctx.signal` is aborted. Second, calls still running in the plugin get 10 seconds to end; after that Reelix stops waiting for them. Third, the undo steps run one at a time, newest first; an error in one does not stop the others. During all this, new registrations are refused. A download already handed to a downloader is not affected.
- **[new] Management results.** Every management action (install, switch on, configure, update) returns `applied` or `failed`, with a `next` sentence saying what to do. A third result, `saved-restart-needed`, enters in phase 4 with installing and updating code. Settings and the agent read the same result.

## 6. The plugin context

**The plain-data rule** (Q45). A plugin passes functions to Reelix only as *handlers*, registered under a name. Everything a handler receives and returns is plain data: JSON values and bytes. Errors are plain too: a code, a message and optional data. The cancellation signal a handler receives is built by the SDK on the plugin's side, so it works the same in another process. Calls on `ctx` return promises, except `ctx.log` and `ctx.t`. The one exception to the whole rule is the raw pi extension (§10.4), which can only ever run in-process.

What a plugin **registers** (each is undone automatically):

| Call | Purpose | Phase |
| --- | --- | --- |
| `ctx.job({ name, run, every? })` | A queued or repeating job in the existing job runner. `every` enters in phase 2 with its first user; a `daily` option is reserved. A schedule survives restarts of the plugin and of Reelix, and queued runs wait while the plugin restarts; switching the plugin off ends both. | 1 |
| `ctx.on(event, fn)` | Listen to an event (§9) | 1 |
| `ctx.operation({...})` | An operation `<id>.<name>` (§6.1) | 2 |
| `ctx.provide(seam, impl)` | Become a provider for a seam (§7) | 2 |
| `ctx.hook(name, fn)` | Take part in a decision (§8) | 2 |
| `ctx.task(name, fn)` | A long-running loop (a chat app's long poll), restarted with a growing delay if it ends | 2 |
| `ctx.check(name, fn)` | A check shown in Doctor | 2 |
| `ctx.card(kind, layout)` | A chat card (§12.3) | 3 |
| `ctx.route(method, path, fn)` | HTTP under `/api/plugins/<id>/`, behind sign-in, including a live stream | 6 |
| `ctx.webhook(name, fn)` | An incoming call from outside (§11.5) | reserved |
| `ctx.pi(factory)` | A raw pi extension (§10.4) | 6 |

What a plugin **calls**:

| Call | Purpose | Phase |
| --- | --- | --- |
| `ctx.reelix.run(operation, input)` | Run a core operation, recorded under `plugin:<id>` (§11.2) | 1 |
| `ctx.reelix.read.*` | Read titles, the library, downloads, the owner's notes and the state of services, as stable records | 1 |
| `ctx.jobs.enqueue(name, payload, { dedupe? })` | Queue one run of the plugin's own job | 1 |
| `ctx.kv.get/set/delete` | The plugin's own small store (Q17) | 1 |
| `ctx.log`, `ctx.t(key, vars)` | Logging; the plugin's strings | 1 |
| `ctx.signal` | A signal aborted when the plugin stops | 2 |
| `ctx.secret.get(name)`, `ctx.secret.set(name, value)` | Its declared secrets. `set` is for values the plugin obtains itself: a rotating login cookie, a generated key. | 2 |
| `ctx.http.fetch(url, init)` | Reelix's fetch (§11.4) | 2 |
| `ctx.agent.run({ prompt, title })` | Inside a job: one background agent turn (§10.5) | 2 |
| `ctx.model.complete({ role, system, user })` | The owner's model, metered (§10.2) | 6 |
| `ctx.inbox.add(item)` | Put a notice or a question in the Inbox; the dispatcher (§7.3) sends it on | 2 |
| `ctx.owner.pair()`, `ctx.owner.of(channel)`, `ctx.inbox.answer(...)`, `ctx.chat.receive(...)` | For chat apps (§7.4) | 2 |
| `ctx.propose(proposal)` | Ask the owner to approve a list of operations (§10.3) | 3 |

A folder of the plugin's own for larger files is `ctx.folder()` (`<data>/plugin-data/<id>`), first used by `browser` for its Chromium profile (phase 6).

Deliberately absent: the database, the `Reelix` object, the HTTP server, other plugins' settings, and direct access to another provider (plugins use operations, so the ledger and every hook still apply).

Strings: English is required; zh, fr and ru are optional and fall back to English. Built-in plugins keep all four (Q32).

### 6.1 Operations

`ctx.operation` takes what core operations take today: `name`, `summary`, `description`, `effect`, `input` (a TypeBox schema), `run`, and optionally `toText`, `positional`, `titleOf`, `reconcile`. `preview` is new and enters in phase 3 with proposals, for core operations too.

- The full name is `<id>.<name>`. A typed agent tool is `<id>_<name>`; it must be listed in `uses.tools` (Q34).
- A plugin gets at most three typed tools; the rest of its operations are reached through the generic `reelix` tool. The owner can switch a plugin's typed tools off (Q13). A fourth is refused at activation. First user: the reference plugin `finished-cleanup` (phase 3), whose `scan` operation is the typed tool `finished-cleanup_scan`. `uses.tools`, the limit and the switch have no code before that. `browser`, which has ten session tools today, registers them through its raw pi extension, where this limit does not apply.
- `effect` is `read`, `write`, `destructive` or `admin` (§11.2). A plugin states the effect of its own operations; the install screen lists them. This is a claim by the author, not a control.
- `preview(input)` returns, as plain data, what the operation would do. Proposals need it (§10.3).
- **The CLI** reads the list of operations from the running server, so plugin operations appear in `reelix help` and can be run like any other. When no server is running the CLI still runs core operations itself, as today, but plugin operations and anything that needs a provider are unavailable and say so (§18, change C13).

## 7. Seams

A seam is a contract with an owner and a version, such as `reelix:indexer@1` (Q36). It has one of two kinds (Q10):

- **many**: every provider that is switched on is used, and Reelix merges results under a stated rule.
- **one of several**: several may be installed; the owner picks the active one in Settings. Only the owner can change that choice. If the active provider fails, operations that need it fail with a clear error; Reelix does not switch by itself.

One plugin registers one provider per entry in its settings list: two Jackett servers are two providers from the same plugin. Plugins are never cloned (Q35). Provider ids are unique within a seam (Telegram is both the notifier `telegram` and the chat channel `telegram`), and the label of a third-party provider is always shown with its plugin's id.

**Rules for every seam method:**

- It receives a second argument `call` with `signal` (cancellation; it also fires when the plugin stops) and `deadline` (when Reelix stops waiting, so that a provider with several steps can plan its time; `jackett` stops starting searches at it).
- Each contract sets its own time limit per method; 60 seconds is the default (Q38).
- It returns a result or a **typed outcome**: `rate_limited { until }`, `needs_auth`, `needs_verification { url }`, `unavailable { message }`. Outside services often answer this way; it is expected, not an error. Outcomes are shown to the owner and the agent and are *not* failures (§11.6). Where a method's type does not list `Outcome`, the provider throws the SDK's `OutcomeError` to the same effect. `OutcomeError` enters in phase 6 with `downloader`.
- After the owner has passed a human check at the `url`, Reelix calls the method again with the result in `call.verification`.

**[new] A seam is three things**, kept together:

1. the contract (types), in `@reelix/plugin`;
2. a conformance suite, which checks any provider against the contract's rules using answers the provider's author recorded from the real service;
3. a status (Q22). A seam is `provisional` until its built-in provider runs through it with tests. After that it is `stable`, unless a second real service exists for it (Transmission for `downloader`, for example). In that case it stays `provisional` until a provider for the second service also passes. If the contract cannot describe both services, the contract is wrong and is fixed. §16 schedules no second providers yet.

Fakes of particular services (the fake Jackett, the fake qBittorrent) belong to the plugin for that service once that plugin exists, and are what `reelix plugin dev` runs against (§14). Until phase 6 the qBittorrent, Jellyfin and TMDB fakes stay in core's tests.

| Seam | Kind | First provider | Merge rule | Phase |
| --- | --- | --- | --- | --- |
| `subtitle.source` | many | `subtitle-sites` | Source order from settings; duplicates removed per source | 2 |
| `indexer` | many | `jackett` | Duplicates removed by info-hash, else by name and size, keeping the best seeded | 2 |
| `notifier` | many | `push`, `telegram` | Every provider is sent each notice | 2 |
| `chat.channel` | many | `telegram` | Each channel is its own conversation | 2 |
| `downloader` | one of several | `qbittorrent` | — | 6 |
| `media.server` | one of several | `jellyfin` | — | 6 |
| `metadata.source` | many | `bangumi`, `douban` | Fields merged; TMDB wins on conflict | 6 |
| `translator` | one of several | `model-translator` | — | 6 |
| `player` | many | `players` | Links in the order of the owner's player list | 6 |
| `trends.source` | many | `bangumi` | Added to core's TMDB lists; duplicates removed by title id | 6 |

All ten are specified below (Q11). The four of phase 2 were checked against today's code. **The six seams of phase 6 are drafts.** Each will be checked again, against the code and against a second real service, before it is built; the review found the first sketches of the hardest ones wrong in detail.

Shared types:

```ts
type Kind = "movie" | "show" | "anime";
type Ids = { tmdb?: number; imdb?: string; tvdb?: number; bangumi?: number; douban?: string };
type Call = { signal: AbortSignal; deadline: number; verification?: string };
type Outcome =
	| { outcome: "rate_limited"; until?: string }
	| { outcome: "needs_auth" }
	| { outcome: "needs_verification"; url: string }
	| { outcome: "unavailable"; message: string };
```

### 7.1 `reelix:subtitle.source@1`

```ts
type SubtitleSource = {
	id: string;
	label: string;
	kinds: Kind[];
	languages: string[];
	needsSecrets?: string[];    // declared secrets it cannot work without; while one is missing it is not asked
	search(q: SubtitleQuery, call: Call): Promise<SubtitleHit[] | Outcome>;
	files?(ref: string, call: Call): Promise<{ name: string; size?: number }[] | Outcome>;
	download(ref: string, call: Call): Promise<{ bytes: Uint8Array; filename: string } | Outcome>;
};
type SubtitleQuery = {
	names: string[];            // every known name of the title
	year?: number;
	ids: Ids;
	kind: Kind;
	series: boolean;            // has seasons and episodes (an anime can be either)
	season?: number;
	episodes?: number[];
	languages: string[];
	text?: string;              // the agent's own search words, when it overrides
	videoHash?: string;
};
type SubtitleHit = {
	ref: string;                // the provider's own; Reelix stores it as "<provider id>:<ref>"
	name: string;
	languages: string[];        // as the site words them (简体, 双语, en)
	language?: string;          // ISO 639-1 code, when the site states one
	formats?: string[];
	season?: number;
	episode?: number;
	release?: string;
	hashMatch?: boolean;
	machine?: boolean;
	hearingImpaired?: boolean;
	date?: string;
	tags?: string[];            // what the site says about it: 官方字幕, trusted, season pack
	size?: string;
	downloads?: number;
	uploader?: string;
	ids?: Ids;                  // an id the site revealed, e.g. Douban; Reelix records it on the title
};
```

`download` may return an archive; Reelix unpacks it. Today this is already a registry (`subtitles/providers.ts`); the branch `p.id === "subhd"` in `pipeline.ts` moves into that provider, and the site's daily limit and human check become outcomes.

### 7.2 `reelix:indexer@1`

```ts
type Indexer = {
	id: string;
	label: string;
	kinds: Kind[];
	sites(call: Call): Promise<Site[] | Outcome>;
	search(q: IndexerQuery, call: Call): Promise<{ hits: ReleaseHit[]; sites: SiteResult[] }>;
	fetch(ref: string, call: Call): Promise<{ torrent?: Uint8Array; magnet?: string } | Outcome>;
};
type Site = { id: string; name: string; private?: boolean };
type IndexerQuery = { queries: string[]; kind?: Kind; ids?: Ids; season?: number; episode?: number; sites?: string[] };
type SiteResult = { site: string; ok: boolean; count: number; ms: number; outcome?: Outcome };
type ReleaseHit = {
	ref: string;
	title: string;
	site: string;               // a Site id
	size?: number;
	seeders?: number;
	peers?: number;
	infoHash?: string;
	publishedAt?: string;
	hasMagnet: boolean;
	downloadFactor?: number;    // 0 = freeleech
	uploadFactor?: number;
	minSeedSeconds?: number;
	minRatio?: number;
	attrs?: Record<string, string | number | boolean>;
};
```

- `search` has a limit of 30 seconds *per site* and returns what it has: a slow site appears in `sites` as failed and the other sites' hits survive, as today.
- A health test is `search` with a test query; Doctor's indexer check moves into the `jackett` plugin as a `ctx.check`.
- Around the provider Reelix keeps what it does today: parsing names, removing duplicates, saving handles, never showing links or magnets to the model. A handle records its provider, which it does not today.

### 7.3 `reelix:notifier@1`

```ts
type Notifier = {
	id: string;
	label: string;
	can: { images: boolean; update: boolean; answers: boolean };   // answers: it can bring the owner's answer back
	send(n: Notice, call: Call): Promise<{ ref?: string } | Outcome>;
	update?(ref: string, n: Notice, closed: { status: string; answer?: string }, call: Call): Promise<void | Outcome>;
};
type Notice = {
	inboxId: string;
	kind: string;
	title: string;
	body?: string;
	answer: { kind: "none" | "choice" | "text"; options: { id: string; label: string }[] };
	image?: Uint8Array;
	path: string;               // the item's path inside Reelix; the provider adds its own address
	urgent: boolean;            // a choice is waiting, or the item was marked urgent: deliver with priority where the service can
	badge: number;
};
```

Today Telegram and Web Push each listen to the Inbox on their own and each decide what to send. They are replaced by one **dispatcher** in core:

- It applies today's rule once: a notice is sent when the owner must act or it is marked urgent.
- It runs the `notify.before` hook, calls every provider, and retries a failed send once after 30 seconds (the retry moves out of `push.ts`).
- It records each delivery per provider in a table that replaces `inbox.telegram_message_id`.
- A provider without `can.answers` receives the notice with `answer.kind` "none". `push` turns `urgent` into the Web Push urgency.
- When a notifier's plugin comes up, the notifier is sent what it missed: the newest five open items that need the owner, at most three days old, that it has no delivery for. A notice raised during a restart is not lost, and a returning notifier does not flood the owner.

A test message is an operation of the plugin (`telegram.test`, `push.test`), not part of the seam.

A provider that can carry answers calls `ctx.inbox.answer(inboxId, { optionId, sender })` for a button; a typed reply to a notice arrives through `ctx.chat.receive` with `answerTo` set to the notice's `ref`. Who may answer is settled by pairing (§7.4), and §11.2 says when such an answer counts as the owner's approval.

### 7.4 `reelix:chat.channel@1`

**[new]** Telegram is two things: a notifier and a place to talk to the agent. Both use the same bot connection, so both must move together. MoviePilot's largest notification plugin needed the same two parts. This is the tenth seam.

```ts
type ChatChannel = {
	id: string;
	label: string;
	can: { buttons: boolean; images: boolean; typing: boolean };
	say(m: ChatOut, call: Call): Promise<void | Outcome>;
};
type ChatOut =
	| { type: "text"; text: string }
	| { type: "card"; kind: string; text: string; image?: Uint8Array }
	| { type: "ask"; id: string; question: string; options: { id: string; label: string }[] }
	| { type: "working" };
```

- The plugin calls `ctx.chat.receive({ channel, sender, text?, images?, answerTo?, optionId? })` for each incoming message. `answerTo` is the id of a question or the `ref` of a notice; `optionId` is the button pressed. Core keeps one standing conversation per channel and calls `say` with what the agent produces. `ctx.owner.of(channel)` tells the plugin whom to send to.
- **Pairing lives in core.** `ctx.owner.pair()` returns a one-time code shown in Settings; the first sender who types it becomes that channel's owner. Messages from anyone else never reach the agent. This is today's Telegram link flow, moved.
- The plugin tells Reelix who sent a message, and Reelix cannot check that. A chat plugin is therefore trusted to identify the sender, which is one more reason answers from a channel do not count as approval unless the owner switches that on (§11.2).
- A question that asks for a secret is never sent to a chat app; the channel receives "answer this in the web app".

### 7.5 `reelix:downloader@1` (phase 6)

```ts
type Downloader = {
	id: string;
	label: string;
	add(src: { torrent: Uint8Array } | { magnet: string }, o: AddOptions, call: Call): Promise<AddResult | Outcome>;
	get(id: string, call: Call): Promise<Transfer | undefined>;
	list(o: { ids?: string[]; mark?: string }, call: Call): Promise<Transfer[]>;
	changes?(cursor: string | undefined, call: Call): Promise<TransferChanges>;
	files(id: string, call: Call): Promise<TransferFile[]>;
	setWanted(id: string, indexes: number[], wanted: boolean, call: Call): Promise<void>;
	start(ids: string[], call: Call): Promise<void>;
	stop(ids: string[], call: Call): Promise<void>;
	remove(ids: string[], o: { deleteFiles: boolean }, call: Call): Promise<void>;
	addMark(ids: string[], mark: string, call: Call): Promise<void>;
	freeSpace(call: Call): Promise<number | undefined>;   // at defaultFolder; undefined when unknown
	defaultFolder(call: Call): Promise<string>;           // as the client names it
};
type AddOptions = { paused: boolean; mark: string; folder?: string };   // mark: [a-z0-9-]+
type AddResult = { id: string; duplicate: boolean };
type TransferChanges = {
	cursor: string;
	full: boolean;              // `changed` is every transfer; anything absent is gone
	changed: Transfer[];
	removed: string[];          // info-hashes; empty when full
};
type Transfer = {
	id: string;                 // v1 info-hash, 40 lower-case hex
	name: string;
	state: "queued" | "checking" | "downloading" | "seeding" | "stopped" | "error";
	hasMetadata: boolean;
	done: boolean;
	progress: number;           // 0..1 of the wanted data
	size: number;               // bytes of the wanted data; 0 before metadata
	left: number;               // wanted bytes still missing; 0 before metadata
	folder: string;
	contentPath?: string;       // the single file or top folder; relied on only when done
	marks: string[];
	addedAt: string;
	completedAt?: string;
	downSpeed?: number;
	upSpeed?: number;
	etaSeconds?: number;        // absent when unknown or unbounded
	peersSending?: number;
	ratio?: number;             // absent when undefined or infinite
	seedingSeconds?: number;
	problem?: { kind: "tracker" | "local"; message: string };
};
type TransferFile = { index: number; path: string; size: number; progress: number; wanted: boolean };
```

Rules every provider follows, checked by the conformance suite:

- **An empty list does nothing.** `ids: []` and `indexes: []` never reach the service, because on some clients an empty or missing list means "everything". `list({ ids: [] })` returns `[]`.
- **`list`:** `ids` and `mark` combine with AND; neither means every transfer. Unknown ids are left out. A provider filters by `mark` itself if the service cannot.
- **`add`:** when it returns, the transfer exists with `mark`. With `duplicate: true` the service ignored the options, so core treats it as adopting an existing transfer and calls `addMark`.
- **`paused`:** no payload is requested until `start`. A paused magnet need not fetch metadata: core starts it, waits for `hasMetadata`, stops it, then applies the selection. Some payload may arrive in between.
- **`done`:** metadata is present, no wanted data is missing, nothing is being checked or moved, and there is no local error. It does not mean a seed limit was reached. Core tests `done`, never `left === 0`.
- **`state`:** `checking` covers verifying and moving data. `error` is only a local failure; a tracker message is a `problem` and the transfer keeps its state.
- **`files`:** returns `[]` before metadata. `index` is the file's position in the torrent. `path` is relative to `folder`, with `/`. `setWanted` needs `hasMetadata`.
- **`addMark`:** keeps existing marks. It may read and rewrite the list per transfer.
- **`remove`:** may return before the files are gone.
- **`changes`:** an undefined or unusable cursor gives `full: true`. Only a full answer or `removed` proves a transfer is gone. Without `changes`, core polls `list({ ids })`, and an id absent from a successful answer is gone.
- Times are ISO 8601. All paths are as the client names them; the path map is stored per provider id.

The hardest seam, because qBittorrent's shapes are used directly today: tags as ownership markers become `mark`; the change feed becomes the optional `changes`; `QbTorrent` in `DownloadView.live` becomes `Transfer`. Generic `download.*` operations stay in core; `qbittorrent.*` operations are that plugin's own.

**Checked on paper against Transmission's RPC specification (2026-11-19); no daemon was run.** A Transmission provider maps marks to `labels` (no commas; on add from 4.0.0, otherwise add then set); `id` to `hash_string`; `progress`, `size`, `left` to `percent_done`, `size_when_done`, `left_until_done`; `hasMetadata` to `metadata_percent_complete === 1`; status 1 and 2 to `checking`, 3 and 5 to `queued`, 4 to `downloading`, 6 to `seeding`, 0 to `stopped`, or `error` when `error` is 3; `contentPath` to `download_dir/name`; `completedAt` to `done_date` when above 0; `peersSending` to `peers_sending_to_us`; `freeSpace` to `free_space` at `session_get.download_dir`. `is_finished` is never used for `done`. It omits `changes` at first: `recently_active` covers only 60 seconds and `removed` holds session-local numbers. The seam stays `provisional` until such a provider passes the conformance suite.

### 7.6 `reelix:metadata.source@1` and the catalogue (phase 6)

```ts
type MetadataSource = {
	id: string;
	label: string;
	find?(q: { text: string; kind?: Kind; year?: number }, call: Call): Promise<MetaHit[] | Outcome>;
	fromLink?(text: string, call: Call): Promise<MetaHit | undefined | Outcome>;   // a link or a short id (douban:1)
	enrich?(ids: Ids, call: Call): Promise<Enrichment | Outcome>;                    // {} for ids of other sources
};
type MetaHit = { ids: Ids; kind: Kind; name: string; names?: string[]; year?: number; series?: boolean; episodes?: number; rating?: Rating; note?: string };
type Rating = { value: number; scale: number };
type Enrichment = {
	rating?: Rating;
	episodes?: { number: number; airDate?: string }[];   // the main story in the source's own numbering
};
```

**[new] A limit, stated plainly: TMDB is Reelix's identity for a title** (title ids, the `[tmdbid-N]` folder tag, the play index). The TMDB catalogue therefore stays in core and is not a plugin in `api: 1`. This seam can find titles and add details: ids, ratings, episode lists. Every title still needs a TMDB id. If a result has none, Reelix looks it up in TMDB; if that fails, Reelix offers to keep it as a title that exists only in this library. This is narrower than "a different metadata source" in Q5.

### 7.7 `reelix:media.server@1` (phase 6)

```ts
type MediaServer = {
	id: string;
	label: string;
	watchUsers?: string[];   // whose history counts, by name, as the owner set it; absent: the only user, else the administrators
	info(call: Call): Promise<{ serverId: string; name: string; version: string; publicUrl?: string }>;
	libraries(call: Call): Promise<{ id: string; name: string; paths: string[] }[]>;
	users(call: Call): Promise<{ id: string; name: string; admin: boolean; active: boolean }[]>;
	changed(paths: { path: string; change: "created" | "deleted" }[], call: Call): Promise<void>;
	refreshAll(call: Call): Promise<void>;
	items(o: ItemsQuery, call: Call): Promise<ServerItem[]>;
	episodes(o: { userId: string; showId: string }, call: Call): Promise<ServerEpisode[]>;
	nextUp(userId: string, call: Call): Promise<ServerEpisode[]>;
};
type ItemsQuery = {
	userId: string;
	kinds: ("movie" | "show")[];
	filter?: "played" | "favourite";   // played: a film played, or a show with at least one played episode
	sort?: "lastPlayed";
	limit?: number;
};
type ServerItem = {
	id: string; kind: "movie" | "show"; name: string; year?: number; ids: Ids;
	plays?: number; episodesPlayed?: number; favourite?: boolean; lastPlayedAt?: string;
};
type ServerEpisode = { id: string; showId: string; season: number; episode: number };
```

### 7.8 `reelix:translator@1` (phase 6)

```ts
type Translator = {
	id: string;
	label: string;
	translate(job: TranslateJob, call: Call): Promise<TranslateResult | Outcome>;
};
type TranslateJob = {
	to: string;                 // the target in the owner's words: "French", "Klingon", "pirate English"
	novelty: boolean;           // a constructed language or a style
	lines: { n: number; text: string; sign?: boolean }[];
	glossary: { term: string; as: string; note?: string }[];
	tone?: string;
	context: { text: string; translated: string }[];   // the lines just before
	instructions?: string;      // the owner's own words
};
type TranslateResult = { lines: TranslatedLine[]; terms?: { term: string; as: string }[]; model?: string };
type TranslatedLine = { n: number; text: string; unsure?: boolean; borrowed?: boolean };
```

Glossary building, review, pacing and resuming stay in core; translating one chunk becomes the provider's work.

### 7.9 `reelix:player@1` (phase 6)

```ts
type Player = {
	id: string;
	label: string;
	links(requests: PlayRequest[], call: Call): Promise<({ url: string; autoplay: boolean } | null)[]>;   // one per request, in order
};
type PlayRequest = {
	ids: Ids; kind: Kind; series: boolean; season?: number; episode?: number;
	server?: { serverId: string; userId: string; itemId: string; publicUrl?: string };
};
```

### 7.10 `reelix:trends.source@1` (phase 6)

```ts
type TrendsSource = {
	id: string;
	label: string;
	trending(o: { kind: Kind | "all"; window: "day" | "week" }, call: Call): Promise<TrendHit[] | Outcome>;
};
type TrendHit = { ids: Ids; kind: Kind; name: string; names?: string[]; year?: number; rating?: number };
```

Providers supply candidates; choosing "For you" stays with the model in core. Trending from Bangumi is new behaviour, not a move of existing code (§18, A29).

### 7.11 Requirements between plugins

- `requires.seams` lists seams that must have at least one provider switched on. Example: `auto-subtitles` requires `reelix:subtitle.source@1`.
- A plugin whose requirement is missing is `waiting`, and Settings says what it waits for. It is checked again whenever plugins change. Nothing waits silently (Q36).
- Switching off a plugin that is the last provider of a seam others require, or a plugin others require, shows who depends on it and, after the owner confirms, switches them off together (Q36).
- Phase 7 (§21): `requires.plugins` (a plugin id and version range), plugin-owned seams (`<id>:<name>@1`) and events (`<id>:<name>`), activation in the order of requirements and the refusal of cycles. They use the same `requires` key, so existing plugins needed no change. This builds Q36 in two steps, not one (§18, change C6).

## 8. Hooks

A hook is a named step where plugins take part in a decision before it is made. Each hook has exactly one mode:

| Mode | Meaning | Does order matter? |
| --- | --- | --- |
| **guard** | Each handler may say no, with a reason. One no is final. | No |
| **pipeline** | Each handler receives the value so far and returns a changed value, or nothing. | Yes |
| **collect** | Each handler returns an item; Reelix gathers them all. | No |

Rules for all hooks:

- There is no `next()` to call. Returning nothing means "no opinion".
- Handlers receive the whole list in one call, never one call per item.
- A change comes with a `reason` of at most 200 characters; Reelix records it (§10.1).
- Reelix checks every result against the hook's limits. An invalid result is dropped and counted as a failure.
- A handler has 10 seconds (Q38).
- Pipeline order is: built-in plugins first, then order of installation; the owner can reorder per hook in Settings.

| Hook | Mode | Handler receives → returns | Phase |
| --- | --- | --- | --- |
| `release.filter` | guard | `{ title, releases }` → `{ ref, reason }[]` to hide | 2 |
| `release.rank` | pipeline | `{ title, releases }` → refs in a new order, with optional `{ ref, note }[]` | 2 |
| `organise.name` | pipeline | `{ title, items: { source, path, parsed }[] }` → changed paths | 2 |
| `notify.before` | pipeline | a `Notice` → changed `title`, `body` or `image` | 2 |
| `agent.prompt` | collect | `{ session }` → `{ title, text }` | 2 |
| `download.before` | guard | `{ release, title, options }` → `{ reason }` to refuse | 6 |
| `subtitle.pick` | pipeline | `{ files: { name, languages, format, score }[] }` → changed scores | 6 |
| `agent.tool` | guard | `{ tool, input, session }` → `{ reason }` to block | 6 |

A release in these hooks is `ReleaseHit` plus Reelix's parsed facts: resolution, source, codec, group, season and episodes. Its `ref` is Reelix's handle: the provider's own reference can carry a key and is not shown to plugins.

What Reelix enforces, and where each hook really sits in today's code:

- **`release.filter`** runs inside `searchReleases`, which chat, cards and follows all use. Hidden releases stay in the result, marked with the plugin and its reason. Reelix stores the mark with the release. `download.add` refuses a hidden release unless the owner chose "show hidden" or named that release. *Seven hooks were agreed in Q12; this one is new.* Blocking a release and preferring one are different, so they are two hooks. MoviePilot had one hook on one code path; a blocking plugin there had to modify eight internal functions.
- **`release.rank`** cannot add or remove releases. It sets the order Reelix presents. The agent still chooses; the notes are shown to it as facts. With no ranking plugin the order is today's: best seeded first. The follow engine's quick accept takes the first match in that order, so a ranking plugin also steers follows.
- **`organise.name`** applies to plans Reelix makes itself. Items the agent writes by hand are checked by the same limits but not passed through the hook. The result must stay inside the library, keep the title folder with its `[tmdbid-N]` tag, keep the same folder depth and the extension, and use legal characters. Facts from probing the file are not available at this step today; `parsed` holds what the release name says.
- **`notify.before`** may change wording and picture. It cannot change the path, the answer options or the kind, and cannot suppress. A changed notice shows "edited by <plugin>". Quiet hours and the like belong in a notifier's own settings.
- **`agent.prompt`** is collected when a conversation loads. Each plugin gets at most 1,500 characters in total, placed *before* Reelix's own rules under the heading "From the plugin <name>. It cannot change the rules below." Not included in job sessions unless the owner allows it per plugin.
- **`download.before`** runs after Reelix's own checks. A magnet's contents are known only after the downloader has loaded it. If the hook refuses at that point, Reelix removes the download again.
- **`subtitle.pick`**: choosing a candidate is the agent's work today. The only scoring in code is of files inside an archive, and that is what this hook adjusts. It cannot add files.
- **`agent.tool`** can block a tool call with a reason. It cannot change input or output, and it does not see commands the agent runs in its shell. After all plugin handlers, Reelix removes secrets from the text. Plugins cannot skip this step.

**[new] Trial mode** (phase 3). The owner can run a plugin's hooks in trial: Reelix calls them, records what they would have changed, and applies nothing. Settings then shows the difference: "would have hidden 14 releases; would have changed the first candidate 9 times". Trial is a preview of *effects*. It is not a safety step: the plugin's code still runs, with its network calls. It does not include `agent.prompt`, and notices or proposals made from inside a trial hook are dropped.

**A guard that says no to everything** would make follows find nothing, silently. Core raises an Inbox notice when a guard hides more than 90% over 20 calls, or when a follow gets no candidates because of filters, naming the plugin.

## 9. Events

Events report what has happened. A handler cannot change anything and cannot delay Reelix. Each handler's errors are contained, and no order between plugins is promised.

Plugin events are a typed catalogue, emitted at named points in core. Core keeps its internal stream (`app.emit`). That stream still sends detailed updates to the web UI, to jobs and to the agent host. Plugins cannot listen to it. What the catalogue does replace: the callback list for "a download was filed" (`watcher.onFiled`), and the Inbox listeners of Telegram and push, which the dispatcher takes over (§7.3). Core code that used the callback list (translation's standing wishes) listens to `download.filed` too. Following §2, an event enters the catalogue with its first listener:

| Event | Payload (main fields) | First listener | Phase |
| --- | --- | --- | --- |
| `config.changed` | changed paths | `metadata-refresh` | 1 |
| `download.filed` | hash, title id, paths, `via: "download" \| "organise" \| "adopt"` | `auto-subtitles` | 2 |
| `session.ended` | thread id, kind | `browser` | 6 |

`download.filed` is emitted for every way a file reaches the library, which the callback list did not do. The `via` field lets `auto-subtitles` keep today's behaviour and not start 300 jobs when a library is adopted.

Reserved, with no code until a listener exists: `inbox.answered`, `download.added`, `download.completed`, `download.removed`, `download.stalled`, `title.added`, `title.removed`, `library.changed`, `inbox.opened`, `inbox.dismissed`, `follow.matched`, `job.finished`, `plugin.changed`, and from a media server `media.played`, `media.added`. Adding one is a small change made together with the plugin that needs it. Plugin-owned events (`<id>:<name>`) are declared and emitted only by their owner, from phase 7 (§7.11).

## 10. What makes this agent-native

### 10.1 Reasons everywhere

**[new]** Each hook change, each hidden release and each provider outcome is recorded with the plugin and its reason. "Why this release?" on a card, and the same question in chat, list them: "hidden by `hr-guard`: this site requires seeding for 72 hours"; "moved up by `prefer-remux`: REMUX preferred for films". The agent reads the same record, so it can explain its own picks truthfully.

### 10.2 The owner's model, metered

**[new]** `ctx.model.complete` lets a plugin use the owner's models through the existing role routing. In MoviePilot fifteen plugins import the host's model helper from internals, with no accounting.

- Each plugin has a daily budget in US dollars, set in Settings, with a small default. It resets at local midnight. When it is reached the call returns the outcome `unavailable` and the plugin's page says why.
- Spend is recorded per plugin, including the agent turns its jobs run. (No core operation calls a model, so the operations a plugin runs spend none.)
- A call has a size limit, and the role is `background` unless the owner allows another.
- First user: `model-translator` (phase 6), which keeps translation's deliberate exemption from the cap as a setting on that plugin.

### 10.3 Proposals

**[new]** `ctx.propose({ key, title, why, steps: [{ operation, input }], expiresAt })` asks the owner to approve a list of operations. A cleanup plugin can say "these 12 finished torrents can be deleted, freeing 300 GB" and nothing is deleted until the owner agrees. It is the only way a plugin gets a `destructive` operation run (§11.2).

- **Reelix writes the card, not the plugin.** Each step is shown through the operation's `preview`: names, sizes and paths in place of ids, with totals ("deletes 12 torrents and 300 GB of files"). The plugin's `title` and `why` appear below as a quotation from the plugin. A step whose operation has no `preview` is refused. At most 50 steps.
- The owner can untick steps. The approve button shows how many destructive steps remain.
- Approval creates an approval record (§11.2) for exactly the steps shown. Reelix runs them through the ledger under the plugin's name, checks each step's preview again just before running it, and skips a step whose target changed.
- A new proposal with the same `key` replaces the old one. A proposal expires. The plugin learns the result from the return value: approved, declined, expired, or replaced by a newer proposal with the same key, with a result per step. A refusal rejects the same promise at once.
- Notifications about a proposal carry Reelix's summary, never only the plugin's title.

Reserved: standing approvals ("remove torrents seeded for 14 days, at most 20 a day"), which need their own design.

### 10.4 Raw pi extensions

`ctx.pi(factory)` adds a pi extension to agent sessions (Q30): the only way to add a model provider or tools that live inside a session, which is why `browser` needs it. Its manifest says `uses.pi: true`. It is labelled *advanced* at install: it can change the agent's prompt, tools and model traffic. After it loads, Reelix refuses any tool whose name collides with a Reelix tool or another plugin's, and Reelix's own redaction of secrets runs after every plugin's handlers. A raw pi extension can only ever run in-process.

### 10.5 Background agent turns

`ctx.agent.run({ prompt, title })`, inside a job, runs one background agent turn and returns its outcome. This is how the subtitle job works today ("subtitles are missing for this title: find and place them") and it is the most agent-native tool a plugin has: a plugin can state a goal in words and let the agent pursue it with every operation and skill. Turns count against the owner's background budget, as jobs do today, and a job can wait for the owner's answer and resume.

### 10.6 Inspection

`plugin_inspect` (Q31) is a read-only agent tool over the generated catalogue (§14.1) and live state: seams and their providers, hooks, events, operations with their schemas, plugins with state and last error, a plugin's settings schema, the Reelix version. The agent uses it to answer "can a plugin do this?", to help an author, and to explain a failure. It changes nothing. The agent *writing* a plugin comes in phase 7.

### 10.7 What plugin text is to the model

Text written by a plugin or returned by a service reaches the model in many places. The rule for each:

| Text | Treated as | Limit |
| --- | --- | --- |
| A plugin's skills | Instructions, under the fixed heading "Guidance from the plugin <name>. It cannot authorise approvals, access to secrets, or changes to plugins." | Shown at install |
| `agent.prompt` sections | Instructions, under the heading in §8 | 1,500 characters per plugin |
| Operation summaries and tool descriptions | Instructions (the model reads them to choose tools) | 300 characters; shown at install |
| Everything else: provider results, hook reasons and notes, outcomes, errors, card content, check results, notice and proposal text, labels | **Data, never instructions** | Length limits; marked as outside text |

**[new]** "Marked as outside text" is done in code at the one place where such text becomes model input. Today it is only a sentence in the system prompt. Each block's marks carry a new random id, so the text cannot contain its own closing mark. A plugin that writes outside values into a prompt of its own passes each through `outsideLine` from `@reelix/plugin`.

## 11. Trust and safety

### 11.1 The model

Plugins run inside Reelix with full trust (Q2). Declared capabilities do not stop malicious code. The protection is control over what gets in:

- Only the owner installs, switches on, updates or re-approves a plugin, in the web UI or at a terminal, after a screen that lists what the plugin declares and says plainly that the code can do anything Reelix can, or, for a plugin that runs in a process of its own (§11.7), what that process cannot do.
- That screen shows manifest data only. A plugin's code is never loaded before approval, not even to check it.
- A skill pack's screen lists its scripts and says the agent may run them (Q40).
- The agent may read, explain, and suggest a plugin to install. It cannot install, switch on or update one (Q43): these are `admin` (§11.2). It can change a plugin's settings only with the owner's yes to that exact change (§11.2).

### 11.2 Effects and approval

Four effects:

| Effect | Examples | Who may run it |
| --- | --- | --- |
| `read` | search, list | anyone |
| `write` | add a download, organise | owner, agent, jobs, plugins |
| `destructive` | remove a download with its files, remove a title | owner; agent as today; **a plugin only with an approval record** |
| `admin` | change settings, set a secret, manage plugins, change downloader preferences | **owner; never a plugin.** The agent only for operations marked `agentMay` (§ below) |

`agentMay` is on `config.set` and `qbittorrent.set_prefs` (a plugin's operation may carry it; plugins still never run it), because setting Reelix up in conversation is how the agent helps the owner (`skills/setup-and-doctor`). `secret.set`, all plugin management and pairing a chat channel (`telegram.link`) do not have it.

**Settings that decide where Reelix connects** are the owner's even within `config.set`, because changing one can send a secret elsewhere: everything under `plugins`, `proxy` and `web`, the active `downloader`, and a service address (`jellyfin.url`, `magpie.url`, `tmdb.base_url`, or the object holding it) while that service's secret is stored. An address no secret goes to yet stays open, so the agent sets it first and then asks for the secret. So are the agent's own spending and time limits, everything under `limits`. For any actor not starting with `owner:`, `config.set` refuses these without an approval record. The agent's `reelix` tool gets that record the usual way: Reelix shows the owner the path and the old and new values, in the conversation or, for a job, in the Inbox. The agent's shell gets the refusal. The owner can always use Settings.

The agent asks for a secret (`ask` with kind=secret) only under a name Reelix knows or a plugin declares, and never for `web.*`.

`admin` is new. Today `config.set`, `secret.set` and `qb.set_prefs` are plain `write`, although they can repoint the library or swap the model's address. This rule stops plugins and the agent's tools when they go through Reelix. It does not stop the agent's shell, or a plugin that goes around Reelix (§11.3).

**An approval record** is `{ operation, hash of the input, requested by, approved by, time, expires }`, used once. It is created only when the owner answers through a signed-in web session, the terminal, or a chat channel the owner has explicitly marked "may approve destructive actions" (off by default). An answer given by the agent or a plugin never creates one: an Inbox item that a job, an approval or an adoption waits on can only be answered by the owner or their paired channel, and only such an answer resumes a job. The record is made when the answer is the "approve" the item offered, in whatever language it was asked. The existing approval of `magpie.apply` is folded into this mechanism, so there is one; `magpie.apply` is its first user (phase 2). Today the owner can approve Magpie plans on Telegram. To keep that working, a Telegram that is already linked gets this switch turned on when its settings are moved.

**The agent is not changed by this design.** Today it may remove something when the owner asks in chat, limited by its instructions. Q14 was about plugins, and the gate is built for plugins. Whether to bind the agent too is a decision in §19.

### 11.3 What is real and what only prevents mistakes

An earlier draft called two gates "real". The review showed they are not while the agent's shell runs as Reelix's own user: from that shell it could read the secrets file, call the local socket without any token, run the CLI directly, edit the database, and write into the plugins folder. Decision D2 (§19) closes that in the Docker image; outside the image nothing changed.

**In the image (D2, built 2026-11-20).** Three system users (docs/deployment.md, "Users and files"):

- **Reelix** runs as the owner's `PUID:PGID` (qBittorrent's, decision D), in its own group `reelix` that owns the data folder. The container starts as root only for its entrypoint (`docker/entrypoint.sh`), which gives the data folder to that user and group and starts Reelix with `setpriv`: umask 002, the groups `reelix`, `reelix-agent` and `reelix-plugin`, and only three capabilities (`setuid`, `setgid` to start processes as the two other users, `kill` to stop them), also as its bounding set, with `no_new_privs`.
- **The agent's shell** (every `bash` call, and the scripts and `reelix` commands it runs) runs as `reelix-agent`, with Reelix's group `PGID` as its second group for the media folder. pi's shell replaces itself with `setpriv --reuid … --inh-caps=-all --ambient-caps=-all --no-new-privs -- bash -c <command>` (`shellAs` and `agentCommand` in `server/src/agent/host.ts` and `server/src/isolation.ts`): no capabilities, none to gain, so no set-user-ID program helps it. Its HOME is `<workspace>/.home`.
- **Plugins in a process of their own** (§11.7) run as `reelix-plugin` the same way, with no other group. They are not the agent's user, so the agent's shell cannot signal, trace or read the environment of a plugin's process, or plant files in its folder.

At every start, before anything runs as another user, Reelix sets the data folder's modes (`isolateData`). Only what is listed is open:

| Path | Reelix | agent's shell | plugin's process |
| --- | --- | --- | --- |
| the data folder itself | all | passes through, cannot list | passes through, cannot list |
| `workspace/`, `notes/`, `skills/`, `themes/` | all | read and write (group `reelix-agent`, kept for new files) | nothing |
| `plugins/` (installed plugins, install records) | all | read (skill scripts), never write | read (its code), never write |
| `plugin-data/` | all | nothing | passes through; its own folder read and write while it runs in its own process; every other folder closed |
| `agent.sock` | serves it | connects; every call needs a session's token | connects; has no token |
| `reelix.sock` (the owner's socket), `owner.token`, `secrets.yaml`, `reelix.db` (with the approvals), `config.yaml`, `pi/`, `sessions/`, `backups/`, `cache/`, `home/`, anything else | all | nothing | nothing |

**The agent's socket.** The owner's socket stays Reelix's user's only (0600). The agent's shell reaches Reelix through `agent.sock` (0666), which refuses every call without the token of a running session (`REELIX_TOKEN`), and refuses the owner's token too, so it never counts as the owner. The `reelix` command with `REELIX_TOKEN` uses only that socket, and never opens the data folder itself; without a token it uses the owner's socket as before. This is the same everywhere: outside the image the agent's shell uses `agent.sock` too, it is just not another user.

**pi's file tools are not covered by the system.** `read`, `write`, `edit`, `ls`, `find` and `grep` run inside Reelix's process, as Reelix's user. Reelix keeps them, in every setup, to what the agent's shell reaches in the image (`fileToolRefusal`, `server/src/agent/file-paths.ts`): in the data folder only the four working folders, and `plugins/` to read; nothing under `/proc` (Reelix's own environment and open files); no `grep` over a folder that holds the data folder. A path is judged by where it really leads, links included, also a link to a file that does not exist yet. This is Reelix's code, not the system's guarantee: a link swapped between the check and the read is not caught.

**What D2 gives.** Against a steered agent the gates now hold at the system level: it cannot read a secret, the owner's token or the database, cannot change the approvals or an installed plugin's files, cannot call the owner's socket, and cannot open the database or the data lock to run the CLI directly. Everything it does in Reelix goes through operations as itself (§11.2), where `admin` without `agentMay` and `secret.set` are refused. A plugin in its own process cannot read Reelix's data at the system level even past the second layer of §11.7.

**What it does not give:**
- The agent still has what it legitimately works on: the media folder (read and write where its group may write: `PGID` with umask 002), its four folders (so it can still write a skill, which later sessions load as instructions, as designed), the network, and every operation an agent may run.
- A plugin inside Reelix (`in-process`) runs as Reelix and can do anything Reelix can (§11.1); D2 does not change that.
- Reelix itself holds `setuid`, `setgid` and `kill`, and the programs it starts (git, npm, ffmpeg, Chromium) inherit them. Someone who takes over Reelix's user can become root in the container, limited to those three capabilities, and so change the image's files until the container is made again. Reelix's user already holds every secret, so this adds little; the agent's and plugins' users cannot get there.
- Every process's command line is visible to every user in `ps`; Reelix puts no secret in one.
- Outside the image (development, tests, a start without the entrypoint) nothing changes user: the agent's shell runs as Reelix's user and everything above about the system does not hold. There, as before, the gates stop mistakes made through Reelix's tools and operations, and stop a careless plugin and an agent that is behaving.

Two earlier changes still prevent mistakes everywhere: the CLI counts as the owner only when attached to a terminal, so `admin` operations without `agentMay` are refused anywhere else (phase 1); a development folder (§13.3) can only be named on the command line (phase 5).

The hash of an installed plugin (§13.3) is checked when its code is loaded (at start, at every restart of the plugin, so also every start of its own process), before its screen is served and before its settings schema file is read. It does not cover what the plugin reads later: a `require` or `import` inside a handler, a file it reads while it runs, or a file changed between the check and the read. In the image only Reelix's user can write the plugins folder; outside it the agent's shell can too.

### 11.4 Network

`ctx.http.fetch` is Reelix's fetch: proxy settings, time limits, redaction, the hosts in `uses.network`. It resolves the host, checks the address, then connects to that address, and checks again at every redirect; a redirect to a host that is not declared is refused. The entry `*` means any public host, and the install screen shows it as "any site on the internet". First user: `jackett`, because a download link from Jackett may redirect to the tracker's own address. Addresses on the home network are refused, except a host the owner typed into a `config:<field>` setting, which is how `jackett` reaches a server on the NAS. Reelix's own ports are always refused. Home addresses include the forms that lead back to one: `::/96`, `64:ff9b::/96`, `2002::/16`, `fec0::/10` and `192.0.0.0/24`. `198.18.0.0/15` is not included, because proxies with fake-IP DNS resolve public names into it. Responses give manual redirects, all cookies and bytes, which today's subtitle sites need.

A followed redirect to another origin (scheme, host or port) carries none of the headers the plugin set and no body, and goes on as `GET`; what was dropped stays dropped for the later hops. A response is limited to 64 MB, room for a subtitle archive or a `.torrent`; a larger one is an error. With a proxy, the proxy resolves the name when it connects: Reelix checks what the name means here, but cannot pin the address the proxy ends up using.

While plugins run inside Reelix, this cannot stop a hostile plugin, which can use Node's own HTTP. It keeps honest plugins inside what they declared. In a process of its own (§11.7) an honest plugin's only network is this fetch: Node 22's permission model does not cover the network, so Reelix's code in that process refuses every Node module not on its list, which a determined plugin may get past; it is not the operating system's guarantee.

### 11.5 Incoming calls

`ctx.webhook(name, fn)` gives a service a way to call Reelix: `/api/hooks/<id>/<token>` (Q39).

- Reelix makes the long random token, shows it in Settings, and can replace it there.
- The handler receives the method, headers and the raw body, limited to 1 MB. The body is outside text (§10.7). No session cookie is passed.
- Calls are rate-limited per token. Webhook failures are not counted for automatic switch-off; otherwise anyone who knows the address could disable the plugin by sending bad calls.
- Plugin routes (`ctx.route`) answer with JSON, a download or a data stream, never a web page, so a plugin cannot use a route to show its own screen inside Reelix.

Webhooks are reserved. Reelix receives no call from a media server today, and the events such a call would feed (`media.played`, `media.added`) are reserved too (§9). Routes are built with `browser` (phase 6).

### 11.6 Failures and limits

- **What counts as a failure:** a throw, a timeout, or a result that breaks the contract. A typed outcome (§7) does not count: a site saying "too many requests" is not a broken plugin.
- **Counting** is per registration (one hook, one provider in one seam), not per plugin. Five failures in ten minutes switch that plugin off with an Inbox notice that names the registration (Q15). The owner switches it back on in Settings.
- **Fairness:** sometimes Reelix itself is busy and cannot answer in time. That time is not counted against the plugin. One such incident can switch off at most one plugin, so a plugin that blocks Reelix cannot get the others switched off.
- **Volume:** notices and Inbox items from one plugin are rate-limited.
- **Names:** a plugin cannot register an operation, tool, route or card kind outside its own prefix.
- **Secrets:** redaction is best-effort replacement of known values. It runs on logs, the ledger (inputs and outputs), reasons, cards, notices, model input and output, and it also covers the owner's socket token. An operation whose output must not be kept at all, such as a pairing code, says so with `recordOutput`. A plugin that derives a value from a secret stores it with `ctx.secret.set`, so it is redacted too.

### 11.7 A process of its own, and real isolation later

`runtime: "process"` (phase 8) runs a plugin in a child process that receives its context over a message channel and is meant to have nothing else. It is the default of one built-in with a simple contract (`jackett`, Q2), and the owner can choose it for any plugin without a raw pi extension or compiled dependencies. A plugin that uses only the context moves there unchanged; one with a raw pi extension cannot. What holds there, and how firmly, comes in three layers.

**Node's permission model** (`--permission`), checked by Node inside the child for every call it covers:

- reading only the plugin's folder (with its own `node_modules`), `@reelix/plugin`, `jiti` and `typebox`, and the few files of Reelix the child runs, each granted by its real path; Reelix does not start the child if one of those folders holds a symbolic link that leads out of it, because Node checks the path as written and the system follows the link (`<link>/../..` reached the whole repository through the workspace link `node_modules/@reelix/core`);
- writing only its data folder `<data>/plugin-data/<id>`; creating links needs every permission, so it cannot make one there;
- no child processes (also `process.execve`), workers, WASI, compiled addons, `process.binding`, inspector, report files or OpenSSL engines.

Node documents this model as a seat belt for trusted code, not a defence against malicious code; it has had bypasses fixed in patch releases. It is enforced by Node, not by the operating system.

**Reelix's code inside the child** (`server/plugins/child.ts`), for what Node 22's model does not cover: the network, signals, and `node:sqlite`, which opened `reelix.db` under `--permission`. Before the plugin's code loads, the child:

- allows only the Node modules in `ALLOWED_MODULES` (`process.ts`; none opens a socket, reaches a native handle, starts code elsewhere or opens files past the model) and refuses every other, through `import`, `require`, `Module._load` and `process.getBuiltinModule`, whatever the form of the name (`net`, `node:net?x`, a `data:` module that re-exports it);
- makes `module.registerHooks` and `module.register` throw, so the plugin cannot add a resolver of its own in front of Reelix's;
- lets a signal go only to the child itself (`process.kill`, `process._kill`, `process._debugProcess`);
- removes the global `fetch`, `WebSocket` and `EventSource`, makes `process.stdout` and `process.stderr` plain writers instead of sockets, removes Node's lists of open handles, and holds the channel's socket where only its own code can reach it;
- takes these checks' tools (`Set.prototype.has`, `String.prototype.startsWith`, the original functions) before the plugin runs, so replacing built-ins does not undo them.

This is code in the same process as the plugin. It keeps an honest plugin on `ctx.http.fetch` and makes a hostile one work much harder, and a test (`server/test/plugin-hostile.test.ts`) tries every way out the review found and the others found while closing them, including a walk over everything reachable from the plugin's globals for a class that opens sockets or handles. It is still not a guarantee: a plugin that finds an object or a Node interface this code did not think of could reach the network (anything its user can reach, the home network included; outside the image also the owner's socket, which treats a caller without a token as the agent) or, outside the image, send a signal to Reelix.

**Reelix's side of the channel**, which holds whatever the child does: every `ctx` call runs in Reelix under §6 to §11; a message from the child is at most 80 MB, checked from its length before it is read, and a larger one ends the child; a printed line is cut at 16 KB; time limits and failure counting are as inside; the child's environment has only `TZ`, `LANG` and `LC_ALL`, and its working folder is `/`. The data folder's paths are still knowable (`ctx.folder()` returns one); what keeps the files closed is the permission model, not secrecy.

What is not stopped at all: CPU, memory and disk use in its own folder (no limits yet); and, outside the image, once the second layer is passed, `SIGKILL` or `SIGSTOP` to Reelix, which is a denial of service (in the image the system refuses it: another user). `SIGUSR1` is harmless: every start of Reelix passes `--disable-sigusr1` (the image, `bin/reelix`, `npm run server`, `scripts/demo.ts`) and the server ignores the signal itself, so no process of its user can open Node's debugger in Reelix.

**The operating system's boundary** (D2, §11.3), in the Docker image only: the child runs as the system user `reelix-plugin`, with no capabilities and `no_new_privs`. Past the first two layers it still cannot read the secrets file, the database, the owner's token, Reelix's settings or another plugin's folder, cannot write an installed plugin's files, cannot open the owner's socket (the agent's socket answers it nothing without a session's token), and cannot signal Reelix or the agent's shell. Its data folder is shared with that user's group while it runs in its own process, and closed again when it runs inside Reelix. All plugins in their own process share the one user, so at the system level they could read each other's folders; the permission model keeps each to its own. Still missing: a network namespace whose only way out is Reelix's channel. Until then a hostile plugin past the second layer can reach the network and the home network, and Reelix's web port, as any process in the container can; outside the image none of this layer exists. The owner still installs only code they trust (§11.1).

**[new]** The same phase may add `runtime: "mcp"`: an MCP server presented as a plugin, its tools becoming operations. It would make the existing MCP servers, including the owner's own qBittorrent MCP server, installable as Reelix plugins. Reserved; not designed.

## 12. The owner's side

### 12.1 Settings → Plugins

One list for built-in and third-party plugins: state, version, what each provides, last error, failures, spend. Per plugin: switch on or off, settings, secrets, hook order, trial mode, typed tools, budget, uninstall. The list and the on/off switch arrive in phase 1; settings, secrets, hook order, trial mode and the typed-tools switch in phase 3; uninstall in phase 4; budget and spend in phase 6 with model access.

### 12.2 Settings and secrets

- The form is generated from the plugin's TypeBox schema (Q18): text, number, switch, choice, a list of entries (two Jackett servers), a field shown only when another has a given value, a choice whose options come from one of the plugin's operations, and a button that runs one (for "test" and "pair"). No plugin code or HTML runs in the page.
- Secrets are declared by name, entered through the existing secret field, stored as `plugins.<id>.<name>`, and redacted automatically.
- **Where settings live.** A plugin's settings are under `plugins.<id>` in `config.yaml`. When a built-in moves, its keys move once (`jackett.url` becomes `plugins.jackett.servers[0].url`, and in `secrets.yaml` `jackett.api_key` becomes `plugins.jackett.api_key`) through the existing one-time migration at start, and the old keys are removed.
- **Stored data moves in the same migration:** the core store's keys `push.devices`, `telegram.offset`, `telegram.thread` and `metadata.locale` move into the plugins' stores, `telegram.owner_id` moves to core's pairing, and the `site_state` table is replaced by recorded outcomes, which core's `site.status` then reads.
- The Settings page is hand-written today. Phase 3 builds the generated form; the hand-written fields of every plugin moved by then are deleted in that phase. In phases 1 and 2 the moved plugins keep their existing fields, pointed at the new keys.

### 12.3 Cards

`ctx.card(kind, layout)` declares a chat card as data, in the layout `list` or `text`, with optional buttons (Q19). First user: the reference plugin `finished-cleanup`, which also is the first user of proposals. Reelix's own components render it. An operation names the card kind that shows its result. A button runs one of the plugin's operations as `plugin:<id>`, so a destructive one goes through a proposal. This replaces the fallback that prints unknown cards as JSON. More layouts (`table`, `posters`, `stats`) are reserved.

### 12.4 Uninstall

Removes the code; asks whether to delete settings, secrets and data, keeping them by default (Q29).

## 13. Distribution

### 13.1 Sources

A local folder (development), a git URL, or npm (Q20).

- git is pinned to a full commit id, never a branch or tag.
- npm is pinned to an exact version, installed from the lock file the package ships, with integrity hashes. For a package from npm that lock file is `npm-shrinkwrap.json`: npm never publishes `package-lock.json`.
- Install scripts never run. pi's package manager has no such option of its own, so Reelix runs the install step itself.
- Installed plugins live in `<data>/plugins/<id>/`, so they survive image updates (Q42).

**Loading.** Node cannot run TypeScript from inside a `node_modules` folder, and a plugin's import of `@reelix/plugin` must resolve to Reelix's own copy (Q24). So a plugin sits in its own folder (not inside `node_modules`), its dependencies sit in its own `node_modules`, and Reelix loads the entry with the loader pi already uses, which runs TypeScript and maps `@reelix/plugin` to Reelix's copy. This is to be confirmed by a small experiment at the start of phase 1.

### 13.2 Dependencies

Each plugin has its own dependencies; Reelix's packages are peers (Q37). A plugin with compiled dependencies sets `uses.native: true`. Reelix installs it only if ready-made binaries exist for the owner's platform. Nothing is compiled on the owner's machine. The install screen states both facts.

### 13.3 Integrity and updates

- Reelix records a hash of everything it installed for a plugin: its files, its skills and scripts, and its whole dependency folder.
- The hash is checked every time the plugin is loaded, not only at start. A plugin whose files changed is not loaded, and an Inbox item asks the owner to re-approve it (Q28).
- A development folder is exempt. It exists only while Reelix was started with `reelix plugin dev <folder>`, is shown with a permanent banner, and cannot be added through settings or an operation.
- Updates are manual (Q27). The update screen shows the author's changelog *and* what changed in the declaration: new network hosts, new secrets, new skills or scripts, new operations.
- Approving an update replaces the installed files at once; the running version keeps running until the restart. Anything that starts the plugin again before then (a change of its settings, a crash of its process) loads the approved new version, after the same hash check: it is the code the owner approved, only earlier.
- An update that cannot run where the owner chose (the owner runs it in a process of its own and the new version adds `uses.pi` or `uses.native`) says so in its difference (`in-process`), and after approval it stays off, saying why, until the owner chooses to run it inside Reelix (§11.7).
- An install is a transaction: on any failure the previous state is restored. A newly installed plugin is off until the owner has approved its screen.

These hashes live in the data folder, which the agent's shell can write today (§11.3).

### 13.4 Compatibility

- `engines.reelix` is checked at install and at every start. After an image update, incompatible plugins are switched off with an Inbox notice (Q26, Q42).
- A plugin whose `api` differs from Reelix's is `incompatible` and not loaded.
- **Each seam and hook has its own version** (Q44), written `reelix:indexer@1` and `release.rank@1`. `api` covers the manifest and the context; a seam's version covers that contract alone. A change that breaks one seam raises that seam's version and affects only its providers. Before the review gate all of them may change freely.
- Whether Reelix keeps the previous `api` or seam version working for one release after a break is a decision in §19. Q26 said yes.

### 13.5 Built-ins, index, opening up

- The index is one JSON file in a public GitHub repository, read by Settings; entries arrive by pull request; no install counts or ratings (Q25). The index, and the code in Settings that reads it, are created only when the project opens.
- `@reelix/plugin` is MIT (Q9): types and small helpers (Q24). The test helper and conformance suites are a second package, `@reelix/plugin-testing`.
- Making the repository public, publishing either package to npm, and creating the index each wait until the owner says so (Q23).

### 13.6 Command line

`reelix plugin list | add <source> | remove | enable | disable | update | new | dev | check | inspect` (Q43). All but `list`, `new`, `dev`, `check` and `inspect` are `admin` (§11.2) and confirm at the terminal. `new`, `dev` and `check` are not operations: they need no running Reelix and change none (`dev` starts one of its own in a temporary folder). `list`, `enable` and `disable` exist from phase 1 (they are operations); `inspect` from phase 3; `add`, `remove` and `update` from phase 4; `new`, `dev` and `check` from phase 5.

## 14. For contributors

### 14.1 A reference that cannot differ from the code

**[new]** Seams, hooks, events and operations are declared in code with their types, modes and limits. A generator writes `docs/plugin-reference.md` from those declarations. `npm test` fails when the committed file differs from the code, and when a declared seam, hook or event has no user (§2). `plugin_inspect` reads the same data.

### 14.2 The path from idea to working plugin

1. `reelix plugin new` asks what kind (subtitle source, indexer, notifier, hook, skill pack) and writes a working example with a test.
2. **[new]** `reelix plugin dev ./folder` starts Reelix in demo mode, with the fake qBittorrent, Jackett, TMDB and Jellyfin that `scripts/demo.ts` already uses, and the plugin loaded from the folder. No real services, keys or library are needed.
3. **[new]** The checker validates the manifest and the entry's shape, checks that what is registered matches what is declared, and runs the conformance suite of every seam the plugin provides. In phase 2 it is part of `npm test` for the built-in plugins; in phase 5 it also becomes the command `reelix plugin check ./folder`.
4. The test helper starts Reelix *through the real loading path*: manifest, loader, schema, activation. It gives canned HTTP answers (`testing.http`), runs a job (`testing.runJob`) and calls a hook with a recorded input (`testing.hook`). A test that mounts a plugin by hand can pass while the real path fails.
5. Publish to git or npm; later, optionally a pull request on the index.

Items 3 and 4 are built in phase 2, because the built-in plugins of that phase are their first users. Items 1 and 2, the `check` command and the written material are phase 5.

### 14.3 Material

`docs/plugin-guide.md`, with one recipe per seam and hook, each recipe being a built-in plugin or a reference plugin; the generated reference; an `AGENTS.md` for people writing plugins with a coding agent, including the order in which to find facts: inspect, then the reference, then say what is unverified (Q33).

## 15. Work in Reelix itself

The plugin API cannot be laid over the code as it is. From the survey of 2026-11-18:

| Today | Needed | Phase |
| --- | --- | --- |
| The operation registry is a module-level list filled when files are imported; entries cannot be removed. 79 operations in 11 files. | A registry owned by the app, entries removable by scope. The largest hidden job. | 2 |
| The CLI reads its own copy of the registry | It reads the list from the server when one is running (§6.1) | 2 |
| `Subsystem` has no way to stop; listeners and timers are never released | `Subsystem` deleted in phase 2 (§3) | 1–2 |
| Server subsystems read the database directly | They use operations and `ctx.reelix.read`; core functions they call become operations | 1–2 |
| `config.set`, `secret.set`, `qb.set_prefs` are plain `write` | Effect `admin` (§11.2) | 1 |
| Approval exists only for `magpie.apply` | One approval record for all (§11.2) | 2 |
| A callback list announces filed downloads; plugins have no events | Typed plugin events beside the internal stream (§9) | 1–2 |
| Telegram and push each decide and send on their own; `inbox.telegram_message_id` | Dispatcher and delivery table (§7.3) | 2 |
| System prompt is one template with no place for additions | Sections | 2 |
| Planning (`autoPlan`) and the system prompt are synchronous | Both stay synchronous. The naming hook runs after the plan is made and before it is applied. Prompt sections are collected before a conversation loads. | 2 |
| Client accessors on `Reelix` return service classes; callers use service shapes | Seam contracts; each accessor deleted when its seam lands | 2, 6 |
| Tool names hard-coded in job prompts, in the card switch and in Telegram | Declared by the owning plugin | 2–3 |
| Outside text is marked only by a sentence in the prompt | Marked in code (§10.7) | 2 |
| Settings fields, known secrets and Doctor checks are hand-written lists | Generated forms, declared secrets, `ctx.check` | 2–3 |
| HTTP routes cannot be added or removed after start | One dispatch route per prefix, registered at start | 6 |
| `session.bindExtensions()` is never called | Called, with the first raw pi extension | 6 |

Each row ends with the old code deleted (§2).

## 16. Phases

Each phase ends with tests green, this document updated, a dead-code check, and a stop for the owner's review (Q44). "Prepares" names the later work a phase makes room for.

### Phase 1: Kernel, with its first plugin

- An experiment first: load a TypeScript plugin from a folder with `@reelix/plugin` resolved to Reelix's copy (§13.1).
- Manifest, loader, scope with automatic cleanup, the states `active`, `failed` and `disabled`, failure counting, management results.
- The `admin` effect, the socket token and the CLI's terminal check (§11.2, §11.3). First user: switching a plugin on or off, which is `admin`.
- Context calls marked phase 1 in §6, and the event `config.changed`.
- **First user: `metadata-refresh`**, which uses `ctx.job`, `ctx.jobs.enqueue`, `ctx.on`, `ctx.kv`, `ctx.reelix.run`, `ctx.reelix.read`, `ctx.log` and `ctx.t`. `ctx.reelix.read` starts with the two records it needs (titles, state of services); each further record enters with its first reader. `ctx.signal` enters in phase 2 with `telegram`.
- Settings → Plugins: the list and the on/off switch.
- Prepares: later groups of context calls. `ctx.supports(name)` is reserved until the first optional group exists.

### Phase 2: First real plugins

- The app-owned operation registry; the CLI reading operations from the server; approval records (first user: `magpie.apply`).
- Seams: the mechanism, the conformance runner, the checker and the test helper, then `subtitle.source`, `indexer`, `notifier`, `chat.channel`.
- Plugins: `subtitle-sites`, `auto-subtitles`, `jackett`, `push`, `telegram`. The follow and translation wiring becomes core code, and `Subsystem` is deleted (§3).
- The notification dispatcher and delivery table; pairing in core.
- Hooks, each with its first user:

  | Hook | First user |
  | --- | --- |
  | `agent.prompt` | `telegram` (the "# Telegram" section of the core prompt moves into the plugin) |
  | `release.filter` | reference plugin `block-words` |
  | `release.rank` | reference plugin `prefer-freeleech` |
  | `organise.name` | reference plugin `name-with-resolution` |
  | `notify.before` | reference plugin `short-notices` |

- Context calls marked phase 2 in §6, each with its first user:

  | Call | First user |
  | --- | --- |
  | `ctx.operation` | `jackett` (`jackett.indexers`), `push`, `telegram` |
  | `ctx.provide` | `subtitle-sites` |
  | `ctx.hook` | `telegram` |
  | `ctx.task`, `ctx.signal`, `ctx.owner.pair`, `ctx.inbox.answer`, `ctx.chat.receive` | `telegram` (its long poll, linking, answers, chat) |
  | `ctx.check` | `jackett` (the indexer check moves out of Doctor) |
  | `ctx.secret.get` | `jackett` |
  | `ctx.secret.set` | `push` (its generated key) |
  | `ctx.http.fetch` | `subtitle-sites` |
  | `ctx.agent.run` | `auto-subtitles` |
  | `ctx.inbox.add`, `ctx.job` with `every` | reference plugin `low-space` (an hourly job that reads free space and adds one notice when it is low) |
  | `requires.seams`, the state `waiting` | `auto-subtitles` |

- Reasons (§10.1); outside-text marking; the generated reference and its test, which also checks that every context call has a user.
- Prepares: each seam and hook has its own version, so one can change without the rest.

### Review gate

The owner reviews the API on real code. Before the gate, the `downloader` contract is drafted against Transmission on paper. Then `api: 1` is declared. Until then anything may change freely.

### Phase 3: Owner experience

- Generated settings forms (the hand-written fields of moved plugins are deleted); secrets on the plugin page; hook order; trial mode.
- Cards, proposals and typed plugin tools (first user of all three: reference plugin `finished-cleanup`); `plugin_inspect`.
- Prepares: more card layouts; standing approvals.

### Phase 4: Distribution

- Install from git and npm, transactions, hashes, re-approval, manual updates with the declaration difference, the commands `add`, `remove` and `update`, the data volume. The states `installed`, `incompatible` and `changed`.
- Skill packs (first user: a reference pack in `plugins/examples/`); a plugin's own skills and setup skills (first user: `skills/setup-jackett` in `jackett`).
- Prepares: install sources share one small interface, so an index or signed packages can be added later as one more source.

### Phase 5: Contributors

- The guide, `plugin new`, `plugin dev`, `plugin check`, `AGENTS.md`.
- Then, only when the owner says so: public repository, packages on npm, the index and its reader in Settings.
- Prepares: the conformance suites are what later runtimes are tested against.

### Phase 6: Full surface

These complete Q6 and are **not optional**: without them Reelix's own downloader and media server stay outside the plugin API.

- `qbittorrent`, `jellyfin`, `bangumi`, `douban`, `players`, `model-translator`, each with its seam, one at a time. Each seam starts as `provisional` (§7). `ctx.model.complete` and plugin budgets arrive with `model-translator`.
- Hooks `download.before`, `subtitle.pick`, `agent.tool`, each with a reference plugin.
- Raw pi extensions, routes and the event `session.ended`, with `browser`.
- Prepares: each seam that lands removes one service-shaped accessor from core, so phase 7 starts from a core that knows only the model, TMDB and Magpie.

### Phase 7: Ecosystem depth

- Plugin-owned seams and events; `requires.plugins`, activation order, cycles refused.
- The agent writing a plugin and proposing it to the owner.
- Prepares: plugins that build on other plugins, which the isolation of phase 8 must then respect.

### Phase 8: Isolation and screens

- `runtime: "process"` with declarations enforced; possibly `runtime: "mcp"`.
- Plugin screens in a sandboxed frame. Trust signals in the index.
- Prepares: other runtimes use the same manifest key and the same conformance suites.

Phases 1 to 5 are the first release others can build on. Phase 6 must follow. Phases 7 and 8 can be reordered by demand.

**Reserved names with no code until their phase** (§2): `ctx.supports`; settings versions and migration by a plugin; `runtime` values other than `in-process` and `process` (`mcp`); the events listed as reserved in §9; card layouts beyond `list` and `text`; standing approvals; declarative providers; the index reader; `ctx.webhook` and `uses.webhooks`; the `daily` option of `ctx.job`; a "required" mark for plugins that cannot be switched off (no plugin needs it now that TMDB stays in core).

## 17. Kept out, on purpose

Considered and not proposed, because nothing in Reelix needs them yet: a per-user watchlist source, a storage seam, a model-provider seam, a hook for recognising names, site sign-in and statistics, more than one user. MoviePilot's community wrote plugins for each, so they are the likeliest next seams.

Not to be copied from the systems studied: replacing any host method by name; a generic event used as a command bus; required empty methods; UI described as a tree of framework components; installing dependencies into the host's own environment; several plugin generations side by side; a plugin sandbox built on `node:vm`, which is not a boundary.

## 18. Beyond the interview

### Additions

None of these was put to the owner. A9, A21, A22 and A23 can be removed without affecting the rest; the others depend on each other.

| # | Addition | Section | Why |
| --- | --- | --- | --- |
| A1 | Hook modes `guard`, `pipeline`, `collect`; lists handled in one call | §8 | A veto can never be undone by ordering |
| A2 | Hook `release.filter` | §8 | MoviePilot plugins patched host code for lack of it |
| A3 | Seam `chat.channel`; pairing in core | §7.4 | Telegram cannot be split otherwise |
| A4 | Typed outcomes for providers | §7 | A rate limit is not a failure |
| A5 | Reasons recorded for every plugin decision | §10.1 | The owner and the agent can always answer "why" |
| A6 | Proposals, written by Reelix from previews | §10.3 | Cleanup without silent deletion or misleading cards |
| A7 | Metered access to the owner's model | §10.2 | Wanted by many MoviePilot plugins; here with a budget |
| A8 | Background agent turns from a plugin job | §10.5 | Today's subtitle job already works this way |
| A9 | Trial mode for hooks | §8 | See a plugin's effect on your own data first |
| A10 | Seam = contract + conformance suite + status; two providers before "stable" | §7 | Contracts not shaped by their first provider |
| A11 | Reference plugins as first users and as guide recipes | §2 | No extension point without a user |
| A12 | Generated reference, checked by the tests | §14.1 | Docs, agent and code cannot differ |
| A13 | `plugin dev` on the demo fakes; `plugin check` | §14.2 | Try a plugin with no real services |
| A14 | Effect `admin`; one approval record | §11.2 | Settings and secrets are more than `write` |
| A15 | Rules for what plugin text is to the model | §10.7 | Plugin text is the cheapest attack |
| A16 | Network rules for `ctx.http`; `config:` entries | §11.4 | Reelix sits beside unprotected home services |
| A17 | Hash over the whole dependency folder, checked at each load; declaration difference on update | §13.3 | The first draft's check had holes |
| A18 | Management results with a next step | §5.3 | No guessing what is live |
| A19 | `ctx.task`, `ctx.check`, `ctx.secret.set`, `ctx.jobs.enqueue`, `ctx.reelix.read` | §6 | Needed by the built-ins that move in phases 1 and 2 |
| A20 | Guard alarm; fair failure counting | §8, §11.6 | A plugin cannot hide everything or get others switched off unnoticed |
| A21 | Setup skill | §4 | The agent configures a plugin with the owner |
| A22 | Declarative providers (reserved) | §4 | The cheapest way to add a service |
| A23 | `runtime: "mcp"` (reserved) | §11.7 | Opens an existing ecosystem later |
| A24 | A plugin package is also a pi package; pi's loader loads it | §4, §13.1 | Reuse what Reelix already ships |
| A25 | The core/plugin line and the built-in plugin table | §3 | "Everything is a plugin" was never the goal |
| A26 | One notification dispatcher and a delivery table in core | §7.3 | Two channels deciding separately is how duplicates and gaps happen |
| A27 | A token on the local socket; the CLI's terminal check | §11.3 | Small changes that prevent mistakes |
| A28 | `uses.runs` and the other `uses` keys beyond those named in Q46 | §5.1 | The install screen can only show what is declared |
| A29 | Anime trending from Bangumi, as the first `trends.source` provider | §7.10 | A seam needs a real provider; TMDB's own lists stay in core |

### Changes to agreed answers

| # | Agreed | Now | Why |
| --- | --- | --- | --- |
| C1 | Q12: each hook has "one fixed mode", two modes named | Three modes (A1) | Sharper; same intent |
| C2 | Q14: destructive plugin calls "follow the same rules as the agent" | Plugins need an approval record; the agent is unchanged | No such rule exists in code for the agent (§11.2) |
| C3 | Q43: management commands "cannot be run by the agent", by "the same mechanism that guards secret commands" | They are `admin`; this stops the agent's tools, not its shell | That mechanism does not exist (§11.3) |
| C4 | Q26: the previous `api` number is supported for one release | Open: decision D3 | It conflicts with "never two generations" in §2 |
| C5 | Q6: the five subsystems move first | Metadata and subtitles become plugins in phases 1–2; follows and translation stay in core; `browser` moves in phase 6 | Follows and translation are engine and talk to no outside service; `browser` needs session tools |
| C6 | Q36: the resolver exists from phase 1 and built-ins use it | Phase 2 builds the seam requirement check; ordering and cycles wait for phase 7 | Built-ins never need ordering, so it would be code without a user |
| C7 | Q41: a few built-ins are marked required | None is: every built-in plugin can be switched off | The one candidate, TMDB, stays in core (C9) |
| C8 | Q24: the SDK is "types plus small helpers" | Plus a second package for testing | The suites are too large to call helpers |
| C9 | Q5: "a different metadata source" as an example of replacing a core part; Q6: service clients become plugins | TMDB stays the identity, stays in core, and is not replaceable in `api: 1` | Title ids and folder tags are built on it |
| C10 | Q13: operations of plugins are named `<id>.<name>` | Engine operations keep their present names in core; a plugin id may not equal a core prefix; `qb.*` becomes `qbittorrent.*` | Otherwise every `subtitle.*` and `follow.*` name used in skills and prompts would change |
| C11 | Q11, Q12: later seams and hooks "defined now" | Defined, and marked as specifications to be re-checked when built | The review found the first sketches wrong in detail |
| C12 | Q30: raw pi extensions "built last within v1" | Phase 6, after the first release | They are first needed by `browser` |
| C13 | (not asked) The CLI runs every operation by itself when no server is running | Only core operations; plugin operations need the server | Loading plugins inside the CLI would be a second loader |
| C14 | Q12: `notify.before` can change or suppress a message | It can change wording only | A pipeline that can veto is what A1 removes; quiet hours belong in a notifier's settings |
| C15 | Q16: switching on or off and settings changes are live | Live for Reelix; an open agent conversation sees them when it next loads | The agent library fixes tools and prompt at load |
| C16 | (not asked) Follows pick the best-seeded match | They pick the first match in ranked order, which is best-seeded unless a ranking plugin is on | So a ranking plugin also steers follows |
| C17 | (not asked) Subtitle jobs start only when the watcher files a download | `download.filed` is announced for every way a file is filed, with a `via` field; `auto-subtitles` keeps today's behaviour by reading it | One event in place of a callback list |
| C19 | Q43, §11.2 first draft: `admin` is owner only | The agent keeps `config.set` and `qb.set_prefs` (`agentMay`), except that settings deciding where Reelix connects need the owner's yes (§11.2); plugins never get them | Found when building: the owner's setup in chat depends on them |
| C18 | Q19, Q39: plugin routes and webhooks in the first release | Routes in phase 6 with `browser`; webhooks reserved until a plugin needs one | Nothing before `browser` needs a route, and nothing today receives a webhook; the web UI reaches plugins through operations |

## 19. Decisions for the owner

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Accept the additions A1–A29, or name the ones to remove? | Accept. If anything is to be cut for size, cut A9, A21, A22, A23 first. |
| D2 | Run the agent's shell as a second system user (§11.3), as its own step before phase 1? | Yes. It is the only thing that makes any gate hold against a steered agent, and it protects today's Reelix too. **Done 2026-11-20** (after phase 8, not before phase 1): the image's agent's shell runs as `reelix-agent`, plugins in their own process as `reelix-plugin` (§11.3, §11.7); built and tested in a real container (§21). |
| D3 | After a breaking change, keep the previous `api` or seam version working for one release (Q26), or one version at a time? | One at a time, with the break announced a release ahead. Keeping two is less clean but kinder to plugin authors; it is a real choice. |
| D4 | Bind the agent, too, to approval records for destructive operations? | Not now. It changes the agreed soft limits and adds a second prompt to things the owner asked for in chat. Decide after D2. |
| D5 | Accept the changes C1–C19? | Accept. C2, C3, C9 and C15 are corrections of fact, not preferences. C5 is the one to look at most closely: it keeps follows and translation in core. |

## 20. Where each interview answer is recorded

| Q | Section | Q | Section | Q | Section |
| --- | --- | --- | --- | --- | --- |
| Q1 | §1 | Q17 | §6 | Q33 | §14 |
| Q2 | §11.1, §11.7 | Q18 | §12.2 | Q34 | §5.1, §6.1 |
| Q3 | §1 | Q19 | §12.3, C18 | Q35 | §7 |
| Q4 | §1, §6.1 | Q20 | §13.1 | Q36 | §7.11, C6 |
| Q5 | §1, §7, C9 | Q21 | §3 | Q37 | §5.1, §13.2 |
| Q6 | §3, §16, C5 | Q22 | §7 | Q38 | §7, §8 |
| Q7 | §4 | Q23 | §13.5 | Q39 | §11.5, C18 |
| Q8 | §4 | Q24 | §13.1, §13.5, C8 | Q40 | §11.1 |
| Q9 | §13.5 | Q25 | §13.5 | Q41 | §3, C7 |
| Q10 | §7 | Q26 | §5.1, §13.4, C4 | Q42 | §13.1, §13.4 |
| Q11 | §7, C11 | Q27 | §13.3 | Q43 | §11.1, §13.6, C3 |
| Q12 | §8, C1, C11, C14 | Q28 | §13.3 | Q44 | §5.1, §13.4, §16 |
| Q13 | §6.1, C10 | Q29 | §12.4 | Q45 | §1, §6 |
| Q14 | §11.2, C2 | Q30 | §10.4, C12 | Q46 | §1, §5.1 |
| Q15 | §11.6 | Q31 | §10.6 | | |
| Q16 | §5.3, C15 | Q32 | §6 | | |

## 21. Implementation status

The owner asked on 2026-11-19 to implement this design. Until the owner says otherwise, §19 is taken at its recommendations. D2 (a second system user) was first left for the owner, because it changes the Docker image and Docker was not on this machine; it was built and tested in a real container on 2026-11-20.

| Phase | State |
| --- | --- |
| 1. Kernel | done (2026-11-19): `metadata-refresh` runs on the kernel; `npm test`, typecheck, web build and a real server boot with `plugin list` and a refused non-terminal `plugin disable` pass |
| 2. First real plugins | done (2026-11-19), parts below |
| 2a. Registry, CLI, approvals, seams, first plugins | done (2026-11-19): app-owned operation registry; the CLI reads the server's list and confirms `plugin enable` and `disable` at the terminal; approval records with `magpie.apply` as first user; `reelix:subtitle.source@1` and `reelix:indexer@1`; plugins `subtitle-sites`, `auto-subtitles`, `jackett` and the reference `examples/low-space`; `@reelix/plugin-testing` |
| 2b. Notifications and chat | done (2026-11-19): `reelix:notifier@1` with the dispatcher and the `notice_deliveries` table; `reelix:chat.channel@1` with pairing, one standing conversation per channel and the owner's "may approve destructive actions" switch (`channel.*` operations, `chat_channels` table); `ctx.task`, `ctx.signal`, `ctx.secret.set`, `ctx.owner`, `ctx.chat`, `ctx.inbox.answer`, `ctx.hook` with the collect hook `agent.prompt@1`; plugins `push` and `telegram`, with their settings, secrets and stored data migrated. `core/push.ts`, `clients/telegram.ts`, `server/telegram.ts`, `app.telegram()` and the `/api/push*` and `/api/telegram/link` routes are gone. Job sessions get no `agent.prompt` sections: the per-plugin permission waits for its screen in phase 3. |
| 2c. Hooks, reasons, outside text, reference | done (2026-11-19): hook modes `guard` and `pipeline`; `release.filter@1`, `release.rank@1`, `organise.name@1`, `notify.before@1` with the reference plugins `block-words`, `prefer-freeleech`, `name-with-resolution`, `short-notices` (off by default); the `reasons` table and `release.why` ("Why this release?"); outside text marked where tool results reach the model (`core/outside.ts`); `docs/plugin-reference.md` generated by `npm run plugin-reference` and checked by `npm test`, with every seam, hook, event and context call needing a user; the checker calls each hook; `testing.hook`. `Subsystem` and `server/plugins.ts` are gone: `startFollows`, `startTranslation` and `startBrowser` are started from `main.ts`, and Chromium is closed at shutdown. Verified by `npm run typecheck`, `npm test`, the web typecheck and build, and a demo server with fake services (search, hidden release, ranked order, refused download, the release card in headless Chromium, a chat with a real model) |
| Review of phases 1-2 (2026-11-19) | 28 findings fixed: 3 blockers, 8 major, 11 minor, 5 unused contract fields or methods, and file names reaching a plugin's agent prompt unmarked. `Notifier.test`, `can.buttons` of notifiers and `Notice.waiting` are gone; `can.answers`, `Notice.urgent` and `Call.deadline` now have readers. Tests in `packages/server/test/plugin-review.test.ts` |
| 3. Owner experience | done (2026-11-19), before the review gate, so `api` stays 0. Parts below |
| 3a. Settings, secrets, hook order, trial, typed tools | Generated settings form (`plugin.settings`, `plugin.configure`, owner only, returning management results with the errors per field); annotations `SETTINGS.optionsFrom`, `showWhen` and `buttons` in `@reelix/plugin`; labels from the plugin's locales. The schema can be read without loading code: a manifest's `settings` names a JSON copy (`settings.schema.json`), written by `npm run plugin-reference`, checked by `npm test`, and checked again at every activation, where a copy that differs from the code stops the plugin. A plugin without that key still gets its form once it has run. A plugin's declared secrets are on its page through the existing secret field, and `config.set` refuses them; their labels come from the plugin, and the plugin entries of `KNOWN_SECRETS` are gone. The hand-written Jackett address field and the Telegram section are gone: Telegram's bot check, linking code and test message are buttons on its page; what is core (who is linked, "may approve") is a section for all chat channels. Push keeps its device section, which is about the browser, not settings. Hook order per hook (`plugin.hooks`, `plugin.hook_order`; owner only; kept; the pipeline runs in it). Trial mode per plugin (`plugin.trial`): guard and pipeline hooks run and are recorded in `trial_results` for 30 days, nothing applies, `agent.prompt` is not called, notices and proposals from inside a trial hook are dropped (a proposal returns `dropped`); Settings shows "would have hidden N releases; would have changed the first candidate M times". Typed tools: `tool: true` makes `<id>_<name>`, it must be in `uses.tools`, at most three (a fourth is refused when the manifest is read), the summary is capped at 300 characters, and the owner's switch (`plugin.tools`) leaves the operations reachable through `reelix`. Also from the security review: `limits.*` is the owner's within `config.set` (§11.2) |
| 3b. Previews, proposals, cards, inspection | `preview` on operations, core and plugin; `download.remove` has one. `ctx.propose` (needs `uses.inbox`; steps are the plugin's own operations or ones in `uses.runs`, never `admin`, each with a preview, at most 50): Reelix writes the Inbox item and the card (summary with totals, each step's preview, the plugin's title and reason quoted), the owner unticks steps, `proposal.decide` (owner only) re-previews each ticked step and skips it when its target changed, makes one approval record for that step just before it runs through the ledger as `plugin:<id>`, and returns a result per step; the same key replaces, proposals expire (default seven days, at most 30), and notices about them carry Reelix's summary and are never edited by `notify.before`. `ctx.card` with layouts `list` and `text`; an operation names its card kind; a button runs the plugin's operation as `plugin:<id>` (`plugin.press`), so a destructive one is refused and must be proposed; the card is built when the tool result arrives and stays in the conversation. `GenericCard`, the JSON fallback, is gone: an undeclared kind shows nothing. `ctx.reelix.read.downloads`. Reference plugin `examples/finished-cleanup` (off by default): first user of the generated form's annotations, of cards, proposals and the typed tool `finished-cleanup_scan`. `plugin.inspect` (the agent's `plugin_inspect`, and `reelix plugin inspect`): the catalogue and live state, plugin-written text passed through `outsideLine`. Verified by `npm run typecheck`, `npm test`, the web typecheck and build, the reference check, a demo server in headless Chromium (form refused and saved, secret field, hook order, trial summary, a proposal with one step unticked, approved, per-step results and two ledger entries under `plugin:finished-cleanup`, a second one declined) and one turn of a real model that used `plugin_inspect` and `finished-cleanup_scan` |
| 4. Distribution | done (2026-11-19), before the review gate, so `api` stays 0. Below |
| 4a. Sources, transactions, hashes | `server/plugins/sources.ts`: one `Source` interface with three implementations: a folder (copied without `node_modules` and `.git`), git (`<url>#<full commit id>`; a branch, tag, short id or no id is refused; fetched by commit, `.git` removed) and npm (`npm:<name>@<exact version>`; `npm pack` checks the registry's integrity hash; a range or tag is refused). `server/plugins/install.ts`: everything happens in `<data>/plugins/.staging`; npm installs dependencies in a folder holding only `package.json` and the lock file, with `--ignore-scripts` and `npm_config_ignore_scripts`; every lock entry must come from a registry with an integrity hash, so git, folder and link dependencies are refused; a shipped `node_modules` is dropped; symbolic links in the package are refused; a dependency with `binding.gyp` and no `prebuilds/<platform>-<arch>` or `.node` file is refused, and compiled code without `uses.native` is refused. The result is moved to `<data>/plugins/<id>/` with a record in `<data>/plugins/.installs/<id>.json` (source, pin, hash of every file including `node_modules`, compiled packages and install scripts found, approval). Only folders with a record load; a folder that merely appears there is ignored. A cut-off install or update is undone at the next start. `engines.reelix` (a small range reader, `semver.ts`) and `api` are checked at install (refused) and at every start (`incompatible`, not loaded, one Inbox notice per Reelix version) |
| 4b. Approval, updates, uninstall | `plugin.install` returns the approval screen, built from the manifest and the installed files only: kind, provides, requires, hooks, events, operations with their effects and typed tools, jobs, runs, network ("any site on the internet" for `*`), secrets, skills, scripts ("contains scripts the agent may run"), `agent`, `inbox`, `model`, `pi` (advanced), `native`, compiled packages found and install scripts not run. The manifest now maps each operation to its effect, and an operation whose code claims another effect is refused at activation. `plugin.review` shows it again; `plugin.approve` takes back the hash shown, so the owner approves exactly what they saw, and answers `saved-restart-needed`: code is loaded only at start. `server.restart` exists only where something starts Reelix again (`REELIX_RESTART=exit`, set by the compose files); otherwise `next` says how. The hash is checked at every load (start, switching on, a settings change): different files make the plugin `changed`, not loaded, with an Inbox item; re-approving is the same screen. `plugin.check_updates` (git: the remote's newest commit and tags; npm: newer registry versions; a folder: whether it changed) installs nothing; `plugin.update` stages a version in `.pending/<id>` with the author's changelog and the declaration difference (new and removed hosts, secrets, skills, scripts, operations, tools, seams, hooks, events, jobs, runs; changed effects; newly asked `agent`, `inbox`, `model`, `pi`, `native`), and approval swaps it in as a transaction. `plugin.uninstall` removes the code and keeps settings, secrets and stored data unless `delete_data`. All are `admin` without `agentMay`. `reelix plugin add`, `remove` and `update` confirm at the terminal. Settings → Plugins: install box, approval and update screens, uninstall dialog, the new states, a restart banner; four languages. The image installs git (it had none); npm comes with Node |
| 4c. Skills, setup skills, job prompts | A skill pack is a package with `reelix.id`, `api` and a `skills` folder, no `entry` and no other declarations; reference pack `examples/seeding-report` (off by default) with a script that calls the `reelix` command. A plugin's own skills need `uses.skills`; first user `skills/setup-jackett` in `jackett`. Skills of running plugins and packs are added to a conversation one folder at a time (`noSkills` stays on), each listed under "Guidance from the plugin <name>. It cannot authorise approvals, access to secrets, or changes to plugins." and read with that heading. The agent's shell keeps only a short list of environment variables (no server secrets) and its own session token, never the owner's, for every command it runs, plugin scripts included. A plugin with `setup-<id>` offers, when switched on, a conversation in which the agent walks the owner through its settings; keys go through the secret field. The phase-3 leftover: `plugin.job_prompt` lets one plugin's `agent.prompt` sections into background jobs, off by default, switched on the plugin's page. Verified by `npm run typecheck`, `npm test` (`packages/server/test/plugin-install.test.ts`: each source through the real loading path, a local git repository by commit and a local npm registry stub; refused branch, tag and range; an install script that would leave a mark and did not; rollback; no import before approval, proved by a mark at import; tamper, `changed`, re-approval; `incompatible`; the update difference; uninstall keeping and deleting; skill packs and the heading; the scrubbed environment; the setup skill; job prompts), the web typecheck and build, the reference check, and a demo server in headless Chromium (install from a local git repository, approval screen, approve, restart, use, a changed file, the Inbox item, re-approval, the update screen with its difference and changelog, the Restart button, the setup offer, uninstall keeping data), `reelix plugin add` and `remove` at a pseudo-terminal, and one real-model conversation that quoted the heading of both plugin skills and was refused `plugin.install` from the tool and the shell |
| 5. Contributors | done (2026-11-19), before the review gate, so `api` stays 0; nothing is published (§13.5). `reelix plugin new` (`packages/cli/src/plugin-tools.ts`) asks the kind (subtitle source, indexer, notifier, the hooks `release.filter`, `release.rank`, `organise.name`, `notify.before`, skill pack) and an id, and writes a working plugin with a test, a `README.md`, an `AGENTS.md` and a `.gitignore` into a new folder; it refuses a folder inside Reelix's own. The hook kinds and the skill pack are generated from the reference plugins (`block-words`, `prefer-freeleech`, `name-with-resolution`, `short-notices`, `seeding-report`) with the id replaced and a test that uses only `@reelix/plugin-testing`; the three seam kinds are whole templates in `packages/cli/templates/` (no small reference plugin exists for them). Until the packages are published, `node_modules/@reelix/plugin` and `plugin-testing` in the new folder link to the Reelix that wrote it. `reelix plugin check <folder>` is the checker plus the conformance suite of every seam the plugin provides, run with what the plugin's `test/check.ts` gives (settings, secrets, recorded answers, a `prepare` step; a chat channel is paired first); a provided seam without recorded answers fails. It prints one line per check, exits with 1 on a failure, then shows what Reelix logged, and needs no server; `--write-settings` writes `settings.schema.json` from the code. The built-in plugins' conformance tests moved into their own `test/check.ts`, and `npm test` runs the same check on every plugin in `plugins/`. `reelix plugin dev <folder>` starts Reelix (`startServer({ devPlugin })`, now exported by `server/src/main.ts`) in a new temporary folder with the demo's fake services (moved from `scripts/demo.ts` into `server/src/demo.ts`, which both use), on 127.0.0.1 and a free port, with a new password it prints; the folder is loaded like a built-in folder, with no install record or hash, and only this command can name it. Its code is read when the plugin starts: at the start of the command, and again when it is switched on or its settings change. `/api/status` carries `devPlugin` and the web UI shows a banner on every screen (four languages). `docs/plugin-guide.md`, linked from the README and the main design; `AGENTS.md` is written into every new plugin (source `packages/cli/templates/AGENTS.md`), not at the root of this repository, where `CLAUDE.md` is the rule file. Also found and fixed, the causes of tests that failed now and then: a stopped job runner that was only ticked by hand still ticked, and the chat bridge recorded the result of a send still on its way after it stopped, so either could reach a closed database (the test helper hid both behind a 10 ms wait, now gone); and the CLI test gave the server four seconds to start, which takes three and a half on an idle machine |
| 6. Full surface | done (2026-11-19), before the review gate, so `api` stays 0. Parts below. Declarative providers stay reserved (§4) and have no code |
| 6a. Downloader seam, `qbittorrent`, `download.before` | done (2026-11-19). `reelix:downloader@1` exactly as §7.5, of the kind one of several (`SEAM_DECLARATIONS` and the reference now state each seam's kind): the setting `downloader` (default `qbittorrent`) names the active provider; it is the owner's (like `plugins`, refused to the agent without the owner's yes) and is chosen in Settings → Downloader, which lists the running providers (`download.downloaders`). When it is not running, everything that needs it fails with `no_downloader`, saying why (no such plugin, its plugin's state, or a plugin that is up but not set up) and naming the others; Reelix never switches. Core reaches it only through `core/downloader.ts` (`app.seams`); `app.qb()`, `clients/qbittorrent.ts` and `QbTorrent` are gone. Each download records the provider that holds it (column `downloads.downloader`, migration 10); the watcher looks only at the active provider's, and an action on another's is refused. `OutcomeError` in `@reelix/plugin`: thrown by a method without `Outcome` in its type, it is recorded like a returned outcome, reaches core as an error with the outcome as its code, and is not a failure. The hub checks every `Transfer` (40-hex id, known state, `done` consistent, size and left 0 before metadata, ISO times) and `files` (torrent order, relative `/` paths). Plugin `plugins/qbittorrent` (moved client on `ctx.http.fetch`, `network: ["config:url"]`): empty lists never sent; `list` filters ids and mark itself too; `add` computes the info-hash itself (bencode, base32 magnets), returns `duplicate` without adding when qBittorrent has it, sends paused for 4.x and 5.x, and waits until the transfer is listed; marks are tags through `torrents/addTags`, which keeps the others (no read-modify-write is needed on qBittorrent); states and `done` as §7.5 (`missingFiles` and `error` are `error` with a local problem; a failing tracker in `get` is a tracker problem and the state stays); `changes` from `sync/maindata`, where only the plugin's own last response id is a usable cursor; `freeSpace` from `server_state`, `defaultFolder` from `app/defaultSavePath`; a refused login is `needs_auth`, a ban or an unreachable client `unavailable`, never failures. After a refused login or a ban the client sends no further login (2026-11-21, issue #3: the watcher asks every few seconds, and qBittorrent bans an address after a few failed logins) until the plugin starts again, which a change of its settings or password does, or its Doctor check, which the owner runs, allows one more. Operations `qbittorrent.prefs`, `qbittorrent.set_prefs` (admin; `agentMay`, which `ctx.operation` now accepts for admin operations only; plugins still never run admin operations) and `qbittorrent.torrents`; its `ctx.check` replaces Doctor's qBittorrent check, and core's new Doctor line "downloader" replaces "path mapping" for whichever provider is active. Settings `url`, `username`, secret `password`; the path map is core's, per provider id (`path_maps.downloaders.<id>`). Moved once at start (§12.2): `qbittorrent.url` and `.username` to `plugins.qbittorrent`, `path_maps.qbittorrent` to `path_maps.downloaders.qbittorrent`, secret `qbittorrent.password` to `plugins.qbittorrent.password`, an open "unreachable" Inbox item to its new key; no core store key belonged to qBittorrent. `REELIX_DEFAULT_QBITTORRENT_URL` fills `plugins.qbittorrent.url`; the pre-flight prints the new path-map key. Its fake moved to `plugins/qbittorrent/test`; recorded answers in `test/check.ts`; the downloader conformance suite in `@reelix/plugin-testing` (empty lists send nothing, ids AND mark, unknown ids left out, size of the wanted files, `files` `[]` before metadata, `add` leaves a paused marked transfer, duplicate, full answer for an undefined or unusable cursor, the deadline) runs on those recordings; a canned answer may now be limited with `times`. **The seam stays provisional**: no Transmission provider was built. Core rewritten onto the seam: `download.add` adds paused, starts a magnet only to fetch its file list, stops it, checks it, applies the selection, then starts; completion by `done`; removal proved only by a full answer, `removed` or a missing id in `list`; adoption, library removal, the nightly (free space from the downloader when the file system cannot say, and a line when the downloader is not working), the watcher and Doctor. `DownloadView.live` is a `Transfer`; the web Downloads row shows its speeds, peers, ETA and problem. Hook `download.before@1` (guard; `release` absent for a magnet given directly): after Reelix's own checks, before a `.torrent` is added, or once a magnet's files are known, when a refusal removes it again (`download_refused`); reference plugin `examples/max-size`. Verified by `npm run typecheck`, `npm test` twice, the web typecheck and build, the reference check, and a demo server (`scripts/demo.ts`, a magnet-only release added to its fake Jackett) driven from the CLI: search, `download add` of a `.torrent` and of a magnet, the watcher filing both into the library, `download remove` with data, adoption of a torrent added to the fake qBittorrent by hand, `qbittorrent prefs` and `torrents`, `download downloaders`, Doctor; an old-format data folder moved by the CLI and booted; headless Chromium showing the Downloads screen's live speeds, peers and ETA and Settings → Downloader with the choice |
| 6b. Media server, players, metadata and trends sources, `subtitle.pick` | done (2026-11-19). Four seams, each `provisional` (no second real service was built for any): **`reelix:media.server@1`**, one of several, chosen by the owner's setting `media_server` (default `jellyfin`; owner only, like `downloader`) in Settings → Media server, which lists the running providers (`library.media_servers`); it is optional, so without it filing goes on and only history and server links are missing. Core reaches it through `core/media-server.ts`: filing and library removal tell it each folder through the path map per provider (`path_maps.media_servers.<id>`), falling back to `refreshAll`; `trends.ts` reads watch history through `items` (`played`, `favourite`) and chooses the users itself with the provider's `watchUsers`; `playback.ts` builds its index from `users`, `info`, `items`, `nextUp` and `episodes`; core's new Doctor line "media server" checks that the server has a library holding each of Reelix's library folders (`libraries`). Plugin `plugins/jellyfin` (client moved, on `ctx.http.fetch`, `network: ["config:url"]`): settings `url`, `public_url`, `watch_users`, secret `api_key`; operation `jellyfin.refresh` (a full scan); its `ctx.check` replaces Doctor's Jellyfin line; a refused key or an unreachable server is `OutcomeError`, never a failure. **`reelix:player@1`**, many: links in the order of the new setting `players` (default infuse, swiftfin, jellyfin), others after; plugin `plugins/players` with the providers `infuse`, `swiftfin`, `jellyfin`, which get the server's ids in `PlayRequest.server` from core, never from the jellyfin plugin; a link with `javascript:`, `data:`, `file:` and the like is refused by the hub; the web app remembers the player by provider id and shows the provider's label. **`reelix:metadata.source@1`**, many: plugins `plugins/bangumi` (`find`, `fromLink`, `enrich` with the main episodes) and `plugins/douban` (`fromLink`, `enrich` with the rating, from the public page; operation `douban.rating`, which runs core's new `title.enrich` and `title.set`); `findTitle` asks the sources for a link, finds the hit in TMDB and merges the source's ids and rating (TMDB wins on name, year and ids), and `anime.map` finds Bangumi entries and their episodes through the seam. Titles keep a rating per source (`titles.ratings_json`, migration 11; `douban_rating` moved into it and dropped). **`reelix:trends.source@1`**, many: Bangumi's provider answers with its weekly airing calendar (`/calendar`), most watched first; Bangumi's API has no trending list, so this is the honest nearest thing (docs/trends.md §3). Core adds the hits after TMDB's list, found in TMDB by name and year, unmatched ones left out, duplicates removed by title id, and offers them to "For you". **Hook `subtitle.pick@1`** (pipeline) on the scores of an archive's files in `placeSubtitles`; reference plugin `examples/prefer-srt` (off by default); the result's `why` names the plugin and reason, recorded as reasons of kind `scored`. Moved once at start (§12.2): `jellyfin.url`, `.public_url`, `.watch_users` to `plugins.jellyfin`, `jellyfin.username` (unused) dropped, `bangumi.base_url` to `plugins.bangumi` when not the default, `path_maps.jellyfin` to `path_maps.media_servers.jellyfin`, secret `jellyfin.api_key` to `plugins.jellyfin.api_key`; `REELIX_DEFAULT_JELLYFIN_URL` fills `plugins.jellyfin.url`; the pre-flight prints the new path-map key. `app.jellyfin()`, `app.bangumi()`, `clients/jellyfin.ts`, `clients/bangumi.ts`, core's `jellyfin.refresh` and `douban.rating`, `doubanPage`, `BROWSER_UA`, the hand-written Jellyfin fields of Settings and Doctor's Jellyfin and Bangumi lines are gone. Fakes moved into the plugins (`plugins/jellyfin/test/fake-jellyfin.ts`; new `plugins/bangumi/test/fake-bangumi.ts`, used by the demo); recorded answers in each plugin's `test/check.ts`, run by the four new conformance suites in `@reelix/plugin-testing`. Contracts changed from the drafts where the code proved them incomplete (§7.6, §7.7, §7.9, §7.10): `watchUsers` on the media server; `ItemsQuery` without `episode`, `ids` and `sort: "name"`, `ServerItem.episodesPlayed`; `ServerEpisode` without fields nothing reads; `links` takes every request of a screen at once and answers one link or null each; `PlayRequest.series`; `MetaHit` with `names`, `series`, `episodes`, `rating`, `note`; `enrich(ids)`; `Enrichment` with `rating` and the source's episode numbers and air dates only; `related` left out of `TrendsSource` (no provider has it), `TrendHit.names`. Behaviour changes: `jellyfin.refresh` no longer takes `paths` (filing tells the server by itself); `library.play_links` says `media_server_error`, not `jellyfin_error`; a play link carries `label`; the Douban rating shows as its source's label ("Douban", "豆瓣" in Chinese); Bangumi links search TMDB as a show only when Bangumi says TV; a title found through a Douban page by name is now linked to it too; the "Refresh Douban rating" button shows only while the douban plugin runs. Verified by `npm run typecheck`, `npm test` twice, the web check and build, the reference check, `reelix plugin check` of each new plugin, and a demo server in its own data folder (fake Jellyfin, Bangumi and TMDB): Doctor's "media server" and "jellyfin" lines, `library media_servers`, `anime map` with Bangumi lined up to TMDB S1, Trends without a duplicate Frieren, a download filed, `title play` and `library.play_links` with Infuse and Swiftfin links, `jellyfin refresh`, "For you" made from the owner's history (users owner, 2 titles; no model set, so no picks), and headless Chromium showing a library poster's player menu, the remembered choice and Settings → Media server; an old-format data folder moved by the CLI and booted. Not verified against real Jellyfin, Bangumi or Douban. |
| 6c. Translator, model access, raw pi extensions, routes, `browser`, `agent.tool` | done (2026-11-19). **`reelix:translator@1`**, one of several, chosen by the owner's setting `translator` (default `model-translator`; owner only, like `downloader`) in Settings → Models, which lists the running providers (`subtitle.translators`). Core keeps the glossary, the review, pacing, resuming, the line-count check and the file; each chunk goes to the active provider, looked up at every chunk, and a provider that is off, restarting or answers with an outcome pauses the translation with the reason (it is never switched). The contract changed from the draft where the code proved it incomplete (§7.8): `TranslateJob` carries `novelty`, `sign` per line, the glossary's `note`, `tone`, the context as source and translation pairs and the owner's `instructions`, and has no `from` or `style` (nothing read them); the answer is `{ lines, terms?, model? }`, because new terms join the glossary and the report names the model. The hub checks that only lines asked for come back, each once and not empty. Plugin `plugins/model-translator` holds the chunk prompt and the reading of the answer unchanged (an unreadable answer is no lines, so the three-strikes rule still applies; `unsure` and `borrowed` as before); core's tests run the translation through it. **`ctx.model.complete`** (`uses.model`: `true` or `{ roles, unmetered }`, shown on the approval screen and in the update difference): through the existing router; the role is `background` unless the manifest asks for more (a built-in's ask, or an approved plugin's, is allowed until the owner takes it back); at most 100,000 characters; a daily budget in US dollars per plugin (`limits.plugin_daily_usd`, default $0.25, or the owner's own through `plugin.model`, owner only), reset at local midnight; a used-up budget, a role not allowed and no model that can answer are the outcome `unavailable`, not failures. Spend is recorded under `plugin:<id>`, with the agent turns of the plugin's jobs added to it (they still count against the background cap); the plugin page shows spend, budget, roles and the no-budget switch. Translation's exemption from the cap is `model-translator` asking for `unmetered`, which the owner can switch off on its page. All spend days are now the local date (the background cap too, which now resets at local midnight). "For you" got its own scope `suggestions` and limit `limits.suggestions_daily_usd` (default $0.25); it was recorded as `translation` and uncapped. **`ctx.pi`** (`uses.pi`): the extension runs for every session with pi's API and `{ threadId, kind, notice }`; its tools must be `<id>_<name>` and not taken (Reelix's tools, other plugins'), else `registerTool` throws; its tools and handlers do nothing once the plugin stops, and sessions are reopened before their next run when extensions change; Reelix's own `tool_call` and `tool_result` handlers are loaded last; `session.bindExtensions()` is called, so `session_start` fires, and a plugin handler's error counts against it. **`ctx.route`**: `/api/plugins/<id>/<path>` behind the sign-in, one dispatch route registered at start (`server/plugins/routes.ts`); JSON, an attachment (HTML, SVG, XML and script types refused) or server-sent events; `nosniff` and a `default-src 'none'; sandbox` policy on every answer; a refusal is 400, a plugin that is not running 404 saying so. **`ctx.folder()`** (`<data>/plugin-data/<id>`, deleted with its data at uninstall), `ctx.reelix.read.answer` and `ctx.reelix.read.proxy`, all first used by `browser`. Event **`session.ended`**, emitted when a session is unloaded (archived, reopened, a job's a minute after its run). Plugin **`plugins/browser`**: `server/browser.ts` moved whole; its ten tools through its raw pi extension, files into the session's folder; its four routes with the live view as an event stream; `session.ended` releases the session's tab; idle close; Chromium closed when the plugin stops, so at shutdown too; the profile in its folder, moved once from `<data>/browser-profile`; settings `chromium` and `headed`; `REELIX_CHROMIUM` fills `plugins.browser.chromium`. `startBrowser`, `HostOptions.extraTools`, `ToolContext.extraTools`, `paths.browserProfile`, `/api/browser/*` and `REELIX_BROWSER_HEADED` are gone; the web live view uses the new paths; `playwright-core` is a dependency of the repository root, since built-in plugins are not installed by the installer. Hook **`agent.tool@1`** (guard): every tool call except the shell, with the tool, its input, the operation it runs (typed tools and the `reelix` tool) and the session; a block reaches the model as outside text after redaction; not run in trial; reference plugin `examples/no-delete-without-ask` (off by default) blocks destructive operations in background jobs. `@reelix/plugin-testing`: `model` (canned model answers), `t.piSession`, `t.route`, and the translator conformance suite (only lines asked for, an unreadable answer, a model that cannot answer, the deadline) run on recordings in `test/check.ts`. Also: the agent host's one-minute buffer timer no longer keeps a process alive; `TranslationPaused.retryAfterMs` (never read) is gone. Verified by `npm run typecheck`, `npm test` twice, the web check and build, the reference check, a real `AgentHost` session test with a scripted model (`server/test/pi-extensions.test.ts`), and a demo server in its own data folder with qwen3.8-flash: a real translation of six lines into French (spend under `plugin:model-translator`, the glossary and review under `translation`), a second one paused by a budget of $0 with the reason in the Inbox, a chat in which the agent opened a local page with `browser_open` and read it, the live view of that tab in headless Chromium, the tab gone after the conversation was archived, a background job whose `download.remove` was blocked by `no-delete-without-ask` (nothing reached the ledger), and Chromium gone after the server stopped. Found: a model without cost data in pi spends $0, so a USD budget never trips for it; only $0 refuses. |
| 7. Ecosystem depth | done (2026-11-19), before the review gate, so `api` stays 0. **Plugin-owned seams and events**: a manifest's `owns.seams` (`<id>:<name>@<n>`) declares each method's time limit and a JSON Schema of its result, `owns.events` (`<id>:<name>`) each event's payload schema; the contract is data, checked by Reelix on every answer and payload (`SeamHub.define`, `schemaProblem`). A seam exists while its owner runs, is of the kind many, and only the owner calls it (`ctx.seams.call`, one answer or error per provider; a broken answer counts against the provider); only the owner emits its events (`ctx.emit`), delivered like core events, never from a hook in trial. Others provide (`ctx.provide`) and listen (`ctx.on`) with the names in `uses.provides` and `uses.events`, and must list the owner in `requires.plugins`; the owner's package exports the types (`exports["./contract"]`, an `import type`). `plugin_inspect` lists them (`pluginSeams`, `pluginEvents`, with providers and listeners), and the generated reference has a section built from the manifests in this repository. First users, all off by default: `examples/release-tags` (owns `release-tags:tagger@1` and `release-tags:tagged`; its `release.rank@1` handler keeps the order and adds the tags as notes), `examples/tag-hdr` (a tagger: HDR10, HDR10+, Dolby Vision, HLG) and `examples/hdr-alert` (listens; one Inbox notice per title). **`requires.plugins`** (`{ "<id>": "<range>" }`, ranges by the existing reader, `understoodRange` refuses one it does not understand): plugins start in the order of their requirements and stop in the reverse; a plugin whose required plugin is missing, not running or outside the range is `waiting`, and `waitingForPlugins` (Settings, `plugin.list`, `plugin.enable`) says what is there instead; a circle of requirements makes each plugin in it `failed`, naming the circle, at start and again when one is switched on; switching off a plugin others require goes through the existing dependents question (CLI second yes, web dialog). Every approval screen has `requirements` (each required plugin, its version and state here, satisfied or not), and declarations and their difference have `requiresPlugins` and `owns`. `@reelix/plugin-testing`'s `PluginCheck` has `plugins` (folders of required plugins, started with it) and `pluginSeams` (calls checked against the owner's contract). **The agent writing a plugin**: core skill `skills/writing-plugins` (facts from `plugin_inspect`, the reference, the guide; `reelix plugin new`, `npm test`, `reelix plugin check`, propose); `plugin.propose { folder, note? }` (`write`, refused to plugins) copies the folder into `<data>/plugins/.proposed/<pp_id>/` (no `node_modules`, `.git` or links, no dependencies of its own, an id Reelix does not have) and adds an Inbox item in Reelix's words; `plugin.proposal` is the manifest-only approval screen with `what: "proposal"`, the proposer's note as outside text, the files and a `git diff --no-index` against the previous proposal of the same plugin, which a new one replaces; `plugin.proposal_decide` (admin, owner only) approves exactly the hash shown, installs the copy as a folder install with hashes (source: the agent's folder) and approves it, `saved-restart-needed`. Inbox card and approval dialog in the web app, four languages. **Plugin knowledge out of core**: `describeConfig` no longer names qBittorrent, Jackett, Jellyfin or Telegram; a manifest's `describe` template (`{setting}`, `{list.*.field}`, `{secret:<name>}` as set or missing) gives one line per running plugin, marked with `outsideLine`. `ENV_DEFAULTS` keeps only `REELIX_DEFAULT_MAGPIE_URL`; a manifest's `env` (`REELIX_*` to a setting inside the plugin's settings) is applied by the plugin manager at start, only for plugins shipped with Reelix or named at start, never for an installed one; `loopbackAddresses` checks those settings, naming the compose service after the plugin. docker-compose and the Dockerfile are unchanged. Behaviour changes: an unknown event in `uses.events` and a seam of a plugin not required are refused when the manifest is read, not at activation; the dependents question now reads "… need X: they require it, or it is the last provider of a seam they need"; the demo's fake Jackett has one more release (`Sintel.2010.2160p.UHD.BluRay.DV.HDR10.HEVC-XYZ`). Verified by `npm run typecheck`, `npm test` twice, the web check and build, the reference check, and a demo server in its own data folder: the trio on a search (note "Tags: Dolby Vision, HDR10", the hdr-alert notice once), `plugin inspect`, `config show` with the plugins' lines, switching off release-tags at a pseudo-terminal (no, then yes: all three off), two installed plugins requiring each other refused after a restart with the circle named and the install screen showing "requires plugins: cycle-a ^0.1.0 (has 0.1.0, failed)", and a conversation with qwen3.8-flash asked to write a plugin hiding releases from the group XYZ: it read the skill, used `plugin_inspect` and the reference, ran `reelix plugin new`, `npm test` and `reelix plugin check`, proposed `hide-group`; the files it read back arrived as outside text; asked to install it itself, both `reelix plugin install` in its shell and the `reelix` tool were refused; the owner approved it in the Inbox in headless Chromium; after a restart it was active and hid the XYZ release. |
| 8. Isolation and screens | done (2026-11-19), before the review gate, so `api` stays 0. **`runtime: "process"`** (`server/plugins/process.ts`, `child.ts`, `channel.ts`): the manifest's `runtime` is `in-process` or `process` (refused with `uses.pi` or `uses.native`); the owner's choice (`plugin.runtime`, `admin`, owner only; a switch on the plugin's page) overrides it for any plugin that can run there, and a running plugin starts again where it now belongs. The plugin's code is unchanged: the child loads the entry with the same loader and gets a `ctx` whose calls go over a message channel (structured clone; Node's IPC at first, framed messages on the child's fourth stream since the review below) to the real `ctx` in Reelix, so every rule of §6 to §11 applies there as before. Functions become handlers called by number (provider methods, also of a class, `run`, `preview`, hooks, jobs, tasks, checks, listeners, routes, and `toText`, `recordInput`, `recordOutput`, which the registry now awaits); a signal becomes a number whose abort is sent on and a signal built on the other side; an async iterable (a route's stream) becomes `next`/`return` calls; errors cross as kind, code, message and data (`OperationError`, `OutcomeError` and Reelix's coded errors keep their meaning); properties an object hides (TypeBox's kind) cross and are hidden again, so the settings schema works in Reelix as before. A call back from the plugin names the call of Reelix's it serves and runs in that call's async context, so a hook in trial and `ctx.agent.run` inside a job work as inside for an honest plugin; Reelix accepts only a call it made to that process and still waits for, but cannot tell which of those the plugin's code really serves, so neither is a limit on a hostile plugin (nor is it inside Reelix). `ctx.t` stays synchronous (`core/messages.ts`, split from `i18n.ts`, is all of Reelix the child loads besides `@reelix/plugin`) and follows language changes; `ctx.log` is a message; `ctx.signal` is the child's own, aborted when the plugin stops. Time limits and failure counting are unchanged (they sit on Reelix's side). A process that ends by itself is a failure of the registration `process`; the plugin is `failed` with the reason and starts again after a growing delay (the task delay, doubling, at most 2 minutes, reset after a minute of health), and five in ten minutes switch it off with the usual Inbox notice. Disposal ends the process (SIGTERM, SIGKILL after 2 s) after everything else is undone; the process keeps Reelix's event loop alive only while Reelix waits for it. **What holds in the child** (rewritten after the review of phases 3 to 8, below; §11.7 has the three layers): Node's permission model limits reading to the plugin's folder, its data folder and the files the child runs, writing to its data folder, and forbids child processes, workers, addons and WASI; Node 22's model does not cover the network, signals or `node:sqlite`, so Reelix's code in the child refuses Node's modules outside a list and removes the global `fetch`, `WebSocket` and `EventSource`. That second part is a refusal inside the process, not a guarantee of the operating system. The network is `ctx.http.fetch` (§11.4). The approval screen (`reviewText`, the web dialog) states the runtime and whether the plugin could run in a process; declarations carry `runtime`, `processAllowed` and `screen`, and their difference flags `in-process` and `screen`. **First user: `jackett` runs in a process by default.** Chosen over `subtitle-sites` because it uses only `ctx.provide`, `ctx.operation`, `ctx.check`, `ctx.secret` and `ctx.http.fetch` (including a home-network `config:` host and redirects, and `.torrent` bytes across the boundary), and the demo's fake Jackett exercises it end to end, where `subtitle-sites` would reach real sites. `examples/finished-cleanup`'s whole test runs once inside Reelix and once in a process. **Screens**: a manifest's `screen: { entry, title }` (an `.html` file inside the folder; `screen.title` in its locales); `GET /api/plugin-screens/<id>` (behind sign-in, only while the plugin runs) returns one document: Reelix's CSP (`default-src 'none'`, inline scripts and styles, `data:` pictures and fonts, `connect-src 'none'`, no frames, workers, forms or base) and the `window.reelix` bridge ahead of the plugin's HTML, with scripts and style sheets from the screen's folder put inline, at most 1 MB. The web app shows it in `<iframe sandbox="allow-scripts" srcdoc>` (`PluginScreen`, under a Plugins group in the sidebar and in More on a phone) and talks to it through a message port it hands only to the frame's first document (its `ready`, from origin `null`, before the frame has loaded); a later load of the frame closes the port, so a site the frame navigates to never gets it: `run` goes to `POST /api/plugin-screens/<id>/run`, which runs only `<id>.<name>` operations, as `plugin:<id>`, so a destructive one needs an approval record; `context` sends the language, the theme tokens and the scheme. The browser sends the owner's cookie when the frame navigates itself to `/api`, so the API middleware now refuses requests whose `Sec-Fetch-Dest` is a frame. First user: `examples/finished-cleanup` (off by default) lists what `scan` finds and asks through `propose`. **Reserved, no code**: `runtime: "mcp"` (the design says "possibly" and nothing needs it yet) and trust signals in the index (the index does not exist; it waits for the owner, §13.5). Behaviour changes: `jackett` runs in a process, so its restart after a change of settings or secret takes about half a second (a test that waited 200 ms now waits for it); an unknown `runtime` names `in-process` and `process`; `GET /api/*` into a frame is 403. Verified by `npm run typecheck`, `npm test` twice, the web check and build, the reference check, and a demo server in its own data folder: `jackett` in its process (`--permission` flags in `ps`, environment `LANG` only, working folder its data folder) answered `jackett.indexers`, `release.search` and Doctor, and `download.add` fetched the `.torrent` through it into the fake qBittorrent; switching it inside and back out worked. A hostile plugin installed from a folder (the approval screen said "runs: in a process of its own") was refused reading `secrets.yaml`, `reelix.db`, `owner.token` and the data folder, opening the database with `node:sqlite`, writing outside its folder, spawning a process, starting a worker, connecting to Reelix's socket, a raw TCP socket (by import and by `process.getBuiltinModule`), `node:http`, the global `fetch`, and `ctx.http.fetch` to an undeclared host; writing its own folder worked. `packages/server/test/plugin-screen.e2e.ts` in headless Chromium against that demo: the screen listed a finished download and proposed it; from inside the frame, `document.cookie`, `localStorage`, the parent's document and location, `fetch` and XHR to `/api` (with credentials too), an image from `/api`, a form, a pop-up and navigating the page all failed, nothing it sent to `/api` was answered, core and other plugins' operations were refused, and navigating the frame itself to `/api` got 403 (before that change it got 200 with the owner's cookie). |
| Review of phases 3-8 (2026-11-20) | An independent review proved four ways out of a plugin's process and found two major and seven minor problems; each was reproduced with a hostile plugin through the real `startProcess` and child before it was fixed (`server/test/plugin-hostile.test.ts`, `plugin-review-8.test.ts`, three tests in `plugin-install.test.ts`). **Module hooks**: a plugin registered its own `module.registerHooks` resolver in front of Reelix's and got `node:net`, and through a re-export `node:sqlite`, which wrote Reelix's database (it ignores `--permission`); the child now takes `ALLOWED_MODULES`, an allow-list, in place of a list of refused modules, checks the resolved URL (so `node:net?x`, `#x` and `data:` re-exports are caught), and makes `registerHooks` and `register` throw (`syncBuiltinESMExports`). **Internal modules**: `_http_client` and the rest opened sockets, also to Reelix's socket; the allow-list refuses them, and `tty`, `v8`, `vm`, `os`, `module`, `async_hooks` and `diagnostics_channel` with them. **SIGUSR1**: a plugin's signal opened Reelix's debugger on 127.0.0.1:9229; every start passes `--disable-sigusr1` (Dockerfile, `bin/reelix`, `npm run reelix` and `server`, `scripts/demo.ts`, the README), `startServer` ignores the signal for a start by hand, the child has the flag too, and signals from the child go only to itself. **Reading through a link**: `--allow-fs-read=<repo>/node_modules` let `node_modules/@reelix/core/../../X` read the repository; grants are now the real paths of exactly what the child needs, and a granted folder holding a link out stops the child from starting; `.git` is in `.dockerignore`. Also found while closing these and closed: `process.stdout` and `process.stderr` were network sockets whose class opens any socket (now plain writers), `process._getActiveHandles()` listed the IPC pipe and those sockets (removed), `process.kill(0)` and `-1` reached Reelix's process group and every process of the user, and the checks used built-ins the plugin could replace. The channel no longer uses Node's IPC, whose reader buffered a message of any size (a 90 MB one ran the test's heap out): framed messages on the child's fourth stream, at most 80 MB, checked from the length before reading; output lines are cut at 16 KB; the child's working folder is `/`. **Major**: concurrent `ctx.model.complete` calls all passed the budget check before any recorded its spend (six calls reached a model with a budget for two); one call of a plugin runs at a time now. A screen's frame that navigated to another site kept the bridge (the page answered any message from that frame); the page now hands a `MessagePort` to the frame's first document only and closes it when the frame loads again. **Minor**: a screen and the settings schema file are read only after the hash is checked again; screen files are checked for size and kind before they are read; an update that leaves the owner's choice of a process says so in its difference and stays off until the owner chooses again; a broken %-escape in a route path is 400; `download.*` hashes need at least 6 hex characters and match one download. Not changed, now documented: an approved update loads before the restart when something starts the plugin again (§13.3); code read lazily after the hash check (§11.3); `via` already named only a call still waiting on that channel, but nothing can tell which of them the plugin serves, so trial and "inside a job" are not limits on a hostile plugin. §11.7, this table's phase 8, the guide (§2, §5.26, §5.27), the reference, the approval screens and the runtime switch's help now say what Node enforces, what only Reelix's code in the process does, and that the real boundary is a second system user and namespace. Verified by `npm run typecheck`, `npm test` twice (365 tests each), the web check and build, the reference check, the old code failing the new tests (35 ways out open; six model calls in flight; a 500 for a bad escape; a 90 MB message ran the test's heap out), `plugin-screen.e2e.ts` in headless Chromium against a demo in its own folder (27 of 27; with the old page and bridge the navigated site received the context and the results of five runs), and that demo with `jackett` in its process: working folder `/`, environment `LANG` only, release search and `download add` of a `.torrent` through it, and `kill -USR1` to the server opened no debugger. |
| D2. The agent's shell and plugins' processes as other users | done (2026-11-20), §11.3. **Built:** three users in the image (`PUID:PGID` in group `reelix`, `reelix-agent`, `reelix-plugin`); `docker/entrypoint.sh` starts as root, gives `/data` to `PUID` and group `reelix` where needed, and starts Reelix with `setpriv` (umask 002, capabilities `setuid`, `setgid`, `kill` only, bounding set the same, `no_new_privs`); `server/src/isolation.ts` (`isolateData` at start, `pluginFolderAccess`, `runAs`); pi's shell through `shellAs(agentCommand)`; plugins' processes through `pluginCommand`; `agent.sock` with `agentSocketApp` (a session's token required, the owner's refused), used by the CLI whenever `REELIX_TOKEN` is set; pi's file tools limited by `fileToolRefusal` in every setup; `config.yaml` written 0600; `user:` removed from the compose files (`PUID`/`PGID` variables instead). **Tested without Docker** (`server/test/isolation.test.ts`): the switch, the `setpriv` command, the data folder's modes with this user's own group in place of the two users, `shellAs` (quotes, exit code), the file-tool limits (links, links to nothing yet, /proc, searches over the data folder), the agent's socket and the CLI on it. **Tested in a real container** (`reelix:d2-test`, built from this Dockerfile for the first time; fresh data folder and media folder): a real chat turn through the web API with a scripted model, whose `bash` calls ran in the agent's shell as `reelix-agent` with no capabilities and `no_new_privs`; from there reading `secrets.yaml`, `owner.token`, `reelix.db` (and its WAL), `config.yaml`, `pi/`, `sessions/`, listing `/data` and `plugin-data/`, writing `plugins/`, `plugins/.installs/`, `/app/plugins/jackett`, another plugin's folder, connecting to the owner's socket, signalling Reelix, reading its environment, and `setpriv`/`su` to root were all refused by the system; `reelix config get/set` worked with the session's token, `secret set` was refused as the agent, and `reelix` without a token or with a made-up one was refused, as was a raw request to `agent.sock` without a token (401); the agent wrote into the media folder, its workspace and notes; a timed-out command was killed (no `sleep` left); pi's `read` of `secrets.yaml` and `write` into `plugins/` were refused by `fileToolRefusal`; plain `node -e` probes as `reelix-plugin` and `reelix-agent` (no permission model, no `child.ts`) got `EACCES`/`EPERM` for the secrets, database, token, settings, other plugins' folders, `plugins/`, the owner's socket and signals to Reelix; `jackett` ran as `reelix-plugin` with no capabilities (`/proc/<pid>/status`), stopped and started again when the owner switched it off and on through the web API; Reelix had exactly `setuid`, `setgid`, `kill` and `no_new_privs`; web UI 200 and the health check healthy; `reelix doctor` by `docker exec -u PUID:PGID`; starts with `--user` or `PUID=0` refused. **Upgrade** tested on a data folder made by the same image started the old way (as `PUID`, no entrypoint: everything ran as one user, as before) plus files left by root: after one start every file belonged to `PUID`, the modes and groups were as in §11.3, and the agent could append to its old notes and workspace files and `jackett`'s user to its old state file. Not done: a network namespace for plugins' processes; one user per plugin |

**Built: phases 1 to 8.** Remaining, reserved or waiting for the owner: the review gate and declaring `api` 1; a network namespace for plugins' processes (§11.7); publishing the packages and the repository, and the index (with its trust signals); `runtime: "mcp"`; declarative providers; standing approvals; second real providers for the provisional seams (§21, phase 6b).

**Review gate: the owner chose on 2026-11-20 to review the built API before declaring `api: 1`; until then `api` stays 0 and contracts may still change.**
