import { existsSync, linkSync, readdirSync, statSync, unlinkSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { Reelix } from "./app.ts";
import { toOurs } from "./config.ts";
import { freeSpace } from "./downloads.ts";
import { http, proxyFor } from "./http.ts";
import { explainLinkError, libraryRoots } from "./organiser.ts";
import { findBinary } from "./probe.ts";
import { VIDEO_EXT } from "./torrent.ts";
import { errorMessage, humanBytes, newId } from "./util.ts";

export type Check = { name: string; ok: boolean | null; detail: string; fix?: string };

async function check(name: string, fn: () => Promise<Omit<Check, "name">> | Omit<Check, "name">): Promise<Check> {
	try {
		return { name, ...(await fn()) };
	} catch (e) {
		return { name, ok: false, detail: errorMessage(e) };
	}
}

/** Find a real file qBittorrent wrote, for the hard-link test (§10.2 step 4). */
export function findSampleFile(dir: string, depth = 0): string | undefined {
	if (depth > 4 || !existsSync(dir)) return undefined;
	let fallback: string | undefined;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name.startsWith(".") || e.name === "@eaDir" || e.name === "#recycle") continue;
		const p = join(dir, e.name);
		if (e.isFile()) {
			if (VIDEO_EXT.test(e.name)) return p;
			fallback ??= p;
		} else if (e.isDirectory()) {
			const f = findSampleFile(p, depth + 1);
			if (f && VIDEO_EXT.test(f)) return f;
			fallback ??= f;
		}
	}
	return fallback;
}

/** Try a real hard link from `source` into `libraryRoot`, then remove it. */
export function linkTest(source: string, libraryRoot: string): Check {
	const probe = join(libraryRoot, `.reelix-linktest-${newId()}`);
	try {
		linkSync(source, probe);
		const a = statSync(source);
		const b = statSync(probe);
		unlinkSync(probe);
		if (a.ino !== b.ino) return { name: "hard link", ok: false, detail: "link created but points to a different file" };
		return { name: "hard link", ok: true, detail: `linked ${source} into ${libraryRoot}` };
	} catch (e) {
		return { name: "hard link", ok: false, detail: explainLinkError(e as NodeJS.ErrnoException, source, libraryRoot) };
	}
}

