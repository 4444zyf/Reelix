import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { PluginFetchInit, PluginFetchResponse } from "@reelix/plugin";
import { type Reelix, ReelixError, checkedConnection, http, proxyFor } from "@reelix/core";
import type { Manifest } from "./manifest.ts";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
/** Room for a subtitle archive or a .torrent file; nothing a plugin fetches should be larger. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

// 198.18.0.0/15 is left out on purpose: proxies with fake-IP DNS resolve public names into it.
const HOME = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) HOME.addSubnet(net, bits, "ipv4");
// `::/96` also holds `::1` and IPv4 written as `::127.0.0.1`; `64:ff9b::/96` and `2002::/16` carry IPv4 addresses inside them.
for (const [net, bits] of [["::", 96], ["64:ff9b::", 96], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) HOME.addSubnet(net, bits, "ipv6");

/** Loopback, private, link-local and the like: anything that is not the public internet. */
export function isHomeAddress(address: string): boolean {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
	if (mapped) return HOME.check(mapped, "ipv4");
	return HOME.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

const refused = (message: string) => new ReelixError("network_refused", message);
const bareHost = (u: URL) => u.hostname.replace(/^\[|\]$/g, "").toLowerCase();

function hostsInValue(v: unknown, out: Set<string>): void {
	if (typeof v === "string") {
		try {
			out.add(bareHost(new URL(v)));
		} catch {
			/* not an address */
		}
	} else if (Array.isArray(v)) for (const x of v) hostsInValue(x, out);
	else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) hostsInValue(x, out);
}

/** What goes over the wire. Tests replace it; the rules above it stay in force. */
export type HttpTransport = (req: { url: string; method: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal; timeoutMs: number; proxy?: string; checkAddress(address: string): void }) => Promise<{ status: number; headers: Headers; url: string; bytes: Uint8Array }>;

export const realTransport: HttpTransport = async (req) => {
	const host = new URL(req.url).hostname.replace(/^\[|\]$/g, "");
	if (isIP(host)) req.checkAddress(host);
	else if (req.proxy) for (const a of await lookup(host, { all: true })) req.checkAddress(a.address); // the proxy connects; check what the name means here
	const connection = req.proxy ? undefined : checkedConnection(req.checkAddress);
	try {
		const res = await http(req.url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal, timeoutMs: req.timeoutMs, proxy: req.proxy, dispatcher: connection, redirect: "manual" });
		return { status: res.status, headers: res.headers, url: req.url, bytes: await res.bytes(MAX_RESPONSE_BYTES) };
	} finally {
		void connection?.close();
	}
};

/** `ctx.http.fetch` of one plugin (docs/plugins.md §11.4). */
export function pluginFetch(app: Reelix, manifest: Manifest, settings: unknown, transport: HttpTransport) {
	const declared = manifest.uses.network;
	const configHosts = new Set<string>();
	for (const entry of declared) if (entry.startsWith("config:")) hostsInValue(entry.slice(7).split(".").reduce<any>((o, k) => o?.[k], settings), configHosts);
	const ownPorts = () => new Set([String(app.config.web.port), process.env.REELIX_PORT].filter(Boolean));

	const permitted = (host: string) => configHosts.has(host) || declared.some((d) => d === "*" || d === host || (d.startsWith("*.") && host.endsWith(d.slice(1))));

	return async function fetch(url: string, init: PluginFetchInit = {}): Promise<PluginFetchResponse> {
		let current = url;
		let method = (init.method ?? "GET").toUpperCase();
		let body = init.body;
		let headers = init.headers ?? {};
		const timeoutMs = Math.min(init.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
		for (let hops = 0; ; hops++) {
			const u = new URL(current);
			if (u.protocol !== "http:" && u.protocol !== "https:") throw refused(`${u.protocol} addresses cannot be fetched`);
			const host = bareHost(u);
			if (!permitted(host)) throw refused(`${host} is not declared in reelix.uses.network of the plugin ${manifest.id}`);
			const port = u.port || (u.protocol === "https:" ? "443" : "80");
			const res = await transport({
				url: current,
				method,
				headers,
				body,
				signal: init.signal,
				timeoutMs,
				proxy: proxyFor(app.config, init.service ?? manifest.id),
				checkAddress(address) {
					if (!isHomeAddress(address)) return;
					if (!configHosts.has(host)) throw refused(`${host} is on the home network; only a host the owner typed into this plugin's settings may be`);
					if (ownPorts().has(port)) throw refused(`port ${port} is Reelix's own`);
				},
			});
			const location = res.headers.get("location");
			if (init.redirect !== "manual" && res.status >= 300 && res.status < 400 && location) {
				if (hops >= MAX_REDIRECTS) throw new ReelixError("network", `${host}: too many redirects`);
				current = new URL(location, current).toString();
				if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
					method = "GET";
					body = undefined;
				}
				// What the plugin meant for one site (keys, cookies, the body) does not follow to another.
				if (new URL(current).origin !== u.origin) {
					headers = {};
					body = undefined;
					if (method !== "HEAD") method = "GET";
				}
				continue;
			}
			const answered: Record<string, string> = {};
			res.headers.forEach((value, name) => (answered[name] = value));
			return { status: res.status, ok: res.status >= 200 && res.status < 300, url: current, headers: answered, cookies: res.headers.getSetCookie(), bytes: res.bytes };
		}
	};
}
