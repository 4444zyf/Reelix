import { useSyncExternalStore } from "react";
import marquee from "../../../../themes/marquee/theme.json";
import paper from "../../../../themes/paper/theme.json";
import i18n from "./i18n";

/**
 * Themes. Each one is a folder with theme.json (this manifest) and theme.css (token values
 * under [data-theme="<id>"]). Marquee and Paper are built in (themes/ in the repo, bundled);
 * others are installed into $REELIX_DATA/themes/<id>/ and served by /api/themes, without a
 * rebuild. See docs/ui-themes.md.
 */
export type Localized = string | Partial<Record<string, string>>;
export type ThemeManifest = {
	id: string;
	name: Localized;
	description?: Localized;
	scheme: "dark" | "light";
	/** Installed themes build on a built-in one: tokens they leave out come from it. */
	base?: "marquee" | "paper";
	swatches?: string[];
	author?: string;
	version?: string;
	/** Set for installed themes. */
	installed?: boolean;
};

export const BUILT_IN: ThemeManifest[] = [marquee as ThemeManifest, paper as ThemeManifest];
export type ThemeChoice = string; // a theme id, or "auto"
export const DEFAULT_THEME = "marquee";

const KEY = "reelix.theme";
const BASE_KEY = "reelix.theme.base";
const LIGHT = "(prefers-color-scheme: light)";

/** The text for the UI language from a manifest field. */
export function localized(v: Localized | undefined): string {
	if (!v) return "";
	if (typeof v === "string") return v;
	return v[i18n.language] ?? v.en ?? Object.values(v)[0] ?? "";
}

let installed: ThemeManifest[] = [];
const all = () => [...BUILT_IN, ...installed];
export const findTheme = (id: string) => all().find((t) => t.id === id);

export function readChoice(): ThemeChoice {
	try {
		return localStorage.getItem(KEY) || DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

export function resolve(choice: ThemeChoice): string {
	if (choice === "auto") return window.matchMedia(LIGHT).matches ? "paper" : "marquee";
	return choice;
}

/** An installed theme's stylesheet, added once. */
function ensureStylesheet(t: ThemeManifest) {
	if (!t.installed || document.getElementById(`theme-css-${t.id}`)) return;
	const link = document.createElement("link");
	link.id = `theme-css-${t.id}`;
	link.rel = "stylesheet";
	link.href = `/api/themes/${encodeURIComponent(t.id)}/theme.css`;
	document.head.appendChild(link);
}

/** The attributes that put an element in a theme (the page, or a preview inside it). */
export function themeAttrs(id: string): { "data-theme": string; "data-base"?: string } {
	const t = findTheme(id);
	return t?.base ? { "data-theme": id, "data-base": t.base } : { "data-theme": id };
}

function apply(choice: ThemeChoice) {
	const id = resolve(choice);
	const t = findTheme(id);
	const root = document.documentElement;
	if (!t) {
		// An installed theme not listed yet (or uninstalled): its base, from the last visit, until the list arrives.
		const base = (() => {
			try {
				return localStorage.getItem(BASE_KEY);
			} catch {
				return null;
			}
		})();
		root.dataset.theme = id;
		if (base) root.dataset.base = base;
		return;
	}
	ensureStylesheet(t);
	root.dataset.theme = t.id;
	if (t.base) root.dataset.base = t.base;
	else delete root.dataset.base;
	root.style.colorScheme = t.scheme;
	try {
		if (t.base) localStorage.setItem(BASE_KEY, t.base);
		else localStorage.removeItem(BASE_KEY);
	} catch {
		/* private mode */
	}
	requestAnimationFrame(() => {
		const color = getComputedStyle(root).getPropertyValue("--theme-color").trim();
		if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
	});
}

const listeners = new Set<() => void>();
const emit = () => {
	for (const l of listeners) l();
};
let current: ThemeChoice = typeof window === "undefined" ? DEFAULT_THEME : readChoice();
let list: ThemeManifest[] = all();

export function setTheme(choice: ThemeChoice) {
	current = choice;
	try {
		localStorage.setItem(KEY, choice);
	} catch {
		/* private mode: lasts until reload */
	}
	apply(choice);
	emit();
}

/** Ask the server which themes are installed (public: the sign-in page is themed too). */
export async function loadInstalled() {
	try {
		const r = await fetch("/api/themes");
		if (!r.ok) return;
		const got = (await r.json()) as ThemeManifest[];
		installed = got.filter((t) => t && typeof t.id === "string" && !BUILT_IN.some((b) => b.id === t.id)).map((t) => ({ ...t, installed: true }));
		for (const t of installed) ensureStylesheet(t); // previews in Settings need them all
		list = all();
		if (!findTheme(resolve(current))) current = DEFAULT_THEME; // uninstalled since the last visit
		apply(current);
		emit();
	} catch {
		/* offline: built-ins only */
	}
}

if (typeof window !== "undefined") {
	apply(current);
	void loadInstalled();
	window.matchMedia(LIGHT).addEventListener("change", () => {
		if (current === "auto") {
			apply(current);
			emit();
		}
	});
	window.addEventListener("storage", (e) => {
		if (e.key === KEY) {
			current = readChoice();
			apply(current);
			emit();
		}
	});
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

/** The owner's choice, the theme showing, and every theme on offer. */
export function useTheme() {
	const choice = useSyncExternalStore(subscribe, () => current);
	const active = useSyncExternalStore(subscribe, () => resolve(current));
	const themes = useSyncExternalStore(subscribe, () => list);
	return { choice, active, themes, setTheme };
}
