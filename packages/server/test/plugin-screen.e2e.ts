/**
 * A plugin's screen in a real browser (run against a running server with the reference plugin
 * `finished-cleanup` switched on): the screen works through `window.reelix`, and the sandboxed frame
 * cannot read cookies or storage, call /api with the owner's session, reach the page around it, or
 * navigate it; a site the frame navigates to gets no bridge. Prints one line per check and exits 1 if any fails.
 *
 *   REELIX_URL=http://127.0.0.1:7979 REELIX_PASSWORD=… node packages/server/test/plugin-screen.e2e.ts
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type Frame, chromium } from "playwright-core";
import { findChromium } from "../../../plugins/browser/src/chromium.ts";

const base = process.env.REELIX_URL ?? "http://localhost:7979";
const pw = process.env.REELIX_PASSWORD ?? "testpass123";
const shot = process.env.SHOT;
const b = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
	results.push({ check: name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
/** Answers from Reelix's API to requests the screen's frame made (a request the browser refused never gets one). */
const answeredToScreen: string[] = [];
page.on("response", (r) => {
	if (r.url().includes("/api/") && r.frame() !== page.mainFrame()) answeredToScreen.push(`${r.request().method()} ${r.url()} → ${r.status()}`);
});
/** Requests the browser refused, with why. */
const refused: string[] = [];
page.on("requestfailed", (r) => refused.push(`${r.url()}: ${r.failure()?.errorText}`));

