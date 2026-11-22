import { existsSync, readdirSync } from "node:fs";
import { basename, relative, sep } from "node:path";
import type { Reelix } from "./app.ts";
import type { LibraryFolder, LibraryWhen } from "./config.ts";
import { type MediaClass, type TitleLike, mediaClassOf } from "./naming.ts";
import { type Title, fetchTitle, getTitle } from "./titles.ts";
import { ReelixError, sleep } from "./util.ts";

/**
 * Several library folders per media type (docs/library-folders.md): which folder a title goes to,
 * decided once, before the naming rules. Code applies the rules; the agent decides what they do not.
 */

const SETTING: Record<MediaClass, "movies" | "shows" | "anime"> = { movie: "movies", show: "shows", anime: "anime" };
const FACTS = ["original_language", "origin_country", "genre"] as const;

/** A title as far as choosing its folder goes. */
export type FolderTitle = TitleLike & {
	id?: string;
	library_folder?: string | null;
	library_choice?: string | null;
	original_language?: string | null;
	origin_country?: string[];
	genres?: string[];
};

export type Decided = { folder: LibraryFolder; how: "there" | "chosen" | "rule" | "only" | "default"; rule?: LibraryWhen };
export type FolderDecision = Decided | { undecided: LibraryFolder[] };

/** Why a folder was chosen, in words for plans and the agent. */
export function decidedText(d: Decided): string {
	return { there: "the title is already there", chosen: "chosen for this title", rule: `rule ${whenText(d.rule ?? {})}`, only: "the only folder", default: "the default" }[d.how];
}

/** The folders of a media type, in order. Anime with none of its own uses the shows' folders. */
export function foldersOf(app: Reelix, cls: MediaClass): LibraryFolder[] {
	const own = app.config.library[SETTING[cls]];
	return own.length || cls !== "anime" ? own : app.config.library.shows;
}

/** Every library folder of every media type, once each, named for messages ("movies: International"). */
export function everyLibraryFolder(app: Reelix): { label: string; path: string }[] {
	const seen = new Set<string>();
	return (["movies", "shows", "anime"] as const).flatMap((k) =>
		app.config.library[k].filter((f) => !seen.has(f.path) && seen.add(f.path)).map((f) => ({ label: app.config.library[k].length > 1 ? `${k}: ${folderLabel(f)}` : k, path: f.path })),
	);
}

export function allLibraryFolders(app: Reelix): string[] {
	return everyLibraryFolder(app).map((f) => f.path);
}

export function folderLabel(f: LibraryFolder): string {
	return f.name || basename(f.path);
}

