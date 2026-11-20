import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Notice } from "@reelix/plugin";
import { checkPluginFolder, startPlugins } from "@reelix/plugin-testing";

const PLUGIN = join(import.meta.dirname, "..");
const notice = (body: string): Notice => ({ inboxId: "in_1", kind: "notice", title: "Filed", body, answer: { kind: "none", options: [] }, path: "/inbox?item=in_1", urgent: false, badge: 1 });

test("reelix plugin check passes", async () => {
	const r = await checkPluginFolder(PLUGIN);
	assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test("a long body is shortened to the length in the settings; a short one is left alone", async () => {
	const t = await startPlugins([PLUGIN], { settings: { "short-notices": { max_body: 20 } } });
	try {
		const [got] = await t.hook("notify.before@1", notice("A body that is much longer than twenty characters."));
		assert.equal(got!.item.body, "A body that is much…");
		assert.deepEqual(await t.hook("notify.before@1", notice("Short.")), []);
	} finally {
		await t.close();
	}
});
