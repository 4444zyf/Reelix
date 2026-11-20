---
name: anime
description: Lining up Bangumi seasons and absolute episode numbers with TMDB seasons for anime, and storing the mapping. Use when anime files use absolute numbering, Bangumi and TMDB disagree on seasons, or filing anime needs a season decision.
---
# Anime numbering

Bangumi has one entry per season or cour; TMDB often has one long season, or splits differently. Release groups often number episodes absolutely (episode 29 = season 2 episode 1).

1. `reelix anime map title_id=…` lines up the title's Bangumi entries with TMDB seasons by air date and episode count, and stores: *Bangumi entry X episodes N–M are TMDB season S starting at episode E*. Read its output; it marks places where dates or counts disagree. Bangumi's entries and episodes come from the `bangumi` plugin; when it is off, the output says so.
2. Settle what does not fit yourself, once: look at TMDB's episode groups (alternative orderings) and air dates, then store a per-title note (`title.note`) such as "episode 13 is S2E1" and file with explicit plan items.
3. To file absolute-numbered files: compute season and episode from the mapping, then `organise mode=apply items=[…]` with explicit `episodes`.
4. Specials (SP, OVA, OAD, 総集編) go to Season 00 with TMDB's special numbering when it has one; otherwise `extras/`.
5. Movies of an anime series are separate TMDB movies → Movies (or Anime if the owner prefers; check the preferences note).
