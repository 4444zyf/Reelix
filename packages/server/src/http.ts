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
	listOperations,
	newId,
	proxyFor,
	ReelixError,
	runOperation,
} from "@reelix/core";
import type { AgentHost } from "./agent/host.ts";
import { COOKIE, clearCookie, hashPassword, loginAllowed, loginFailed, loginSucceeded, makeSessionCookie, validSession, verifyPassword } from "./auth.ts";
import type { JobRunner } from "./jobs.ts";
import type { TelegramBot } from "./telegram.ts";

export type ServerDeps = { app: Reelix; host: AgentHost; jobs: JobRunner; telegram: TelegramBot; webDir?: string; extra?: (api: Hono) => void };

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".txt": "text/plain" };

function opError(c: Context, e: unknown) {
	const code = e instanceof ReelixError ? e.code : "error";
	const status = code === "invalid_input" || code === "unknown_operation" || code === "unknown_setting" ? 400 : code === "not_found" || code === "unknown_title" ? 404 : 500;
	return c.json({ error: errorMessage(e), code }, status);
}

/** Routes shared by the web UI and the local socket. */
function opRoutes(api: Hono, d: ServerDeps, actorOf: (c: Context) => string) {
	api.get("/api/ops", (c) => c.json(listOperations().map((o) => ({ name: o.name, summary: o.summary, description: o.description, effect: o.effect, input: o.input, tool: o.tool, positional: o.positional }))));
	api.post("/api/op/:name", async (c) => {
		const name = c.req.param("name");
		const input = await c.req.json().catch(() => ({}));
		try {
			const r = await runOperation(d.app, name, input, { actor: actorOf(c), requestId: c.req.header("x-request-id") ?? newId("web_") });
			return c.json({ output: r.output, text: r.text, actionId: r.actionId, repeated: r.repeated });
		} catch (e) {
			return opError(c, e);
		}
	});
}

/** The private socket: only Reelix's own user can open it; it is the agent's command line (§3.3). */
export function socketApp(d: ServerDeps): Hono {
	const api = new Hono();
	opRoutes(api, d, (c) => c.req.header("x-reelix-actor") ?? "owner:cli");
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
			const allowed = app.config.web.allowed_origins;
			let ok = false;
			try {
				ok = new URL(origin).host === host_ || allowed.includes(origin);
			} catch {}
			if (!ok) return c.json({ error: "cross-site request refused" }, 403);
		} else if (c.req.method !== "GET" && c.req.header("sec-fetch-site") && c.req.header("sec-fetch-site") !== "same-origin") {
			return c.json({ error: "cross-site request refused" }, 403);
		}
		if (path === "/api/session" || path === "/api/login" || path === "/api/setup-password" || path === "/api/telegram/webhook") return next();
		if (!validSession(app, c.req.header("cookie"))) return c.json({ error: "not signed in" }, 401);
		return next();
	});

	api.get("/api/session", (c) => c.json({ authenticated: validSession(app, c.req.header("cookie")), needsPassword: !app.secrets["web.password_hash"] }));
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

	opRoutes(api, d, () => "owner:web");

	// ---------------------------------------------------------------- status
	api.get("/api/status", (c) => {
		const openInbox = (app.db.prepare("SELECT COUNT(*) n FROM inbox WHERE status = 'open'").get() as { n: number }).n;
		return c.json({
			spend: host.spendToday(),
			inbox: openInbox,
			models: host.availableModels(),
			model: { main: app.config.models.main, background: app.config.models.background },
			configWarning: app.configWarning,
			telegram: d.telegram.status(),
			jobs: d.jobs.summary(),
			version: "0.1.0",
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

	// ---------------------------------------------------------------- jobs
	api.get("/api/jobs", (c) => c.json(d.jobs.list()));
	api.post("/api/jobs/:id/run", (c) => c.json(d.jobs.runNow(c.req.param("id"))));

	// ---------------------------------------------------------------- telegram
	api.post("/api/telegram/link", (c) => c.json({ code: d.telegram.newLinkCode() }));

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

	d.extra?.(api);

	// ---------------------------------------------------------------- the web UI (static)
	const webDir = d.webDir;
	api.get("*", (c) => {
		if (!webDir || !existsSync(webDir)) return c.html("<!doctype html><title>Reelix</title><p>Reelix is running. The web UI is not built yet: <code>npm run web:build</code>.</p>");
		let p = resolve(webDir, "." + decodeURIComponent(new URL(c.req.url).pathname));
		if (!p.startsWith(resolve(webDir))) return c.text("no", 400);
		if (!existsSync(p) || statSync(p).isDirectory()) p = join(webDir, "index.html"); // client-side routes
		const ext = extname(p);
		if (p.includes("/_astro/")) c.header("cache-control", "public, max-age=31536000, immutable");
		const etag = `"${createHash("sha1").update(statSync(p).mtimeMs + p).digest("hex").slice(0, 16)}"`;
		if (c.req.header("if-none-match") === etag) return c.body(null, 304);
		c.header("etag", etag);
		return c.body(readFileSync(p), 200, { "content-type": MIME[ext] ?? "application/octet-stream" });
	});
	return api;
}

export { COOKIE };
