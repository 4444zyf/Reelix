# Reelix HTTP API (for the web UI)

Served by `packages/server/src/http.ts`. All `/api/*` routes except session/login/setup-password need the session cookie (HttpOnly, SameSite=Strict; the browser sends it automatically — use `credentials: "same-origin"`). Requests carrying an `Origin` header from another site are refused. JSON in and out unless noted. Errors: `{ error, code? }` with a 4xx/5xx status.

## Session
- `GET /api/session` → `{ authenticated, needsPassword }` (needsPassword = first run: show "set a password").
- `POST /api/setup-password { password }` (first run only, ≥ 8 chars) → sets the cookie.
- `POST /api/login { password }` → sets the cookie; 401 wrong, 429 rate-limited.
- `POST /api/logout`; `POST /api/password { current, password }`.

## Operations (one registry, three faces)
- `GET /api/ops` → `[{ name, summary, description, effect: "read"|"write"|"destructive", input: JSONSchema, tool?, positional? }]`.
- `POST /api/op/:name` body = the operation's input; header `x-request-id` (generate one per click; resending the same id returns the first result) → `{ output, text, actionId?, repeated? }`.

Useful operations and their `output` shapes:
- `title.find { query?, id?, kind?, year? }` → `{ resolved?: Title, how?, candidates: [{ id, kind, tmdb_id, name, original_name, year, overview, poster_path }], note? }`.
- `title.show { id }` → `{ title: Title, have: { folder, episodes, files }, files: [{ id, dest, kind, exists, episodes }], downloads: [...], follows: [...] }`.
- `title.note { id, note }`, `title.set { id, media_class?, folder_name?, douban_id?, bangumi_id? }`.
- `release.search { title_id?, query?, season?, episode?, sort?, limit?, offset? }` → `{ title, queries, total, offset, releases: Release[], all: Release[], indexers: [{ indexer, name, ok, count, ms, error? }] }`; `Release = { handle, title, size, seeders, peers, indexer, publishDate, freeleech, parsed: { resolution, source, codec, hdr[], chineseSubs, group, season, episodes[] }, hasMagnet }`.
- `release.files { handle }` → `{ name, files: [{ path, size }], magnetOnly }`.
- `download.add { handle, title_id, episodes?, reason? }` → `{ hash, name, adopted, started, files, size, warnings[] }`.
- `download.status { hash?, all? }` → `[{ hash, title_id, title_name, name, state, progress, size, reason, note, added_at, filed_at, live?: { state, progress, dlspeed, upspeed, eta, num_seeds, ratio } }]`. States: downloading, complete, filed, needs_agent, stalled, gone, removed.
- `download.pause|resume { hash }`, `download.remove { hash, delete_data }` (destructive), `download.file { hash }`.
- `library.list {}` → `{ titles: (Title & { file_count })[], untracked_folders: string[] }`.
- `library.remove { title_id, level: "entry"|"torrent"|"data", season?, episodes? }` (destructive), `library.removed {}`, `library.restore { ids }`.
- `organise { mode: "plan"|"apply", hash?, title_id?, path?, items? }` → `{ plan: { items: [{ source, dest, kind, reason, episodes }] }, problems?, results? }`.
- `activity { limit?, title_id?, status? }` → ledger rows `{ id, op, actor, status, error, title_id, started_at, finished_at, input_json }`.
- `config.show {}` → `{ summary, config, warning? }`; `config.set { path, value }`.
- `secret.list {}` → `[{ key, what, set }]`; `secret.set { key, value }` (only from a password field).
- `doctor { quick? }` → `[{ name, ok: true|false|null, detail, fix? }]`.
- `jackett.indexers { test? }`, `qb.prefs {}`, `inbox.*`, `job.list {}`, `job.run { task }`, `telegram.link {}`, `telegram.test {}`.
- Subtitles (step 4): `subtitle.search`, `subtitle.fetch`, `subtitle.list`. Follows (step 7): `follow.add|list|remove`. Browser (step 5): see `/api/browser/*`.

`Title = { id ("movie:123"|"tv:456"|"local:x"), kind, tmdb_id, media_class ("movie"|"show"|"anime"), name (zh-CN), original_name, folder_name, year, names[], imdb_id, douban_id, bangumi_ids[], runtime_min, seasons: [{ season_number, episode_count, air_date }], poster_path, rating, douban_rating, overview, notes, library_folder }`.

