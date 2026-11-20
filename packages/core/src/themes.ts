import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { Reelix } from "./app.ts";
import { defineOperation } from "./registry.ts";
import { ReelixError } from "./util.ts";

/**
 * Web UI themes as folders: theme.json (manifest) + theme.css (token values under
 * [data-theme="<id>"]) + optional fonts and images. Marquee and Paper are built in (themes/ in the
 * repo); the owner's or third-party themes live in $REELIX_DATA/themes/<id>/ and load without a
 * rebuild. The token contract is themes/tokens.json. See docs/ui-themes.md.
 */
export const BUILT_IN_THEMES_DIR = fileURLToPath(new URL("../../../themes/", import.meta.url));
export const BUILT_IN_THEMES = ["marquee", "paper"] as const;
/** Files a theme folder may serve. No SVG (it can carry script) and nothing executable. */
export const THEME_FILE_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
};
const MAX_CSS = 512 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

export type Localized = string | Record<string, string>;
export type ThemeManifest = { id: string; name: Localized; description?: Localized; scheme: "dark" | "light"; base?: "marquee" | "paper"; swatches?: string[]; author?: string; version?: string };
export type ThemeInfo = { id: string; dir: string; builtIn: boolean; ok: boolean; manifest?: ThemeManifest; errors: string[]; warnings: string[]; inherited: string[] };

export function themeTokens(): string[] {
	return (JSON.parse(readFileSync(join(BUILT_IN_THEMES_DIR, "tokens.json"), "utf8")) as { tokens: string[] }).tokens;
}

const isLocalized = (v: unknown) => typeof v === "string" ? v.trim().length > 0 : !!v && typeof v === "object" && Object.values(v).length > 0 && Object.values(v).every((x) => typeof x === "string");

