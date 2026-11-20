import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { describeConfig } from "../src/config.ts";
import { applyEnvDefaults, loopbackAddresses } from "../src/container.ts";
import { tempApp, withPlugins } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

test("docker-compose.yml: optional services in their own containers, reachable by name, magpie walled off", () => {
	const dc = parse(read("docker-compose.yml"));
	const s = dc.services;
	assert.deepEqual(Object.keys(s).sort(), ["jackett", "jellyfin", "magpie", "qbittorrent", "reelix"]);
	assert.equal(s.reelix.profiles, undefined, "Reelix always runs");
	for (const n of ["magpie", "qbittorrent", "jackett", "jellyfin"]) assert.deepEqual(s[n].profiles, [n], `${n} is optional`);
	for (const [n, svc] of Object.entries<any>(s)) {
		assert.equal(svc.depends_on, undefined, `${n}: no depends_on (a disabled profile cannot be depended on)`);
		assert.deepEqual(svc.networks, ["reelix"], `${n} is on Reelix's network`);
	}

	// the media folder: one mount, the same path everywhere it is used
	const mediaOf = (n: string) => (s[n].volumes as string[]).filter((v) => v.includes("MEDIA_ROOT"));
	for (const n of ["reelix", "qbittorrent", "jellyfin"]) {
		assert.equal(mediaOf(n).length, 1, `${n}: one media mount`);
		assert.match(mediaOf(n)[0]!, /:\/media(:ro)?$/, `${n}: at /media`);
	}
	assert.equal(mediaOf("magpie").length + mediaOf("jackett").length, 0);
	assert.match(mediaOf("jellyfin")[0]!, /:ro$/, "Jellyfin only reads");
	assert.equal(s.reelix.user, undefined, "the image starts as root and switches to PUID:PGID itself (D2)");
	assert.deepEqual([s.reelix.environment.PUID, s.reelix.environment.PGID], ["${PUID:-1000}", "${PGID:-1000}"]);
	assert.equal(s.qbittorrent.environment.PUID, "${PUID:-1000}", "qBittorrent and Reelix share the user");

	// magpie: its data is not visible to the agent's shell, its gateway is not published, only Reelix's network may call it
	const reelixVols = (s.reelix.volumes as string[]).join(" ");
	assert.doesNotMatch(reelixVols, /MAGPIE|magpie/i, "magpie's volume is not mounted into Reelix");
	assert.ok((s.magpie.ports as string[]).every((p) => !p.endsWith(":3425")), "gateway 3425 not published");
	assert.match(s.magpie.environment.MAGPIE_ALLOW_IPS, /^\$\{REELIX_SUBNET:-172\.31\.78\.0\/24\}/);
	assert.equal(dc.networks.reelix.ipam.config[0].subnet, "${REELIX_SUBNET:-172.31.78.0/24}", "the allow list and the network use the same subnet");
	// Compose reads every service's variables even when its profile is off: only what every setup needs may be required.
	const requiredVars = [...read("docker-compose.yml").matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1]);
	assert.deepEqual([...new Set(requiredVars)], ["MEDIA_ROOT"], "an optional service never requires a variable");
	assert.match(s.magpie.image, /:\$\{MAGPIE_VERSION:-0\.1\.\d+\}$/, "magpie is pinned");

	// Reelix reaches the NAS itself through host.docker.internal, and gets the service addresses
	assert.deepEqual(s.reelix.extra_hosts, ["host.docker.internal:host-gateway"]);
	for (const k of ["REELIX_DEFAULT_QBITTORRENT_URL", "REELIX_DEFAULT_JACKETT_URL", "REELIX_DEFAULT_JELLYFIN_URL", "REELIX_DEFAULT_MAGPIE_URL"]) assert.ok(k in s.reelix.environment, k);

	// every variable without a default is explained in .env.example
	const env = read(".env.example");
	const required = [...read("docker-compose.yml").matchAll(/\$\{([A-Z_]+)(:?[-?+])?/g)].map((m) => m[1]!);
	for (const v of new Set(required)) assert.match(env, new RegExp(`^${v}=`, "m"), `.env.example has ${v}`);
	for (const line of env.split("\n").filter((l) => /^[A-Z_]+_URL=/.test(l))) assert.doesNotMatch(line, /localhost|127\.|::1/, `.env.example never points a service at localhost: ${line}`);

	// secrets and service data stay out of the image and out of git
	for (const f of [".dockerignore", ".gitignore"]) for (const p of [".env", "reelix-data/", "magpie-config/"]) assert.match(read(f), new RegExp(`^${p.replace(".", "\\.")}$`, "m"), `${f} ignores ${p}`);
	// pi's command shares Reelix's pi folder
	const df = read("Dockerfile");
	assert.match(df, /PI_CODING_AGENT_DIR=\/data\/pi/);
	assert.match(df, /\/app\/bin\/pi/);
	assert.match(df, /HEALTHCHECK/);
});

