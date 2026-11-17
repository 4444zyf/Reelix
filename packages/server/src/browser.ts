import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type BrowserContext, type CDPSession, type Page, chromium } from "playwright-core";
import { streamSSE } from "hono/streaming";
import { Type } from "typebox";
import { type Reelix, errorMessage, getInbox, proxyFor, sleep } from "@reelix/core";
import type { Subsystem } from "./plugins.ts";

/** Find a Chromium: env override, the container's system Chromium, or a Playwright download. */
export function findChromium(): string | undefined {
	const env = process.env.REELIX_CHROMIUM;
	if (env && existsSync(env)) return env;
	for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) if (existsSync(p)) return p;
	const pw = join(homedir(), ".cache/ms-playwright");
	if (existsSync(pw)) {
		for (const d of readdirSync(pw).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
			for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) if (existsSync(join(pw, d, sub))) return join(pw, d, sub);
		}
	}
	return undefined;
}

type Tab = { id: string; page: Page; owner: string; leasedAt: number; cdp?: CDPSession; viewers: number };

/**
 * One real Chromium with a saved profile (§8): cookies and logins persist. Each session gets its
 * own tab on a lease; a parked job releases its tab. The owner sees and drives the same page in
 * the live view (screencast frames out, clicks and keys in, over Chromium's own control channel).
 */
export class BrowserManager {
	app: Reelix;
	ctx?: BrowserContext;
	tabs = new Map<string, Tab>();
	private starting?: Promise<BrowserContext>;
	private idleTimer?: NodeJS.Timeout;
	private nextId = 1;

	constructor(app: Reelix) {
		this.app = app;
	}

	async context(): Promise<BrowserContext> {
		if (this.ctx) return this.ctx;
		this.starting ??= (async () => {
			const executablePath = findChromium();
			if (!executablePath) throw new Error("No Chromium found. Install it in the container (or set REELIX_CHROMIUM).");
			const proxy = proxyFor(this.app.config, "browser");
			mkdirSync(this.app.paths.browserProfile, { recursive: true });
			const ctx = await chromium.launchPersistentContext(this.app.paths.browserProfile, {
				executablePath,
				headless: process.env.REELIX_BROWSER_HEADED !== "1",
				proxy: proxy ? { server: proxy } : undefined,
				viewport: { width: 1280, height: 860 },
				locale: "zh-CN",
				acceptDownloads: true,
				downloadsPath: join(this.app.paths.workspace, "browser-downloads"),
				args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"],
			});
			ctx.on("close", () => {
				this.ctx = undefined;
				this.starting = undefined;
				this.tabs.clear();
			});
			this.ctx = ctx;
			return ctx;
		})();
		try {
			return await this.starting;
		} catch (e) {
			this.starting = undefined;
			throw e;
		}
	}

	/** The tab leased to a session, opened on demand. */
	async tabFor(owner: string): Promise<Tab> {
		for (const t of this.tabs.values()) if (t.owner === owner && !t.page.isClosed()) {
			t.leasedAt = Date.now();
			return t;
		}
		const ctx = await this.context();
		const page = await ctx.newPage();
		const tab: Tab = { id: `tab${this.nextId++}`, page, owner, leasedAt: Date.now(), viewers: 0 };
		page.on("close", () => this.tabs.delete(tab.id));
		this.tabs.set(tab.id, tab);
		this.touch();
		return tab;
	}

	/** A job waiting for the owner does not hold its tab (§8). */
	async release(owner: string): Promise<void> {
		for (const t of [...this.tabs.values()]) if (t.owner === owner) await t.page.close().catch(() => {});
		this.touch();
	}

	private touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			if (![...this.tabs.values()].some((t) => t.viewers > 0 || Date.now() - t.leasedAt < 10 * 60_000)) void this.close();
		}, 10 * 60_000);
		this.idleTimer.unref();
	}

	async close(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		await this.ctx?.close().catch(() => {});
		this.ctx = undefined;
		this.tabs.clear();
	}

	list() {
		return [...this.tabs.values()].map((t) => ({ id: t.id, owner: t.owner, url: t.page.url(), viewers: t.viewers }));
	}
}

// ------------------------------------------------------------------ reading a page as structured text

const SNAPSHOT_JS = `(() => {
	let n = 0;
	const out = [];
	const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
	document.querySelectorAll("[data-rx]").forEach((e) => e.removeAttribute("data-rx"));
	const sel = "a[href], button, input, textarea, select, [role=button], [role=checkbox], [role=link], [onclick], iframe, summary, label";
	for (const el of document.querySelectorAll(sel)) {
		if (!visible(el) || n >= 150) continue;
		const ref = String(++n);
		el.setAttribute("data-rx", ref);
		const tag = el.tagName.toLowerCase();
		const type = el.getAttribute("type") || el.getAttribute("role") || "";
		const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("src") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
		const href = tag === "a" ? (el.getAttribute("href") || "").slice(0, 100) : "";
		out.push("[" + ref + "] " + tag + (type ? ":" + type : "") + " " + JSON.stringify(label) + (href ? " -> " + href : "") + (el.disabled ? " (disabled)" : ""));
	}
	const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 6000);
	return { title: document.title, url: location.href, text, elements: out };
})()`;