/** Validate one theme folder: manifest, selector, tokens, self-containment. */
export function checkThemeDir(dir: string, id: string, builtIn = false): ThemeInfo {
	const info: ThemeInfo = { id, dir, builtIn, ok: false, errors: [], warnings: [], inherited: [] };
	const err = (m: string) => info.errors.push(m);
	if (!ID.test(id)) err(`Folder name "${id}" is not a valid theme id (lowercase letters, digits and dashes, 2–40 characters).`);
	let m: ThemeManifest | undefined;
	try {
		m = JSON.parse(readFileSync(join(dir, "theme.json"), "utf8")) as ThemeManifest;
	} catch (e) {
		err(`theme.json: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (m) {
		if (m.id !== id) err(`theme.json id "${m.id}" must equal the folder name "${id}".`);
		if (!isLocalized(m.name)) err("theme.json name: a string, or an object of language → string ({\"en\": …, \"zh\": …}).");
		if (m.description !== undefined && !isLocalized(m.description)) err("theme.json description: a string or a language → string object.");
		if (m.scheme !== "dark" && m.scheme !== "light") err('theme.json scheme: "dark" or "light".');
		if (m.base !== undefined && !(BUILT_IN_THEMES as readonly string[]).includes(m.base)) err('theme.json base: "marquee" or "paper".');
		if (m.swatches !== undefined && (!Array.isArray(m.swatches) || m.swatches.some((s) => typeof s !== "string"))) err("theme.json swatches: an array of CSS colours.");
		if (!builtIn && (BUILT_IN_THEMES as readonly string[]).includes(id)) err(`"${id}" is a built-in theme's id; choose another.`);
		info.manifest = m;
	}
	const cssPath = join(dir, "theme.css");
	if (!existsSync(cssPath)) err("theme.css is missing.");
	else if (statSync(cssPath).size > MAX_CSS) err(`theme.css is over ${MAX_CSS / 1024} KB.`);
	else {
		const css = readFileSync(cssPath, "utf8");
		const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
		if (!plain.includes(`[data-theme="${id}"]`)) err(`theme.css must set its tokens under [data-theme="${id}"].`);
		// Self-contained: no network. CSS can leak what is typed (attribute selectors + url()) to whoever serves those URLs.
		if (/@import/i.test(plain)) err("theme.css may not use @import; put everything in this one file.");
		if (/url\(\s*['"]?\s*(https?:|\/\/|data:text|javascript:)/i.test(plain)) err("theme.css may only use url() for files in its own folder (no web addresses).");
		if (/expression\s*\(|behavior\s*:|-moz-binding/i.test(plain)) err("theme.css uses a scripting extension.");
		const set = new Set([...plain.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((x) => x[1]!));
		const tokens = themeTokens();
		const missing = tokens.filter((t) => !set.has(t));
		if (missing.length) {
			if (m?.base) info.inherited = missing;
			else err(`theme.css does not set ${missing.length} token(s) and has no base to inherit them from: ${missing.join(", ")}.`);
		}
		const unknown = [...set].filter((t) => !tokens.includes(t));
		if (unknown.length) info.warnings.push(`Tokens the UI does not use (typo?): ${unknown.join(", ")}.`);
		for (const u of plain.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
			const f = u[1]!.replace(/^\.\//, "");
			if (f.startsWith("data:")) continue;
			if (f.includes("..") || f.startsWith("/")) err(`url(${u[1]}) must point inside the theme folder.`);
			else if (!THEME_FILE_TYPES[extname(f).toLowerCase()]) err(`url(${u[1]}): ${extname(f) || "this file type"} is not served (fonts, PNG, JPEG, WebP).`);
			else if (!existsSync(join(dir, f))) err(`url(${u[1]}): the file is missing.`);
		}
	}
	for (const f of readdirSync(dir)) if (!THEME_FILE_TYPES[extname(f).toLowerCase()] && !/^(README|LICENSE)/i.test(f) && !statSync(join(dir, f)).isDirectory()) info.warnings.push(`${f} will not be served (allowed: ${Object.keys(THEME_FILE_TYPES).join(" ")}).`);
	info.ok = info.errors.length === 0;
	return info;
}

/** Built-in and installed themes, each checked. */
export function listThemes(app: Reelix): ThemeInfo[] {
	const out = BUILT_IN_THEMES.map((id) => checkThemeDir(join(BUILT_IN_THEMES_DIR, id), id, true));
	if (existsSync(app.paths.themes))
		for (const id of readdirSync(app.paths.themes).sort()) {
			const dir = join(app.paths.themes, id);
			if (statSync(dir).isDirectory() && !id.startsWith(".")) out.push(checkThemeDir(dir, id));
		}
	return out;
}

/** What the web UI offers besides the built-ins: installed themes that pass the check. */
export function installedThemes(app: Reelix): ThemeManifest[] {
	return listThemes(app)
		.filter((t) => !t.builtIn && t.ok && t.manifest)
		.map((t) => t.manifest!);
}

/** The folder of an installed theme, or undefined. */
export function themeDir(app: Reelix, id: string): string | undefined {
	if (!ID.test(id)) return undefined;
	const dir = join(app.paths.themes, id);
	return existsSync(join(dir, "theme.json")) ? dir : undefined;
}

/** Start a theme from a copy of another (built-in or installed). */
export function newTheme(app: Reelix, i: { id: string; from?: string; name?: string; author?: string }): ThemeInfo {
	const from = i.from ?? "marquee";
	if (!ID.test(i.id)) throw new ReelixError("invalid_input", "Theme ids are lowercase letters, digits and dashes (2–40 characters).");
	if ((BUILT_IN_THEMES as readonly string[]).includes(i.id) || existsSync(join(app.paths.themes, i.id))) throw new ReelixError("conflict", `A theme called "${i.id}" exists already.`);
	const builtIn = (BUILT_IN_THEMES as readonly string[]).includes(from);
	const src = builtIn ? join(BUILT_IN_THEMES_DIR, from) : themeDir(app, from);
	if (!src) throw new ReelixError("not_found", `No theme "${from}" to copy (built in: ${BUILT_IN_THEMES.join(", ")}; installed: see theme.list).`);
	const srcManifest = JSON.parse(readFileSync(join(src, "theme.json"), "utf8")) as ThemeManifest;
	const dest = join(app.paths.themes, i.id);
	cpSync(src, dest, { recursive: true });
	const sel = (id: string) => new RegExp(String.raw`(:root\s*,\s*)?\[data-theme="${id}"\](\s*,\s*\[data-base="${id}"\])?`, "g");
	const css = readFileSync(join(dest, "theme.css"), "utf8").replace(sel(from), `[data-theme="${i.id}"]`).replace(/^\/\*[\s\S]*?\*\/\n?/, `/* ${i.name ?? i.id}: started from ${from}. Tokens: themes/tokens.json; guide: docs/ui-themes.md. */\n`);
	writeFileSync(join(dest, "theme.css"), css);
	const manifest: ThemeManifest = {
		id: i.id,
		name: i.name ?? i.id,
		description: srcManifest.description,
		scheme: srcManifest.scheme,
		base: builtIn ? (from as ThemeManifest["base"]) : srcManifest.base,
		swatches: srcManifest.swatches,
		author: i.author,
		version: "0.1.0",
	};
	writeFileSync(join(dest, "theme.json"), JSON.stringify(manifest, null, "\t") + "\n");
	return checkThemeDir(dest, i.id);
}

const infoText = (t: ThemeInfo) =>
	`${t.ok ? "✓" : "✗"} ${t.id}${t.builtIn ? " (built in)" : ""}${t.manifest ? ` — ${typeof t.manifest.name === "string" ? t.manifest.name : (t.manifest.name.en ?? Object.values(t.manifest.name)[0])}, ${t.manifest.scheme}${t.manifest.base ? `, base ${t.manifest.base}` : ""}` : ""}\n   ${t.dir}` +
	t.errors.map((e) => `\n   error: ${e}`).join("") +
	t.warnings.map((w) => `\n   warning: ${w}`).join("") +
	(t.inherited.length ? `\n   inherits ${t.inherited.length} token(s) from ${t.manifest?.base}` : "");

defineOperation({
	name: "theme.list",
	summary: "Web UI themes: built in and installed (in the data folder's themes/), each checked",
	effect: "read",
	input: Type.Object({}),
	async run(ctx) {
		return listThemes(ctx.app);
	},
	toText: (o: any) => (o as ThemeInfo[]).map(infoText).join("\n"),
});

defineOperation({
	name: "theme.new",
	summary: "Start a new web UI theme as a copy of another (default marquee) in the data folder's themes/<id>/; then edit its theme.css",
	effect: "write",
	input: Type.Object({ id: Type.String({ description: "lowercase-with-dashes" }), from: Type.Optional(Type.String({ description: "marquee, paper, or an installed theme" })), name: Type.Optional(Type.String()), author: Type.Optional(Type.String()) }),
	positional: ["id"],
	async run(ctx, i) {
		return newTheme(ctx.app, i);
	},
	toText: (o: any) => `${infoText(o)}\nEdit theme.css there (token values; a reload of the web UI shows changes), then run: reelix theme check ${o.id}`,
});

defineOperation({
	name: "theme.check",
	summary: "Check a theme folder: manifest, selector, every token, no web addresses",
	effect: "read",
	input: Type.Object({ id: Type.String() }),
	positional: ["id"],
	async run(ctx, i) {
		const t = listThemes(ctx.app).find((x) => x.id === i.id);
		if (!t) throw new ReelixError("not_found", `No theme "${i.id}". Installed themes live in ${ctx.app.paths.themes}/<id>/.`);
		return t;
	},
	toText: (o: any) => infoText(o),
});
