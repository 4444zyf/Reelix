import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { applyPlan, autoPlan, getTitle, processLocalSubtitle } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { makeZip } from "../../../../packages/core/test/fakes/zip.ts";
import { insertTitle, tempApp, touch } from "../../../../packages/core/test/helpers.ts";

const PLUGIN = join(import.meta.dirname, "..");
const lines = Array.from({ length: 20 }, (_, i) => ({ at: `00:${String(i).padStart(2, "0")}:01`, text: "我们这个时候来说" }));
const SRT = lines.map((l, i) => `${i + 1}\n${l.at},000 --> ${l.at.slice(0, -1)}3,000\n${l.text}\n`).join("\n");
const ASS = `[Script Info]\n\n[Events]\n${lines.map((l) => `Dialogue: 0,${l.at.slice(1)}.00,${l.at.slice(1, -1)}3.00,Default,,0,0,0,,${l.text}`).join("\n")}`;
const BILINGUAL = `[Script Info]\n\n[Events]\n${lines.map((l) => `Dialogue: 0,${l.at.slice(1)}.00,${l.at.slice(1, -1)}3.00,Default,,0,0,0,,${l.text}\\NWe say this here`).join("\n")}`;

/** A film in the library and an archive with its subtitles; what Reelix places from it. */
async function place(withPlugin: boolean, files: { name: string; data: string }[]) {
	const w = tempApp();
	w.app.setConfig("subtitles.languages", ["zh", "en"]);
	insertTitle(w.app, { id: "movie:45745", kind: "movie", tmdb_id: 45745, name: "Sintel", year: 2010 });
	const video = touch(join(w.downloads, "Sintel.2010.1080p.BluRay.x264-GRP.mkv"), 1000);
	applyPlan(w.app, autoPlan(w.app, getTitle(w.app, "movie:45745")!, video).plan);
	const t = await startPlugins(withPlugin ? [PLUGIN] : [], { app: w.app });
	try {
		const zip = join(w.app.paths.workspace, "subs.zip");
		writeFileSync(zip, makeZip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data) }))));
		const out = await processLocalSubtitle(w.app, zip, { title_id: "movie:45745" });
		return { placed: out.results.map((r) => r.from), why: out.results.map((r) => r.why) };
	} finally {
		await t.close();
		w.app.close();
	}
}

test("same language: Reelix takes ASS; with prefer-srt the SRT", async () => {
	const files = [{ name: "Sintel.zh.ass", data: ASS }, { name: "Subs/Sintel.zh.srt", data: SRT }];
	assert.deepEqual((await place(false, files)).placed, ["Sintel.zh.ass"]);
	const picked = await place(true, files);
	assert.deepEqual(picked.placed, ["Sintel.zh.srt"]);
	assert.deepEqual(picked.why, ["scored by prefer-srt: SRT preferred over ASS in the same language"], "the result says which plugin changed the choice, and why");
});

test("prefer-srt changes the format only, never the owner's order of languages", async () => {
	// Chinese is wanted first, bilingual Chinese and English before plain Chinese, whatever the format.
	const files = [{ name: "Sintel.chs&eng.ass", data: BILINGUAL }, { name: "Sintel.chs.srt", data: SRT }];
	assert.deepEqual((await place(true, files)).placed, ["Sintel.chs&eng.ass"]);
});
