---
name: translation
description: Translating an existing subtitle into another language or style with subtitle_translate, as a separate styled file (French, Chinese, Klingon, Elvish, pirate speak…). Covers when to offer it and when not to, what the owner has said before, choosing the source subtitle, the look, size and progress, the glossary, and titles with their own constructed language. Use when the owner asks for subtitles in a language no source has, when a filed title lacks subtitles in the owner's language, or when a title has its own invented language.
---
# Subtitle translation

Reelix can turn an existing **text** subtitle into a new one in any language or style. The result is a separate `.ass` file next to the video, labelled `AI`. The video is never changed. Models do the writing in a background job; you start it and report.

## Never without a yes

Start a translation only when the owner asked for it, said yes to your offer, or the preferences note has a standing rule that covers it.

**Read the preferences note first.** Under "Translation" it may say:
- standing rules ("always translate anime to Chinese without asking", "never offer for documentaries", "no novelty subtitles");
- franchise answers ("Klingon for Star Trek: yes");
- a tally of recent answers.

**Write what you learn there.**
- A lasting statement from the owner becomes a rule at once.
- Otherwise add one line per answer to the tally (`2026-11-18 anime, zh: yes`). When the last three answers for the same kind of title are identical, ask once: "Shall I always do this without asking?" Write the rule only on a yes.
- Never change your behaviour from the tally alone.

## When to offer

1. **A filed title has no subtitle in the first wanted language**, the sources have none, and a usable subtitle in another language exists or can be fetched. Offer once for that title or season. The after-filing job tells you whether an offer is still allowed.
2. **The title has its own constructed language** (Star Trek → Klingon; The Lord of the Rings or The Hobbit → Sindarin; Avatar → Na'vi; Game of Thrones → Dothraki or High Valyrian; you know others). Mention it once per franchise, when the owner asks for such a title or it has just been filed, after the ordinary business is done: "Want Klingon subtitles for it as well?" Record the answer in the note under the franchise's name. Skip languages with only a handful of words. Skip all of this if the note says no novelty subtitles.

An offer states the size and the source: "24 episodes, about 9,000 lines, from the English subtitle." In a background job, offer with `notify` (wait=true, options yes/no) and stop.

## Steps

1. **Source.** `subtitle_translate_sources title_id=… [season=…]` lists what can be used.
   - Prefer a human-made subtitle in the title's original language; otherwise English. Pass `source_language` when it is not English.
   - Nothing usable: fetch one first with the `subtitles` skill (`subtitle_search languages=[…]`, `subtitle_fetch`), then translate.
   - Only a machine-translated one exists: say so and ask before using it.
   - Picture-based tracks (PGS, VobSub) cannot be read. Say so plainly; do not try.
2. **Start.** `subtitle_translate` with:
   - `target`: the language or style in English ("French", "Klingon", "pirate English").
   - `code`: the ISO code where one exists (`fr`, `zh`, `tlh` Klingon, `sjn` Sindarin, `qya` Quenya); otherwise a private one (`x-pirate`, `x-navi`).
   - `novelty=true` for constructed languages and styles. The source line then appears underneath when the owner reads it, and the file is never the default subtitle.
   - `style`: `plain` for ordinary translations; for novelty pick one that fits (`warrior` for Klingon, `parchment` for Elvish, `terminal`, `storybook`, `cinematic`). `reelix subtitle styles` describes them.
   - `custom_style` only when the owner describes a look; it takes plain styling fields. `effects` for fade or typewriter.
   - `instructions`: the owner's wishes in a sentence ("keep honorifics", "formal vous").
   - `when_filed=true` when the owner wants it for everything of this title from now on (new episodes, or a film that has not arrived yet).
3. **Tell the owner what happens next.** It runs in the background; a film takes minutes, a season longer. For a season the first episode is finished first as a sample. Do not wait in the conversation: the result is sent to this conversation when it ends.
4. **Report** what the result says, briefly and honestly: lines, corrections, lines still too long, and for a constructed language the share that kept borrowed words and that the review could not check correctness. Say when the same model translated and reviewed.

## Progress, stopping, corrections

- `subtitle_translation [id=…]`: progress and result.
- `subtitle_translation_cancel id=…`: stop; finished episodes stay.
- **Paused** means no model could answer (down, or the spending limit on the gateway key), the translator plugin is off, or the owner gave it a daily budget that is used up (Settings → Plugins → model-translator; it resets at midnight). It retries by itself; tell the owner the reason shown. Raising a budget is the owner's decision, made on that page.
- **Names and terms.** `subtitle_glossary title_id=… target=…` shows them. When the owner corrects one ("call him the Captain"), use `subtitle_glossary_set`; only the lines that mention it are redone.
- **A different look** for a finished translation: start it again with the new style; the lines are redone too, so say that first.
- The owner dislikes the result: delete the file like any library file, and record what was wrong in the note if it is lasting.

## Limits to be honest about

- Constructed languages have small vocabularies. The translation keeps names and words with no equivalent, and does not invent words. It is for fun, not for study.
- Klingon is written in Latin letters unless the owner asks for pIqaD (`piqad=true`), which shows only on a player with a pIqaD font.
- No translation from speech, and none from picture-based subtitles.
