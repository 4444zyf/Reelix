import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listInbox, runOperation } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { offered, releaseWorld } from "../../../../packages/core/test/fakes/release-world.ts";

process.chdir(tmpdir()); // never run a binary from .tools/

const EXAMPLES = join(import.meta.dirname, "../..");
const DV = "Sintel.2010.2160p.UHD.BluRay.DV.HDR10.HEVC-GRP";
const PLAIN = "Sintel.2010.1080p.BluRay.x264-GRP";
const trio = ["release-tags", "tag-hdr", "hdr-alert"];
const world = () => releaseWorld({ examples: trio, results: [offered(PLAIN, 40), offered(DV, 30)] });

const until = async (what: string, ok: () => boolean) => {
	for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
	assert.ok(ok(), what);
};

/** A plugin of a test's own, in a new folder: its manifest's `reelix` key and its entry's code. */
function plugin(base: string, reelix: Record<string, unknown>, code = "export default definePlugin({ async activate() {} });", version = "0.1.0"): string {
	const dir = join(base, String(reelix.id));
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `t-${reelix.id}`, version, type: "module", reelix: { api: 0, entry: "./src/index.ts", runtime: "in-process", ...reelix } }));
	writeFileSync(join(dir, "src/index.ts"), `import { definePlugin } from "@reelix/plugin";\n${code}\n`);
	return dir;
}

test("a search: tag-hdr tags through the seam release-tags owns, release-tags notes the tags and emits its event, hdr-alert tells the owner once", async () => {
	const w = await world();
	try {
		await w.run("title.find", { query: "Sintel (2010)" });
		const search = async () => (await w.run("release.search", { title_id: "movie:45745" })) as { output: any; text: string };
		const r = await search();
		const dv = r.output.releases.find((x: any) => x.title === DV);
		assert.deepEqual(dv.notes, [{ plugin: "release-tags", note: "Tags: Dolby Vision, HDR10" }]);
		assert.equal(r.output.releases.find((x: any) => x.title === PLAIN).notes, undefined);
		assert.deepEqual(r.output.releases.map((x: any) => x.title), [PLAIN, DV], "the order is untouched");
		assert.match(r.text, /note from release-tags: Tags: Dolby Vision, HDR10/);

		const alerts = () => listInbox(w.app, { status: "open" }).filter((i) => i.source === "plugin:hdr-alert");
		await until("hdr-alert put the release in the Inbox", () => alerts().length === 1);
		assert.equal(alerts()[0]!.title, "An HDR release of Sintel turned up");
		assert.match(alerts()[0]!.body ?? "", /DV\.HDR10.*\(Dolby Vision, HDR10\)/);
		await search();
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(listInbox(w.app, {}).filter((i) => i.source === "plugin:hdr-alert").length, 1, "once per title");

		const catalogue = (await w.run("plugin.inspect", {})).output as any;
		const seam = catalogue.pluginSeams.find((s: any) => s.id === "release-tags:tagger@1");
		assert.equal(seam.owner, "release-tags");
		assert.deepEqual(seam.methods.map((m: any) => [m.name, m.limitMs]), [["tag", 5000]]);
		assert.deepEqual(seam.providers.map((p: any) => [p.id, p.plugin]), [["hdr", "tag-hdr"]]);
		const event = catalogue.pluginEvents.find((e: any) => e.id === "release-tags:tagged");
		assert.deepEqual([event.owner, event.listeners], ["release-tags", ["hdr-alert"]]);
		const one = (await w.run("plugin.inspect", { id: "tag-hdr" })).output as any;
		assert.deepEqual(one.requires, [{ id: "release-tags", range: "^0.1.0" }]);
	} finally {
		await w.close();
	}
});

