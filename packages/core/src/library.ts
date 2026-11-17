import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Reelix } from "./app.ts";
import { notifyJellyfin } from "./downloads.ts";
import { libraryRoots } from "./organiser.ts";
import { type Title, requireTitle } from "./titles.ts";
import { ReelixError, nowIso } from "./util.ts";

export type FileRow = { id: number; title_id: string | null; download_hash: string | null; source: string | null; dest: string; kind: string; version_label: string | null; linked: number; created_at: string };

export function titleFiles(app: Reelix, titleId: string): (FileRow & { episodes: { season: number; episode: number }[]; exists: boolean })[] {
	const rows = app.db.prepare("SELECT * FROM files WHERE title_id = ? ORDER BY dest").all(titleId) as FileRow[];
	const eps = app.db.prepare("SELECT season, episode FROM file_episodes WHERE file_id = ? ORDER BY season, episode");
	return rows.map((r) => ({ ...r, episodes: eps.all(r.id) as { season: number; episode: number }[], exists: existsSync(r.dest) }));
}

/** Which library root holds a path. */
function rootOf(app: Reelix, p: string): string | undefined {
	return Object.values(libraryRoots(app)).find((r) => r && (p === r || p.startsWith(r.replace(/\/+$/, "") + "/")));
}

function trashDir(root: string): string {
	const d = join(root, ".reelix-trash");
	if (!existsSync(d)) {
		mkdirSync(d, { recursive: true });
		// Jellyfin skips folders containing a .ignore file.
		writeFileSync(join(d, ".ignore"), "");
	}
	return d;
}

export type RemoveLevel = "entry" | "torrent" | "data";

export type RemoveOutput = { unlinked: string[]; trashed: string[]; torrent?: string; data_deleted?: boolean; notes: string[] };

/**
 * Remove a title from the library at one of three explicit levels (§5.8):
 *   entry  — the library entry only;
 *   torrent — plus the torrent in qBittorrent (data stays on disk);
 *   data    — plus the downloaded data.
 * A link whose data still exists elsewhere is just unlinked (restorable by re-linking); a last
 * remaining copy moves to a 14-day trash inside the same library folder (decision E).
 */
