import { accessSync, constants, existsSync, linkSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Reelix } from "./app.ts";
import { inContainer, loopbackAddresses } from "./container.ts";
import { downloader, ourPath } from "./downloader.ts";
import { freeSpace } from "./downloads.ts";
import { proxyFor } from "./http.ts";
import { type MediaServerProvider, activeMediaServer, missingMediaServer, serverPath } from "./media-server.ts";
import { everyLibraryFolder } from "./library-folders.ts";
import { explainLinkError } from "./organiser.ts";
import { findBinary } from "./probe.ts";
import { VIDEO_EXT } from "./torrent.ts";
import { ReelixError, errorMessage, humanBytes, newId } from "./util.ts";

/**
 * Doctor (docs/settings.md, "Status and Doctor"). Every result is data: the web UI words `cause`,
 * `impact` and the action's label in the owner's language (its `doctor` strings, or for a plugin the
 * `text` Reelix took from the plugin's own strings); the command line prints `raw` and `cli`.
 */
export const CHECK_STATES = ["passed", "failed", "skipped", "not_tested", "not_used", "degraded"] as const;
export type CheckState = (typeof CHECK_STATES)[number];
/** A message key and its values. `text`: already worded, for messages from a plugin's strings (key `<plugin>:<key>`). */
export type CheckMessage = { key: string; values?: Record<string, string | number>; text?: string };
/** A place in Settings (`anchor`: a section id, `field-<config path>`, `secret-<secret key>` or `plugin-<id>`), or an operation to run. */
export type CheckAction = { label: CheckMessage; anchor: string } | { label: CheckMessage; operation: string; input?: Record<string, unknown> };
export type Check = {
	name: string;
	state: CheckState;
	cause: CheckMessage;
	impact?: CheckMessage;
	action?: CheckAction;
	/** The command, for the command line's own output. */
	cli?: string;
	/** The details: paths, ids, raw errors. */
	raw?: string;
	/** Results with the same cause are shown once. */
	cause_id?: string;
	/** The other checks that found the same cause. */
	also?: string[];
};
export type CheckResult = Omit<Check, "name" | "also">;

const msg = (key: string, values?: CheckMessage["values"]): CheckMessage => (values ? { key, values } : { key });
const open = (anchor: string, label: string): CheckAction => ({ label: msg(`actions.${label}`), anchor });
/** How a plugin id reads in a message when its plugin offers no label ("jellyfin" → "Jellyfin"). */
const named = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

