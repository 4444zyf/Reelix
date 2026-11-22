# Reelix: design

Date: 2026-11-17
Status: third draft. Revised after two independent reviews (§16), then updated with the owner's decisions on §0 (2026-11-17). Not re-reviewed since. **Implemented 2026-11-17 (all build steps in code; see §17); not yet installed on the NAS.**

**How to read the labels.** **(agreed)** means settled with the owner in the design interview on 2026-11-17. **(proposed)** means decided while writing or revising this doc; the owner has not confirmed it. Anything without a label is detail that follows from a labelled decision.

## 0. Decisions waiting for the owner

These either change something agreed in the interview or are large enough that they should not pass unnoticed.

**The owner's answers, 2026-11-17:** A is changed to a Telegram bot. B is reversed: the owner chose full access for background jobs. C to I are accepted as recommended. Nothing in this table is still open. Items in §13 are to be verified during implementation, not before.

| # | Decision | Why | Section |
| --- | --- | --- | --- |
| A | **A Telegram bot in v1**: notices with images, answers from anywhere, and chat. The interview left phone notifications out of v1; the first draft proposed a one-way push, and the owner chose Telegram. | "Send me the QR code" is no use if it waits in a web page at home, and a one-way push cannot carry the answer back. | §7.4 |
| B | **Background jobs have the same full access as chat threads**: shell, file writing, everything. The second draft proposed removing their shell; the owner chose full access. | The owner wants the agent able to fix things unattended, and accepts the risk set out in §9. | §4.2, §9 |
| C | **Build order revised:** a pre-flight check on the NAS comes first; the job runner, spending cap and Telegram bot move earlier. | The one decision that makes or breaks hard links (how folders are mounted) is made before Reelix runs. | §11 |
| D | **Reelix runs as the same user and group as qBittorrent.** | Linux refuses to hard-link a file the linking user neither owns nor can write. | §3.2 |
| E | **The trash is refined:** removing a library entry whose data still exists in the download folder just removes the link (restorable by re-linking); only a last remaining copy goes to the 14-day trash. | The agreed design would have failed across some NAS folder layouts and could quietly hold large files. | §9 |
| F | **Douban without imitating its phone app.** IDs come from subhd; ratings from the public page. | The app-imitation route uses copied keys and forged signatures, and can die any day. | §5.1 |
| G | **Navigation changes from MovieCopilot-Frontend:** Dashboard and Explore are dropped; Chat, Inbox, Library and Activity are added. | The poster wall moves to Library; trending and recommendations are out of v1. | §7.1 |
| H | **Passwords and keys are typed into a secret field**, never into chat, and each service can have a proxy or alternative address. | Chat text goes to the model provider and into saved conversations. TMDB and most model providers are commonly unreachable from mainland China without a proxy. | §10 |
| I | **RAR-packed releases are avoided at choice time**; one that arrives anyway is unpacked only with the owner's consent. | Packed files cannot be hard-linked; unpacking doubles the disk space. | §5.4 |

## 1. What it is

Reelix is a self-hosted assistant for one person's movie, TV and anime collection on a NAS. You talk to it; it finds a title, picks a release, downloads it, files it into a Jellyfin-ready library by hard link, and fetches Chinese subtitles. It is built around the [pi](https://github.com/earendil-works/pi) agent, and the agent is the product, not a feature added to an app.

"Native agentic" means three things here:

1. **The agent works on the real system.** It has a shell and file access inside its container, in chat and in unattended background jobs alike. It can look at any folder on the media volume, diagnose a messy download and fix it, without anyone having written a tool for that case.
2. **The agent configures the system.** It inspects the NAS before installation and recommends the layout, then sets up Reelix, and can change qBittorrent's and Jackett's own settings when asked.
3. **Judgement replaces rule systems.** Reading an odd release name, deciding which title a release belongs to, choosing between releases, deciding what a stray file is: these go to the model, guided by a plain-text note of the owner's taste. Exact code is kept only where a mistake costs something: links, names, qBittorrent calls, money spent.

MoviePilot (§14) is the main reference for what goes wrong in this domain. It is a source of knowledge, not a template.

### Principles

- **One operation, three faces.** Every important function is defined once and is reachable as an agent tool, a `reelix` command and a web UI action. All three leave the same record. **(agreed in substance: the owner asked for native tools and human interfaces for important features)**
- **Soft limits, hard invariants.** In conversation the agent obeys the owner, including when asked to delete. **(agreed)** A few things are fixed in code because they are correctness or cost, not permission (§9).
- **State is written down when it is known.** What a download is for is recorded when it is added, never guessed when it finishes.
- **Look at the thing itself.** Where a name can mislead, check the content: the file list inside a torrent, a video's running time, the text inside a subtitle file.
- **The agent asks only on a real tie**, and remembers the answer.
- **Text from outside is data.** Release names, web pages, NFO files and subtitle contents are never treated as instructions.

## 2. Scope

**v1**, for movies, TV and anime **(agreed unless marked)**:

1. Identify a title, from anything: a name, a Douban or TMDB link, a magnet, a screenshot of a poster.
2. Search releases and choose one.
3. Download with qBittorrent; files stay seeding where they are.
4. Hard-link finished files into a Jellyfin-standard library.
5. Find, choose, clean up and place Chinese subtitles.
6. Adopt downloads that already exist on disk.
7. Follow a show: fetch new episodes as they air.
8. A nightly tidy-up and a morning summary. **(proposed)**
9. A Telegram bot: notices with images, answers, and chat from anywhere. **(agreed 2026-11-17, decision A)**

**Not in v1 (proposed; the owner left scope to recommendation):** recommendations and trending, music, private-tracker account features, plugins, other chat channels, multiple users, automatic quality upgrades of files already in the library, automatic removal of old seeding torrents, learning from Jellyfin's watch history. The last three are the first candidates for v2.

## 3. Architecture

One Docker container on the NAS, one Node process (TypeScript, Node 22+). **(agreed)**

```
┌───────────── Reelix container (runs as qBittorrent's user, not root) ─────────────┐
│                                                                                   │
│  Web UI (static)  ◄── HTTP + event stream ──►  Server                             │
│                                                  │                                │
│                    ┌─────────────────────────────┼─────────────────────────┐      │
│                    │                             │                         │      │
│           pi sessions (SDK)               Operations (core)        Job runner     │
│   chat threads and background jobs:     one registry, three faces  + watcher      │
│   shell + files + tools                          │                 + Telegram     │
│          │            │                    SQLite, config,                        │
│     `reelix` CLI   browser tabs            notes, ledger                          │
│                       │                                                           │
│                 Chromium (saved profile)                                          │
└───────┬────────────────────────┬─────────────────────────────┬────────────────────┘
        │ /media (ONE mount)     │ /data (Reelix's own)        │ network (optional proxy)
   downloads + library       config, db, notes, skills,   qBittorrent, Jackett, Jellyfin,
                             sessions, browser profile    TMDB, Bangumi, subtitle sites,
                                                          model provider, Telegram
```

### 3.1 Repository layout (proposed)

An npm-workspaces monorepo:

| Package | Contents |
| --- | --- |
| `packages/core` | Operation registry, service clients (qBittorrent, Jackett, TMDB, Bangumi, ASSRT, subhd, Jellyfin, Telegram), organiser, subtitle pipeline, database, config. No pi, no HTTP. |
| `packages/cli` | The `reelix` command, generated from the registry. |
| `packages/server` | HTTP API, pi host (sessions, tools, UI bridge), job runner, completion watcher, browser manager. |
| `packages/web` | The web UI. |
| `skills/` | Built-in pi skills. |
| `preflight/` | The pre-install check (§10.1). |
| `docs/` | Dated design docs. |

### 3.2 Mounts, users and data

- **`/media`**: the common parent of the download folder and the library, mounted **once**. Hard links do not cross mount points: with two separate mounts the link fails even when both are on the same disk. On Synology, two shared folders cannot be hard-linked to each other at all, even on one volume; downloads and library must sit under one shared folder. The pre-flight check (§10.1) finds this out before installation.
- **User and group (agreed 2026-11-17, decision D).** Reelix runs with the same user and group IDs as qBittorrent. Linux only lets a user hard-link a file they own or can write. A link also keeps the original file's owner and permissions, so Jellyfin must be able to read files as qBittorrent wrote them; the doctor check covers this.
- **`/data`**: Reelix's own state.

```
/data
  config.yaml         settings, readable and editable (§10)
  secrets.yaml        passwords and API keys, readable only by Reelix's user
  reelix.db           the database
  notes/              preferences.md, library.md
  skills/             skills the agent has written for itself (§4.4)
  sessions/           saved conversations
  pi/                 pi's own settings, sign-in and model list
  plugin-data/        plugins' own folders; browser/chromium-profile: cookies and logins persist
  workspace/          the agent's working folder and scratch space
  backups/            nightly copies of the database and config
/media
  <downloads>/        owned by qBittorrent; Reelix reads and links from it
  <library>/Movies, Shows, Anime
```