export async function removeFromLibrary(app: Reelix, input: { title_id: string; level: RemoveLevel; season?: number; episodes?: number[]; paths?: string[] }): Promise<RemoveOutput> {
	const title = requireTitle(app, input.title_id);
	let files = titleFiles(app, title.id).filter((f) => f.exists || f.kind === "disc");
	if (input.paths?.length) files = files.filter((f) => input.paths!.includes(f.dest));
	if (input.season !== undefined) files = files.filter((f) => f.episodes.some((e) => e.season === input.season && (!input.episodes?.length || input.episodes.includes(e.episode))) || (f.kind === "subtitle" && /S(\d\d)E/.exec(f.dest)?.[1] === String(input.season).padStart(2, "0")));
	const out: RemoveOutput = { unlinked: [], trashed: [], notes: [] };
	const hashes = new Set<string>();
	const days = app.config.limits.trash_days;
	const expires = new Date(Date.now() + days * 86400_000).toISOString();
	const willDeleteData = input.level === "data";

	for (const f of files) {
		if (f.download_hash) hashes.add(f.download_hash);
		const root = rootOf(app, f.dest);
		if (!root) {
			out.notes.push(`Skipped ${f.dest}: not inside a library folder.`);
			continue;
		}
		const paths = f.kind === "disc" && existsSync(f.dest) && statSync(f.dest).isDirectory() ? walkFiles(f.dest) : [f.dest];
		for (const p of paths) {
			if (!existsSync(p)) continue;
			const st = lstatSync(p);
			const otherCopy = f.linked === 1 && st.nlink > 1;
			if (otherCopy) {
				// The data still exists in the download folder: remove the link only. Restorable by
				// re-linking, unless the owner also asked to delete the data (then it is gone, §9).
				rmSync(p);
				const src = f.kind === "disc" ? join(f.source ?? "", relative(f.dest, p)) : f.source;
				app.db.prepare("INSERT INTO removed (title_id, source, dest, kind, removed_at, restored_at) VALUES (?, ?, ?, ?, ?, ?)").run(title.id, src, p, f.kind, nowIso(), willDeleteData ? "never" : null);
				out.unlinked.push(p);
			} else {
				// Last copy (data already gone, or an ordinary file such as a subtitle): to the trash.
				const t = join(trashDir(root), `${Date.now()}-${basename(p)}`);
				renameSync(p, t);
				app.db.prepare("INSERT INTO removed (title_id, source, dest, kind, trash_path, removed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(title.id, f.source, p, f.kind, t, nowIso(), expires);
				out.trashed.push(p);
			}
		}
		app.db.prepare("DELETE FROM file_episodes WHERE file_id = ?").run(f.id);
		app.db.prepare("DELETE FROM files WHERE id = ?").run(f.id);
		pruneEmptyDirs(dirname(f.dest), root);
	}
	if (input.level !== "entry") {
		for (const h of hashes) {
			try {
				await app.qb().delete([h], input.level === "data");
				app.db.prepare("UPDATE downloads SET state = 'removed', note = ? WHERE hash = ?").run(input.level === "data" ? "removed with data" : "torrent removed, data kept", h);
				out.torrent = h;
			} catch (e) {
				out.notes.push(`Could not remove torrent ${h.slice(0, 10)}: ${(e as Error).message}`);
			}
		}
		out.data_deleted = input.level === "data";
	}
	if (!files.length) out.notes.push("No library files matched.");
	if (out.unlinked.length || out.trashed.length) await notifyJellyfin(app, [...out.unlinked, ...out.trashed], "Deleted").catch(() => {});
	if (!titleFiles(app, title.id).length) app.db.prepare("UPDATE titles SET library_folder = NULL WHERE id = ?").run(title.id);
	return out;
}

function walkFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...walkFiles(p));
		else out.push(p);
	}
	return out;
}

function pruneEmptyDirs(dir: string, stopAt: string): void {
	let d = dir;
	while (d.startsWith(stopAt.replace(/\/+$/, "") + "/") && d !== stopAt) {
		try {
			const left = readdirSync(d).filter((n) => n !== "@eaDir" && n !== ".DS_Store");
			if (left.length) return;
			rmSync(join(d, "@eaDir"), { recursive: true, force: true });
			rmdirSync(d);
		} catch {
			return;
		}
		d = dirname(d);
	}
}

export function listRemoved(app: Reelix, titleId?: string): { id: number; title_id: string | null; dest: string; source: string | null; trash_path: string | null; removed_at: string; expires_at: string | null; restorable: boolean }[] {
	const rows = (titleId ? app.db.prepare("SELECT * FROM removed WHERE restored_at IS NULL AND title_id = ? ORDER BY removed_at DESC").all(titleId) : app.db.prepare("SELECT * FROM removed WHERE restored_at IS NULL ORDER BY removed_at DESC LIMIT 200").all()) as any[];
	return rows.map((r) => ({ ...r, restorable: r.trash_path ? existsSync(r.trash_path) : !!r.source && existsSync(r.source) }));
}

