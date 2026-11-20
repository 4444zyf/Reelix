# Several library folders per media type

Date: 2026-11-20
Status: **proposed**, shaped with the owner on 2026-11-20 (the agent learns the owner's folders and keeps them as rules); not yet agreed in full. Answers [issue #1](https://github.com/4444zyf/Reelix/issues/1).
Changes design §5.4 (layout) and the `library` settings.

## The problem

Today each media type has one library folder: `library.movies`, `library.shows`, `library.anime`, each one path. An owner whose Jellyfin already scans several folders for one type cannot use them:

```
library/movies/Chinese-language Movies/     ← a Jellyfin library
library/movies/International Movies/        ← another one
library/shows/East Asian Shows/
library/shows/Western Shows/
library/anime/Anime Series/
```

Setting `library.movies` to one of these sends every film there. Setting it to the parent makes Reelix create title folders next to the category folders, where Jellyfin does not look. The `organise.name@1` hook cannot help, because it may not change the title folder or the depth.

## The idea

A media type has a **list of folders** instead of one. Which folder a title goes to is the owner's taste, and the owner has usually shown it already: the titles sitting in each folder. So:

- **The agent learns** the owner's sorting from what is already in each folder, and from every answer the owner gives later.
- **It writes what it learned down as rules**, plain data in the settings, which the owner can read and change.
- **Code applies the rules** to every new title, with no model, as routine filing does today (§5.4).
- **When no rule decides**, the agent compares the new title with what each folder already holds, picks the most similar folder, files it there if it is sure, and proposes a rule so the same case is decided by code next time. When it is not sure, it asks.

Reelix chooses the folder for a title once, before the naming rules, and then names files inside it exactly as now. Everything after the choice is unchanged: the `[tmdbid-N]` folder, seasons, versions, subtitles, the hard-link rules, `path_maps`, Jellyfin's refresh.

## Settings

```yaml
library:
  movies:
    - path: /media/library/movies/Chinese-language Movies
      name: Chinese-language          # shown in the UI and to the agent; defaults to the folder's name
      rules:
        - when: { original_language: [zh, cn, yue] }
          note: "47 of the 48 films here are in Chinese; learned 2026-11-20"
    - path: /media/library/movies/International Movies
      name: International
      default: true
  anime:
    - path: /media/library/anime/Anime Series
```

- Each type is a list of folders: a `path`, and optionally a `name`, `rules` and `default`.
- **A rule** lists TMDB facts and the values that count. A title matches when, for every fact in the rule, it has at least one of the listed values. A folder matches when any of its rules does. The facts: `original_language` (ISO 639-1), `origin_country` (ISO 3166-1), `genre` (TMDB's English genre names). These are what TMDB gives for every title and cover the cases seen so far ("Chinese-language films", "East Asian shows", "documentaries"); more facts are added when someone needs one.
- **`note`** says where a rule came from (learned from which titles, or set by the owner). The agent writes it; it is not used for matching.
- **`default`** (at most one folder per type) is optional: the folder for titles no rule decides, for an owner who would rather not have the agent choose. Without one, the agent chooses (below).
- **Existing settings keep working.** A single path (`library.movies: /media/library/Movies`) is read as a list with one folder, the same way `models.main` was migrated (`migrateConfig` in `config.ts`). Nothing on disk moves.
- `anime` still falls back to `shows` when it has no folders.

Settings → Paths shows a list per type: add, remove and reorder folders, edit their rules (each with its note), mark the default. Each folder is chosen with the folder picker (operation `media.folders`), as the single paths are today.

**Only the owner changes `library`.** It joins the settings that need the owner's confirmation (`OWNER_SETTINGS` in `config.ts`, with `plugins`, `proxy` and the others): when the agent calls `config.set` on it, Reelix shows the owner the exact change and asks, in chat or, from a background job, in the Inbox. So the agent proposes rules and the owner approves them, through the mechanism that already exists. Today the agent may set `library` freely; this tightens that.

## Choosing the folder for a title

The first step that gives an answer wins:

1. **The title is already in the library** (`titles.library_folder`, or a folder with its `[tmdbid-N]` tag in any folder of its type): that folder. New episodes of a show go where the show already is, whatever the rules say now. Changing a rule never moves anything.
2. **The owner chose a folder for this title** (`titles.library_choice`, below).
3. **The rules**, in the order of the list: the first folder with a matching rule.
4. **Only one folder** for the type: that one.
5. **The default folder**, if one is marked.
6. **The agent decides** (next section). Code does not file the download; it waits in the existing `needs_agent` state with the reason "no library folder decided", and the background job that handles `needs_agent` downloads takes it.

The plan's reason always names the folder and why ("Chinese-language: rule original_language zh", "International: default", "Western Shows: chosen by the agent, closest to Severance and Slow Horses").

## What the agent does

A skill (`skills/library-folders/SKILL.md`) tells it how. It works from facts code gives it; it does not walk the disk itself.

**Learning, when a type gets a second folder** (in setup, or when the owner adds one):
1. `library.folders.survey` (new operation, read-only) lists, per folder, the titles in it, found by their `[tmdbid-N]` tags (untagged folders are looked up by name), with each title's language, countries and genres, and the counts of each value.
2. The agent looks for what separates the folders ("47 of 48 here are in Chinese; none in the other folder is") and writes the fewest rules that sort the existing titles the way the owner already did. It reports how well they fit, naming the titles they would put elsewhere.
3. It proposes them with `config.set` (owner-confirmed, above): the owner sees the rules and the fit and approves in one tap, or edits them in Settings instead. Nothing changes before approval.

**Deciding a title no rule decides** (step 6):
1. It compares the title's facts with each folder's survey: the folder whose titles are most like it.
2. **Sure**: it files the title there, records that as the title's choice, and proposes the rule that would have decided it ("add Korean to East Asian Shows?").
3. **Not sure** (two folders fit about equally, or none does): it asks, with an Inbox question naming the title and the folders, its best guess first. The answer becomes the title's choice, filing continues, and a rule is proposed from the answer.

**Learning from corrections.** When the owner picks a folder by hand (the title page, the Inbox, chat) against what the rules would have said, the agent proposes a change to the rules that fits the new choice and every earlier one, or says why none does.

Rules change only through the owner's approval or the owner's own edit. A filing the agent was sure about happens without waiting; a rule, which decides future filings silently, does not.

## The owner's choice per title

`titles.library_choice` holds the chosen folder's path. It is set by an Inbox answer, by the agent with a new operation `title.library_folder.set { title, folder }` when the owner says so in chat or the agent decided (step 6), and on the title's page: a "Library folder" select, shown only before the title is in the library and only when its type has more than one folder.

Once a title is in the library, its folder is shown but not editable: moving a filed title between folders is moving its links (§5.8, fixing mistakes), not part of this change.

## New title facts

Titles store `original_language` and `origin_country` (a list) from TMDB, next to the genres they already use for anime. New columns, filled when a title is created or refreshed. A title stored before this change has them empty until it is refreshed; the survey and the deciding step refresh the titles they look at first.

## What changes in the code

| Place | Now | After |
| --- | --- | --- |
| `config.ts` | `library.movies` etc. are strings | lists of `{ path, name?, rules?, default? }`; the old string is migrated |
| `db.ts`, `titles.ts` | | `original_language`, `origin_country`, `library_choice` on titles |
| `organiser.ts` `libraryRootFor(app, cls)` | one path per type | `libraryFolderFor(app, title)`, the steps above; "undecided" when it reaches step 6 |
| `organiser.ts` `libraryRoots` | three paths | every folder of every type (apply, subtitles, doctor, library scan) |
| `downloads.ts`, `adopt.ts` | root by type | the title's folder; undecided goes to `needs_agent` (downloads) or is marked unsure on the review screen (adoption) |
| `checkWrittenItems` (the agent's plans) | the type's root | the folder chosen for the title |
| `organise.name@1` | paths relative to the type's root | relative to the chosen folder; the input names it. Limits unchanged |
| `library.ts` | looks in three roots | looks in every folder |
| `doctor.ts` | link test and Jellyfin check per type | per folder |
| operations | | `library.folders.survey`, `title.library_folder.set`; `library` becomes owner-confirmed, so the agent's rule changes are approved by the owner |
| skills | `organise` says one root per type | `organise` updated; new `library-folders` |
| web | three path fields | a folder list per type with rules; the title's folder select |

`apply` keeps its rule that a destination must be inside a library folder; it now checks all of them.

## Not part of this

- Moving titles between folders, and re-sorting an existing library by new rules.
- Rules in plain words judged by the model at filing time: routine filing stays code (§5.4). The model's judgement is used where rules run out, and its result is turned back into a rule.
- A plugin hook to choose the folder. The name `organise.route@1` is reserved for it.
