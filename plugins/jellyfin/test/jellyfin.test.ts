import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Reelix, doctor, forgetWatchHistory, runOperation, tellMediaServer, watchHistory } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { tempApp } from "../../../packages/core/test/helpers.ts";
import { startFakeJellyfin } from "./fake-jellyfin.ts";

const PLUGIN = join(import.meta.dirname, "..");
const SEAM = "reelix:media.server@1";

async function world(o: { legacy?: boolean; key?: string } = {}) {
	const w = tempApp();
	const jf = await startFakeJellyfin({
		legacy: o.legacy,
		watch: [{ user: "owner", type: "Movie", name: "Sintel", year: 2010, tmdb: 45745, plays: 1 }],
		folders: [{ name: "Films", paths: ["/data/media/library/Movies"] }, { name: "Shows", paths: ["/data/media/library/Shows", "/data/media/library/Anime"] }],
	});
	w.app.setConfig("path_maps.media_servers.jellyfin", [{ theirs: "/data/media", ours: w.media }]);
	const t = await startPlugins([PLUGIN], { app: w.app, settings: { jellyfin: { url: jf.url } }, secrets: { "plugins.jellyfin.api_key": o.key ?? jf.apiKey } });
	return {
		...w,
		jf,
		t,
		async close() {
			await t.close();
			w.app.close();
			await jf.close();
		},
	};
}

test("filing tells Jellyfin about each folder as it names it; a refused update falls back to a full scan", async () => {
	const w = await world();
	try {
		const film = join(w.library, "Movies", "Sintel (2010) [tmdbid-45745]", "Sintel (2010) [tmdbid-45745].mkv");
		assert.equal(await tellMediaServer(w.app, [film, `${film.slice(0, -4)}.zh.srt`]), "Told Jellyfin (jellyfin) about 1 path(s).");
		assert.deepEqual(w.jf.updates, [{ Updates: [{ Path: "/data/media/library/Movies/Sintel (2010) [tmdbid-45745]", UpdateType: "Created" }] }], "one folder, in Jellyfin's view, through the path map");
		await tellMediaServer(w.app, [film], "deleted");
		assert.deepEqual((w.jf.updates[1] as { Updates: { UpdateType: string }[] }).Updates[0]!.UpdateType, "Deleted");
		assert.equal(w.t.info("jellyfin").failures, 0);
	} finally {
		await w.close();
	}
	const refused = await world({ key: "wrong-key" });
	try {
		await assert.rejects(tellMediaServer(refused.app, [join(refused.library, "Movies", "X (2020)", "X.mkv")]), /refused the login or key/, "a refused key is said as it is, after trying the full scan");
		assert.equal(refused.t.info("jellyfin").failures, 0, "a refused key is an outcome, not a failure of the plugin");
	} finally {
		await refused.close();
	}
});

test("jellyfin.refresh asks for a full scan; Doctor checks the server and whether it holds Reelix's library folders", async () => {
	const w = await world();
	try {
		const r = await runOperation(w.app, "jellyfin.refresh", {}, { actor: "agent:test" });
		assert.equal(r.text, "Full library scan requested.");
		assert.deepEqual(w.jf.updates, ["refresh"]);
		const checks = await doctor(w.app, { quick: true });
		assert.equal(checks.find((c) => c.name === "jellyfin")?.raw, `fake 10.10.7 at ${w.jf.url}`);
		const line = checks.find((c) => c.name === "media server")!;
		assert.equal(line.state, "passed", line.raw);
		assert.match(line.raw!, /Films=\/data\/media\/library\/Movies/);
		w.app.setConfig("path_maps.media_servers.jellyfin", []);
		const unmapped = (await doctor(w.app, { quick: true })).find((c) => c.name === "media server")!;
		assert.equal(unmapped.state, "failed");
		assert.equal(unmapped.cause.key, "media_server_unseen");
		assert.deepEqual(unmapped.action, { label: { key: "actions.set_path_map" }, anchor: "field-path_maps.media_servers.jellyfin" });
		assert.match(unmapped.raw!, /No library of Jellyfin \(jellyfin\) holds movie/);
		assert.match(unmapped.cli!, /path_maps\.media_servers\.jellyfin/);
		const folders = (await runOperation(w.app, "media.folder_checks", {}, { actor: "owner:web" })).output as { kind: string; media_server: { state: string } }[];
		assert.ok(folders.some((f) => f.kind === "library" && f.media_server.state === "failed"), "the folder checks see the same");
	} finally {
		await w.close();
	}
});