The sub-paths under `/media` are found during setup, not assumed.

### 3.3 The operation registry (proposed)

The centre of `core` is a list of operations. Each is declared once:

```ts
defineOperation({
  name: "download.add",
  summary: "Add a release to qBittorrent for a known title",
  effect: "write",            // "read" | "write" | "destructive" | "admin"
  input: Schema, output: Schema,
  run(ctx, input) { ... },
  reconcile(ctx, input) { ... },   // optional: how to find out whether an interrupted run took effect
})
```

From that one declaration Reelix derives:

- the **CLI command** `reelix download add …` (flags from the schema, `--json` output);
- the **HTTP route** `POST /api/op/download.add`, which the web UI calls;
- a **typed agent tool**, for the operations listed in §4.2;
- the **ledger entry** (§6.2) for every `write`, `destructive` and `admin` operation.

Adding an operation gives all three faces at once, and they cannot drift apart.

**One writer.** The running server holds a lock on `/data`. The CLI sends its request to the server over a local socket that only Reelix's user can open; a token says who is calling (`plugins.md` §11.3). The agent's shell uses a second socket, `agent.sock`, which needs its session's token and never counts as the owner. The CLI runs an operation by itself only when it can take that lock, which means no server is running (early build steps, repairs).

## 4. The agent

### 4.1 Embedding pi

- pi runs **in-process** through its SDK. Tested on pi 1.5.2: two sessions ran side by side in one process with separate history, tools, working folder and files. Not yet tested: pi's shell and file tools in two sessions at once, and more than two sessions (§13).
- Each session is created with its working folder set to `/data/workspace`, pi's own state under `/data/pi`, and **context files switched off**, so an `AGENTS.md` planted in a download can never become instructions. Reelix's system prompt replaces pi's coding prompt.
- Server defaults that differ from pi's:
  - Shell commands get a time limit: 2 minutes by default, and the agent may ask for up to 30 for long jobs such as unpacking. pi has none.
  - Cache warming is off, because it spends money while idle.
  - Automatic retries stay on.
- Model access goes through pi: any of its providers, or an OpenAI-compatible address. As in StardewPilot, Claude Pro/Max sign-in is blocked; Anthropic is by API key only. Settings offer a main model and an optional cheaper model for background jobs. The main model should accept images; without that the agent cannot read screenshots, and verification goes straight to the owner (§8).

### 4.2 What the agent can use

**In every session, chat thread or background job (agreed 2026-11-17, decision B):**

- **pi's built-in tools:** `bash`, `read`, `ls`, `find`, `grep`, `write`, `edit`. The container is the boundary: it can reach `/media`, `/data` and the network, nothing else.
- **The `reelix` command through the shell.** Every operation is available this way. It is composable (pipe to `jq`, loop over files) and is the same thing the owner would type.
- **Typed tools** (below).

The one difference in a background job is `ask`: nobody is there to answer, so a job uses `notify` and parks instead (§4.5).

**Typed tools (proposed):**

| Tool | Purpose |
| --- | --- |
| `title_find` | Resolve a name, link or ID to an identity. |
| `release_search` | Search Jackett for a title; a compact, paged list. |
| `release_files` | The real file list of a release. |
| `download_add`, `download_status` | Add a chosen release; progress and state. |
| `organise` | Plan or apply filing a download into the library. |
| `media_probe` | Read a video's running time, tracks and embedded subtitles; grab a frame. |
| `subtitle_search`, `subtitle_fetch` | Find candidates; fetch, clean and place one. |
| `reelix` | Run any other registry operation by name, without going through the shell. |
| `show` | Put a rich card in the chat. |
| `ask` | Ask the owner a question with buttons, and wait. Chat threads only. |
| `notify` | Post to the Inbox, and to Telegram if it matters. |
| `browser_*` | Drive the browser (§8). |

These overlap with the CLI on purpose. The owner asked for native tools for the important features, and the typed tools are generated from the registry at no extra cost.

