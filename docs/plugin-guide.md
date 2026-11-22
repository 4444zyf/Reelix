# Writing a Reelix plugin

This guide takes you from an idea to a plugin that works. It is written for people who know some TypeScript and do not know Reelix's code. You do not need to read Reelix's code: everything a plugin can use is in `@reelix/plugin`, and every part of it is in the [reference](plugin-reference.md). The reasons behind the design are in [plugins.md](plugins.md).

Every recipe below is a real plugin in this repository. When this guide and a plugin seem to differ, the plugin is right, because `npm test` runs it.

## 1. What you can make

| Kind | What it does | Start with |
| --- | --- | --- |
| Subtitle source | Finds and downloads subtitles from a site. | `reelix plugin new --kind subtitle-source` |
| Indexer | Searches a tracker or an indexer service for releases. | `--kind indexer` |
| Notifier | Sends Reelix's notices to a service (a phone app, a webhook). | `--kind notifier` |
| Chat channel | Lets the owner talk to the agent from a chat app. | read `plugins/telegram` |
| Downloader | Drives a torrent client; the owner picks one. Provisional. | read `plugins/qbittorrent` |
| Translator | Translates chunks of subtitle lines; the owner picks one. Provisional. | read `plugins/model-translator` |
| Tools in the agent's session | A raw pi extension: tools, handlers, a live view through routes. Advanced. | read `plugins/browser` |
| Hook | Takes part in a decision: hide releases, order them, refuse a download, name files, word notices, add to the agent's prompt, block a tool call. | `--kind filter`, `rank`, `name`, `notice`; read `plugins/examples/max-size`, `no-delete-without-ask` |
| Job, event listener, operation | Does work on a schedule or when something happens, or adds a command that the agent, the command line and the web UI can all run. | read `plugins/examples/low-space`, `finished-cleanup` |
| Skill pack | Instructions (`SKILL.md`) and scripts for the agent. No code runs inside Reelix. | `--kind skills` |

A *seam* is a contract for one kind of outside service. Code that fulfils it is a *provider*. A *hook* is a named step where plugins take part in a decision. The [reference](plugin-reference.md) lists every seam, hook, event and `ctx` call, with time limits.

## 2. What Reelix trusts, in plain words

- **By default your code runs inside Reelix, with the same rights as Reelix.** Nothing stops a plugin there that wants to do harm. So the owner decides what is installed: Reelix shows the owner what your `package.json` declares, says plainly what the code can do, and loads nothing before the owner approves. After that, Reelix checks the plugin's files every time it loads them. If one changed, the plugin does not run until the owner approves it again.
- **Or in a process of its own** (`"runtime": "process"`, section 5.26). There it gets its context and is meant to have nothing else. Node's permission model keeps it from Reelix's data folder, database and secrets, from starting programs and from compiled addons; Reelix's own code in that process refuses Node's network modules and the rest of what that model does not cover, so an honest plugin reaches the network only through `ctx.http.fetch`. That second part is code inside your process, not a wall: a determined hostile plugin may find a way past it, and even Node's permission model is not promised to hold against malicious code. The owner can choose this for any plugin without a raw pi extension or compiled dependencies, whatever your manifest says; your manifest only sets the default. The same code runs both ways.
- **Declarations keep honest plugins honest.** A plugin must declare in `package.json` what it registers and what it reaches: seams, hooks, events, operations and their effects, network hosts, secrets, skills. Reelix refuses anything that is not declared. Inside Reelix this catches mistakes and does not stop a hostile plugin; in a process of its own, `ctx` is all an honest plugin has, so what `ctx` refuses stays refused for it.
- **A plugin never deletes anything on its own.** An operation whose effect is `destructive` runs for a plugin only after the owner approves it in a *proposal* (section 5.13). `admin` operations (settings, secrets, plugins) never run for a plugin.
- **Text from a plugin is data, not instructions,** with three exceptions: skills, `agent.prompt` sections and operation summaries. The owner sees those at install, and Reelix puts a heading over them that says they cannot authorise anything.
- **Failures stay local.** A throw or a timeout counts as a failure of that one registration. Five failures in ten minutes switch the plugin off, with a notice to the owner. Downloads and the agent go on.

## 3. From idea to working plugin

You need a checkout of Reelix with `npm install` done. In this guide `reelix` means `bin/reelix` of that checkout.

1. **Write a working start.** Outside Reelix's folder:

   ```sh
   reelix plugin new ~/reelix-plugins/my-indexer --kind indexer --id my-indexer
   ```

   At a terminal, `reelix plugin new` asks for the kind and the id when you leave them out. It writes a plugin that already passes its tests and the checker, with a `README.md` and an `AGENTS.md` (for a coding agent, section 8). It refuses to write inside Reelix's own folder. Until `@reelix/plugin` and `@reelix/plugin-testing` are published, it links them from your Reelix into the plugin's `node_modules`.

2. **Run its tests and the checker.**

   ```sh
   cd ~/reelix-plugins/my-indexer
   npm test
   reelix plugin check .
   ```

   `reelix plugin check` needs no running Reelix. It starts your plugin in a Reelix of its own through the real loading path, and checks: the manifest and the entry; that everything declared was registered; each hook once, with an ordinary input; and the *conformance suite* of every seam the plugin provides, against the answers you recorded in `test/check.ts` (section 6.3). It prints one line per check and exits with 1 when a check fails. When it fails, it also shows what Reelix logged while it ran your plugin.

3. **Change it into your plugin.** Change the code, record real answers of your service in `test/check.ts`, and change the tests. Run step 2 again until both pass.