export async function doctor(app: Reelix, opts: { quick?: boolean } = {}): Promise<Check[]> {
	const c = app.config;
	const checks: Check[] = [];
	if (app.configWarning) checks.push({ name: "config", ok: false, detail: app.configWarning });

	checks.push(
		await check("folders", () => {
			const missing: string[] = [];
			if (!c.downloads) missing.push("downloads");
			const roots = libraryRoots(app);
			if (!roots.movie) missing.push("library.movies");
			if (!roots.show) missing.push("library.shows");
			if (missing.length) return { ok: false, detail: `not set: ${missing.join(", ")}`, fix: "reelix config set downloads /media/…" };
			const absent = [c.downloads!, ...Object.values(roots).filter(Boolean)].filter((p) => !existsSync(p!));
			if (absent.length) return { ok: false, detail: `do not exist: ${absent.join(", ")}` };
			const unwritable = Object.values(roots).filter((p) => {
				try {
					if (p) accessSync(p, constants.W_OK);
					return false;
				} catch {
					return true;
				}
			});
			if (unwritable.length) return { ok: false, detail: `library folders not writable by uid ${process.getuid?.()}: ${unwritable.join(", ")}` };
			return { ok: true, detail: `downloads ${c.downloads}; library ${Object.entries(roots).map(([k, v]) => `${k}=${v ?? "-"}`).join(" ")}` };
		}),
	);

	let qbSave: string | undefined;
	checks.push(
		await check("qbittorrent", async () => {
			if (!c.qbittorrent?.url) return { ok: false, detail: "not configured", fix: "reelix config set qbittorrent.url http://host:8080" };
			const v = await app.qb().version();
			qbSave = await app.qb().defaultSavePath();
			const prefs = await app.qb().preferences();
			const tmp = prefs.temp_path_enabled ? `; incomplete folder ${prefs.temp_path} (files move on completion)` : "";
			return { ok: true, detail: `qBittorrent ${v.app} (API ${v.api}); saves to ${qbSave}${tmp}` };
		}),
	);

	if (qbSave !== undefined) {
		checks.push(
			await check("path mapping", () => {
				const ours = toOurs(c.path_maps.qbittorrent, qbSave!);
				if (!existsSync(ours)) return { ok: false, detail: `qBittorrent's save folder ${qbSave} maps to ${ours}, which Reelix cannot see`, fix: "reelix config set path_maps.qbittorrent '[{\"theirs\":\"/downloads\",\"ours\":\"/media/torrents\"}]'" };
				return { ok: true, detail: `${qbSave} → ${ours}` };
			}),
		);
	}

	checks.push(
		await check("hard link", () => {
			if (!c.downloads || !existsSync(c.downloads)) return { ok: null, detail: "skipped: download folder not set" };
			const sample = findSampleFile(c.downloads);
			if (!sample) return { ok: null, detail: "skipped: no file in the download folder to test with" };
			const results = Object.entries(libraryRoots(app))
				.filter(([, r]) => r && existsSync(r))
				.map(([k, r]) => ({ k, ...linkTest(sample, r!) }));
			if (!results.length) return { ok: null, detail: "skipped: no library folder exists yet" };
			const bad = results.filter((r) => !r.ok);
			const st = statSync(sample);
			const own = `test file ${sample} is uid ${st.uid} gid ${st.gid} mode ${(st.mode & 0o777).toString(8)}; Reelix runs as uid ${process.getuid?.()} gid ${process.getgid?.()}`;
			if (bad.length) return { ok: false, detail: `${bad.map((b) => `${b.k}: ${b.detail}`).join("; ")}. ${own}` };
			const otherRead = (st.mode & 0o004) !== 0 || (st.mode & 0o040) !== 0;
			return { ok: true, detail: `${results.map((r) => r.k).join(", ")} OK. ${own}${otherRead ? "" : ". WARNING: the file is not group/other-readable; Jellyfin may not read it"}` };
		}),
	);

	checks.push(
		await check("free space", () => {
			const f = freeSpace(app);
			if (f === undefined) return { ok: null, detail: "unknown" };
			return { ok: f > 20 * 1024 ** 3, detail: `${humanBytes(f)} free at the download folder` };
		}),
	);

	checks.push(
		await check("jackett", async () => {
			if (!c.jackett?.url) return { ok: false, detail: "not configured" };
			const ix = await app.jackett().indexers();
			if (!ix.length) return { ok: false, detail: "no indexers configured in Jackett" };
			if (opts.quick) return { ok: true, detail: `${ix.length} indexers: ${ix.map((i) => i.name).join(", ")}` };
			const { outcomes } = await app.jackett().searchEach(ix, ["test"], [], 20_000);
			const bad = outcomes.filter((o) => !o.ok);
			return { ok: bad.length < outcomes.length, detail: outcomes.map((o) => `${o.name}: ${o.ok ? `ok ${(o.ms / 1000).toFixed(1)}s` : `ERROR ${o.error}`}`).join("; ") };
		}),
	);

	checks.push(
		await check("tmdb", async () => {
			if (!app.secrets["tmdb.api_key"]) return { ok: false, detail: "no API key", fix: "reelix secret set tmdb.api_key" };
			const t0 = Date.now();
			await app.tmdb().details("movie", 550);
			return { ok: true, detail: `reachable${proxyFor(c, "tmdb") ? " via proxy" : ""} in ${Date.now() - t0} ms` };
		}),
	);

	if (!opts.quick) {
		for (const [name, url] of [
			["subhd", c.subtitles.subhd_url],
			["bangumi", c.bangumi.base_url + "/v0/subjects/1"],
		] as const) {
			checks.push(
				await check(name, async () => {
					const res = await http(url, { proxy: proxyFor(c, name), timeoutMs: 10_000 });
					return { ok: res.status < 500, detail: `HTTP ${res.status}` };
				}),
			);
		}
	}

	checks.push(
		await check("jellyfin", async () => {
			const jf = app.jellyfin();
			if (!jf) return { ok: null, detail: "not configured (optional)" };
			const info = await jf.info();
			const libs = await jf.virtualFolders().catch(() => []);
			return { ok: true, detail: `${info.ServerName} ${info.Version}; libraries: ${libs.map((l) => `${l.Name}=${l.Locations.join("|")}`).join("; ") || "none"}` };
		}),
	);

	checks.push(
		await check("telegram", async () => {
			const tg = app.telegram();
			if (!tg) return { ok: null, detail: "not configured (optional)" };
			const me = await tg.getMe();
			return { ok: !!c.telegram.owner_id, detail: `bot @${me.username}${c.telegram.owner_id ? ", owner linked" : ", owner not linked yet"}` };
		}),
	);

	checks.push(
		await check("tools", () => {
			const tools = ["ffprobe", "ffmpeg", "7zz", "7z", "unrar"].map((t) => [t, !!findBinary(t)] as const);
			const missing = tools.filter(([, ok]) => !ok).map(([t]) => t);
			const have7z = tools.some(([t, ok]) => (t === "7z" || t === "7zz") && ok);
			return { ok: !!findBinary("ffprobe") && have7z, detail: missing.length ? `missing: ${missing.join(", ")}` : "all present" };
		}),
	);

	checks.push(
		await check("identity", () => {
			const uid = process.getuid?.();
			return { ok: uid !== 0, detail: `running as uid ${uid} gid ${process.getgid?.()}${uid === 0 ? " — should not be root; run as qBittorrent's user" : ""}` };
		}),
	);
	return checks;
}

export function checksToText(checks: Check[]): string {
	return checks.map((c) => `${c.ok === true ? "OK  " : c.ok === false ? "FAIL" : "--  "} ${c.name}: ${c.detail}${c.fix ? `\n      fix: ${c.fix}` : ""}`).join("\n");
}
