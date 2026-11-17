# Reelix: one container, one Node process (design §3). Built and first run on the NAS (§12).
FROM node:22-bookworm-slim

# Chromium for the browser (§8), ffmpeg/ffprobe for media_probe, 7-Zip for subtitle archives,
# tini as PID 1, and the usual shell tools the agent uses.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-noto-cjk ffmpeg 7zip unar tini ca-certificates curl jq less procps file \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    REELIX_DATA=/data \
    REELIX_CHROMIUM=/usr/bin/chromium \
    REELIX_WEB_DIR=/app/packages/web/dist \
    REELIX_BIN_DIR=/app/bin \
    PATH=/app/bin:$PATH

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --include=dev

COPY . .
RUN npm -w @reelix/web run build && npm prune --omit=dev && chmod +x bin/reelix

# Runs as qBittorrent's user and group (decision D): pass --user PUID:PGID at run time.
VOLUME ["/data", "/media"]
EXPOSE 7878
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--no-warnings", "packages/server/src/main.ts"]
