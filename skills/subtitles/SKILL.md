---
name: subtitles
description: Finding, choosing, cleaning up and placing Chinese subtitles (subhd first, ASSRT fallback) — language and format preference, release matching, packs per season, encoding and script detection, naming next to the video. Use for any subtitle request or when a filed title lacks Chinese subtitles.
---
# Subtitles

1. **What is there already?** `subtitle_search` reports existing external files and embedded Chinese tracks (via media_probe). If the preference is already met, stop.
2. **Search** with `subtitle_search title_id=… [season=…]`. subhd is searched by name and year (it also yields the Douban ID); ASSRT by Chinese then English name.
3. **Choose once per season, not per episode**: a season pack covers everything. Weigh, in order: the owner's language preference (default: 简体&English bilingual, then 简体 alone; ASS over SRT), human over machine translation, made for this release (WEB-DL vs BluRay, matching group — compare with the download's name).
4. **Fetch and place** with `subtitle_fetch candidate=… title_id=…` (or `video=` for one file). It unpacks safely, converts to UTF-8, detects 简/繁/双语 by content, matches files in a pack to episodes, checks timing against the video length, and writes next to each video using Jellyfin's naming. Read its report: timing warnings mean the subtitle may be for another cut.
5. **Verification:** if a site asks for a check, follow the `verification` skill. Until then: tell the owner, offer the drop-in route (they drag a file into chat), or try the other source.
6. **Nothing suitable:** say so; for a recent release offer to look again in a few days (a follow or a one-off job).

Never edit the video. Subtitle files are ordinary new files in the library (not links).
