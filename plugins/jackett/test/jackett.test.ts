import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { doctor, fetchRelease, getHandle, indexerHealth, runOperation, searchReleases } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { magnetHash } from "../src/client.ts";
import check, { KEY } from "./check.ts";
import { startFakeJackett } from "./fake-jackett.ts";

const PLUGIN = join(import.meta.dirname, "..");
const SEAM = "reelix:indexer@1";
const start = () => startPlugins([PLUGIN], { settings: { jackett: check.settings }, secrets: { "plugins.jackett.api_key": KEY }, http: check.http });

test("one broken site does not hide the others", async () => {
	const t = await start();
	try {
		const r = await t.app.seams.provider(SEAM, "jackett")!.call("search", [{ queries: ["Sintel"], sites: ["alpha", "beta"] }]);
		assert.deepEqual(r.sites.map((s) => [s.site, s.ok, s.outcome]), [["alpha", true, undefined], ["beta", false, { outcome: "unavailable", message: "Cloudflare" }]]);
	} finally {
		await t.close();
	}
});

test("handles record their provider and never show the link; fetching goes back to that provider", async () => {
	const t = await start();
	try {
		const s = await searchReleases(t.app, { query: "Sintel" });
		assert.equal(s.total, 1);
		const [release] = s.releases;
		assert.equal(release!.indexer, "Alpha & Co");
		assert.equal(release!.freeleech, true);
		assert.ok(!JSON.stringify(s).includes(KEY), "the key stays out of what the model sees");
		const h = getHandle(t.app, release!.handle);
		assert.equal(h.provider, "jackett");
		assert.deepEqual(await fetchRelease(t.app, { ...h, ref: JSON.stringify({ link: null, magnet: "magnet:?xt=urn:btih:ABC" }) }).then((f) => f.magnet), "magnet:?xt=urn:btih:ABC");
		await t.manager.disable("jackett");
		await assert.rejects(fetchRelease(t.app, h), /not active now/);
	} finally {
		await t.close();
	}
});

test("the operation, the Doctor check and the nightly health all go through the plugin", async () => {
	const t = await start();
	try {
		const op = await runOperation(t.app, "jackett.indexers", { test: true }, { actor: "agent:t" });
		assert.match(op.text, /alpha \| Alpha & Co \| private \| ok/);
		assert.match(op.text, /beta \| Beta \|  \| ERROR Cloudflare/);
		const check = (await doctor(t.app, { quick: true })).find((c) => c.name === "jackett")!;
		assert.deepEqual([check.ok, check.detail], [true, "2 indexers: Alpha & Co, Beta"]);
		const full = (await doctor(t.app)).find((c) => c.name === "jackett")!;
		assert.equal(full.ok, true, "one site still answers");
		assert.match(full.detail, /Beta: ERROR Cloudflare/);
		assert.deepEqual((await indexerHealth(t.app)).filter((o) => !o.ok).map((o) => [o.name, o.error]), [["Beta", "Cloudflare"]]);
	} finally {
		await t.close();
	}
});

test("without a server set up: no provider, and the check says so", async () => {
	const t = await startPlugins([PLUGIN], {});
	try {
		assert.equal(t.info("jackett").state, "active");
		assert.equal(t.app.seams.providers(SEAM).length, 0);
		await assert.rejects(searchReleases(t.app, { query: "x" }), (e: any) => e.code === "no_indexers");
		assert.equal((await doctor(t.app, { quick: true })).find((c) => c.name === "jackett")!.detail, "not configured");
		assert.match((await runOperation(t.app, "jackett.indexers", {}, { actor: "agent:t" })).text, /No Jackett server/);
	} finally {
		await t.close();
	}
});

test("two servers are two providers; results merge by info-hash, keeping the best seeded", async () => {
	const release = (seeders: number) => ({ title: "Sintel.2010.1080p.BluRay.x264-GRP", size: 1000, seeders, peers: 1, category: [2040], infoHash: "a".repeat(40), magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}` });
	const one = await startFakeJackett({ apiKey: "k1", indexers: [{ id: "a", name: "A", results: [release(5)] }] });
	const two = await startFakeJackett({ apiKey: "k2", indexers: [{ id: "b", name: "B", results: [release(50)] }] });
	const t = await startPlugins([PLUGIN], { settings: { jackett: { servers: [{ url: one.url }, { url: two.url }] } }, secrets: { "plugins.jackett.api_key": "k1", "plugins.jackett.api_key_2": "k2" } });
	try {
		assert.deepEqual(t.app.seams.providers(SEAM).map((p) => p.id), ["jackett", "jackett-2"]);
		const s = await searchReleases(t.app, { query: "Sintel" });
		assert.equal(s.total, 1);
		assert.deepEqual([s.releases[0]!.seeders, s.releases[0]!.provider, s.releases[0]!.indexer], [50, "jackett-2", "B"]);
		assert.deepEqual(s.indexers.map((i) => i.name), ["A", "B"]);
	} finally {
		await t.close();
		await Promise.all([one.close(), two.close()]);
	}
});

test("magnet hashes in hex and base32", () => {
	assert.equal(magnetHash(`magnet:?xt=urn:btih:${"AB".repeat(20)}&dn=x`), "ab".repeat(20));
	assert.equal(magnetHash(`magnet:?xt=urn:btih:${"A".repeat(32)}`), "0".repeat(40));
	assert.equal(magnetHash("magnet:?dn=x"), undefined);
});
