import type { Language } from "./config.ts";

/**
 * Looking up a message in a catalog of strings. It imports nothing at run time, so a plugin running in a
 * process of its own uses it for `ctx.t` without loading the rest of Reelix (docs/plugins.md §11.7).
 */
export type Messages = { [k: string]: string | Messages };
export type Catalog = Partial<Record<Language, Messages>>;

export const LOCALE_TAGS: Record<Language, string> = { en: "en", zh: "zh-CN", fr: "fr", ru: "ru" };

function lookup(from: Catalog, lang: Language, key: string): string | undefined {
	let node: string | Messages | undefined = from[lang];
	for (const part of key.split(".")) node = typeof node === "object" ? node[part] : undefined;
	return typeof node === "string" ? node : undefined;
}

/** A message from a catalog, falling back to English: {{placeholders}}; `count` picks the plural form (Intl.PluralRules). */
export function messageFrom(from: Catalog, lang: Language, key: string, vars: Record<string, unknown> = {}): string | undefined {
	const pick = (l: Language) => {
		if (typeof vars.count === "number") {
			const form = new Intl.PluralRules(LOCALE_TAGS[l]).select(vars.count);
			return lookup(from, l, `${key}_${form}`) ?? lookup(from, l, `${key}_other`);
		}
		return lookup(from, l, key);
	};
	return (pick(lang) ?? pick("en"))?.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => (vars[k] === undefined ? `{{${k}}}` : String(vars[k])));
}