test("switching off the owner shows who needs it and switches them off together; one that needs it waits, and starts when it is back", async () => {
	const w = await world();
	try {
		const m = w.t.manager;
		const asked = await m.disable("release-tags");
		assert.equal(asked.result, "needs_confirmation");
		assert.deepEqual(asked.dependents!.sort(), ["hdr-alert", "tag-hdr"]);
		assert.match(asked.next, /need release-tags: they require it/);
		assert.equal(w.t.info("tag-hdr").state, "active", "nothing changed before the owner said yes");

		const done = await m.disable("release-tags", { withDependents: true });
		assert.deepEqual(done.dependents!.sort(), ["hdr-alert", "tag-hdr"]);
		for (const id of trio) assert.equal(w.t.info(id).state, "disabled", id);

		const waiting = await m.enable("tag-hdr");
		assert.equal(waiting.state, "waiting");
		assert.match(waiting.next, /release-tags \^0\.1\.0 \(disabled, 0\.1\.0\)/);
		assert.deepEqual(w.t.info("tag-hdr").waitingForPlugins, [{ id: "release-tags", range: "^0.1.0", version: "0.1.0", state: "disabled" }]);
		assert.match((await runOperation(w.app, "plugin.list", {}, { actor: "owner:cli" })).text, /tag-hdr 0\.1\.0 \| waiting \| waiting for release-tags \^0\.1\.0 \(disabled, 0\.1\.0\)/);

		await m.enable("release-tags");
		assert.equal(w.t.info("tag-hdr").state, "active", "it started by itself, after release-tags");
		assert.equal(w.t.info("hdr-alert").state, "disabled", "the owner switched that one off");
	} finally {
		await w.close();
	}
});

