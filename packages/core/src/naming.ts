import { extname } from "node:path";
import { pad2, safeName } from "./util.ts";

export type MediaClass = "movie" | "show" | "anime";

export type TitleLike = {
	kind: "movie" | "tv";
	tmdb_id?: number | null;
	media_class: string;
	name: string;
	folder_name?: string | null;
	original_name?: string | null;
	year?: number | null;
};

/** `Name (Year) [tmdbid-N]` — Jellyfin honours the ID tag on movie and series folders (§5.4). */
export function folderName(t: TitleLike): string {
	const base = safeName(t.folder_name || t.original_name || t.name);
	const year = t.year ? ` (${t.year})` : "";
	const tag = t.tmdb_id ? ` [tmdbid-${t.tmdb_id}]` : "";
	return `${base}${year}${tag}`;
}

/** Base name for episode files: `Name (Year)` without the ID tag. */
export function showBase(t: TitleLike): string {
	return `${safeName(t.folder_name || t.original_name || t.name)}${t.year ? ` (${t.year})` : ""}`;
}

export function mediaClassOf(t: TitleLike): MediaClass {
	if (t.media_class === "movie" || t.media_class === "show" || t.media_class === "anime") return t.media_class;
	return t.kind === "movie" ? "movie" : "show";
}

export function episodeTag(season: number, episodes: number[]): string {
	const sorted = [...episodes].sort((a, b) => a - b);
	const first = sorted[0]!;
	const last = sorted[sorted.length - 1]!;
	const width = last >= 100 ? 3 : 2;
	const e = (n: number) => String(n).padStart(width, "0");
	return first === last ? `S${pad2(season)}E${e(first)}` : `S${pad2(season)}E${e(first)}-E${e(last)}`;
}

export function seasonFolder(season: number): string {
	return `Season ${pad2(season)}`;
}

/** Relative path inside the class root, e.g. `Oppenheimer (2023) [tmdbid-872585]/Oppenheimer (2023) [tmdbid-872585] - 2160p.mkv`. */
export function movieRelPath(t: TitleLike, ext: string, version?: string): string {
	const f = folderName(t);
	const label = version ? ` - ${safeName(version)}` : "";
	return `${f}/${f}${label}${ext.startsWith(".") ? ext : "." + ext}`;
}

export function episodeRelPath(t: TitleLike, season: number, episodes: number[], ext: string, version?: string): string {
	const label = version ? ` - ${safeName(version)}` : "";
	return `${folderName(t)}/${seasonFolder(season)}/${showBase(t)} ${episodeTag(season, episodes)}${label}${ext.startsWith(".") ? ext : "." + ext}`;
}

/** What is wrong with one folder or file name in the library, if anything. */
function nameProblem(name: string): string | undefined {
	if (!name || name === "." || name === "..") return "an empty or relative path part";
	if (name.startsWith(".")) return `"${name}" starts with a dot`;
	if (safeName(name) !== name) return `"${name}" has characters a library name cannot have`;
	return Buffer.byteLength(name) > 255 ? `"${name}" is longer than 255 bytes` : undefined;
}

/**
 * The limits on a path a plan may use, relative to the library folder (docs/plugins.md §8): the title
 * folder stays, with its `[tmdbid-N]` tag, and so do the depth and the extension.
 * For items the agent wrote there is no earlier path: `depths` then says what fits their kind.
 * A folder (a disc) has no `extension` to keep; the case of an extension may change.
 */
export function libraryPathProblem(path: string, want: { titleFolders?: string[]; depths: number[]; extension?: string }): string | undefined {
	const parts = path.split("/");
	for (const part of parts) {
		const problem = nameProblem(part);
		if (problem) return problem;
	}
	if (want.titleFolders && !want.titleFolders.includes(parts[0]!)) return `it must stay in the title folder "${want.titleFolders[0]}"`;
	if (!want.depths.includes(parts.length)) return `it must be ${want.depths.join(" or ")} levels deep`;
	if (want.extension === undefined || extname(path).toLowerCase() === want.extension.toLowerCase()) return undefined;
	return `it must keep the extension "${want.extension}"`;
}

/** Subtitle name next to a video: `<video base>.<lang>[.default][.forced].<ext>`. Exact suffix still to verify against Jellyfin (§13). */
export function subtitlePathFor(videoPath: string, lang: string, ext: string, opts: { default?: boolean; label?: string } = {}): string {
	const base = videoPath.slice(0, videoPath.length - extname(videoPath).length);
	const parts = [base];
	if (opts.label) parts.push(safeName(opts.label));
	parts.push(lang);
	if (opts.default) parts.push("default");
	return parts.join(".") + (ext.startsWith(".") ? ext : "." + ext);
}
