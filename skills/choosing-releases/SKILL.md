---
name: choosing-releases
description: Weighing releases against the owner's preferences note — quality, size, subtitles, seeders, groups; verifying packs from file lists; spotting RAR-packed or fake releases. Use when choosing which release to download.
---
# Choosing a release

Read `notes/preferences.md` first; it wins over everything here. There are no rule groups: weigh and decide, then state the reason in one sentence ("2160p WEB-DL, 18 GB, 简中 inside; skipped the 60 GB remux as over your size limit").

Default weighing when the note is silent:
- **Health first:** 0 seeders is dead; prefer ≥5 seeders. A freeleech (FREE) on a private tracker is a plus.
- **Quality:** 1080p WEB-DL or BluRay encode as the default; 2160p if the note says so; REMUX only if asked (very large). Avoid CAM/TS/TC/HDCAM/screeners completely.
- **Size sanity:** a 1080p film under ~1.5 GB or a 2160p film under ~6 GB is suspect; a 2-hour film at 80 GB is a remux.
- **Chinese subtitles inside** (内封/中字/简中) save a step; a bilingual (简英) track is best.
- **Codec:** x265/HEVC is fine for modern players; note the owner's device limits if recorded.
- **Groups:** prefer groups the owner has liked before (library notes, past reasons via `reelix activity`).
- **Pack vs episodes:** a verified season pack beats N singles. Verify with `release_files`: count the episodes actually present; note missing ones.
- **Avoid:** RAR-packed releases (cannot be hard-linked), ISO/disc images unless asked, names with `.exe`/`.lnk`/`.zip` video "codecs", password-protected archives — these are often fake or malware.
- **Ties:** in chat, show the shortlist as a release card (`show` with kind=releases) and let the owner click; in a background job, pick the safer (more seeders, smaller) one.
