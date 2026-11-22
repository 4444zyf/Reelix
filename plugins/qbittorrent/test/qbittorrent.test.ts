import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { Reelix, doctor, kvSet, listInbox, runOperation } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { makeTorrent } from "../../../packages/core/test/fakes/bencode.ts";
import { tempApp } from "../../../packages/core/test/helpers.ts";
import { type FakeQbVersion, startFakeQb } from "./fake-qbittorrent.ts";

const PLUGIN = join(import.meta.dirname, "..");
const SEAM = "reelix:downloader@1";
const GB = 1_000_000_000;

async function world(o: { version?: FakeQbVersion; password?: string; url?: string } = {}) {
	const w = tempApp();
	const qb = await startFakeQb({ version: o.version, downloadsDir: w.downloads, password: "pw" });
	const t = await startPlugins([PLUGIN], { app: w.app, settings: { qbittorrent: { url: o.url ?? qb.url } }, secrets: { "plugins.qbittorrent.password": o.password ?? "pw" } });
	const p = () => t.app.seams.provider(SEAM, "qbittorrent")!;
	return {
		...w,
		qb,
		t,
		p,
		run: (name: string, input: unknown, actor = "agent:test") => runOperation(w.app, name, input, { actor }),
		async close() {
			await t.close();
			w.app.close();
			await qb.close();
		},
	};
}

const torrent = (name: string, files: [string, number][]) => makeTorrent(name, files.map(([path, length]) => ({ path: path.split("/"), length })));

for (const version of ["v4.6.7", "v5.0.2"] as const) {
	test(`qBittorrent ${version}: the transfer as the seam says it, paused add, files, marks, start and stop`, async () => {
		const w = await world({ version });
		try {
			const bytes = torrent("Show.S01", [["E01.mkv", 2 * GB], ["E02.mkv", 2 * GB], ["Sample/s.mkv", 1_000]]);
			const added = await w.p().call("add", [{ torrent: bytes }, { paused: true, mark: "reelix" }]);
			assert.ok(!("outcome" in added));
			const id = added.id;
			assert.equal(added.duplicate, false);
			const t = (await w.p().call("get", [id]))!;
			assert.deepEqual([t.state, t.hasMetadata, t.done, t.marks, t.folder, t.left], ["stopped", true, false, ["reelix"], "/downloads", 4 * GB + 1_000]);
			assert.equal(w.qb.calls.find((c) => c.path === "torrents/add")!.form[version.startsWith("v5") ? "stopped" : "paused"], "true");
			const files = await w.p().call("files", [id]);
			assert.deepEqual(files.map((f) => [f.index, f.path, f.wanted]), [[0, "Show.S01/E01.mkv", true], [1, "Show.S01/E02.mkv", true], [2, "Show.S01/Sample/s.mkv", true]]);
			await w.p().call("setWanted", [id, [2], false]);
			assert.equal((await w.p().call("get", [id]))!.size, 4 * GB, "size is the wanted data");
			await w.p().call("addMark", [[id], "reelix-filed"]);
			assert.deepEqual((await w.p().call("get", [id]))!.marks.sort(), ["reelix", "reelix-filed"], "existing marks stay");
			await w.p().call("start", [[id]]);
			assert.equal((await w.p().call("get", [id]))!.state, "downloading");
			await w.p().call("stop", [[id]]);
			assert.equal((await w.p().call("get", [id]))!.state, "stopped");
			const [wrongStart, wrongStop] = version.startsWith("v5") ? ["torrents/resume", "torrents/pause"] : ["torrents/start", "torrents/stop"];
			assert.ok(!w.qb.hits().includes(wrongStart) && !w.qb.hits().includes(wrongStop));
			w.qb.complete(id);
			const done = (await w.p().call("get", [id]))!;
			assert.deepEqual([done.done, done.left, done.progress, done.contentPath], [true, 0, 1, "/downloads/Show.S01"]);
			assert.ok(done.completedAt && !Number.isNaN(Date.parse(done.completedAt)));
			assert.deepEqual(await w.p().call("add", [{ torrent: bytes }, { paused: true, mark: "reelix" }]), { id, duplicate: true }, "qBittorrent already has it");
			assert.equal(w.qb.hits().filter((h) => h === "torrents/add").length, 1);
			await w.p().call("remove", [[id], { deleteFiles: true }]);
			assert.equal(await w.p().call("get", [id]), undefined);
			assert.equal(w.t.info("qbittorrent").failures, 0);
		} finally {
			await w.close();
		}
	});
}

