# Subtitle translation

Date: 2026-11-18
Status: design agreed with the owner in an interview on 2026-11-18. **Being built; nothing here is verified yet.** The implementation status is at the end.

When no subtitle exists in a language the owner wants, Reelix can translate one that does exist. The target can be any language or style the model can write, including constructed ones (Klingon, Sindarin, Na'vi) and registers (pirate, Shakespearean). The result is a separate styled subtitle file next to the video. The video is never edited.

Every decision below was put to the owner as a question and accepted, except where marked **(detail)**, which follows from an accepted decision.

## 1. When it happens

Nothing is translated without a yes.

| Trigger | What the agent does |
| --- | --- |
| **The owner asks in chat** | "Klingon subtitles for this", "translate the English one to French". Starts straight away. |
| **A filed title lacks the preferred language** | The existing after-filing subtitle job searches the sources. If it finds nothing in the first wanted language but a usable subtitle in another language exists, the agent makes one offer in that title's thread (and on Telegram if linked). |
| **A title has its own constructed language** | Star Trek → Klingon, The Lord of the Rings → Sindarin or Quenya, Avatar → Na'vi, Game of Thrones → Dothraki or High Valyrian. The agent offers it in the filing report, after ordinary subtitles are settled. |

Rules for offers:
- **Once:** one offer per title or season for a missing language; one per franchise for a constructed language. Never repeated.
- **Recognising a franchise language:** the agent's own knowledge plus the TMDB details. There is no hard-coded list. Languages with only a few dozen words on screen are not offered.
- **Automatic translation** (no question) is off. It can only be turned on by a standing rule the owner states.

### Memory

The agent keeps what it learns in the preferences note (`notes/preferences.md`), which it already reads at the start of every conversation.

- **Standing rules** are written when the owner says something lasting: "always translate anime without asking", "never offer for documentaries", "offer Klingon for Star Trek: yes", "no novelty subtitles".
- **Repeated answers:** after three identical answers for the same kind of title, the agent asks once whether to make it a rule, and writes it only on a yes. It never changes behaviour silently.
- A general "no" to novelty languages stops all franchise offers.

## 2. What is translated from

An existing **text** subtitle only:
- a file next to the video;
- a text track embedded in the video (extracted with ffmpeg);
- one fetched from the subtitle sources.

Choice of source, in order:
1. a human-made subtitle in the title's original language;
2. the best human-made English one, by the same release-matching rules as ordinary subtitles.

Not used:
- **Machine-translated subtitles**, unless the owner agrees after being told nothing else exists.
- **Picture tracks** (the usual Blu-ray and DVD kind: images of text). Reading them needs text recognition, which is out of this version. The agent says so and looks for a text subtitle instead.
- **Speech-to-text.** Out of this version.

## 3. The translation job

A background job with three stages, each on its own model role (§6).

| Stage | Role | What it does |
| --- | --- | --- |
| **Glossary** | `glossary` | Reads the whole subtitle once and writes down names, recurring terms and the tone. |
| **Translate** | `translate` | Works through the lines in chunks, with the glossary and the lines just before as context. Reports new names it meets, which join the glossary. This stage is the active translator's (`reelix:translator@1`, [plugins.md](plugins.md) §7.8), chosen by the owner (`translator`, Settings → Models); the built-in `model-translator` plugin asks the `translate` role. |
| **Review** | `review` | Checks a sample plus every line the translator marked as unsure or that came out too long, and sends corrections. One pass. |

What must survive:
- **Timings and line count.** Every source line gets exactly one translated line with the same start and end. Code checks this after each chunk and redoes a chunk that breaks it.
- **Signs and songs.** In an ASS source, on-screen signs keep their position and style; karaoke lines and drawings are copied untouched. Styling codes are removed before the model sees the text and put back afterwards.
- **Readable length.** A line too long for its time on screen (about 20 characters a second; half that for Chinese and Japanese) is marked for the reviewer to shorten.

Other behaviour:
- **Checkpoints.** Progress is saved after every chunk. A restart, a pause or a spending limit resumes where it stopped. Cancelling keeps the episodes already finished.
- **Seasons.** The offer states the size ("24 episodes, about 9,000 lines"). Episode 1 is done first and announced as a sample; the rest continues unless the owner stops it. One translation runs at a time.
- **Glossary.** Kept per title and target language, and reused for later episodes and seasons. The owner can see it and correct an entry in chat ("call him 'the Captain'"); the agent then redoes only the lines that entry affects.
- **Review by a second model.** When the `review` role has its own model, a different model checks the work. When it does not, the same model reviews and the report says so.

### Constructed languages and styles

Best effort, stated plainly.
- The translator uses real vocabulary and grammar where they exist, and keeps names and words with no equivalent in the original. It does not invent words that look right.
- The report gives the share of lines that kept borrowed words.
- The reviewer checks consistency and length only, not correctness, and the report says that.

## 4. The file

- **Format:** always ASS, so it can carry the look.
- **Name:** `Film (2010).AI.fr.ass`; for a novelty language `Film (2010).Klingon AI.tlh.ass`. The `AI` label is always present, so Jellyfin shows it. Real language codes are used where they exist (Klingon is `tlh`); a style with no code gets a private one such as `x-pirate`. **(detail: the label comes before the language code because that is how Reelix already names labelled subtitles.)**
- **Default flag:** set only when the target is one of the owner's wanted languages and no human subtitle in it exists. Never for novelty languages.
- **Later human subtitle:** it takes the default flag. The AI file stays until the owner deletes it.
- **Overwriting:** never anything but its own earlier AI file for the same video and language.
- **Wanted languages:** an AI file does not count as "has subtitles in my language" for the sources, so a human one is still looked for.

### The look

Two layers.

**Presets** ship with Reelix:

| Preset | Look |
| --- | --- |
| `plain` | white, thin black outline |
| `cinematic` | warm serif, soft shadow, gentle fade |
| `warrior` | angular amber capitals (Klingon and the like) |
| `parchment` | pale gold italic serif (Elvish and the like) |
| `terminal` | green monospace in a dark box, typed out |
| `storybook` | cream text in a brown box (pirates, rhymes) |

The agent picks one from the language and the title's genre, or the owner names one.

**Custom looks:** the agent may write its own on request ("make it look like a terminal"). A checker accepts only a fixed list of styling fields (font, size, colours, outline, shadow, box, position) with plain values, and only fonts that are installed or in a common list. A look can therefore never carry drawings, clips or other codes into the library.

**Effects**, generated by code from the timings, never by the model:
- **fade:** each line fades in and out;
- **typewriter:** letters appear one by one.

Per-word karaoke timing is out: the source has no word timings.

**Second line.** The source text can be shown underneath, smaller and dimmer. It is on by default for novelty languages and off for real ones, and only used when the source is in a language the owner reads (a wanted language).

**Klingon script.** Latin letters (tlhIngan Hol) by default. The pIqaD script is an option; it needs a pIqaD font on the player.

## 5. Where it appears

- **Chat:** the agent's tools start a translation, list usable sources, show progress, cancel, and show or correct the glossary. A `translation` skill tells it how.
- **Subtitles panel:** a "Translate…" action on a title, which opens a chat message with the request filled in.
- **Activity:** the job with its progress and a cancel button.
- **Settings:** the model roles, and the magpie address and key (§6).
- All new text is in the four languages. Tests run against a fake model.

## 6. Models

Described in [models.md](models.md). In short: named roles (`chat`, `background`, `glossary`, `translate`, `review`), each an ordered list of models with simple fallback, and an optional magpie gateway that owns smart routing and spending limits.

Translation spend is recorded separately and does not count against the background jobs' daily cap: the glossary and the review under `translation`, the lines under the translator plugin (`plugin:model-translator`), which its plugin page shows. `model-translator` asks to run without a daily budget, so by default Reelix has no translation cap of its own: the limit is the one set on Reelix's gateway key in magpie, and without magpie the only guard is the size stated in the offer. The owner can give it a daily budget on its page ([plugins.md](plugins.md) §10.2); when that is used up, the translation pauses and says why, and goes on after midnight.

## 7. Implementation status (2026-11-18)

Built:

| Part | Where |
| --- | --- |
| Reading SRT, WebVTT and ASS into timed lines; signs and karaoke kept | `packages/core/src/subtitles/cues.ts` |
| Presets, checked custom looks, fade and typewriter, pIqaD | `packages/core/src/subtitles/styles.ts` |
| Sources, records, glossary, the glossary and review stages, the chunks sent to the active translator, checkpoints, placement, report | `packages/core/src/subtitles/translate.ts` |
| The translate stage's prompt and reading of the answer (2026-11-19) | `plugins/model-translator/src/translate.ts` |
| Operations and tools: `subtitle_translate_sources`, `subtitle_translate` (with `when_filed`), `subtitle_translation`, `subtitle_translation_cancel`, `subtitle_glossary`, `subtitle_glossary_set`; `subtitle.translate_standing` and `subtitle.styles` (CLI and `reelix` tool only) | `packages/core/src/ops/translate.ts` |
| The background job: one at a time, outside the two agent slots, pause with back-off (also while the translator is off or its budget is used up), sample notice, report to the asking conversation; standing wishes on filing | `packages/server/src/translation.ts` |
| One offer per title and season in the after-filing subtitle job | `packages/server/src/subtitles.ts` |
| Agent guidance | `skills/translation/SKILL.md`; system prompt |
| Web: Translate… action, Stop in Activity, model roles and magpie in Settings, four languages | `packages/web` |

Verified:
- **Tests with a fake model:**
  - line count kept when the model drops a line;
  - glossary reused, and one correction redoes one line;
  - reviewer fixes applied, and ones for lines it was not shown ignored;
  - Klingon not the default, source underneath, borrowed share counted;
  - a pause keeps its place and resumes;
  - cancel;
  - the job pausing while the model is refused, then finishing and reporting in French;
  - styling codes from a model cannot reach the file.
- **Live with the owner's Qwen model** (demo server, 15 English lines of Sintel into Klingon): see the result below.

Not verified yet:
- extracting an embedded text track with ffmpeg on a real video;
- an ASS source with real signs;
- a whole season;
- a real magpie gateway (only a fake one in tests);
- how Jellyfin shows the `AI` label;
- the pIqaD font on a player.
