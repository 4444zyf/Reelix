# Trends, suggestions, and paths on screen

Date: 2026-11-18
Status: asked for by the owner on 2026-11-18; built the same day (see Implementation status).

## 1. The Search page becomes Trends

- The page is called **Trends** (`/trends`; `/search` still opens it, so old links work).
- The search box stays at the top, and works as before: a name, link or ID → the title → its releases.
- With nothing searched, the page shows:
  1. **For you** (§2), when there is something to suggest;
  2. **Trending** from TMDB, as a poster wall: All / Films / Shows, Today / This week. After TMDB's list come the titles the trends sources (`reelix:trends.source@1`, [plugins.md](plugins.md) §7.10) add, found in TMDB, without duplicates: from the `bangumi` plugin, the anime airing now, by how many people on Bangumi watch them (§3).
- A poster opens the title on the same page (title card + releases), exactly as picking a search result did. A title already in the library is marked and opens its library page.
- TMDB's trending list is in the owner's language (the TMDB language Reelix already uses). It is kept for 30 minutes per list.
- The agent can read it too: operation `title.trending` (tool `title_trending`), for "what's popular this week?".

## 2. For you: suggestions from what Reelix knows about the owner

What it knows, all already on the NAS:
- `notes/preferences.md`, the owner's memory (what they like, avoid, prefer);
- the library (titles, kinds, years) and what is followed;
- titles in the library rated by the owner or a metadata source such as Douban (as signal only).

How:
1. **Candidates** are TMDB titles, never from the model's own head: TMDB's recommendations for up to six titles recently watched, added or followed, this week's trending list, then what the trends sources add. Titles already in the library are dropped. At most 40.
2. **One model call** (role `background`) gets the owner's notes, a short library summary and the candidates, and picks up to 8, each with one sentence of why, in the owner's language. It may only answer with candidate IDs; anything else is dropped. Nothing is downloaded or changed: it is read-only.
3. The result is kept in `cache/suggestions.json` for a day, and the page has a Refresh button. The page shows the kept list at once and makes a new one in the background when it is older than a day.
4. The model calls for it are recorded as their own scope, `suggestions`, with a daily limit of their own (`limits.suggestions_daily_usd`, default $0.25, reset at local midnight); once it is used up the kept list stays until the next day. No model available (none set, magpie down): the row says so instead of guessing. No notes and an empty library: the row explains that suggestions grow with what Reelix learns, and asks the owner to tell the agent what they like.
5. Under each suggestion, "Ask about it" sends it to chat, so the owner can say "not my thing" and the agent can write that into the notes, which shapes the next list.

### 2.1 The media server's watch history (asked for 2026-11-18)

What was actually watched says more than what is kept. When the active media server (`reelix:media.server@1`, [plugins.md](plugins.md) §7.7; the `jellyfin` plugin) is set up, suggestions also use:
- films watched, most recent first, with how often and whether they are favourites;
- shows with how many episodes were watched, most recent first;
- favourites not yet watched.

**Whose history.** A NAS Jellyfin is often shared by a household. The media server's setting of whose history counts (for Jellyfin `watch_users`, in Settings → Plugins → jellyfin) says whose history counts. Unset: the only user if there is one, else the administrators, who are usually the owner. The row on the page says whose history was used, so a wrong choice is visible.

**How it is used:**
- The model gets the history before the library, as the strongest signal.
- Favourites and recently watched titles become the seeds for TMDB's recommendations, ahead of followed and recently added titles.
- Anything already watched is never suggested, even when it is no longer in the library.
- New watching makes the list stale: the history is part of what the list was made from. It is read from the media server at most every 15 minutes, and again when its settings change.

**Failure:** no media server, or one that cannot be reached → suggestions are made without it, and the row says so. It never blocks the list.

**Privacy:** the titles watched (names, years, counts) go to the model, as the library already does. No user names, devices or times of day are sent.

## 3. Real paths are not shown in the library

The library pages show where things are **relative to the library**, never the NAS's own folders:
- `Films › Oppenheimer (2023) [tmdbid-872585] › Oppenheimer (2023).mkv`, with the library folder named by its kind (Films, Shows, Anime) and the download folder as "Downloads";
- a file inside the title's own folder is shown from that folder (`Season 01 › S01E01.mkv`);
- a path outside every known folder shows only its last two parts.