## Status and live events
- `GET /api/status` → `{ spend: { usd, tokens, capUsd, capTokens, reached }, inbox (open count), models[], model: { main, background }, configWarning?, telegram: { configured, linked, running, bot, error }, jobs: { queued, running, parked } }`.
- `GET /api/events` (SSE, event name `app`): `{ type: "download", hash, state, progress? }`, `{ type: "inbox", id, status }`, `{ type: "action", action }`, `{ type: "job", id, state, kind }`, `{ type: "config" }`, `{ type: "notice", level, text }`, `{ type: "thread", threadId, event: "run_start"|"run_end"|"ask" }`. Use these to invalidate TanStack Query caches.

## Chat threads
- `GET /api/threads` → `[{ id, name, kind ("chat"|"telegram"|"job"|"setup"), title_id, job_run_id, updated_at, running, pending_question }]`.
- `POST /api/threads { name? }` → thread. `PATCH /api/threads/:id { name?, archived? }`.
- `GET /api/threads/:id` → `{ thread, messages: UiMessage[], seq, running, pending?: Ask }`. Messages are rebuilt from the saved conversation:
  `UiMessage = { role: "user", text, images? } | { role: "assistant", text (markdown), tools: [{ id, name, label (human line), isError, summary, card? }], error? }`.
- `POST /api/threads/:id/messages { text, images?: [{ data (base64), mimeType }] }` → `{ runId? | queued? | answered? }`. While a run is active the message is delivered after the current tool call.
- `POST /api/threads/:id/answer { questionId, value }` (button or secret field). `POST /api/threads/:id/abort`.
- `GET /api/threads/:id/events?after=<seq>` (SSE, event name `ui`, `id` = seq). Reconnect with the last seq seen; a returning page catches up. Events:
  - `run_start { runId }`, `run_end { runId, state: "done"|"failed"|"interrupted", parkedOn? }`
  - `user_message { text, from?, queued? }`
  - `assistant_start`, `text_delta { delta }`, `thinking`, `assistant_end { stopReason, error? }`
  - `tool_start { id, name, label }`, `tool_end { id, name, isError, summary, card? }`
  - `card { card }` (from the `show` tool)
  - `ask { id, question, kind: "choice"|"confirm"|"text"|"secret", options?, secret_key? }`, `ask_answered { id, text? }`
  - `notice { text }`, `error { message }`
  After `run_end`, refetch `GET /api/threads/:id` to rebuild from the saved conversation.

Cards (`card.kind`): `title { title }`, `candidates { candidates }`, `releases { releases, pick?, reason?, total?, indexers? }` (each row: Download button → `download.add { handle, title_id }` then a short note in the thread), `plan { items, results?, problems?, mode }` (Approve → `organise { mode: "apply", items }`), `progress { hash, name }` (live from download events), `downloads { downloads }`, `image { image (URL), text }`, `verification { image, text }` (code field → send as a message; "open live view" → Browser screen), `subtitles { … }`, `text { text }`.

## Inbox
- `GET /api/inbox?status=open|answered|dismissed|all` → `[{ id, kind ("notice"|"question"|"plan"|"verification"|"summary"), title, body, options[], image_path, payload, source, job_run_id, status, answer, created_at }]`.
- `POST /api/inbox/:id/answer { answer }`, `POST /api/inbox/:id/dismiss`, `POST /api/inbox/:id/continue` → the job's thread (open it in Chat).
- Image of an item: `GET /api/files?path=<image_path>`.

## Files
- `GET /api/poster?path=/abc.jpg&size=w342` — TMDB posters proxied and cached by the server.
- `GET /api/files?path=…` — images from Reelix's workspace (screenshots, frames, QR codes).
- `POST /api/upload` (multipart `file`) → `{ path, name, size, type }`; then tell the agent about it in a message ("I dropped a subtitle file at <path>").

## Jobs, Telegram
- `GET /api/jobs` → `{ jobs, runs: [{ id, kind, state, summary, created_at, thread_id }] }`; `POST /api/jobs/:id/run`.
- `POST /api/telegram/link` → `{ code }`.
