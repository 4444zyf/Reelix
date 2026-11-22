# Deployment: Docker Compose

Date: 2026-11-18
Status: agreed with the owner on 2026-11-18. **Built.** The image was first built and run under Docker on 2026-11-20 (Users and files, D2); Compose and the other services have not been run yet (see Implementation status).

Related: design §3 (one container, one process), §10.1 (pre-flight), [magpie.md](magpie.md).

## Decisions

- **Docker Compose is the way to install.** One compose file: Reelix always, everything else optional.
- **Every service is its own container.** Reelix, magpie, qBittorrent, Jackett and Jellyfin each run from their own image, with their own user, volume and updates. They are switched on with compose profiles.
- **pi is part of Reelix's container.** It is already there as a library; the `pi` command is put on PATH and shares Reelix's pi folder.
- **No all-in-one image for now.** If it is ever built, magpie must run there as a separate user whose files the agent cannot read (see Why magpie is separate).
- **No image is published.** The NAS builds Reelix from the repository. The other services use their makers' images.

## Services

| Service | Profile | Image | Data |
| --- | --- | --- | --- |
| `reelix` | (always) | built from this repository | `/data` (Reelix's own), `/media` |
| `magpie` | `magpie` | `ghcr.io/yetone/magpie`, pinned to a tested version | its own `/config` volume, **never mounted into Reelix** |
| `qbittorrent` | `qbittorrent` | `lscr.io/linuxserver/qbittorrent` | `/config`, `/media` |
| `jackett` | `jackett` | `lscr.io/linuxserver/jackett` | `/config` |
| `jellyfin` | `jellyfin` | `lscr.io/linuxserver/jellyfin` | `/config`, `/media` (read only) |

Start with, for example, `docker compose --profile magpie --profile jackett up -d`, or list the profiles once in `.env` as `COMPOSE_PROFILES=magpie,jackett`. Most NAS owners already run qBittorrent and Jellyfin; for them the pre-flight check leaves those profiles off and connects Reelix to the existing containers.

All settings the owner chooses live in `.env` (from `.env.example`): the media folder, the user and group IDs, ports, the magpie web key, the time zone.

## Reaching each other (accessibility between containers)

### Addresses

- **One private network**, `reelix`, with a fixed subnet (`REELIX_SUBNET`, default `172.31.78.0/24`). Inside it, services reach each other by name: `http://qbittorrent:8080`, `http://jackett:9117`, `http://jellyfin:8096`, `http://magpie:3425`.
- **`localhost` means the container itself.** Inside a container, `127.0.0.1` is never the NAS or another service. Reelix's doctor warns about any service address that points at localhost while Reelix runs in a container, and says what to use instead.
- **Services that already exist** (another compose project, a NAS app, a VPN container like gluetun) are reached by one of:
  1. joining their network: list it in `REELIX_EXTRA_NETWORK`, then use their container name (a qBittorrent behind gluetun is `http://gluetun:8080`);
  2. the NAS's LAN address, for a container that publishes its port;
  3. `host.docker.internal`, for something listening on the NAS itself (a container with `network_mode: host`, a proxy). Reelix's container maps it to the host with `extra_hosts: host-gateway`.
  The pre-flight check finds which applies and writes it into `.env`.
- **Proxy** (decision H): a proxy on the NAS is `http://host.docker.internal:7890`, not `127.0.0.1:7890`, and must accept connections from other machines (Clash's "allow LAN").
- **First start fills in the addresses.** The compose file passes `REELIX_DEFAULT_QBITTORRENT_URL` (it becomes `plugins.qbittorrent.url`, the setting of the `qbittorrent` plugin), `…_JACKETT_URL` (it becomes `plugins.jackett.servers[0].url`), `…_JELLYFIN_URL` (it becomes `plugins.jellyfin.url`, the setting of the `jellyfin` plugin), `…_MAGPIE_URL` for the services that are switched on. The image's `REELIX_CHROMIUM=/usr/bin/chromium` becomes `plugins.browser.chromium`, the setting of the `browser` plugin, the same way. Reelix copies each into its settings only while that setting is empty, so a later change in Settings wins.

### Files and users

- **The same host folder at the same path in every container:** the media folder is mounted as `/media` in Reelix, qBittorrent and Jellyfin. The paths qBittorrent reports and those Reelix sends to Jellyfin are then the same everywhere, and `path_maps` stay empty. Existing containers that mount it elsewhere keep working through `path_maps` (the downloader's under `path_maps.downloaders.<its id>`, for example `path_maps.downloaders.qbittorrent`, and the media server's under `path_maps.media_servers.<its id>`, for example `path_maps.media_servers.jellyfin`), which the pre-flight check fills in.
- **One mount for downloads and library**, as before: hard links do not cross mounts.
- **One user for files:** Reelix and qBittorrent run with the same `PUID:PGID` (all of them through `PUID`/`PGID`; Reelix's image switches to them itself, see Users and files). Jellyfin uses the same group, so it can read what is filed.
- **Magpie runs as its own user** (uid 65532) in its own volume.

### Magpie across containers

From Reelix's container, magpie sees a request from another machine, which changes four things:
- **Every call needs an enabled gateway key.** Reelix already sends `magpie.api_key`; "anything works" only applies inside magpie's own container.
- **The admin key must be allowed from other machines:** `magpie gateway-key admin <id> any`, not `local`. When magpie refuses with "from this computer only", Reelix's message says exactly this.
- **Only Reelix's network and the home network may reach it.** The compose file sets `MAGPIE_ALLOW_IPS` to the `reelix` subnet plus `MAGPIE_ALLOW_IPS_EXTRA`, which the pre-flight fills with the NAS's LAN range. Magpie's allow list also guards its web page, and a published port keeps the browser's own address, so without the LAN range your browser would be refused at 3430. Since 3425 is not published, LAN machines can still only reach the key-protected page, so an `any` admin key is usable only from Reelix's network.
- **The gateway port 3425 is not published.** Other machines (a laptop's coding agent) can be let in by publishing it in `.env` and adding their addresses to `MAGPIE_ALLOW_IPS_EXTRA`.

Magpie's web page (3430), where the owner adds providers and makes Reelix's two keys, is published on the LAN and protected by `MAGPIE_WEB_KEY`. Left empty, magpie makes a new key at each start and prints it (`docker compose logs magpie`). The variable cannot be required, because Compose reads every service's variables even when its profile is off; only `MEDIA_ROOT` is required. Set `MAGPIE_WEB_BIND=127.0.0.1` to keep it to the NAS (then reach it with an SSH tunnel).

### What the owner opens

| Page | Address |
| --- | --- |
| Reelix | `http://<nas>:7878` |
| magpie | `http://<nas>:3430/?k=<MAGPIE_WEB_KEY>` |
| qBittorrent, Jackett, Jellyfin | their usual ports on the NAS |

Reelix shows the owner no links into the other services today. If it ever does, it needs each service's LAN address as a separate setting, because the service names above only work inside the network.

### Start order

There is no `depends_on`: a service in a profile that is switched off cannot be depended on, and Reelix already copes with a missing service. Reelix asks for magpie's models again every 5 minutes while the gateway is not answering, so a magpie that starts after Reelix is found without a restart.

## Why magpie is separate

Reelix's agent has a shell in Reelix's container. A magpie in the same container, as the same user, would let the agent read every provider key in magpie's files and run `magpie gateway-key limit … off` on its own key, past every check in [magpie.md](magpie.md). In its own container it is reachable only over the network, with the keys Reelix holds.

## The Reelix image

- Node 22, Chromium, ffmpeg, 7-Zip, tini (as before).
- `pi` on PATH. `PI_CODING_AGENT_DIR=/data/pi`, the folder Reelix's agent already uses, so a provider signed in to in Settings → Models (or with `docker compose exec reelix pi`) is the one Reelix uses, and Reelix sees the result at once.
- `HOME=/data/home`, because Reelix runs as a numeric user with no home of its own. The agent's shell has its own, `/data/workspace/.home`.
- Three users and an entrypoint that starts as root (Users and files).
- A health check on `/api/session`.
- git and npm, for installing plugins ([plugins.md](plugins.md) §13.1). Installed plugins live in `/data/plugins`, inside the data volume, so they survive an image update; at every start Reelix checks each against the new version and leaves an incompatible one unloaded, with an Inbox notice.
- Nothing more for plugins that run in a process of their own ([plugins.md](plugins.md) §11.7): Reelix starts them as the user `reelix-plugin` (Users and files) with the image's own Node (22, which has the permission model and the module hooks they rely on; Reelix needs 22.18 or later anyway), with read access to `/app/node_modules`, `/app/packages/plugin` and the plugin's folder, and write access only to its folder under `/data/plugin-data`.
- `REELIX_RESTART=exit` in the compose files: `restart: unless-stopped` starts Reelix again when it exits, so Settings → Plugins offers a Restart button after a plugin is installed or updated. Without it, Settings says how to restart.

## Users and files (D2)

Decision D2 ([plugins.md](plugins.md) §11.3): the agent's shell and plugins that run in a process of their own are other system users than Reelix, so a steered agent or a hostile plugin cannot read Reelix's secrets, database or token, change installed plugins, or call the owner's socket.

| User | Who | Groups |
| --- | --- | --- |
| `PUID:PGID` (qBittorrent's) | Reelix itself: the web UI, operations, pi's sessions, plugins inside Reelix | `reelix` (61870), `reelix-agent`, `reelix-plugin` |
| `reelix-agent` (61871) | every command of the agent's shell, and the scripts and `reelix` commands it runs | `PGID`, for the media folder |
| `reelix-plugin` (61872) | plugins with `runtime: "process"` (`jackett` by default) | none |

**How it starts.** The container starts as root; there is no `user:` in the compose file any more, and `PUID`/`PGID` are passed as variables like for the linuxserver images. The entrypoint (`docker/entrypoint.sh`):

1. refuses to start as another user than root, with `PUID` or `PGID` 0, or with one of the image's own ids (61870 to 61872);
2. gives every file in `/data` that none of the three users owns to `PUID`, and every file in no group of theirs to the group `reelix`, and marks every folder so new files keep its group. This is the one-time step for a data folder from before D2 (all `PUID:PGID`), and it repeats only for what something else left there, such as a `docker exec` as root or a changed `PUID`;
3. starts Reelix as `PUID:PGID` with umask 002, those three groups, and only the capabilities `setuid`, `setgid` and `kill` (to start the agent's shell and plugins' processes as their users and to stop them), with `no_new_privs`.

Reelix then sets the data folder's modes at every start, before anything runs as another user (the table in [plugins.md](plugins.md) §11.3): the agent's shell may work in `workspace/`, `notes/`, `skills/` and `themes/`, may read `plugins/`, and reaches Reelix through `/data/agent.sock` with its session's token. Everything else in `/data` is Reelix's user's only.

**Volumes.**

- `/data` belongs to `PUID` and group `reelix` after the first start. Back it up as root, or as `PUID`, which may read everything in it. Files the agent's shell wrote in its folders belong to `reelix-agent`, with group `reelix-agent` and group write, so Reelix can change them.
- `/media` keeps its owner and group. The agent's shell is in `PGID`, so it reads the media folder as before and writes where the group may write. Reelix now writes with umask 002, so the folders and subtitles it files are group-writable; the agent's own files there belong to `reelix-agent` and are readable by everyone, as before. Folders that qBittorrent created with umask 022 stay closed to the agent's writes, which suits the rule that downloads are never changed. With linuxserver's qBittorrent, `UMASK=002` makes its folders group-writable too, if the agent should rename there.

**Commands in the container.** `docker exec` runs as root unless told otherwise. Run Reelix's commands as Reelix's user:

```sh
docker compose exec -u "$PUID:$PGID" reelix reelix doctor
docker compose exec -u "$PUID:$PGID" reelix pi        # pi itself, to try a model; signing in to a provider is done in Settings → Models
```

As root, `reelix` works through the owner's socket, but a file root writes into `/data` belongs to root until the next start gives it back.

**Upgrading an existing data folder.** Nothing to do: remove `user:` from your compose file (the new `docker-compose.yml` has none) and set `PUID`/`PGID` in `.env` as before. The first start gives the folder to the group `reelix` and sets the modes; this takes a moment on a large folder. A start with `user:` still set is refused with a message that says so. Going back to an image before D2 works: it runs as `PUID`, which still owns everything except what the agent's shell wrote in its folders, which it can read but not change.

**Outside Docker** (development, tests, `npm run server`) there are no other users: the entrypoint is not run, the two variables it sets (`REELIX_AGENT_ID`, `REELIX_PLUGIN_ID`) are absent, and the agent's shell and plugins' processes run as Reelix's user, as before. Only the agent's socket and the limits on pi's file tools ([plugins.md](plugins.md) §11.3) apply everywhere.

## Pre-flight

The pre-flight check (§10.1) prints a `.env` instead of a `docker run` line:
- the media folder;
- `PUID`/`PGID` from qBittorrent;
- the profiles to switch on (only for services it did not find);
- the addresses and the network to join for the services it did find;
- `path_maps` when their mounts differ.

## Implementation status (2026-11-18)

Built:
- `docker-compose.yml`, `.env.example` and `docker-compose.override.example.yml` (joining an existing network, publishing magpie's gateway).
- The `Dockerfile`: `pi` on PATH with `PI_CODING_AGENT_DIR=/data/pi`, `HOME=/data/home`, a health check.
- `packages/core/src/container.ts`: addresses from the environment go into empty settings at start; the doctor flags localhost addresses inside a container.
- Magpie is retried every 5 minutes while it is down. Its refusals explain `admin any` and the allow list when Reelix runs in another container.
- `.dockerignore` and `.gitignore` keep `.env`, `reelix-data/` and the services' config folders (magpie's provider keys among them) out of the image and git.
- The pre-flight prints a `.env`. For each service it found, it says how Reelix reaches it:
  - a user network: its container name, and the network to join;
  - behind a VPN container: that container's name;
  - host networking: `host.docker.internal`;
  - Docker's default bridge: its published port.
  It also prints `path_maps` where mounts differ, and the NAS's home network for magpie's allow list. A public network is never let in: magpie's page then stays on the NAS, reached through an SSH tunnel.

Tested (`packages/core/test/deployment.test.ts`):
- the compose file's rules: optional profiles, one network, `/media` at the same path, magpie's volume not in Reelix, gateway not published, allow list from the subnet, only `MEDIA_ROOT` required, every variable explained in `.env.example`, nothing pointed at localhost, secrets ignored;
- addresses from the environment never overwrite a setting;
- the localhost check;
- the pre-flight against a fake `docker`: qBittorrent behind gluetun, Jellyfin on the default bridge, Jackett missing.

Found while building and fixed:
- Compose reads every service's variables even when its profile is off, so a required `MAGPIE_WEB_KEY` would have stopped installs without magpie.
- Magpie's allow list also guards its web page, so the owner's browser would have been locked out without the home network on it.

The image (2026-11-20, D2): built with `docker build` for the first time with no change needed, and run with a fresh data folder and with one from before D2 (Users and files; what was checked is in [plugins.md](plugins.md) §21, row D2). Found while running it: `docker exec` runs as root, which would leave root-owned files in `/data`; the entrypoint now gives them back at the next start, and the commands above use `-u "$PUID:$PGID"`.

Not verified: Compose has not been run, nor any of the other services. Not yet seen in practice:
- `docker compose config` accepting the file (the `${VAR:+…}` form included);
- `host.docker.internal` resolving;
- magpie's container accepting Reelix's admin key with `any` across the network;
- whether published ports keep the browser's address on the NAS's Docker. This depends on Docker's userland proxy; with it, the browser appears as the network's gateway and is let in anyway.

The first run on the NAS is the test.