4. **Try it in a whole Reelix.**

   ```sh
   reelix plugin dev .
   ```

   This starts Reelix in a new temporary folder, with fake qBittorrent, Jackett, TMDB, Jellyfin and Bangumi servers and a small film and series library (the ones `scripts/demo.ts` uses), and your plugin loaded from your folder. It prints the address and a password for this session. The web UI shows a banner on every screen while a development plugin is loaded. The plugin needs no approval and its files are not hashed. The folder can only be named on this command line, never in settings or by an operation. Reelix reads your code when the plugin starts: restart the command after a change. Stop it with Ctrl-C; the temporary folder is deleted. For a conversation with the agent, set `REELIX_PI_DIR` (pi's folder with your model sign-in) and `REELIX_DEMO_MODEL=provider/model` before you start it.

   In a second terminal, the command it prints (`REELIX_DATA=… reelix plugin list`) talks to this Reelix. `REELIX_DATA=… reelix plugin inspect my-indexer` shows the plugin's state, last error, settings and what it registered.

5. **Publish it** (section 7).

## 4. The parts of a plugin

### 4.1 The manifest

`package.json` holds the manifest under the key `reelix`. From `plugins/examples/finished-cleanup/package.json`:

```json
"reelix": {
  "api": 0,
  "id": "finished-cleanup",
  "entry": "./src/index.ts",
  "runtime": "in-process",
  "settings": "./settings.schema.json",
  "uses": {
    "operations": { "scan": "read", "propose": "write", "kinds": "read" },
    "tools": ["scan"],
    "jobs": ["daily"],
    "runs": ["download.remove"],
    "inbox": true
  }
}
```

- `id`: 2 to 40 lowercase letters, digits and hyphens. It cannot be a built-in plugin's id or the first word of a Reelix operation (`download`, `title`, …).
- `api`: the plugin API of the Reelix that runs it. It is `0` until the owner declares the API stable; until then anything may change. A plugin with another `api` is not loaded.
- `engines.reelix` (optional, next to `reelix`): a version range, checked at install and at every start.
- `requires.seams`: seams that must have a provider before this plugin starts. `plugins/auto-subtitles` requires `reelix:subtitle.source@1`; without a subtitle source it waits, and Settings says what for.
- `requires.plugins`: other plugins by id, each with a version range: `{ "release-tags": "^0.1.0" }`. They start first. While one is not installed, off, or of a version outside the range, this plugin waits, and Settings and `reelix plugin list` say for which and what there is instead. Switching off a plugin others require asks first and switches them off with it. Requirements that go round in a circle are refused: each plugin in the circle fails, naming it. A plugin that provides a seam or listens to an event another plugin owns must require that plugin (section 5.25).
- `owns`: seams and events this plugin owns, for other plugins (section 5.25).
- `describe` (optional): one line about the plugin's state for the agent's prompt and `reelix config show`. `{path}` is one of its settings (`{servers.*.url}`: every entry's), `{secret:<name>}` says `set` or `missing`; a secret's value never appears. From `plugins/qbittorrent`: `"at {url} (password {secret:password})"`, shown as `plugin qbittorrent: at http://qbittorrent:8080 (password set)`.
- `env` (optional, only for plugins shipped with Reelix or named at start, never for one the owner installed): environment variables (`REELIX_…`) that fill one of its settings at start while it is empty: `{ "REELIX_DEFAULT_QBITTORRENT_URL": "url" }`. This is how `docker-compose.yml` passes addresses. Doctor warns when such an address points at Reelix's own container.
- `runtime`: `"in-process"` (inside Reelix) or `"process"` (a process of its own, section 5.26). A plugin with `uses.pi` or `uses.native` can only be `"in-process"`. The owner can change it on the plugin's page.
- `screen` (optional): `{ "entry": "./screen/index.html", "title": "Finished downloads" }`, a screen of its own under Plugins (section 5.27).
- `uses`: every key is in [plugins.md §5.1](plugins.md#51-manifest). `network` lists hosts (`api.example.org`, `*.example.org`), `config:<setting>` (the host of an address the owner typed into that setting, which may be on the home network) or `*` (any public host).

### 4.2 The entry

The entry file has exactly one export, the default:

```ts
import { definePlugin } from "@reelix/plugin";

export default definePlugin({
	async activate(ctx, settings) {
		// register everything here, through ctx
	},
});
```

Everything you register is undone when the plugin stops: when it is switched off, when its settings change, when Reelix stops. Keep state in variables inside `activate`, or in `ctx.kv` when it must survive a restart. Never keep it in module-level variables. `ctx.signal` is aborted when the plugin stops.

TypeScript runs without a build step. Reelix gives your plugin its own copy of `@reelix/plugin`, whatever is in your `node_modules`.

### 4.3 Strings

`locales/en.json` holds the plugin's strings; `ctx.t("key", { name })` reads one in the owner's language, with `{{name}}` filled in. `zh.json`, `fr.json` and `ru.json` are optional and fall back to English. `description` is shown in Settings; `settings.<field>` and `settings.<field>_help` label the settings form; `secrets.<name>` labels a secret.

### 4.4 Settings

`config` in `definePlugin` is a TypeBox schema (`Type` comes from `@reelix/plugin`). Reelix makes the settings form from it, checks what the owner saves, fills in defaults, and starts the plugin again with the new values. `settings.schema.json` is a copy of the schema that the manifest names, so the form can be shown before the code runs. Write it again with `reelix plugin check . --write-settings` after you change the schema; a copy that differs stops the plugin.

Three annotations add what plain TypeBox cannot say. All three are in `plugins/examples/finished-cleanup/src/index.ts`:

```ts
kind: Type.String({ default: "all", [SETTINGS.optionsFrom]: "kinds" }),       // a choice filled by the operation finished-cleanup.kinds
at_most: Type.Integer({ default: 20, [SETTINGS.showWhen]: { field: "schedule", equals: "daily" } }),
// on the object: buttons that run operations of the plugin
{ [SETTINGS.buttons]: ["scan"] },
```

Telegram uses a button for linking and a test message (`plugins/telegram/src/index.ts`).

Two more say how the form is shown:

```ts
url: Type.Optional(Type.String({ [SETTINGS.required]: true })),                   // "needs setup" while it is empty (a list: without an entry)
api_url: Type.String({ default: "https://api.telegram.org", [SETTINGS.advanced]: true }), // under Advanced
```

Put the fields in the order a person fills them in. Settings shows the plugin's fields and its secrets as one form with one Save, and for a connection also on its card under Services with "Test connection", which runs your `ctx.check`. If Reelix works fully without your plugin (a chat app, a media server), set `"optional": true` in the manifest: until any required setting or secret is filled in, it shows as "optional, not connected" instead of something to fix.

### 4.5 Secrets

Declare a secret by name in `uses.secrets`, or as `{ "name": "api_key", "required": true }` when the plugin cannot work without it. `{ "name": "token", "managed": true }` is one the plugin makes and renews itself: Settings shows it as a state and nobody is asked for it. `{ "name": "api_key", "per": "servers" }` gives each entry of the list setting `servers` its own key, read as `ctx.secret.get("servers.0.api_key")` (`plugins/jackett`). The owner enters secrets in the plugin's form; it is stored as `plugins.<id>.<name>` and removed from logs, the ledger and the agent's text. Read it with `ctx.secret.get(name)`. A value the plugin makes itself, such as a generated key, is stored with `ctx.secret.set` (`plugins/push/src/index.ts`). Never return a secret from an operation or put it in a log line.

### 4.6 The network

Fetch only with `ctx.http.fetch(url, init)`, to hosts declared in `uses.network`. It applies the owner's proxy, time limits and the home-network rules, and gives you the status, headers, cookies and bytes. A redirect to an undeclared host is refused. Pass `call.signal` from a seam method, so a cancelled call stops the request.

## 5. Recipes

### 5.1 A subtitle source

Built-in: `plugins/subtitle-sites`. It registers six providers, one per site, in `src/index.ts`; `src/gestdown.ts` is the shortest. Template: `reelix plugin new --kind subtitle-source`.

```ts
await ctx.provide("reelix:subtitle.source@1", {
	id: "gestdown", label: "Gestdown (Addic7ed)", kinds: ["show"], languages: ["en", "fr", "ru", "zh"],
	async search(q, call) { /* … return hits */ },
	async download(id, call) { /* … return { bytes, filename } */ },
});
```

- `search` receives every known name of the title, its ids, season and episodes, and the wanted languages this source covers. It returns hits, each with the site's own `ref`.
- `download` may return an archive; Reelix unpacks it.
- An expected answer of the site is a typed outcome, not an error: `{ outcome: "rate_limited" }`, `{ outcome: "needs_auth" }`, `{ outcome: "unavailable", message }`, or `{ outcome: "needs_verification", url }` for a human check. After the owner passes the check, Reelix calls again with the result in `call.verification` (`plugins/subtitle-sites/src/subhd.ts`).

### 5.2 An indexer

Built-in: `plugins/jackett/src/index.ts`. Template: `--kind indexer`.

- `sites(call)` lists the sites the provider covers. `search(q, call)` returns `{ hits, sites }`: one `SiteResult` per site, so that one slow or broken site does not hide the others' hits. `fetch(ref, call)` returns the `.torrent` bytes or a magnet.
- One plugin may register several providers: Jackett registers one per server in its settings (`jackett`, `jackett-2`).
- Reelix parses the release names, removes duplicates and never shows links to the model. Your `ref` can carry a key; plugins and the model never see it.

### 5.3 A notifier

Built-ins: `plugins/push` (Web Push) and `plugins/telegram`. Template: `--kind notifier` (posts each notice as JSON to an address from its settings).

- Reelix decides what is sent and when: a notice goes out when the owner must act or it is marked urgent. `send(notice, call)` delivers one. `notice.urgent` asks for priority where the service has it.
- `can.update`: with it, `update(ref, notice, closed)` changes a sent message after the owner answers elsewhere. `can.answers`: the service can bring the owner's answer back (Telegram's buttons call `ctx.inbox.answer`).
- A failed send is tried once more after 30 seconds. A notifier that starts again is sent what it missed, at most five recent items.

### 5.4 A chat channel

Built-in: `plugins/telegram/src/index.ts`. A chat app is two seams on one connection: `reelix:notifier@1` and `reelix:chat.channel@1`.

- A long poll runs in `ctx.task`; Reelix starts it again with a growing delay when it ends.
- Each incoming message goes to `ctx.chat.receive({ channel, sender, text, … })`. Pairing is Reelix's: `ctx.owner.pair()` gives a one-time code, and only the sender who sends it becomes the owner of the channel. Messages from anyone else never reach the agent.
- `say(message, call)` sends what the agent says: text, a card as text, a question with options, or "working".

### 5.5 A downloader

Built-in: `plugins/qbittorrent/src/index.ts`. No template yet: the seam is *provisional* until a second client (Transmission) passes its conformance suite, and its contract may still change.

- Of this seam one provider is active, the one the owner picks in Settings → Services → Downloader. When it is off or broken, downloads stop with a clear error; Reelix never switches to another by itself.
- A transfer's `id` is its v1 info-hash in lower case. `add` returns `{ id, duplicate }`; when it returns, the transfer exists with the mark Reelix gave (`reelix`), paused when asked. If your client already had it, return `duplicate: true` and leave it as it is: Reelix adds its mark itself with `addMark`.
- **An empty list does nothing.** `start([])`, `stop([])`, `remove([], …)`, `addMark([], …)`, `setWanted(id, [], …)` and `list({ ids: [] })` must not reach the service: on some clients an empty or missing list means "every torrent".
- `done` is the only completion test Reelix makes: metadata present, nothing wanted missing, nothing being checked or moved, no local error. A tracker's message is a `problem` of kind `tracker`; the state stays.
- `files` is `[]` before metadata, in torrent order, with paths relative to `folder` and `/` between folders. Paths stay as the client names them; the owner's path map (`path_maps.downloaders.<your id>`) translates them.
- `changes(cursor)` is optional. When you have it, an undefined or unknown cursor gives `full: true`; Reelix treats a transfer as gone only after a full answer or `removed`. Without it Reelix polls `list({ ids })`.
- Methods whose type has no `Outcome` throw `OutcomeError` for an expected answer of the client (`throw new OutcomeError({ outcome: "needs_auth" })`): a refused login or an unreachable client is not counted as a failure of your plugin.
- `test/check.ts` gives the suite a transfer the client has (with its mark and a magnet for it), an id it does not have, and a magnet it gets by `add`; `times: 1` on a recorded answer lets the client's answer change after the add (`plugins/qbittorrent/test/check.ts`).

### 5.6 Refusing a download: `download.before@1`

Reference: `plugins/examples/max-size/src/index.ts`.

```ts
await ctx.hook("download.before@1", ({ options }) =>
	options.size > settings.max_gb * GB ? { reason: ctx.t("reason", { size: (options.size / GB).toFixed(1), max: settings.max_gb }) } : undefined,
);
```

A *guard* that runs after Reelix's own checks (hidden release, RAR, free space), with the release, the title and what will be downloaded: every file with `wanted`, the wanted bytes and the episodes. For a `.torrent` it runs before anything reaches the downloader. A magnet's files are known only once the downloader has loaded it; your refusal then removes it again. The agent sees `download_refused` with your plugin and reason.

### 5.7 Hiding releases: `release.filter@1`

Reference: `plugins/examples/block-words/src/index.ts`. Template: `--kind filter`.

```ts
await ctx.hook("release.filter@1", ({ releases }) =>
	releases.flatMap((r) => {
		const found = words.find((w) => w.pattern.test(r.title));
		return found ? [{ ref: r.ref, reason: ctx.t("reason", { word: found.word }) }] : [];
	}),
);
```

A *guard*: each plugin may say no, with a reason of at most 200 characters, and one no is final. A hidden release stays in the result, marked with your plugin and reason; the owner can still choose it.

### 5.8 Ordering releases: `release.rank@1`

Reference: `plugins/examples/prefer-freeleech/src/index.ts`. Template: `--kind rank`.

A *pipeline*: you receive the releases in the order so far and return `{ order, notes?, reason }`. `order` must hold every ref you received, exactly once. Notes are shown to the agent as facts. Return nothing for "no opinion". A follow's quick accept takes the first match in this order, so your ranking steers follows too.

### 5.9 Naming files: `organise.name@1`

Reference: `plugins/examples/name-with-resolution/src/index.ts`. Template: `--kind name`.

You receive the paths Reelix planned and return changed ones. The result must stay inside the library, keep the title folder with its `[tmdbid-N]` tag, the folder depth and the extension. Move a subtitle together with its video, as the reference does.

### 5.10 Wording notices: `notify.before@1`

Reference: `plugins/examples/short-notices/src/index.ts`. Template: `--kind notice`.

You may change the title, body or picture of a notice. You cannot suppress it or change its answers; the notice then says that your plugin edited it.

### 5.11 Adding to the agent's prompt: `agent.prompt@1`

Built-in: `plugins/telegram/src/index.ts`:

```ts
await ctx.hook("agent.prompt@1", ({ session }) => (session.channel === CHANNEL ? { title: "Telegram", text: "This thread is the owner's Telegram chat. Keep replies short; rich cards become plain text there." } : undefined));
```

A *collect* hook: at most 1,500 characters per plugin, placed before Reelix's own rules under a heading that names your plugin. Background jobs get it only when the owner allows it for your plugin.

### 5.12 Jobs, notices, events and core operations

- **A repeating job and one notice:** `plugins/examples/low-space/src/index.ts`. `ctx.job({ name, every: "60m", run })`; `ctx.inbox.add({ title, body, key })` keeps one open item per `key` (needs `uses.inbox`).
- **An event and a core operation:** `plugins/metadata-refresh/src/index.ts`. `ctx.on("config.changed", …)` (needs `uses.events`), `ctx.jobs.enqueue(name, payload, { dedupe })`, and `ctx.reelix.run("title.refresh_metadata", {})` (needs `uses.runs`; recorded in Activity under `plugin:metadata-refresh`).
- **A goal for the agent:** `plugins/auto-subtitles/src/index.ts`. When `download.filed` arrives, it queues a job; the job reads what is missing with `ctx.reelix.read` and asks the agent, in words, to find subtitles with `ctx.agent.run` (needs `uses.agent`). Names from outside go through `outsideLine`, so a file name cannot pose as an instruction.

### 5.13 Operations, typed tools, cards and proposals

Reference: `plugins/examples/finished-cleanup/src/index.ts`.

- **An operation** (`ctx.operation`) is at once an agent tool, a command (`reelix finished-cleanup scan`) and a web UI action. Its full name is `<id>.<name>`. Declare it in `uses.operations` with its effect: `read`, `write`, `destructive` or `admin`. The code may not claim another effect.
- **A typed tool** (`tool: true`, listed in `uses.tools`) is an agent tool of its own, named `<id>_<name>`. At most three per plugin; the others are reached through the agent's `reelix` tool. The summary is at most 300 characters, and the model reads it to choose tools: write it for the model.
- **A card** (`ctx.card(kind, layout)`) shows an operation's result in chat, as data: a `list` or a `text` layout, with buttons that run the plugin's operations. Reelix draws it; no code of yours runs in the page.
- **A proposal** (`ctx.propose({ key, title, why, steps })`) asks the owner to approve a list of operations. Reelix writes what the owner sees from each step's `preview`; your title and reason are quoted below it. The owner can untick steps. It is the only way a plugin gets a `destructive` operation run, and it needs `uses.inbox`.

### 5.14 Checks in Doctor

`ctx.check(name, run)` adds a line to Doctor. It returns `{ state, cause, impact?, action?, cli?, raw?, cause_id? }` with messages from your own strings ([plugins.md](plugins.md) §6, "Checks"): say what was found, what it stops, and the one thing to do. `plugins/jackett/src/index.ts` checks each server; with `quick` it only lists indexers and reports them `not_tested`, with an action that runs its own `indexers` operation with `test`. `plugins/qbittorrent` reports the client's version and save folder, and points a refused login at its password; Reelix's own "downloader" line checks the path map. "Test connection" in Settings runs your checks alone (`plugin.check`).

### 5.15 Skill packs and setup skills

Reference: `plugins/examples/seeding-report`. Template: `--kind skills`.

A skill pack is a package with `reelix.id` and `reelix.api`, no `entry`, and a `skills/<name>/SKILL.md` for each skill. Its first lines say when the agent should read it:

```markdown
---
name: seeding-report
description: Report how the owner's downloads are seeding … Use when the owner asks about seeding, ratios, or what can be cleaned up.
---
```

A script next to `SKILL.md` runs in the agent's shell and calls the `reelix` command, with the agent's own rights (`skills/seeding-report/scripts/report.sh`). The owner's approval screen lists every script.

A plugin may ship skills too (`uses.skills: true`). A skill named `setup-<id>` is a *setup skill*: when the owner switches the plugin on, the agent offers to walk them through its settings in chat. Example: `plugins/jackett/skills/setup-jackett/SKILL.md`. A secret is always asked in the secret field, never in the conversation.

### 5.16 A media server

Built-in: `plugins/jellyfin/src/index.ts`. No template yet: the seam is *provisional* until a second server passes its conformance suite.

- Of this seam one provider is active, the one the owner picks in Settings → Services → Media server (`media_server`). It is optional: without it Reelix still files, and only what needs the server is missing.
- `changed(paths)` gets folders and files as your server names them; the owner's path map (`path_maps.media_servers.<your id>`) translates them. An empty list never reaches the service. When `changed` fails, Reelix asks for `refreshAll`.
- `items` is about one user. `filter: "played"` means a film the user played, or a show with at least one played episode; give a show's `episodesPlayed` and its last `lastPlayedAt`. `sort: "lastPlayed"` is the most recent first.
- `watchUsers` is the owner's setting of whose history counts, by name; Reelix chooses the users from `users()` with it.
- `info().serverId` and `publicUrl` reach the players (section 5.17), which is how Swiftfin and Jellyfin in the browser get their ids without knowing your plugin.
- Throw `OutcomeError` for an expected answer of the server, as a downloader does.

### 5.17 A player

Built-in: `plugins/players/src/index.ts` (Infuse, Swiftfin, Jellyfin in the browser; three providers from one plugin).

- `links(requests, call)` gets every title or episode of a screen at once and returns one answer per request, in order: `{ url, autoplay }`, or `null` when your app cannot open it. Build links only; never fetch.
- A link is an app's address (`infuse://…`) or a web address. `javascript:`, `data:`, `file:` and the like are refused.
- `server` is set when the active media server has the item: its `serverId`, the `userId` whose history counts, the `itemId`, and the `publicUrl` devices open.
- The links are shown in the order of the owner's list `players`; yours comes after the listed ones until the owner adds it. The web app remembers the player by your provider id.

### 5.18 A metadata source

Built-ins: `plugins/bangumi` and `plugins/douban`.

- TMDB stays Reelix's identity for a title. Your hits are found in TMDB (by an IMDb id, else by name and year), and what you add is merged in: your id (`ids.douban`, `ids.bangumi`) and your rating. TMDB wins on a conflict.
- `fromLink(text)` answers for your own links and short ids (`douban:1`) only, and `undefined` for anything else, without a request. `find` answers a search. `enrich(ids)` gives details for the entry your id in `ids` names (a rating; for an anime the main episodes with air dates, which the anime mapping lines up with TMDB's seasons), and `{}` for ids of other sources.
- A page that refuses machines is an outcome (`unavailable`), with words that say the browser may be needed.

### 5.19 A trends source

Built-in: `plugins/bangumi` (the anime airing now, by how many watch them).

- `trending({ kind, window })` gives candidates: ids, kind, name, other names and year. Reelix finds each in TMDB and leaves out what it cannot match, adds them after TMDB's own list without duplicates, and offers them to "For you". Choosing stays with the model in core. Answer `[]` for a kind you do not have.

### 5.20 Choosing subtitle files: `subtitle.pick@1`

Reference: `plugins/examples/prefer-srt/src/index.ts`.

```ts
await ctx.hook("subtitle.pick@1", ({ files }) => {
	const srt = files.filter((f) => f.format === "srt");
	return srt.length ? { files: srt.map((f) => ({ name: f.name, score: f.score + 1.5 })), reason: ctx.t("reason") } : undefined;
});
```

A *pipeline* over the subtitle files of one downloaded archive, before Reelix picks the best file for each video. You see each file's path inside the archive, its detected languages, format and Reelix's score, and return new scores for the files you change. A language step is worth at least ten points, so a small change reorders formats without overriding the owner's languages. You cannot add or remove files. Which subtitle to download stays the agent's choice. The result names your plugin and reason.

### 5.21 A translator, and the owner's models: `ctx.model`

Built-in: `plugins/model-translator` (`src/translate.ts` is the prompt and how the answer is read).

- Reelix keeps the glossary, the review, the pacing, resuming and the file. Your `translate(job, call)` gets one chunk: the numbered `lines` (on-screen `sign`s marked), the target `to` in the owner's words, `novelty` for a constructed language or a style, the binding `glossary`, the `tone`, the lines just before as `context`, and the owner's `instructions`. Answer `{ lines, terms?, model? }`: only lines asked for, each once, never empty, with `unsure` where you doubt a line (the review looks at it) and `borrowed` where a novelty keeps words of the source. Leave out what you could not translate; Reelix asks for it again. An answer you cannot read is `{ lines: [] }`, not a throw.
- Of this seam one provider is active, the one the owner picks in Settings → Models (`translator`). When it is off, translations pause and say why.
- `ctx.model.complete({ role, system, user, signal })` asks the owner's models (`uses.model`). The role is `background` unless your manifest asks for others (`"model": { "roles": ["translate"] }`), which the owner can take back on your plugin's page. Each plugin has a daily budget in US dollars (`limits.plugin_daily_usd`, or the owner's own on your page), reset at local midnight; `"unmetered": true` asks to run without one, and the owner sees that at install and can switch it off. When the budget is used up, or no model can answer now, the answer is the outcome `unavailable`: pass it on, it is not a failure. At most 100,000 characters per call. What you spend, and what the agent turns of your jobs spend, is shown on your page.
- `test/check.ts` gives a chunk and answers recorded from a real model under `model`; the suite checks the lines, an unreadable answer, a model that cannot answer, and the deadline.

### 5.22 Tools in the agent's session: `ctx.pi`

Built-in: `plugins/browser` (ten tools, the live view, a Chromium profile in its own folder).

```ts
await ctx.pi((pi, session) => registerTools(pi, session, deps));
```

- `uses.pi: true`. The owner sees it at install as *advanced*: a raw pi extension can change the agent's prompt, tools and model traffic, and it only ever runs inside Reelix. Use pi's own API (`@earendil-works/pi-coding-agent`, install it for its types); Reelix calls your function once for every agent session, with `session.threadId`, `session.kind` and `session.notice(text)` for a line the owner sees.
- Your tools are named `<id>_<name>`; any other name, and one already taken by Reelix or another plugin, is refused with a throw. Tools are per session, and a session is opened again before its next run when plugins changed. Write files into the session's folder (`ctx.cwd` in a tool's `execute`), where the agent and `show` can use them.
- Reelix's own handlers run after yours: secrets are blanked out of every tool result and outside text is marked, whatever your `tool_result` handler did.
- `ctx.on("session.ended", ({ threadId }) => …)` frees what you held for a session. `ctx.folder()` is your own folder for larger files. Close what you started when `ctx.signal` fires.
- Test with `t.piSession({ threadId, kind, cwd })`: it loads your extension the way Reelix does and lets you call its tools (`plugins/browser/test/browser.test.ts`).

### 5.23 Routes: `ctx.route`

```ts
await ctx.route("GET", "/:tab/stream", async ({ params, signal }) => ({ events: frames(params.tab, signal) }));
```

HTTP under `/api/plugins/<id>/<path>`, behind the owner's sign-in, for the web app's screens of a plugin. A route answers `{ json }`, `{ download: { bytes, filename, type } }` (always an attachment) or `{ events }`, an async iterable sent as server-sent events, which ends when the caller goes away (`signal`). It never answers with a page: an HTML, SVG, XML or script type is refused, and every answer has `nosniff`. Throw `OperationError` to refuse (400). Test with `t.route(plugin, method, path, body?)`.

### 5.24 Blocking a tool call: `agent.tool@1`

Reference: `plugins/examples/no-delete-without-ask/src/index.ts`.

```ts
await ctx.hook("agent.tool@1", ({ operation, session }) =>
	session.kind === "job" && operation?.effect === "destructive" ? { reason: ctx.t("reason", { operation: operation.name }) } : undefined,
);
```

A *guard* on every tool call of the agent, with the tool, its input, the Reelix `operation` it runs (for a typed tool and for the `reelix` tool) and the session. One no blocks the call, and the agent is told your reason as outside text. You cannot change the input or the result. **It does not see the agent's shell**: the agent can still run `reelix download remove` there, so this hook prevents mistakes, not a determined agent. Reelix blanks secrets out of your reason after you.

### 5.25 A seam and an event of your own: `owns`, `ctx.seams.call`, `ctx.emit`

A plugin can own a seam that other plugins provide, and an event other plugins listen to. The recipe is three reference plugins: `plugins/examples/release-tags` owns the seam `release-tags:tagger@1` and the event `release-tags:tagged`; `plugins/examples/tag-hdr` provides a tagger; `plugins/examples/hdr-alert` listens to the event. All three are off by default.

The owner declares the contract as data in its manifest. Reelix checks every answer against the method's `result` schema (JSON Schema) and its time limit, and every payload against the event's `payload` schema:

```json
"owns": {
  "seams": {
    "release-tags:tagger@1": {
      "summary": "Reads tags from release names: one call per search, every release at once.",
      "methods": { "tag": { "limitMs": 5000, "result": { "type": "array", "items": { "type": "object", "required": ["ref", "tags"], "properties": { "ref": { "type": "string" }, "tags": { "type": "array", "items": { "type": "string" } } } } } } }
    }
  },
  "events": {
    "release-tags:tagged": { "summary": "A search found releases with tags.", "payload": { "type": "object", "required": ["releases"], "properties": { "releases": { "type": "array" } } } }
  }
}
```

- Names start with the owner's id: `<id>:<name>@<version>` for a seam, `<id>:<name>` for an event. A seam is of the kind *many*: every provider is called.
- Only the owner calls its seam, `await ctx.seams.call("release-tags:tagger@1", "tag", [releases])`, which answers one entry per provider: `{ provider, label, plugin, result }`, or `{ …, error }` for a provider that failed, timed out or broke the contract (that counts as a failure of the provider, not of the owner).
- Only the owner emits its event, `await ctx.emit("release-tags:tagged", payload)`. A payload that does not fit its schema is refused. Listeners cannot delay it, and an event emitted from a hook in trial reaches nobody.
- The owner's package exports the contract as types: `release-tags` has `"exports": { "./contract": "./src/contract.ts" }`, and the others write `import type { Tagger } from "reelix-plugin-release-tags/contract"`. Add the owner's package as a development dependency to compile against it; `import type` leaves nothing behind at run time. In this repository `tsconfig.json` maps the name.
- A provider lists the seam in `uses.provides` and the owner in `requires.plugins`, then `await ctx.provide("release-tags:tagger@1", tagger)`. A listener lists the event in `uses.events`, requires the owner, and `await ctx.on("release-tags:tagged", (payload) => …)`; the payload is `unknown` to the compiler, so cast it to the owner's type.
- The seams and events plugins own are in `plugin_inspect` (`pluginSeams`, `pluginEvents`, with their providers and listeners now) and in the [reference](plugin-reference.md), generated from the manifests of the plugins in this repository.
- `reelix plugin check` of a provider needs its owner and calls to make: `plugins` and `pluginSeams` in `test/check.ts` (section 6.3).

### 5.26 Running in a process of its own: `"runtime": "process"`

Reference: `plugins/jackett`, which runs there by default; `plugins/examples/finished-cleanup`, whose test runs it both ways.

```json
"reelix": { "api": 0, "id": "jackett", "entry": "./src/index.ts", "runtime": "process", "uses": { "provides": ["reelix:indexer@1"], "network": ["config:servers", "*"] } }
```

Nothing in the code changes: the same `definePlugin`, the same `ctx`. Reelix starts a Node process for the plugin and hands it the context over a message channel; every `ctx` call goes back to Reelix, which applies the same rules as inside, and your handlers (operations, provider methods, hooks, jobs, tasks, checks, listeners, routes) are called from there. A call back to Reelix names the call of Reelix's that your handler is serving, so a hook in trial and `ctx.agent.run` inside a job work as they do inside Reelix; Reelix accepts only a call it has made to your process and is still waiting for, but it cannot tell which of those your code is really serving, so trial and "inside a job" keep an honest plugin right, as inside Reelix, and are not limits on a hostile one.

- **Plain data only** crosses (structured clone): JSON values, bytes, dates. Functions you pass are handlers; signals arrive as signals and abort when Reelix aborts; an async iterable (a route's event stream) works; a provider written as a class works. A value that refers to itself is refused. `toText`, `recordInput` and `recordOutput` of an operation run in your process too. `ctx.t` and `ctx.log` stay synchronous; `ctx.t` follows the owner's language as it changes.
- **Errors** cross as code, message and data: `OperationError` and `OutcomeError` keep their meaning, an error from Reelix keeps its `code` (`network_refused`, …).
- **What Node's permission model keeps from your process**: reading anything but your own folder (with its own `node_modules`), `@reelix/plugin` and the few files of Reelix and its packages the process runs, each named by its real path; writing anything but `await ctx.folder()`; starting programs (also `process.execve`), workers and WASI; loading compiled addons; `process.binding`. Your working folder is `/`, so use `ctx.folder()` for files, not relative paths. Reelix does not start your process if one of the folders it may read holds a symbolic link that leads out of that folder. Its environment has none of Reelix's variables. Node itself says its permission model is not a defence against malicious code; it is what holds a careless plugin.
- **What Reelix's code in your process takes away**, because Node 22's permission model does not cover it: of Node's own modules you can load only `assert`, `buffer`, `console`, `crypto`, `events`, `fs`, `path`, `perf_hooks`, `process`, `querystring`, `stream`, `string_decoder`, `timers`, `url`, `util`, `zlib` and their sub-paths (the list is in the [reference](plugin-reference.md#runtimes)); the network modules, `node:sqlite`, `node:os`, `node:module`, `node:vm`, `node:v8`, `node:inspector`, `node:tty`, `node:child_process`, `node:worker_threads` and the rest are refused, also through `require`, `process.getBuiltinModule` or a module hook of your own (`module.registerHooks` and `module.register` throw). The global `fetch`, `WebSocket` and `EventSource` are gone: use `ctx.http.fetch`. A signal can go only to your own process. That is code inside your process, not the operating system: it keeps an honest plugin on `ctx.http.fetch` and makes a hostile one work much harder, but a plugin that finds a way past it could reach the network, and with it Reelix's local socket and the home network, or send a signal that stops Reelix ([the design](plugins.md), §11.7, says what is still open).
- **What Reelix checks on its side**, whatever your process does: every `ctx` call runs in Reelix with the same rules as inside; a message from your process may be at most 80 MB, and a larger one ends the process; a printed line is cut at 16 KB.
- **Failures**: time limits and failure counting are the same as inside. If your process ends by itself, that is a failure; the plugin starts again after a growing delay (two seconds, doubling, at most two minutes), and five in ten minutes switch it off. Switching the plugin off ends the process.
- **Not here**: a raw pi extension (`ctx.pi`) lives inside the agent's session, and compiled dependencies need addons; a plugin with `uses.pi` or `uses.native` runs inside Reelix only.
- **Test both ways**: `await t.manager.setRuntime("<id>", "process")` after `startPlugins` is the owner's switch; `plugins/examples/finished-cleanup/test/finished-cleanup.test.ts` runs its whole test once inside Reelix and once in a process. A plugin whose manifest says `"process"` is tested there by `startPlugins` and `reelix plugin check` without anything else.

### 5.27 A screen of its own: `reelix.screen`

Reference: `plugins/examples/finished-cleanup/screen/` (off by default), which lists the finished downloads its `scan` finds and asks the owner, through `propose`, to remove them.

```json
"screen": { "entry": "./screen/index.html", "title": "Finished downloads" }
```

- **One HTML file**, with scripts and style sheets beside it: `<script src="screen.js">` and `<link rel="stylesheet" href="screen.css">` from the screen's own folder are put inline. Nothing else loads: Reelix puts a Content-Security-Policy before your HTML that allows inline scripts and styles, pictures and fonts given as `data:` and nothing from anywhere else, no requests, frames, workers or forms. Larger than 1 MB with what is inline is refused.
- **The title** is `title` in English, `screen.title` in your locales for the other languages. The screen is listed under Plugins in the sidebar (and in More on a phone) while the plugin runs.
- **A sandboxed frame**: `<iframe sandbox="allow-scripts">` with your document as `srcdoc`. It has no origin of its own, so it cannot read Reelix's cookies or storage, call `/api` with the owner's session, open pop-ups, submit forms or navigate the page around it. `window.reelix` talks to the page through a message port the page gives only to your document as it first loads; if the frame goes to another page (a link you show, `location = …`), that page gets no port, and your screen's bridge is closed until it is opened again.
- **`window.reelix`** is all it has:
  - `await reelix.run("scan", input)` runs one of your plugin's own operations, by its short name, and gives `{ output, text }`. It runs as `plugin:<id>`, exactly as when your plugin calls it: a `destructive` operation is refused unless the owner approved it, so a screen that removes things does it through a proposal (section 5.13). Another plugin's operations and Reelix's own are refused. Errors reject with `code` and `message`.
  - `reelix.lang` (`en`, `zh`, `fr`, `ru`) and `reelix.onContext(fn)`, called when the screen starts and whenever the owner's language or theme changes. The theme tokens are set as CSS variables on your document (`--bg`, `--fg`, `--card`, `--primary`, `--primary-fg`, `--muted-fg`, `--border`, `--radius`, `--ui-font`, …; [ui-themes.md](ui-themes.md)) and given in `reelix.theme`, with `reelix.scheme` (`dark` or `light`).
- Keep the screen's own strings in the four languages inside the screen; `reelix.lang` picks them.
- The screen runs in the owner's browser, not in your plugin's process: what it can reach is what your operations give it.

## 6. Testing

### 6.1 `@reelix/plugin-testing`

`startPlugins([folder], options)` starts your plugin in a Reelix of its own, through the same loading path the server uses: manifest, loader, settings, activation. A test that builds a plugin by hand can pass while the real path fails, so there is no other way.

| Option or member | What it does |
| --- | --- |
| `settings: { "<id>": {...} }`, `secrets: { "plugins.<id>.<name>": "…" }` | What the owner would have saved. |
| `http: CannedAnswer[]` | Recorded answers in place of the network (`testing.http`). The declared hosts are still enforced; any other request fails. `t.http.requests` holds what was sent. |
| `agent: (prompt) => outcome` | What a background agent turn answers. |
| `model: CannedModelAnswer[]` | What the owner's model answers to `ctx.model.complete`; `t.model.calls` holds what was asked. |
| `t.piSession({ threadId, kind, cwd })` | Load your raw pi extension into a stand-in session and call its tools. |
| `t.route(id, method, path, body?)` | Call one of your routes as the owner's browser would. |
| `t.app.seams.provider(seam, id).call(method, [args])` | Call one of your seam methods as Reelix does, with its time limit. |
| `t.hook(name, input)` | Call every handler of a hook with this input (`testing.hook`). |
| `t.runJob("<id>.<job>", payload)` | Queue one run of a job and wait for it (`testing.runJob`). |
| `t.kv(id, key)`, `t.info(id)` | The plugin's stored value; its state, failures and last error. |
| `t.close()` | Stop everything and delete the temporary data. |

The tests of every template use only these. `plugins/jackett/test/jackett.test.ts` and `plugins/telegram/test/telegram.test.ts` are longer examples.

### 6.2 Conformance suites

A conformance suite checks one provider against the rules of its seam: unique refs, every site reported, a download that is not empty, for a downloader the rules of section 5.5, for a media server and a player those of sections 5.16 and 5.17, a provider that stops at its deadline when the service never answers, and nothing counted as a failure. The suites are in `@reelix/plugin-testing`. You do not call them yourself: `reelix plugin check`, and `checkPluginFolder(folder)` in a test, run the suite of every seam your plugin provides, with what `test/check.ts` gives.

### 6.3 `test/check.ts`

What the checker runs your plugin with. From `packages/cli/templates/indexer/test/check.ts`:

```ts
import type { PluginCheck } from "@reelix/plugin-testing";

export default {
	secrets: { api_key: "recorded-key" },
	http: [
		{ url: "https://tracker.example.org/api/me", body: JSON.stringify({ user: "owner" }) },
		{ url: SEARCH, body: JSON.stringify({ torrents: [ /* … */ ] }) },
		{ url: "https://tracker.example.org/api/download/7", body: "d4:infod4:name6:Sintelee" },
	],
	seams: {
		"reelix:indexer@1": { provider: "example-indexer", query: { queries: ["Sintel"], kind: "movie" }, expectHits: 1 },
	},
} satisfies PluginCheck;
```

- `settings` are the plugin's own settings; `secrets` are by the names in `uses.secrets`.
- `http` must be **answers recorded from the real service**, not invented ones: that is what makes the suite mean something. Record them once with `curl` and keep them.
- `seams` needs one entry per seam the plugin provides. A chat channel's entry has an `owner`, the sender id it is paired with before the suites run.
- `prepare(t)` runs before the suites, for state the provider needs (`plugins/push/test/check.ts` subscribes a browser).
- `plugins` names the folders, relative to yours, of the plugins yours requires; they start with it. `pluginSeams` gives, for each seam another plugin owns that yours provides, the provider id and calls to make; each answer must fit the owner's contract. From `plugins/examples/tag-hdr/test/check.ts`:

```ts
export default {
	plugins: ["../release-tags"],
	pluginSeams: {
		"release-tags:tagger@1": { provider: "hdr", calls: [{ method: "tag", args: [[{ ref: "r1", name: "Sintel.2010.2160p.UHD.BluRay.DV.HDR10.HEVC-GRP" }]] }] },
	},
} satisfies PluginCheck;
```

Your own tests can import the same answers, as the templates do.

## 7. Publishing

The owner installs a plugin in Settings → Plugins or with `reelix plugin add <source>`, from one of three sources:

- **A git repository, pinned to a full commit id:** `git+https://example.org/you/reelix-plugin-x.git#<40 hex characters>`. A branch or tag is refused, so the owner always gets exactly what they approved. This is the simplest way to publish.
- **npm, pinned to an exact version:** `npm:reelix-plugin-x@1.2.0`.
- **A folder** on the owner's machine, for trying.

What Reelix does at install, so you know what to expect:

- A plugin with dependencies must ship a lock file, and every dependency in it must come from a registry with an integrity hash. In git that can be `package-lock.json`. On npm it must be `npm-shrinkwrap.json`, because npm never publishes `package-lock.json`; `npm shrinkwrap` writes it. A plugin without dependencies needs neither.

- Install scripts never run, for your package or its dependencies. A shipped `node_modules` is dropped and installed again from the lock file. Symbolic links in the package are refused.
- Compiled dependencies need `uses.native: true` and ready-made binaries for the owner's platform; nothing is compiled on the owner's machine.
- Name the package `reelix-plugin-<id>` and add the keyword `reelix-plugin`. Declare `@reelix/plugin` as a peer dependency.
- Remove the `node_modules/@reelix` links of `reelix plugin new` from what you publish (`.gitignore` already keeps them out of git).

Updates are manual: the owner sees your changelog and every new declaration (hosts, secrets, operations, scripts) before approving an update.

`@reelix/plugin` and `@reelix/plugin-testing` are not on npm yet, and there is no public index of plugins. Both wait for the owner of Reelix.

## 8. Writing a plugin with a coding agent

### 8.1 Reelix's own agent

Ask Reelix's agent for a behaviour no plugin has ("hide releases from the group XYZ") and it can write the plugin itself, following the core skill `skills/writing-plugins`: it looks the facts up (`plugin_inspect`, the reference, this guide), runs `reelix plugin new <folder> --kind <kind> --id <id>` in its workspace (`<data>/workspace`), changes what it must, runs the plugin's `npm test` and `reelix plugin check <folder>`, and then `reelix plugin propose <folder> --note "…"`. Both commands work in its shell, which keeps only a short list of environment variables.

`plugin.propose` is a request, not an install. Reelix copies the folder as it is then (changes the agent makes afterwards are not part of it) and puts an item in the Inbox. Its screen is the usual approval screen, built from the manifest only, plus the agent's note as a quotation, the list of files and the difference to the agent's previous proposal of the same plugin, which a new proposal replaces. Only the owner decides: in the Inbox, or with `reelix plugin proposal <id>` and `reelix plugin proposal_decide <id> <hash> --approve` at a terminal. Approving installs the copy as a folder, with its hashes, approved; it runs after a restart. The agent can never install, switch on, approve or change an installed plugin, and what a plugin's files say is data to the model when it reads them back. A proposed plugin has no dependencies of its own.

### 8.2 Another coding agent

`reelix plugin new` writes an `AGENTS.md` into the plugin's folder. Coding agents read that file. It tells the agent where to find facts, in this order: the running Reelix (`reelix plugin inspect`, or the agent tool `plugin_inspect` inside Reelix), then the [reference](plugin-reference.md), then this guide; and to say when something is not verified instead of guessing. It also gives the rules of section 4, the commands, and the rule that a change deletes what it makes unused. Its source is `packages/cli/templates/AGENTS.md`.
