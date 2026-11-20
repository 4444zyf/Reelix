---
name: organise
description: Filing downloads into the library by hard link, in Jellyfin's naming — layout, naming, extras, disc folders, multi-part and multi-episode files, sidecar subtitles and audio, odd structures. Use when a download needs filing that code could not plan, or the owner asks to re-file something.
---
# Organising into the library

**Layout** (one root each for Movies, Shows, Anime; see config `library`):
```
Movies/Name (Year) [tmdbid-N]/Name (Year) [tmdbid-N] - 2160p.mkv
Shows/Name (Year) [tmdbid-N]/Season 01/Name (Year) S01E01.mkv
Shows/…/Season 01/Name (Year) S01E01-E02.mkv     two episodes in one file
…/Season 00/…   specials        …/extras/…   extras (not a film or episode)
```
- Folder names use the English or original title (`folder_name` on the title; change with `reelix title set --folder-name`).
- A second version of a film: `Name (Year) [tmdbid-N] - <label>.ext` — must start with the exact folder name.
- Disc folders (BDMV, VIDEO_TS) are linked whole into the title folder; they cannot have versions or external subtitles.
- Characters `<>:"/\|?*` are removed from names.

**How to file something code could not:**
1. `organise mode=plan hash=…` — read the plan and the problems.
2. Inspect with the shell: `ls -la`, `find <path> -type f -printf '%s %p\n'`, and `media_probe` on doubtful files (running time vs TMDB; a 2-minute "episode" is a sample; a 3-hour file in a TV pack is a compilation).
3. Write your own plan items and apply: `organise mode=apply items=[{source, dest, kind, episodes, reason}]`. Apply only hard-links inside the library, never replaces, and is safe to repeat. Use exact absolute paths.
4. Things that cannot be linked: RAR parts (ask before unpacking; the unpacked copy costs the space again), files on another mount (the doctor explains). Never copy instead of linking without the owner's say-so.
5. Subtitles and separate audio shipped next to a video follow it under the video's new name; samples, NFO, screenshots, `@eaDir`, `#recycle` are skipped.
6. Afterwards the media server (Jellyfin) is told automatically; check `reelix title show` for the result.

Never rename, move or edit anything inside the download folder: it breaks seeding.
