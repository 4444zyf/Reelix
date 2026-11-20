# Reelix: one container, one Node process (design §3), started by docker-compose.yml with the other
# services in their own containers (docs/deployment.md). Built and first run on the NAS (§12).
FROM node:22-bookworm-slim

# Chromium for the browser (§8), ffmpeg/ffprobe for media_probe, 7-Zip for subtitle archives,
# tini as PID 1, git for installing plugins from git (npm comes with the base image; docs/plugins.md
# §13.1), and the usual shell tools the agent uses.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-noto-cjk ffmpeg 7zip unar tini ca-certificates curl jq less procps file git \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    REELIX_DATA=/data \
    REELIX_CHROMIUM=/usr/bin/chromium \
    REELIX_WEB_DIR=/app/packages/web/dist \
    REELIX_BIN_DIR=/app/bin \
    PI_CODING_AGENT_DIR=/data/pi \
    HOME=/data/home \
    PATH=/app/bin:$PATH

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/server/package.json packages/server/
COPY packages/plugin/package.json packages/plugin/
COPY packages/plugin-testing/package.json packages/plugin-testing/
COPY packages/web/package.json packages/web/
RUN npm ci --include=dev

COPY . .
RUN npm -w @reelix/web run build && npm prune --omit=dev && chmod +x bin/reelix docker/entrypoint.sh \
    # pi's own command, sharing Reelix's pi folder (PI_CODING_AGENT_DIR): `docker compose exec reelix pi`
    && ln -s /app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /app/bin/pi \
    && chmod +x /app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js

# Three users (docs/deployment.md "Users and files", docs/plugins.md §11.3): Reelix runs as qBittorrent's user and
# group (decision D: PUID and PGID at run time), in the group `reelix` that owns its data folder; the agent's
# shell runs as `reelix-agent`, plugins in a process of their own as `reelix-plugin`. The entrypoint starts as
# root, prepares /data and starts Reelix as PUID:PGID with only the rights to start those two.
RUN groupadd --gid 61870 reelix \
    && groupadd --gid 61871 reelix-agent && useradd --uid 61871 --gid 61871 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin reelix-agent \
    && groupadd --gid 61872 reelix-plugin && useradd --uid 61872 --gid 61872 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin reelix-plugin

# Plugins the owner installs live in /data/plugins, so they survive image updates (docs/plugins.md §13.1).
VOLUME ["/data", "/media"]
EXPOSE 7878
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:7878/api/session').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["node", "--no-warnings", "--disable-sigusr1", "packages/server/src/main.ts"]