test("container: addresses from compose fill only empty settings, core's and those plugins declare (reelix.env); localhost addresses are caught", async () => {
	const { app } = tempApp();
	app.setConfig("plugins.jackett.servers.0.url", "http://192.168.1.10:9117");
	const env = { REELIX_DEFAULT_QBITTORRENT_URL: "http://qbittorrent:8080", REELIX_DEFAULT_JACKETT_URL: "http://jackett:9117", REELIX_DEFAULT_MAGPIE_URL: "" };
	Object.assign(process.env, env);
	let stop: (() => Promise<void>) | undefined;
	try {
		assert.deepEqual(applyEnvDefaults(app), [], "an empty variable fills nothing");
		stop = await withPlugins(app, ["qbittorrent", "jackett", "jellyfin"]);
	} finally {
		for (const k of Object.keys(env)) delete process.env[k];
	}
	try {
		assert.equal(app.getConfig("plugins.qbittorrent.url"), "http://qbittorrent:8080");
		assert.deepEqual(app.config.plugins.jackett, { servers: [{ url: "http://192.168.1.10:9117" }] }, "a setting already made wins");
		assert.equal(app.config.magpie.url, undefined);
		assert.deepEqual(app.plugins!.envSettings().map((e) => `${e.variable}=${e.path}`), ["REELIX_DEFAULT_QBITTORRENT_URL=plugins.qbittorrent.url", "REELIX_DEFAULT_JACKETT_URL=plugins.jackett.servers.0.url", "REELIX_DEFAULT_JELLYFIN_URL=plugins.jellyfin.url"]);

		// Each plugin describes itself for the agent's prompt and `reelix config show`; core names none of them.
		const described = describeConfig(app);
		assert.match(described, /^plugin qbittorrent: at http:\/\/qbittorrent:8080 \(password missing\)$/m);
		assert.match(described, /^plugin jackett: at http:\/\/192\.168\.1\.10:9117 \(api key missing\)$/m);
		assert.match(described, /^plugin jellyfin: at \(not set\) \(api key missing\)$/m);

		app.setConfig("magpie.url", "http://127.0.0.1:3425");
		app.setConfig("plugins.jellyfin.url", "http://localhost:8096");
		const bad = loopbackAddresses(app);
		assert.deepEqual(bad.map((b) => b.path), ["magpie.url", "plugins.jellyfin.url"]);
		assert.match(bad[0]!.fix, /http:\/\/magpie:3425/);
		assert.match(bad[1]!.fix, /\(http:\/\/jellyfin:8096\)/);
		assert.match(bad[1]!.fix, /host\.docker\.internal:8096/);
	} finally {
		await stop?.();
	}
});

