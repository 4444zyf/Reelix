import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { type PluginDefinition, isPluginDefinition } from "@reelix/plugin";

/**
 * TypeScript without a build step, with `@reelix/plugin` always mapped to Reelix's own copy
 * (docs/plugins.md §13.1). Nothing is cached, so switching a failed plugin on again reads it anew.
 * It imports nothing of Reelix beyond `@reelix/plugin`: a plugin's own process loads it too (§11.7).
 */
const jiti = createJiti(import.meta.url, {
	alias: { "@reelix/plugin": fileURLToPath(import.meta.resolve("@reelix/plugin")) },
	moduleCache: false,
	fsCache: false,
	interopDefault: false,
});

/** Load the loader's own modules (its TypeScript compiler) now: a plugin's process does this before it refuses modules (§11.7). */
export function prepareLoader(): void {
	jiti.transform({ source: "export const ready: boolean = true;", filename: "prepare.ts", ts: true });
}

/** Load the entry file. It must have exactly one export: the default `definePlugin(...)`. */
export async function loadPlugin(dir: string, entry: string): Promise<PluginDefinition> {
	const root = realpathSync(dir);
	const file = realpathSync(join(root, entry));
	if (!file.startsWith(root + sep)) throw new Error("the entry file is outside the plugin's folder");
	if (file.split(sep).includes("node_modules")) throw new Error("a plugin's entry cannot be under node_modules");
	const mod = (await jiti.import(file)) as Record<string, unknown>;
	const names = Object.keys(mod);
	if (names.length !== 1 || names[0] !== "default") throw new Error(`the entry file must have exactly one export, the default; it has: ${names.join(", ") || "none"}`);
	if (!isPluginDefinition(mod.default)) throw new Error("the default export must be the result of definePlugin()");
	return mod.default;
}
