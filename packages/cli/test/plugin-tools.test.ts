import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkPluginFolder } from "@reelix/plugin-testing";
import { PLUGIN_KINDS, writePlugin } from "../src/plugin-tools.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const CLI = join(REPO, "packages/cli/src/main.ts");

/** Every template passes the checker and its own tests as soon as it is written (docs/plugins.md §14.2). */
for (const kind of Object.keys(PLUGIN_KINDS)) {
	test(`reelix plugin new --kind ${kind}: the checker and its own tests pass at once`, async () => {
		const root = mkdtempSync(join(tmpdir(), "reelix-new-"));
		try {
			const dir = join(root, `my-${kind}`);
			const written = writePlugin(kind, `my-${kind}`, dir);
			for (const f of ["package.json", "README.md", "AGENTS.md"]) assert.ok(written.includes(f), f);
			assert.ok(written.some((f) => f.startsWith("test/") && f.endsWith(".test.ts")), "it has a test");
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			assert.equal(pkg.reelix.id, `my-${kind}`);
			assert.equal(pkg.private, undefined, "it can be published");
			const old = JSON.parse(readFileSync(join(PLUGIN_KINDS[kind]!.from ? join(REPO, PLUGIN_KINDS[kind]!.from!) : join(REPO, "packages/cli/templates", kind), "package.json"), "utf8")).reelix.id;
			// Only the README names the recipe it came from.
			for (const f of written.filter((x) => x !== "README.md")) assert.ok(!readFileSync(join(dir, f), "utf8").includes(old) && !f.includes(old), `${f} still names ${old}`);

			const r = await checkPluginFolder(dir);
			assert.deepEqual([r.errors, r.warnings], [[], []]);
			const own = spawnSync(process.execPath, ["--no-warnings", "--test", "test/**/*.test.ts"], { cwd: dir, encoding: "utf8", timeout: 120_000 });
			assert.equal(own.status, 0, own.stdout + own.stderr);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("reelix plugin new refuses Reelix's own folder, a taken or invalid id, and a folder that is not empty", () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-new-"));
	try {
		assert.throws(() => writePlugin("filter", "my-filter", join(REPO, "plugins", "my-filter")), /inside Reelix's own folder/);
		assert.throws(() => writePlugin("filter", "jackett", join(root, "a")), /taken/);
		assert.throws(() => writePlugin("filter", "download", join(root, "a")), /taken/, "the first word of a core operation");
		assert.throws(() => writePlugin("filter", "My Filter", join(root, "a")), /not a valid plugin id/);
		assert.throws(() => writePlugin("widget", "my-widget", join(root, "a")), /no kind "widget"/);
		writeFileSync(join(root, "note.txt"), "x");
		assert.throws(() => writePlugin("filter", "my-filter", root), /not empty/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reelix plugin check: a broken plugin fails with the reason and a non-zero exit; without a terminal plugin new needs its answers", () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-new-"));
	try {
		const dir = join(root, "broken");
		writePlugin("indexer", "broken", dir);
		// The tracker's search answer changed shape: the recorded answer no longer gives the hit.
		const check = join(dir, "test/check.ts");
		writeFileSync(check, readFileSync(check, "utf8").replace("expectHits: 1", "expectHits: 2"));
		const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { encoding: "utf8", input: "", env: { ...process.env, REELIX_DATA: join(root, "no-data") } });
		const r = run("plugin", "check", dir);
		assert.equal(r.status, 1, r.stdout + r.stderr);
		assert.match(r.stdout, /FAIL {2}reelix:indexer@1 conformance suite \(broken\): the recorded answer's hits/);
		assert.match(r.stdout, /Failed: 1 problem\./);

		writeFileSync(join(dir, "src/index.ts"), readFileSync(join(dir, "src/index.ts"), "utf8").replace('await ctx.provide("reelix:indexer@1"', 'await ctx.provide("reelix:notifier@1" as never'));
		assert.match(run("plugin", "check", dir).stdout, /FAIL {2}broken did not start: failed: .*reelix:notifier@1/);

		const asked = run("plugin", "new", join(root, "x"));
		assert.equal(asked.status, 1);
		assert.match(asked.stderr, /give --kind .* and --id/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