/** Restore removed library entries: re-link from the download, or move back from the trash. */
export function restoreRemoved(app: Reelix, ids: number[]): { restored: string[]; failed: { dest: string; error: string }[] } {
	const out = { restored: [] as string[], failed: [] as { dest: string; error: string }[] };
	for (const id of ids) {
		const r = app.db.prepare("SELECT * FROM removed WHERE id = ? AND restored_at IS NULL").get(id) as any;
		if (!r) continue;
		try {
			if (existsSync(r.dest)) throw new ReelixError("exists", "something already exists there");
			mkdirSync(dirname(r.dest), { recursive: true });
			if (r.trash_path) renameSync(r.trash_path, r.dest);
			else linkSync(r.source, r.dest);
			app.db.prepare("UPDATE removed SET restored_at = ? WHERE id = ?").run(nowIso(), id);
			app.db.prepare("INSERT OR IGNORE INTO files (title_id, source, dest, kind, linked, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(r.title_id, r.source, r.dest, r.kind ?? "video", r.trash_path ? 0 : 1, nowIso());
			out.restored.push(r.dest);
		} catch (e) {
			out.failed.push({ dest: r.dest, error: (e as Error).message });
		}
	}
	return out;
}

/** Empty expired trash (nightly). */
export function emptyExpiredTrash(app: Reelix): { deleted: number; bytes: number } {
	const rows = app.db.prepare("SELECT * FROM removed WHERE trash_path IS NOT NULL AND restored_at IS NULL AND expires_at < ?").all(nowIso()) as any[];
	let bytes = 0;
	for (const r of rows) {
		try {
			if (existsSync(r.trash_path)) {
				bytes += statSync(r.trash_path).size;
				rmSync(r.trash_path, { recursive: true, force: true });
			}
			app.db.prepare("UPDATE removed SET trash_path = NULL, expires_at = NULL WHERE id = ?").run(r.id);
		} catch {
			/* retry tomorrow */
		}
	}
	return { deleted: rows.length, bytes };
}

export function trashSize(app: Reelix): number {
	let total = 0;
	for (const r of app.db.prepare("SELECT trash_path FROM removed WHERE trash_path IS NOT NULL AND restored_at IS NULL").all() as { trash_path: string }[]) {
		try {
			total += statSync(r.trash_path).size;
		} catch {}
	}
	return total;
}

/** Titles in the library: Reelix's records plus folders found on disk with a [tmdbid-N] tag. */
export function libraryOverview(app: Reelix): { titles: (Title & { file_count: number })[]; untracked_folders: string[] } {
	const titles = app.db.prepare("SELECT t.*, (SELECT COUNT(*) FROM files f WHERE f.title_id = t.id AND f.kind IN ('video','disc')) AS file_count FROM titles t WHERE t.library_folder IS NOT NULL OR EXISTS (SELECT 1 FROM files f WHERE f.title_id = t.id) ORDER BY t.updated_at DESC").all() as any[];
	const known = new Set(titles.map((t) => t.library_folder).filter(Boolean));
	const untracked: string[] = [];
	for (const root of Object.values(libraryRoots(app))) {
		if (!root || !existsSync(root)) continue;
		for (const e of readdirSync(root, { withFileTypes: true })) {
			if (e.isDirectory() && !e.name.startsWith(".") && !known.has(join(root, e.name))) untracked.push(join(root, e.name));
		}
	}
	return { titles: titles.map((t) => ({ ...t, names: JSON.parse(t.names_json), bangumi_ids: JSON.parse(t.bangumi_ids_json), seasons: JSON.parse(t.seasons_json ?? "[]") })), untracked_folders: untracked.slice(0, 500) };
}

/** Does the library already have this title (and these episodes)? The folder with [tmdbid-N] is the truth (§5.2). */
export function haveInLibrary(app: Reelix, title: Title): { folder?: string; episodes: { season: number; episode: number }[]; files: string[] } {
	const files = titleFiles(app, title.id).filter((f) => f.exists && (f.kind === "video" || f.kind === "disc"));
	const episodes = files.flatMap((f) => f.episodes);
	let folder = title.library_folder ?? undefined;
	if (!files.length && title.tmdb_id) {
		for (const root of Object.values(libraryRoots(app))) {
			if (!root || !existsSync(root)) continue;
			const hit = readdirSync(root).find((n) => n.includes(`[tmdbid-${title.tmdb_id}]`));
			if (hit) {
				folder = join(root, hit);
				break;
			}
		}
	}
	return { folder, episodes, files: files.map((f) => f.dest) };
}
