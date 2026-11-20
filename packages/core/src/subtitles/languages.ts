import type { Reelix } from "../app.ts";
import type { SubLanguage } from "./text.ts";

/**
 * Subtitle languages. The owner wants subtitles in an ordered list of languages
 * (config subtitles.languages; unset: from the owner's language). Codes are ISO 639-1; "zh" covers
 * 简体, 繁體 and 简英双语 (ranked bilingual > simplified > traditional unless told otherwise).
 */
export const SUBTITLE_LANGUAGES = ["zh", "en", "fr", "ru", "ja"] as const;
export type SubLang = (typeof SUBTITLE_LANGUAGES)[number];

const FROM_OWNER: Record<string, SubLang[]> = { zh: ["zh"], en: ["en"], fr: ["fr", "en"], ru: ["ru", "en"] };

export function wantedLanguages(app: Reelix): SubLang[] {
	const set = app.config.subtitles.languages?.filter((l): l is SubLang => (SUBTITLE_LANGUAGES as readonly string[]).includes(l));
	return set?.length ? set : FROM_OWNER[app.config.language ?? "en"] ?? ["en"];
}

/** The language family of a detected subtitle ("zh-Hans" → "zh"). */
export const family = (l: SubLanguage): SubLang | undefined => (l.startsWith("zh") ? "zh" : (SUBTITLE_LANGUAGES as readonly string[]).includes(l) ? (l as SubLang) : undefined);

const ZH_ORDER: Partial<Record<SubLanguage, number>> = { "zh-bilingual": 6, "zh-Hans": 5, "zh-mixed": 3, "zh-Hant": 2 };

/** How much the owner wants a subtitle in this language: earlier in the list scores higher; 0 = not wanted. */
export function languageScore(l: SubLanguage, wanted: readonly SubLang[], prefer?: string): number {
	if (prefer) {
		if (prefer === "bilingual" && l === "zh-bilingual") return 1000;
		if (prefer === "simplified" && l === "zh-Hans") return 1000;
		if (prefer === "traditional" && l === "zh-Hant") return 1000;
		if (prefer === l || prefer === family(l)) return 1000;
	}
	const f = family(l);
	const i = f ? wanted.indexOf(f) : -1;
	if (i < 0) return 0;
	return (wanted.length - i) * 10 + (f === "zh" ? (ZH_ORDER[l] ?? 0) : 5);
}

/** ISO 639-2 / common tags in video containers and file names, per language. */
const TRACK_TAGS: Record<SubLang, RegExp> = {
	zh: /^(chi|zho|zh|chs|cht|cmn|yue)\b/i,
	en: /^(eng|en)\b/i,
	fr: /^(fre|fra|fr)\b/i,
	ru: /^(rus|ru)\b/i,
	ja: /^(jpn|ja)\b/i,
};
const TRACK_TITLES: Record<SubLang, RegExp> = {
	zh: /中|简|繁|chinese|chs|cht/i,
	en: /english/i,
	fr: /fran[cç]ais|french/i,
	ru: /рус|russian/i,
	ja: /日本|japanese/i,
};
const FILE_TAGS: Record<SubLang, RegExp> = {
	zh: /\.(zh|chi|chs|cht|zho|zh-CN|zh-TW|zh-Hans|zh-Hant)\b|简|繁/i,
	en: /\.(en|eng)\b/i,
	fr: /\.(fr|fre|fra)\b/i,
	ru: /\.(ru|rus)\b/i,
	ja: /\.(ja|jpn)\b/i,
};

/** Does an embedded track (language tag, title) carry one of these languages? */
export function trackMatches(track: { language?: string; title?: string }, wanted: readonly SubLang[]): boolean {
	return wanted.some((w) => TRACK_TAGS[w].test(track.language ?? "") || TRACK_TITLES[w].test(track.title ?? ""));
}

/** Does an external subtitle file name say it is in one of these languages? */
export function fileMatches(name: string, wanted: readonly SubLang[]): boolean {
	return wanted.some((w) => FILE_TAGS[w].test(name));
}

/** Names of languages for the agent and logs. */
export const LANGUAGE_LABEL: Record<SubLang, string> = { zh: "Chinese (简体/繁體/简英双语)", en: "English", fr: "French", ru: "Russian", ja: "Japanese" };
