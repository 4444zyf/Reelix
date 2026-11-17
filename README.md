# Reelix

A self-hosted, agent-native copilot for one person's movie, TV and anime collection on a NAS. You talk to it; it identifies a title, picks a release, downloads it with qBittorrent, files it into a Jellyfin-ready library by hard link, and fetches Chinese subtitles. Built around the [pi](https://github.com/earendil-works/pi) agent.

Design: [`docs/2026-11-17-reelix-design.md`](docs/2026-11-17-reelix-design.md). Web API: [`docs/api.md`](docs/api.md).

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Operation registry + ledger, clients (qBittorrent, Jackett, TMDB, Bangumi, Jellyfin, Telegram, subhd, ASSRT), organiser (plan/apply hard links), titles, downloads, library removal/trash, subtitles, anime mapping, follows, adoption, doctor. No pi, no HTTP. |
| `packages/cli` | The `reelix` command, generated from the registry (`bin/reelix`). |
| `packages/server` | HTTP API + web UI, private local socket, pi host (sessions, tools, hooks), job runner, completion watcher, Telegram bot, browser (Chromium + live view), nightly tidy-up. |
| `packages/web` | The web UI (Astro + React SPA, MovieCopilot-Frontend look). |
| `skills/` | Built-in pi skills. |
| `preflight/` | `reelix-preflight.sh`: run once on the NAS over SSH before installing. |

## Run

Requirements: Node ≥ 22.18 (TypeScript runs directly; no build for the backend).

```sh
npm install
npm run web:build                      # static UI into packages/web/dist
export REELIX_DATA=$PWD/.dev-data      # /data in the container
export REELIX_PI_DIR=~/.pi/agent       # pi's sign-in and models (default: $REELIX_DATA/pi)
bin/reelix config set models.main provider/model-id
bin/reelix serve                       # web UI on :7878; first visit sets the password
bin/reelix chat                        # or: the agent in the terminal
bin/reelix help                        # every operation
```

On the NAS: run `preflight/reelix-preflight.sh` first, then build the image (`Dockerfile`, `docker-compose.example.yml`) with one `/media` mount and qBittorrent's user and group.

## Test

```sh
npm test            # core + server: hard links, ledger, parser, the media loop against fake qBittorrent/Jackett/TMDB, subtitles, jobs, auth
npm run typecheck
REELIX_PI_DIR=~/.pi/agent REELIX_TEST_MODEL=provider/model node --no-warnings packages/server/test/agent.e2e.ts   # agent behaviour, spends tokens
```

MIT licence. No code, tests or fixtures from MoviePilot (GPL-3.0).
