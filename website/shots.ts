/**
 * Takes the site's screenshots from a running demo Reelix (scripts/demo.ts), into website/assets/shots/*.webp.
 *
 *   SHOTS_URL=http://127.0.0.1:7993 SHOTS_PASSWORD=… node --no-warnings website/shots.ts [chat trends title downloads inbox plugins paper]
 *
 * "chat" reuses a conversation that is already there.
 * With no names, every shot is taken, in an order that makes sense on a fresh demo: the chat asks the agent
 * for a film (this spends model tokens), which starts the download the other screens show.
 * The demo's TMDB has no pictures, so posters are drawn here (a gradient and the title) and never reach the product.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";

const url = (process.env.SHOTS_URL ?? "http://127.0.0.1:7878").replace(/\/+$/, "");
const password = process.env.SHOTS_PASSWORD ?? "";
const out = join(dirname(fileURLToPath(import.meta.url)), "assets", "shots");
const ASK = "Get me Sintel, the 2010 Blender film.";
const ALL = ["chat", "trends", "title", "downloads", "inbox", "plugins", "paper"];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

/** Poster art by TMDB id: the demo's four titles; anything else gets a neutral card. */
const ART: Record<string, { title: string; sub: string; a: string; b: string; ink: string }> = {
	"45745": { title: "SINTEL", sub: "2010", a: "#1d3a4a", b: "#c7772e", ink: "#fbead0" },
	"872585": { title: "OPPEN­HEIMER", sub: "2023", a: "#2b0f08", b: "#e0662a", ink: "#ffe9c9" },
	"95396": { title: "SEVERANCE", sub: "2022", a: "#0d2b33", b: "#7fb7b0", ink: "#eef7f4" },
	"209867": { title: "FRIEREN", sub: "Beyond Journey's End", a: "#27406b", b: "#c9b8e8", ink: "#f6f2ff" },
};

