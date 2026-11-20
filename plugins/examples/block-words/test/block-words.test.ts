import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { approvalRequest, createApproval, getHandle, hiddenApprovalInput } from "@reelix/core";
import { offered, releaseWorld } from "../../../../packages/core/test/fakes/release-world.ts";

process.chdir(tmpdir()); // never run a binary from .tools/

const GOOD = "Sintel.2010.1080p.BluRay.x264-GRP";
const CAM = "Sintel.2010.1080p.CAM.x264-NOPE";
const results = [offered(GOOD, 40), offered(CAM, 300)];
const world = () => releaseWorld({ examples: ["block-words"], results });
const search = async (w: Awaited<ReturnType<typeof world>>) => (await w.run("release.search", { query: "Sintel" })).output as any;

test("a hidden release stays in the result, marked and stored; the page and the agent's text say so", async () => {
	const w = await world();
	try {
		const r = await w.run("release.search", { query: "Sintel" });
		const o = r.output as any;
		assert.deepEqual(o.releases.map((x: any) => x.title), [GOOD], "the page has only what is not hidden");
		assert.equal(o.total, 1);
		assert.deepEqual(o.all.map((x: any) => x.title), [GOOD, CAM], "the owner's list keeps it, last");
		assert.deepEqual(o.hidden[0].hidden, [{ plugin: "block-words", reason: 'The name contains "CAM"' }]);
		assert.deepEqual(getHandle(w.app, o.hidden[0].handle).hidden, o.hidden[0].hidden, "the mark is stored with the handle");
		assert.match(r.text, /Hidden by plugins \(1;[^\n]*\n.*CAM.*HIDDEN by block-words: The name contains "CAM"/);

		const why = await w.run("release.why", { handle: o.hidden[0].handle });
		assert.match(why.text, /hidden by block-words: The name contains "CAM"/);
		assert.match(why.text, /Alpha: 2 found/);
		assert.match(why.text, /Flaky: .*Cloudflare/, "provider outcomes are in the same record");
		assert.match((await w.run("release.why", { handle: o.releases[0].handle })).text, /No plugin hid, moved or noted it/);
	} finally {
		await w.close();
	}
});

test("download.add refuses a hidden release unless the owner decided; the agent needs the owner's approval of that release", async () => {
	const w = await world();
	try {
		const { handle } = (await search(w)).hidden[0];
		const refused = (e: any) => e.code === "release_hidden" && /block-words: The name contains/.test(e.message);
		await assert.rejects(w.run("download.add", { handle }), refused, "the agent, plainly");
		await assert.rejects(w.run("download.add", { handle, allow_hidden: true }), refused, "the agent cannot just say so");
		await assert.rejects(w.run("download.add", { handle, allow_hidden: true }, "job:1"), refused, "nor a job");
		await assert.rejects(w.run("download.add", { handle, allow_hidden: true }, "plugin:x"), refused, "nor a plugin");
		await assert.rejects(w.run("download.add", { handle }, "owner:web"), refused, "the owner has to choose it too");
		assert.equal(w.qb.torrents.size, 0);

		// The owner approved this release for this agent: one use.
		createApproval(w.app, { ...approvalRequest("download.add", hiddenApprovalInput(handle), "agent:test", new Date(Date.now() + 60_000).toISOString()), approvedBy: "owner:web" });
		assert.match((await w.run("download.add", { handle, allow_hidden: true })).text, /Added and started/);
		await assert.rejects(w.run("download.add", { handle, allow_hidden: true }, "agent:other"), refused, "the approval was for one actor");
		assert.equal(w.qb.torrents.size, 1);
	} finally {
		await w.close();
	}
});

test("the owner's own choice is enough, and a plugin switched off hides nothing any more", async () => {
	const w = await world();
	try {
		const { handle } = (await search(w)).hidden[0];
		assert.match((await w.run("download.add", { handle, allow_hidden: true }, "owner:web")).text, /Added and started/);
		const good = (await search(w)).releases[0].handle;
		await w.t.manager.enable("block-words");
		await w.t.manager.disable("block-words");
		const other = (await w.run("release.why", { handle })).output as any;
		assert.equal(other.hidden, false);
		assert.match((await w.run("download.add", { handle: good })).text, /Added and started/);
		const after = await search(w);
		assert.equal(after.hidden.length, 0, "a new search no longer marks it");
		assert.equal(getHandle(w.app, handle).hidden, undefined, "and the stored mark is gone");
	} finally {
		await w.close();
	}
});

test("the word list comes from the plugin's settings and matches whole words", async () => {
	const w = await releaseWorld({ examples: ["block-words"], settings: { "block-words": { words: ["x264"] } }, results: [offered("Sintel.2010.1080p.x264-GRP", 5), offered("Sintel.2010.1080p.x2644-GRP", 4), offered(CAM.replace("x264", "x265"), 3)] });
	try {
		assert.deepEqual((await search(w)).hidden.map((r: any) => r.title), ["Sintel.2010.1080p.x264-GRP"]);
	} finally {
		await w.close();
	}
});