test("not set up: no provider, filing goes on, Doctor says so, the operation refuses", async () => {
	const w = tempApp();
	const t = await startPlugins([PLUGIN], { app: w.app });
	try {
		assert.equal(t.info("jellyfin").state, "active");
		assert.equal(w.app.seams.providers(SEAM).length, 0);
		assert.equal(await tellMediaServer(w.app, ["/x/y.mkv"]), "No media server is set up.");
		assert.equal(await watchHistory(w.app), undefined);
		const checks = await doctor(w.app, { quick: true });
		assert.equal(checks.some((c) => c.name === "media server"), false, "one cause, shown once");
		const line = checks.find((c) => c.name === "jellyfin")!;
		assert.deepEqual([line.state, line.cause.key, line.cause_id, line.also], ["not_used", "jellyfin:checks.not_set_up", "jellyfin:setup", ["media server"]]);
		w.app.setConfig("plugins.jellyfin", { url: "http://127.0.0.1:9" });
		let noKey = (await doctor(w.app, { quick: true })).find((c) => c.name === "jellyfin")!;
		for (let i = 0; i < 200 && noKey?.state !== "failed"; i++) {
			await new Promise((r) => setTimeout(r, 10));
			noKey = (await doctor(w.app, { quick: true })).find((c) => c.name === "jellyfin")!;
		}
		assert.deepEqual([noKey.state, noKey.cause.text, noKey.also], ["failed", "Jellyfin API key missing", ["media server"]]);
		assert.deepEqual(noKey.action, { label: { key: "jellyfin:checks.add_key", text: "Add the key" }, anchor: "secret-plugins.jellyfin.api_key" });
		const folders = (await runOperation(w.app, "media.folder_checks", {}, { actor: "owner:web" })).output as { kind: string; media_server: { state: string; cause: { key: string; values: unknown } } }[];
		const lib = folders.find((f) => f.kind === "library")!;
		assert.deepEqual([lib.media_server.state, lib.media_server.cause], ["skipped", { key: "folder.server_unverified", values: { server: "Jellyfin" } }], "never a pass while it is not connected");
		await assert.rejects(runOperation(w.app, "jellyfin.refresh", {}, { actor: "owner:web" }), /Settings → Plugins → jellyfin/);
		await assert.rejects(runOperation(w.app, "config.set", { path: "media_server", value: "plex" }, { actor: "agent:test" }), (e: { code?: string }) => e.code === "owner_only" || e.code === "needs_owner" || /owner/.test(String(e)), "the active media server is the owner's choice");
	} finally {
		await t.close();
		w.app.close();
	}
});

test("watch history: older Jellyfin servers answer only /Users/{id}/Items", async () => {
	const w = await world({ legacy: true });
	try {
		forgetWatchHistory();
		const h = (await watchHistory(w.app))!;
		assert.deepEqual(h.users, ["owner"], "a single user is used whatever their role");
		assert.deepEqual(h.titles.map((x) => x.name), ["Sintel"]);
		assert.ok(w.jf.requests.some((r) => r.includes("/Users/u1/Items")));
	} finally {
		await w.close();
	}
});

test("an old data folder moves once: address, public address, whose history, API key, path map, Bangumi's address; the environment fills the new key", () => {
	const w = tempApp();
	w.app.close();
	const data = join(w.root, "data");
	writeFileSync(join(data, "config.yaml"), `downloads: ${w.downloads}\njellyfin:\n  url: http://jellyfin:8096\n  username: nas\n  public_url: https://jf.example.ts.net\n  watch_users: [owner]\nbangumi:\n  base_url: https://bgm.mirror.test\npath_maps:\n  jellyfin:\n    - theirs: /data/media\n      ours: /media\n`);
	mkdirSync(data, { recursive: true });
	writeFileSync(join(data, "secrets.yaml"), "jellyfin:\n  api_key: old-jellyfin-key-123\n");
	const app = new Reelix(data);
	try {
		assert.deepEqual(app.config.plugins.jellyfin, { url: "http://jellyfin:8096", public_url: "https://jf.example.ts.net", watch_users: ["owner"] });
		assert.deepEqual(app.config.plugins.bangumi, { base_url: "https://bgm.mirror.test" });
		assert.deepEqual(app.config.path_maps.media_servers, { jellyfin: [{ theirs: "/data/media", ours: "/media" }] });
		assert.equal(app.config.media_server, "jellyfin");
		assert.equal(app.secrets["plugins.jellyfin.api_key"], "old-jellyfin-key-123");
		assert.equal(app.secrets["jellyfin.api_key"], undefined);
		for (const old of ["jellyfin", "bangumi", "path_maps.jellyfin"]) assert.equal(app.getConfig(old), undefined, `${old} is gone`);
	} finally {
		app.close();
	}
	const again = new Reelix(data);
	try {
		assert.deepEqual(again.config.plugins.jellyfin, { url: "http://jellyfin:8096", public_url: "https://jf.example.ts.net", watch_users: ["owner"] }, "a second start changes nothing");
	} finally {
		again.close();
	}
});