try {
	await page.goto(base);
	const field = page.locator('input[type="password"]').first();
	await field.fill(pw);
	await field.press("Enter");
	await page.waitForTimeout(1500);
	const cookies = await page.context().cookies();
	check("signed in: the page has a session cookie", cookies.length > 0, cookies.map((c) => `${c.name} (httpOnly ${c.httpOnly}, sameSite ${c.sameSite})`).join(", "));

	// The Plugins menu leads to the screen.
	const entry = page.getByRole("link", { name: /Finished downloads/ }).first();
	check("the sidebar lists the screen under Plugins", (await entry.count()) > 0);
	await entry.click();
	await page.waitForURL(/\/plugins\/finished-cleanup$/);
	const iframe = page.locator('iframe[data-testid="plugin-screen"]');
	await iframe.waitFor();
	check("the frame is sandboxed to scripts only", (await iframe.getAttribute("sandbox")) === "allow-scripts", `sandbox="${await iframe.getAttribute("sandbox")}"`);
	const frame: Frame = (await (await iframe.elementHandle())!.contentFrame())!;
	await frame.waitForFunction(() => document.getElementById("summary")?.textContent !== "", undefined, { timeout: 10_000 });
	const summary = await frame.locator("#summary").textContent();
	const items = await frame.locator("#list li").count();
	check("the screen ran the plugin's scan through window.reelix", !!summary, `${summary} (${items} listed)`);
	const bg = await frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
	const pageBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
	check("the theme tokens reached the frame", !!bg && bg === pageBg, `--bg ${bg}`);
	check("the language reached the frame", (await frame.evaluate(() => (window as unknown as { reelix: { lang: string } }).reelix.lang)) === (await page.evaluate(() => document.documentElement.lang || "en")));
	if (shot) await page.screenshot({ path: shot });

	// Escape attempts, run inside the frame with the frame's own rights.
	const inFrame = <T>(fn: () => T | Promise<T>) => frame.evaluate(fn as () => Promise<T>);
	const attempt = (fn: string) =>
		inFrame(new Function(`return (async () => { try { const v = await (${fn})(); return "allowed: " + String(v).slice(0, 80); } catch (e) { return "refused: " + (e && e.name) + " " + String(e && e.message).slice(0, 100); } })();`) as () => Promise<string>);
	const origin = new URL(base).origin;
	const tries: [string, string][] = [
		["read document.cookie", "() => document.cookie"],
		["read localStorage", "() => localStorage.length"],
		["read the page around it", "() => parent.document.title"],
		["read the page's location", "() => parent.location.href"],
		["fetch /api with the session", `() => fetch("${origin}/api/op/plugin.list", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.status)`],
		["fetch /api relative", `() => fetch("/api/session").then((r) => r.status)`],
		["XMLHttpRequest to /api", `() => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open("GET", "${origin}/api/status"); x.onload = () => res(x.status); x.onerror = () => rej(new Error("network error")); x.send(); })`],
		["open a pop-up", `() => { const w = window.open("${origin}/settings"); if (!w) throw new Error("window.open returned null"); return "opened"; }`],
		["navigate the page", `() => { top.location.href = "${origin}/settings?escaped=1"; return "navigated"; }`],

		["load an image from /api", `() => new Promise((res, rej) => { const i = new Image(); i.onload = () => res("loaded"); i.onerror = () => rej(new Error("image refused")); i.src = "${origin}/api/status"; })`],
		["run a core operation", `() => window.reelix.run("download.remove", { hash: "x" })`],
		["run another plugin's operation", `() => window.reelix.run("jackett.indexers", {})`],
		["run a dotted name", `() => window.reelix.run("../plugin.disable", { id: "jackett" })`],
	];
	const before = page.url();
	for (const [name, fn] of tries) {
		const r = await attempt(fn);
		check(`frame cannot ${name}`, r.startsWith("refused"), r);
	}
	// A form's submit() does not throw in a sandbox without allow-forms; it is dropped, so nothing must arrive.
	await inFrame(() => {
		const f = document.createElement("form");
		f.method = "POST";
		f.action = "/api/op/plugin.enable";
		document.body.append(f);
		f.submit();
	});
	await page.waitForTimeout(500);
	check("the page was not navigated", page.url() === before, page.url());
	check("no pop-up opened", page.context().pages().length === 1);
	check("nothing the frame sent to /api was answered (no form, fetch, XHR or image got through)", answeredToScreen.length === 0, answeredToScreen.join(", ") || `refused by the browser: ${refused.filter((r) => r.includes("/api/")).length}`);

	// Its own operations work: proposing asks the owner, it removes nothing.
	const propose = frame.locator("#propose");
	if (await propose.isEnabled()) {
		await propose.click();
		await frame.waitForFunction(() => document.getElementById("note")?.textContent !== "", undefined, { timeout: 10_000 });
		check("the screen's own write operation ran (a proposal for the owner)", true, (await frame.locator("#note").textContent()) ?? "");
	} else check("nothing to propose in this demo", true);

	// The frame navigating itself to another site (a link the screen shows): that site gets no bridge. It says
	// "ready" and asks to run the plugin's operation, and reports by a picture request what reached it.
	const reports: string[] = [];
	const outside = createServer((req, res) => {
		if (req.url?.startsWith("/report?")) reports.push(decodeURIComponent(req.url.slice(8)));
		res.writeHead(200, { "content-type": "text/html" }).end(`<script>
			const report = (what) => { new Image().src = "/report?" + encodeURIComponent(what); };
			addEventListener("message", (e) => report("got " + JSON.stringify(e.data) + " ports " + e.ports.length));
			report("loaded, origin " + origin);
			for (let i = 0; i < 5; i++) setTimeout(() => {
				parent.postMessage({ reelix: 1, type: "ready" }, "*");
				parent.postMessage({ reelix: 1, type: "run", id: 99, operation: "scan", input: {} }, "*");
			}, i * 100);
		</script>`);
	});
	await new Promise<void>((r) => outside.listen(0, "127.0.0.1", r));
	const outsideUrl = `http://127.0.0.1:${(outside.address() as AddressInfo).port}/`;
	const runs: string[] = [];
	page.on("request", (r) => {
		if (r.method() === "POST" && r.url().includes("/api/plugin-screens/")) runs.push(r.url());
	});
	await frame.evaluate((u) => void (location.href = u), outsideUrl).catch(() => undefined);
	await page.waitForTimeout(2000);
	outside.close();
	check("the frame reached the other site (the test did navigate it)", reports.some((r) => r.startsWith("loaded")), reports.join(" | "));
	check("the other site got nothing from the page: no port, no context, no result", !reports.some((r) => r.startsWith("got")), reports.join(" | "));
	check("the page ran nothing for the other site", runs.length === 0, runs.join(", "));

	// The frame navigating itself to the API: allowed by the sandbox, but the session cookie does not go with it.
	const response = page.waitForResponse((r) => r.url().endsWith("/api/plugin-screens/finished-cleanup?lang=en") || r.url().endsWith("/api/status"), { timeout: 5_000 }).catch(() => undefined);
	await frame.evaluate((o) => void (location.href = `${o}/api/status`), origin).catch(() => undefined);
	const r = await response;
	check("the frame navigating itself to /api is refused (the browser sends the owner's cookie there, so Reelix refuses API documents in frames)", r?.status() === 403, r ? `${r.url()} → ${r.status()}` : "no response");
} catch (e) {
	check("the run itself", false, e instanceof Error ? e.message : String(e));
} finally {
	await b.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
