import { FormData as UndiciFormData, ProxyAgent, fetch as ufetch, type Dispatcher } from "undici";
import type { Config } from "./config.ts";
import { ReelixError, errorMessage } from "./util.ts";

export const USER_AGENT = "Reelix/0.1 (self-hosted media assistant; https://github.com/4444zyf/Reelix)";
export const BROWSER_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

export type HttpOptions = {
	method?: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array | FormData | URLSearchParams;
	timeoutMs?: number;
	signal?: AbortSignal;
	proxy?: string;
	redirect?: "follow" | "manual";
};

export type HttpResponse = {
	status: number;
	ok: boolean;
	headers: Headers;
	url: string;
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
	bytes(): Promise<Uint8Array>;
};

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
			dispatcher: dispatcher(opts.proxy),
		});
	} catch (e) {
		const host = safeHost(url);
		if (timeout.aborted) throw new ReelixError("network_timeout", `${host} did not answer within ${Math.round((opts.timeoutMs ?? 20_000) / 1000)}s`);
		throw new ReelixError("network", `Could not reach ${host}: ${errorMessage(e)}`);
	}
	const r = res;
	let buf: Uint8Array | undefined;
	const bytes = async () => (buf ??= new Uint8Array(await r.arrayBuffer()));
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