test("pre-flight: finds how Reelix's container reaches existing services and prints a .env", () => {
	const t = mkdtempSync(join(tmpdir(), "reelix-pf-"));
	const media = join(t, "volume1", "data");
	mkdirSync(join(media, "torrents", "Some.Movie"), { recursive: true });
	mkdirSync(join(media, "library"), { recursive: true });
	mkdirSync(join(t, "qbconf", "qBittorrent"), { recursive: true });
	writeFileSync(join(media, "torrents", "Some.Movie", "movie.mkv"), Buffer.alloc(4096, 1));
	writeFileSync(join(t, "qbconf", "qBittorrent", "qBittorrent.conf"), "[BitTorrent]\nSession\\DefaultSavePath=/data/torrents\n");
	mkdirSync(join(t, "bin"));
	// qBittorrent behind a gluetun VPN container on a user network; Jellyfin on Docker's default bridge
	const docker = `#!/usr/bin/env bash
if [ "$1" = ps ]; then [ "$2" = --format ] && printf 'qbittorrent lscr.io/linuxserver/qbittorrent\\ngluetun qmcgaw/gluetun\\njellyfin jellyfin/jellyfin\\n'; exit 0; fi
t="$3"; c="$4"
case "$c:$t" in
  qbittorrent:*Config.Env*) printf 'PUID=1026\\nPGID=100\\nWEBUI_PORT=8080\\n' ;;
  jellyfin:*Config.Env*) printf 'PUID=1027\\nPGID=100\\n' ;;
  qbittorrent:*Mounts*) printf '${t}/qbconf -> /config\\n${media} -> /data\\n' ;;
  jellyfin:*Mounts*) printf '${t}/jfconf -> /config\\n${media} -> /data/media\\n' ;;
  qbittorrent:*NetworkMode*) echo container:abc123 ;;
  jellyfin:*NetworkMode*) echo bridge ;;
  abc123:*Name*) echo /gluetun ;;
  gluetun:*Networks*) echo "media_default " ;;
  jellyfin:*Networks*) echo "bridge " ;;
  jellyfin:*Ports*) echo 18096 ;;
  *) echo "" ;;
esac
`;
	writeFileSync(join(t, "bin", "docker"), docker);
	chmodSync(join(t, "bin", "docker"), 0o755);
	const out = execFileSync("bash", [join(ROOT, "preflight", "reelix-preflight.sh"), "--library", join(media, "library")], { env: { ...process.env, PATH: `${join(t, "bin")}:${process.env.PATH}` }, encoding: "utf8" });
	assert.match(out, /^ {2}COMPOSE_PROFILES=jackett /m, "only the service it did not find");
	assert.match(out, /^ {2}PUID=1026$/m);
	assert.match(out, /^ {2}QBITTORRENT_URL=http:\/\/gluetun:8080$/m, "behind a VPN container: that container's name");
	assert.match(out, /^ {2}JELLYFIN_URL=http:\/\/host\.docker\.internal:18096$/m, "default bridge: its published port on the NAS");
	assert.match(out, /^ {4}name: media_default$/m, "join the user network");
	assert.match(out, /path_maps\.downloaders\.qbittorrent '\[\{"theirs":"\/data","ours":"\/media"\}\]'/);
	assert.match(out, /path_maps\.media_servers\.jellyfin '\[\{"theirs":"\/data\/media","ours":"\/media"\}\]'/);
	assert.match(out, /failures=0$/m);
	// magpie's allow list: a private home network is let in to open magpie's page; a public one never
	const lan = /lan="([^"]*)"/.exec(out)![1]!;
	if (lan) {
		assert.match(lan, /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)/, "only a private range");
		assert.match(out, new RegExp(`MAGPIE_ALLOW_IPS_EXTRA=${lan.replace(/\./g, "\\.")}`));
	} else if (/is public, not a home network/.test(out)) {
		assert.match(out, /^ {2}MAGPIE_ALLOW_IPS_EXTRA= /m);
		assert.match(out, /^ {2}MAGPIE_WEB_BIND=127\.0\.0\.1 /m);
	}
});
