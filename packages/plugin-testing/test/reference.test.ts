import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { HOOK_DECLARATIONS, PLUGIN_EVENTS, SEAM_DECLARATIONS } from "@reelix/core";
import { CONTEXT_CALLS } from "@reelix/server/plugins/context.ts";
import { REFERENCE_FILE, contextMembers, renderReference, settingsCopies } from "../../../scripts/plugin-reference.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

/** Every .ts file under a folder, without tests and dependencies. */
function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" || e.name === "test" ? [] : sourceFiles(p);
		return e.name.endsWith(".ts") ? [p] : [];
	});
}

const pluginDirs = [join(ROOT, "plugins"), join(ROOT, "plugins/examples")].flatMap((root) => readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(root, e.name))).filter((d) => existsSync(join(d, "package.json")));
// A skill pack has no src.
const pluginCode = pluginDirs.flatMap((d) => (existsSync(join(d, "src")) ? sourceFiles(join(d, "src")) : [])).map((f) => readFileSync(f, "utf8")).join("\n");
const manifests = pluginDirs.map((d) => JSON.parse(readFileSync(join(d, "package.json"), "utf8")).reelix as { uses?: Record<string, string[]> });
const declaredBy = (key: string) => new Set(manifests.flatMap((m) => m.uses?.[key] ?? []));
const coreCode = ["packages/core/src", "packages/server/src"].flatMap((d) => sourceFiles(join(ROOT, d))).map((f) => readFileSync(f, "utf8")).join("\n");

test("docs/plugin-reference.md is what the code generates (npm run plugin-reference)", () => {
	assert.equal(readFileSync(REFERENCE_FILE, "utf8"), renderReference());
});

test("each plugin's settings.schema.json is its code's settings schema (npm run plugin-reference)", async () => {
	const copies = await settingsCopies();
	assert.ok(copies.some((c) => c.dir.endsWith("finished-cleanup")));
	for (const c of copies) assert.equal(readFileSync(c.file, "utf8"), c.expected, c.file);
});

test("the list of context calls is the type plugins compile against", () => {
	assert.deepEqual(Object.keys(CONTEXT_CALLS).sort(), [...contextMembers().keys()].sort());
});

test("every context call is used by a plugin", () => {
	for (const call of Object.keys(CONTEXT_CALLS)) assert.ok(new RegExp(`\\b${call.replace(/\./g, "\\.")}\\b`).test(pluginCode), `${call} has no user in plugins/`);
});

test("every seam has a provider in plugins/ and a call site in core", () => {
	const provided = declaredBy("provides");
	for (const { id } of SEAM_DECLARATIONS) {
		assert.ok(provided.has(id), `${id} has no provider`);
		assert.ok(coreCode.split(`"${id}"`).length > 2, `${id} is not used by core beyond its declaration`);
	}
});

test("every hook has a plugin that uses it and a call site in core", () => {
	const used = declaredBy("hooks");
	for (const { id } of HOOK_DECLARATIONS) {
		assert.ok(used.has(id), `${id} has no plugin`);
		const calls = coreCode.match(new RegExp(`(?:hooks\\.(?:each|pipeline)\\(\\s*|(?:const [A-Z]+ = ))"${id.replace(/\./g, "\\.")}"`, "g"));
		assert.ok(calls?.length, `${id} is never called`);
	}
});

test("every event is emitted by core and has a listener", () => {
	const listened = declaredBy("events");
	for (const event of PLUGIN_EVENTS) {
		assert.ok(coreCode.includes(`pluginEvents.emit("${event}"`), `${event} is never emitted`);
		assert.ok(listened.has(event) || coreCode.includes(`pluginEvents.on("${event}"`), `${event} has no listener`);
	}
});

test("every seam and event a plugin owns has a provider or listener in plugins/, which requires the owner", () => {
	const all = manifests as { id: string; owns?: { seams?: Record<string, unknown>; events?: Record<string, unknown> }; requires?: { plugins?: Record<string, string> }; uses?: Record<string, string[]> }[];
	const owned = all.flatMap((m) => [...Object.keys(m.owns?.seams ?? {}).map((id) => ({ id, key: "provides" })), ...Object.keys(m.owns?.events ?? {}).map((id) => ({ id, key: "events" }))]);
	assert.ok(owned.length, "the reference plugins own a seam and an event");
	for (const { id, key } of owned) {
		const users = all.filter((m) => m.uses?.[key]?.includes(id));
		assert.ok(users.length, `${id} has no ${key === "provides" ? "provider" : "listener"}`);
		for (const u of users) assert.ok(u.requires?.plugins?.[id.split(":")[0]!], `${u.id} uses ${id} without requiring its owner`);
	}
});
