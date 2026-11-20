import { existsSync, readFileSync } from "node:fs";
import type { Reelix } from "./app.ts";

/*
 * Running in a container next to other containers (docs/deployment.md, "Reaching each other").
 */

/**
 * Core's settings that docker-compose.yml can fill in at start, while they are still empty. A plugin's own
 * come from its manifest (`reelix.env`), and the plugin manager fills them (docs/plugins.md §5.1).
 */
export const ENV_DEFAULTS: Record<string, string> = {
	REELIX_DEFAULT_MAGPIE_URL: "magpie.url",
};

/** Copy values from the environment into empty settings, by variable name to setting path. A setting already made (in Settings) wins. */
export function applyEnvDefaults(app: Reelix, defaults: Record<string, string> = ENV_DEFAULTS, env: NodeJS.ProcessEnv = process.env): string[] {
	const applied: string[] = [];
	for (const [name, path] of Object.entries(defaults)) {
		const v = env[name]?.trim();
		if (!v || app.getConfig(path)) continue;
		app.setConfig(path, v);
		applied.push(`${path}=${v}`);
	}
	return applied;
}

/** Docker or Podman: /.dockerenv, /run/.containerenv, or a container cgroup. */
export function inContainer(): boolean {
	if (process.env.REELIX_IN_CONTAINER) return process.env.REELIX_IN_CONTAINER === "1";
	if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) return true;
	try {
		return /docker|containerd|kubepods|libpod/.test(readFileSync("/proc/1/cgroup", "utf8"));
	} catch {
		return false;
	}
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i;

/** Service addresses that point at this container itself, with what to use instead. */
export function loopbackAddresses(app: Reelix): { path: string; url: string; fix: string }[] {
	const port = (url: string) => {
		try {
			return new URL(url).port;
		} catch {
			return "";
		}
	};
	// The addresses docker-compose.yml fills, plugins' among them: the compose service is named like the plugin.
	const urls: [string, (url: string) => string][] = [
		["magpie.url", () => "http://magpie:3425"],
		["proxy.default", () => "http://host.docker.internal:7890"],
		...(app.plugins?.envSettings() ?? []).map((e): [string, (url: string) => string] => [e.path, (url) => `http://${e.plugin}${port(url) ? `:${port(url)}` : ""}`]),
	];
	const out: { path: string; url: string; fix: string }[] = [];
	for (const [path, exampleFor] of urls) {
		const url = app.getConfig(path);
		if (typeof url !== "string" || !url) continue;
		const example = exampleFor(url);
		let host = "";
		try {
			host = new URL(url).hostname;
		} catch {
			continue;
		}
		if (!LOOPBACK.test(host)) continue;
		out.push({
			path,
			url,
			fix: `Inside a container, ${host} is Reelix's own container. Use the service's name on Reelix's network (${example}), the NAS's LAN address, or http://host.docker.internal${port(url) ? `:${port(url)}` : ""} for something listening on the NAS itself.`,
		});
	}
	return out;
}