async function art(id: string, wide: boolean): Promise<Buffer> {
	const a = ART[id] ?? { title: "", sub: "", a: "#2a2219", b: "#5a4630", ink: "#efe7dc" };
	const [w, h] = wide ? [1280, 720] : [684, 1026];
	const words = a.title.split("­");
	const size = wide ? 110 : Math.min(96, Math.floor(600 / Math.max(...words.map((x) => x.length)) / 0.74));
	// The UI writes the title over the foot of a poster, so the art's own lettering sits at the head.
	const top = h * (wide ? 0.55 : 0.15);
	const lines = words.map((x, i) => `<text x="${w / 2}" y="${top + i * size * 1.02}" font-family="Fraunces, Georgia, serif" font-weight="700" font-size="${size}" letter-spacing="4" text-anchor="middle" fill="${a.ink}">${x}</text>`).join("");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="${a.a}"/><stop offset="1" stop-color="#0c0a08"/></linearGradient>
<radialGradient id="s" cx="0.66" cy="0.46" r="0.55"><stop offset="0" stop-color="${a.b}" stop-opacity="0.95"/><stop offset="0.45" stop-color="${a.b}" stop-opacity="0.35"/><stop offset="1" stop-color="${a.b}" stop-opacity="0"/></radialGradient>
<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.7"/></linearGradient>
</defs>
<rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#s)"/>
<circle cx="${w * 0.66}" cy="${h * 0.46}" r="${Math.min(w, h) * 0.17}" fill="${a.b}" opacity="0.9"/>
<path d="M0 ${h * 0.68} L${w * 0.25} ${h * 0.55} L${w * 0.45} ${h * 0.64} L${w * 0.7} ${h * 0.52} L${w} ${h * 0.66} L${w} ${h} L0 ${h} Z" fill="#0c0a08" opacity="0.55"/>
<rect width="100%" height="100%" fill="url(#f)"/>
${lines}
<text x="${w / 2}" y="${top + words.length * size * 1.02 - size * 0.45}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="28" letter-spacing="6" text-anchor="middle" fill="${a.ink}" opacity="0.75">${a.sub.toUpperCase().replace(/&/g, "&amp;").replace(/'/g, "&#39;")}</text>
</svg>`;
	return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "en-US" });
await context.addInitScript(() => {
	localStorage.setItem("reelix.lang", "en");
	if (!localStorage.getItem("reelix.theme")) localStorage.setItem("reelix.theme", "marquee");
});
await context.route("**/api/poster*", async (route) => {
	const q = new URL(route.request().url()).searchParams;
	const id = (q.get("path") ?? "").replace(/\D/g, "");
	const wide = /^w(780|1280)$|^original$/.test(q.get("size") ?? "");
	await route.fulfill({ contentType: "image/jpeg", body: await art(id, wide) });
});
const page = await context.newPage();

async function save(name: string): Promise<void> {
	await page.waitForLoadState("networkidle").catch(() => {});
	await page.waitForTimeout(600);
	mkdirSync(out, { recursive: true });
	await sharp(await page.screenshot({ type: "png" })).webp({ quality: 82 }).toFile(join(out, `${name}.webp`));
	console.log(`${name}.webp`);
}

async function go(path: string): Promise<void> {
	await page.goto(url + path, { waitUntil: "networkidle" });
}

async function setTheme(page: Page, theme: string): Promise<void> {
	await page.evaluate((t) => localStorage.setItem("reelix.theme", t), theme);
}

await go("/");
if (await page.locator("#pw").count()) {
	await page.fill("#pw", password);
	await page.keyboard.press("Enter");
	await page.waitForURL(/\/chat/);
}

const shots: Record<string, () => Promise<void>> = {
	/** Asks the agent for Sintel and waits for it to finish; this is what starts the demo's download. */
	async chat() {
		await go("/chat");
		// The oldest conversation that asked this is the one where the agent searched and downloaded.
		const earlier = page.getByRole("button", { name: ASK.slice(0, 16) }).last();
		await earlier.waitFor({ timeout: 5000 }).catch(() => {});
		if (await earlier.count()) await earlier.click();
		else {
			const box = page.locator("textarea").first();
			await box.fill(ASK);
			await box.press("Enter");
			await page.waitForURL(/\/chat\/.+/, { timeout: 30_000 });
			// The Stop button is there while the agent works.
			const stop = page.locator('button[title="Stop"]');
			await stop.waitFor({ timeout: 30_000 }).catch(() => {});
			await stop.waitFor({ state: "detached", timeout: 300_000 });
		}
		// The start of the conversation: the request, the agent's steps, the title it found.
		await page.evaluate(() => {
			for (const el of document.querySelectorAll("main *")) if (el.scrollHeight > el.clientHeight + 50 && getComputedStyle(el).overflowY !== "visible") el.scrollTop = 0;
		});
		await save("chat");
	},
	async trends() {
		await go("/trends");
		// "For you" is picked by the model; wait for its spinner to go.
		await page.locator(".animate-spin").first().waitFor({ state: "detached", timeout: 120_000 }).catch(() => {});
		await save("trends");
	},
	async title() {
		await go("/library");
		await page.locator('a[href^="/library/"]:not([href="/library/adopt"])').first().click();
		await save("title");
	},
	async downloads() {
		// Start one from Trends so the shot shows a download part-way (the demo's finish in about 30 s).
		await go("/trends");
		await page.getByText("Oppenheimer", { exact: true }).first().click();
		await page.getByRole("button", { name: "Download", exact: true }).first().click();
		await page.waitForTimeout(10_000);
		await go("/downloads");
		await save("downloads");
	},
	async inbox() {
		await go("/inbox");
		await save("inbox");
	},
	async plugins() {
		await go("/settings");
		await page.locator("#plugins").evaluate((el) => el.scrollIntoView({ block: "start" }));
		await save("plugins");
	},
	async paper() {
		await setTheme(page, "paper");
		await go("/library");
		await save("paper");
		await setTheme(page, "marquee");
	},
};

for (const name of wanted) {
	const shot = shots[name];
	if (!shot) throw new Error(`Unknown shot "${name}". Known: ${ALL.join(", ")}`);
	await shot();
}
await browser.close();
