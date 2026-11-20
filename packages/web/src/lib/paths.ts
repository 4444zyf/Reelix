import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { endpoints } from "./api";

/*
 * Paths on screen are shown relative to the library, never as the NAS's own folders
 * (docs/trends.md §3). The agent, the command line and the API still use real paths.
 */

export type Root = { path: string; label: string };

const SEP = " › ";
const trim = (p: string) => p.replace(/[\\/]+$/, "");
const parts = (p: string) => p.split(/[\\/]+/).filter(Boolean);

/** `path` from `base` if it is inside it, else from the deepest known root (named by its label), else its last two parts. */
export function shortPath(path: string | null | undefined, roots: Root[], base?: string | null): string {
	if (!path) return "";
	const p = trim(path);
	const inside = (root: string) => {
		const r = trim(root);
		return p === r || p.startsWith(`${r}/`) || p.startsWith(`${r}\\`);
	};
	if (base && trim(base) !== p && inside(base)) return parts(p.slice(trim(base).length)).join(SEP);
	const root = roots.filter((r) => r.path && inside(r.path)).sort((a, b) => b.path.length - a.path.length)[0];
	if (root) return [root.label, ...parts(p.slice(trim(root.path).length))].join(SEP);
	const ps = parts(p);
	return (ps.length > 2 ? ["…", ...ps.slice(-2)] : ps).join(SEP);
}

/** The library folders and the download folder, named by what they hold. */
export function useShortPath(): (path: string | null | undefined, base?: string | null) => string {
	const { t } = useTranslation(["library", "nav"]);
	const config = useQuery({ queryKey: ["config"], queryFn: endpoints.config, staleTime: 5 * 60_000 });
	const c = config.data?.config;
	const roots: Root[] = [
		{ path: c?.library?.movies, label: t("library:wall.tabs.movie") },
		{ path: c?.library?.shows, label: t("library:wall.tabs.show") },
		{ path: c?.library?.anime, label: t("library:wall.tabs.anime") },
		{ path: c?.downloads, label: t("nav:items.downloads") },
	].filter((r): r is Root => typeof r.path === "string" && !!r.path);
	const key = roots.map((r) => `${r.path}=${r.label}`).join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: roots are rebuilt from `key`
	return useCallback((path, base) => shortPath(path, roots, base), [key]);
}
