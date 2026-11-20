import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { HookRelease } from "@reelix/plugin";
import { checkPluginFolder, startPlugins } from "@reelix/plugin-testing";

const PLUGIN = join(import.meta.dirname, "..");
const release = (ref: string, downloadFactor: number): HookRelease => ({ ref, title: `Film.2024.1080p.WEB-DL.x264-${ref}`, site: "s", siteName: "Site", hasMagnet: false, downloadFactor });

test("reelix plugin check passes", async () => {
	const r = await checkPluginFolder(PLUGIN);
	assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test("freeleech comes first, with a note; nothing is added or removed", async () => {
	const t = await startPlugins([PLUGIN]);
	try {
		const [got] = await t.hook("release.rank@1", { releases: [release("paid", 1), release("free", 0)] });
		assert.deepEqual(got!.item.order, ["free", "paid"]);
		assert.deepEqual(got!.item.notes?.map((n) => n.ref), ["free"]);
		assert.deepEqual(await t.hook("release.rank@1", { releases: [release("paid", 1)] }), [], "no opinion when nothing is freeleech");
	} finally {
		await t.close();
	}
});
