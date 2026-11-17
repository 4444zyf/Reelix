/** Real-browser pass over the web UI (run against a running server). */
import { chromium } from "playwright-core";
import { findChromium } from "../src/browser.ts";
const base = process.env.REELIX_URL ?? "http://localhost:7979";
const pw = process.env.REELIX_PASSWORD ?? "testpass123";
const out = process.env.SHOTS ?? "/tmp/uishots";
const b = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await b.newPage({ viewport: { width: 1360, height: 900 } });
const errors: string[] = [];
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("response", (r) => r.status() >= 400 && r.url().includes("/api/") && errors.push(`${r.status()} ${r.url()}`));
const log = (s: string) => console.log(s);
await page.goto(base);
await page.waitForTimeout(1500);
const pwField = page.locator('input[type="password"]').first();
await pwField.fill(pw);
await pwField.press("Enter");
await page.waitForTimeout(2000);
await page.screenshot({ path: `${out}/0-home.png` });
for (const [name, path] of [["library", "/library"], ["search", "/search"], ["downloads", "/downloads"], ["inbox", "/inbox"], ["activity", "/activity"], ["settings", "/settings"], ["browser", "/browser"]]) {
	await page.goto(base + path);
	await page.waitForTimeout(1800);
	const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160);
	await page.screenshot({ path: `${out}/${name}.png` });
	log(`${name}: ${text}`);
}
// (chat streaming is checked by ui-chat.e2e.ts)
// phone layout
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(base + "/library");
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/phone.png` });
log(`errors (${errors.length}):\n${[...new Set(errors)].slice(0, 20).join("\n")}`);
await b.close();
