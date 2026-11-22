import { existsSync, linkSync, readdirSync, statSync, unlinkSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { Reelix } from "./app.ts";
import { inContainer, loopbackAddresses } from "./container.ts";
import { downloader, ourPath } from "./downloader.ts";
import { freeSpace } from "./downloads.ts";
import { proxyFor } from "./http.ts";
import { activeMediaServer, missingMediaServer, serverPath } from "./media-server.ts";
import { everyLibraryFolder } from "./library-folders.ts";
import { explainLinkError } from "./organiser.ts";
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

/** Find a real file the downloader wrote, for the hard-link test (§10.2 step 4). */
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
	// In a container, "localhost" is the container itself (docs/deployment.md).
	if (inContainer())
		for (const l of loopbackAddresses(app)) checks.push({ name: `address ${l.path}`, ok: false, detail: `${l.url} points at Reelix's own container`, fix: l.fix });

	checks.push(
		await check("folders", () => {
			const missing: string[] = [];
			if (!c.downloads) missing.push("downloads");
			const folders = everyLibraryFolder(app);
			if (!c.library.movies.length) missing.push("library.movies");
			if (!c.library.shows.length) missing.push("library.shows");
			if (missing.length) return { ok: false, detail: `not set: ${missing.join(", ")}`, fix: "Settings → Paths" };
			const absent = [c.downloads!, ...folders.map((f) => f.path)].filter((p) => !existsSync(p));
			if (absent.length) return { ok: false, detail: `do not exist: ${absent.join(", ")}` };
			const unwritable = folders.filter((f) => {
				try {
					accessSync(f.path, constants.W_OK);
					return false;
				} catch {
					return true;
				}
			});
			if (unwritable.length) return { ok: false, detail: `library folders not writable by uid ${process.getuid?.()}: ${unwritable.map((f) => f.path).join(", ")}` };
			return { ok: true, detail: `downloads ${c.downloads}; library ${folders.map((f) => `${f.label}=${f.path}`).join(" ")}` };
		}),
	);

	// The active downloader and its path map; its plugin checks the service itself (docs/plugins.md §7.5).
	if (app.plugins)
		checks.push(
			await check("downloader", async () => {
				const d = downloader(app);
				const folder = await d.call("defaultFolder", []);
				const ours = ourPath(app, d.id, folder);
				if (!existsSync(ours)) return { ok: false, detail: `${d.label} saves to ${folder}, which is ${ours} here, and Reelix cannot see it`, fix: `reelix config set path_maps.downloaders.${d.id} '[{"theirs":"${folder}","ours":"/media/torrents"}]'` };
				return { ok: true, detail: `${d.label} saves to ${folder}${ours === folder ? "" : ` (${ours} here)`}` };
			}),
		);

	checks.push(
		await check("hard link", () => {
			if (!c.downloads || !existsSync(c.downloads)) return { ok: null, detail: "skipped: download folder not set" };
			const sample = findSampleFile(c.downloads);
			if (!sample) return { ok: null, detail: "skipped: no file in the download folder to test with" };
			const results = everyLibraryFolder(app)
				.filter((f) => existsSync(f.path))
				.map((f) => ({ k: f.label, ...linkTest(sample, f.path) }));
			if (!results.length) return { ok: null, detail: "skipped: no library folder exists yet" };
			const bad = results.filter((r) => !r.ok);
			const st = statSync(sample);
			const own = `test file ${sample} is uid ${st.uid} gid ${st.gid} mode ${(st.mode & 0o777).toString(8)}; Reelix runs as uid ${process.getuid?.()} gid ${process.getgid?.()}`;
			if (bad.length) return { ok: false, detail: `${bad.map((b) => `${b.k}: ${b.detail}`).join("; ")}. ${own}` };
			const otherRead = (st.mode & 0o004) !== 0 || (st.mode & 0o040) !== 0;
			return { ok: true, detail: `${results.map((r) => r.k).join(", ")} OK. ${own}${otherRead ? "" : ". WARNING: the file is not group/other-readable; the media server may not read it"}` };
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
		await check("tmdb", async () => {
			if (!app.secrets["tmdb.api_key"]) return { ok: false, detail: "no API key", fix: "reelix secret set tmdb.api_key" };
			const t0 = Date.now();
			await app.tmdb().details("movie", 550);
			return { ok: true, detail: `reachable${proxyFor(c, "tmdb") ? " via proxy" : ""} in ${Date.now() - t0} ms` };
		}),
	);

	// The active media server and whether it sees Reelix's library folders (docs/plugins.md §7.7); its plugin checks the service itself.
	if (app.plugins)
		checks.push(
			await check("media server", async () => {
				const p = activeMediaServer(app);
				if (!p) return { ok: null, detail: `${missingMediaServer(app)} It is optional.` };
				const [info, libs] = await Promise.all([p.call("info", []), p.call("libraries", [])]);
				const detail = `${p.label} ${info.name} ${info.version}; libraries: ${libs.map((l) => `${l.name}=${l.paths.join("|")}`).join("; ") || "none"}`;
				const near = (a: string, b: string) => a === b || a.startsWith(`${b.replace(/\/+$/, "")}/`) || b.startsWith(`${a.replace(/\/+$/, "")}/`);
				const unseen = everyLibraryFolder(app).flatMap((f) => (!libs.some((l) => l.paths.some((lp) => near(serverPath(app, p.id, f.path), lp))) ? [`${f.label} (${serverPath(app, p.id, f.path)} there)`] : []));
				if (unseen.length) return { ok: false, detail: `${detail}. No library of ${p.label} holds ${unseen.join(", ")}`, fix: `Add the folder as a library in ${p.label}, or say how its paths look: reelix config set path_maps.media_servers.${p.id} '[{"theirs":"/data/media","ours":"/media"}]'` };
				return { ok: true, detail };
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
			return { ok: uid !== 0, detail: `running as uid ${uid} gid ${process.getgid?.()}${uid === 0 ? " — should not be root; run as the downloader's user" : ""}` };
		}),
	);
	// The plugins' own checks: services only they know about (docs/plugins.md §6).
	if (!app.plugins) checks.push({ name: "plugins", ok: null, detail: "not checked: plugins run inside the server (start it with `reelix serve`)" });
	for (const [name, run] of app.checks) {
		const r = await check(name, async () => (await withTimeout(run({ quick: !!opts.quick }))) ?? { ok: null, detail: "" });
		if (r.detail || r.ok !== null) checks.push(r);
	}
	return checks;
}

const PLUGIN_CHECK_MS = 30_000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
	let timer!: NodeJS.Timeout;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`no answer within ${PLUGIN_CHECK_MS / 1000} seconds`)), PLUGIN_CHECK_MS);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function checksToText(checks: Check[]): string {
	return checks.map((c) => `${c.ok === true ? "OK  " : c.ok === false ? "FAIL" : "--  "} ${c.name}: ${c.detail}${c.fix ? `\n      fix: ${c.fix}` : ""}`).join("\n");
}
