import { basename } from "node:path";
import { Type } from "typebox";
import { defineOperation } from "../registry.ts";
import { PRESETS } from "../subtitles/styles.ts";
import { TRANSLATOR, cancelTranslation, createTranslation, setTranslationWish, translationWishes, getGlossary, listTranslations, reportToText, setGlossaryEntry, translationSources, translationStatus, type TranslationStatus } from "../subtitles/translate.ts";
import { videosOf } from "../subtitles/pipeline.ts";
import { requireTitle } from "../titles.ts";
import { ReelixError } from "../util.ts";

const statusText = (s: TranslationStatus) =>
	[
		`Translation ${s.id}: ${s.target} (${s.code}), style ${s.style}: ${s.state}${s.note ? ` (${s.note})` : ""}. ${s.lines.done} of ${s.lines.total} lines.`,
		...s.items.map((i) => `- ${i.episode !== undefined ? `E${i.episode} ` : ""}${basename(i.video)}: ${i.state} ${i.lines_done}/${i.lines_total}${i.placed ? ` → ${basename(i.placed)}` : ""}${i.error ? ` (${i.error})` : ""}`),
		s.report && s.state !== "running" ? reportToText(s.report) : "",
	]
		.filter(Boolean)
		.join("\n");

defineOperation({
	name: "subtitle.translate_sources",
	tool: "subtitle_translate_sources",
	summary: "List the subtitles a translation could be made from (text files next to the video and embedded text tracks), and those it cannot use",
	effect: "read",
	input: Type.Object({ title_id: Type.Optional(Type.String()), season: Type.Optional(Type.Number()), video: Type.Optional(Type.String({ description: "one video file, instead of title_id" })) }),
	async run(ctx, input) {
		const videos = input.video ? [input.video] : videosOf(ctx.app, requireTitle(ctx.app, input.title_id ?? "").id, input.season).map((v) => v.path);
		if (!videos.length) throw new ReelixError("no_videos", "No library video files recorded for that yet.");
		return { videos: await Promise.all(videos.slice(0, 40).map((v) => translationSources(v))) };
	},
	toText: (o: any) =>
		o.videos
			.map((v: any) => `${basename(v.video)}\n${v.usable.map((u: any) => `  usable: ${u.kind === "file" ? `${basename(u.path)} (${u.language})` : `embedded track #${u.index} (${u.codec}, ${u.language ?? "language not stated"}${u.title ? `, "${u.title}"` : ""})`}${u.note ? ` — ${u.note}` : ""}`).join("\n") || "  nothing usable"}${v.unusable.map((u: any) => `\n  not usable: ${u.what}: ${u.why}`).join("")}`)
			.join("\n"),
});

defineOperation({
	name: "subtitle.translate",
	tool: "subtitle_translate",
	summary: "Start translating an existing text subtitle into any language or style, as a separate styled ASS file next to the video (a background job; the video is never changed)",
	description:
		"Only after the owner has said yes (or asked). Give title_id (+ season for a show) or video. target is free text (\"French\", \"Klingon\", \"pirate English\"); code is the language code for the file name (ISO where one exists: fr, tlh, sjn; else x-something). novelty=true for constructed languages and styles. The source is the subtitle in source_language if given, else English, else the first usable text subtitle. Returns at once with the size; report progress with subtitle_translation.",
	effect: "write",
	input: Type.Object({
		title_id: Type.Optional(Type.String()),
		season: Type.Optional(Type.Number()),
		video: Type.Optional(Type.String()),
		target: Type.String({ description: "the language or style, in English, a few words" }),
		code: Type.String({ description: "language code for the file name: fr, tlh, x-pirate" }),
		novelty: Type.Optional(Type.Boolean({ description: "a constructed language or a style: source line underneath, never the default subtitle" })),
		style: Type.Optional(Type.String({ description: `look: ${PRESETS.map((p) => p.id).join(", ")} (subtitle.styles describes them)` })),
		custom_style: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "changes to the chosen style: font, size, color, outline, shadow (#RRGGBB), bold, italic, spacing, outlineWidth, shadowDepth, box, alignment (bottom|top|middle), marginV, second {font, size, color, italic}" })),
		effects: Type.Optional(Type.Object({ fade: Type.Optional(Type.Boolean()), typewriter: Type.Optional(Type.Boolean()) })),
		second_line: Type.Optional(Type.Boolean({ description: "show the source text underneath (default: on for novelty when the owner reads the source language)" })),
		piqad: Type.Optional(Type.Boolean({ description: "Klingon only: pIqaD script instead of Latin letters (the player needs a pIqaD font)" })),
		source_language: Type.Optional(Type.String({ description: "two-letter code of the subtitle to translate from, e.g. the title's original language" })),
		instructions: Type.Optional(Type.String({ description: "the owner's wishes for this translation, in a sentence or two" })),
		when_filed: Type.Optional(Type.Boolean({ description: "also remember this for the title: whatever is filed for it later (the film once it arrives, new episodes) is translated the same way without asking again. Needs title_id." })),
		thread_id: Type.Optional(Type.String({ description: "leave out: filled in by the chat" })),
	}),
	async run(ctx, input) {
		const { when_filed, ...rest } = input;
		if (!when_filed) return createTranslation(ctx.app, rest);
		const t = requireTitle(ctx.app, input.title_id ?? "");
		const { video: _v, thread_id: _t, season: _s, ...wish } = rest;
		setTranslationWish(ctx.app, t.id, input.code, wish);
		try {
			return { ...(await createTranslation(ctx.app, { ...rest, only_missing: true })), standing: true };
		} catch (e) {
			if (e instanceof ReelixError && ["no_videos", "no_source", "nothing_missing"].includes(e.code)) return { standing: true, waiting: e.message, target: input.target, code: input.code };
			throw e;
		}
	},
	toText: (o: any) =>
		o.waiting
			? `Remembered: ${o.target} (${o.code}) will be made for this title when it is filed. Nothing to translate yet (${o.waiting})`
			: `${o.standing ? "Remembered for this title's later files too. " : ""}Queued as ${o.id}: ${o.target} (${o.code}), style ${o.style}, ${o.items.length} video(s), ${o.lines.total} lines.\nFrom:\n${o.sources.map((s: string) => `- ${s}`).join("\n")}${o.skipped.length ? `\nSkipped:\n${o.skipped.map((s: string) => `- ${s}`).join("\n")}` : ""}\nIt runs in the background${o.items.length > 1 ? "; the first episode is finished first as a sample" : ""}. The result is reported in this conversation when it ends.`,
});