**Large results.** A tool returns a compact top slice to the model, always with the total count and how to get the next page. The full list rides along separately for the web UI to render, without the model paying for it. (MoviePilot's history shows models re-running searches and miscounting when results were cut without totals.)

**Handles, not secrets.** Release results carry a short Reelix-made ID. Download links and `.torrent` contents never go to the model or into saved conversations, because private-tracker files and Jackett's links contain personal keys.

### 4.3 System prompt and skills

The system prompt is short and stable: who Reelix is, the principles in §1, the soft limits in §9, a summary of current settings, and the two notes files. Domain knowledge lives in **skills**, loaded only when needed:

| Skill | Contents |
| --- | --- |
| `acquire` | "Get me X": identify, check library and current downloads, check free space, search, choose, add, confirm it started. Offer to follow a season that is still airing. |
| `release-names` | Reading release names: Chinese season and episode forms, anime bracket style, absolute numbering, numeric titles such as *1917*, packs, language and subtitle hints. |
| `choosing-releases` | Weighing releases against the preferences note; verifying a pack from its file list; spotting RAR-packed releases. |
| `organise` | Jellyfin layout, extras, disc folders, multi-part and multi-episode files, files shipped alongside a video, the unknown. |
| `subtitles` | Sources, choosing, the clean-up steps, naming. |
| `anime` | Lining up Bangumi seasons with TMDB seasons. |
| `verification` | The ladder in §8. |
| `setup-and-doctor` | Discovering paths, testing links, diagnosing connections, changing qBittorrent and Jackett settings. |
| `fixing-mistakes` | Wrong identity versus wrong download (§5.8). |

Rules in the prompt because they were learned the hard way (largely from MoviePilot's fixes):

- "Added" is not "downloaded", and "downloaded" is not "in the library". Report the state actually observed.
- A path as qBittorrent reports it is not a path Reelix can open until it has been mapped.
- Copy IDs exactly, never from memory.
- If a search returns nothing, check the indexers' health before saying a title is unavailable.
- An explicit request from the owner is the authorisation; do not ask again for the thing just asked for.
- Never change a video file in place. A library file and its download are the same data; editing one corrupts the torrent.

### 4.4 Memory

- **`notes/preferences.md`**: the owner's taste in releases and subtitles, in plain language. Written at setup from a few questions; the agent updates it when told something lasting ("never HDR") and reads it before every choice. **(agreed)**
- **`notes/library.md`**: what Reelix has learned about this setup: path quirks, slow indexers, the owner's habits.
- **Per-title notes** in the database: corrections that belong to one title ("the 1994 film, not the 2019 one"; "episode 13 is season 2 episode 1"). Shown whenever the agent touches that title. A correction is a sentence said once in chat. This replaces MoviePilot's "recognition words" syntax.
- **Skills the agent writes for itself (proposed).** When the agent has solved the same unusual case twice with shell work, it writes a short skill, with a script if useful, into `/data/skills`. The owner sees these as a "things I've learned" list in Settings and can read, edit or delete any of them. Only chat threads write skills, so a new one is always written with the owner present; background jobs can use them.
- **Past conversations** stay as saved pi sessions, which the agent can search with `grep` from a chat thread.

Notes are capped in size and loaded when a session starts.

### 4.5 Conversations and background work

**Threads (agreed).** Chat has multiple named threads, each a saved pi session. Reelix keeps its own index of threads in the database for fast listing and for links to titles and jobs.

**A run outlives the browser tab.**
- A turn runs on the server and continues if the page closes.
- Events are numbered and buffered in memory while a turn runs; a returning page asks for everything after the last number it saw.
- Once a turn has ended, the page is rebuilt from the saved conversation. That bounds the buffer, and it survives a restart.

**While the agent works.** A typed message is delivered when the current tool call finishes. Stop interrupts immediately, including a running shell command.

**Background jobs (agreed that they run apart from threads).** Each runs in its own session with the same tools as a chat thread (§4.2). A job that needs the owner's decision calls `notify` and **parks**: its question is saved in the database and its browser tab is released. When the owner answers, from the Inbox or Telegram, the job resumes in its saved session with the answer. The Inbox item also offers **"continue in chat"**, which opens the job's conversation as a normal thread so the owner can work on it together with the agent.

**Restarts.** Running turns, parked questions and job runs are all recorded in the database. On start-up Reelix marks interrupted turns as interrupted (and offers to continue them), reconciles unsettled ledger entries (§6.2), and re-queues interrupted job runs.

**Spending cap (agreed in principle; details proposed).** pi reports the cost and token count of every model call. Reelix sums them per day for background work. Because subscription and token plans can report zero cost, the cap is set in both money and tokens. At the cap:
- no new background run that needs the model starts;
- work that needs no model carries on (watching downloads, filing routine ones);
- waiting jobs queue for the next day;
- one Inbox notice says so.

Chat threads are not capped.

## 5. The media loop

### 5.1 Identity

**TMDB is the identity (agreed).** Every title has one TMDB ID and type (movie or TV). It decides folder names and what Jellyfin matches.

- One details request brings alternative titles, translations and the IDs other sites use. These are the set of names used for searching and matching.
- Display language is zh-CN with fallbacks; folder names use the English or original title (§5.4).
- **Linked IDs** are stored on the title: IMDb (the bridge between sources), Douban, and Bangumi.
- **Anything as input.** A TMDB, IMDb, Douban or Bangumi link resolves by ID. A magnet or release name is read for its title. A screenshot or photo of a poster is read by the model. **(proposed)**
- **Titles not on TMDB.** The agent can create a local-only title, with names and year supplied by the owner or another source. Its folder carries no ID tag, and Jellyfin will match it on name alone or not at all. **(proposed)**
- A lookup that failed because the network was down is never stored as "not found".

**Deciding which title something is (proposed).** IDs settle it whenever one is present. Otherwise:

- Code does the cheap part: an exact name match against any known name, with the year agreeing, is accepted without the model.
- Everything else goes to the model **with evidence**, not to a strictness rule: the candidates' years, running times, episode counts, the release's file list.
- The agent asks the owner only when two candidates remain plausible.

**Bangumi, for anime (agreed).** The official API (`api.bgm.tv`, with a descriptive client name as it requires). Reelix reads what MoviePilot never does: each entry's **episode list with air dates**. Bangumi has one entry per season or part-season, while TMDB often has one long season or splits differently. Reelix lines them up by air date and episode count, with TMDB's alternative episode orderings as a hint, and stores the result per title as: *this Bangumi entry's episodes N to M are TMDB season S, starting at episode E*, with per-episode exceptions. The agent settles what does not fit, once. How well date-matching works on awkward anime is untested (§13).

**Douban (agreed that it is included; method agreed 2026-11-17, decision F).** Douban has no official public API. MoviePilot reaches it by imitating Douban's phone app with keys copied from that app and forged request signatures. Reelix does not. It needs two things:

- **The Douban ID**, which subhd's own search results contain (its title pages are filed by Douban ID). No Douban request is needed.
- **The rating and Chinese title**, read from the ordinary public page, by plain request or through the browser.

Douban is best-effort. When it is unavailable nothing else stops, and subhd can still be searched by name.

### 5.2 Finding and choosing a release

- **Search** goes through Jackett, by ID where an indexer supports it and by Chinese and English names otherwise, in the category for the title's type. Each indexer is queried separately so one slow or broken indexer does not hold up or hide the rest. Reelix reports per-indexer errors and timings and removes duplicates.
- **Reading names.** A small conventional parser gives every result structured fields for the routine majority (resolution, source, codec, `S01E02`, group). It is not expected to be complete. Names it is unsure about are left for the model to read. The parser's test set grows from real names met in use, starting small. This is a deliberate break from MoviePilot's ever-growing hand-written parser patched by user rules.
- **Choosing.** There are no rule groups. The agent reads the candidates, the preferences note and any per-title note, and chooses, saying why in a sentence ("2160p WEB-DL, 18 GB, 简中 built in; skipped the 60 GB remux as over your size limit"). In chat it can show the list as a card so the owner picks with a click. Each row in the Search screen and each past download has a "why this one?" that shows the stored reason.
- **Look inside before committing.** `release_files` shows a release's real file list: which episodes a pack actually contains, whether it is RAR-packed, whether it is a disc image. For a `.torrent` this is available at once. For a magnet link it is available only after qBittorrent has fetched the torrent's details, so Reelix adds it stopped, waits, then checks (§5.3).
- **Already have it?** Reelix checks its own records and the library folder for the title and episodes. The library folder, with `[tmdbid-N]` in its names, is the truth; a Jellyfin title search is not used.
- **Free space** is checked against the release's size before adding. **(proposed)**

### 5.3 Downloading

**Adding.**
- **A `.torrent` link:** Reelix fetches the file itself, works out the torrent's ID, and uploads the file to qBittorrent. Reasons: the ID is known immediately (older qBittorrent versions do not return it); Jackett's download links point back at Jackett, which qBittorrent may not be able to reach; and the file list can be checked first. The file is used and discarded, not stored.
- **A magnet link:** the ID is in the link. Reelix adds it stopped, waits for qBittorrent to fetch the details, checks the file list, then starts it or removes it and says why.
- **If qBittorrent already has that torrent**, Reelix adopts the existing task instead of adding a duplicate.
- **Partial packs:** unwanted files are set to "do not download" before starting.

**Recording.**
- Ownership is marked with a qBittorrent tag (`reelix`) and recorded in the database. A second tag (`reelix-filed`) is added after filing.
- Recorded at add time: the torrent's ID, the title, the episodes wanted from it, the release's details, and why it was chosen.
- The file locations are **not** trusted from add time, because qBittorrent may move files when a download completes. They are read at completion.

**qBittorrent versions.** v4 and v5 differ in some parameter and state names. Reelix detects the version at setup and handles both.

**Watching (ordinary code, no model).** Reelix polls qBittorrent's change feed and keeps the entries it owns.
- **Complete** means: 100%, nothing left to fetch, and not in a checking, moving, error or missing-files state. A torrent that qBittorrent stops on completion counts as complete.
- **Removed outside Reelix:** the download is marked gone, and the owner is told if it had not been filed.
- **Stalled (proposed):** no progress for a set time (default 12 hours) raises a background job, which looks for a healthier release of the same thing and either proposes the swap in the Inbox or, if the preferences note allows it, makes it.
- **qBittorrent unreachable:** the watcher backs off and retries; one Inbox notice after an hour, not one per attempt.

### 5.4 Organising into the library

**Layout (agreed):** Jellyfin's conventions, English or original titles, the TMDB ID in the folder name, three top-level folders that become three Jellyfin libraries. A media type may have several library folders, each a Jellyfin library; which one a title goes to is decided first ([library-folders.md](library-folders.md), 2026-11-22).

```
Movies/Oppenheimer (2023) [tmdbid-872585]/Oppenheimer (2023) [tmdbid-872585] - 2160p.mkv
Shows/Severance (2022) [tmdbid-95396]/Season 01/Severance (2022) S01E01.mkv
Shows/Severance (2022) [tmdbid-95396]/Season 01/Severance (2022) S01E01-E02.mkv   two episodes in one file
Anime/Frieren (2023) [tmdbid-209867]/Season 01/Frieren (2023) S01E01.mkv
…/Season 00/…          specials
…/extras/…             extras Jellyfin should not treat as the film or an episode
```

Checked against Jellyfin's documentation and source: the ID tag is honoured on movie and series folders; a second version of a film must start with the exact folder name including the tag, then ` - label`; `Season 00` and `extras` are valid; disc folders (`BDMV`, `VIDEO_TS`) are linked whole and cannot have versions or separate subtitle files; the characters `<>:"/\|?*` are removed from names.

**A plan, then an apply (agreed).** A plan is plain data: a list of `source → destination` with a kind (video, subtitle, extra) and a reason. It is the same whether code or the agent wrote it, and it is what the owner sees when a plan needs approval.

**Who plans.**
- **Routine downloads are planned by code, with no model.** Reelix knows the title and episodes, so a single film file or cleanly numbered episodes are planned and applied automatically.
- **A cheap content check (proposed):** the video's running time is compared with TMDB's. A film that is 40 minutes off, or an "episode" two hours long, is not filed automatically.
- **Anything unexpected goes to the agent**, not to a manual-review queue: an odd folder structure, a file matching no wanted episode, extras, several versions, a failed content check. A background job gets the folder listing and the expected title, inspects whatever it needs with its shell and `media_probe`, and writes a plan. If it is confident it applies it; if not, the plan goes to the Inbox.

**Apply is exact, and is the only code that hard-links into the library:**
- Sources must be inside the download folder, destinations inside the library.
- It **makes the link directly** at the destination. That step either fully happens or does not, and it never replaces an existing file.
- If the destination already exists, apply compares the two: the same underlying file counts as done; a different file is reported as a conflict.
- There is **no fallback to copying**. If the link fails, the operation fails with the reason spelled out: a different mount or shared folder, no permission (the user-ID problem in §3.2), or a filesystem without hard links.
- Applying the same plan twice changes nothing.

**Files shipped inside the torrent.** Subtitle and separate audio files next to a video follow it into the library under the video's new name. Samples and promotional files are skipped. NAS system folders (`@eaDir`, `#recycle`) and partial-download files are ignored.

**RAR-packed releases (agreed 2026-11-17, decision I).** A release delivered as RAR parts cannot be hard-linked. The agent avoids them when choosing, since the file list shows them. If one arrives anyway, a background job asks before unpacking, because the unpacked copy takes the space a second time; the unpacked file is then filed, and the Library shows it as "unpacked copy".

**Afterwards** Reelix tells Jellyfin that the path changed, if Jellyfin is configured (§5.6), and starts the subtitle step.

**Adopting existing downloads (agreed; batching proposed).** One operation scans qBittorrent's existing torrents and the download folder.
- Code identifies and plans everything it can without the model.
- The agent takes the remainder.
- The owner gets **one** review screen: a table of title, files and destination, with everything confident pre-ticked, the uncertain ones marked, and a single Approve.
- Nothing is linked before approval.

### 5.5 Subtitles

**Sources (agreed):** subhd first, ASSRT (official API) as fallback, behind one interface so more can be added. The subhd address is a setting, because the site moves between domains (it currently names `subhd.me` as its main address).

**The library does receive ordinary files here.** Subtitle files Reelix downloads or converts are new, small files written next to the video. Only video, and files shipped inside the torrent, are hard links.

**Flow:**

1. **Check what is already there:** subtitle files next to the video, and Chinese subtitle tracks inside it. If the preference is already met, stop.
2. **Search.** subhd by name and year, which also yields the title's Douban ID for exact lookups later; ASSRT by Chinese then English name. These are plain pages and API responses; no browser is needed in the normal case.
3. **Choose once per season, not once per episode.** subhd lists each archive's contents on its page, so the choice is made before downloading. The agent weighs:
   - the language preference: 简体 & English bilingual, then 简体 alone; ASS over SRT **(agreed)**;
   - human over machine translation;
   - whether the subtitle was made for this release (WEB-DL versus Blu-ray, a matching group).
   
   A season pack is preferred, so one download covers the season.
4. **Fetch**, at a gentle pace, remembering each site's daily limits. If the site asks for verification, follow §8.
5. **Unpack** with a hardened external unpacker (zip, rar, 7z; old Chinese file-name encodings), with limits on depth, file count and size, and refusal of paths that escape the scratch folder.
6. **Clean up** (none of which MoviePilot's subtitle plugin does):
   - convert the text encoding to UTF-8 (GBK and Big5 are common);
   - tell 简体 from 繁體 from bilingual **by reading the content**, not the file name;
   - attribute each file in a pack to its episode;
   - check timing roughly: the last line should fall near the end of the video.
7. **Place** next to the video in Jellyfin's naming for separate subtitle files, with the preferred track marked as default. The exact suffix, including which Chinese language codes Jellyfin recognises and whether a "简英双语" label shows as the track's name, is not settled by Jellyfin's documentation and must be tested before it is fixed (§13).
8. **If nothing suitable is found**, say so, and for a recent release look again in a few days.

**Dropping in a file.** The owner can always drag a subtitle file or archive into the chat or onto a title's page; steps 5 to 7 then apply. Until the browser exists (build step 5), this and a plain notice are the fallback when subhd demands verification.

**Later (not v1):** aligning a subtitle to the audio automatically when the timing check fails.

**Translation (agreed 2026-11-18).** When no subtitle exists in a wanted language, or the owner asks for any language or style (Klingon included), Reelix can translate an existing text subtitle into a separate styled ASS file. The full design is in [subtitle-translation.md](subtitle-translation.md); the model roles it uses are in [models.md](models.md).

**Magpie configuration (agreed 2026-11-18).** With a separate admin key, Reelix can change an optional magpie gateway's routing groups, providers and other keys' limits. Every change goes plan → apply, is checked afterwards and rolled back if it breaks a role. The agent may not change the model it is running on, leave a role with no model, or touch Reelix's own keys. See [magpie.md](magpie.md).

**Deployment (agreed 2026-11-18).** Docker Compose: Reelix always, with pi inside it; magpie, qBittorrent, Jackett and Jellyfin as optional services, each in its own container on one private network, with the media folder at the same path everywhere. See [deployment.md](deployment.md).

**Trends and suggestions (2026-11-18).** The Search page became Trends: search on top, then "For you" (a model picks among TMDB's trending and recommended titles using the owner's notes and library, and says why) and TMDB's trending lists. Library pages show paths relative to the library, never the NAS's folders. See [trends.md](trends.md).

**Installable web app (2026-11-18).** The web UI installs to the Home Screen and sends native notifications through Web Push, and library titles open in Infuse, Swiftfin or Jellyfin with one tap, from the library or chat. See [web-app.md](web-app.md).

**Plugins (2026-11-18, design agreed; built phase by phase, state in plugins.md §21).** Others join the development through plugins: skill packs, providers for named seams, hooks, and operations that are at once agent tools, CLI commands and HTTP calls. Reelix's own subsystems move onto the same API. See [plugins.md](plugins.md); the systems studied are in [plugins-study.md](plugins-study.md). How to write one: [plugin-guide.md](plugin-guide.md).

### 5.6 Jellyfin

Optional. **(agreed)** The library folder is the truth. With a Jellyfin address and key configured, Reelix uses the API for one thing: telling Jellyfin that a path changed, falling back to a full library scan, so new files appear at once. It uses Jellyfin's current sign-in header, not the deprecated forms. Jellyfin sees paths differently from Reelix, so the path mapping in §10 applies.

### 5.7 Following a show

**A follow is a standing instruction in the owner's words (proposed)**, for example: *"Follow Frieren season 2. Weekly 1080p from the same group as season 1; when the Blu-ray batch comes out, tell me."* Reelix stores the instruction as written and keeps plain bookkeeping beside it: each episode is **wanted, grabbed or filed**. A follow is finished when everything is filed.

**Waking up is code; deciding is the agent.**
- Each episode has its own "check next at" time, taken from TMDB's air date (and Bangumi's for anime) plus a day's slack, since air dates carry no time zone. After a miss the interval widens.
- Nothing wakes for an episode that has not aired, and no model is called when nothing is due.
- When an episode is due, code runs the search. To avoid a model call every week, the agent may record a **quick-accept pattern** on the follow when it first chooses ("group X, 1080p, WEB"). A new episode matching the pattern is taken by code. Anything else wakes a background job, within the spending cap.

**After downtime.** A run is held on a lease that expires, so a run that crashed midway is taken up again and one that finished is never repeated. Missed checks run on the next start. (MoviePilot needed a fix for exactly this.)

### 5.8 Fixing mistakes

Two different things can be wrong, and the agent first works out which. **(proposed)**

- **Right file, wrong identity** ("that's the 1994 film"): re-identify. The library entry is re-linked under the right folder and name, subtitle files are renamed with it, the per-title note records the correction, and Jellyfin is told about both paths. Nothing is downloaded again.
- **Wrong download:** remove the library entry and, as the owner chooses, the torrent and its data; then get the right one.

**Removing a title** is one operation with three explicit levels: the library entry only; plus the torrent (the data stays on disk); plus the data. **(proposed)**

### 5.9 Nightly tidy-up and morning summary (proposed)

One scheduled job each night:

1. **By code:** back up the database and config to `/data/backups`; empty expired trash; re-check downloads Reelix believes are stalled, missing or unfiled; check free space and indexer health.
2. **By the agent, only if step 1 found something:** look into each problem and either fix it or prepare a question.
3. **One summary** to the Inbox, and one Telegram message if anything needs the owner: what arrived, what was filed, what is waiting, each with a one-tap choice where possible.

## 6. Data and records

### 6.1 Database

SQLite. Main tables (proposed):

| Table | Holds |
| --- | --- |
| `titles` | TMDB ID and type (or local-only), names, year, linked IDs, per-title notes, library folder. |
| `anime_map` | Bangumi entry and episode range → TMDB season and starting episode; per-episode exceptions. |
| `lookups` | "Looked for X at source Y, found Z or nothing", with an expiry. |
| `downloads` | Torrent ID, title, wanted episodes, release details, reason chosen, state, locations read at completion. |
| `files`, `file_episodes` | Each library file (source, destination, kind, version label); which episodes it contains, since one file can hold several. |
| `follows`, `follow_episodes` | The standing instruction, quick-accept pattern, per-episode state and next check. |
| `subtitles` | What was placed, from where, language, checks done. |
| `actions` | The ledger (§6.2). |
| `inbox` | Items waiting for the owner, including parked job questions. |
| `jobs`, `job_runs` | Scheduled work, leases, outcomes. |
| `threads`, `runs` | Chat threads and their saved sessions; turns in progress. |
| `site_state` | Per-site limits, cool-downs, last verification. |
| `spend` | Daily model cost and tokens. |
| `removed` | Library entries removed by unlinking, for restore (§9). |

### 6.2 The ledger

Every `write` and `destructive` operation is recorded **before** it runs and settled afterwards as `succeeded`, `failed` or `unknown`. `unknown` is what a timeout, a crash or a cancellation leaves behind. This is the lesson MoviePilot's agent learned the expensive way: models retry, requests time out, and without a record the same download gets added twice.

- **Each request carries its own ID** (the agent's tool call, the UI click, the CLI invocation). Re-sending the *same request* returns the first result. A *new* request for the same thing, such as downloading again after a deliberate removal, is a new request and runs.
- **Operations are written to be safe to repeat** wherever possible: adopting an existing torrent, treating an existing identical link as done.
- **An `unknown` entry is reconciled**, on restart and before a related operation, by the operation's own `reconcile` step where it has one (is that torrent in qBittorrent? does that link exist?).
- **Some operations cannot be checked afterwards**: a subtitle fetch that used up a daily allowance, or a request to Jellyfin to scan. Those stay `unknown` and are shown to the owner as such, not guessed at.

The **Activity** view is the ledger plus job runs, newest first: what was done, by whom (the owner through the UI, the agent in which thread, or a background job), with what result.

## 7. Web UI

**Stack and look (agreed):** the same as MovieCopilot-Frontend: Astro 5, React 19, Tailwind 4, shadcn/Radix, TanStack Query, lucide icons; dark only; one blue accent; the glass sidebar; the poster grid; sticky headers that shrink on scroll; English interface text with Chinese titles from metadata.

**Tokens carried over unchanged** from `MovieCopilot-Frontend/src/styles/global.css`: background and card `oklch(0.145 0 0)`, foreground `oklch(0.985 0 0)`, muted and border `oklch(0.269 0 0)`, primary `oklch(0.7 0.15 250)`, the status colours, radii (cards `rounded-xl`, posters `rounded-lg`, controls `rounded-md`), and the `.glass`, `.glass-card` and `.glass-panel` recipes. The poster grid stays 2 to 6 columns at `aspect-[2/3]`.

**One structural change (proposed).** MovieCopilot-Frontend reloads the whole page on every navigation, which would cut off a live chat. Reelix keeps Astro as the shell but serves a single page that mounts one React app with a client-side router. Components, tokens and styles carry over as they are; the per-page wrappers become routes; chat state lives above the routes and survives navigation.

**Fixed rather than copied (proposed):** card actions that appear only on hover (invisible on touch screens); a login token kept in browser storage; the sticky-header logic copied into every page; the browser's native confirm box.

### 7.1 Screens (agreed 2026-11-17, decision G)

MovieCopilot-Frontend's navigation was Dashboard, Explore, Subscriptions, Downloads, Settings. Reelix's is:

| Screen | For |
| --- | --- |
| **Chat** | The centre. Thread list, the conversation, rich cards, a composer that accepts dropped files, images and links. |
| **Inbox** | Things waiting for the owner: verification, plans to approve, questions from background jobs, the morning summary. A count in the navigation. |
| **Library** | The poster wall (what Dashboard was); per title: files, subtitles, notes, follows, fix match, re-file, remove. |
| **Search** | Find a title, see releases, download one by hand. |
| **Downloads** | Live progress, pause, resume, remove. |
| **Activity** | The ledger and job runs. |
| **Settings** | Connections with "test", paths and mappings, proxies, the preferences note, things the agent has learned, models, spending cap, Telegram. |

Dropped: **Dashboard** (merged into Library), **Explore** (trending is out of v1), **Subscriptions** (follows live on each title and in Library filters).

**Every item can be taken to the agent.** A title, a download, a release row, a ledger entry: each has "ask about this", which opens the chat with that item attached, and "why?" where a reason was stored. That is what makes the hand-operated screens part of an agent product instead of a separate app.

On desktop the sidebar carries navigation and the thread list, and the chat is one click away from any screen as a dock. On a phone the bottom bar leads with Chat and Inbox.

### 7.2 Cards in chat

The agent puts structured things in the conversation with `show` and `ask`:

- **Title card:** poster, names, year, rating, where it stands (in library, downloading, followed).
- **Release list:** one row per release with size, seeders, indexer, quality badges and the agent's reason for its pick; each row has a Download button. MovieCopilot-Frontend has no ancestor for this (its "search result card" was a poster), so it is designed new in the same visual language.
- **Plan card:** the `source → destination` list with Approve and Edit.
- **Progress card:** a live download or job.
- **Subtitle candidates:** language, format, source, what release each was made for.
- **Choice card:** a question with buttons.
- **Secret field:** for passwords and keys. What is typed goes straight to the server's secrets file; the conversation only records that it was provided. **(agreed 2026-11-17, decision H)**
- **Verification card:** a screenshot or QR code, a field for a code, and "open live view" (§8).

A click on a card either answers the agent's pending question, or performs the operation directly through the same API as everywhere else and leaves a short note in the thread ("owner downloaded release 3 from the list"), so the agent always knows what the owner did.

### 7.3 Access

Single user. **(agreed)** A password is set on first run. Intended for the home network, or the owner's own VPN or reverse proxy for access from outside. There is no registration.

Because this API can run a shell on the NAS, it is protected beyond the password **(proposed)**:

- the login cookie cannot be read by scripts and is not sent on requests coming from other sites;
- every request, the event stream and the live browser view check which site the request came from;
- login attempts are rate-limited.

### 7.4 Reaching the owner away from home: Telegram (agreed 2026-11-17, decision A)

Today this is the `telegram` plugin on the `notifier` and `chat.channel` seams (`docs/plugins.md` §7.3, §7.4).

Reelix runs a Telegram bot that the owner creates and whose token goes in the secrets file. It does three things:

- **Notices with pictures.** Anything that needs the owner (verification, a plan to approve, a failed download) and the morning summary. A QR code or a screenshot is sent as an image. Routine progress is not sent.
- **Answers.** Inbox items arrive with buttons (Approve, Skip, Try another source), and a reply to a notice is taken as its answer, so a verification code can be typed straight back.
- **Chat.** Any other message goes to one standing thread, "Telegram", which is an ordinary chat thread with the same powers as one in the web UI. It also appears in the web UI's thread list.

**Only the owner.** The bot acts only on messages from the owner's own Telegram account, fixed during setup by a one-time code shown in the web UI. Messages from anyone else are ignored. This matters because a chat thread has a shell.

**Reachability.** The bot connects outward to Telegram, so nothing on the NAS is opened to the internet and no VPN is needed to answer. Where Telegram is blocked, Reelix reaches it through the proxy setting (§10); the owner's phone needs its own access.

**Limits.** Rich cards become plain text, images and buttons. The live browser view is not available in Telegram: a check that needs the owner's own clicks still means opening the web UI.



## 8. The browser and verification

A real Chromium runs in the container with a **saved profile**, so cookies and logins persist and a site that has seen it before asks less often. **(agreed)** It is a general tool: the agent may use it for anything the owner asks, including operating Jackett's own web page to add or fix an indexer, and is told to prefer plain requests, which are faster and cheaper. **(agreed)**

**How the agent drives it (proposed; settled by a short trial at the start of build step 5).** Reelix starts Chromium itself, with its control channel private to the server process. The agent's browser tools are either Playwright's ready-made tool server attached to that browser, or a small set of custom tools on Playwright if the trial shows the ready-made route to be awkward. Either way the tools are: open a page, read it as structured text, click, type, wait, take a screenshot the model can see, save a download.

**Tabs, not one lock.** Each session gets its own tab on a lease. A job waiting for the owner does not hold its tab: it parks and releases it (§4.5).

**Live view (agreed).** Reelix streams the page to the web UI as images and relays the owner's clicks and typing back, so the owner sees exactly the page the agent sees, including any QR code. The design intends this to work over the browser's own control channel without a remote-desktop layer. That is to be confirmed in the step 5 trial, along with whether Chromium should run with or without a visible window, which affects how often sites challenge it.

**The escalation ladder (agreed):**

1. **Avoid it.** Plain requests, a gentle pace, a memory of each site's limits.
2. **Use the real browser.** Some checks, including Cloudflare's, often pass by themselves there.
3. **Do what is on the page.** If the check is something the agent can do as the owner would (tick a box, type a code it can read in an image), it does.
4. **Hand over only what needs the owner.** For a QR code or a code sent to a phone:
   - *If the owner is in the conversation:* show it in chat, keep the page open, type in the code the owner replies with.
   - *If the owner is away:* the picture or request goes to Telegram and the page is held for a few minutes, so a prompt reply with the code still works. After that the job parks and releases its tab. When the owner answers later, the agent starts the verification afresh and sends a new code.
5. **Let the owner take over** in the live view.
6. **Fall back:** another source, a later retry, and a plain account of what happened.

**The limit:** no disguising the browser as something it is not, and no paid solving services. Those break sites' rules and get a home IP blocked. Cloudflare sometimes refuses a browser driven by a program; when it does, steps 4 to 6 apply. This cannot be promised to work every time.

## 9. Safety

The owner chose soft limits. **(agreed)**

**In the prompt (soft), for every session:**
- When the owner asks for something, including deletion, do it and report exactly what was removed.
- When a destructive step is the agent's own idea, say what it intends and wait.
- Do not open `secrets.yaml`; use the `reelix` command, which uses secrets without printing them.
- Do not move, rename, edit or delete anything in the download folder unless the owner asks: it breaks seeding.
- **In a background job, a destructive step waits for the owner.** Nobody has asked for anything in a background job's conversation, so by the rule above anything destructive is the agent's own idea: it posts to the Inbox and Telegram and parks. This is an instruction, not a lock (decision B).

**In code (hard), because these are correctness or cost, not permission:**

- **Secrets are kept out of the conversation (proposed).** They are typed into a secret field, and known secret values are blanked from tool output before it reaches the model. The blanking is a cheap filter, not a guarantee.
- **The organiser** only creates links, only inside the library, and never replaces a file.
- **Removing a library entry (agreed as a 14-day trash; refined and agreed 2026-11-17, decision E):**
  - *The data still exists in the download folder:* the library link is removed and the removal recorded, so it can be restored by re-linking. Nothing needs keeping; the data never left.
  - *It is the last copy* (the torrent's data is already gone): it moves to a trash folder inside the same library folder, marked so Jellyfin skips it, for 14 days. Settings show the trash's size.
- **The ledger** prevents blind repeats (§6.2).
- **The spending cap**, and the time limit on shell commands.
- **Handles instead of download links** in anything the model sees (§4.2).

**The boundary** is the container: two mounts, no access to Docker itself, nothing else from the NAS. Only the entrypoint runs as root; Reelix runs as `PUID:PGID`, and the agent's shell as a user of its own that cannot read Reelix's data (`plugins.md` §11.3, D2). pi has no sandbox of its own and says so; the mounts are the real limit on what a mistake can reach.

**Accepted risks**, stated plainly:
- Outside the Docker image the agent's shell runs as Reelix's user and can read `secrets.yaml` despite being told not to; what it reads goes to the model provider. The owner accepted this soft limit in the interview. In the image it runs as another user that cannot read it (`plugins.md` §11.3, D2).
- **Unattended jobs with full access (the owner's choice, decision B).** Background jobs read text written by strangers (release names, NFO files, web pages, subtitle files) with nobody watching, and they have a shell. A line in such text that succeeds in steering the model could delete or damage files under `/media` and `/data`, or, outside the image, read the secrets file and send it out. What stands against that: context files are off; the prompt marks outside text as data and tells a job to park before anything destructive; secrets are kept out of conversations; the container limits the reach to the two mounts; the database and config are backed up nightly; library entries are only links, so they can be rebuilt while the downloads exist. None of these is a guarantee. The downloaded files themselves have no backup inside Reelix.
- A removed torrent's data is gone immediately.
- The agent's own shell reaches Reelix through its socket and runs operations as the agent, which excludes the owner-only `admin` ones. That is intended: it is the agent's command line. In the image that is all it can do with Reelix (`plugins.md` §11.3); outside it, this prevents mistakes and does not contain a steered agent.

## 10. Settings and setup

`config.yaml` is one readable file. **(agreed)** The agent and the Settings page change it through `reelix config set`, which validates and records the change; settings that decide where Reelix connects need the owner's yes when the agent changes them (`docs/plugins.md` §11.2). The owner can also edit the file by hand: Reelix notices, validates, and keeps the last good version if the edit is invalid, saying what was wrong. `secrets.yaml` holds passwords and keys separately.

```yaml
media_root: /media
downloads: /media/torrents            # found at setup
library:
  movies: /media/library/Movies
  shows:  /media/library/Shows
  anime:  /media/library/Anime
path_maps:                            # how other services see the same folders
  downloaders: { qbittorrent: [{ theirs: /downloads, ours: /media/torrents }] }   # by downloader id
  jellyfin:    [{ theirs: /data/media, ours: /media/library }]
downloader:  qbittorrent                        # the active downloader; the owner's choice (docs/plugins.md §7.5)
jellyfin:    { url: http://nas:8096 }          # optional
tmdb:        { language: zh-CN, base_url: …, image_base_url: … }
proxy:       { default: http://nas:7890, use_for: [tmdb, models, browser, subhd] }
subtitles:   { sources: [subhd, assrt], subhd_url: https://subhd.me }
plugins:                                       # services that are plugins; their passwords and keys live in secrets.yaml
  qbittorrent: { url: http://nas:8080, username: admin }
  jackett:     { servers: [{ url: http://nas:9117 }] }
  telegram:    { api_url: … }                  # optional; the linked owner lives in the database
models:      { main: …, background: … }
limits:      { background_daily_usd: 1, background_daily_tokens: 2000000,
               shell_timeout_s: 120, stalled_after_h: 12 }
```

The numbers are starting values, set with the owner at setup.

**Proxies and alternative addresses (agreed 2026-11-17, decision H).** TMDB's API and image servers, and most model providers, are commonly unreachable from mainland China. Each outside service can use a proxy or an alternative address; the proxy also applies to pi's model calls and to Chromium. Posters are fetched by the server and served to the web UI, so the owner's phone does not need to reach TMDB itself.

**Changing other services' settings (proposed).** Operations exist for qBittorrent's preferences (default save folder, incomplete-downloads folder, what happens on completion), its categories and tags, and for listing and testing Jackett's indexers. Adding or repairing a Jackett indexer has no dependable API, so the agent does that in Jackett's own web page through the browser.

### 10.1 Pre-flight: before installation (agreed 2026-11-17, decision C)

Hard links depend on how folders are mounted into the container, and that is chosen before Reelix runs. So the first thing built is a pre-flight check, run once on the NAS itself over SSH, which needs nothing installed. It:

1. finds the qBittorrent, Jackett and Jellyfin containers and reads how each is set up: which NAS folders they mount, and which user and group IDs they run as;
2. finds where qBittorrent actually saves, and where an existing library is, if any;
3. **tests a real hard link** between the download location and the proposed library location, using a file qBittorrent itself wrote, and checks that Jellyfin's user could read the result;
4. names the NAS type and CPU, which are not known at design time;
5. prints a recommendation in plain words: either "this layout works; here is the container definition to use", or "downloads and library are in two shared folders, which cannot be hard-linked; here are the two ways to fix it and what each would move".

The owner or the agent, in a later session, acts on the recommendation. Pre-flight changes nothing by itself.

### 10.2 Setup by the agent (agreed)

First run opens a setup thread. The agent:

1. confirms what it sees under `/media` against the pre-flight result;
2. asks for the qBittorrent, Jackett and (optionally) Jellyfin addresses, takes logins through the secret field, and tests each;
3. reads qBittorrent's save folder and its existing torrents' locations, and works out the path mapping by finding the same folder on its own side;
4. repeats the hard-link test from inside the container, on a real downloaded file;
5. checks which of Jackett's indexers are configured and healthy;
6. asks about a proxy if TMDB or the model provider cannot be reached;
7. asks a few questions and writes the first `preferences.md`;
8. sets up the Telegram bot, links the owner's account with a one-time code, and sends a test;
9. writes the settings and shows a summary for the owner to correct.

### 10.3 Doctor

`reelix doctor` (also a button in Settings, and something the agent runs when things look wrong) repeats the checks: connections and versions, path mappings, the hard-link test on a real file, file ownership and whether Jellyfin can read, free space, indexer health, reachability of TMDB and the model with and without the proxy, Telegram, and whether the browser starts.

## 11. Build order (agreed 2026-11-17 in this revised form, decision C)

The interview agreed seven steps starting with "core and CLI". Review showed two problems: the hard-link assumptions would first meet the real NAS at step 3, and background work appeared before the job runner and spending cap existed. The revised order:

| Step | Delivers | Tools the agent has | Usable as |
| --- | --- | --- | --- |
| 0. Pre-flight | The check in §10.1, run on the owner's NAS. | none | A report on whether the NAS layout supports hard links, and what to change. |
| 1. Core and CLI | Operation registry; qBittorrent, Jackett and TMDB clients; a small name parser; the organiser's plan and apply; the ledger; `reelix doctor`. | none | A terminal tool with no AI. |
| 2. Agent in the terminal | pi host, system prompt, first skills, notes, the setup conversation. Checks the two untested pi behaviours (§13). | shell and file tools; `title_find`, `release_search`, `release_files`, `download_add`, `download_status`, `organise`, `media_probe`, `reelix` | A working assistant over SSH: identify, search, choose, download, file. |
| 3. Web UI and the job runner | Server, login, event stream, threads, cards, Inbox; the job runner with leases, spending cap and the Telegram bot; the completion and stalled watchers; the container image; **first installation on the NAS**. Then Downloads, Library, Search, Settings, Activity. | adds `show`, `ask`, `notify` | The product, for everything except subtitles. |
| 4. Subtitles | subhd and ASSRT, unpacking, clean-up, placement, drop-in files. When subhd demands verification: a notice and drop-in. | adds `subtitle_search`, `subtitle_fetch` | Subtitles in the normal case. |
| 5. Browser | Chromium, browser tools, tabs, the ladder in §8, live view. | adds `browser_*` | Verification handled; any site reachable. |
| 6. Bangumi and Douban | Anime season mapping; Douban ratings. (Douban IDs already arrive with subhd in step 4.) | | Anime numbered correctly. |
| 7. Adopt, follow, nightly | Adopt existing downloads; follows; nightly tidy-up and morning summary; self-written skills. | | The always-on assistant. |

Steps 0 to 3 each stand alone. Steps 4 to 7 each add a capability to the installed product.

## 12. Testing

- **No Docker on the development machine (agreed).** Development and tests run directly on it; the container image is built in step 3 and first run on the owner's NAS.
- **Core without a model:**
  - the organiser against temporary folders: real hard links, conflicts, repeat-safety, and the failure cases (a second mount, a read-only source);
  - the ledger, including restart with unsettled entries;
  - the parser against its small set of names;
  - clients against recorded responses for Jackett, TMDB, Bangumi, ASSRT and subhd pages.
- **qBittorrent for real:** a throwaway `qbittorrent-nox` run directly (it needs no administrator rights), with freely licensed test files only (for example the Blender open films).
- **Agent behaviour:** a short list of scripted requests with known right outcomes, judged by what ends up in the ledger and on disk, not by the wording of replies. Examples: "get me *Sintel*"; a pack with one episode missing; a download that arrives as an unexpected folder; a subtitle archive in GBK with both 简体 and 繁體 files; a release name and an NFO file with injected instructions in them, run as a background job, checking that nothing outside the task was touched.
- **Web UI:** component tests for cards; one end-to-end pass of the main loop.
- No test data, fixture or code is taken from MoviePilot (GPL-3.0).

## 13. Open items and things to verify

| Item | When |
| --- | --- |
| NAS type, CPU (x86 or ARM), folder layout, and the user IDs of the existing containers. | Step 0. |
| qBittorrent's version (v4 or v5) and what it does on completion. | Step 0 / setup. |
| pi's shell and file tools in two sessions at once; more than two sessions; whether a parked session resumes cleanly after a restart. | Step 2. |
| The exact Jellyfin subtitle file suffix: accepted Chinese language codes, the order of label, language and "default", and whether a bilingual label shows as the track name. | Before step 4 finishes; needs a Jellyfin to test against. |
| Whether Jellyfin skips a marked trash folder inside a library. | Step 3. |
| Which model the owner runs day to day, and whether it reads images. | Before step 5. |
| Ready-made browser tool server versus custom tools; live view over the browser's control channel; Chromium with or without a visible window; its real size and memory use. | Trial at the start of step 5. |
| subhd's final download request and its limits (observed, not exercised). | Step 4. |
| How well date-based Bangumi ↔ TMDB matching works on awkward anime. | Step 6; expect to lean on the agent and per-title notes. |
| Whether Telegram is reliably reachable from the NAS through the proxy. | Step 3. |
| Jackett's per-indexer behaviour under timeouts, and the exact form of its download links. | Step 1. |

## 14. What was learned from the references

### 14.1 MoviePilot v3 (GPL-3.0; ideas only, no code)

**Taken as knowledge**

- *Agent:* duplicate actions after timeouts are the central reliability problem, hence the ledger with an `unknown` outcome. Scheduled runs must be claimed. A scheduled check should not wake the model when nothing is due. Results cut without totals make models re-run and miscount. Models shorten long IDs. Explicit requests should not be re-confirmed.
- *Pipeline:* record a download's purpose when adding it. "Complete" is more than 100%. Never fall back to copying. Verify packs from the file list. Work out the torrent's ID yourself. Extras, discs and files shipped inside torrents each need a decided treatment. Track episodes as wanted, grabbed, filed, and finish on filed.
- *Metadata:* match by ID chains with IMDb as the bridge; never store a network failure as "not found"; always carry the movie-or-TV type with a TMDB ID.
- *Subtitles:* check existing and embedded subtitles first; unpack with a hardened tool and limits; attribute pack files to episodes.
- *Chat:* keep the run alive when the browser leaves; show tool activity as short human lines, not raw arguments.

**Where Reelix deliberately differs**

| MoviePilot | Reelix |
| --- | --- |
| An agent added to a large form-driven app. | The agent is the product; screens are views onto its work, and every item can be taken to the agent. |
| One gateway tool over about 240 registered operations, plus a model call to select tools. | A shell everywhere, a small CLI and about fifteen typed tools, from one registry. |
| A large hand-written release-name parser, patched by a user-maintained "recognition words" syntax. | A small parser for the routine; the model for the rest; corrections are sentences. |
| Title matching by exact names and year rules only. | IDs first; then the model weighs evidence, including the content itself. |
| Release choice by boolean rule groups (`SPECSUB & 4K & !BLU > …`). | The agent's judgement from a plain-text preferences note, with a stated reason. |
| Subscriptions as a state machine with rule groups. | A standing instruction in the owner's words; code only wakes it. |
| Unrecognised files rejected to a manual-review queue. | They go to the agent, which opens the folder and plans. |
| Douban through an imitated phone-app API. | Douban IDs from subhd; ratings from the public page. |
| Bangumi for search and calendar only; no season mapping. | Bangumi episode lists and air dates lined up against TMDB. |
| Subtitle plugin: no encoding conversion, no look inside the file, no timing check, no release matching. | All four. |
| The agent's knowledge is fixed by its developers. | The agent writes skills for cases it has solved twice. |
| Chat stream cannot be resumed. | A returning page catches up. |
| Roles, per-user isolation, channel authorisation, personas. | None: single user. |

MoviePilot's agent subsystems are in part ports of the Hermes agent (MIT-licensed), which can be read directly if a mechanism is ever wanted in detail.

### 14.2 pi 1.5.2 (checked against its documentation and type definitions)

- SDK embedding with a streaming event feed; two concurrent sessions in one process tested.
- The host supplies the "ask the user" implementation, so questions become cards. With no UI attached, questions are silently answered "no", which is why background jobs use the Inbox and never `ask`.
- Tool results can carry images, resized automatically, and a separate payload for the UI that the model does not see.
- Extensions can block or change a tool call before it runs and rewrite a tool's result afterwards. Reelix uses this for the shell time limit and blanking secrets.
- No sandbox, no approval step, no shell time limit, cache warming on by default: each handled by Reelix as described.
- Cost and token counts on every model call.
- A typed message during a run is delivered after the current tool call, not in the middle of it.
- A large package gallery exists (browser, scheduling, memory, permissions). Most packages assume pi's terminal interface, so they are read for ideas rather than installed.

### 14.3 Official documentation of the services

- **Jellyfin:** naming rules (§5.4); separate libraries per type; a targeted "path changed" call; the current sign-in header.
- **qBittorrent:** v4 and v5 differences; adding by file upload; the change feed; file priorities; no torrent ID in the add response on older versions.
- **Jackett:** the results interface and its fields; category numbers; download links that point back at Jackett; the weaknesses of querying all indexers as one.
- **TRaSH Guides:** one mount for downloads and library; how to verify a hard link; the Synology and Unraid layouts that pre-flight recommends.
- **TMDB:** one details request for names and external IDs; lookup by external ID; alternative episode orderings; rate limits; the attribution notice Reelix must show.
- **Bangumi:** search, entry and episode endpoints; the client-name rule.
- **ASSRT:** search and detail; 20 requests a minute; download links that expire.
- **subhd:** plain pages keyed by Douban ID; a three-request download; Cloudflare Turnstile after many downloads in a day, then a daily cap; a moving domain.

### 14.4 Comparable projects

- **Sonarr, Radarr, Prowlarr, Bazarr:** the established rule-driven stack. Reelix borrows its hard-link discipline and nothing of its configuration model.
- **ChineseSubFinder:** dropped direct scraping of subtitle sites because of the load it put on them; a reminder to keep Reelix's pace gentle.
- **Existing agent integrations** (tool servers for the \*arr stack, qBittorrent, Jellyfin) are thin wrappers over those apps' APIs. None covers Jackett, Chinese subtitles, or Bangumi and Douban, and none treats the filesystem as something the agent works on.

### 14.5 The owner's own projects

- **MovieCopilot-Frontend:** the visual style and stack (§7), and a list of small bugs not to carry over.
- **MovieCopilot (backend):** settings with masked secrets and a per-service "test connection" that never throws. Not carried over: open registration, any-site access, silent fallback when a secret fails to decrypt.
- **QbittorrentMCP:** the shape of a compact torrent summary for a model.

- **StardewPilot:** the working method: a dated design doc, steps usable by themselves, code executes while the model plans, notes as plain text, a daily model budget, model access only through pi.

## 15. Project setup (agreed)

- Private GitHub repository `4444zyf/Reelix`.
- MIT licence. No code, tests or fixtures copied from MoviePilot or any other GPL project.
- No secrets in the repository; `references/` is git-ignored.
- Changes are pushed only when the owner says so.
- TMDB's attribution notice is shown in the web UI's About section.

## 16. Review record

The first draft was reviewed twice on 2026-11-17, by reviewers who had not seen the design conversation: one checked technical claims against pi's documentation and type definitions, Jellyfin's and qBittorrent's documentation, and Linux hard-link behaviour; the other read it as a product against the owner's own words.

**Corrected after the technical review**

| Finding | Change |
| --- | --- |
| The "same filesystem" pre-check was wrong in both directions. | Dropped. The link is attempted and its failure explained (§5.4). |
| "Link under a temporary name, then rename" can silently replace a file. | The link is made directly at the destination (§5.4). |
| A differing user ID defeats hard-linking, and the setup test could not see it. | Run as qBittorrent's user; test on a file qBittorrent wrote (§3.2, §10). |
| "Background jobs cannot run destructive shell commands" could not be enforced by inspecting commands. | The second draft removed the shell from background jobs. The owner then chose full access for them (decision B); the claim is withdrawn and the risk is stated in §9. |
| The web API and local channels were unprotected beyond a password. | §7.3; private socket and browser control channel. |
| Secrets could reach the model through chat and saved conversations. | Secret field; blanking; refused reads in jobs (§7.2, §9). |
| The ledger's "check the real state" was impossible for many operations, and blocked legitimate repeats. | Request IDs; per-operation reconcile; honest `unknown` (§6.2). |
| CLI fallback contradicted "one writer". | A lock decides (§3.3). |
| Completion logic missed stopped-on-completion and moved files; removed torrents unhandled. | §5.3. |
| Magnet links have no file list before adding; download links carry personal keys. | Add stopped, then check; handles instead of links (§4.2, §5.3). |
| Restarts, event storage, the shared browser, proxies, data-model gaps, follows after downtime, build-order dependencies. | §4.5, §8, §10, §6.1, §5.7, §11. |

**Changed after the product review**

| Finding | Change |
| --- | --- |
| Nothing reached the owner away from home. | A Telegram bot (§7.4, decision A; the owner chose Telegram over the one-way push first proposed). |
| Setup came after the decision that matters. | Pre-flight (§10.1). |
| "Configure the settings" covered only Reelix's own. | Operations for qBittorrent and Jackett settings (§10). |
| Follows were a state machine with a rule. | A standing instruction, woken by code (§5.7). |
| Strict name matching would fail on Chinese names and over-ask. | The model weighs evidence (§5.1). |
| "That's the wrong film" and "delete it" were undefined. | §5.8. |
| Adoption would mean hundreds of approvals. | Code first, one review screen (§5.4). |
| Screens were plain CRUD. | "Ask about this" and "why?" everywhere (§7.1). |
| Dropped screens and unlabelled decisions. | §0, labels throughout, §7.1. |
| Hopes stated as facts; contradictions. | Reworded; §5.5 states that subtitle files are ordinary files. |
| Missing: stalled downloads, free space, RAR releases, backups, titles not on TMDB. | §5.3, §5.2, §5.4, §5.9, §5.1. |
| Bolder ideas. | Adopted: self-written skills, checking content, anything as input, nightly tidy-up and morning summary. Deferred to v2: learning from Jellyfin's watch history, audio-based subtitle alignment. |

**Considered and not adopted**

- *Drop the typed tools that duplicate the CLI.* Kept: the owner asked for native tools, and they cost nothing extra to generate.
- *Drop the ledger's `unknown` handling.* Kept in simpler form: it is the one mechanism MoviePilot visibly had to retrofit.
- *Drop Douban.* Kept, minimal: the owner asked for it.
- *Build with the agent first, harden operations later.* Partly adopted: the parser and core are kept small in step 1, and pre-flight puts the real NAS first. Linking and qBittorrent calls are still written and tested as exact code before the agent uses them, because those are the mistakes that cost.

**Not yet verified by either review:** the Jellyfin subtitle suffix; details of Jackett's source; qBittorrent v5's exact parameter and state names. All are in §13.

## 17. Implementation status (2026-11-17)

Every build step exists in code. What was verified, and how:

| Step | State | Verified by |
| --- | --- | --- |
| 0. Pre-flight | `preflight/reelix-preflight.sh` | Run locally: a working layout, and a cross-filesystem layout (EXDEV explained). Not yet run on the NAS. |
| 1. Core and CLI | Registry, ledger with request IDs and reconcile, clients, parser, organiser, doctor, `reelix` CLI over the private socket or with the data lock. | Tests: real hard links, conflicts, repeat-safety, cross-mount and read-only failures; ledger restart; the whole loop against fake qBittorrent (v4 and v5), Jackett and TMDB. |
| 2. Agent in the terminal | pi host (in-process, context files off, shell time limit hook, secret blanking hook, cache warming off), system prompt, nine skills, `reelix chat`. | Live runs with the owner's pi model. |
| 3. Web UI and job runner | Server, login, event streams, threads, cards, Inbox, job runner (leases, parking, spending cap), watcher, Telegram bot, nightly, Dockerfile. | Tests for parking/resume, cap, restart, login/origin/rate limit; live chat over the API. Real Chromium pass (`packages/server/test/ui*.e2e.ts`): login, all seven screens, phone layout, a streamed chat reply with the real model; no console or API errors. Not tried with a real Telegram bot. |
| 4. Subtitles | subhd and ASSRT, hardened unpack (own zip reader; 7-Zip for rar/7z), encoding and script by content, episode attribution, timing check, placement. | Tests; subhd parsing and its full download flow checked once against the live site (§13 item settled: prepare → `/down/<sid>` → `POST /api/sub/down` returns a file URL or `turnstileRequired` / `dailyLimitReached`). |
| 5. Browser | Chromium with saved profile, tools, tab leases, live view (CDP screencast + input relay). | Tools run against the live subhd page. Live view checked in a real browser: frames stream, clicks relay. (Chinese renders only with CJK fonts installed; the image installs them.) |
| 6. Bangumi and Douban | Air-date mapping, absolute-number resolution in filing, Douban rating from the public page. | Unit test for resolution; the Bangumi client checked against the live API (search, per-season entries, episode air dates). Full TMDB↔Bangumi mapping needs a TMDB key. |
| 7. Adopt, follow, nightly | Adoption scan/review/apply, follows with quick-accept, nightly summary, self-written skills list. | Tests against the fakes: adoption (identify, plan, nothing linked before approval, apply), follows (quick-accept grabs, other releases go to the agent, misses widen the interval). Not run against live services. |

Agent behaviour (§12) with a real model against the fakes: chose the 1080p release per the preferences note (skipping CAM and 4K), filed it, and in an unattended job ignored and reported instructions injected into a release name; no secret or Jackett link reached any saved conversation.

Still open, and only possible with the owner's equipment: the pre-flight run and first installation on the NAS (§11 step 3); a real qBittorrent, Jackett and Jellyfin (subtitle suffix and `.ignore` in the trash folder, §13); a Telegram bot token and the owner's account; a TMDB key for live identification.

## Glossary

- **Hard link:** a second name for the same file on disk. The library entry and the downloaded file are one set of data, so filing costs no space, and it only works within one mounted folder tree.
- **Seeding:** continuing to share a finished download. Moving or renaming the files stops it.
- **Indexer:** a site Jackett searches for releases.
- **Release:** one particular upload of a film or episode (a given quality, source and group).
- **Pack:** a release containing a whole season or several episodes.
- **Magnet link:** a link that identifies a torrent without its file; the file list arrives only after the download client has fetched the details.
- **Skill:** a short instruction file the agent loads when a task needs it.
- **Session / thread:** one saved conversation with the agent.
- **Ledger:** Reelix's record of every change it makes, written before the change happens.
- **Pre-flight:** the check run on the NAS before Reelix is installed.
