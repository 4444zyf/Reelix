import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startPlugins } from "@reelix/plugin-testing";
import { Reelix } from "../src/app.ts";

export function tempApp(opts: { base?: string } = {}) {
	const root = mkdtempSync(join(opts.base ?? tmpdir(), "reelix-test-"));
	const media = join(root, "media");
	const downloads = join(media, "torrents");
	const library = join(media, "library");
	for (const d of [downloads, join(library, "Movies"), join(library, "Shows"), join(library, "Anime")]) mkdirSync(d, { recursive: true });
	const app = new Reelix(join(root, "data"));
	app.setConfig("downloads", downloads);
	app.setConfig("library", { movies: join(library, "Movies"), shows: join(library, "Shows"), anime: join(library, "Anime") });
	return { app, root, media, downloads, library };
}

/** The built-in plugins of this repository. */
export const PLUGINS = join(import.meta.dirname, "../../../plugins");

/** Start built-in plugins on this app, through the real loading path. Returns the step that stops them. */
export async function withPlugins(app: Reelix, ids: string[]): Promise<() => Promise<void>> {
	const t = await startPlugins(ids.map((id) => join(PLUGINS, id)), { app });
	return t.close;
}

export function touch(path: string, size = 16): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, Buffer.alloc(size, 7));
	return path;
}

export function insertTitle(app: Reelix, t: { id: string; kind: "movie" | "tv"; tmdb_id?: number; name: string; folder_name?: string; year?: number; media_class?: string; runtime_min?: number }) {
	app.db
		.prepare("INSERT INTO titles (id, kind, tmdb_id, media_class, name, original_name, folder_name, year, runtime_min, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))")
		.run(t.id, t.kind, t.tmdb_id ?? null, t.media_class ?? (t.kind === "movie" ? "movie" : "show"), t.name, t.folder_name ?? t.name, t.folder_name ?? t.name, t.year ?? null, t.runtime_min ?? null);
}
