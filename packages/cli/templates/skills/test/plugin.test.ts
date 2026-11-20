import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkPluginFolder } from "@reelix/plugin-testing";

const PLUGIN = join(import.meta.dirname, "..");

test("reelix plugin check passes", async () => {
	const r = await checkPluginFolder(PLUGIN);
	assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test("every skill says what it is for, so the agent knows when to read it", () => {
	for (const name of readdirSync(join(PLUGIN, "skills"))) {
		const text = readFileSync(join(PLUGIN, "skills", name, "SKILL.md"), "utf8");
		assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: .{20,}\\n`), name);
	}
});
