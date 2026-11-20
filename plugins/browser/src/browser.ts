import { mkdirSync } from "node:fs";
import { type BrowserContext, type Page, chromium } from "playwright-core";
import { findChromium } from "./chromium.ts";

export type Tab = { id: string; page: Page; owner: string; leasedAt: number; viewers: number };

const IDLE_MS = 10 * 60_000;

/**
 * One real Chromium with a saved profile: cookies and logins persist. Each session gets its own tab on a lease,
 * released when its session ends; the owner sees and drives the same page in the live view. Chromium closes
 * after ten idle minutes, and when the plugin stops.
 */
export class Browser {
	tabs = new Map<string, Tab>();
	private ctx?: BrowserContext;
	private starting?: Promise<BrowserContext>;
	private idleTimer?: NodeJS.Timeout;
	private nextId = 1;
	private o: { profile: string; chromium?: string; headed: boolean; proxy: () => Promise<string | undefined>; downloads: string };

	constructor(o: { profile: string; chromium?: string; headed: boolean; proxy: () => Promise<string | undefined>; downloads: string }) {
		this.o = o;
	}

	private async context(): Promise<BrowserContext> {
		if (this.ctx) return this.ctx;
		this.starting ??= (async () => {
			const executablePath = findChromium(this.o.chromium);
			if (!executablePath) throw new Error("No Chromium found. Install it in the container, or set its path on the browser plugin's page.");
			const proxy = await this.o.proxy();
			mkdirSync(this.o.profile, { recursive: true });
			const ctx = await chromium.launchPersistentContext(this.o.profile, {
				executablePath,
				headless: !this.o.headed,
				proxy: proxy ? { server: proxy } : undefined,
				viewport: { width: 1280, height: 860 },
				locale: "zh-CN",
				acceptDownloads: true,
				downloadsPath: this.o.downloads,
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

	/** The tab leased to a session (its thread id), opened on demand. */
	async tabFor(owner: string): Promise<Tab> {
		for (const t of this.tabs.values())
			if (t.owner === owner && !t.page.isClosed()) {
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

	/** A session that ended does not hold its tab. */
	async release(owner: string): Promise<void> {
		for (const t of [...this.tabs.values()]) if (t.owner === owner) await t.page.close().catch(() => {});
		this.touch();
	}

	private touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			if (![...this.tabs.values()].some((t) => t.viewers > 0 || Date.now() - t.leasedAt < IDLE_MS)) void this.close();
		}, IDLE_MS);
		this.idleTimer.unref();
	}

	/** Whether Chromium is running. */
	get open(): boolean {
		return !!this.ctx;
	}

	async close(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		const starting = this.starting;
		this.starting = undefined;
		await (this.ctx ?? (await starting?.catch(() => undefined)))?.close().catch(() => {});
		this.ctx = undefined;
		this.tabs.clear();
	}

	list() {
		return [...this.tabs.values()].map((t) => ({ id: t.id, owner: t.owner, url: t.page.url(), viewers: t.viewers }));
	}
}