test("an empty list never reaches qBittorrent, which would read it as every torrent", async () => {
	const w = await world();
	try {
		const id = w.qb.addOutside(torrent("Film", [["Film.mkv", GB]]));
		const before = w.qb.calls.length;
		assert.deepEqual(await w.p().call("list", [{ ids: [] }]), []);
		await w.p().call("start", [[]]);
		await w.p().call("stop", [[]]);
		await w.p().call("remove", [[], { deleteFiles: true }]);
		await w.p().call("addMark", [[], "reelix"]);
		await w.p().call("setWanted", [id, [], false]);
		assert.equal(w.qb.calls.length, before);
		assert.ok(w.qb.torrents.has(id));
	} finally {
		await w.close();
	}
});

test("a magnet before its metadata: no files, nothing to want; problems and the change feed", async () => {
	const w = await world();
	try {
		const hash = "f".repeat(40);
		const added = await w.p().call("add", [{ magnet: `magnet:?xt=urn:btih:${hash}&dn=Nobody` }, { paused: true, mark: "reelix" }]);
		assert.deepEqual(added, { id: hash, duplicate: false });
		const bare = (await w.p().call("get", [hash]))!;
		assert.deepEqual([bare.hasMetadata, bare.size, bare.left, bare.done], [false, 0, 0, false]);
		assert.deepEqual(await w.p().call("files", [hash]), []);

		const id = w.qb.addOutside(torrent("Film", [["Film.mkv", GB]]));
		const first = await w.p().call("changes", [undefined]);
		assert.equal(first.full, true);
		assert.deepEqual(first.changed.map((t) => t.id).sort(), [hash, id].sort());
		w.qb.torrents.get(id)!.trackerError = "unregistered torrent";
		w.qb.torrents.get(id)!.progress = 0.5;
		w.qb.removeOutside(hash);
		const next = await w.p().call("changes", [first.cursor]);
		assert.equal(next.full, false);
		assert.deepEqual([next.changed.map((t) => [t.id, t.progress]), next.removed], [[[id, 0.5]], [hash]]);
		assert.equal((await w.p().call("changes", ["12345"])).full, true, "a cursor that is not ours starts again");

		const tracker = (await w.p().call("get", [id]))!;
		assert.deepEqual([tracker.state, tracker.problem], ["downloading", { kind: "tracker", message: "unregistered torrent" }], "a tracker's message keeps the state");
		w.qb.torrents.get(id)!.failed = true;
		const local = (await w.p().call("get", [id]))!;
		assert.deepEqual([local.state, local.problem?.kind, local.done], ["error", "local", false]);
		assert.equal(await w.p().call("defaultFolder", []), "/downloads");
		assert.equal(await w.p().call("freeSpace", []), 500 * 1024 * 1024 * 1024);
	} finally {
		await w.close();
	}
});

test("a refused login and an unreachable qBittorrent are outcomes, not failures of the plugin", async () => {
	const w = await world({ password: "wrong" });
	try {
		await assert.rejects(w.p().call("list", [{}]), (e: any) => e.code === "needs_auth" && /^qBittorrent( \(qbittorrent\))?: refused the login/.test(e.message));
		const added = await w.p().call("add", [{ magnet: `magnet:?xt=urn:btih:${"e".repeat(40)}` }, { paused: true, mark: "reelix" }]);
		assert.deepEqual(added, { outcome: "needs_auth" });
		assert.equal(w.t.info("qbittorrent").failures, 0);
		assert.deepEqual(w.app.seams.outcomes(SEAM, "qbittorrent", "2000-01-01").map((o) => o.outcome), ["needs_auth", "needs_auth"]);
		const check = (await doctor(w.app, { quick: true })).find((c) => c.name === "qbittorrent")!;
		assert.equal(check.state, "failed");
		assert.match(check.raw!, /refused the login/);
		assert.deepEqual([check.cause.key, check.cause_id], ["qbittorrent:checks.login_refused", "qbittorrent:unreachable"]);
	} finally {
		await w.close();
	}
	const gone = await world({ url: "http://127.0.0.1:9" });
	try {
		await assert.rejects(gone.p().call("get", ["a".repeat(40)]), (e: any) => e.code === "unavailable");
		assert.equal(gone.t.info("qbittorrent").failures, 0);
	} finally {
		await gone.close();
	}
});

