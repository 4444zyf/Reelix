import { chromium } from "playwright-core";
import { findChromium } from "../../../plugins/browser/src/chromium.ts";
const base = "http://localhost:7979";
const b = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await b.newPage({ viewport: { width: 1360, height: 900 } });
await page.goto(base);
await page.waitForTimeout(1000);
const pw = page.locator('input[type="password"]').first();
if (await pw.count()) { await pw.fill("testpass123"); await pw.press("Enter"); await page.waitForTimeout(1500); }
const opened = await page.evaluate(async () => (await fetch("/api/plugins/browser/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://subhd.me/" }) })).json());
console.log("opened", JSON.stringify(opened));
await page.goto(base + "/browser");
await page.waitForTimeout(6000);
const img = page.locator("img[src^='data:image']").first();
console.log("frame image shown:", await img.count());
await page.screenshot({ path: "/tmp/uishots/live1.png" });
if (await img.count()) {
	const box = (await img.boundingBox())!;
	await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
	await page.waitForTimeout(3000);
}
const tabs = await page.evaluate(async () => (await fetch("/api/plugins/browser/tabs")).json());
console.log("tabs after click:", JSON.stringify(tabs));
await page.screenshot({ path: "/tmp/uishots/live2.png" });
await b.close();
