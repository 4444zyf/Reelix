import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runOperation } from "../src/registry.ts";
import "../src/ops/index.ts";
import { tempApp, touch } from "./helpers.ts";

test("media.folders lists folders inside media_root and nothing outside it", async () => {
	const { app, root, media, library } = tempApp();
	app.setConfig("media_root", media);
	mkdirSync(join(media, ".hidden"));
	mkdirSync(join(media, "@eaDir"));
	touch(join(media, "a file.txt"));
	mkdirSync(join(root, "outside"));
	symlinkSync(join(root, "outside"), join(media, "escape"));
	symlinkSync(library, join(media, "lib-link"));
	const list = async (path?: string) => (await runOperation(app, "media.folders", path === undefined ? {} : { path }, { actor: "owner:test" })).output as any;

	const top = await list();
	assert.equal(top.path, media);
	assert.equal(top.parent, null);
	assert.deepEqual(top.folders.map((f: any) => f.name), ["lib-link", "library", "torrents"]);

	const lib = await list(join(media, "library"));
	assert.deepEqual(lib.folders.map((f: any) => f.name), ["Anime", "Movies", "Shows"]);
	assert.equal(lib.parent, media);
	assert.equal(lib.folders[1].path, join(media, "library", "Movies"));

	await assert.rejects(list(root), /outside the media folder/);
	await assert.rejects(list(join(media, "escape")), /outside the media folder/);
	await assert.rejects(list(join(media, "..", "outside")), /outside the media folder/);
	await assert.rejects(list(join(media, "missing")), /does not exist/);
});