test("after a refused login no more logins are sent, until the owner tests the connection", async () => {
	const w = await world({ password: "wrong" });
	try {
		const logins = () => w.qb.calls.filter((c) => c.path === "auth/login").length;
		await assert.rejects(w.p().call("list", [{}]), (e: any) => e.code === "needs_auth");
		assert.equal(logins(), 1);
		for (let i = 0; i < 5; i++) assert.deepEqual(await w.p().call("add", [{ magnet: `magnet:?xt=urn:btih:${"e".repeat(40)}` }, { paused: true, mark: "reelix" }]), { outcome: "needs_auth" });
		await assert.rejects(w.p().call("list", [{}]), (e: any) => e.code === "needs_auth");
		assert.equal(logins(), 1, "the watcher's and the agent's calls send no login while it is refused");
		const check = (await doctor(w.app, { quick: true })).find((c) => c.name === "qbittorrent")!;
		assert.equal(check.state, "failed");
		assert.match(check.raw!, /refused the login.*sends no more logins until the username or password is changed/);
		assert.equal(check.impact?.text, "Downloads are paused: Reelix sends no more logins until the password changes or you test the connection.");
		assert.equal(logins(), 2, "the Doctor check tries once more");
		await assert.rejects(w.p().call("list", [{}]), (e: any) => e.code === "needs_auth");
		assert.equal(logins(), 2);
		const tested = (await w.run("plugin.check", { plugin: "qbittorrent" }, "owner:web")).output as { name: string; state: string }[];
		assert.deepEqual(tested.map((c) => [c.name, c.state]), [["qbittorrent", "failed"]]);
		assert.equal(logins(), 3, "Test connection allows exactly one more login");
		assert.equal(w.t.info("qbittorrent").lastCheck?.results[0]?.cause.key, "qbittorrent:checks.login_refused");
	} finally {
		await w.close();
	}
});

test("operations and the Doctor check go through the plugin; set_prefs is admin, the agent may, a plugin may not", async () => {
	const w = await world();
	try {
		const outside = w.qb.addOutside(torrent("Someone.Elses.Film", [["x.mkv", GB]]));
		assert.match((await w.run("qbittorrent.prefs", {})).text, /save_path: "\/downloads"/);
		assert.equal(w.app.operations.get("qbittorrent.set_prefs")!.effect, "admin");
		await w.run("qbittorrent.set_prefs", { prefs: { max_ratio: 2 } });
		assert.equal(w.qb.preferences.max_ratio, 2);
		await assert.rejects(w.run("qbittorrent.set_prefs", { prefs: { max_ratio: 3 } }, "plugin:other"), (e: any) => e.code === "owner_only");
		assert.match((await w.run("qbittorrent.torrents", { filter: "elses" })).text, /^1 torrents\n.*Someone\.Elses\.Film/);
		assert.equal(w.app.operations.get("qb.prefs"), undefined, "the old names are gone");
		const checks = await doctor(w.app, { quick: true });
		assert.match(checks.find((c) => c.name === "qbittorrent")!.raw!, /^qBittorrent v5\.0\.2 \(API 2\.11\.2\); saves to \/downloads$/);
		const d = checks.find((c) => c.name === "downloader")!;
		assert.equal(d.state, "failed", "no path map yet: /downloads is not a folder here");
		assert.deepEqual(d.action, { label: { key: "actions.set_path_map" }, anchor: "field-path_maps.downloaders.qbittorrent" });
		w.app.setConfig("path_maps.downloaders.qbittorrent", [{ theirs: "/downloads", ours: w.downloads }]);
		const mapped = (await doctor(w.app, { quick: true })).find((c) => c.name === "downloader")!;
		assert.deepEqual([mapped.state, mapped.raw], ["passed", `qBittorrent (qbittorrent) saves to /downloads (${w.downloads} here)`], "a plugin from a folder, so its label names it");
		// A finished download is where the path map says: the same folder on both sides.
		w.qb.complete(outside);
		assert.equal((await doctor(w.app, { quick: true })).find((c) => c.name === "downloader")!.state, "passed");
		// The same path names another folder here (both sides "/downloads", two disks): its downloads are not there.
		const elsewhere = join(w.downloads, "..", "another-disk");
		mkdirSync(elsewhere, { recursive: true });
		w.app.setConfig("path_maps.downloaders.qbittorrent", [{ theirs: "/downloads", ours: elsewhere }]);
		const other = (await doctor(w.app, { quick: true })).find((c) => c.name === "downloader")!;
		assert.deepEqual([other.state, other.cause.key, other.action], ["failed", "downloader_other_folder", { label: { key: "actions.set_path_map" }, anchor: "field-path_maps.downloaders.qbittorrent" }]);
	} finally {
		await w.close();
	}
});