export function within(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

type Facts = Pick<FolderTitle, "original_language" | "origin_country" | "genres">;

function factsOf(t: Facts): Record<(typeof FACTS)[number], string[]> {
	return { original_language: t.original_language ? [t.original_language] : [], origin_country: t.origin_country ?? [], genre: t.genres ?? [] };
}

/** A rule matches when, for every fact it names, the title has one of the listed values. A rule naming nothing matches nothing. */
export function ruleMatches(when: LibraryWhen, t: Facts): boolean {
	const facts = factsOf(t);
	const named = FACTS.filter((k) => when[k]?.length);
	return named.length > 0 && named.every((k) => when[k]!.some((v) => facts[k].some((f) => f.toLowerCase() === v.toLowerCase())));
}

export function whenText(when: LibraryWhen): string {
	return FACTS.filter((k) => when[k]?.length).map((k) => `${k} ${when[k]!.join("/")}`).join(" and ");
}

/** Steps 3 and 5 alone: what the rules and the default would say, ignoring where the title already is. */
function byRules(folders: LibraryFolder[], t: Facts): Decided | undefined {
	for (const f of folders) {
		const rule = f.rules?.find((r) => ruleMatches(r.when, t));
		if (rule) return { folder: f, how: "rule", rule: rule.when };
	}
	if (folders.length === 1) return { folder: folders[0]!, how: "only" };
	const d = folders.find((f) => f.default);
	return d ? { folder: d, how: "default" } : undefined;
}

/** Where a title already is: its recorded folder, or a folder with its [tmdbid-N] tag. */
function alreadyIn(app: Reelix, folders: LibraryFolder[], t: FolderTitle): LibraryFolder | undefined {
	if (t.library_folder) {
		const own = folders.find((f) => within(t.library_folder!, f.path));
		if (own) return own;
		const path = allLibraryFolders(app).find((p) => within(t.library_folder!, p));
		if (path) return [...app.config.library.movies, ...app.config.library.shows, ...app.config.library.anime].find((f) => f.path === path);
	}
	if (t.tmdb_id) {
		const tag = `[tmdbid-${t.tmdb_id}]`;
		return folders.find((f) => existsSync(f.path) && readdirSync(f.path).some((n) => n.includes(tag)));
	}
	return undefined;
}

/** The folder for a title (docs/library-folders.md, "Choosing the folder for a title"). */
export function libraryFolderFor(app: Reelix, t: FolderTitle): FolderDecision {
	const cls = mediaClassOf(t);
	const folders = foldersOf(app, cls);
	if (!folders.length) {
		const key = SETTING[cls];
		throw new ReelixError("not_configured", `No library folder for ${key} is set (Settings → Paths, setting library.${key}).`);
	}
	const there = alreadyIn(app, folders, t);
	if (there) return { folder: there, how: "there" };
	const chosen = t.library_choice ? folders.find((f) => f.path === t.library_choice) : undefined;
	if (chosen) return { folder: chosen, how: "chosen" };
	return byRules(folders, t) ?? { undecided: folders };
}

/** The folder's path, or an error that hands the decision to the agent (or the owner). */
export function libraryRootFor(app: Reelix, t: FolderTitle): string {
	const d = libraryFolderFor(app, t);
	if ("folder" in d) return d.folder.path;
	throw new ReelixError("library_undecided", undecidedProblem(t, d.undecided));
}

/** Why code cannot file the title yet, worded for the agent that takes it over. */
export function undecidedProblem(t: FolderTitle, folders: LibraryFolder[]): string {
	return `No library folder is decided for "${t.name}": its type has several folders (${folders.map(folderLabel).join(", ")}) and no rule, choice or default decides. Load the library-folders skill: choose one with title.library_folder.set, then file it again.`;
}

/** Record the folder chosen for a title that is not filed yet. An empty folder clears the choice. */
export function setLibraryChoice(app: Reelix, title: Title, folder: string): { title: string; folder: string | null } {
	if (!folder) {
		app.db.prepare("UPDATE titles SET library_choice = NULL WHERE id = ?").run(title.id);
		return { title: title.id, folder: null };
	}
	const folders = foldersOf(app, mediaClassOf(title));
	const f = folders.find((x) => x.path === folder || folderLabel(x) === folder);
	if (!f) throw new ReelixError("invalid_input", `"${folder}" is not a library folder for ${SETTING[mediaClassOf(title)]}. Its folders: ${folders.map((x) => `${folderLabel(x)} (${x.path})`).join("; ") || "none"}.`);
	const there = alreadyIn(app, folders, title);
	if (there && there.path !== f.path) throw new ReelixError("invalid_input", `"${title.name}" is already in ${folderLabel(there)}. Moving a filed title to another folder is not supported; it stays where it is.`);
	app.db.prepare("UPDATE titles SET library_choice = ? WHERE id = ?").run(f.path, title.id);
	return { title: title.id, folder: f.path };
}

// ------------------------------------------------------------------ the survey the agent learns from

export type SurveyTitle = { id?: string; folder: string; name: string; year?: number | null; original_language?: string | null; origin_country: string[]; genres: string[] };
export type SurveyFolder = {
	type: "movies" | "shows" | "anime";
	path: string;
	name: string;
	default: boolean;
	rules: { when: LibraryWhen; note?: string }[];
	titles: SurveyTitle[];
	/** Folders without a [tmdbid-N] tag: not identified. */
	untagged: string[];
	counts: Record<(typeof FACTS)[number], Record<string, number>>;
};
export type Survey = {
	folders: SurveyFolder[];
	/** Titles the current rules and default would put in another folder of their type than the one they are in. */
	misfits: { name: string; in: string; rules_say: string | null }[];
	/** Titles whose facts could not be read from TMDB this time (not configured, or the limit below). */
	unread: number;
};

const SURVEY_FETCH_LIMIT = 200;

/** What each library folder holds, with the TMDB facts the rules can match (operation library.folders.survey). */
export async function surveyLibraryFolders(app: Reelix, type?: "movies" | "shows" | "anime"): Promise<Survey> {
	const types = type ? [type] : (["movies", "shows", "anime"] as const);
	const out: SurveyFolder[] = [];
	let fetched = 0;
	let unread = 0;
	for (const k of types) {
		for (const f of app.config.library[k]) {
			const sf: SurveyFolder = { type: k, path: f.path, name: folderLabel(f), default: !!f.default, rules: f.rules ?? [], titles: [], untagged: [], counts: { original_language: {}, origin_country: {}, genre: {} } };
			const names = existsSync(f.path) ? readdirSync(f.path, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name) : [];
			for (const n of names) {
				const tmdb = /\[tmdbid-(\d+)\]/.exec(n)?.[1];
				if (!tmdb) {
					sf.untagged.push(n);
					continue;
				}
				const kind = k === "movies" ? "movie" : "tv";
				let t = getTitle(app, `${kind}:${tmdb}`);
				if ((!t || (!t.original_language && !t.genres.length)) && !!app.secrets["tmdb.api_key"] && fetched < SURVEY_FETCH_LIMIT) {
					fetched++;
					t = await fetchTitle(app, kind, Number(tmdb)).catch(() => t);
					await sleep(150); // TMDB allows ~40 requests/s; stay far below
				}
				if (!t || (!t.original_language && !t.genres.length)) unread++;
				const st: SurveyTitle = { id: t?.id, folder: n, name: t?.name ?? n, year: t?.year, original_language: t?.original_language, origin_country: t?.origin_country ?? [], genres: t?.genres ?? [] };
				sf.titles.push(st);
				for (const [fact, values] of Object.entries(factsOf(st))) for (const v of values) sf.counts[fact as keyof SurveyFolder["counts"]][v] = (sf.counts[fact as keyof SurveyFolder["counts"]][v] ?? 0) + 1;
			}
			out.push(sf);
		}
	}
	const misfits: Survey["misfits"] = [];
	for (const sf of out) {
		const folders = app.config.library[sf.type];
		if (folders.length < 2) continue;
		for (const t of sf.titles) {
			if (!t.original_language && !t.genres.length) continue;
			const said = byRules(folders, t);
			if (said?.folder.path !== sf.path) misfits.push({ name: t.name, in: sf.name, rules_say: said ? folderLabel(said.folder) : null });
		}
	}
	return { folders: out, misfits, unread };
}
