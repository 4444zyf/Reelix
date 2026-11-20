import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { type RouteRequest, type RouteResponse, isOperationError } from "@reelix/plugin";
import { ReelixError, errorMessage } from "@reelix/core";

/** One route of a plugin (docs/plugins.md §6, §11.5): `GET /:tab/stream` under `/api/plugins/<id>`. */
export type PluginRoute = {
	plugin: string;
	method: "GET" | "POST";
	path: string;
	handler(request: RouteRequest): Promise<RouteResponse>;
	/** Its answer was not one a route may give (a handler that throws is counted by the kernel). */
	onFailure(error: unknown): void;
};

/** Route paths: lower-case words, digits, `-`, `_` and `.`, or a `:name` part. */
const PATH = /^(\/([a-z0-9._-]+|:[a-z][a-z0-9_]*))+$/;
/** Types a download may not have: they would show as a page, an image that runs script, or code. */
const PAGE_TYPES = /html|xml|svg|javascript|ecmascript/i;

const parts = (path: string) => path.split("/").filter(Boolean);

/**
 * The routes of running plugins. The web server has one route for all of them, registered at start
 * (`/api/plugins/:plugin/*`), behind the owner's sign-in; plugins come and go here.
 */
export class PluginRoutes {
	private routes: PluginRoute[] = [];

	add(r: PluginRoute): () => void {
		if (r.method !== "GET" && r.method !== "POST") throw new Error(`route ${r.method} ${r.path}: the method must be GET or POST`);
		if (!PATH.test(r.path)) throw new Error(`route "${r.path}": a path starts with / and holds words, digits, - _ . or :name parts`);
		if (this.routes.some((x) => x.plugin === r.plugin && x.method === r.method && parts(x.path).join("/").replace(/:[^/]+/g, ":") === parts(r.path).join("/").replace(/:[^/]+/g, ":"))) throw new Error(`route ${r.method} ${r.path} is already registered`);
		this.routes.push(r);
		return () => {
			this.routes = this.routes.filter((x) => x !== r);
		};
	}

	/** The plugin's route for a path below its prefix, and the values of its `:name` parts. A broken %-escape in such a part throws. */
	match(plugin: string, method: string, path: string): { route: PluginRoute; params: Record<string, string> } | undefined {
		const got = parts(path);
		for (const route of this.routes) {
			if (route.plugin !== plugin || route.method !== method) continue;
			const want = parts(route.path);
			if (want.length !== got.length) continue;
			const params: Record<string, string> = {};
			if (want.every((w, i) => (w.startsWith(":") ? ((params[w.slice(1)] = decodeURIComponent(got[i]!)), true) : w === got[i]))) return { route, params };
		}
		return undefined;
	}

	/** The one handler of `/api/plugins/:plugin/*`: JSON, a download or an event stream, never a page. */
	async dispatch(c: Context): Promise<Response> {
		const plugin = c.req.param("plugin") ?? "";
		const path = c.req.path.slice(`/api/plugins/${plugin}`.length) || "/";
		c.header("x-content-type-options", "nosniff");
		c.header("content-security-policy", "default-src 'none'; sandbox");
		let found: ReturnType<PluginRoutes["match"]>;
		try {
			found = this.match(plugin, c.req.method, path);
		} catch {
			return c.json({ error: `${path} is not a valid path: a %-escape in it is broken` }, 400);
		}
		if (!found) return c.json({ error: this.routes.some((r) => r.plugin === plugin) ? `${plugin} has no route ${c.req.method} ${path}` : `The plugin ${plugin} is not running (Settings → Plugins).` }, 404);
		const { route, params } = found;
		const stop = new AbortController();
		c.req.raw.signal?.addEventListener("abort", () => stop.abort(), { once: true });
		const body = c.req.method === "POST" ? await c.req.json().catch(() => undefined) : undefined;
		let res: RouteResponse;
		try {
			res = await route.handler({ params, query: c.req.query(), body, signal: stop.signal });
		} catch (e) {
			// A refusal (the plugin's OperationError, as the kernel passes it on) is the caller's to act on.
			if (isOperationError(e) || e instanceof ReelixError) return c.json({ error: e.message, code: e.code }, 400);
			return c.json({ error: errorMessage(e) }, 500);
		}
		const refuse = (why: string) => {
			route.onFailure(new Error(`route ${route.method} ${route.path}: ${why}`));
			return c.json({ error: why }, 500);
		};
		if (res && typeof res === "object" && "json" in res) {
			const status = res.status ?? 200;
			if (!Number.isInteger(status) || status < 200 || status > 599) return refuse("status must be 200 to 599");
			return c.json(res.json as object, status as 200);
		}
		if (res && typeof res === "object" && "download" in res) {
			const { bytes, filename, type = "application/octet-stream" } = res.download ?? ({} as never);
			if (!(bytes instanceof Uint8Array) || typeof filename !== "string" || typeof type !== "string") return refuse("a download needs bytes, a filename and a type");
			if (PAGE_TYPES.test(type)) return refuse(`a download may not be ${type}: a route never answers with a page`);
			const name = filename.replace(/["\\\r\n]/g, "_").slice(0, 200) || "download";
			return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { "content-type": type, "content-disposition": `attachment; filename="${name}"` });
		}
		if (res && typeof res === "object" && "events" in res && typeof (res.events as AsyncIterable<unknown>)?.[Symbol.asyncIterator] === "function") {
			const events = res.events;
			return streamSSE(c, async (stream) => {
				stream.onAbort(() => stop.abort());
				const it = events[Symbol.asyncIterator]();
				stop.signal.addEventListener("abort", () => void it.return?.(), { once: true });
				try {
					while (!stop.signal.aborted) {
						const next = await it.next();
						if (next.done || stream.aborted) break;
						await stream.writeSSE({ event: next.value.event, data: JSON.stringify(next.value.data) });
					}
				} catch (e) {
					if (!stop.signal.aborted) route.onFailure(e);
				} finally {
					stop.abort();
				}
			});
		}
		return refuse("a route answers { json }, { download } or { events }");
	}
}