test("the active downloader is the owner's choice; when it is not running, downloads fail clearly and Reelix does not switch", async () => {
	const w = await world();
	try {
		const listed = (await w.run("download.downloaders", {})).output as any;
		assert.deepEqual([listed.active, listed.running, listed.providers.map((p: any) => p.id)], ["qbittorrent", true, ["qbittorrent"]]);
		await assert.rejects(w.run("config.set", { path: "downloader", value: "other" }), (e: any) => e.code === "owner_only", "not the agent's");
		await w.run("config.set", { path: "downloader", value: "other" }, "owner:web");
		await assert.rejects(w.run("download.add", { magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}` }), (e: any) => e.code === "no_downloader" && /"other" is not available: no plugin provides/.test(e.message) && /Other downloaders: qbittorrent; only the owner/.test(e.message));
		assert.equal(w.qb.calls.length, 0, "nothing reached qBittorrent");
		w.app.setConfig("downloader", "qbittorrent");
		await w.t.manager.disable("qbittorrent");
		await assert.rejects(w.run("download.status", {}).then(() => w.run("download.pause", { hash: "a".repeat(40) })), (e: any) => e.code === "no_downloader" && /its plugin is disabled/.test(e.message));
	} finally {
		await w.close();
	}
});

test("without an address: no downloader, and the check and the operations say what to set", async () => {
	const w = tempApp();
	const t = await startPlugins([PLUGIN], { app: w.app });
	try {
		assert.equal(t.info("qbittorrent").state, "active");
		assert.equal(t.app.seams.providers(SEAM).length, 0);
		const checks = await doctor(w.app, { quick: true });
		assert.equal(checks.some((c) => c.name === "downloader"), false, "the downloader check and the plugin's see one cause");
		const check = checks.find((c) => c.name === "qbittorrent")!;
		assert.deepEqual([check.state, check.cause_id, check.also, check.raw], ["failed", "qbittorrent:setup", ["downloader"], "not configured"]);
		await assert.rejects(runOperation(w.app, "qbittorrent.prefs", {}, { actor: "owner:web" }), /plugins\.qbittorrent\.url/);
		await assert.rejects(runOperation(w.app, "download.add", { magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}` }, { actor: "owner:web" }), /its plugin is running but offers no downloader/);
	} finally {
		await t.close();
		w.app.close();
	}
});

test("an old data folder moves once: address, user, password, path map, the open notice, and each download's downloader", () => {
	const w = tempApp();
	w.app.db.prepare("INSERT INTO downloads (hash, name, state, added_at, downloader) VALUES (?, 'Old', 'downloading', datetime('now'), NULL)").run("a".repeat(40));
	kvSet(w.app.db, "unrelated", "stays");
	w.app.close();
	const data = join(w.root, "data");
	writeFileSync(join(data, "config.yaml"), `downloads: ${w.downloads}\nqbittorrent:\n  url: http://qb:8080\n  username: nas\npath_maps:\n  qbittorrent:\n    - theirs: /downloads\n      ours: /media/torrents\n  jellyfin: []\n`);
	mkdirSync(data, { recursive: true });
	writeFileSync(join(data, "secrets.yaml"), "qbittorrent:\n  password: old-secret-password\n");
	// The database as phase 5 left it: no downloader column, and an open "unreachable" notice under the old key.
	const db = new DatabaseSync(join(data, "reelix.db"));
	db.exec("ALTER TABLE downloads DROP COLUMN downloader; ALTER TABLE titles DROP COLUMN ratings_json; ALTER TABLE titles ADD COLUMN douban_rating REAL; ALTER TABLE titles DROP COLUMN original_language; ALTER TABLE titles DROP COLUMN origin_country_json; ALTER TABLE titles DROP COLUMN genres_json; ALTER TABLE titles DROP COLUMN library_choice; ALTER TABLE job_runs DROP COLUMN models_json; UPDATE schema_version SET v = 9;");
	db.prepare("INSERT INTO inbox (id, kind, title, status, payload_json, created_at) VALUES ('in_old', 'notice', 'qBittorrent is unreachable', 'open', ?, datetime('now'))").run(JSON.stringify({ dedupeKey: "qb-unreachable" }));
	db.close();

	const app = new Reelix(data);
	try {
		assert.deepEqual(app.config.plugins.qbittorrent, { url: "http://qb:8080", username: "nas" });
		assert.deepEqual(app.config.path_maps.downloaders, { qbittorrent: [{ theirs: "/downloads", ours: "/media/torrents" }] });
		assert.equal(app.config.downloader, "qbittorrent");
		assert.equal(app.secrets["plugins.qbittorrent.password"], "old-secret-password");
		assert.equal(app.secrets["qbittorrent.password"], undefined);
		assert.equal(app.getConfig("qbittorrent"), undefined, "the old keys are gone");
		assert.equal(app.getConfig("path_maps.qbittorrent"), undefined);
		assert.equal((app.db.prepare("SELECT downloader FROM downloads").get() as { downloader: string }).downloader, "qbittorrent");
		assert.equal(listInbox(app).find((i) => i.id === "in_old")?.payload.dedupeKey, "downloader-unreachable:qbittorrent");
	} finally {
		app.close();
	}
	const again = new Reelix(data);
	try {
		assert.deepEqual(again.config.plugins.qbittorrent, { url: "http://qb:8080", username: "nas" }, "a second start changes nothing");
	} finally {
		again.close();
	}
});
