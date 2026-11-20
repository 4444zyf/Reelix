import { type AddOptions, type AddResult, isOutcome } from "@reelix/plugin";
import type { Reelix } from "./app.ts";
import { toOurs } from "./config.ts";
import { type Provider, outcomeAsError } from "./seams.ts";
import { ReelixError } from "./util.ts";

/**
 * The downloader, a seam of the kind "one of several" (docs/plugins.md §7, §7.5): the owner picks the active
 * provider (`downloader` in the settings), and core reaches it only through here.
 */
export const DOWNLOADER = "reelix:downloader@1";
export type Downloader = Provider<typeof DOWNLOADER>;

/** Reelix's own marks on a transfer: it looks after it, and it has been filed. */
export const MARK = "reelix";
export const MARK_FILED = "reelix-filed";

/** The active downloader, or nothing when it is not running (or no server runs the plugins). */
export function activeDownloader(app: Reelix): Downloader | undefined {
	return app.plugins ? app.seams.provider(DOWNLOADER, app.config.downloader) : undefined;
}

/** The active downloader. When it is not running, a clear error; Reelix never switches to another by itself. */
export function downloader(app: Reelix): Downloader {
	const all = app.seams.providers(DOWNLOADER); // without the server: "needs the server"
	const p = all.find((x) => x.id === app.config.downloader);
	if (p) return p;
	const id = app.config.downloader;
	const plugin = app.plugins?.list().find((x) => x.id === id);
	const why = !plugin
		? `no plugin provides a downloader "${id}"`
		: plugin.state !== "active"
			? `its plugin is ${plugin.state}${plugin.error ? ` (${plugin.error})` : ""}`
			: `its plugin is running but offers no downloader, so its settings are probably incomplete (Settings → Plugins → ${id})`;
	const others = all.map((x) => x.id);
	throw new ReelixError("no_downloader", `The active downloader "${id}" is not available: ${why}.${others.length ? ` Other downloaders: ${others.join(", ")}; only the owner can choose one (Settings → Downloads).` : ""}`);
}

/** The downloader that holds a download Reelix recorded. A download in another one is left alone. */
export function downloaderOf(app: Reelix, row: { hash: string; downloader?: string | null } | undefined): Downloader {
	const p = downloader(app);
	if (row?.downloader && row.downloader !== p.id) throw new ReelixError("other_downloader", `Download ${row.hash.slice(0, 10)} is in the downloader "${row.downloader}", not in the active one ("${p.id}").`);
	return p;
}

/** Add a transfer; an outcome of the service is an error here. */
export async function addTransfer(p: Downloader, src: { torrent: Uint8Array } | { magnet: string }, o: AddOptions, signal?: AbortSignal): Promise<AddResult> {
	const r = await p.call("add", [src, o], { signal });
	if (isOutcome(r)) throw outcomeAsError(p.label, r);
	return r;
}

/** A path as the downloader names it, as Reelix can open it (the path map of that provider). */
export const ourPath = (app: Reelix, providerId: string, theirs: string): string => toOurs(app.config.path_maps.downloaders[providerId] ?? [], theirs);

/** Bytes free where the downloader saves, as it says; undefined when it cannot say. */
export async function downloaderFreeSpace(app: Reelix): Promise<number | undefined> {
	const p = activeDownloader(app);
	return p ? p.call("freeSpace", []).catch(() => undefined) : undefined;
}
