// Checks src/locales/<lang>/<ns>.json against English: same keys, the plural forms each language
// needs (Intl.PluralRules), the same {{placeholders}}, no empty strings. Exit 1 on any problem.
//   node scripts/check-locales.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../src/locales/", import.meta.url).pathname;
const REF = "en";
const PLURAL = /_(zero|one|two|few|many|other)$/;
const langs = readdirSync(dir).filter((d) => !d.startsWith("."));
const namespaces = readdirSync(join(dir, REF)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

function flat(o, pre = "", out = {}) {
	for (const [k, v] of Object.entries(o)) {
		const key = pre ? `${pre}.${k}` : k;
		if (v && typeof v === "object") flat(v, key, out);
		else out[key] = v;
	}
	return out;
}
const vars = (s) => [...String(s).matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort().join(",");
/** base key → { forms: Set, sample value } */
function group(entries) {
	const g = new Map();
	for (const [k, v] of Object.entries(entries)) {
		const m = PLURAL.exec(k);
		const base = m ? k.slice(0, -m[0].length) : k;
		const e = g.get(base) ?? { forms: new Set(), plural: false, values: [] };
		if (m) {
			e.plural = true;
			e.forms.add(m[1]);
		}
		e.values.push(v);
		g.set(base, e);
	}
	return g;
}

let problems = 0;
const say = (m) => {
	problems++;
	console.log(m);
};
for (const ns of namespaces) {
	const load = (l) => {
		try {
			return flat(JSON.parse(readFileSync(join(dir, l, `${ns}.json`), "utf8")));
		} catch (e) {
			say(`${l}/${ns}.json: ${e.code === "ENOENT" ? "missing" : e.message}`);
			return {};
		}
	};
	const ref = group(load(REF));
	for (const l of langs) {
		const cats = new Intl.PluralRules(l).resolvedOptions().pluralCategories;
		const g = group(load(l));
		for (const [base, e] of ref) {
			const o = g.get(base);
			if (!o) {
				say(`${l}/${ns}: missing ${base}`);
				continue;
			}
			if (e.plural !== o.plural) say(`${l}/${ns}: ${base} is ${e.plural ? "" : "not "}plural in ${REF}`);
			if (e.plural) for (const c of cats) if (!o.forms.has(c)) say(`${l}/${ns}: ${base}_${c} missing (${l} plural forms: ${cats.join(", ")})`);
			const want = vars(e.values.at(-1)).replace(/(^|,)count(,|$)/, "$1$2");
			for (const v of o.values) {
				if (typeof v === "string" && !v.trim()) say(`${l}/${ns}: ${base} is empty`);
				const got = vars(v).replace(/(^|,)count(,|$)/, "$1$2");
				if (got !== want) say(`${l}/${ns}: ${base} placeholders {${got}} differ from ${REF} {${want}}`);
			}
		}
		for (const base of g.keys()) if (!ref.has(base)) say(`${l}/${ns}: ${base} is not in ${REF}`);
	}
}
console.log(problems ? `${problems} problem(s) in the locale files.` : `Locales OK: ${langs.join(", ")} × ${namespaces.length} namespaces.`);
process.exit(problems ? 1 : 0);
