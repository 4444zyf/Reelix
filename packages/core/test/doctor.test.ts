import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type Check, type FolderCheck, checksToText, doctor, mergeShared } from "../src/doctor.ts";
import { runOperation } from "../src/registry.ts";
import "../src/ops/index.ts";
import { tempApp, touch } from "./helpers.ts";

const folderChecks = async (app: ReturnType<typeof tempApp>["app"], path?: string) => (await runOperation(app, "media.folder_checks", path === undefined ? {} : { path }, { actor: "owner:test" })).output as FolderCheck[];

test("results with a shared cause are shown once: the most serious, where the first stood", () => {
	const c = (name: string, state: Check["state"], cause_id?: string): Check => ({ name, state, cause: { key: name }, cause_id });
	const merged = mergeShared([c("media server", "not_used", "jellyfin:setup"), c("tools", "passed"), c("jellyfin", "failed", "jellyfin:setup"), c("other", "failed", "x:setup")]);
	assert.deepEqual(
		merged.map((m) => [m.name, m.state, m.also]),
		[
			["jellyfin", "failed", ["media server"]],
			["tools", "passed", undefined],
			["other", "failed", undefined],
		],
	);
	const tie = mergeShared([c("downloader", "failed", "qb:setup"), c("qbittorrent", "failed", "qb:setup")]);
	assert.deepEqual([tie.length, tie[0]!.name, tie[0]!.also], [1, "qbittorrent", ["downloader"]], "on a tie the later one, a plugin's, speaks");
});

test("Doctor returns structured results: states, keys, actions, details; the command line reads English", async () => {
	const { app, downloads } = tempApp();
	let checks = await doctor(app, { quick: true });
	const by = (name: string) => checks.find((c) => c.name === name)!;
	assert.deepEqual([by("folders").state, by("folders").cause], ["passed", { key: "folders_ok", values: { count: 3 } }]);
	assert.deepEqual([by("hard link").state, by("hard link").cause.key], ["not_tested", "hardlink_no_sample"], "no file to test with is not a pass");
	assert.deepEqual(by("tmdb"), {
		name: "tmdb",
		state: "failed",
		cause: { key: "tmdb_no_key" },
		impact: { key: "impact.tmdb_off" },
		action: { label: { key: "actions.add_key" }, anchor: "secret-tmdb.api_key" },
		cli: "reelix secret set tmdb.api_key",
		raw: "no API key",
		cause_id: "tmdb.api_key",
	});
	assert.equal(by("plugins").state, "skipped");
	for (const t of checks.filter((c) => c.name === "tools")) {
		assert.ok(t.state === "passed" || (t.state === "degraded" && t.impact && t.cause_id?.startsWith("tool:")), "a missing tool is degraded, with what stops working");
	}
	assert.ok(!checks.some((c) => "ok" in c || "detail" in c), "no English text in place of a cause");
	const text = checksToText(checks);
	assert.match(text, /^FAIL tmdb: no API key\n {6}fix: reelix secret set tmdb\.api_key$/m);
	assert.match(text, /^-- {3}hard link \(not tested\): no file in /m);

	touch(join(downloads, "Film.2020", "film.mkv"));
	checks = await doctor(app, { quick: true });
	assert.deepEqual([by("hard link").state, by("hard link").cause], ["passed", { key: "hardlink_ok", values: { count: 3 } }]);

	app.setConfig("library.movies", [{ path: join(downloads, "..", "nowhere") }]);
	checks = await doctor(app, { quick: true });
	assert.deepEqual([by("folders").state, by("folders").cause, by("folders").action], ["failed", { key: "folders_missing", values: { count: 1 } }, { label: { key: "actions.open_folders" }, anchor: "folders" }]);
});

test("media.folder_checks: four results per folder; no sample is not tested; the media server is never a pass when not connected", async () => {
	const { app, root, media, downloads, library } = tempApp();
	app.setConfig("media_root", media);
	let all = await folderChecks(app);
	assert.deepEqual(all.map((f) => [f.kind, f.label]), [["downloads", "downloads"], ["library", "movies"], ["library", "shows"], ["library", "anime"]]);
	const movies = all[1]!;
	assert.deepEqual([movies.exists.state, movies.writable.state, movies.hardlink.state, movies.hardlink.cause.key], ["passed", "passed", "not_tested", "folder.no_sample"]);
	assert.deepEqual(movies.media_server, { state: "skipped", cause: { key: "folder.server_unverified", values: { server: "Jellyfin" } } }, "not verified: Jellyfin is not connected");
	assert.equal(all[0]!.media_server.state, "not_used", "the media server need not see the downloads");

	touch(join(downloads, "x.mkv"));
	all = await folderChecks(app, join(library, "Shows"));
	assert.deepEqual([all.length, all[0]!.label, all[0]!.hardlink.state, all[0]!.hardlink.cause.key], [1, "shows", "passed", "folder.link_ok"]);

	const fresh = join(media, "library", "New");
	const unsaved = await folderChecks(app, fresh);
	assert.deepEqual([unsaved[0]!.kind, unsaved[0]!.exists.state, unsaved[0]!.writable.state, unsaved[0]!.hardlink.state], ["other", "failed", "skipped", "skipped"]);
	mkdirSync(fresh);
	assert.equal((await folderChecks(app, fresh))[0]!.hardlink.state, "passed");
	await assert.rejects(folderChecks(app, join(root, "data")), /outside the media folder/);
});

test("every message key Reelix's Doctor uses has words in the web UI's doctor strings", () => {
	const source = readFileSync(join(import.meta.dirname, "../src/doctor.ts"), "utf8");
	const en = JSON.parse(readFileSync(join(import.meta.dirname, "../../web/src/locales/en/doctor.json"), "utf8"));
	const has = (key: string) => {
		let node = en;
		for (const part of key.split(".")) node = node?.[part];
		const last = key.split(".").at(-1)!;
		const parent = key.split(".").slice(0, -1).reduce((n: any, p) => n?.[p], en);
		return typeof node === "string" || typeof parent?.[`${last}_other`] === "string";
	};
	const keys = [...source.matchAll(/msg\("([a-z_.]+)"/g)].map((m) => m[1]!);
	keys.push(...[...source.matchAll(/open\([^,]+, "([a-z_]+)"\)/g)].map((m) => `actions.${m[1]}`));
	for (const kind of ["downloader", "media_server"]) keys.push(`${kind}_setup`, `${kind}_missing`, `${kind}_not_running`, `impact.${kind}_off`);
	for (const link of ["cross_device", "denied", "failed"]) keys.push(`folder.link_${link}`, `hardlink_${link}`);
	keys.push("check_passed", "check_not_run", "actions.run", "tmdb_ok_proxy");
	assert.ok(keys.length > 50);
	assert.deepEqual(keys.filter((k) => !has(k)), []);
});
