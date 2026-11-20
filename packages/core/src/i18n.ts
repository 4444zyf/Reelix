import { readFileSync } from "node:fs";
import type { Reelix } from "./app.ts";
import { LANGUAGES, type Language } from "./config.ts";
import { type Catalog, type Messages, messageFrom } from "./messages.ts";

/**
 * Messages Reelix writes itself (chat replies, Inbox notices, the morning summary), in the
 * owner's language (config `language`). Strings: packages/core/locales/<lang>.json, English is the
 * reference; test/i18n.test.ts checks the others. The agent's own words follow its system prompt.
 */
const catalog: Catalog = Object.fromEntries(LANGUAGES.map((l) => [l, JSON.parse(readFileSync(new URL(`../locales/${l}.json`, import.meta.url), "utf8")) as Messages]));

/** Translate one of Reelix's own messages for a language. */
export function translate(lang: Language, key: string, vars?: Record<string, unknown>): string {
	return messageFrom(catalog, lang, key, vars) ?? key;
}

export function ownerLanguage(app: Reelix): Language {
	return app.config.language ?? "en";
}

/** Translate into the owner's language. */
export function tr(app: Reelix, key: string, vars?: Record<string, unknown>): string {
	return translate(ownerLanguage(app), key, vars);
}

/** The owner's language as a name the agent understands ("Simplified Chinese"). */
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", zh: "Simplified Chinese", fr: "French", ru: "Russian" };
