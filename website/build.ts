/**
 * Builds the project website into website/dist: one static page per language (English at the root,
 * the others under /zh, /fr, /ru), with fonts copied from the fontsource packages the web UI already uses.
 * No dependencies beyond the repository's own. Run: npm run site:build
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS, type Lang, type Strings, render } from "./src/page.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const fontsource = join(here, "..", "node_modules", "@fontsource-variable");

/** Latin and Cyrillic only: Chinese text uses the reader's system fonts, which every Chinese system has. */
const FONTS = [
	"fraunces/files/fraunces-latin-wght-normal.woff2",
	"fraunces/files/fraunces-latin-ext-wght-normal.woff2",
	"fraunces/files/fraunces-latin-wght-italic.woff2",
	"inter/files/inter-latin-wght-normal.woff2",
	"inter/files/inter-latin-ext-wght-normal.woff2",
	"inter/files/inter-cyrillic-wght-normal.woff2",
	"noto-serif/files/noto-serif-cyrillic-wght-normal.woff2",
	"jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
];

const load = (lang: Lang): Strings => JSON.parse(readFileSync(join(here, "locales", `${lang}.json`), "utf8"));

/** Every language has exactly English's keys, and lists of the same length. */
function sameShape(a: unknown, b: unknown, path: string): string[] {
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return [`${path}: list length differs`];
		return a.flatMap((x, i) => sameShape(x, b[i], `${path}[${i}]`));
	}
	if (a && typeof a === "object") {
		if (!b || typeof b !== "object" || Array.isArray(b)) return [`${path}: not an object`];
		const [ka, kb] = [Object.keys(a), Object.keys(b)];
		return [
			...ka.filter((k) => !kb.includes(k)).map((k) => `${path}.${k}: missing`),
			...kb.filter((k) => !ka.includes(k)).map((k) => `${path}.${k}: not in en`),
			...ka.filter((k) => kb.includes(k)).flatMap((k) => sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`)),
		];
	}
	return typeof a === typeof b && (typeof b !== "string" || b.trim()) ? [] : [`${path}: empty or wrong type`];
}

const en = load("en");
const problems = LANGS.filter((l) => l !== "en").flatMap((l) => sameShape(en, load(l), l));
if (problems.length) {
	console.error(problems.join("\n"));
	process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "fonts"), { recursive: true });
for (const f of FONTS) cpSync(join(fontsource, f), join(dist, "fonts", f.split("/").pop()!));
cpSync(join(here, "assets"), join(dist, "assets"), { recursive: true });
cpSync(join(here, "..", "packages", "web", "public", "icons", "icon-192.png"), join(dist, "assets", "icon.png"));
for (const f of ["site.css", "site.js"]) cpSync(join(here, "src", f), join(dist, f));
for (const lang of LANGS) {
	const dir = lang === "en" ? dist : join(dist, lang);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "index.html"), render(load(lang), lang));
}
console.log(`website/dist: ${LANGS.length} pages`);
