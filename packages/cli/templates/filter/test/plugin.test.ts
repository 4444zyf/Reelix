import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { HookRelease } from "@reelix/plugin";
import { checkPluginFolder, startPlugins } from "@reelix/plugin-testing";

const PLUGIN = join(import.meta.dirname, "..");
const release = (ref: string, title: string): HookRelease => ({ ref, title, site: "s", siteName: "Site", hasMagnet: false });

test("reelix plugin check passes", async () => {
	const r = await checkPluginFolder(PLUGIN);
	assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test("a release whose name has a listed word is hidden, with the word as the reason", async () => {
	const t = await startPlugins([PLUGIN], { settings: { "block-words": { words: ["CAM"] } } });
	try {
		const got = await t.hook("release.filter@1", { releases: [release("a", "Film.2024.1080p.CAM.x264-GRP"), release("b", "Film.2024.1080p.WEB-DL.x264-GRP")] });
		assert.deepEqual(got, [{ plugin: "block-words", item: [{ ref: "a", reason: 'The name contains "CAM"' }] }]);
	} finally {
		await t.close();
	}
});
