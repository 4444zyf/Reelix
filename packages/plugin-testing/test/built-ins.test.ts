import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { LANGUAGES } from "@reelix/core";
import { readFileSync } from "node:fs";
import { checkPluginFolder } from "../src/index.ts";

const ROOT = resolve(import.meta.dirname, "../../../plugins");
const folders = (dir: string) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)).filter((d) => existsSync(join(d, "package.json")));
const ALL = [...folders(ROOT), ...folders(join(ROOT, "examples"))];

test("the plugins are found", () => assert.ok(ALL.length >= 5, ALL.join()));

for (const dir of ALL) {
	const name = dir.slice(ROOT.length + 1);
	test(`reelix plugin check: ${name}`, async () => {
		const r = await checkPluginFolder(dir);
		assert.deepEqual([r.errors, r.warnings], [[], []]);
	});

	test(`every language has every string: ${name}`, () => {
		const flat = (o: Record<string, unknown>, prefix = ""): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v !== null ? flat(v as Record<string, unknown>, `${prefix}${k}/`) : [`${prefix}${k}`]));
		const read = (l: string) => flat(JSON.parse(readFileSync(join(dir, "locales", `${l}.json`), "utf8")));
		const stem = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, "");
		const keys = new Set(read("en").map(stem));
		for (const l of LANGUAGES) {
			const have = new Set(read(l).map(stem));
			assert.deepEqual([...have].sort(), [...keys].sort(), l);
		}
	});
}
