import { chromium } from "playwright-core";
import { findChromium } from "../../../plugins/browser/src/chromium.ts";
const base = "http://localhost:7979";
const b = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await b.newPage({ viewport: { width: 1360, height: 900 } });
await page.addInitScript(() => {
	const Orig = window.EventSource;
	(window as any).__ev = [];
	(window as any).EventSource = function (url: string, init: any) {
		const es = new Orig(url, init);
		(window as any).__ev.push("OPEN " + url);
		es.addEventListener("ui", (e: any) => (window as any).__ev.push(JSON.parse(e.data).type + "#" + JSON.parse(e.data).seq));
		es.addEventListener("error", () => (window as any).__ev.push("ERROR " + url));
		return es;
	} as any;
});
await page.goto(base);
await page.waitForTimeout(1000);
const pw = page.locator('input[type="password"]').first();
if (await pw.count()) { await pw.fill("testpass123"); await pw.press("Enter"); await page.waitForTimeout(1500); }
await page.goto(base + "/chat");
await page.waitForTimeout(1500);
await page.locator("textarea").first().fill("Say the word MANGO and nothing else.");
await page.locator("textarea").first().press("Enter");
await page.waitForTimeout(25000);
console.log((await page.evaluate(() => (window as any).__ev)).join(" | "));
const n = await page.getByText("MANGO", { exact: true }).count();
console.log("exact MANGO elements:", n, "url:", page.url());
await page.screenshot({ path: "/tmp/uishots/chat3.png" });
await b.close();