async function check(name: string, fn: () => Promise<CheckResult> | CheckResult): Promise<Check> {
	try {
		return { name, ...(await fn()) };
	} catch (e) {
		return { name, state: "failed", cause: msg("check_failed"), raw: errorMessage(e) };
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

/** Try a real hard link from `source` into `folder`, then remove it. `code`: the system's error code. */
export function linkTest(source: string, folder: string): { ok: boolean; code?: string; detail: string } {
	const probe = join(folder, `.reelix-linktest-${newId()}`);
	try {
		linkSync(source, probe);
		const a = statSync(source);
		const b = statSync(probe);
		unlinkSync(probe);
		if (a.ino !== b.ino) return { ok: false, detail: "link created but points to a different file" };
		return { ok: true, detail: `linked ${source} into ${folder}` };
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		return { ok: false, code: err.code, detail: explainLinkError(err, source, folder) };
	}
}

// ------------------------------------------------------------------ folder checks

/** One of a folder's four results. */
export type FolderResult = { state: CheckState; cause: CheckMessage; raw?: string };
export type FolderCheck = {
	path: string;
	/** `other`: a folder inside the media folder that is not (yet) in the settings. */
	kind: "downloads" | "library" | "other";
	label: string;
	exists: FolderResult;
	writable: FolderResult;
	hardlink: FolderResult;
	media_server: FolderResult;
};

/** The active media server, its libraries, and what kept Reelix from asking it. */
type ServerView = { id: string; label: string; provider?: MediaServerProvider; info?: { name: string; version: string }; libs?: { name: string; paths: string[] }[]; error?: string };

async function serverView(app: Reelix): Promise<ServerView> {
	const id = app.config.media_server;
	const provider = activeMediaServer(app);
	if (!provider) return { id, label: named(id) };
	try {
		const [info, libs] = await Promise.all([provider.call("info", []), provider.call("libraries", [])]);
		return { id, label: provider.label, provider, info, libs };
	} catch (e) {
		return { id, label: provider.label, provider, error: errorMessage(e) };
	}
}

const near = (a: string, b: string) => a === b || a.startsWith(`${b.replace(/\/+$/, "")}/`) || b.startsWith(`${a.replace(/\/+$/, "")}/`);

function writableBy(path: string): boolean {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

const LINK_CAUSE: Record<string, string> = { EXDEV: "cross_device", EPERM: "denied", EACCES: "denied" };

function inspectFolder(app: Reelix, f: { path: string; kind: FolderCheck["kind"]; label: string }, sample: string | undefined, view: ServerView): FolderCheck {
	const c = app.config;
	const exists = existsSync(f.path) && statSync(f.path).isDirectory();
	const needsFolder: FolderResult = { state: "skipped", cause: msg("folder.needs_folder") };
	const ids = `Reelix runs as uid ${process.getuid?.()} gid ${process.getgid?.()}`;
	let hardlink: FolderResult;
	if (!exists) hardlink = needsFolder;
	else if (!c.downloads || !existsSync(c.downloads)) hardlink = { state: "skipped", cause: msg("folder.needs_downloads") };
	else if (!sample) hardlink = { state: "not_tested", cause: msg("folder.no_sample"), raw: `no file in ${c.downloads} to test with` };
	else {
		const r = linkTest(sample, f.path);
		hardlink = r.ok ? { state: "passed", cause: msg("folder.link_ok"), raw: r.detail } : { state: "failed", cause: msg(`folder.link_${(r.code && LINK_CAUSE[r.code]) || "failed"}`), raw: r.detail };
	}
	let media_server: FolderResult;
	const server = { server: view.label };
	if (f.kind === "downloads") media_server = { state: "not_used", cause: msg("folder.server_not_needed", server) };
	else if (!view.libs) media_server = { state: "skipped", cause: msg("folder.server_unverified", server), ...(view.error ? { raw: view.error } : {}) };
	else {
		const there = serverPath(app, view.id, f.path);
		media_server = view.libs.some((l) => l.paths.some((lp) => near(there, lp)))
			? { state: "passed", cause: msg("folder.server_sees", server), raw: `${f.path} is ${there} for ${view.label}` }
			: { state: "failed", cause: msg("folder.server_unseen", server), raw: `no library of ${view.label} holds ${there}` };
	}
	return {
		path: f.path,
		kind: f.kind,
		label: f.label,
		exists: exists ? { state: "passed", cause: msg("folder.exists") } : { state: "failed", cause: msg("folder.missing"), raw: `${f.path} does not exist` },
		writable: !exists ? needsFolder : writableBy(f.path) ? { state: "passed", cause: msg("folder.writable") } : { state: "failed", cause: msg("folder.not_writable"), raw: `${f.path} is not writable; ${ids}` },
		hardlink,
		media_server,
	};
}

/** The downloads folder and every library folder, as the settings have them. */
function settingsFolders(app: Reelix): { path: string; kind: FolderCheck["kind"]; label: string }[] {
	return [...(app.config.downloads ? [{ path: app.config.downloads, kind: "downloads" as const, label: "downloads" }] : []), ...everyLibraryFolder(app).map((f) => ({ ...f, kind: "library" as const }))];
}

function sampleFile(app: Reelix): string | undefined {
	const d = app.config.downloads;
	return d && existsSync(d) ? findSampleFile(d) : undefined;
}

/**
 * Four results per folder (docs/settings.md, "Folder checks"): exists, writable by Reelix, a hard link
 * from the downloads works, the media server sees it. `path`: only that folder; one not in the settings
 * must be inside the media folder.
 */
export async function folderChecks(app: Reelix, path?: string): Promise<FolderCheck[]> {
	let folders = settingsFolders(app);
	if (path !== undefined) {
		const wanted = resolve(path);
		folders = folders.filter((f) => resolve(f.path) === wanted);
		if (!folders.length) {
			if (!insideMediaRoot(app, wanted)) throw new ReelixError("invalid_input", `${wanted} is outside the media folder ${app.config.media_root}; only folders inside it can be checked.`);
			folders = [{ path: wanted, kind: "other", label: wanted }];
		}
	}
	const view = await serverView(app);
	const sample = sampleFile(app);
	return folders.map((f) => inspectFolder(app, f, sample, view));
}

/** Inside `media_root`, after following links; a folder that does not exist yet counts by its name. */
function insideMediaRoot(app: Reelix, path: string): boolean {
	const real = (p: string) => {
		try {
			return realpathSync(p);
		} catch {
			return resolve(p);
		}
	};
	const root = real(app.config.media_root);
	const p = real(path);
	return p === root || p.startsWith(root + sep);
}

export function folderChecksToText(folders: FolderCheck[]): string {
	const line = (what: string, r: FolderResult) => `  ${mark(r.state)} ${what}${r.raw ? `: ${r.raw}` : ""}`;
	return folders.map((f) => [`${f.label} (${f.path})`, line("exists", f.exists), line("writable", f.writable), line("hard link", f.hardlink), line("media server", f.media_server)].join("\n")).join("\n");
}

// ------------------------------------------------------------------ Doctor

function foldersCheck(app: Reelix, folders: FolderCheck[]): CheckResult {
	const c = app.config;
	const unset = [...(c.downloads ? [] : ["downloads"]), ...(c.library.movies.length ? [] : ["library.movies"]), ...(c.library.shows.length ? [] : ["library.shows"])];
	const impact = msg("impact.no_filing");
	const action = open("folders", "open_folders");
	if (unset.length) return { state: "failed", cause: msg("folders_not_set"), impact, action, raw: `not set: ${unset.join(", ")}`, cause_id: "folders" };
	const absent = folders.filter((f) => f.exists.state !== "passed");
	if (absent.length) return { state: "failed", cause: msg("folders_missing", { count: absent.length }), impact, action, raw: `do not exist: ${absent.map((f) => f.path).join(", ")}`, cause_id: "folders" };
	const unwritable = folders.filter((f) => f.kind === "library" && f.writable.state !== "passed");
	if (unwritable.length) return { state: "failed", cause: msg("folders_not_writable", { count: unwritable.length }), impact, raw: `library folders not writable by uid ${process.getuid?.()}: ${unwritable.map((f) => f.path).join(", ")}` };
	const lib = folders.filter((f) => f.kind === "library");
	return { state: "passed", cause: msg("folders_ok", { count: lib.length }), raw: `downloads ${c.downloads}; library ${lib.map((f) => `${f.label}=${f.path}`).join(" ")}` };
}

function hardLinkCheck(app: Reelix, folders: FolderCheck[], sample: string | undefined): CheckResult {
	const c = app.config;
	if (!c.downloads || !existsSync(c.downloads)) return { state: "skipped", cause: msg("hardlink_needs_downloads"), raw: "download folder not set" };
	if (!sample) return { state: "not_tested", cause: msg("hardlink_no_sample"), raw: `no file in ${c.downloads} to test with` };
	const tested = folders.filter((f) => f.kind === "library" && f.exists.state === "passed");
	if (!tested.length) return { state: "skipped", cause: msg("hardlink_needs_library"), raw: "no library folder exists yet" };
	const st = statSync(sample);
	const own = `test file ${sample} is uid ${st.uid} gid ${st.gid} mode ${(st.mode & 0o777).toString(8)}; Reelix runs as uid ${process.getuid?.()} gid ${process.getgid?.()}`;
	const bad = tested.filter((f) => f.hardlink.state === "failed");
	if (bad.length) {
		const cause = bad[0]!.hardlink.cause.key.replace("folder.link_", "hardlink_");
		return { state: "failed", cause: msg(cause, { count: bad.length }), impact: msg("impact.no_filing"), action: open("folders", "open_folders"), raw: `${bad.map((b) => `${b.label}: ${b.hardlink.raw}`).join("; ")}. ${own}`, cause_id: "hardlink" };
	}
	const readable = (st.mode & 0o004) !== 0 || (st.mode & 0o040) !== 0;
	if (!readable) return { state: "degraded", cause: msg("hardlink_unreadable"), impact: msg("impact.server_may_not_read"), raw: `${tested.map((f) => f.label).join(", ")} OK. ${own}; the file is not group/other-readable` };
	return { state: "passed", cause: msg("hardlink_ok", { count: tested.length }), raw: `${tested.map((f) => f.label).join(", ")} OK. ${own}` };
}

/** A provider of `kind` is missing: the plugin's state says why, and `<id>:setup` is the cause its own check shares. */
function missingProvider(app: Reelix, id: string, kind: "downloader" | "media_server", raw: string, optional: boolean): CheckResult {
	const plugin = app.plugins?.list().find((x) => x.id === id);
	const values = { name: named(id) };
	const impact = msg(`impact.${kind}_off`, values);
	if (plugin?.state === "active") return { state: optional ? "not_used" : "failed", cause: msg(`${kind}_setup`, values), impact, action: open(`plugin-${id}`, "set_up"), raw, cause_id: `${id}:setup` };
	if (!plugin) return { state: optional ? "not_used" : "failed", cause: msg(`${kind}_missing`, values), impact, action: open("plugins", "open_plugins"), raw };
	return { state: optional && plugin.state === "disabled" ? "not_used" : "failed", cause: msg(`${kind}_not_running`, values), impact, action: open(`plugin-${id}`, "open_plugin"), raw, cause_id: `${id}:not_running` };
}

async function downloaderCheck(app: Reelix): Promise<CheckResult> {
	let d: ReturnType<typeof downloader>;
	try {
		d = downloader(app);
	} catch (e) {
		return missingProvider(app, app.config.downloader, "downloader", errorMessage(e), false);
	}
	const values = { name: d.label };
	let folder: string;
	try {
		folder = await d.call("defaultFolder", []);
	} catch (e) {
		return { state: "failed", cause: msg("downloader_unreachable", values), impact: msg("impact.downloader_off", values), action: open(`plugin-${d.id}`, "open_plugin"), raw: errorMessage(e), cause_id: `${d.id}:unreachable` };
	}
	const ours = ourPath(app, d.id, folder);
	if (!existsSync(ours))
		return {
			state: "failed",
			cause: msg("downloader_path_unseen", { ...values, folder }),
			impact: msg("impact.downloads_not_found"),
			action: open(`field-path_maps.downloaders.${d.id}`, "set_path_map"),
			cli: `reelix config set path_maps.downloaders.${d.id} '[{"theirs":"${folder}","ours":"/media/torrents"}]'`,
			raw: `${d.label} saves to ${folder}, which is ${ours} here, and Reelix cannot see it`,
		};
	// The folder exists here, but is it the same folder? Both sides can say /media and mean two disks: then the
	// downloads the downloader has finished are not where Reelix looks (docs/settings.md, "Path maps").
	const finished = (await d.call("list", [{}]).catch(() => [])).filter((t) => t.done && t.name).slice(0, 5);
	if (finished.length && !finished.some((t) => existsSync(join(ourPath(app, d.id, t.folder), t.name))))
		return {
			state: "failed",
			cause: msg("downloader_other_folder", { ...values, folder, ours }),
			impact: msg("impact.downloads_not_found"),
			action: open(`field-path_maps.downloaders.${d.id}`, "set_path_map"),
			raw: `${d.label} has finished ${finished.map((t) => `${t.folder}/${t.name}`).join(", ")}; none of them is at the same place here (${finished.map((t) => join(ourPath(app, d.id, t.folder), t.name)).join(", ")})`,
		};
	return { state: "passed", cause: msg("downloader_ok", { ...values, folder: ours }), raw: `${d.label} saves to ${folder}${ours === folder ? "" : ` (${ours} here)`}` };
}

function mediaServerCheck(app: Reelix, view: ServerView, folders: FolderCheck[]): CheckResult {
	if (!view.provider) return missingProvider(app, view.id, "media_server", missingMediaServer(app), true);
	const values = { name: view.label };
	if (!view.libs || !view.info) return { state: "failed", cause: msg("media_server_unreachable", values), impact: msg("impact.media_server_off", values), action: open(`plugin-${view.id}`, "open_plugin"), raw: view.error, cause_id: `${view.id}:unreachable` };
	const raw = `${view.label} ${view.info.name} ${view.info.version}; libraries: ${view.libs.map((l) => `${l.name}=${l.paths.join("|")}`).join("; ") || "none"}`;
	const unseen = folders.filter((f) => f.kind === "library" && f.media_server.state === "failed");
	if (unseen.length)
		return {
			state: "failed",
			cause: msg("media_server_unseen", { ...values, count: unseen.length }),
			impact: msg("impact.media_server_unseen", values),
			action: open(`field-path_maps.media_servers.${view.id}`, "set_path_map"),
			cli: `Add the folder as a library in ${view.label}, or say how its paths look: reelix config set path_maps.media_servers.${view.id} '[{"theirs":"/data/media","ours":"/media"}]'`,
			raw: `${raw}. No library of ${view.label} holds ${unseen.map((f) => `${f.label} (${serverPath(app, view.id, f.path)} there)`).join(", ")}`,
		};
	return { state: "passed", cause: msg("media_server_ok", { ...values, version: view.info.version }), raw };
}

/** Missing tools: what stops working, and what stands in. `unrar` is not used: 7-Zip unpacks RAR too. */
function toolChecks(): CheckResult[] {
	const missing: CheckResult[] = [];
	if (!findBinary("ffprobe")) missing.push({ state: "degraded", cause: msg("tool_missing", { tool: "ffprobe" }), impact: msg("impact.no_ffprobe"), raw: "ffprobe not found on PATH", cause_id: "tool:ffprobe" });
	if (!findBinary("ffmpeg")) missing.push({ state: "degraded", cause: msg("tool_missing", { tool: "ffmpeg" }), impact: msg("impact.no_ffmpeg"), raw: "ffmpeg not found on PATH", cause_id: "tool:ffmpeg" });
	if (!["7zz", "7z", "7za"].some((t) => findBinary(t))) missing.push({ state: "degraded", cause: msg("tool_missing", { tool: "7-Zip" }), impact: msg("impact.no_7z"), raw: "none of 7zz, 7z, 7za found on PATH", cause_id: "tool:7z" });
	return missing.length ? missing : [{ state: "passed", cause: msg("tools_ok"), raw: "ffprobe, ffmpeg and 7-Zip present" }];
}

/** Results with the same `cause_id` become one: the most serious of them (a later one on a tie: a plugin knows its service best), where the first stood. */
export function mergeShared(checks: Check[]): Check[] {
	const rank: Record<CheckState, number> = { failed: 5, degraded: 4, not_tested: 3, skipped: 2, not_used: 1, passed: 0 };
	const out: Check[] = [];
	const at = new Map<string, number>();
	for (const c of checks) {
		const i = c.cause_id === undefined ? undefined : at.get(c.cause_id);
		if (i === undefined) {
			if (c.cause_id !== undefined) at.set(c.cause_id, out.length);
			out.push(c);
			continue;
		}
		const kept = out[i]!;
		const names = [kept.name, ...(kept.also ?? []), c.name];
		const winner = rank[c.state] >= rank[kept.state] ? c : kept;
		out[i] = { ...winner, also: names.filter((n) => n !== winner.name) };
	}
	return out;
}

export async function doctor(app: Reelix, opts: { quick?: boolean } = {}): Promise<Check[]> {
	const checks: Check[] = [];
	if (app.configWarning) checks.push({ name: "config", state: "failed", cause: msg("config_invalid"), impact: msg("impact.config_defaults"), raw: app.configWarning });
	// In a container, "localhost" is the container itself (docs/deployment.md).
	if (inContainer())
		for (const l of loopbackAddresses(app)) checks.push({ name: "address", state: "failed", cause: msg("loopback", { url: l.url }), impact: msg("impact.loopback"), action: open(`field-${l.path}`, "fix_address"), cli: l.fix, raw: `${l.path}: ${l.url} points at Reelix's own container`, cause_id: `address:${l.path}` });

	const view = await serverView(app);
	const sample = sampleFile(app);
	const folders = settingsFolders(app).map((f) => inspectFolder(app, f, sample, view));
	checks.push(await check("folders", () => foldersCheck(app, folders)));
	// The active downloader and its path map; its plugin checks the service itself (docs/plugins.md §7.5).
	if (app.plugins) checks.push(await check("downloader", () => downloaderCheck(app)));
	checks.push(await check("hard link", () => hardLinkCheck(app, folders, sample)));
	checks.push(
		await check("free space", () => {
			const f = freeSpace(app);
			if (f === undefined) return { state: "skipped", cause: msg("free_space_unknown"), raw: "unknown" };
			const free = humanBytes(f);
			const raw = `${free} free at the download folder`;
			return f > 20 * 1024 ** 3 ? { state: "passed", cause: msg("free_space_ok", { free }), raw } : { state: "failed", cause: msg("free_space_low", { free }), impact: msg("impact.space_low"), raw };
		}),
	);
	checks.push(
		await check("tmdb", async () => {
			if (!app.secrets["tmdb.api_key"]) return { state: "failed", cause: msg("tmdb_no_key"), impact: msg("impact.tmdb_off"), action: open("secret-tmdb.api_key", "add_key"), cli: "reelix secret set tmdb.api_key", raw: "no API key", cause_id: "tmdb.api_key" };
			const t0 = Date.now();
			try {
				await app.tmdb().details("movie", 550);
			} catch (e) {
				return { state: "failed", cause: msg("tmdb_unreachable"), impact: msg("impact.tmdb_off"), raw: errorMessage(e) };
			}
			const ms = Date.now() - t0;
			const proxied = !!proxyFor(app.config, "tmdb");
			return { state: "passed", cause: msg(proxied ? "tmdb_ok_proxy" : "tmdb_ok", { ms }), raw: `reachable${proxied ? " via proxy" : ""} in ${ms} ms` };
		}),
	);
	// The active media server and whether it sees Reelix's library folders (docs/plugins.md §7.7); its plugin checks the service itself.
	if (app.plugins) checks.push(await check("media server", () => mediaServerCheck(app, view, folders)));
	for (const r of toolChecks()) checks.push({ name: "tools", ...r });
	const uid = process.getuid?.();
	const ids = `running as uid ${uid} gid ${process.getgid?.()}`;
	checks.push(uid === 0 ? { name: "identity", state: "failed", cause: msg("running_as_root"), impact: msg("impact.root_files"), raw: `${ids} — should not be root; run as the downloader's user` } : { name: "identity", state: "passed", cause: msg("identity_ok", { uid: uid ?? "?" }), raw: ids });
	// The plugins' own checks: services only they know about (docs/plugins.md §6).
	if (!app.plugins) checks.push({ name: "plugins", state: "skipped", cause: msg("plugins_need_server"), cli: "reelix serve", raw: "plugins run inside the server" });
	checks.push(...(await runPluginChecks(app, [...app.checks.keys()], !!opts.quick)));
	return mergeShared(checks);
}

/** Run plugins' checks and keep each plugin's results as its last check (until it restarts). */
async function runPluginChecks(app: Reelix, names: string[], quick: boolean): Promise<Check[]> {
	const out: Check[] = [];
	const byPlugin = new Map<string, Check[]>();
	for (const name of names) {
		const registered = app.checks.get(name);
		if (!registered) continue;
		let r: CheckResult | undefined;
		try {
			r = await withTimeout(registered.run({ quick }));
		} catch (e) {
			r = { state: "failed", cause: msg("check_failed"), raw: errorMessage(e) };
		}
		if (!r) continue;
		const c = { name, ...r };
		out.push(c);
		byPlugin.set(registered.plugin, [...(byPlugin.get(registered.plugin) ?? []), c]);
	}
	const at = new Date().toISOString();
	for (const [plugin, results] of byPlugin) app.lastChecks.set(plugin, { at, results });
	return out;
}

/** One plugin's checks, in full: "Test connection" (docs/settings.md, "The test"). */
export async function pluginChecks(app: Reelix, plugin: string): Promise<Check[]> {
	const info = app.plugins?.list().find((p) => p.id === plugin);
	if (!info) throw new ReelixError("not_found", app.plugins ? `There is no plugin "${plugin}".` : "Plugins run inside the server (start it with `reelix serve`).");
	if (info.state !== "active") throw new ReelixError("unavailable", `The plugin ${plugin} is ${info.state}, so its checks cannot run.`);
	const names = [...app.checks].filter(([, c]) => c.plugin === plugin).map(([name]) => name);
	const results = await runPluginChecks(app, names, false);
	app.lastChecks.set(plugin, { at: new Date().toISOString(), results });
	return results;
}

const PLUGIN_CHECK_MS = 30_000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
	let timer!: NodeJS.Timeout;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`no answer within ${PLUGIN_CHECK_MS / 1000} seconds`)), PLUGIN_CHECK_MS);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const MARKS: Record<CheckState, string> = { passed: "OK  ", failed: "FAIL", degraded: "WARN", skipped: "--  ", not_tested: "--  ", not_used: "--  " };
const mark = (s: CheckState) => MARKS[s];

/** For the command line: readable English from the details, and the command as the fix. */
export function checksToText(checks: Check[]): string {
	return checks
		.map((c) => {
			const state = c.state === "not_tested" ? " (not tested)" : c.state === "not_used" ? " (not used)" : c.state === "skipped" ? " (skipped)" : "";
			const also = c.also?.length ? ` (also ${c.also.join(", ")})` : "";
			return `${mark(c.state)} ${c.name}${also}${state}: ${c.raw ?? c.cause.text ?? c.cause.key}${c.cli && c.state !== "passed" ? `\n      fix: ${c.cli}` : ""}`;
		})
		.join("\n");
}
