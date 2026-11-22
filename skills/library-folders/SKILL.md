---
name: library-folders
description: Several library folders for one media type (for example "Chinese-language Movies" and "International Movies", each a Jellyfin library) — learning how the owner sorts titles between them, writing that down as rules, and choosing the folder for a title no rule decides. Use when a media type gets a second folder, when filing stops with "No library folder is decided", or when the owner says where a title or a kind of title belongs.
---
# Library folders

A media type (`library.movies`, `library.shows`, `library.anime`) is a list of folders. Each folder has a `path`, and may have a `name`, `rules` and `default: true` (at most one per type). Code chooses the folder for a title in this order, and you never need to repeat it:

1. the title is already in the library (its folder, or a folder with its `[tmdbid-N]` tag): that folder, always;
2. the folder chosen for the title (`title.library_folder.set`);
3. the first folder whose rule matches;
4. the only folder of the type;
5. the default folder.

Otherwise code stops and the download comes to you: **"No library folder is decided"**. Nothing is ever moved between folders: not by you, not by a rule change.

**A rule** names TMDB facts and the values that count: `{ "when": { "original_language": ["zh", "cn"] }, "note": "…" }`. Facts: `original_language` (ISO 639-1, e.g. `zh`, `ja`, `ko`), `origin_country` (ISO 3166-1, e.g. `CN`, `TW`, `HK`), `genre` (TMDB's English names, e.g. `Documentary`, `Animation`). A title matches when, for every fact named, it has one of the values. Write the `note`: what the rule was learned from ("47 of the 48 films here are in Chinese; learned 2026-11-22").

**Only the owner changes `library`.** Propose rules with the `reelix` tool, `command=config.set`, path `library.movies` (the whole list, with every folder's path, name, default and rules) or `library.movies.<n>.rules`. Reelix shows the owner the exact change and asks; from a background job the question goes to the Inbox and the job parks. `reelix config set` from the shell is refused for these.

## Learning, when a type has two or more folders

1. `reelix library folders survey movies` (operation `library.folders.survey`): per folder, the titles in it with their language, countries and genres, the counts of each, the untagged folders, and the titles the current rules would put elsewhere. It reads TMDB for titles it does not know, up to 200 per call: call it again while it says titles are not read yet.
2. Find what separates the folders. Prefer one fact over several, and few values over many. A folder holding everything the others do not hold is the **default**, not a rule.
3. Check the fit before proposing: name the titles the rules would put elsewhere, and say how many fit ("all 48 Chinese films; 1 of 230 international films would move: …"). A rule that misplaces many titles is wrong; look again.
4. Propose the rules and the default in one `config.set`, with the fit in your message.

## Deciding a title no rule decides

1. Read the title's facts (`reelix title show <id>`; refresh it with `reelix title find --id <id>` if the language is empty) and the survey.
2. Compare: the folder whose titles are most like this one, by the same facts.
3. **Sure** (one folder clearly fits, the others do not): `reelix title library_folder set <id> "<folder name or path>"`, then `reelix download file <hash>`. Then propose the rule that would have decided it (a value added to an existing rule, or a new rule), with `config.set` as above.
4. **Not sure** (two fit about equally, none fits, or the facts are missing): ask with the `ask` tool, `kind=choice`, your best guess first, one option per folder. Set the answer with `title.library_folder.set`, file it, and propose a rule from the answer.

## When the owner corrects you

The owner chose a folder against what the rules said (on the title page, in the Inbox, in chat): propose a change to the rules that fits the new choice and every title already in the folders (check with the survey). If no rule can fit them all, say so and leave the rules as they are; the choice for that one title is enough.

## Do not

- Move or re-file a title that is already in the library to follow a rule. Re-filing is the owner's decision (skill fixing-mistakes).
- Write rules from a single title unless the owner said it is a general preference.
- Create folders. A new folder is also a new Jellyfin library, which the owner sets up.