Where: the title page (folder and files), the untracked folders on the library wall, and the adopt review (source → destination). The "Ask the agent" texts use the same short form; the agent finds the real paths itself.

This is about display. The agent, the command line and the API still use real paths, since they act on them. The full settings (Settings → library folders) still show the real folders, because that is where the owner sets them.

## 3. Anime airing now, from Bangumi (2026-11-19)

The first provider of `reelix:trends.source@1` (plugins.md §18, A29), kept modest: Bangumi's public API has no "trending" list. What it has is the weekly airing calendar (`/calendar`): the anime on air this season, each with how many people on Bangumi are watching it (`collection.doing`). The `bangumi` plugin answers with that, most watched first, at most 30: "Today" is today's weekday, "This week" all of it. It adds nothing to "Films". Each entry is looked up in TMDB by its Japanese and Chinese names and year (at most 20 per list); one TMDB cannot match is left out rather than guessed. They come after TMDB's own list and are kept with it for 30 minutes.

## Implementation status (2026-11-18)

Built:
- `packages/core/src/trends.ts`: trending lists (kept 30 min), candidates, the prompt, checking the answer, the kept list and when it is stale (a day, other notes or titles, another language; a failed attempt after 10 minutes).
- TMDB `trending` and `recommendations`; operation `title.trending`.
- `packages/server/src/suggestions.ts`: `GET /api/suggestions` (the kept list; starts a new one when stale) and `POST /api/suggestions/refresh`; one list made at a time, with the `background` role, under the `suggestions` scope and its daily limit.
- The Trends page (`/trends`; `/search` still works) and nav entries, in four languages.
- `packages/web/src/lib/paths.ts`: library-relative paths on the title page (folder, files, subtitles), the library wall's untracked folders and the adopt review.

Tested: `packages/core/test/trends.test.ts` (trending marks library titles and is kept; no model call when nothing is known; only offered candidates are kept, once each, never library titles; the notes and library reach the model; stale on new notes, titles or language; no model and a non-JSON answer are reported). Tried in the demo with the real Qwen model, desktop and phone.

Found while trying it: with notes that were only about quality and subtitles, the model gave reasons like "matches your preference for crisp visuals". The prompt now says such notes are not taste, and asks it to name the library title or note each pick connects to, or to say plainly that the link is weak.

Jellyfin watch history (§2.1), built the same day:
- `JellyfinClient.users` and `userItems` (the 10.9+ `/Items?userId=` form, falling back to `/Users/{id}/Items` on older servers); `jellyfin.watch_users` in config and Settings → Services; `watchHistory` in `trends.ts`, kept 15 minutes.
- Tested with a fake Jellyfin (`packages/core/test/fakes/jellyfin.ts`): the administrators are chosen over another user and a disabled one; a single user is used whatever their role; named users win; an unknown name is reported; episodes are counted per show; a favourite seen twice is counted once; watched titles are never candidates, even if the model picks one; the favourite seeds TMDB's recommendations; new watching makes the list stale; an unreachable Jellyfin is reported and the list is still made; the older API form works.
- The demo has a fake Jellyfin with an owner and a guest. With the real model the row read "Using the Jellyfin watch history of owner (2 titles)", and the pick named the favourite it connects to.
- Found while trying it: with few candidates the model returned an empty list, which the prompt allowed. It now asks for at least three picks when there are that many, with an honest reason for a weak match.

Not verified against a real Jellyfin server; the requests follow Jellyfin's documented API.

Moved on 2026-11-19 (plugins.md §21, 6b): the Jellyfin client is the `jellyfin` plugin (`plugins/jellyfin`) behind `reelix:media.server@1`; `trends.ts` reads the history through the seam (`items` with `played` and `favourite`), and the choice of users stays in core (`chooseWatchUsers`, with the provider's `watchUsers`). Its tests are in `packages/core/test/trends.test.ts` and `plugins/jellyfin/test`, with the fake moved to `plugins/jellyfin/test/fake-jellyfin.ts`. The Bangumi trends of §3 are tested there too, with a fake Bangumi (`plugins/bangumi/test/fake-bangumi.ts`); not against the real Bangumi API.
