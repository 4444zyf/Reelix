import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { reasonsFor, runOperation } from "@reelix/core";
import { insertTitle, touch } from "../../../../packages/core/test/helpers.ts";
import { releaseWorld } from "../../../../packages/core/test/fakes/release-world.ts";

process.chdir(tmpdir());

const NAME = "Severance.S01E01.1080p.WEB-DL.x265-GRP";

async function world() {
	const w = await releaseWorld({ examples: ["name-with-resolution"], results: [] });
	insertTitle(w.app, { id: "tv:95396", kind: "tv", tmdb_id: 95396, name: "Severance", folder_name: "Severance", year: 2022 });
	const dir = join(w.downloads, NAME);
	touch(join(dir, `${NAME}.mkv`), 2000);
	touch(join(dir, `${NAME}.chs.srt`), 20);
	return { ...w, dir };
}

test("Reelix's own plan gets the resolution in the name, subtitles stay beside the video, and the reason is kept", async () => {
	const w = await world();
	try {
		const r = await runOperation(w.app, "organise", { mode: "apply", title_id: "tv:95396", path: w.dir }, { actor: "owner:test" });
		const items = (r.output as any).plan.items as { dest: string; kind: string; reason: string }[];
		const base = "Severance (2022) S01E01 - 1080p";
		assert.deepEqual(items.map((i) => basename(i.dest)).sort(), [`${base}.mkv`, `${base}.zh.srt`].sort());
		assert.ok(items.every((i) => i.dest.includes("Severance (2022) [tmdbid-95396]/Season 01/")), "the folders are kept");
		assert.ok(items.every((i) => existsSync(i.dest)));
		assert.match(items[0]!.reason, /named by name-with-resolution: The resolution was added/);
		assert.equal(reasonsFor(w.app, "plan:tv:95396").filter((x) => x.kind === "renamed" && x.plugin === "name-with-resolution").length, 2);
	} finally {
		await w.close();
	}
});

test("items the agent writes keep their path but are held to the same limits", async () => {
	const w = await world();
	try {
		const source = join(w.dir, `${NAME}.mkv`);
		const root = join(w.library, "Shows");
		const folder = "Severance (2022) [tmdbid-95396]";
		const plan = (dest: string) => runOperation(w.app, "organise", { mode: "plan", title_id: "tv:95396", items: [{ source, dest, kind: "video" }] }, { actor: "agent:test" });
		const good = join(root, folder, "Season 01", "My own name.mkv");
		assert.equal(((await plan(good)).output as any).plan.items[0].dest, good, "not passed through the hook");
		for (const [dest, why] of [
			[join(w.library, "..", "evil", folder, "Season 01", "a.mkv"), /inside the library/],
			[join(root, "Other [tmdbid-1]", "Season 01", "a.mkv"), /title folder/],
			[join(root, folder, "a.mkv"), /levels deep/],
			[join(root, folder, "Season 01", "a.mp4"), /extension/],
			[join(root, folder, "Season 01", "a?.mkv"), /cannot have/],
		] as const) await assert.rejects(plan(dest), (e: any) => e.code === "invalid_plan" && why.test(e.message), dest);
	} finally {
		await w.close();
	}
});
