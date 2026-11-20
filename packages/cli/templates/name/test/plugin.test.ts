import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { checkPluginFolder, startPlugins } from "@reelix/plugin-testing";

const PLUGIN = join(import.meta.dirname, "..");
const FOLDER = "Film (2024) [tmdbid-1]";
const TITLE = { id: "movie:1", name: "Film", kind: "movie" as const, mediaClass: "movie", year: 2024, tmdbId: 1 };

test("reelix plugin check passes", async () => {
	const r = await checkPluginFolder(PLUGIN);
	assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test("the resolution is added to the video's name, and its subtitle moves with it", async () => {
	const t = await startPlugins([PLUGIN]);
	try {
		const [got] = await t.hook("organise.name@1", {
			title: TITLE,
			items: [
				{ source: "/downloads/Film.2024.1080p.mkv", path: `${FOLDER}/${FOLDER}.mkv`, kind: "video", parsed: { resolution: "1080p" } },
				{ source: "/downloads/Film.2024.1080p.en.srt", path: `${FOLDER}/${FOLDER}.en.srt`, kind: "subtitle", parsed: {} },
			],
		});
		assert.deepEqual(got!.item.items.map((i) => i.path), [`${FOLDER}/${FOLDER} - 1080p.mkv`, `${FOLDER}/${FOLDER} - 1080p.en.srt`]);
	} finally {
		await t.close();
	}
});