defineOperation({
	name: "subtitle.translation",
	tool: "subtitle_translation",
	summary: "Progress and result of a subtitle translation (or the recent ones, with no id)",
	effect: "read",
	input: Type.Object({ id: Type.Optional(Type.String()) }),
	run: async (ctx, input) => (input.id ? { one: translationStatus(ctx.app, input.id) } : { list: listTranslations(ctx.app) }),
	toText: (o: any) => (o.one ? statusText(o.one) : o.list.length ? o.list.map((s: TranslationStatus) => `${s.id}: ${s.target} for ${s.title_id ?? basename(s.items[0]?.video ?? "")}${s.season !== undefined ? ` S${s.season}` : ""}: ${s.state}, ${s.lines.done}/${s.lines.total} lines`).join("\n") : "No translations yet."),
});

defineOperation({
	name: "subtitle.translation_cancel",
	tool: "subtitle_translation_cancel",
	summary: "Stop a running or waiting subtitle translation; finished episodes are kept",
	effect: "write",
	input: Type.Object({ id: Type.String() }),
	run: async (ctx, input) => cancelTranslation(ctx.app, input.id),
	toText: (o: any) => statusText(o),
});

defineOperation({
	name: "subtitle.glossary",
	tool: "subtitle_glossary",
	summary: "Show the translation glossary (names, terms, tone) of a title for one target language",
	effect: "read",
	input: Type.Object({ title_id: Type.String(), target: Type.String() }),
	async run(ctx, input) {
		const g = getGlossary(ctx.app, input.title_id, input.target);
		if (!g) throw new ReelixError("not_found", `No glossary for ${input.title_id} in ${input.target} yet: it is made by the first translation.`);
		return g;
	},
	toText: (o: any) => `${o.tone ? `Tone: ${o.tone}\n` : ""}${o.entries.map((e: any) => `${e.source} → ${e.target}${e.note ? ` (${e.note})` : ""}`).join("\n") || "(no entries)"}`,
});

defineOperation({
	name: "subtitle.glossary_set",
	tool: "subtitle_glossary_set",
	summary: "Correct or add one glossary entry; the lines it affects in finished translations are redone, nothing else",
	effect: "write",
	input: Type.Object({ title_id: Type.String(), target: Type.String(), source: Type.String({ description: "the name or term as it is written in the source subtitle" }), translation: Type.String(), note: Type.Optional(Type.String()) }),
	run: (ctx, input) => setGlossaryEntry(ctx.app, input),
	toText: (o: any) => `Saved (${o.glossary.entries.length} entries). ${o.redo.length ? o.redo.map((r: any) => `${r.lines} lines of ${r.translation} are being redone.`).join(" ") : "No finished lines mention it, so nothing is redone."}`,
});

defineOperation({
	name: "subtitle.translate_standing",
	summary: "Show a title's standing translation wishes (made when files are filed), or remove one by its language code",
	effect: "write",
	input: Type.Object({ title_id: Type.String(), remove: Type.Optional(Type.String({ description: "language code to stop, e.g. tlh" })) }),
	run: async (ctx, input) => ({ wishes: input.remove ? setTranslationWish(ctx.app, requireTitle(ctx.app, input.title_id).id, input.remove) : translationWishes(ctx.app, requireTitle(ctx.app, input.title_id).id) }),
	toText: (o: any) => (o.wishes.length ? o.wishes.map((w: any) => `${w.target} (${w.code})${w.style ? `, style ${w.style}` : ""}`).join("\n") : "No standing translations for this title."),
});

defineOperation({
	name: "subtitle.styles",
	summary: "The looks a translated subtitle can have",
	effect: "read",
	input: Type.Object({}),
	run: async () => ({ styles: PRESETS.map((p) => ({ id: p.id, description: p.description, effects: p.effects, look: p.look })) }),
	toText: (o: any) => o.styles.map((s: any) => `${s.id}: ${s.description}${s.effects.fade ? " [fade]" : ""}${s.effects.typewriter ? " [typewriter]" : ""}`).join("\n"),
});

type ProviderChoice = { active: string; running: boolean; providers: { id: string; label: string; plugin: string }[] };

defineOperation({
	name: "subtitle.translators",
	summary: "The translators this Reelix can use for subtitle lines and the active one, which only the owner chooses (config translator)",
	effect: "read",
	input: Type.Object({}),
	async run(ctx): Promise<ProviderChoice> {
		const providers = ctx.app.seams.providers(TRANSLATOR).map((p) => ({ id: p.id, label: p.label, plugin: p.plugin }));
		return { active: ctx.app.config.translator, running: providers.some((p) => p.id === ctx.app.config.translator), providers };
	},
	toText: (o: ProviderChoice) => `Active: ${o.active}${o.running ? "" : " (not running)"}\n${o.providers.map((p) => `${p.id} | ${p.label} | plugin ${p.plugin}`).join("\n") || "No translator is running."}`,
});
