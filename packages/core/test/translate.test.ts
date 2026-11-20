import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { test } from "node:test";
import { parseConfig, roleModels } from "../src/config.ts";
import { applyPlan, autoPlan } from "../src/organiser.ts";
import { assTime, parseSubtitle } from "../src/subtitles/cues.ts";
import { videosOf } from "../src/subtitles/pipeline.ts";
import { PRESETS, checkLook, getPreset, renderAss, toPiqad } from "../src/subtitles/styles.ts";
import { type ChunkTranslator, type ModelCall, TranslationPaused, cancelTranslation, createTranslation, extractJson, getGlossary, runTranslation, setGlossaryEntry, translationSources, translationStatus } from "../src/subtitles/translate.ts";
import { getTitle } from "../src/titles.ts";
import { translateChunk } from "../../../plugins/model-translator/src/translate.ts";
import { insertTitle, tempApp, touch } from "./helpers.ts";

const SRT = Array.from({ length: 25 }, (_, i) => `${i + 1}\n00:00:${String(i * 2).padStart(2, "0")},000 --> 00:00:${String(i * 2 + 1).padStart(2, "0")},500\n${i === 3 ? "Sintel, wait for me!" : i === 7 ? "The dragon\nis gone." : `Line number ${i + 1} of the film.`}\n`).join("\n");

const ASS = `[Script Info]
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: Signs,Arial,30,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,8,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Hello, there{\\i0}, friend.
Dialogue: 0,0:00:04.00,0:00:06.00,Signs,,0,0,0,,{\\pos(640,80)}Tokyo Station
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,{\\k20}la{\\k30}la{\\k40}la
`;

