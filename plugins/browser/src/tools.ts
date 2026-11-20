import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type AgentSessionInfo, Type } from "@reelix/plugin";
import type { Page } from "playwright-core";
import type { Browser, Tab } from "./browser.ts";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the tools need besides the browser: the owner's answer to an Inbox item. */
export type ToolDeps = { browser: Browser; answer(inboxId: string): Promise<{ status: string; answer?: string } | undefined> };

/**
 * The agent's ten browser tools, registered in one session. Results go back as they are: Reelix blanks out secrets
 * and marks the page text as outside text after this. Files land in the session's working folder.
 */
export function registerTools(pi: ExtensionAPI, session: AgentSessionInfo, d: ToolDeps): void {
	const owner = session.threadId;
	const text = (t: string, details: unknown = {}, image?: { data: string; mimeType: string }) => ({ content: [{ type: "text" as const, text: t }, ...(image ? [{ type: "image" as const, ...image }] : [])], details });
	const tool = (name: string, description: string, parameters: any, run: (p: any, page: Page, tab: Tab, cwd: string) => Promise<any>): ToolDefinition<any, any, any> => ({
		name,
		label: name,
		description,
		parameters,
		async execute(_id, p, _signal, _update, ctx) {
			const tab = await d.browser.tabFor(owner);
			return run(p, tab.page, tab, ctx.cwd);
		},
	});
	const tools = [
		tool("browser_open", "Open a URL in the real browser (saved profile: cookies persist). Prefer plain requests (reelix operations, curl) when they work; use the browser for sites that need it, verification, or web pages like Jackett's.", Type.Object({ url: Type.String() }), async (p, page, tab) => {
			await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
			await sleep(1500);
			session.notice(`Browser (${tab.id}) at ${page.url()} — open the live view to watch`);
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
		tool("browser_screenshot", "Take a screenshot you can see (and that show/notify can pass to the owner via its saved path). ref= crops to one element, e.g. a QR code.", Type.Object({ full: Type.Optional(Type.Boolean()), ref: Type.Optional(Type.String()) }), async (p, page, _tab, cwd) => {
			const dir = join(cwd, "screenshots");
			mkdirSync(dir, { recursive: true });
			const path = join(dir, `${Date.now()}.png`);
			const buf = p.ref ? await locate(page, { ref: p.ref }).screenshot({ path }) : await page.screenshot({ path, fullPage: !!p.full });
			return text(`Screenshot saved at ${path}`, { path }, { data: buf.toString("base64"), mimeType: "image/png" });
		}),
		tool("browser_download", "Click something that downloads a file and save it (returns the saved path).", Type.Object({ ref: Type.Optional(Type.String()), text: Type.Optional(Type.String()), selector: Type.Optional(Type.String()) }), async (p, page, _tab, cwd) => {
			const dir = join(cwd, "browser-downloads");
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
				const it = await d.answer(p.inbox_id);
				if (it?.status === "answered") return text(`The owner answered: ${it.answer}`);
				await sleep(3000);
			}
			return text("No answer yet. Park now with notify (wait=true); the tab will be released and you will restart the verification when resumed.");
		}),
		tool("browser_close", "Close your browser tab (done with the page).", Type.Object({}), async () => {
			await d.browser.release(owner);
			return text("Closed.");
		}),
	];
	for (const t of tools) pi.registerTool(t);
}
