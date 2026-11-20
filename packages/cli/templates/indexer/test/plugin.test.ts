import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { checkPluginFolder, startPlugins } from "@reelix/plugin-testing";
import check, { SEARCH } from "./check.ts";

const PLUGIN = join(import.meta.dirname, "..");
const SEAM = "reelix:indexer@1";
const KEY = { "plugins.example-indexer.api_key": check.secrets.api_key };

test("reelix plugin check passes", async () => {
	const r = await checkPluginFolder(PLUGIN);
	assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test("a search sends the owner's key and reports freeleech", async () => {
	const t = await startPlugins([PLUGIN], { secrets: KEY, http: check.http });
	try {
		const r = await t.app.seams.provider(SEAM, "example-indexer")!.call("search", [{ queries: ["Sintel"] }]);
		assert.equal(t.http.requests[0]!.url, SEARCH);
		assert.equal(t.http.requests[0]!.headers.authorization, `Bearer ${check.secrets.api_key}`);
		assert.deepEqual(r.hits.map((h) => [h.title, h.downloadFactor]), [["Sintel.2010.1080p.BluRay.x264-GRP", 0]]);
	} finally {
		await t.close();
	}
});

test("without a key the site says so, and nothing counts as a failure", async () => {
	const t = await startPlugins([PLUGIN], { http: check.http });
	try {
		const r = await t.app.seams.provider(SEAM, "example-indexer")!.call("search", [{ queries: ["Sintel"] }]);
		assert.deepEqual(r.sites.map((s) => s.outcome), [{ outcome: "needs_auth" }]);
		assert.equal(t.http.requests.length, 0);
		assert.equal(t.info("example-indexer").failures, 0);
	} finally {
		await t.close();
	}
});
