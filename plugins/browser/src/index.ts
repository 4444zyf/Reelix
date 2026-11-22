import { join } from "node:path";
import { OperationError, SETTINGS, Type, definePlugin } from "@reelix/plugin";
import { Browser } from "./browser.ts";
import { registerTools } from "./tools.ts";

/**
 * The agent's browser: one real Chromium with a saved profile, its ten tools in every agent session (a raw pi
 * extension), and the owner's live view of the same page (routes under /api/plugins/browser/). A session's tab
 * goes when the session ends; Chromium closes after ten idle minutes and when the plugin stops.
 */
export default definePlugin({
	config: Type.Object({
		chromium: Type.String({ default: "", [SETTINGS.advanced]: true }),
		headed: Type.Boolean({ default: false, [SETTINGS.advanced]: true }),
	}),
	async activate(ctx, settings) {
		const folder = await ctx.folder();
		const browser = new Browser({
			profile: join(folder, "chromium-profile"),
			chromium: settings.chromium || undefined,
			headed: settings.headed,
			downloads: join(folder, "downloads"),
			proxy: async () => (await ctx.reelix.read.proxy()).url,
		});
		// Closed when the plugin stops, Reelix's shutdown included.
		ctx.signal.addEventListener("abort", () => void browser.close(), { once: true });

		await ctx.pi((pi, session) => registerTools(pi, session, { browser, answer: (id) => ctx.reelix.read.answer(id) }));
		await ctx.on("session.ended", ({ threadId }) => browser.release(threadId));

		const tabOf = (id: string | undefined) => {
			const tab = id ? browser.tabs.get(id) : undefined;
			if (!tab) throw new OperationError("not_found", "no such tab");
			return tab;
		};
		await ctx.route("GET", "/tabs", async () => ({ json: browser.list() }));
		await ctx.route("POST", "/open", async ({ body }) => {
			const tab = await browser.tabFor("owner");
			await tab.page.goto(String((body as { url?: unknown })?.url ?? ""), { waitUntil: "domcontentloaded" }).catch(() => {});
			return { json: { id: tab.id } };
		});
		/** Screencast frames (JPEG, base64) as a stream of events. */
		await ctx.route("GET", "/:tab/stream", async ({ params, signal }) => {
			const tab = tabOf(params.tab);
			return {
				events: (async function* () {
					tab.viewers++;
					const cdp = await tab.page.context().newCDPSession(tab.page);
					let wake: (() => void) | undefined;
					const frames: string[] = [];
					cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
						frames.length = 0;
						frames.push(f.data);
						void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
						wake?.();
					});
					signal.addEventListener("abort", () => wake?.(), { once: true });
					try {
						await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 860, everyNthFrame: 1 });
						while (!signal.aborted && !tab.page.isClosed()) {
							const f = frames.shift();
							if (f) yield { event: "frame", data: { data: f, url: tab.page.url() } };
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
				})(),
			};
		});
		/** The owner's clicks and typing, relayed to the same page. */
		await ctx.route("POST", "/:tab/input", async ({ params, body }) => {
			const p = tabOf(params.tab).page;
			const i = (body ?? {}) as Record<string, unknown>;
			if (i.type === "click") await p.mouse.click(Number(i.x), Number(i.y));
			else if (i.type === "scroll") await p.mouse.wheel(0, Number(i.dy ?? 300));
			else if (i.type === "text") await p.keyboard.type(String(i.text ?? ""));
			else if (i.type === "key") await p.keyboard.press(String(i.key));
			else if (i.type === "goto") await p.goto(String(i.url)).catch(() => {});
			else if (i.type === "back") await p.goBack().catch(() => {});
			return { json: { ok: true, url: p.url() } };
		});
	},
});
