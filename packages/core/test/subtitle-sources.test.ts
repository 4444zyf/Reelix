import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { languageScore, wantedLanguages } from "../src/subtitles/languages.ts";
import { videoFileHash } from "../src/subtitles/pipeline.ts";
import { detectLanguage } from "../src/subtitles/text.ts";
import { tempApp } from "./helpers.ts";

const FR_SRT = "1\n00:00:01,000 --> 00:00:02,000\nJe ne sais pas ce que vous voulez.\n\n2\n00:00:03,000 --> 00:00:04,000\nC'est une bonne nouvelle, et je suis là.\n\n".repeat(10);
const EN_SRT = "1\n00:00:01,000 --> 00:00:02,000\nI don't know what you want from me.\n\n2\n00:00:03,000 --> 00:00:04,000\nThis is good news and I'm here.\n\n".repeat(10);
const RU_SRT = "1\n00:00:01,000 --> 00:00:02,000\nЯ не знаю, чего вы хотите.\n\n2\n00:00:03,000 --> 00:00:04,000\nЭто хорошие новости, и я здесь.\n\n".repeat(10);

test("subtitle languages: French and Russian are read from the text; the wanted order follows the owner", () => {
	assert.equal(detectLanguage(FR_SRT).language, "fr");
	assert.equal(detectLanguage(EN_SRT).language, "en");
	assert.equal(detectLanguage(RU_SRT).language, "ru");
	const { app } = tempApp();
	assert.deepEqual(wantedLanguages(app), ["en"]);
	app.setConfig("language", "fr");
	assert.deepEqual(wantedLanguages(app), ["fr", "en"]);
	app.setConfig("language", "zh");
	assert.deepEqual(wantedLanguages(app), ["zh"]);
	app.setConfig("subtitles.languages", ["ru", "zh"]);
	assert.deepEqual(wantedLanguages(app), ["ru", "zh"], "an explicit list wins");
	assert.ok(languageScore("ru", ["ru", "zh"]) > languageScore("zh-bilingual", ["ru", "zh"]));
	assert.ok(languageScore("zh-bilingual", ["zh"]) > languageScore("zh-Hans", ["zh"]), "within Chinese: bilingual first");
	assert.equal(languageScore("ja", ["fr", "en"]), 0);
	app.close();
});

test("the video hash sources match on: size plus the sums of the first and last 64 KB", () => {
	const { app, root } = tempApp();
	const f = join(root, "zeros.bin");
	writeFileSync(f, Buffer.alloc(200_000));
	assert.equal(videoFileHash(f), (200_000).toString(16).padStart(16, "0"));
	app.close();
});
