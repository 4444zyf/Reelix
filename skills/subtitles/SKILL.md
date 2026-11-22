---
name: subtitles
description: Finding, choosing, cleaning up and placing subtitles in the owner's languages from several sources (subhd, ASSRT, OpenSubtitles, SubDL, Gestdown/Addic7ed, Jimaku). Covers language order, release matching, season packs versus single episodes, encoding and language detection, and naming next to the video. Use for any subtitle request, or when a filed title lacks subtitles in the owner's language.
---
# Subtitles

**Wanted languages.** The owner wants subtitles in an ordered list of languages: config `subtitles.languages`, or, when that is unset, the owner's language (zh → Chinese; en → English; fr → French, then English; ru → Russian, then English). `subtitle_search` prints the list on its first line. Within Chinese, the default order is 简英双语 > 简体 > 繁體 unless the preferences note says otherwise.

**Sources** (config `subtitles.sources`, in order; each is asked only for the languages and kinds of title it covers):

| Source | Covers | Notes |
| --- | --- | --- |
| subhd | Chinese | Searched by the Chinese title; gives the Douban ID; may need verification (the `verification` skill). |
| ASSRT | Chinese, English | Needs `plugins.subtitle-sites.assrt_token`. |
| OpenSubtitles | every language, movies and TV | Needs `plugins.subtitle-sites.opensubtitles_api_key`. An account (`plugins.subtitle-sites.opensubtitles_username` + `plugins.subtitle-sites.opensubtitles_password`) raises the small daily download quota. **HASH MATCH** means made for exactly this file. |
| SubDL | many languages, movies and TV | Needs `plugins.subtitle-sites.subdl_api_key`. Often has season packs. |
| Gestdown | TV only (Addic7ed): English, French, Russian, Chinese… | No key. One result per episode and language, with the release version. |
| Jimaku | Japanese, anime | Needs `plugins.subtitle-sites.jimaku_api_key`. Only when Japanese is wanted. |

**Missing keys.** A source without its key is listed under "Not asked". If that leaves nothing good, tell the owner which key would help and where to add it (Settings → Services → Subtitle sites, under that site; free account at the source).

## Steps

1. **What is there already?** `subtitle_search` reports external files and embedded tracks in a wanted language (via media_probe). If the first wanted language is already met, stop.
2. **Search** with `subtitle_search title_id=… [season=…]`. Pass `languages=[…]` only when the owner asks for something else (for example "get Japanese subs for this anime"). `query=` searches with another name.
3. **Choose once per season where a pack exists, else per episode.** Weigh, in order:
   - the wanted language order;
   - HASH MATCH, or made for this release (WEB-DL vs BluRay, same group: compare with the download's name);
   - human over machine translation (`machine-translated`);
   - not hearing-impaired unless the owner wants it;
   - downloads and recency.
4. **Fetch and place** with `subtitle_fetch ref=… title_id=… season=…` for a pack, or `ref=… video=…` for one episode. It unpacks safely and converts to UTF-8. It detects the language from the content (简/繁/双语, English, French, Russian, Japanese) and matches files in a pack to episodes. It checks timing against the video length, and writes next to each video using Jellyfin's naming (`.fr.default.srt`, `.zh.简英双语.default.ass`). Read its report: timing warnings mean another cut.
5. **Verification or limits.**
   - A site's human check: follow the `verification` skill, then fetch again with `verification=<the token>` where the page gave one.
   - Daily limits (OpenSubtitles, Gestdown): say when they reset, or try the next source.
   - An empty file from a source: choose another candidate.
6. **Nothing suitable:** say so. If a text subtitle in another language exists or can be fetched, a translation is possible: see the `translation` skill (offer it; never start one unasked). For a recent release, offer to look again in a few days (a follow or a one-off job), or the drop-in route: the owner drags a file into chat and you place it with `subtitle_place`.

Never edit the video. Subtitle files are ordinary new files in the library (not links).
