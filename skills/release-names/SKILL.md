---
name: release-names
description: How to read torrent release names — scene dots, Chinese season/episode forms, anime bracket style, absolute numbering, numeric titles, packs, quality and subtitle hints. Use when a release or file name is ambiguous or the parser marked it unsure.
---
# Reading release names

The built-in parser handles the routine (`Title.Year.Res.Source.Codec-GROUP`, `S01E02`, `S01E01-E03`). You read the rest.

- **Scene style:** `Title.Year.Resolution.Source.Audio.Codec-GROUP`. Source words: WEB-DL (lossless web capture) > WEBRip; BluRay encode; REMUX (untouched disc video, huge); HDTV. `DV`/`HDR10+`/`HDR` are HDR formats.
- **Numeric titles:** *1917*, *2012*, *1922*: if the name starts with a year-like number followed by another year, the first is the title.
- **Chinese forms:** 第二季 = season 2; 第01集 / 第1-12集 = episodes; 全12集 / 全集 = complete; 合集 = collection; 国语 = Mandarin audio; 中字/内封/内嵌 = Chinese subs inside (内嵌 = burned in, 内封 = soft track); 简繁 = both scripts; 简英/中英双语 = bilingual; 官中 = official subs.
- **Anime bracket style:** `[Group] Title - 05 [1080p][HEVC]` or `[Group][Title][05][1080p][CHS]`. Episode numbers are usually **absolute** across seasons; map them with the anime skill before filing. `v2` = corrected re-release. `[01-12]` / `01~12` / `Fin` = batch. CHS/GB = simplified, CHT/BIG5 = traditional, JPSC/JPTC = Japanese + Chinese.
- **Packs:** `S01` without episode = season pack; `S01-S05` / `Complete` = multi-season; verify with release_files — names lie.
- **Extras:** sample, trailer, featurette, NCOP/NCED (creditless openings), SP/OVA/OAD (specials → Season 00), PV/CM.
- When unsure, look inside: `release_files`, then after download `media_probe` the file (running time, tracks) — the content beats the name.
