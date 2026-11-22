# Settings that read like a product, not a config file

Date: 2026-11-22
Status: **agreed** with the owner on 2026-11-22 (answers below, "Decisions"). Answers [issue #2](https://github.com/4444zyf/Reelix/issues/2) (labels, layout, exposed internals), [issue #3](https://github.com/4444zyf/Reelix/issues/3) (what Settings does when something is unavailable) and [issue #4](https://github.com/4444zyf/Reelix/issues/4) (credentials in their setup flows). All three touch the same screens, so they are one design.

Already done:
- the folder picker for the download and library folders (`61708a1`), with the folder level explained and title or season folders refused (`f91decc`);
- qBittorrent sends no more logins after a refused login or a ban, until its password changes or the owner runs its check (`f91decc`).

## The problem

Settings today is a view of `config.yaml`:
- every field prints its config path under the label (`Field` in `SettingsScreen.tsx`);
- common tasks need JSON (path maps, `proxy.per_service`) or typed IDs (subtitle sources, languages, players, model roles);
- plugin cards list capability IDs, events and operation IDs first;
- credentials that Reelix makes itself (the push key, the OpenSubtitles token) are editable fields.

When something is unavailable, Settings states it but rarely says:
- what it affects;
- what still works;
- what to do next.

Some messages suggest switching to another provider when there is none.

## Principles

1. **Task first.** A section answers "what am I setting up?" (connect qBittorrent, choose where films go), not "which key is this?".
2. **No config keys, JSON or plugin API terms in the default view.** They stay available under **Technical details** (what something is, for operators) and **Advanced** (rarely needed settings), both collapsed by default.
3. **Every unavailable state has three parts**:
   - the cause ("Jellyfin API key missing");
   - the effect ("filing continues; play links, watch history and suggestions from Jellyfin are off");
   - one direct action ("Add the key", which jumps to the field).
4. **Offer only what can work.** No "switch" without an eligible alternative, no "let the assistant fix it" without a usable model, no button whose prerequisite is unmet: it is shown disabled, with the missing step named next to it.
5. **Reuse what exists.** Health checks (`ctx.check`), provider lists, `site.status`, `/api/status` and the schema annotations already carry most of what is needed. This design mostly presents them, and adds a few markers.

## Page structure

The section bar becomes, in order:
1. **Status.** What needs attention, each with its action (below).
2. **Models.**
3. **Services:** downloader, indexers, media server, metadata (TMDB), subtitle sites, Telegram, magpie.
4. **Folders:** today's Paths.
5. **Subtitles:** today's "Services" section, renamed, because it only holds subtitle preferences.
6. **Playback.**
7. **Notifications.**
8. **Appearance.**
9. **Plugins.**
10. **Assistant:** preferences and learned skills.
11. **Account.**
12. **Doctor.**

**Advanced** is one section at the end. It collects administrator tuning:
- shell time limits;
- `schedule.*`;
- proxy per service;
- endpoint overrides of plugins;
- runtime switches;
- the summary "as the agent sees it", which is the one existing `<details>`.

Fields stop printing the config path under the label. The page has one **Technical details** switch beside the search (below): on, every field shows its config path with a copy button, and every plugin card its id and version, for people who use the CLI.

## Credentials

### Credentials Reelix manages itself (#2, highest priority)

A plugin declares a secret as **managed** in its manifest. Today `uses.secrets` is a list of names. An entry can now also be `{ "name": "vapid_private", "managed": true }`, and plain names keep working as before.

The plugin page never shows a managed secret as an input. It shows its state instead:
- **Push signing key** (`plugins/push`, made in `vapid()` on activation): shows "Created automatically", plus the number of subscribed devices. There is no way to change or remove it in Settings; rotating it is not offered until someone needs it.
- **OpenSubtitles token** (`plugins/subtitle-sites`, obtained in `login()` from the username and password, renewed daily): shows "Signed in today" or "Not signed in: check the username and password", taken from `site.status`. There is no manual token mode; if one is ever supported, it is an explicit choice.

The change reaches every layer:
- `PluginSettingsView.secrets` (`manager.ts` `settings()`) carries `managed`;
- `secret.list` does the same;
- the agent's `ask kind=secret` refuses a managed secret.

### Core credentials (#2)

`KNOWN_SECRETS` (`config.ts`) today has English-only descriptions and is shown by key. The fix:
- Each core secret gets a label and help text in the four locale files (`settings.json`, `secrets.<key>`).
- `secret.list` returns the key. The web UI translates it.

Each secret then moves to the flow that uses it:
- **TMDB API key** goes to Services → Metadata, labelled "TMDB API key". The help says what it gives: titles, posters, descriptions and episode lists.
- **Magpie gateway key** (`magpie.api_key`) goes into magpie's connection form: address, key, test.
- **Magpie admin key** (`magpie.admin_key`) goes under magpie → "Let Reelix manage magpie" (Advanced).
- **One-time provider key** (`magpie.new_provider_key`) never shows as a standing field. It is asked for only in the "add a provider" flow, as today through `ask kind=secret`.

A secret that belongs to a feature that is not set up shows "not needed while magpie is not used", never "missing" (#3).

Every password field gets a visible label and an accessible name: the account's current and new password, and `SecretRow`. Today `SecretRow`'s `aria-label` is the raw key.

## Search and filter (the owner's review of 2026-11-22)

Settings has many sections and 26 plugins; the owner asked to search and filter the page. Beside the section links:
- **Search** finds a section by its title, a field by its label or help, a service or plugin by its name or description. Everything else is hidden (not unmounted: a draft survives a search); a section whose title matches shows whole. With nothing found, the page says so.
- **Needs attention** leaves only what needs the owner: the Status list, a field that is required and empty, a service card that needs setup, is paused or cannot be reached, a plugin that failed or waits.
- **Technical details** shows config paths and plugin ids (above).

The Plugins list has its own filter: all, on, off, with their counts.

## Forms and saving (#4, and the owner's review of 2026-11-22)

Today a plugin's page has several Save buttons: one for its settings, at the far left under the fields, always shown and dimmed when nothing changed; and one more for every secret. Core fields each show their own Save, only after an edit. So one block can have two or more Saves, in three styles, and the password is saved apart from the address and user name it belongs to.

The rules:
- **One form per card or section, one Save.** A connection's address, user name, password and API key are fields of the same form, in the order a person fills them in. There is no separate "Secrets" block.
- **Where Save is.** At the end of the form, right-aligned, with **Discard** beside it. Both are disabled until something changed, and the form says "Unsaved changes" when it has. The same in every section and every plugin card.
- **Switches and choices that act alone** (a plugin's on/off, "Run in a process of its own", trial mode) apply at once and have no Save, as today. They are never inside a form that has one.
- **Core sections** (Folders, Subtitles, Proxy, Models, Limits) follow the same rule: one Save for the section instead of one per field.
- **A stored secret** shows as a filled, masked field with "Saved" and a **Replace** action; **Remove** is in the field's menu, not a button beside Save. Its label is the human one ("Web UI password"); the key goes under Technical details.
- **One save, one restart.** Saving a card sends its settings and its changed secrets together (`plugin.configure` takes both), so the plugin restarts once and is checked once. The result of that check shows on the card.

## Layout fixes found in the same review

- The floating chat button no longer covers the right edge of a section: Settings keeps a gutter for it.
- A label column never clips its badge: badges wrap under the label.
- Library folder rows put the path on its own line on a phone, with the actions below it; the up and down arrows show only when a type has more than one folder.
- The media folder has the same Browse button as the downloads folder.
- "Run in a process of its own" moves under Advanced (below, Plugin cards) and is not shown open on every card.

## Services: one card per connection

**Services** has one card per connection: downloader, indexers, media server, TMDB, subtitle sites, Telegram, magpie. A card holds:
- the address and credentials (the plugin's settings form and secrets, which today live under Plugins);
- **Test connection**;
- the state, and the effect of that state.

Plugins → that plugin still opens the same settings. The card is the default way in.

### States

States are computed from the plugin's state, its required settings and its `ctx.check` health check, which today only Doctor shows. Each state is shown with its badge and its effect:

| State | When | Shown as |
| --- | --- | --- |
| Not used | optional, never set up (magpie, Telegram) | grey; no warnings; a "Set up" button |
| Off | plugin disabled by the owner | grey; "Turn on" |
| Paused | a provider stopped on purpose (qBittorrent after a refused login, a budget reached) | amber; the reason and what resumes it |
| Needs setup | a required setting or secret is empty | amber; the missing field named, a button that focuses it |
| Unreachable | the check failed on the network | red; the error in plain words, "Test again" |
| Connected | the check passed | green; what it found ("qBittorrent 5.0.2, saves to /media/torrents") |
| Not tested | set up, check not run since start or since a change | neutral; "Test connection" |

**Required settings.** A manifest can mark settings as required with a new `x-reelix-required` annotation, which joins `SETTINGS` in `@reelix/plugin`. A required secret is marked `{ "name": …, "required": true }`. Needs setup is then known without running the check.

**The test.** "Test connection" runs the plugin's check alone: a new operation `plugin.check { plugin }`, wrapping the existing `ctx.check`. This is also the qBittorrent "controlled test" of #3: the check calls `retryLogin` and allows exactly one login. Plugins that declare `x-reelix-buttons: ["test"]`, as Telegram does, keep their own button.

**Ordered steps.** A card whose actions depend on each other shows them as numbered steps. A step stays disabled until the one before it is done, with the missing step named. Telegram's steps (#3):
1. save the bot token;
2. verify the bot;
3. link your account;
4. send a test message.

The card also says the in-app Inbox works without Telegram.

**Jackett.** One key per server. Today the manifest declares the fixed secrets `api_key`, `api_key_2` and `api_key_3`, matched to `servers[i]` by index, so three slots show even with one server. Instead, a secret can be declared **per list entry**: `{ "name": "api_key", "per": "servers" }`. It is stored as `plugins.jackett.servers.<n>.api_key` and shown inside that server's row, next to its address. Removing a server removes its key. The three old secrets move once to their server rows (`MOVED_SECRETS` in `config.ts`).

**Indexers** show the count of indexers Jackett reports. They say "not tested one by one" until `jackett indexers --test` has run, then each indexer's own result (#3).

**Downloader and media server.**
- The "active provider" choice stays.
- **Switch** appears only when another provider of that kind is running and set up (from `download.downloaders` and `library.media_servers`). Otherwise the card shows the repair action of the current one.
- The message "not running: … or choose another" no longer appears when there is no other.
- A switch always asks first, because downloads belong to their downloader, and path maps are per provider.

**Media server effects (#3).** When Jellyfin is not connected, the card says:
- filing into the library continues;
- off are: play links, watch history, "For you" suggestions and the library refresh.

The Playback section marks each player that depends on Jellyfin as "needs Jellyfin". Swiftfin and Jellyfin in the browser need the media server's item ids (`plugins/players`), so they are marked. Infuse links by TMDB id, so it keeps working.

**TMDB missing (#3).** Status shows "No TMDB key: titles, posters and descriptions cannot be looked up", with a button to the key field. It no longer shows a CLI command.

## Folders

The labels say what each folder is for, and that the paths are as Reelix sees them:
- **Media folder** (mount root): "The one folder that holds downloads and library, as Reelix sees it (inside its container)."
- **Downloads (source)**: "Where your downloader saves. Files stay here and keep seeding."
- **Library: Films / Shows / Anime (hard-link destinations)**: "The folder Jellyfin scans for this type. Reelix puts hard links here."
- Each type is a list of folders ([library-folders.md](library-folders.md)), shown with the folder picker, its name, rules and default.

**Folder checks** (#3). Under each library and download field, four separate results:
- exists;
- writable by Reelix;
- hard link from the downloads works;
- the media server sees it. This one is shown as "not verified: Jellyfin is not connected" when it isn't connected, never as a pass.

They come from Doctor's existing checks: the hard-link test and Jellyfin's library paths, now per folder.

**Path maps** (#2). The JSON field `[{ "theirs", "ours" }]` is replaced by a two-column editor:
- the left column is headed with the service's name ("qBittorrent sees"), the right one "Reelix sees";
- one row per mapping, with add and remove;
- the right column has the folder picker;
- an example row ("/downloads → /media/torrents") shows while the editor is empty.

The editor checks each row:
- **Case:** a path that matches an existing folder only in letter case is flagged ("did you mean /media/Torrents?").
- **Missing folder:** a Reelix-side path that does not exist is flagged.
- **Same path, different folders:** when both sides use the same path (both `/media`) but Doctor's downloader check finds the files elsewhere, it says the two `/media` are different folders. (Built: Doctor looks for up to five of the downloader's finished downloads where the path map puts them; when none is there, the check fails with that cause, and the downloader's card shows it under its path map.)

## Subtitles, proxy, playback

**Subtitle sources.** A list of named sites taken from `site.status`, with id, label, `enabled` and `ready`. Each site has a switch, a drag handle for order, and its readiness ("needs an account").

**Subtitle languages.** A list picker of named languages (from `LANGUAGES`), in order, with a drag handle.

**Players.** The players from the `reelix:player@1` providers, named and reorderable. This needs a new listing operation, `library.players`; today the IDs appear only in help text.

**Proxy.**
- Address field.
- **Use the proxy for** is a list of named services with checkboxes, built from TMDB, models, the browser, push and each running plugin that makes network requests, with their fetch `service` names (OpenSubtitles, SubHD…). It replaces typed IDs.
- **Per service** (Advanced): rows of service, then address or "no proxy". It replaces the JSON.

**Finished-cleanup's "All"** (#2). A choice whose options come from an operation (`x-reelix-options-from`) shows "loading…" while the operation cannot answer. It never shows the raw value, which today appears as `all`. The example plugin's locales label the value "All media types".

## Models

**No usable model** (#3). When `/api/status` lists no models (pi has no provider signed in), Models shows one state: "No model connected: chat, background jobs, translation and image reading are off." It offers three steps:
1. **Connect a model provider**, in the page: the provider's own sign-in or its API key (pi's login, run by Reelix), or magpie (its card). Never a command to type (the owner's review of 2026-11-22).
2. **Choose a chat model**, from the models available once connected.
3. **Test**: one short call through the chat role, with the answer and how long it took.

The status refreshes while this flow is open.

**Roles.**
- Each role (chat, background, glossary, translate, review) is an ordered picker of the available models: drag to order, add from a list. No typed IDs.
- Roles other than chat start empty and **inherit**. Each role shows its **effective model**, for example "Uses: qwen3.8-flash (from Chat)", taken from `models.describe()`'s `uses`.
- A model that is resting after a failure shows why and until when (the router's `resting` record).

**Labels.**
- "Thinking" becomes **Reasoning effort**.

**Translation.** The translator card says that subtitle search and download work without a translation model; only translating subtitles needs one.

**Fallback reasons** (#3). A failed call is classified:
- signed out or key expired;
- timed out;
- rate limited;
- daily budget reached;
- missing capability (images, context length).

The chat and the job record say which applied. When the next model in the owner's own list was used, they name it and say why. The router never uses a model outside the role's list, so it cannot switch to an unapproved provider or a more expensive model; this is already true and becomes a test. Each case offers its action:
- **reconnect** (signed out);
- **retry** (timed out);
- **wait until a time** (rate limit or budget);
- **choose a model that can** (capability).

## Limits and the assistant

**Limits.** Each limit says what it applies to and what happens when it is reached:
- **Background jobs, per day**: dollars and tokens. Jobs pause and resume the next day; the Status section shows when.
- **Per plugin, per day**: a plugin's own model use, inside the background limit.
- **"For you" suggestions, per day.**

A plugin page that says "no daily budget" now says "no limit of its own; the background limit (\$1/day) still applies". Shell time limits move to Advanced.

**Assistant.** Two sections that sound alike today become:
- **Your preferences**: shows the preferences note (`/data/notes/preferences.md`) itself, editable in place, with "Edit in chat" as a second option. When no model is usable, the in-place editor is the only option.
- **Skills the assistant wrote**: the list from `endpoints.skills`, each with its plain description first. The skill's name and body go under Technical details.

## Plugin cards

The card shows first:
- name;
- a one-line purpose (from its locales);
- the state badge;
- the problem, if any, with its action;
- on/off;
- settings.

Permissions stay visible, in plain words with their consequence, for example "Can reach: your qBittorrent address" or "Can run commands: no".

**Technical details** (collapsed) holds:
- id, version, install source and pin;
- the capabilities it provides (`reelix:…@1`);
- the events it listens to;
- its operations and the core operations it runs;
- its tool IDs;
- hook order.

**Advanced** (collapsed) holds:
- runtime (own process or inside Reelix);
- typed tools;
- trial mode;
- job prompts;
- model roles;
- endpoint overrides (subtitle site URLs, Bangumi and Telegram API URLs);
- binary paths (Chromium).

Plugins mark such fields with a new `x-reelix-advanced` annotation.

**Install.** The Git, npm and path syntax goes into the install dialog's help, behind a "How to name a plugin" disclosure. The review dialog keeps its full list; that is where a technical reader wants it.

**Needs before turning on.** A plugin that needs settings shows them before it is enabled, so it is never on in a "needs setup" state that the owner did not see coming.

## Status and Doctor

**Status** (top of Settings) lists what needs attention, most important first. Each item has cause, effect and one action that jumps to the field or card. It is fed by Doctor's quick checks and the service states. One cause is one item: a missing Jellyfin key appears once, though Doctor's "media server" and "jellyfin" checks both see it.

**Doctor** changes in three ways.

First, each check returns structured data, and the web UI words it in the owner's language. Today `Check` is `{ name, ok, detail, fix? }`, with English text and CLI fixes. It becomes:
- `cause`: a message key and its values;
- `impact`;
- `action`: a link target in Settings, or an operation;
- `cli`: the command, for the CLI's own output;
- `raw`: the details;
- `cause_id`: so that results with a shared cause are shown together.

Second, results show as one of these:
- passed;
- failed;
- skipped because a prerequisite is missing;
- **not tested** (Jackett's indexers before `--test`);
- **optional and not used**;
- **degraded**: missing tools such as `ffprobe` or `7z`, with what stops working, and whether anything stands in.

Raw output, process IDs and paths go behind a "Details" disclosure.

Third, "Let the assistant fix it" appears only when a model is usable. Otherwise each failed check shows its manual action.

Plugins return the same shape from `ctx.check`. The current shape keeps working: its `detail` becomes `raw`, and the cause reads "check failed".

## Copy fixes (#2)

- qBittorrent's help says "Settings → Downloads"; it becomes the real section name, with a link to it.
- The finished-cleanup "All" label is covered above.
- Push on HTTP:
  - first: "Browser notifications need HTTPS. The Inbox works without them.";
  - then: a link to the HTTPS part of `docs/deployment.md`;
  - then: other channels (Telegram) when one is connected.

  The Tailscale command moves into that help.
- Password fields get labels, as covered above.

## What changes in the code

| Place | Change |
| --- | --- |
| `@reelix/plugin` `SETTINGS` | `x-reelix-required`, `x-reelix-advanced` |
| plugin manifest `uses.secrets` | entries may be `{ name, managed?, required?, per? }` |
| `server/plugins/manager.ts` | `settings()` carries secret metadata; per-entry secrets; plugin state reasons (paused, needs setup) |
| `core/doctor.ts`, `ctx.check` | structured result (cause, impact, action, cli, raw, cause_id); new states; dedupe |
| operations | `plugin.check`, `library.players`, `model.test`; `secret.list` returns keys only and metadata |
| `core/config.ts` | Jackett secrets move per server; `KNOWN_SECRETS` loses its English text (to locales) |
| `server/models.ts` | failure classes and the reason recorded with each fallback |
| `plugins/push`, `subtitle-sites`, `jackett`, `qbittorrent`, `telegram`, `examples/finished-cleanup` | manifests (managed, required, per-server key); Telegram's ordered steps; strings |
| web `SettingsScreen.tsx` | new section order, Status, Advanced; `Field` without the config path; list, order and map editors |
| web `Plugins.tsx`, `PluginInstall.tsx` | card reorganised; Technical details and Advanced; managed secrets shown as state |
| locales (four languages) | every new label, state, effect and action; core secrets; Doctor causes |
| docs | `plugins.md` and `plugin-reference.md` for the manifest and check changes; `api.md` for the operations |
| skills | `setup-and-doctor` names sections and actions as the owner sees them |
| website, README, screenshots | the plugins screenshot is retaken (its card changes) |

## Acceptance cases

From #3, each a test (core or plugin tests, and a browser walk-through of the four languages):
- Every unavailable state shown in Settings has a cause, an effect and an action.
- **Switch** appears only with an eligible alternative; with none, the card shows repair.
- A fresh data folder can connect a model provider, choose a chat model and test it, without a word about pi internals or magpie.
- Invalid qBittorrent credentials stop background logins until the password changes or the connection is tested (done in `f91decc`).
- A model failure is reported as the right class. When the role's next model is used, it is named with the reason. No model outside the role's list is ever used.
- A downloader or media server is never switched without the owner choosing it.
- Doctor in Chinese shows no English cause text and no CLI line in the default view; a shared cause appears once.
- No config key, JSON field or capability ID is visible in Settings with Technical details and Advanced collapsed.

## Not part of this

- New notification channels.
- An HTTPS setup wizard.
- Moving library titles (see [library-folders.md](library-folders.md)).
- A full accessibility audit beyond the labels named here.

## Decisions (2026-11-22)

1. **Services are cards** in their own section, the default way in. A plugin's own page under Plugins opens the same form.
2. **Doctor's CLI line** is shown in the web UI only inside the check's collapsed Details; the default view words the cause, effect and action in the owner's language.
3. **The push key is not rotatable** from Settings. It is shown as made by Reelix, with no input.
4. **One Save per section** for core settings too (Folders, Subtitles, Proxy, Models, Limits), as for the cards.

## Implementation status (2026-11-22)

Built:
- **Page:** the section order above, with Status first (what needs attention, from the plugins' states, the model, the TMDB key, the budget and Doctor's quick checks, each with cause, effect and a button to the place to fix it; a cause shown once) and Advanced last; search, "Needs attention" and "Technical details"; config paths only with Technical details on; a gutter for the chat button.
- **Forms:** one form and one Save (with Discard and "Unsaved changes") per section and per card (`components/settings/form.tsx`); secrets are fields of their form, shown masked with "Saved", Replace and Remove; ordered pickers for subtitle sites, languages, players and model roles; a path-map editor with a folder picker and checks for a missing folder, a letter-case mistake and a folder outside the media folder; per-service proxies as rows; folder checks under each saved folder.
- **Plugins and credentials:** `uses.secrets` entries with `managed`, `required` and `per`; `SETTINGS.required` and `SETTINGS.advanced`; the manifest's `optional`; `plugin.list` gives `managedSecrets`, `needsSetup`, `unused` and `network`; `plugin.configure` saves settings and secrets in one change (one restart), refuses managed and undeclared secrets, and moves a key with its entry (`origins`); Jackett has one key per server (the old three move once); push's key and the OpenSubtitles token are shown as made by Reelix. The global Secrets section is gone: TMDB and magpie have their cards, plugin secrets are in their forms, the one-time provider key is only asked in the agent's flow.
- **Services:** cards for the downloader (with its path map and, when another is running, the switch, which asks first), indexers, media server (likewise), TMDB, subtitle sites (grouped by site, with what an account adds), Telegram (four steps, each waiting for the one before) and magpie (address and key, admin key under Advanced). A card's state comes from the plugin, its setup needs and its last check (`lastCheck`); "Test connection" runs `plugin.check`.
- **Doctor:** structured results, states, a shared cause shown once, actions that jump to the field, raw output and the command line under Details (`components/settings/Doctor.tsx`, `core/doctor.ts`; `media.folder_checks`, `plugin.check`).
- **Models:** with no model, the three steps (connect a provider in the page, with its own sign-in or its API key, or magpie; choose a chat model; test it), and a Providers list (sign in, sign out) once one is connected, refreshing while open (`components/settings/ModelSetup.tsx`); roles as ordered pickers showing the model each uses and those resting; "Reasoning effort", the translator. Failed model calls are classed (signed out, timed out, rate limited, budget, missing capability, other) with an action; the chat shows a failure and the next model's answer names it; an agent job hands its task to the role's next model and records both (`job_runs.models_json`); `model.test` (docs/models.md).
- **Telegram** says a model's failure and the next model's answer in words, as the web chat does.
- **Other operations:** `library.players`, `proxy.services`, `preferences.show`, `preferences.set`.

### Audit against this document (2026-11-22)

Each section above was checked against the code and in a browser on a demo server (desktop, and a phone width for Services and Folders), in the four languages for Status, Services, Doctor, Notifications and a plugin card:

| Section | State |
| --- | --- |
| Principles | Held: no config keys, JSON or capability ids in the default view; every unavailable state has cause, effect and action; Switch, Test and "ask the assistant" only when they can work. |
| Page structure | Built, with Proxy and Limits as sections of their own (below). |
| Credentials Reelix manages | Built: shown as a state, worded by the plugin (push: "Created automatically", the devices under Notifications; OpenSubtitles: signed in or not); refused by `plugin.configure` and the agent; `secret.list` marks them. |
| Core credentials | Built: TMDB and magpie on their cards; the one-time provider key never a field; labelled password fields. |
| Search and filter | Built and checked (a section hidden by one search comes back with the next). |
| Forms and saving | Built: one Save per section and card; a card saved is checked once and shows the result. |
| Layout fixes | Built, except the media folder's Browse (below). |
| Services and States | Built: Not used, Off, Paused, Needs setup (the missing fields named, a button to the first), Not reachable, Connected (what the check found), Not tested; the last check, from Doctor or the card, shows on the card. |
| Folders | Built: labels, folder checks, path-map editor with its checks, and the same-path check from Doctor. |
| Subtitles, proxy, playback | Built. |
| Models | Built: the no-model flow with sign-in in the page, roles with the model each uses and why a model rests and until when, the test, failure classes in chat, chat apps and jobs. |
| Limits and the assistant | Built: each limit's effect; a plugin with no budget of its own names the background limit that still applies. |
| Plugin cards | Built: purpose, state, problem, switch, what it may reach in plain words; How it runs and Technical details collapsed; switching on a plugin that needs setup opens its settings. |
| Status and Doctor | Built. |
| Copy fixes | Built: push on HTTP says the Inbox works, links to the HTTPS guide (`docs/web-app.md`), gives the Tailscale command and names a linked chat app. |
| Acceptance cases | Each has a test (core, server or plugin tests), and the browser walk-through above. |

Telegram's card was walked in a browser, in English and Chinese, against the plugin's fake Bot API: optional and not connected, the token saved, the bot checked, the code sent from "Telegram" and the account linked (the card follows it by itself), the test message received, connected. Each step's answer is worded in the owner's language. What needs the owner's own accounts was not tried: Telegram's real servers with a real bot, and push on a real iPhone (docs/web-app.md).

Different from the text above, and why:
- Proxy and Limits are sections of their own, and the nightly time and time zone are under Limits, not Advanced: the owner sets them, they are not tuning. A plugin's endpoint overrides, runtime and tools are under its card's Advanced and How it runs, where they belong to it, not under the page's Advanced.
- The media folder has no Browse button: the folder picker browses inside the media folder, so it cannot choose it.
- Lists are ordered with up and down buttons, not drag handles: the same on a phone and with a keyboard.
- Models are not offered in "use the proxy for": nothing routes model traffic through Reelix's proxy (pi's providers make their own requests). The old help text named it; it no longer does.
- A stored secret's Remove is a button inside its field, not a menu: one click fewer, and still apart from Save.
- Technical details is one switch for the page, not a disclosure per field: one disclosure per field doubled the clutter it was meant to remove.
- The switch "main model reads images" is gone instead of becoming "Image reading": nothing read it (`models.main_reads_images` is dropped from old settings).
- `KNOWN_SECRETS` keeps its English descriptions: the command line and the agent read them. The web UI has its own labels in four languages.
- The browser plugin is offered in the proxy list once it has asked for its proxy (it drives Chromium itself and declares no network hosts).
