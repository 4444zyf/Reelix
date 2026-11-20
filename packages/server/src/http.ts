import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
	type Reelix,
	answerInbox,
	dismissInbox,
	errorMessage,
	getInbox,
	http as fetchHttp,
	listInbox,
	newId,
	operationInfo,
	originAllowed,
	ownerLanguage,
	proxyFor,
	ReelixError,
	runOperation,
	THEME_FILE_TYPES,
	installedThemes,
	LANGUAGES,
	themeDir,
} from "@reelix/core";
import type { OpCtx } from "@reelix/core";
import type { AgentHost } from "./agent/host.ts";
import { clearCookie, hashPassword, loginAllowed, loginFailed, loginSucceeded, makeSessionCookie, validSession, verifyPassword } from "./auth.ts";
import type { JobRunner } from "./jobs.ts";
import type { PluginRoutes } from "./plugins/routes.ts";
import { currentSuggestions } from "./suggestions.ts";

/** `devPlugin`: the folder `reelix plugin dev` loads; the web UI shows a banner while it is set. */
export type ServerDeps = { app: Reelix; host: AgentHost; jobs: JobRunner; webDir?: string; routes?: PluginRoutes; devPlugin?: string };

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };

/** What `Sec-Fetch-Dest` says for a document loaded into a frame. */
const FRAME_DESTINATIONS = ["iframe", "frame", "embed", "object", "fencedframe"];

function opError(c: Context, e: unknown) {
	const code = e instanceof ReelixError ? e.code : "error";
	const status =
		code === "invalid_input" || code === "unknown_operation" || code === "unknown_setting" || code === "bad_source" || code === "not_pinned" || code === "refused" || code === "incompatible" || code === "not_installed"
			? 400
			: code === "owner_only"
				? 403
				: code === "not_found" || code === "unknown_title" || code === "unknown_plugin"
					? 404
					: code === "exists" || code === "changed" || code === "nothing_to_approve"
						? 409
						: 500;
	return c.json({ error: errorMessage(e), code }, status);
}

/** Routes shared by the web UI and the local socket. */
function opRoutes(api: Hono, d: ServerDeps, actorOf: (c: Context) => string, requestOf: (c: Context) => OpCtx["request"]) {
	api.get("/api/ops", (c) => c.json(d.app.operations.list().map(operationInfo)));
	api.post("/api/op/:name", async (c) => {
		const name = c.req.param("name");
		const input = await c.req.json().catch(() => ({}));
		try {
			const r = await runOperation(d.app, name, input, { actor: actorOf(c), requestId: c.req.header("x-request-id") ?? newId("web_"), request: requestOf(c) });
			return c.json({ output: r.output, text: r.text, actionId: r.actionId, repeated: r.repeated });
		} catch (e) {
			return opError(c, e);
		}
	});
}

/**
 * The owner's socket: only Reelix's own user can open it (§3.3). The caller is who its token says; without a
 * known token it counts as the agent (docs/plugins.md §11.3).
 */
export function socketApp(d: ServerDeps): Hono {
	const api = new Hono();
	opRoutes(api, d, (c) => d.host.tokens.actorOf(c.req.header("x-reelix-token")), () => undefined);
	return api;
}

/**
 * The agent's socket, the command line of the agent's shell (docs/plugins.md §11.3): in the image another
 * user can open it, so every call needs a session's token, and the owner's token is refused here.
 */
export function agentSocketApp(d: ServerDeps): Hono {
	const api = new Hono();
	const actor = (c: Context) => d.host.tokens.sessionActor(c.req.header("x-reelix-token"));
	api.use("*", async (c, next) => (actor(c) ? next() : c.json({ error: "This socket is for the agent's shell: it needs the token of a running session (REELIX_TOKEN).", code: "no_session" }, 401)));
	opRoutes(api, d, (c) => actor(c)!, () => undefined);
	return api;
}

