---
name: setup-and-doctor
description: First-run setup and diagnosis — discovering folders under /media, connecting qBittorrent/Jackett/Jellyfin, path mappings, the real hard-link test, proxies, the preferences note, Telegram linking, changing qBittorrent and Jackett settings. Use on first run, when the owner asks to set something up, or when things look broken.
---
# Setup and doctor

`reelix doctor` checks everything; run it first when anything looks wrong and read every FAIL.

**First-run setup** (one step at a time, confirm as you go):
1. Look under /media (`ls`, `find /media -maxdepth 3 -type d`) and compare with the pre-flight report if the owner has one. Identify the download folder and propose `library/{Movies,Shows,Anime}` under the same mount. `reelix config set downloads …`, `reelix config set library '{"movies":…,"shows":…,"anime":…}'`.
2. Ask for qBittorrent, Jackett, (optional) Jellyfin addresses: `reelix config set qbittorrent '{"url":"http://…","username":"admin"}'`. Take passwords and API keys ONLY through the ask tool's secret field (kind=secret, key=qbittorrent.password / jackett.api_key / jellyfin.api_key / tmdb.api_key). Test each with `reelix doctor --quick`.
3. Path mapping: `reelix qb prefs` shows qBittorrent's save path (its view). Find the same folder under /media (match folder names and torrent names from `reelix qb torrents`), then `reelix config set path_maps.qbittorrent '[{"theirs":"/downloads","ours":"/media/torrents"}]'`. Same for Jellyfin's view of the library.
4. Hard-link test from inside: `reelix doctor` does it with a real file qBittorrent wrote. EXDEV = different mounts/shared folders (fix the layout, not Reelix); EPERM = Reelix is not running as qBittorrent's user.
5. Indexers: `reelix jackett indexers --test`.
6. Proxy if TMDB or the model provider is unreachable: `reelix config set proxy '{"default":"http://host:7890","use_for":["tmdb","subhd","telegram","models","browser"]}'`.
7. Ask a few questions (resolution, size limits, HDR, subtitles, audio language, anime groups) and write `/data/notes/preferences.md` in plain language.
8. Telegram: the owner creates a bot with @BotFather and gives the token through the secret field (telegram.bot_token); then `reelix telegram link` shows a one-time code the owner sends to the bot.
9. Summarise the settings (`reelix config show`) for the owner to correct.

**Changing other services:** `reelix qb prefs` / `reelix qb set_prefs --prefs '{…}'`; Jackett indexers can be listed and tested by API, but adding or repairing one is done in Jackett's web page with the browser tools.

Record quirks you discover (slow indexer, odd paths) in `/data/notes/library.md`.
