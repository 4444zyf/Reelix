---
name: fixing-mistakes
description: Correcting a wrong identity ("that's the 1994 film") versus a wrong download, re-filing, and removing titles at the right level. Use when the owner says something is wrong in the library or asks to remove or replace something.
---
# Fixing mistakes

First work out which of two things is wrong.

**Right file, wrong identity** ("that's the 1994 film, not the 2019 one"):
1. `title_find` the right title. 2. Plan new destinations for the same sources: `organise mode=apply title_id=<right> items=[…]` (sources from `reelix title show <wrong>`). 3. Remove the old entry with `reelix library remove <wrong> entry` (links only; the data stays). 4. Move subtitle files along (they are ordinary files: `mv` in the library is fine). 5. `title.note` on the right title recording the correction. Nothing is downloaded again.

**Wrong download** (bad quality, wrong cut, broken file): `reelix library remove <title> <level>` then acquire the right one.

**Removal levels** (`library remove`):
- `entry` — library links only. Restorable (`reelix library removed`, `reelix library restore`) while the download exists.
- `torrent` — also remove the torrent from qBittorrent; the data stays on disk.
- `data` — also delete the downloaded data. Gone immediately.
A last remaining copy (data already gone) goes to a 14-day trash instead of vanishing.

When the owner asks to delete, do it and report exactly what was removed. When deletion is your own idea, propose and wait.
