import { useQuery } from "@tanstack/react-query";
import { FolderInput, FolderSearch, Library, Rss, Search, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { AskAbout } from "../components/common/AskAbout";
import { Poster } from "../components/common/Poster";
import { Screen } from "../components/common/Screen";
import { Empty, ErrorState } from "../components/common/States";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { endpoints } from "../lib/api";
import { useFollows } from "../components/media/Follows";
import { PlayButton } from "../components/media/PlayButton";
import type { LibraryList, PlayTarget } from "../lib/types";
import { cn, formatNumber } from "../lib/utils";
import { useShortPath } from "../lib/paths";

type Item = LibraryList["titles"][number];

const GRID = "grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

function MediaCard({ t, followed, play }: { t: Item; followed?: boolean; play?: PlayTarget }) {
	const { t: tr } = useTranslation("library");
	const kinds: Record<string, string> = { movie: tr("kinds.movie"), show: tr("kinds.show"), anime: tr("kinds.anime") };
	return (
		<div className="group relative">
		<Link to={`/library/${encodeURIComponent(t.id)}`} className="group block focus-visible:outline-none">
			<div className="relative overflow-hidden rounded-xl shadow-[0_12px_30px_rgb(0_0_0/0.3)] transition-all group-hover:-translate-y-1 group-hover:shadow-[0_20px_40px_rgb(0_0_0/0.4)] group-hover:ring-2 group-hover:ring-primary/50 group-focus-visible:ring-2 group-focus-visible:ring-primary">
				<Poster path={t.poster_path} alt={t.name} className="rounded-none" />
				<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-2 pt-8">
					<p className="display line-clamp-2 text-base leading-tight text-white">{t.name}</p>
					<div className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-300">
						<span>{t.year ?? "—"}</span>
						{t.rating ? (
							<span className="inline-flex items-center gap-0.5">
								<Star className="h-3 w-3 text-rating" />
								{formatNumber(Number(t.rating), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
							</span>
						) : null}
						<span className="ml-auto">{tr("wall.files", { count: t.file_count })}</span>
					</div>
				</div>
				{followed && <Rss className="absolute left-2 top-2 h-4 w-4 rounded bg-black/60 p-0.5 text-primary" aria-label={tr("wall.followed")} />}
				{t.media_class && t.media_class !== "movie" && <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">{kinds[t.media_class] ?? t.media_class}</span>}
			</div>
		</Link>
		{play && <PlayButton target={play} compact className="absolute left-1/2 top-[38%] -translate-x-1/2 -translate-y-1/2 opacity-100 transition-opacity md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100" />}
		</div>
	);
}

/** The poster wall (what Dashboard was). */
export function LibraryScreen() {
	const { t: tr } = useTranslation(["library", "common"]);
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["library"], queryFn: endpoints.libraryList });
	const [cls, setCls] = useState("all");
	const [q, setQ] = useState("");
	const [showUntracked, setShowUntracked] = useState(false);
	const follows = useFollows();
	const short = useShortPath();
	// Fetched ahead so a poster's button opens the player within the tap itself.
	const play = useQuery({ queryKey: ["play-links"], queryFn: endpoints.playLinks, staleTime: 60_000 });
	const followed = useMemo(() => new Set((follows.data ?? []).filter((f) => Number(f.active)).map((f) => f.title_id)), [follows.data]);
	const titles = useMemo(() => {
		const needle = q.trim().toLowerCase();
		return (data?.titles ?? []).filter(
			(t) => (cls === "all" || (cls === "following" ? followed.has(t.id) : t.media_class === cls)) && (!needle || [t.name, t.original_name, ...(t.names ?? [])].some((n) => n?.toLowerCase().includes(needle))),
		);
	}, [data, cls, q, followed]);
	const untracked = data?.untracked_folders ?? [];

	return (
		<Screen
			title={tr("wall.title")}
			subtitle={data ? `${tr("wall.titles", { count: data.titles.length })}${untracked.length ? ` · ${tr("wall.untrackedShort", { count: untracked.length })}` : ""}` : tr("wall.subtitleEmpty")}
			actions={(scrolled) => (
				<>
				<Button asChild variant="outline" size={scrolled ? "sm" : "default"}>
					<Link to="/library/adopt" title={tr("wall.adopt")}>
						<FolderInput />
						<span className="hidden lg:inline">{tr("wall.adopt")}</span>
					</Link>
				</Button>
				<Button asChild size={scrolled ? "sm" : "default"}>
					<Link to="/trends">
						<Search />
						<span className={cn(scrolled && "hidden sm:inline")}>{tr("wall.find")}</span>
					</Link>
				</Button>
				</>
			)}
			toolbar={
				<div className="flex flex-wrap items-center gap-2">
					<Tabs value={cls} onValueChange={setCls}>
						<TabsList className="max-w-full justify-start overflow-x-auto">
							<TabsTrigger value="all">{tr("wall.tabs.all")}</TabsTrigger>
							<TabsTrigger value="movie">{tr("wall.tabs.movie")}</TabsTrigger>
							<TabsTrigger value="show">{tr("wall.tabs.show")}</TabsTrigger>
							<TabsTrigger value="anime">{tr("wall.tabs.anime")}</TabsTrigger>
							<TabsTrigger value="following">{tr("wall.tabs.following")}</TabsTrigger>
						</TabsList>
					</Tabs>
					<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("wall.filter")} className="h-10 w-full sm:w-60" />
				</div>
			}
		>
			{error ? (
				<ErrorState error={error} onRetry={() => refetch()} />
			) : isLoading ? (
				<div className={GRID}>
					{Array.from({ length: 12 }).map((_, i) => (
						<div key={i} className="aspect-[2/3] w-full animate-pulse rounded-lg bg-muted" />
					))}
				</div>
			) : titles.length === 0 ? (
				<Empty icon={<Library />} title={data?.titles.length ? tr("wall.noMatch") : tr("wall.empty")}>
					{data?.titles.length ? null : tr("wall.emptyHint")}
				</Empty>
			) : (
				<div className={GRID}>
					{titles.map((t) => (
						<MediaCard key={t.id} t={t} followed={followed.has(t.id)} play={play.data?.targets[t.id]} />
					))}
				</div>
			)}

			{untracked.length > 0 && (
				<div className="surface-card mt-8 rounded-xl p-4">
					<div className="flex flex-wrap items-center gap-2">
						<FolderSearch className="h-4 w-4 text-warning" />
						<p className="text-sm font-semibold">{tr("wall.untracked", { count: untracked.length })}</p>
						<Button variant="ghost" size="sm" className="h-8" onClick={() => setShowUntracked((s) => !s)}>
							{showUntracked ? tr("common:actions.hide") : tr("common:actions.show")}
						</Button>
						<AskAbout className="ml-auto" text={tr("wall.askAdoptPrompt", { count: untracked.length, examples: untracked.slice(0, 3).map((f) => short(f)).join(", ") })} label={tr("wall.askAdopt")} />
					</div>
					{showUntracked && (
						<ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
							{untracked.map((f) => (
								<li key={f} className="break-all">
									{short(f)}
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</Screen>
	);
}
