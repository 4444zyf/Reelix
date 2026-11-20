import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { offered, releaseWorld } from "../../../../packages/core/test/fakes/release-world.ts";

process.chdir(tmpdir());

const titles = (list: any[]) => list.map((r) => r.title);
const A = "Sintel.2010.1080p.BluRay.x264-AAA";
const B = "Sintel.2010.720p.BluRay.x264-BBB";
const FREE = "Sintel.2010.2160p.WEB-DL.x265-FREE";
const results = [offered(A, 90), offered(B, 40), offered(FREE, 5, { freeleech: true })];

test("freeleech comes first, with a note and a recorded reason; nothing is added or removed", async () => {
	const w = await releaseWorld({ examples: ["prefer-freeleech"], results });
	try {
		const r = await w.run("release.search", { query: "Sintel" });
		const o = r.output as any;
		assert.deepEqual(titles(o.releases), [FREE, A, B]);
		assert.match(o.releases[0].notes[0].note, /Freeleech/);
		assert.match(r.text, /note from prefer-freeleech: Freeleech/, "the agent reads the note as a fact");
		assert.match((await w.run("release.why", { handle: o.releases[0].handle })).text, /moved from place 3 to 1 by prefer-freeleech: Freeleech releases come first/);
		const bySeeders = (await w.run("release.search", { query: "Sintel", sort: "seeders" })).output as any;
		assert.deepEqual(titles(bySeeders.releases), [FREE, A, B], "seeders is the normal order: asking for it does not get around the plugin");
		const byDate = (await w.run("release.search", { query: "Sintel", sort: "date" })).output as any;
		assert.equal(byDate.releases[0].notes, undefined, "a sort by date or size is kept as asked");
	} finally {
		await w.close();
	}
});

test("without a ranking plugin the order stays best seeded first", async () => {
	const w = await releaseWorld({ results });
	try {
		assert.deepEqual(titles(((await w.run("release.search", { query: "Sintel" })).output as any).releases), [A, B, FREE]);
	} finally {
		await w.close();
	}
});

test("a follow's quick accept takes the first match in ranked order", async () => {
	const E1 = "Severance.S01E01.1080p.WEB-DL.x264-AAA";
	const FREE_E1 = "Severance.S01E01.1080p.WEB-DL.x265-FREE";
	const w = await releaseWorld({ examples: ["prefer-freeleech"], results: [offered(E1, 90), offered(FREE_E1, 3, { freeleech: true })] });
	try {
		await w.run("title.find", { id: "tv:95396" }, "owner:test");
		await w.run("follow.add", { title_id: "tv:95396", season: 1, instruction: "1080p", quick_accept: "1080p, WEB-DL" }, "owner:test");
		const out = (await w.run("follow.check", {}, "owner:test")).output as any[];
		assert.deepEqual(out.find((o) => o.episode === 1), { follow: out[0].follow, season: 1, episode: 1, result: "grabbed", detail: FREE_E1 });
	} finally {
		await w.close();
	}
});
