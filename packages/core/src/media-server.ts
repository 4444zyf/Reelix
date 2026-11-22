import type { ServerUser } from "@reelix/plugin";
import type { Reelix } from "./app.ts";
import { toTheirs } from "./config.ts";
import type { Provider } from "./seams.ts";
import { errorMessage } from "./util.ts";

/**
 * The media server, a seam of the kind "one of several" (docs/plugins.md §7, §7.7): the owner picks the active
 * provider (`media_server` in the settings). It is optional: without one, filing still works, and only what
 * needs the server (watch history, its players' links) is missing.
 */
export const MEDIA_SERVER = "reelix:media.server@1";
export type MediaServerProvider = Provider<typeof MEDIA_SERVER>;

/** The active media server, or nothing when it is not running or not set up (or no server runs the plugins). */
export function activeMediaServer(app: Reelix): MediaServerProvider | undefined {
	return app.plugins ? app.seams.provider(MEDIA_SERVER, app.config.media_server) : undefined;
}

/** Why the active media server is not there, naming the others; only the owner can choose one. */
export function missingMediaServer(app: Reelix): string {
	const id = app.config.media_server;
	const plugin = app.plugins?.list().find((x) => x.id === id);
	const why = !plugin
		? `no plugin provides a media server "${id}"`
		: plugin.state !== "active"
			? `its plugin is ${plugin.state}${plugin.error ? ` (${plugin.error})` : ""}`
			: `its plugin is running but offers no media server, so its settings are probably incomplete (Settings → Plugins → ${id})`;
	const others = app.seams.providers(MEDIA_SERVER).map((x) => x.id);
	return `The media server "${id}" is not available: ${why}.${others.length ? ` Other media servers: ${others.join(", ")}; only the owner can choose one (Settings → Services → Media server).` : ""}`;
}

const maps = (app: Reelix, providerId: string) => app.config.path_maps.media_servers[providerId] ?? [];

/** A path as Reelix sees it, as the media server names it (the path map of that provider). */
export const serverPath = (app: Reelix, providerId: string, ours: string): string => toTheirs(maps(app, providerId), ours);

/** Tell the media server that library paths changed; fall back to a full scan (§5.6). Returns what was done. */
export async function tellMediaServer(app: Reelix, ourPaths: string[], change: "created" | "deleted" = "created"): Promise<string> {
	const p = activeMediaServer(app);
	if (!p) return "No media server is set up.";
	// The folder of each file: the server looks at a folder faster than at many files.
	const theirs = [...new Set(ourPaths.map((x) => serverPath(app, p.id, x.replace(/\/[^/]*\.[a-z0-9]{2,4}$/i, ""))))];
	if (!theirs.length) return "Nothing changed.";
	try {
		await p.call("changed", [theirs.map((path) => ({ path, change }))]);
		return `Told ${p.label} about ${theirs.length} path(s).`;
	} catch {
		await p.call("refreshAll", []);
		return `Asked ${p.label} for a full library scan.`;
	}
}

/** Whose history counts: the provider's `watchUsers`, else the only user, else the administrators. */
export function chooseWatchUsers(p: Pick<MediaServerProvider, "label" | "impl">, users: ServerUser[]): ServerUser[] | string {
	const active = users.filter((u) => u.active);
	const named = p.impl.watchUsers;
	if (named?.length) {
		const want = new Set(named.map((n) => n.trim().toLowerCase()));
		const hit = active.filter((u) => want.has(u.name.toLowerCase()));
		return hit.length ? hit : `None of the users whose history counts in ${p.label}'s settings (${named.join(", ")}) is an active user there.`;
	}
	if (active.length === 1) return active;
	const admins = active.filter((u) => u.admin);
	return admins.length ? admins : `${p.label} has several users and no administrator; say whose history counts in its settings (Settings → Plugins).`;
}

/** An error from the media server, made fit to show: no secret, one line. */
export const serverError = (app: Reelix, e: unknown): string => app.redact(errorMessage(e)).slice(0, 200);
