import { useQuery } from "@tanstack/react-query";
import { FolderInput, FolderSearch, Library, Rss, Search, Star } from "lucide-react";
import { useMemo, useState } from "react";
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
import type { LibraryList } from "../lib/types";
import { cn } from "../lib/utils";

type Item = LibraryList["titles"][number];

const GRID = "grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

function MediaCard({ t, followed }: { t: Item; followed?: boolean }) {
	return (
		<Link to={`/library/${encodeURIComponent(t.id)}`} className="group block focus-visible:outline-none">
			<div className="relative overflow-hidden rounded-lg shadow-md transition-all group-hover:scale-[1.03] group-hover:shadow-xl group-hover:ring-2 group-hover:ring-primary/50 group-focus-visible:ring-2 group-focus-visible:ring-primary">
				<Poster path={t.poster_path} alt={t.name} />
				<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-2 pt-8">
					<p className="line-clamp-2 text-sm font-semibold leading-tight text-white">{t.name}</p>
					<div className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-300">
						<span>{t.year ?? "—"}</span>
						{t.rating ? (
							<span className="inline-flex items-center gap-0.5">
								<Star className="h-3 w-3 text-yellow-500" />
								{Number(t.rating).toFixed(1)}
							</span>
						) : null}
						<span className="ml-auto">{t.file_count} files</span>
					</div>
				</div>
				{followed && <Rss className="absolute left-2 top-2 h-4 w-4 rounded bg-black/60 p-0.5 text-primary" aria-label="followed" />}
				{t.media_class && t.media_class !== "movie" && <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">{t.media_class}</span>}
			</div>
		</Link>
	);
}

/** The poster wall (what Dashboard was). */
export function LibraryScreen() {
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["library"], queryFn: endpoints.libraryList });
	const [cls, setCls] = useState("all");
	const [q, setQ] = useState("");
	const [showUntracked, setShowUntracked] = useState(false);
	const follows = useFollows();
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
			title="Library"
			subtitle={data ? `${data.titles.length} titles${untracked.length ? ` · ${untracked.length} folders not tracked` : ""}` : "Your films, shows and anime"}
			actions={(scrolled) => (
				<>
				<Button asChild variant="outline" size={scrolled ? "sm" : "default"}>
					<Link to="/library/adopt" title="Adopt existing downloads">
						<FolderInput />
						<span className="hidden lg:inline">Adopt existing downloads</span>
					</Link>
				</Button>
				<Button asChild size={scrolled ? "sm" : "default"}>
					<Link to="/search">
						<Search />
						<span className={cn(scrolled && "hidden sm:inline")}>Find a title</span>
					</Link>
				</Button>
				</>
			)}
			toolbar={
				<div className="flex flex-wrap items-center gap-2">
					<Tabs value={cls} onValueChange={setCls}>
						<TabsList className="max-w-full justify-start overflow-x-auto">
							<TabsTrigger value="all">All</TabsTrigger>
							<TabsTrigger value="movie">Films</TabsTrigger>
							<TabsTrigger value="show">Shows</TabsTrigger>
							<TabsTrigger value="anime">Anime</TabsTrigger>
							<TabsTrigger value="following">Following</TabsTrigger>
						</TabsList>
					</Tabs>
					<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name" className="h-10 w-full sm:w-60" />
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
				<Empty icon={<Library />} title={data?.titles.length ? "No titles match" : "The library is empty"}>
					{data?.titles.length ? null : "Ask Reelix for something to watch, or find a title by hand."}
				</Empty>
			) : (
				<div className={GRID}>
					{titles.map((t) => (
						<MediaCard key={t.id} t={t} followed={followed.has(t.id)} />
					))}
				</div>
			)}

			{untracked.length > 0 && (
				<div className="glass-card mt-8 rounded-xl p-4">
					<div className="flex flex-wrap items-center gap-2">
						<FolderSearch className="h-4 w-4 text-warning" />
						<p className="text-sm font-semibold">{untracked.length} folders in the library that Reelix does not track</p>
						<Button variant="ghost" size="sm" className="h-8" onClick={() => setShowUntracked((s) => !s)}>
							{showUntracked ? "Hide" : "Show"}
						</Button>
						<AskAbout className="ml-auto" text={`There are ${untracked.length} untracked folders in the library (for example ${untracked.slice(0, 3).join(", ")}). Please identify and adopt them.`} label="Ask the agent to adopt them" />
					</div>
					{showUntracked && (
						<ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
							{untracked.map((f) => (
								<li key={f} className="break-all">
									{f}
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</Screen>
	);
}