test("cues: SRT and ASS are read into timed lines; signs keep their place, karaoke is copied", () => {
	const srt = parseSubtitle(SRT);
	assert.equal(srt.cues.length, 25);
	assert.deepEqual([srt.cues[7]!.start, srt.cues[7]!.end, srt.cues[7]!.text], [14, 15.5, "The dragon\nis gone."]);
	const ass = parseSubtitle(ASS);
	assert.deepEqual(ass.cues.map((c) => [c.kind, c.text]), [["dialogue", "Hello, there, friend."], ["sign", "Tokyo Station"], ["keep", "lalala"]]);
	const out = renderAss(ass.cues.map((cue, i) => ({ cue, text: ["Bonjour, l'ami.", "Gare de Tokyo", ""][i]!, second: i === 0 ? cue.text : undefined })), { look: getPreset("cinematic").look, effects: { fade: true, typewriter: false }, source: ass.ass });
	assert.match(out, /PlayResX: 1280/, "the source canvas is kept when its sign styles are");
	assert.match(out, /^Style: Signs,/m);
	assert.match(out, /Dialogue: 0,0:00:01.00,0:00:03.00,Reelix,,0,0,0,,\{\\fad\(140,140\)\}Bonjour, l'ami\.\\N\{\\rReelixSecond\}Hello, there, friend\./);
	assert.match(out, /Dialogue: 0,0:00:04.00,0:00:06.00,Signs,,0,0,0,,\{\\pos\(640,80\)\}Gare de Tokyo/);
	assert.match(out, /Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,\{\\k20\}la\{\\k30\}la\{\\k40\}la/);
	assert.equal(assTime(3725.5), "1:02:05.50");
});

test("styles: a model's text can never add styling codes; custom looks take only known fields and fonts", () => {
	const cue = { start: 1, end: 3, text: "x", kind: "dialogue" as const };
	const evil = renderAss([{ cue, text: "{\\p1}m 0 0 l 100 0{\\p0} hi \\N there" }], { look: PRESETS[0]!.look, effects: { fade: false, typewriter: false } });
	assert.ok(!/\{\\p1\}/.test(evil) && !evil.split("\n").pop()!.includes("{"));
	const typed = renderAss([{ cue, text: "ab" }], { look: PRESETS[0]!.look, effects: { fade: false, typewriter: true } });
	assert.match(typed, /\{\\alpha&HFF&\\t\(0,1,\\alpha&H00&\)\}a\{\\alpha&HFF&\\t\(\d+,\d+,\\alpha&H00&\)\}b/);
	assert.equal(checkLook({ color: "#ffb000", size: 60, second: { italic: true } }).color, "#FFB000");
	assert.throws(() => checkLook({ color: "red" }), /colour like/);
	assert.throws(() => checkLook({ font: "Definitely Not A Font 9000" }), /not installed/);
	assert.throws(() => checkLook({ drawing: "m 0 0" }), /unknown field/);
	assert.throws(() => checkLook({ font: "Arial{\\p1}" }), /not a font name/);
	assert.equal(toPiqad("tlhIngan Hol"), " ");
});

test("model roles: the old two settings become lists, and roles inherit", () => {
	const c = parseConfig({ models: { main: "a/chat", background: "b/bg" } });
	assert.deepEqual(c.models.roles.chat, ["a/chat"]);
	assert.deepEqual(roleModels(c, "translate"), ["b/bg"]);
	assert.deepEqual(roleModels(c, "review"), ["b/bg"]);
	const d = parseConfig({ models: { roles: { chat: ["a/chat"], translate: ["m/cheap", "m/other"] } } });
	assert.deepEqual(roleModels(d, "background"), ["a/chat"]);
	assert.deepEqual(roleModels(d, "review"), ["m/cheap", "m/other"]);
	assert.deepEqual(roleModels(parseConfig({}), "chat"), []);
});

/** A model that "translates" by tagging each line, in the JSON shape the prompts ask for. */
function fakeModel(opts: { tag?: string; dropOnce?: number; failAfter?: number; fix?: number } = {}) {
	const calls: { role: string; system: string; user: string }[] = [];
	let dropped = false;
	let translateCalls = 0;
	const call: ModelCall = async (role, system, user) => {
		calls.push({ role, system, user });
		if (role === "glossary") return { model: "fake/big", text: 'Here you go:\n```json\n{"tone":"plain","entries":[{"source":"Sintel","target":"Sintel","note":"the heroine"}]}\n```' };
		if (role === "translate") {
			if (opts.failAfter !== undefined && translateCalls++ >= opts.failAfter) throw new TranslationPaused("the gateway says the budget is used up");
			const lines = [...user.split("Translate:\n")[1]!.matchAll(/^(\d+)\|(.*)$/gm)].map((m) => ({ n: Number(m[1]), t: `${opts.tag ?? "FR"}:${m[2]!.replace("[sign] ", "")}`, ...(Number(m[1]) === 2 ? { u: true } : {}), ...(opts.tag === "tlh" && Number(m[1]) % 5 === 0 ? { b: true } : {}) }));
			if (opts.dropOnce !== undefined && !dropped) {
				dropped = true;
				return { model: "fake/cheap", text: JSON.stringify({ lines: lines.filter((l) => l.n !== opts.dropOnce) }) };
			}
			return { model: "fake/cheap", text: JSON.stringify({ lines, terms: [{ source: "dragon", target: "dragon" }] }) };
		}
		const first = Number(/^(\d+)\|/m.exec(user)?.[1]);
		return { model: "fake/careful", text: JSON.stringify({ fixes: opts.fix !== undefined && user.includes(`${opts.fix}|`) ? [{ n: opts.fix, t: "REVIEWED" }, { n: 9999, t: "not asked about" }] : [] }) + ` (first ${first})` };
	};
	// The chunk step is the translator's (docs/plugins.md §7.8): the built-in one, on the same model.
	const translate: ChunkTranslator = (job, signal) => translateChunk((r) => call(r.role!, r.system, r.user, r.signal), job, signal);
	return { call, calls, translate };
}

function sintel(language?: string) {
	const w = tempApp();
	const { app, downloads } = w;
	if (language) app.setConfig("language", language);
	app.setConfig("translation", { chunk_lines: 10, review_sample: 5 });
	insertTitle(app, { id: "movie:45745", kind: "movie", tmdb_id: 45745, name: "Sintel", folder_name: "Sintel", year: 2010 });
	const f = `${downloads}/Sintel.2010.1080p.BluRay.x264-GRP/Sintel.2010.1080p.BluRay.x264-GRP.mkv`;
	touch(f, 1000);
	applyPlan(app, autoPlan(app, getTitle(app, "movie:45745")!, `${downloads}/Sintel.2010.1080p.BluRay.x264-GRP`).plan);
	const video = videosOf(app, "movie:45745")[0]!.path;
	writeFileSync(video.replace(/\.mkv$/, ".en.srt"), SRT);
	return { ...w, video };
}

test("a French owner with only an English subtitle: translated, checked line by line, reviewed, placed as the default", async () => {
	const { app, video } = sintel("fr");
	try {
		const src = await translationSources(video);
		assert.deepEqual(src.usable.map((u) => [u.kind, (u as any).language]), [["file", "en"]]);
		const made = await createTranslation(app, { title_id: "movie:45745", target: "French", code: "fr" });
		assert.equal(made.lines.total, 25);
		assert.match(made.sources[0]!, /1080p\.mkv ← Sintel \(2010\) .*1080p\.en\.srt \(en, 25 lines\)/);
		const m = fakeModel({ dropOnce: 4, fix: 2 });
		const report = await runTranslation(app, made.id, m.call, m.translate);
		// 25 lines in chunks of 10 → 3 calls; the line the model left out is asked for again in the next chunk.
		assert.equal(m.calls.filter((c) => c.role === "translate").length, 3);
		assert.match(m.calls.filter((c) => c.role === "translate")[1]!.user, /Translate:\n4\|/);
		assert.equal(m.calls.filter((c) => c.role === "glossary").length, 1);
		assert.match(m.calls.find((c) => c.role === "translate")!.system, /Sintel → Sintel \(the heroine\)/, "the glossary reaches the translator");
		const item = report.items[0]!;
		assert.match(item.placed!, / - 1080p\.AI\.fr\.default\.ass$/);
		assert.deepEqual([item.lines, item.fixes, item.unsure, item.default], [25, 1, 1, true]);
		assert.equal(report.reviewedBySameModel, false);
		assert.deepEqual(report.models, { glossary: ["fake/big"], translate: ["fake/cheap"], review: ["fake/careful"] });
		const out = readFileSync(item.placed!, "utf8");
		const events = out.split("\n").filter((l) => l.startsWith("Dialogue:"));
		assert.equal(events.length, 25, "same number of lines as the source");
		assert.equal(events[7], "Dialogue: 0,0:00:14.00,0:00:15.50,Reelix,,0,0,0,,FR:The dragon\\Nis gone.");
		assert.match(events[2]!, /,REVIEWED$/, "the reviewer's correction is applied; one for a line it was not shown is ignored");
		assert.ok(!out.includes("ReelixSecond}"), "no second line for a real language");
		assert.equal(translationStatus(app, made.id).state, "succeeded");
		assert.ok(getGlossary(app, "movie:45745", "french")!.entries.some((e) => e.source === "dragon"), "terms met while translating join the glossary");
		// The English file is untouched, and our file is never offered as a source.
		assert.equal(readFileSync(video.replace(/\.mkv$/, ".en.srt"), "utf8"), SRT);
		assert.equal((await translationSources(video)).usable.length, 1);

		// A glossary correction redoes only the lines that mention it.
		const g = await setGlossaryEntry(app, { title_id: "movie:45745", target: "French", source: "Sintel", translation: "Sintelle" });
		assert.deepEqual(g.redo, [{ translation: made.id, lines: 1 }]);
		const m2 = fakeModel({ tag: "FR2" });
		await runTranslation(app, made.id, m2.call, m2.translate);
		const tr2 = m2.calls.filter((c) => c.role === "translate");
		assert.equal(tr2.length, 1);
		assert.deepEqual([...tr2[0]!.user.split("Translate:\n")[1]!.matchAll(/^(\d+)\|/gm)].map((x) => Number(x[1])), [3]);
		assert.match(tr2[0]!.system, /Sintel → Sintelle/);
		assert.equal(m2.calls.filter((c) => c.role === "glossary").length, 0, "the glossary is reused");
		const again = readFileSync(item.placed!, "utf8").split("\n").filter((l) => l.startsWith("Dialogue:"));
		assert.match(again[3]!, /FR2:Sintel, wait for me!$/);
		assert.match(again[4]!, /,FR:Line number 5/, "other lines keep their first translation");
	} finally {
		app.close();
	}
});

test("Klingon: not the default, the source underneath, borrowed words counted; a pause keeps its place; cancel keeps what is done", async () => {
	const { app, video } = sintel("en");
	try {
		const made = await createTranslation(app, { video, title_id: "movie:45745", target: "Klingon", code: "tlh", novelty: true, style: "warrior" });
		// The gateway refuses after the first chunk: paused, with ten lines saved.
		const m = fakeModel({ tag: "tlh", failAfter: 1 });
		await assert.rejects(runTranslation(app, made.id, m.call, m.translate), TranslationPaused);
		let s = translationStatus(app, made.id);
		assert.deepEqual([s.state, s.lines.done, s.note], ["paused", 10, "the gateway says the budget is used up"]);
		// Later it continues from line 11.
		const m2 = fakeModel({ tag: "tlh" });
		const report = await runTranslation(app, made.id, m2.call, m2.translate);
		assert.equal(m2.calls.filter((c) => c.role === "translate").length, 2);
		assert.equal(m2.calls.filter((c) => c.role === "glossary").length, 0);
		assert.match(m2.calls.find((c) => c.role === "review")!.system, /correctness cannot be checked/);
		const item = report.items[0]!;
		assert.match(basename(item.placed!), / - 1080p\.Klingon AI\.tlh\.ass$/);
		assert.deepEqual([item.default, item.borrowedShare], [false, 0.2]);
		const out = readFileSync(item.placed!, "utf8");
		assert.match(out, /Style: Reelix,DejaVu Sans Mono,54,&H0000B0FF/, "amber, as BGR");
		assert.match(out, /tlh:Line number 1 of the film\.\\N\{\\rReelixSecond\}Line number 1 of the film\./);

		// A second request, cancelled before it starts: nothing is written, the first file stays.
		const other = await createTranslation(app, { video, target: "pirate English", code: "x-pirate", novelty: true });
		cancelTranslation(app, other.id);
		const m3 = fakeModel();
		await runTranslation(app, other.id, m3.call, m3.translate);
		assert.equal(m3.calls.length, 0);
		assert.ok(existsSync(item.placed!));
		assert.throws(() => extractJson("no json here"), /no JSON/);
		await assert.rejects(createTranslation(app, { video, target: "French", code: "not a code" }), /language code/);
		s = translationStatus(app, other.id);
		assert.equal(s.state, "cancelled");
	} finally {
		app.close();
	}
});
