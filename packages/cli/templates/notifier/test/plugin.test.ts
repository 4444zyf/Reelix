import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { checkPluginFolder, startPlugins } from "@reelix/plugin-testing";
import type { Notice } from "@reelix/plugin";
import check, { ADDRESS } from "./check.ts";

const PLUGIN = join(import.meta.dirname, "..");

const NOTICE: Notice = { inboxId: "in_1", kind: "question", title: "Which version?", answer: { kind: "choice", options: [{ id: "0", label: "1080p" }] }, path: "/inbox?item=in_1", urgent: true, badge: 1 };

test("reelix plugin check passes", async () => {
	const r = await checkPluginFolder(PLUGIN);
	assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test("a question for the owner is posted to the address, with the token", async () => {
	const t = await startPlugins([PLUGIN], { settings: { "example-notifier": check.settings }, secrets: { "plugins.example-notifier.token": "t0ken" }, http: check.http });
	try {
		await t.app.seams.provider("reelix:notifier@1", "example-notifier")!.call("send", [NOTICE]);
		const [sent] = t.http.requests;
		assert.equal(sent!.url, ADDRESS);
		assert.equal(sent!.headers.authorization, "Bearer t0ken");
		assert.deepEqual(JSON.parse(sent!.body!), { title: "Which version?", urgent: true, path: "/inbox?item=in_1" });
	} finally {
		await t.close();
	}
});

test("without an address it provides nothing", async () => {
	const t = await startPlugins([PLUGIN]);
	try {
		assert.equal(t.info("example-notifier").state, "active");
		assert.equal(t.app.seams.providers("reelix:notifier@1").length, 0);
	} finally {
		await t.close();
	}
});
