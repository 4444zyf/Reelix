import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { checkPluginFolder, startPlugins } from "@reelix/plugin-testing";
import check, { SEARCH } from "./check.ts";

const PLUGIN = join(import.meta.dirname, "..");
const SEAM = "reelix:subtitle.source@1";
const QUERY = check.seams[SEAM].query;

test("reelix plugin check passes", async () => {
	const r = await checkPluginFolder(PLUGIN);
	assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test("a search asks the site for the name, year and languages, and keeps the site's own reference", async () => {
	const t = await startPlugins([PLUGIN], { http: check.http });
	try {
		const hits = await t.app.seams.provider(SEAM, "example-subtitles")!.call("search", [QUERY]);
		assert.deepEqual(t.http.requests.map((r) => r.url), [SEARCH]);
		assert.deepEqual(hits, [{ ref: "101", name: "Sintel", languages: ["en"], language: "en", release: "Sintel.2010.1080p.BluRay.x264-GRP", downloads: 1200 }]);
	} finally {
		await t.close();
	}
});

test("too many requests is an outcome, not a failure", async () => {
	const t = await startPlugins([PLUGIN], { http: [{ url: SEARCH, status: 429 }] });
	try {
		assert.deepEqual(await t.app.seams.provider(SEAM, "example-subtitles")!.call("search", [QUERY]), { outcome: "rate_limited" });
		assert.equal(t.info("example-subtitles").failures, 0);
	} finally {
		await t.close();
	}
});
