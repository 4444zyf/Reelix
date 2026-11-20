import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startPlugins } from "@reelix/plugin-testing";
import { makeSessionCookie } from "../src/auth.ts";
import { webApp } from "../src/http.ts";
import { readManifest } from "../src/plugins/manifest.ts";
import { SCREEN_CSP } from "../src/plugins/screen.ts";

const CLEANUP = join(import.meta.dirname, "../../../plugins/examples/finished-cleanup");

function screenPlugin(root: string, screen: Record<string, unknown>) {
	const dir = join(root, "screeny");
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "ui"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "screeny", version: "1.0.0", type: "module", reelix: { api: 0, id: "screeny", entry: "./src/index.ts", runtime: "process", screen, uses: { operations: { look: "read", wipe: "destructive" } } } }));
	writeFileSync(join(dir, "src/index.ts"), `import { Type, definePlugin } from "@reelix/plugin";
export default definePlugin({ async activate(ctx) {
	await ctx.operation({ name: "look", summary: "Looks", effect: "read", input: Type.Object({}), async run() { return { seen: true }; } });
	await ctx.operation({ name: "wipe", summary: "Wipes", effect: "destructive", input: Type.Object({}), async run() { return { wiped: true }; } });
} });
`);
	writeFileSync(join(dir, "ui/index.html"), `<!doctype html><html><head><link rel="stylesheet" href="look.css"><script src="../src/index.ts"></script></head><body><p>hi</p><script src="look.js"></script><script src="https://cdn.example/x.js"></script></body></html>`);
	writeFileSync(join(dir, "ui/look.js"), `document.body.dataset.ok = "1"; const s = "</script>";`);
	writeFileSync(join(dir, "ui/look.css"), `p { color: var(--fg); }`);
	return dir;
}

test("a screen: one document with Reelix's CSP and bridge first, its own files inline; it runs only its plugin's operations, as the plugin", async () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-screen-"));
	const dir = screenPlugin(root, { entry: "./ui/index.html", title: "Screeny" });
	const t = await startPlugins([dir, CLEANUP]);
	try {
		await t.manager.enable("finished-cleanup");
		assert.equal(t.info("finished-cleanup").state, "active", t.info("finished-cleanup").error);
		assert.deepEqual(t.info("finished-cleanup").screen, { title: "Finished downloads" });
		t.app.setSecret("web.password_hash", "x");
		const cookie = makeSessionCookie(t.app, false).split(";")[0]!;
		const api = webApp({ app: t.app, host: {} as never, jobs: {} as never, routes: t.manager.routes });
		const req = (path: string, body?: unknown) =>
			api.request(`http://reelix.local${path}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { host: "reelix.local", origin: "http://reelix.local", cookie, "content-type": "application/json" } });

		const doc = (await (await req("/api/plugin-screens/screeny?lang=fr")).json()) as { title: string; html: string };
		assert.equal(doc.title, "Screeny");
		assert.ok(doc.html.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${SCREEN_CSP}">`), "the CSP comes before anything the plugin wrote");
		assert.match(SCREEN_CSP, /default-src 'none'/);
		assert.match(SCREEN_CSP, /connect-src 'none'/);
		assert.match(doc.html, /document\.documentElement\.lang = "fr"/);
		assert.match(doc.html, /Object\.defineProperty\(window, "reelix"/);
		assert.match(doc.html, /<style>p \{ color: var\(--fg\); \}<\/style>/, "its style sheet inline");
		assert.match(doc.html, /document\.body\.dataset\.ok = "1"; const s = "<\\\/script>";/, "its script inline, unable to close the tag");
		assert.match(doc.html, /<script src="\.\.\/src\/index\.ts"><\/script>/, "a file outside the screen's folder is not put inline");
		assert.match(doc.html, /<script src="https:\/\/cdn\.example\/x\.js"><\/script>/, "another site is left to the CSP, which refuses it");
		const cleanup = (await (await req("/api/plugin-screens/finished-cleanup")).json()) as { title: string; html: string };
		assert.match(cleanup.html, /window\.reelix\.run\("scan"\)/);

		// Its own operations, as the plugin: a destructive one needs the owner's approval like any plugin's.
		assert.deepEqual(await (await req("/api/plugin-screens/screeny/run", { operation: "look" })).json(), { output: { seen: true }, text: JSON.stringify({ seen: true }, null, 1) });
		const wipe = await req("/api/plugin-screens/screeny/run", { operation: "wipe" });
		assert.equal(((await wipe.json()) as { code: string }).code, "approval_required");
		for (const operation of ["download.remove", "finished-cleanup.scan", "../look", "config.set"]) {
			const r = await req("/api/plugin-screens/screeny/run", { operation });
			assert.equal(((await r.json()) as { code: string }).code, "unknown_operation", operation);
		}
		const proposed = (await (await req("/api/plugin-screens/finished-cleanup/run", { operation: "propose" })).json()) as { output: { proposed: number } };
		assert.equal(proposed.output.proposed, 0);
		const ledger = t.app.db.prepare("SELECT op, actor FROM actions WHERE op LIKE 'finished-cleanup.%' OR op LIKE 'screeny.%'").all().map((r) => ({ ...r }));
		assert.deepEqual(ledger, [{ op: "finished-cleanup.propose", actor: "plugin:finished-cleanup" }], "recorded as the plugin; the refused destructive one never ran");

		// The frame can navigate itself, and the browser sends the cookie with that: Reelix's API is never a document in a frame.
		const framed = await api.request("http://reelix.local/api/status", { headers: { host: "reelix.local", cookie, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" } });
		assert.equal(framed.status, 403);

		// No screen while the plugin is off; none without sign-in.
		await t.manager.disable("finished-cleanup");
		assert.equal((await req("/api/plugin-screens/finished-cleanup")).status, 404);
		assert.equal(((await (await req("/api/plugin-screens/finished-cleanup/run", { operation: "scan" })).json()) as { code: string }).code, "unknown_operation");
		assert.equal((await api.request("http://reelix.local/api/plugin-screens/screeny", { headers: { host: "reelix.local" } })).status, 401);
	} finally {
		await t.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a screen's manifest entry: an .html file inside the folder, with a short title", () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-screen-"));
	try {
		const refused = (screen: unknown, why: RegExp) => assert.throws(() => readManifest(screenPlugin(root, screen as never), new Set()), why);
		refused({ entry: "../outside.html", title: "x" }, /inside the plugin's folder/);
		refused({ entry: "ui/look.js", title: "x" }, /an \.html file/);
		refused({ entry: "ui/missing.html", title: "x" }, /does not exist/);
		refused({ entry: "ui/index.html", title: "" }, /title must be one line/);
		refused({ entry: "ui/index.html", title: "x", route: "/" }, /reelix\.screen must be/);
		assert.deepEqual(readManifest(screenPlugin(root, { entry: "./ui/index.html", title: "Ok" }), new Set()).screen, { entry: "ui/index.html", title: "Ok" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
