---
name: install-reelix
description: Install Reelix (the self-hosted movie, show and anime copilot) on a NAS or Linux server with Docker Compose, next to qBittorrent, Jackett and Jellyfin. Use this whenever someone asks to install, deploy, set up, self-host or "get running" Reelix, to connect it to services they already run, or to fix an installation that will not start, even if they only say "set this up on my NAS". It first establishes what is already installed (Docker, qBittorrent, Jackett, Jellyfin, a model provider) by checking the machine or asking, because everything after that depends on it.
---

# Installing Reelix

Reelix runs as one container. It talks to qBittorrent (downloads), Jackett (search) and Jellyfin (playback, optional), each in a container of its own, and to a model provider. The Compose file in this repository can start any of those services, or Reelix can use the ones the owner already runs.

Two things decide whether an installation works, and both are settled before anything is started:

1. **What is already installed.** Starting a second qBittorrent beside the owner's own gives them two download clients fighting over ports and folders. Assuming one exists when it does not gives them a Reelix that can do nothing. So the status of each piece of software is checked or asked, never guessed.
2. **One folder for downloads and library.** Reelix files a finished download into the library with a hard link: no copy, and seeding goes on. A hard link cannot cross filesystems, mounts or (on Synology) shared folders. So both folders must sit under one folder on the NAS, which every container mounts as `/media`.

The facts behind this skill are in `docs/deployment.md`, `.env.example`, `docker-compose.yml` and `preflight/reelix-preflight.sh`. Read them when something here does not match what you see: the Compose setup is new and has not yet been run on many machines, so an error may be the project's, not the owner's. Read the message before blaming their setup.

## 1. Find out where you are

The installation happens on the machine that holds the media, usually a NAS. Work out which case you are in:

