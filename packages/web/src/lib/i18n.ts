import i18n from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * The languages Reelix speaks. Strings live in src/locales/<lang>/<namespace>.json; English is the
 * reference (keys are type-checked against it, scripts/check-locales.mjs checks the others match).
 */
export const LANGUAGES = [
	{ id: "en", native: "English", html: "en", intl: "en" },
	{ id: "zh", native: "简体中文", html: "zh-CN", intl: "zh-CN" },
	{ id: "fr", native: "Français", html: "fr", intl: "fr" },
	{ id: "ru", native: "Русский", html: "ru", intl: "ru" },
] as const;

export type Lang = (typeof LANGUAGES)[number]["id"];
export const NAMESPACES = ["common", "nav", "appearance", "chat", "media", "library", "settings", "activity"] as const;

const KEY = "reelix.lang";
const ids = LANGUAGES.map((l) => l.id) as string[];
export const isLang = (v: unknown): v is Lang => typeof v === "string" && ids.includes(v);

/** zh-TW, zh-Hans… → zh; fr-CA → fr; anything else → undefined. */
export function matchLang(tag: string | null | undefined): Lang | undefined {
	const base = tag?.toLowerCase().split(/[-_]/)[0];
	return isLang(base) ? base : undefined;
}

function initial(): Lang {
	try {
		const saved = localStorage.getItem(KEY);
		if (isLang(saved)) return saved;
	} catch {
		/* no storage */
	}
	for (const tag of navigator.languages ?? [navigator.language]) {
		const l = matchLang(tag);
		if (l) return l;
	}
	return "en";
}

const files = import.meta.glob("../locales/*/*.json", { eager: true, import: "default" }) as Record<string, Record<string, unknown>>;
const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, data] of Object.entries(files)) {
	const m = /locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
	if (m) (resources[m[1]!] ??= {})[m[2]!] = data;
}

export const langInfo = (l: string) => LANGUAGES.find((x) => x.id === l) ?? LANGUAGES[0];

function reflect(l: string) {
	document.documentElement.lang = langInfo(l).html;
}

void i18n.use(initReactI18next).init({
	resources,
	lng: initial(),
	fallbackLng: "en",
	supportedLngs: ids,
	ns: [...NAMESPACES],
	defaultNS: "common",
	interpolation: { escapeValue: false },
	returnNull: false,
	react: { useSuspense: false },
});
reflect(i18n.language);
i18n.on("languageChanged", reflect);

/** Switch this browser's language (the server-side setting is saved by the caller). */
export function setLanguage(l: Lang) {
	try {
		localStorage.setItem(KEY, l);
	} catch {
		/* private mode */
	}
	void i18n.changeLanguage(l);
}

/** The Intl locale for dates and numbers. */
export const intlLocale = () => langInfo(i18n.language).intl;

export default i18n;