test("a required plugin missing or of another version: waiting, saying what for", async () => {
	const base = mkdtempSync(join(tmpdir(), "reelix-requires-"));
	try {
		const later = plugin(base, { id: "needs-later", requires: { plugins: { "release-tags": "^2.0.0" } } });
		const missing = plugin(base, { id: "needs-missing", requires: { plugins: { "not-here": ">=1" } } });
		const t = await startPlugins([join(EXAMPLES, "release-tags"), later, missing]);
		try {
			assert.equal(t.info("needs-later").state, "waiting");
			assert.deepEqual(t.info("needs-later").waitingForPlugins, [{ id: "release-tags", range: "^2.0.0", version: "0.1.0", state: "active" }]);
			assert.deepEqual(t.info("needs-missing").waitingForPlugins, [{ id: "not-here", range: ">=1" }]);
			assert.match((await runOperation(t.app, "plugin.list", {}, { actor: "owner:cli" })).text, /needs-missing 0\.1\.0 \| waiting \| waiting for not-here >=1 \(not installed\)/);
		} finally {
			await t.close();
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("requirements that go round in a circle are refused with the circle named; switching one on is refused again", async () => {
	const base = mkdtempSync(join(tmpdir(), "reelix-cycle-"));
	try {
		const a = plugin(base, { id: "circle-a", requires: { plugins: { "circle-b": "*" } } });
		const b = plugin(base, { id: "circle-b", requires: { plugins: { "circle-c": "*" } } });
		const c = plugin(base, { id: "circle-c", requires: { plugins: { "circle-a": "*" } } });
		const fine = plugin(base, { id: "on-a", requires: { plugins: { "circle-a": "*" } } });
		const t = await startPlugins([a, b, c, fine]);
		try {
			assert.equal(t.info("circle-a").state, "failed");
			assert.match(t.info("circle-a").error!, /go round in a circle \(circle-a → circle-b → circle-c → circle-a\)/);
			assert.match(t.info("circle-c").error!, /circle-c → circle-a → circle-b → circle-c/);
			assert.equal(t.info("on-a").state, "waiting", "outside the circle, it only waits");
			const again = await t.manager.enable("circle-b");
			assert.equal(again.result, "failed");
			assert.match(again.next, /circle-b → circle-c → circle-a → circle-b/);
		} finally {
			await t.close();
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("the contract is the owner's data: an answer that breaks it is an error for that provider only, and counts against it", async () => {
	const base = mkdtempSync(join(tmpdir(), "reelix-contract-"));
	try {
		const broken = plugin(
			base,
			{ id: "tag-broken", requires: { plugins: { "release-tags": "^0.1.0" } }, uses: { provides: ["release-tags:tagger@1"] } },
			`export default definePlugin({ async activate(ctx) { await ctx.provide("release-tags:tagger@1", { id: "broken", label: "Broken", async tag(rs: { ref: string }[]) { return rs.map((r) => ({ ref: r.ref, tags: [42] })); } }); } });`,
		);
		const w = await releaseWorld({ examples: ["release-tags", "tag-hdr"], folders: [broken], results: [offered(DV, 30)] });
		try {
			const r = (await w.run("release.search", { query: "Sintel" })).output as any;
			assert.deepEqual(r.releases[0].notes, [{ plugin: "release-tags", note: "Tags: Dolby Vision, HDR10" }], "the good tagger still counts");
			assert.equal(w.t.info("tag-broken").failures, 1);
			assert.match(w.t.info("tag-broken").error!, /broke the release-tags:tagger@1 contract: \/0\/tags\/0 /);
		} finally {
			await w.close();
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("only the owner calls its seam and emits its events; the payload must fit; names that belong to another plugin need it required", async () => {
	const base = mkdtempSync(join(tmpdir(), "reelix-owned-"));
	try {
		const outsider = plugin(
			base,
			{ id: "outsider", requires: { plugins: { "release-tags": "^0.1.0" } }, uses: { operations: { poke: "read" } } },
			`import { Type } from "@reelix/plugin";
export default definePlugin({ async activate(ctx) {
	await ctx.operation({ name: "poke", summary: "Poke", effect: "read", input: Type.Object({ what: Type.String() }), async run({ what }) {
		if (what === "call") return ctx.seams.call("release-tags:tagger@1", "tag", [[]]);
		return ctx.emit("release-tags:tagged", { releases: [] });
	} });
} });`,
		);
		const unrequired = plugin(base, { id: "unrequired", uses: { provides: ["release-tags:tagger@1"] } });
		const unknown = plugin(base, { id: "unknown-event", requires: { plugins: { "release-tags": "*" } }, uses: { events: ["release-tags:nothing"] } }, `export default definePlugin({ async activate(ctx) { await ctx.on("release-tags:nothing", () => undefined); } });`);
		const badOwner = plugin(base, { id: "bad-owner", owns: { seams: { "release-tags:mine@1": { summary: "x", methods: { m: { result: {} } } } } } });
		const t = await startPlugins([join(EXAMPLES, "release-tags"), outsider, unrequired, unknown, badOwner]);
		try {
			const poke = (what: string) => runOperation(t.app, "outsider.poke", { what }, { actor: "owner:cli" });
			await assert.rejects(poke("call"), /outsider does not own the seam "release-tags:tagger@1"/);
			await assert.rejects(poke("emit"), /outsider does not own the event "release-tags:tagged"/);
			await assert.rejects(t.app.seams.callOwned("release-tags:tagger@1", "outsider", "tag", [[]]), /Only the plugin that owns release-tags:tagger@1 calls its providers/);
			assert.match(t.info("unrequired").error!, /"release-tags:tagger@1" belongs to the plugin release-tags; add it to reelix.requires.plugins/);
			assert.match(t.info("unknown-event").error!, /there is no event "release-tags:nothing"; its owner release-tags does not declare it/);
			assert.match(t.info("bad-owner").error!, /a seam a plugin owns is named bad-owner:<name>@<version>/);
		} finally {
			await t.close();
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("an event's payload is checked against the owner's schema before anyone hears it", async () => {
	const base = mkdtempSync(join(tmpdir(), "reelix-payload-"));
	try {
		const owner = join(base, "release-tags");
		cpSync(join(EXAMPLES, "release-tags"), owner, { recursive: true, filter: (s) => !s.includes("node_modules") });
		// The same owner, emitting a payload its own schema does not allow.
		const entry = join(owner, "src/index.ts");
		writeFileSync(entry, readFileSync(entry, "utf8").replace("await ctx.emit(\"release-tags:tagged\", tagged);", "await ctx.emit(\"release-tags:tagged\", { ...tagged, extra: 1 });"));
		const w = await releaseWorld({ folders: [owner, join(EXAMPLES, "tag-hdr"), join(EXAMPLES, "hdr-alert")], results: [offered(DV, 30)] });
		try {
			await w.run("release.search", { query: "Sintel" });
			assert.match(w.t.info("release-tags").error!, /event "release-tags:tagged": the payload does not fit its declared schema/);
		} finally {
			await w.close();
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