- **You have a shell on that machine**: you can check things yourself.
- **You are on another machine** (the owner's laptop): ask whether you may use SSH (`ssh user@nas`). If yes, run the checks through it.
- **You cannot reach it at all**: give the owner one command at a time to run there and ask them to paste the output. Do not send a wall of commands.

Docker and the pre-flight check need root on most NAS systems. Ask the owner how they run privileged commands (`sudo`, or a root shell) instead of trying variants. On Synology, `docker` may live at `/var/packages/ContainerManager/target/usr/bin/docker` and not be on PATH.

## 2. Establish what is installed

Fill in this table before going on. Every row ends as one of: **running in a container**, **stopped container**, **installed another way** (a NAS app package, a native service, another machine), **not installed**. "Unknown" is not a result: if a check does not settle a row, ask the owner.

| Software | Needed | How to check | Ask when the check does not settle it |
| --- | --- | --- | --- |
| Docker Engine | yes | `docker --version`, `docker ps` | "Is Docker (Container Manager on Synology) installed? I could not find it." |
| Docker Compose v2 | yes | `docker compose version` | Old `docker-compose` (v1) is not enough: the file uses profiles and `${VAR:+…}`. |
| git | to fetch the code | `git --version` | Without it, download the repository archive instead. |
| qBittorrent | yes | below | "Do you already run qBittorrent anywhere? If not, shall Reelix's Compose file start one?" |
| Jackett | yes | below | Same question. |
| Jellyfin | optional | below | "Do you use Jellyfin? Reelix works without it, but nothing plays the library then." |
| Model provider | yes | ask | "Which model provider will Reelix's agent use, and do you have an account or key for it?" |

For the three services, look in this order, and stop at the first hit:

```sh
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'   # running AND stopped containers
```

- A container whose name or image contains `qbittorrent`, `jackett` or `jellyfin` is that service. Note whether it is running: the pre-flight check only sees running containers, so a stopped one must be started by the owner first (or they tell you it is abandoned).
- Nothing in Docker: it may still be installed another way. Probe the usual ports on the machine (`curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080` for qBittorrent, `:9117` for Jackett, `:8096` for Jellyfin; any HTTP answer means something is listening), and look for a service (`systemctl is-active qbittorrent-nox jackett jellyfin`).
- Still nothing: ask. The owner may run it on another machine, on another port, or under a name you would not recognise (a qBittorrent inside a VPN container, for instance).

Also ask, because no command can tell you:

- **Where do downloads go, and where is the library** (or where should it be)? Is there media there already?
- For a service that exists: is the owner happy for Reelix to use it as it is? Reelix adds torrents to it and reads its settings; it does not need it reinstalled.

Then **show the owner the table** in plain words ("qBittorrent: your existing container `qbit`. Jackett: not installed, Reelix will start one. Jellyfin: the Synology package on port 8096.") and get a yes before continuing. This is the one checkpoint that prevents most bad installations.

If Docker or Compose is missing, stop here and help with that first (the NAS's package centre, or Docker's own install guide for a Linux server). Installing Docker is the owner's decision; do not do it unasked.

## 3. Get the code

```sh
git clone https://github.com/4444zyf/Reelix.git && cd Reelix
```

No image is published: the machine builds Reelix from the repository. Put the clone somewhere that survives (not `/tmp`); with the default settings Reelix's data folder `reelix-data/` is created inside it.

## 4. Run the pre-flight check

When qBittorrent already exists and has downloaded at least one file:

```sh
sudo bash preflight/reelix-preflight.sh
```

It changes nothing except one test link that it creates and removes. It finds the running containers, reads their mounts and user IDs, finds the download folder, tries a real hard link into the library folder, and prints the lines for `.env`. Options when its guesses are wrong: `--downloads /path/on/nas`, `--library /path/on/nas`, `--qbittorrent <container name>`.

Read the whole output, not only the end:

- `OK` and `FAIL` lines are results; `--` lines are notes.
- "This layout works" is followed by the `.env` lines, the network to join if there is one, and `reelix config set path_maps…` commands if a container mounts the media folder at another path than `/media`. Keep all three for later steps.
- **A cross-device failure, or two Synology shared folders**, means hard links are impossible with the current layout. Stop. Explain the two fixes it prints, and let the owner choose. Moving a library or a download folder is their decision and may take hours; never start it yourself.
- A service that is installed outside Docker is reported as "no running container found". That is not "not installed": you already know its status from step 2.

**Fresh installation** (no qBittorrent yet, or it has never downloaded anything): the script has no file to test with and reports a failure that does not apply. Skip it. Agree one folder with the owner (for example `/volume1/data`), create `torrents/` and `library/` inside it, and write `.env` by hand in the next step. Both folders are then on one filesystem by construction, and Reelix's own doctor repeats the link test after the first download.

## 5. Write `.env`

```sh
cp .env.example .env
```

`.env.example` explains every variable. The ones that matter:

- `COMPOSE_PROFILES`: **only** the services from step 2 that are not installed and that the owner asked Reelix to start, from `qbittorrent`, `jackett`, `jellyfin`, `magpie`. A service that exists anywhere stays out of this list. `magpie` is an optional model gateway; leave it out unless the owner wants it.
- `MEDIA_ROOT`: the one folder that holds both downloads and library.
- `PUID` / `PGID`: the user and group qBittorrent runs as (the pre-flight prints them). They must match, or links and file permissions fail. With a qBittorrent that Reelix starts, use the owner of `MEDIA_ROOT` (`stat -c '%u %g' <folder>`).
- `TZ`.
- `QBITTORRENT_URL`, `JACKETT_URL`, `JELLYFIN_URL`: how Reelix's container reaches each service.

| The service is | Address |
| --- | --- |
| started by this Compose file | `http://qbittorrent:8080`, `http://jackett:9117`, `http://jellyfin:8096` |
| an existing container on a user-defined network | join that network (below), then `http://<its container name>:<port>` |
| behind a VPN container such as gluetun | the VPN container's name: `http://gluetun:8080` |
| a container on host networking, or a native service or NAS package on this machine | `http://host.docker.internal:<port>` |
| on another machine | its LAN address: `http://192.168.1.20:8080` |

Never `localhost` or `127.0.0.1`: inside a container that is the container itself, and Reelix's doctor flags it.

**Joining an existing network.** When the pre-flight names a network, copy `docker-compose.override.example.yml` to `docker-compose.override.yml` and put that name under `networks.existing.name`. Keep only the parts you need; the commented magpie block is for something else.

**Ports.** Before starting, check that nothing else listens on the ports this installation publishes: 7878 for Reelix, plus 8080, 6881, 9117 or 8096 for each service being started. If one is taken, change `REELIX_PORT` or the matching `…_WEB_PORT` in `.env` rather than touching the owner's other software.

`.env` and `docker-compose.override.yml` are in `.gitignore`. Show the owner the choices you made (profiles, folder, addresses) before starting; do not print `MAGPIE_WEB_KEY` if you set one.

## 6. Build and start

```sh
docker compose config >/dev/null     # catches a broken .env before anything is built
docker compose up -d --build
docker compose ps                    # reelix should become "healthy" within about a minute of starting
```

The first build takes several minutes. Tell the owner so, and wait for it instead of retrying. If the container restarts or stays unhealthy, `docker compose logs reelix` says why; the entrypoint refuses to start with a clear message for a `PUID` or `PGID` of 0, or a `user:` line added to the Compose file.

Check from the machine itself: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7878/api/session` should print `200` (use the port from `.env`).

Services that this installation started are empty and need their own first-time setup in their web pages, by the owner: qBittorrent (set its save path to `/media/torrents`; the linuxserver image prints a temporary admin password in `docker compose logs qbittorrent`), Jackett (add indexers), Jellyfin (its wizard; point libraries at folders under `/media/library`).

## 7. Hand over to the owner, then to Reelix

Some steps are the owner's own, because they involve their accounts and passwords. Tell them what to do; do not ask them to paste a password or API key into this conversation.

1. **Open `http://<nas>:7878`.** The first visit sets Reelix's password.
2. **Sign in to a model provider.** `pi` is interactive, so the owner runs it. Use the numbers from `.env` for the user, so no root-owned files are left in the data folder:
   ```sh
   docker compose exec -u <PUID>:<PGID> reelix pi
   ```
3. **Ask Reelix to set itself up**, in its chat: "Set yourself up." Reelix has a setup skill of its own. It looks at `/media`, asks for the service addresses, takes each login and API key through a secret field that never reaches the model, and tests each connection.

What you can do from the shell, with the same `-u <PUID>:<PGID>`:

```sh
docker compose exec -u <PUID>:<PGID> reelix reelix config set path_maps.downloaders.qbittorrent '[…]'   # only if the pre-flight printed it
docker compose exec -u <PUID>:<PGID> reelix reelix doctor
```

`reelix doctor` is the final check: connections, path mappings, a hard link with a real downloaded file, whether Jellyfin can read the result, free space, indexers, the model. Read every FAIL. Before the owner has connected the services, failures about missing addresses or logins are expected; a hard-link failure (`EXDEV`: the layout; `EPERM`: `PUID`/`PGID` do not match qBittorrent's) is not, and goes back to steps 4 and 5.

## 8. Report

Finish with a short account the owner can keep:

- what was already there and is being used, and what this installation started;
- the address of Reelix, and of each newly started service;
- where the files are: the clone, `.env`, the data folder (`reelix-data/`, the thing to back up);
- what `reelix doctor` said, with any FAIL quoted;
- what is still theirs to do (password, model sign-in, setup in chat, first-time setup of new services).

Say plainly if a step was skipped or could not be checked.

## Things not to do

- Do not stop, recreate, reconfigure or update the owner's existing containers. Reelix adapts to them (addresses, `path_maps`, an extra network); they do not adapt to Reelix. If a change on their side is truly needed (two shared folders, mismatched users), explain it and let them decide.
- Do not move, rename or delete anything under the media folder.
- Do not publish Reelix to the internet (router port forwarding, a public tunnel) as part of installing. It is built for the home network; `REELIX_BIND=127.0.0.1` keeps it to the machine itself.
- Do not edit `docker-compose.yml`. Local changes belong in `.env` and `docker-compose.override.yml`, so `git pull` keeps working.

## Other ways to run it

- **Just trying it, with no services at all:** the demo in `README.md` ("Try it without any services") runs Reelix against fake services. It needs Node 22.18 or later and a model.
- **From source, without Docker:** `README.md`, "From source". The checks in step 2 still apply; addresses are then ordinary ones, `localhost` included.
- **Updating:** `git pull && docker compose up -d --build`. The data folder carries over.