async function snapshot(page: Page): Promise<string> {
	const s = (await page.evaluate(SNAPSHOT_JS)) as { title: string; url: string; text: string; elements: string[] };
	const frames = page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url()).filter((u) => u && u !== "about:blank");
	return `Title: ${s.title}\nURL: ${s.url}${frames.length ? `\nFrames: ${frames.slice(0, 5).join(", ")}` : ""}\n\nInteractive elements (use ref with browser_click / browser_type):\n${s.elements.join("\n")}\n\nPage text:\n${s.text}`;
}

function locate(page: Page, p: { ref?: string; text?: string; selector?: string }) {
	if (p.ref) return page.locator(`[data-rx="${p.ref}"]`).first();
	if (p.selector) return page.locator(p.selector).first();
	if (p.text) return page.getByText(p.text, { exact: false }).first();
	throw new Error("Give ref (from browser_snapshot), text, or selector.");
}

// ------------------------------------------------------------------ the tools

export function browserTools(bm: BrowserManager, app: Reelix, ctx: { threadId: string; kind: string; actor: string; emit: (e: Record<string, unknown>) => void }): ToolDefinition<any, any, any>[] {
	const owner = ctx.threadId;
	const text = (t: string, details: unknown = {}, image?: { data: string; mimeType: string }) => ({ content: [{ type: "text" as const, text: app.redact(t) }, ...(image ? [{ type: "image" as const, ...image }] : [])], details });
	const shot = async (page: Page, opts: { full?: boolean; ref?: string } = {}) => {
		const dir = join(app.paths.workspace, "screenshots");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${Date.now()}.png`);
		const buf = opts.ref ? await locate(page, { ref: opts.ref }).screenshot({ path }) : await page.screenshot({ path, fullPage: !!opts.full });
		return { path, data: buf.toString("base64") };
	};
	const tool = (name: string, description: string, parameters: any, run: (p: any, page: Page, tab: Tab) => Promise<any>): ToolDefinition<any, any, any> => ({
		name,
		label: name,
		description,
		parameters,
		async execute(_id: string, p: any) {
			try {
				const tab = await bm.tabFor(owner);
				return await run(p, tab.page, tab);
			} catch (e) {
				throw new Error(errorMessage(e));
			}
		},
	});
	return [
		tool("browser_open", "Open a URL in the real browser (saved profile: cookies persist). Prefer plain requests (reelix operations, curl) when they work; use the browser for sites that need it, verification, or web pages like Jackett's.", Type.Object({ url: Type.String() }), async (p, page, tab) => {
			await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
			await sleep(1500);
			ctx.emit({ type: "notice", text: `Browser (${tab.id}) at ${page.url()} — open the live view to watch` });
			return text(await snapshot(page), { tab: tab.id, url: page.url() });
		}),
		tool("browser_snapshot", "Read the current page as structured text with numbered interactive elements.", Type.Object({}), async (_p, page) => text(await snapshot(page))),
		tool("browser_click", "Click an element by ref (from browser_snapshot), visible text, or CSS selector. Also works for a checkbox like 'Verify you are human'.", Type.Object({ ref: Type.Optional(Type.String()), text: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()) }), async (p, page) => {
			if (p.x !== undefined && p.y !== undefined) await page.mouse.click(p.x, p.y);
			else await locate(page, p).click({ timeout: 15_000 });
			await sleep(1500);
			return text(`Clicked. Now at ${page.url()}`);
		}),
		tool("browser_type", "Type into an input (by ref/text/selector); submit=true presses Enter.", Type.Object({ ref: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), text: Type.String(), submit: Type.Optional(Type.Boolean()) }), async (p, page) => {
			const l = locate(page, { ref: p.ref, selector: p.selector });
			await l.fill(p.text, { timeout: 15_000 });
			if (p.submit) await l.press("Enter");
			await sleep(1000);
			return text("Typed.");
		}),
		tool("browser_wait", "Wait for seconds, or until some text appears (e.g. after a Cloudflare check).", Type.Object({ seconds: Type.Optional(Type.Number({ maximum: 120 })), text: Type.Optional(Type.String()) }), async (p, page) => {
			if (p.text) await page.getByText(p.text).first().waitFor({ timeout: Math.min(120, p.seconds ?? 30) * 1000 });
			else await sleep(Math.min(120, p.seconds ?? 5) * 1000);
			return text(`Waited. URL: ${page.url()}, title: ${await page.title()}`);
		}),
		tool("browser_screenshot", "Take a screenshot you can see (and that show/notify can pass to the owner via its saved path). ref= crops to one element, e.g. a QR code.", Type.Object({ full: Type.Optional(Type.Boolean()), ref: Type.Optional(Type.String()) }), async (p, page) => {
			const s = await shot(page, p);
			return text(`Screenshot saved at ${s.path}`, { path: s.path }, { data: s.data, mimeType: "image/png" });
		}),
		tool("browser_download", "Click something that downloads a file and save it (returns the saved path).", Type.Object({ ref: Type.Optional(Type.String()), text: Type.Optional(Type.String()), selector: Type.Optional(Type.String()) }), async (p, page) => {
			const dir = join(app.paths.workspace, "browser-downloads");
			mkdirSync(dir, { recursive: true });
			const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), locate(page, p).click()]);
			const path = join(dir, `${Date.now()}-${dl.suggestedFilename()}`);
			await dl.saveAs(path);
			return text(`Downloaded to ${path}`, { path });
		}),
		tool("browser_eval", "Run a small JavaScript expression in the page and return its JSON result (for reading data; not for disguising the browser).", Type.Object({ expression: Type.String() }), async (p, page) => {
			const r = await page.evaluate(p.expression);
			return text(JSON.stringify(r, null, 1)?.slice(0, 8000) ?? "undefined");
		}),
		tool("browser_wait_for_answer", "Background jobs: hold the page open for a few minutes waiting for the owner's answer to an Inbox item (e.g. a code sent to their phone). Returns the answer, or says none came.", Type.Object({ inbox_id: Type.String(), minutes: Type.Optional(Type.Number({ maximum: 10 })) }), async (p) => {
			const until = Date.now() + Math.min(10, p.minutes ?? 5) * 60_000;
			while (Date.now() < until) {
				const it = getInbox(app, p.inbox_id);
				if (it?.status === "answered") return text(`The owner answered: ${it.answer}`);
				await sleep(3000);
			}
			return text("No answer yet. Park now with notify (wait=true); the tab will be released and you will restart the verification when resumed.");
		}),
		tool("browser_close", "Close your browser tab (done with the page).", Type.Object({}), async () => {
			await bm.release(owner);
			return text("Closed.");
		}),
	];
}

// ------------------------------------------------------------------ live view routes

export function browserSubsystem(): Subsystem {
	let bm: BrowserManager;
	return {
		name: "browser",
		init({ app, host, jobs }) {
			bm = new BrowserManager(app);
			// A finished or parked job releases its tab.
			host.globalListeners.add((e) => {
				if (e.type === "run_end" && host.getThread(e.threadId)?.kind === "job") void bm.release(e.threadId);
			});
			void jobs;
		},
		tools: (ctx) => (bm ? browserTools(bm, bm.app, ctx) : []),
		routes(api) {
			api.get("/api/browser/tabs", (c) => c.json(bm.list()));
			api.post("/api/browser/open", async (c) => {
				const { url } = await c.req.json();
				const tab = await bm.tabFor("owner");
				await tab.page.goto(String(url), { waitUntil: "domcontentloaded" }).catch(() => {});
				return c.json({ id: tab.id });
			});
			/** Screencast frames (JPEG, base64) over SSE. */
			api.get("/api/browser/:tab/stream", (c) => {
				const tab = bm.tabs.get(c.req.param("tab"));
				if (!tab) return c.json({ error: "no such tab" }, 404);
				return streamSSE(c, async (stream) => {
					tab.viewers++;
					const cdp = await tab.page.context().newCDPSession(tab.page);
					let wake: (() => void) | undefined;
					const frames: string[] = [];
					cdp.on("Page.screencastFrame", (f: any) => {
						frames.length = 0;
						frames.push(f.data);
						void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
						wake?.();
					});
					await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 860, everyNthFrame: 1 });
					stream.onAbort(() => wake?.());
					try {
						while (!stream.aborted && !tab.page.isClosed()) {
							const f = frames.shift();
							if (f) await stream.writeSSE({ event: "frame", data: JSON.stringify({ data: f, url: tab.page.url() }) });
							else
								await new Promise<void>((r) => {
									wake = r;
									setTimeout(r, 5000);
								});
						}
					} finally {
						tab.viewers--;
						await cdp.send("Page.stopScreencast").catch(() => {});
						await cdp.detach().catch(() => {});
					}
				});
			});
			/** The owner's clicks and typing, relayed to the same page. */
			api.post("/api/browser/:tab/input", async (c) => {
				const tab = bm.tabs.get(c.req.param("tab"));
				if (!tab) return c.json({ error: "no such tab" }, 404);
				const i = await c.req.json();
				const p = tab.page;
				if (i.type === "click") await p.mouse.click(Number(i.x), Number(i.y));
				else if (i.type === "scroll") await p.mouse.wheel(0, Number(i.dy ?? 300));
				else if (i.type === "text") await p.keyboard.type(String(i.text ?? ""));
				else if (i.type === "key") await p.keyboard.press(String(i.key));
				else if (i.type === "goto") await p.goto(String(i.url)).catch(() => {});
				else if (i.type === "back") await p.goBack().catch(() => {});
				return c.json({ ok: true, url: p.url() });
			});
		},
	};
}
