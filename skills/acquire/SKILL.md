---
name: acquire
description: The "get me X" workflow — identify a title, check library and downloads, check space, search releases, choose, add, confirm it started. Use whenever the owner asks to get, download, find or watch something.
---
# Acquire a title

1. **Identify.** `title_find` with whatever the owner gave (name, link, magnet, release name; for a poster image read the title yourself first). IDs settle it. With candidates, weigh years, type, overview against what the owner said; ask only if two remain plausible. If TMDB lacks it, `reelix title local`.
2. **Already have it?** `reelix title show <id>` lists library files, downloads and follows. For TV, decide which seasons/episodes are actually wanted. Don't re-download what is filed unless the owner asks for a better version.
3. **Search.** `release_search title_id=… [season=…] [episode=…]`. Read the per-indexer line: if every indexer errored or returned nothing, run `reelix jackett indexers --test` before concluding it is unavailable. Try `query=` with the original or Chinese name if the default queries miss.
4. **Choose.** Load `choosing-releases`. Read the preferences note. For packs and anything doubtful, `release_files handle=…` first: confirm the episodes are really inside, and avoid RAR-packed releases and disc images unless the owner wants them.
5. **Space.** `download_add` checks free space itself; a warning means mention it.
6. **Add.** `download_add handle=… title_id=… episodes=[…] reason="one sentence"`. For a pack where only some episodes are wanted, pass `only_files`/`skip_files` (indexes from release_files) and the wanted `episodes`.
7. **Confirm it started** with `download_status hash=…` after a few seconds (state downloading, some peers). Say what you chose and why in one or two sentences. Filing happens automatically on completion; you'll be woken only if filing needs judgement.
8. **Airing shows.** If the season is still airing (TMDB next episode date), offer to follow it (`reelix follow add`).