export function webApp(d: ServerDeps): Hono {
	const { app, host } = d;
	const api = new Hono();

	// ---------------------------------------------------------------- protection (§7.3)
	api.use("/api/*", async (c, next) => {
		const path = c.req.path;
		// Requests from other sites are refused, for every method and the event streams.
		const origin = c.req.header("origin");
		const host_ = c.req.header("host");
		if (origin) {
			if (!originAllowed(app, origin, host_)) return c.json({ error: "cross-site request refused" }, 403);
		} else if (c.req.method !== "GET" && c.req.header("sec-fetch-site") && c.req.header("sec-fetch-site") !== "same-origin") {
			return c.json({ error: "cross-site request refused" }, 403);
		}
		// Reelix's API is never shown inside a frame. A plugin's screen can navigate its own sandboxed frame,
		// and the browser would send the owner's cookie with that (docs/plugins.md §16, phase 8).
		if (FRAME_DESTINATIONS.includes(c.req.header("sec-fetch-dest") ?? "")) return c.json({ error: "Reelix's API is not shown inside a frame" }, 403);
		if (path === "/api/session" || path === "/api/login" || path === "/api/setup-password" || path === "/api/themes" || path.startsWith("/api/themes/")) return next(); // themes: public, the sign-in page is themed
		if (!validSession(app, c.req.header("cookie"))) return c.json({ error: "not signed in" }, 401);
		return next();
	});

	// `language` is public on purpose: the sign-in page is shown in the owner's language.
	api.get("/api/session", (c) => c.json({ authenticated: validSession(app, c.req.header("cookie")), needsPassword: !app.secrets["web.password_hash"], language: app.config.language ?? null }));
	api.post("/api/setup-password", async (c) => {
		if (app.secrets["web.password_hash"]) return c.json({ error: "password already set" }, 409);
		const { password } = await c.req.json();
		if (typeof password !== "string" || password.length < 8) return c.json({ error: "use at least 8 characters" }, 400);
		app.setSecret("web.password_hash", hashPassword(password));
		c.header("set-cookie", makeSessionCookie(app, c.req.url.startsWith("https")));
		return c.json({ ok: true });
	});
	api.post("/api/login", async (c) => {
		const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? (c.env as any)?.incoming?.socket?.remoteAddress ?? "?";
		if (!loginAllowed(ip)) return c.json({ error: "too many attempts; wait 15 minutes" }, 429);
		const { password } = await c.req.json().catch(() => ({}));
		if (!verifyPassword(String(password ?? ""), app.secrets["web.password_hash"])) {
			loginFailed(ip);
			return c.json({ error: "wrong password" }, 401);
		}
		loginSucceeded(ip);
		c.header("set-cookie", makeSessionCookie(app, c.req.url.startsWith("https")));
		return c.json({ ok: true });
	});
	api.post("/api/logout", (c) => {
		c.header("set-cookie", clearCookie());
		return c.json({ ok: true });
	});
	api.post("/api/password", async (c) => {
		const { current, password } = await c.req.json();
		if (!verifyPassword(String(current ?? ""), app.secrets["web.password_hash"])) return c.json({ error: "wrong current password" }, 401);
		if (typeof password !== "string" || password.length < 8) return c.json({ error: "use at least 8 characters" }, 400);
		app.setSecret("web.password_hash", hashPassword(password));
		c.header("set-cookie", makeSessionCookie(app, c.req.url.startsWith("https")));
		return c.json({ ok: true });
	});

	// The protection above has already refused any other origin; operations see only a checked one.
	opRoutes(api, d, () => "owner:web", (c) => {
		const origin = c.req.header("origin");
		return { origin: origin && originAllowed(app, origin, c.req.header("host")) ? origin : undefined };
	});

	// ---------------------------------------------------------------- status
	api.get("/api/status", async (c) => {
		// Reelix's spending on magpie changes as it works: read it again, at most once a minute.
		await host.router.refreshMagpie(60_000);
		const openInbox = (app.db.prepare("SELECT COUNT(*) n FROM inbox WHERE status = 'open'").get() as { n: number }).n;
		return c.json({
			spend: host.spendToday(),
			inbox: openInbox,
			models: host.availableModels(),
			model: host.router.describe(),
			configWarning: app.configWarning,
			jobs: d.jobs.summary(),
			version: "0.1.0",
			devPlugin: d.devPlugin,
		});
	});

	// ---------------------------------------------------------------- threads (§4.5)
	api.get("/api/threads", (c) => c.json(host.listThreads(c.req.query("archived") === "1")));
	api.post("/api/threads", async (c) => {
		const { name, attach } = await c.req.json().catch(() => ({}));
		const t = host.createThread(String(name || "New chat").slice(0, 80), "chat");
		return c.json({ ...t, attach });
	});
	api.patch("/api/threads/:id", async (c) => {
		const body = await c.req.json();
		if (typeof body.name === "string") host.renameThread(c.req.param("id"), body.name.slice(0, 80));
		if (typeof body.archived === "boolean") host.archiveThread(c.req.param("id"), body.archived);
		return c.json(host.getThread(c.req.param("id")));
	});
	api.get("/api/threads/:id", (c) => {
		const id = c.req.param("id");
		const t = host.getThread(id);
		if (!t) return c.json({ error: "no such thread" }, 404);
		return c.json({ thread: t, messages: host.history(id), seq: host.threadSeq(id), running: host.isRunning(id), pending: host.pendingQuestion(id) });
	});
	api.post("/api/threads/:id/messages", async (c) => {
		const id = c.req.param("id");
		const { text, images } = await c.req.json();
		if (!host.getThread(id)) return c.json({ error: "no such thread" }, 404);
		try {
			const r = await host.send(id, String(text ?? ""), { images: Array.isArray(images) ? images : undefined, from: "web" });
			const t = host.getThread(id)!;
			if (t.name === "New chat" && text) host.renameThread(id, String(text).slice(0, 48));
			return c.json(r);
		} catch (e) {
			return c.json({ error: errorMessage(e) }, 500);
		}
	});
	api.post("/api/threads/:id/answer", async (c) => {
		const { questionId, value } = await c.req.json();
		const ok = host.answer(c.req.param("id"), String(questionId), String(value ?? ""));
		return ok ? c.json({ ok }) : c.json({ error: "that question is no longer open" }, 409);
	});
	api.post("/api/threads/:id/abort", async (c) => {
		await host.abort(c.req.param("id"));
		return c.json({ ok: true });
	});
	/** Numbered events after `after`; a returning page catches up (§4.5). */
	api.get("/api/threads/:id/events", (c) => {
		const id = c.req.param("id");
		const after = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0);
		return streamSSE(c, async (stream) => {
			await host.load(id).catch(() => undefined);
			const queue: any[] = [];
			let wake: (() => void) | undefined;
			const { backlog, unsubscribe } = host.subscribe(id, after, (e) => {
				queue.push(e);
				wake?.();
			});
			queue.push(...backlog);
			stream.onAbort(() => {
				unsubscribe();
				wake?.();
			});
			while (!stream.aborted) {
				while (queue.length) {
					const e = queue.shift();
					await stream.writeSSE({ id: String(e.seq), event: "ui", data: JSON.stringify(e) });
				}
				await new Promise<void>((r) => {
					wake = r;
					setTimeout(r, 15_000);
				});
				wake = undefined;
				if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
			}
			unsubscribe();
		});
	});

	/** App-wide events: downloads, inbox, actions, thread activity. */
	api.get("/api/events", (c) =>
		streamSSE(c, async (stream) => {
			const queue: any[] = [];
			let wake: (() => void) | undefined;
			const onApp = (e: any) => {
				queue.push({ ...e, item: undefined });
				wake?.();
			};
			const onUi = (e: any) => {
				if (e.type === "run_start" || e.type === "run_end" || e.type === "ask") {
					queue.push({ type: "thread", threadId: e.threadId, event: e.type });
					wake?.();
				}
			};
			app.events.on("event", onApp);
			host.globalListeners.add(onUi);
			stream.onAbort(() => wake?.());
			while (!stream.aborted) {
				while (queue.length) await stream.writeSSE({ event: "app", data: JSON.stringify(queue.shift()) });
				await new Promise<void>((r) => {
					wake = r;
					setTimeout(r, 15_000);
				});
				wake = undefined;
				if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
			}
			app.events.off("event", onApp);
			host.globalListeners.delete(onUi);
		}),
	);

	// ---------------------------------------------------------------- inbox
	api.get("/api/inbox", (c) => c.json(listInbox(app, { status: c.req.query("status") ?? "open" })));
	api.post("/api/inbox/:id/answer", async (c) => {
		const { answer } = await c.req.json();
		try {
			return c.json(answerInbox(app, c.req.param("id"), String(answer ?? ""), "owner:web"));
		} catch (e) {
			return opError(c, e);
		}
	});
	api.post("/api/inbox/:id/dismiss", (c) => {
		dismissInbox(app, c.req.param("id"));
		return c.json({ ok: true });
	});
	/** "Continue in chat": open the job's conversation as a normal thread (§4.5). */
	api.post("/api/inbox/:id/continue", async (c) => {
		const it = getInbox(app, c.req.param("id"));
		if (!it?.job_run_id) return c.json({ error: "this item has no job conversation" }, 400);
		const t = d.jobs.continueInChat(it.job_run_id);
		if (!t) return c.json({ error: "the job's conversation is not available" }, 404);
		return c.json(t);
	});

	// ---------------------------------------------------------------- for you (docs/trends.md)
	api.get("/api/suggestions", async (c) => c.json(await currentSuggestions(app, host.router)));
	api.post("/api/suggestions/refresh", async (c) => c.json(await currentSuggestions(app, host.router, { refresh: true })));

	// ---------------------------------------------------------------- jobs
	api.get("/api/jobs", (c) => c.json(d.jobs.list()));
	api.post("/api/jobs/:id/run", (c) => c.json(d.jobs.runNow(c.req.param("id"))));

	// ---------------------------------------------------------------- files: posters, images, uploads
	const posterDir = join(app.paths.cache, "posters");
	mkdirSync(posterDir, { recursive: true });
	/** Posters are fetched by the server (through the proxy) so the owner's phone need not reach TMDB (§10). */
	api.get("/api/poster", async (c) => {
		const p = c.req.query("path") ?? "";
		const size = /^w\d+$|^original$/.test(c.req.query("size") ?? "") ? c.req.query("size")! : "w342";
		if (!/^\/[A-Za-z0-9_.-]+\.(jpg|png|webp)$/.test(p)) return c.text("bad path", 400);
		const file = join(posterDir, `${size}${p.replace(/\//g, "_")}`);
		if (!existsSync(file)) {
			try {
				const res = await fetchHttp(`${app.config.tmdb.image_base_url.replace(/\/+$/, "")}/${size}${p}`, { proxy: proxyFor(app.config, "tmdb"), timeoutMs: 20_000 });
				if (!res.ok) return c.text("not found", 404);
				writeFileSync(file, await res.bytes());
			} catch {
				return c.text("poster unavailable", 502);
			}
		}
		c.header("cache-control", "public, max-age=604800, immutable");
		return c.body(readFileSync(file), 200, { "content-type": MIME[extname(file)] ?? "image/jpeg" });
	});
	/** Installed web UI themes (manifests that pass theme.check); built-ins ship with the UI. */
	api.get("/api/themes", (c) => {
		c.header("cache-control", "no-cache");
		return c.json(installedThemes(app));
	});
	/** A file of an installed theme: only inside its folder, only the allowed types (no SVG). */
	api.get("/api/themes/:id/:file{.+}", (c) => {
		const dir = themeDir(app, c.req.param("id"));
		if (!dir) return c.text("not found", 404);
		let real: string;
		try {
			real = realpathSync(resolve(dir, c.req.param("file")));
		} catch {
			return c.text("not found", 404);
		}
		const type = THEME_FILE_TYPES[extname(real).toLowerCase()];
		if (!real.startsWith(realpathSync(dir) + "/") || !type) return c.text("not allowed", 403);
		c.header("cache-control", "no-cache");
		c.header("x-content-type-options", "nosniff");
		return c.body(readFileSync(real), 200, { "content-type": type });
	});
	/** Images the agent shows (screenshots, frames, QR codes): only from Reelix's own working folders. */
	api.get("/api/files", (c) => {
		const p = c.req.query("path") ?? "";
		let real: string;
		try {
			real = realpathSync(resolve(p));
		} catch {
			return c.text("not found", 404);
		}
		const roots = [app.paths.workspace, app.paths.cache].map((r) => realpathSync(r));
		if (!roots.some((r) => real.startsWith(r + "/")) || !/\.(png|jpe?g|webp|gif)$/i.test(real)) return c.text("not allowed", 403);
		return c.body(readFileSync(real), 200, { "content-type": MIME[extname(real).toLowerCase()] ?? "application/octet-stream" });
	});
	/** Drop a file into chat (subtitle, archive, image): saved under the workspace. */
	api.post("/api/upload", async (c) => {
		const form = await c.req.formData();
		const f = form.get("file");
		if (!(f instanceof File)) return c.json({ error: "no file" }, 400);
		if (f.size > 200 * 1024 * 1024) return c.json({ error: "file too large" }, 413);
		const dir = join(app.paths.workspace, "uploads", new Date().toISOString().slice(0, 10));
		mkdirSync(dir, { recursive: true });
		const name = `${randomBytes(3).toString("hex")}-${basename(f.name).replace(/[^\w.\-一-鿿 ]/g, "_")}`;
		const path = join(dir, name);
		writeFileSync(path, Buffer.from(await f.arrayBuffer()));
		return c.json({ path, name: f.name, size: f.size, type: f.type });
	});

	// ---------------------------------------------------------------- plugin screens (docs/plugins.md §16, phase 8)
	// The page puts the document into a sandboxed frame; the frame asks the page, which runs only the plugin's own operations, as the plugin.
	api.get("/api/plugin-screens/:plugin", (c) => {
		try {
			if (!app.plugins) throw new ReelixError("not_found", "Plugins are not running.");
			const lang = LANGUAGES.find((l) => l === c.req.query("lang")) ?? ownerLanguage(app);
			return c.json(app.plugins.screen(c.req.param("plugin"), lang));
		} catch (e) {
			return opError(c, e);
		}
	});
	api.post("/api/plugin-screens/:plugin/run", async (c) => {
		const plugin = c.req.param("plugin");
		const { operation, input } = await c.req.json().catch(() => ({}));
		try {
			const op = typeof operation === "string" && /^[a-z][a-z0-9_]*$/.test(operation) ? app.operations.get(`${plugin}.${operation}`) : undefined;
			if (!op || op.plugin !== plugin) throw new ReelixError("unknown_operation", `${plugin} has no operation ${JSON.stringify(operation)}; a screen runs only its own plugin's operations.`);
			if (!app.plugins?.list().some((p) => p.id === plugin && p.state === "active" && p.screen)) throw new ReelixError("not_found", `${plugin} is not running, or has no screen.`);
			const r = await runOperation(app, op.name, input ?? {}, { actor: `plugin:${plugin}`, requestId: newId("screen_") });
			return c.json({ output: r.output, text: r.text });
		} catch (e) {
			return opError(c, e);
		}
	});

	// Plugins' routes (docs/plugins.md §6, §11.5): one route for all of them, behind the sign-in above.
	const routes = d.routes;
	if (routes) api.all("/api/plugins/:plugin/*", (c) => routes.dispatch(c));

	// ---------------------------------------------------------------- the web UI (static)
	const webDir = d.webDir;
	api.get("*", (c) => {
		if (!webDir || !existsSync(webDir)) return c.html("<!doctype html><title>Reelix</title><p>Reelix is running. The web UI is not built yet: <code>npm run web:build</code>.</p>");
		let p = resolve(webDir, "." + decodeURIComponent(new URL(c.req.url).pathname));
		if (!p.startsWith(resolve(webDir))) return c.text("no", 400);
		if (!existsSync(p) || statSync(p).isDirectory()) p = join(webDir, "index.html"); // client-side routes
		const ext = extname(p);
		if (p.includes("/_astro/")) c.header("cache-control", "public, max-age=31536000, immutable");
		else if (p.endsWith("/sw.js") || ext === ".webmanifest") c.header("cache-control", "no-cache"); // an installed app must see updates
		const etag = `"${createHash("sha1").update(statSync(p).mtimeMs + p).digest("hex").slice(0, 16)}"`;
		if (c.req.header("if-none-match") === etag) return c.body(null, 304);
		c.header("etag", etag);
		return c.body(readFileSync(p), 200, { "content-type": MIME[ext] ?? "application/octet-stream" });
	});
	return api;
}
