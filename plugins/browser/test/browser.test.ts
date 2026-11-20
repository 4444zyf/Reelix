import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startPlugins } from "@reelix/plugin-testing";
import { findChromium } from "../src/chromium.ts";

const DIR = new URL("..", import.meta.url).pathname;

/** Chromium processes using this profile folder. */
const chromiumsOf = (profile: string) => execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(profile) && !l.startsWith("ps ")).length;

test("the browser: tools in a session, the live view's routes and stream, the tab released at session end, Chromium closed when the plugin stops", { skip: !findChromium() && "no Chromium on this machine" }, async () => {
	const page = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<title>Local page</title><h1>Hello from a test page</h1><a href='/next'>Next</a>"));
	await new Promise<void>((r) => page.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(page.address() as any).port}/`;
	const t = await startPlugins([DIR], { settings: { browser: { chromium: findChromium() } } });
	const cwd = mkdtempSync(join(tmpdir(), "reelix-browser-cwd-"));
	const profile = join(t.app.paths.pluginData, "browser", "chromium-profile");
	try {
		assert.equal(t.info("browser").state, "active");
		const s = await t.piSession({ threadId: "t_chat", kind: "chat", cwd });
		assert.deepEqual(s.tools, ["browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_wait", "browser_screenshot", "browser_download", "browser_eval", "browser_wait_for_answer", "browser_close"]);
		const opened = await s.call("browser_open", { url });
		assert.match(opened.content[0]!.text!, /Title: Local page[\s\S]*\[1\] a "Next" -> \/next[\s\S]*Hello from a test page/);
		assert.match(s.notices[0]!, /Browser \(tab1\) at http:\/\/127\.0\.0\.1/);
		const shot = await s.call("browser_screenshot");
		assert.ok(existsSync(shot.details.path) && shot.details.path.startsWith(join(cwd, "screenshots")), "files land in the session's folder");
		assert.ok(existsSync(profile), "the profile is in the plugin's own folder");

		const tabs = await (await t.route("browser", "GET", "/tabs")).json();
		assert.deepEqual(tabs.map((x: any) => [x.id, x.owner, x.url]), [["tab1", "t_chat", url]]);
		// The live view: a stream of frames, never a page.
		const ctrl = new AbortController();
		const res = await t.route("browser", "GET", "/tab1/stream", undefined, ctrl.signal);
		assert.match(res.headers.get("content-type")!, /^text\/event-stream/);
		assert.equal(res.headers.get("x-content-type-options"), "nosniff");
		const reader = res.body!.getReader();
		let got = "";
		while (!/event: frame\ndata: /.test(got)) got += new TextDecoder().decode((await reader.read()).value);
		assert.match(got, /"url":"http:\/\/127\.0\.0\.1/);
		ctrl.abort();
		await reader.cancel().catch(() => {});
		const input = await (await t.route("browser", "POST", "/tab1/input", { type: "goto", url: `${url}next` })).json();
		assert.equal(input.url, `${url}next`);
		assert.equal((await t.route("browser", "GET", "/nope/stream")).status, 400, "an unknown tab is refused");
		assert.equal((await t.route("browser", "GET", "/missing")).status, 404);

		// The session ends: its tab goes.
		t.app.pluginEvents.emit("session.ended", { threadId: "t_chat", kind: "chat" });
		for (let i = 0; i < 50 && (await (await t.route("browser", "GET", "/tabs")).json()).length; i++) await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(await (await t.route("browser", "GET", "/tabs")).json(), []);
		assert.ok(chromiumsOf(profile) > 0, "Chromium still runs until it is idle");
		assert.equal(t.info("browser").failures, 0);
	} finally {
		await t.close();
		page.close();
	}
	for (let i = 0; i < 100 && chromiumsOf(profile) > 0; i++) await new Promise((r) => setTimeout(r, 50));
	assert.equal(chromiumsOf(profile), 0, "Chromium closed when the plugin stopped");
	rmSync(cwd, { recursive: true, force: true });
});
