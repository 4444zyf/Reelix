import { lookup as dnsLookup } from "node:dns";
import { Agent, FormData as UndiciFormData, ProxyAgent, fetch as ufetch, type Dispatcher } from "undici";
import type { Config } from "./config.ts";
import { ReelixError, errorMessage } from "./util.ts";

export const USER_AGENT = "Reelix/0.1 (self-hosted media assistant; https://github.com/4444zyf/Reelix)";

const agents = new Map<string, Dispatcher>();

/** The proxy for a named outside service, per §10: per-service override, else the default if listed in use_for. */
export function proxyFor(config: Config, service: string): string | undefined {
	const per = config.proxy.per_service[service];
	if (per) return per === "none" ? undefined : per;
	if (config.proxy.default && config.proxy.use_for.includes(service)) return config.proxy.default;
	return undefined;
}

function dispatcher(proxy: string | undefined): Dispatcher | undefined {
	if (!proxy) return undefined;
	let a = agents.get(proxy);
	if (!a) {
		a = new ProxyAgent(proxy);
		agents.set(proxy, a);
	}
	return a;
}

/**
 * A one-use connection that resolves the host itself and connects only to addresses `allow`
 * accepts, so a name cannot change between the check and the connection (docs/plugins.md §11.4).
 */
export function checkedConnection(allow: (address: string) => void): Agent {
	return new Agent({
		connect: {
			lookup(host, options, callback) {
				dnsLookup(host, { all: true, family: options.family as number | undefined }, (e, addresses) => {
					if (e) return callback(e, "", 0);
					try {
						for (const a of addresses) allow(a.address);
					} catch (refused) {
						return callback(refused as NodeJS.ErrnoException, "", 0);
					}
					if (options.all) (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
					else callback(null, addresses[0]!.address, addresses[0]!.family);
				});
			},
		},
	});
}

export type HttpOptions = {
	method?: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array | FormData | URLSearchParams;
	timeoutMs?: number;
	signal?: AbortSignal;
	proxy?: string;
	/** Use this connection instead of the default or the proxy's. */
	dispatcher?: Dispatcher;
	redirect?: "follow" | "manual";
};

export type HttpResponse = {
	status: number;
	ok: boolean;
	headers: Headers;
	url: string;
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
	/** With `limit`, refuses a body larger than that many bytes without reading the rest. */
	bytes(limit?: number): Promise<Uint8Array>;
};

async function readUpTo(r: Response, limit: number, host: string): Promise<Uint8Array> {
	const tooLarge = () => new ReelixError("network_too_large", `${host} sent more than ${Math.round(limit / 1024 / 1024)} MB.`);
	if (Number(r.headers.get("content-length") ?? 0) > limit) {
		await r.body?.cancel();
		throw tooLarge();
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = r.body?.getReader();
	for (let next = await reader?.read(); next && !next.done; next = await reader!.read()) {
		size += next.value.length;
		if (size > limit) {
			await reader!.cancel();
			throw tooLarge();
		}
		chunks.push(next.value);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

export async function http(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
	const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	let res;
	try {
		res = await ufetch(url, {
			method: opts.method ?? "GET",
			headers: { "user-agent": USER_AGENT, ...opts.headers },
			body: toUndiciBody(opts.body) as never,
			signal,
			redirect: opts.redirect ?? "follow",
			dispatcher: opts.dispatcher ?? dispatcher(opts.proxy),
		});
	} catch (e) {
		const host = safeHost(url);
		if (timeout.aborted) throw new ReelixError("network_timeout", `${host} did not answer within ${Math.round((opts.timeoutMs ?? 20_000) / 1000)}s`);
		throw new ReelixError("network", `Could not reach ${host}: ${errorMessage(e)}`);
	}
	const r = res;
	let buf: Uint8Array | undefined;
	const bytes = async (limit?: number) => (buf ??= limit === undefined ? new Uint8Array(await r.arrayBuffer()) : await readUpTo(r as unknown as Response, limit, safeHost(url)));
	return {
		status: r.status,
		ok: r.ok,
		headers: r.headers as unknown as Headers,
		url: r.url,
		bytes,
		text: async () => new TextDecoder().decode(await bytes()),
		json: async <T>() => {
			const t = new TextDecoder().decode(await bytes());
			try {
				return JSON.parse(t) as T;
			} catch {
				throw new ReelixError("bad_response", `${safeHost(url)} returned something that is not JSON (HTTP ${r.status}): ${t.slice(0, 200)}`);
			}
		},
	};
}

/**
 * undici's own fetch does not recognise Node's built-in FormData (a different undici copy): it
 * would send the text "[object FormData]". Copy the fields into undici's FormData instead.
 */
function toUndiciBody(body: HttpOptions["body"]): unknown {
	if (!(body instanceof FormData)) return body;
	const out = new UndiciFormData();
	for (const [k, v] of body.entries()) {
		if (typeof v === "string") out.append(k, v);
		else out.append(k, v, v.name);
	}
	return out;
}

export function safeHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "the service";
	}
}

export async function expectOk(res: HttpResponse, what: string): Promise<HttpResponse> {
	if (!res.ok) {
		const body = (await res.text()).slice(0, 300);
		throw new ReelixError("http_error", `${what} failed: HTTP ${res.status}${body ? `: ${body}` : ""}`);
	}
	return res;
}
