import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search, Sparkles, Star, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { CandidatesCard } from "../components/cards/CandidatesCard";
import { TitleCard } from "../components/cards/TitleCard";
import { AskAbout } from "../components/common/AskAbout";
import { Poster } from "../components/common/Poster";
import { Screen } from "../components/common/Screen";
import { Empty, ErrorState, Loading, Spinner } from "../components/common/States";
import { IndexerLine, ReleaseList } from "../components/media/ReleaseList";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { endpoints } from "../lib/api";
import type { Suggestion, Title, TrendItem } from "../lib/types";
import { formatNumber, timeAgo, titleLabel } from "../lib/utils";

const SORTS = [
	{ value: "", label: "search.sortBest" },
	{ value: "seeders", label: "search.sortSeeders" },
	{ value: "size", label: "search.sortSize" },
	{ value: "date", label: "search.sortDate" },
] as const;

function Releases({ title }: { title: Title }) {
	const { t } = useTranslation(["media", "common"]);
	const isShow = title.kind === "tv";
	const [season, setSeason] = useState("");
	const [episode, setEpisode] = useState("");
	const [sort, setSort] = useState("");
	const [submitted, setSubmitted] = useState<{ season?: number; episode?: number; sort?: string }>({});
	const q = useQuery({
		queryKey: ["releases", title.id, submitted],
		queryFn: () => endpoints.releaseSearch({ title_id: title.id, ...submitted, limit: 50 }),
		staleTime: 5 * 60_000,
		retry: false,
	});
	const releases = q.data?.all?.length ? q.data.all : (q.data?.releases ?? []);
	return (
		<div className="space-y-3">
			<form
				className="flex flex-wrap items-end gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					setSubmitted({ season: season ? Number(season) : undefined, episode: episode ? Number(episode) : undefined, sort: sort || undefined });
				}}
			>
				{isShow && (
					<>
						<label className="text-xs text-muted-foreground">
							{t("shared.season")}
							<Input value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, ""))} placeholder={t("search.any")} inputMode="numeric" className="mt-1 h-9 w-20" />
						</label>
						<label className="text-xs text-muted-foreground">
							{t("search.episode")}
							<Input value={episode} onChange={(e) => setEpisode(e.target.value.replace(/\D/g, ""))} placeholder={t("search.any")} inputMode="numeric" className="mt-1 h-9 w-20" disabled={!season} />
						</label>
					</>
				)}
				<label className="text-xs text-muted-foreground">
					{t("search.sort")}
					<select value={sort} onChange={(e) => setSort(e.target.value)} className="mt-1 block h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground">
						{SORTS.map((s) => (
							<option key={s.value} value={s.value}>
								{t(s.label)}
							</option>
						))}
					</select>
				</label>
				<Button type="submit" size="sm" className="h-9" disabled={q.isFetching}>
					{q.isFetching ? <Spinner /> : <RefreshCw />}
					{t("search.searchReleases")}
				</Button>
				<AskAbout className="ml-auto" text={t("search.askFind", { title: titleLabel(title), id: title.id })} label={t("shared.letAgentChoose")} />
			</form>
			{q.isLoading ? (
				<Loading label={t("search.askingIndexers")} />
			) : q.error ? (
				<ErrorState error={q.error} onRetry={() => q.refetch()} />
			) : q.data ? (
				<>
					<IndexerLine indexers={q.data.indexers} total={q.data.total} />
					{q.data.queries?.length ? <p className="text-xs text-muted-foreground">{t("search.searchedFor", { queries: q.data.queries.join(" · ") })}</p> : null}
					{releases.length === 0 ? <Empty icon={<Search />} title={t("search.noReleases")} /> : <ReleaseList releases={releases} titleId={title.id} />}
				</>
			) : null}
		</div>
	);
}

const GRID = "grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

/** A poster that opens the title: its library page when Reelix has it, else its releases here. */
function TrendPoster({ item, onOpen }: { item: TrendItem; onOpen: (id: string) => void }) {
	const { t } = useTranslation("media");
	const inner = (
		<div className="relative overflow-hidden rounded-xl shadow-[0_12px_30px_rgb(0_0_0/0.3)] transition-all group-hover:-translate-y-1 group-hover:ring-2 group-hover:ring-primary/50 group-focus-visible:ring-2 group-focus-visible:ring-primary">
			<Poster path={item.poster_path} alt={item.name} className="rounded-none" />
			<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-2 pt-8 text-left">
				<p className="display line-clamp-2 text-base leading-tight text-white">{item.name}</p>
				<div className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-300">
					<span>{item.year ?? "—"}</span>
					{item.rating ? (
						<span className="inline-flex items-center gap-0.5">
							<Star className="h-3 w-3 text-rating" />
							{formatNumber(item.rating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
						</span>
					) : null}
					<span className="ml-auto">{item.kind === "tv" ? t("trends.show") : t("trends.film")}</span>
				</div>
			</div>
			{item.in_library && <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-success">{t("trends.inLibrary")}</span>}
		</div>
	);
	return item.in_library ? (
		<Link to={`/library/${encodeURIComponent(item.id)}`} className="group block focus-visible:outline-none">
			{inner}
		</Link>
	) : (
		<button type="button" onClick={() => onOpen(item.id)} className="group block w-full focus-visible:outline-none">
			{inner}
		</button>
	);
}

/** "For you": picked by a model from TMDB's lists, using the owner's notes and library (docs/trends.md §2). */
function ForYou({ onOpen }: { onOpen: (id: string) => void }) {
	const { t } = useTranslation(["media", "common"]);
	const q = useQuery({
		queryKey: ["suggestions"],
		queryFn: endpoints.suggestions,
		refetchInterval: (query) => (query.state.data?.working ? 3000 : false),
		staleTime: 60_000,
	});
	const [refreshing, setRefreshing] = useState(false);
	const working = refreshing || !!q.data?.working;
	const s = q.data?.suggestions;
	const refresh = async () => {
		setRefreshing(true);
		try {
			await endpoints.refreshSuggestions();
			await q.refetch();
		} finally {
			setRefreshing(false);
		}
	};

	let content: ReactNode;
	if (q.error) content = <ErrorState error={q.error} onRetry={() => q.refetch()} />;
	else if (!s) content = <Loading label={t("trends.picking")} />;
	else if (s.state === "nothing_known")
		content = (
			<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
				<span>{t("trends.nothingKnown")}</span>
				<AskAbout text={t("trends.tellTastePrompt")} label={t("trends.tellTaste")} />
			</div>
		);
	else if (s.state === "no_model") content = <p className="text-sm text-muted-foreground">{t("trends.noModel")}</p>;
	else if (s.state === "failed") content = <p className="text-sm text-muted-foreground">{t("trends.failed", { error: s.error ?? "" })}</p>;
	else if (!s.items.length) content = <p className="text-sm text-muted-foreground">{t("trends.noneFits")}</p>;
	else
		content = (
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
				{s.items.map((it) => (
					<SuggestionCard key={it.id} item={it} onOpen={onOpen} />
				))}
			</div>
		);

	return (
		<section className="mb-8">
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<Sparkles className="h-4 w-4 text-primary" />
				<h2 className="display text-xl">{t("trends.forYou")}</h2>
				{s?.made_at && <span className="text-xs text-muted-foreground">{t("trends.madeAgo", { ago: timeAgo(s.made_at) })}</span>}
				<Button variant="ghost" size="sm" className="ml-auto h-8" onClick={refresh} disabled={working}>
					{working ? <Spinner /> : <RefreshCw />}
					{working ? t("trends.picking") : t("trends.refresh")}
				</Button>
			</div>
			{s?.history && (
				<p className="mb-2 text-xs text-muted-foreground">
					{s.history.error ? t("trends.historyError", { error: s.history.error }) : t("trends.fromHistory", { users: s.history.users.join(", "), count: s.history.titles })}
				</p>
			)}
			{content}
		</section>
	);
}

function SuggestionCard({ item, onOpen }: { item: Suggestion; onOpen: (id: string) => void }) {
	const { t } = useTranslation("media");
	return (
		<div className="surface-card flex gap-3 rounded-xl p-3">
			<button type="button" onClick={() => onOpen(item.id)} className="w-20 shrink-0 focus-visible:outline-none" aria-label={item.name}>
				<Poster path={item.poster_path} alt={item.name} size="w185" />
			</button>
			<div className="flex min-w-0 flex-1 flex-col">
				<button type="button" onClick={() => onOpen(item.id)} className="text-left">
					<p className="line-clamp-2 text-sm font-semibold leading-tight hover:underline">{item.name}</p>
				</button>
				<p className="text-[11px] text-muted-foreground">
					{item.year ?? "?"} · {item.kind === "tv" ? t("trends.show") : t("trends.film")}
				</p>
				<p className="mt-1 line-clamp-4 text-xs leading-snug">{item.reason}</p>
				<AskAbout className="-ml-2 mt-auto h-7 self-start" text={t("trends.askSuggestion", { name: item.name, year: item.year ?? "?", id: item.id, reason: item.reason })} />
			</div>
		</div>
	);
}

function Trending({ onOpen }: { onOpen: (id: string) => void }) {
	const { t } = useTranslation("media");
	const [kind, setKind] = useState<"all" | "movie" | "tv">("all");
	const [span, setSpan] = useState<"day" | "week">("week");
	const q = useQuery({ queryKey: ["trending", kind, span], queryFn: () => endpoints.trending(kind, span), staleTime: 30 * 60_000, retry: false });
	return (
		<section>
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<h2 className="display text-xl">{t("trends.trending")}</h2>
				<Tabs value={kind} onValueChange={(v) => setKind(v as typeof kind)} className="ml-auto">
					<TabsList>
						<TabsTrigger value="all">{t("trends.all")}</TabsTrigger>
						<TabsTrigger value="movie">{t("trends.films")}</TabsTrigger>
						<TabsTrigger value="tv">{t("trends.shows")}</TabsTrigger>
					</TabsList>
				</Tabs>
				<Tabs value={span} onValueChange={(v) => setSpan(v as typeof span)}>
					<TabsList>
						<TabsTrigger value="day">{t("trends.today")}</TabsTrigger>
						<TabsTrigger value="week">{t("trends.thisWeek")}</TabsTrigger>
					</TabsList>
				</Tabs>
			</div>
			{q.isLoading ? (
				<div className={GRID}>
					{Array.from({ length: 12 }).map((_, i) => (
						<div key={i} className="aspect-[2/3] w-full animate-pulse rounded-lg bg-muted" />
					))}
				</div>
			) : q.error ? (
				<ErrorState error={q.error} onRetry={() => q.refetch()} />
			) : !q.data?.items.length ? (
				<Empty icon={<Search />} title={t("trends.nothingTrending")} />
			) : (
				<div className={GRID}>
					{q.data.items.map((it) => (
						<TrendPoster key={it.id} item={it} onOpen={onOpen} />
					))}
				</div>
			)}
		</section>
	);
}

/** Trends (docs/trends.md): what is popular and what suits the owner; search on top, as before. */
export function TrendsScreen() {
	const { t } = useTranslation(["media", "common"]);
	const [params, setParams] = useSearchParams();
	const titleParam = params.get("title");
	const qParam = params.get("q") ?? "";
	const [text, setText] = useState(qParam);
	const [kind, setKind] = useState(params.get("kind") ?? "");
	useEffect(() => setText(qParam), [qParam]);
	const open = (id: string) => {
		setParams(new URLSearchParams({ title: id }));
		window.scrollTo({ top: 0 });
	};

	const find = useQuery({
		queryKey: ["find", titleParam ? { id: titleParam } : { query: qParam, kind }],
		queryFn: () => endpoints.titleFind(titleParam ? { id: titleParam } : { query: qParam, kind: kind || undefined }),
		enabled: !!titleParam || !!qParam,
		staleTime: 5 * 60_000,
		retry: false,
	});
	const resolved = find.data?.resolved;

	return (
		<Screen
			title={t("trends.title")}
			subtitle={t("trends.subtitle")}
			toolbar={
				<form
					className="flex flex-wrap gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (!text.trim()) return;
						const next = new URLSearchParams({ q: text.trim() });
						if (kind) next.set("kind", kind);
						setParams(next);
					}}
				>
					<div className="relative min-w-0 flex-1">
						<Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("search.placeholder")} className="pl-9" />
					</div>
					<select value={kind} onChange={(e) => setKind(e.target.value)} className="h-10 rounded-md border border-input bg-background px-2 text-sm" aria-label={t("search.kind")}>
						<option value="">{t("search.anyKind")}</option>
						<option value="movie">{t("search.film")}</option>
						<option value="tv">{t("search.tvAnime")}</option>
					</select>
					<Button type="submit" disabled={!text.trim()}>
						{t("search.find")}
					</Button>
					{(titleParam || qParam) && (
						<Button type="button" variant="ghost" size="icon" aria-label={t("search.clear")} onClick={() => setParams(new URLSearchParams())}>
							<X />
						</Button>
					)}
				</form>
			}
		>
			{!titleParam && !qParam ? (
				<>
					<ForYou onOpen={open} />
					<Trending onOpen={open} />
				</>
			) : find.isLoading ? (
				<Loading label={t("search.lookingUp")} />
			) : find.error ? (
				<ErrorState error={find.error} onRetry={() => find.refetch()} />
			) : resolved ? (
				<div className="space-y-4">
					<TitleCard title={resolved} />
					{find.data?.how && <p className="text-xs text-muted-foreground">{t("search.matchedBy", { how: find.data.how })}</p>}
					<Releases key={resolved.id} title={resolved} />
				</div>
			) : (
				<div className="space-y-3">
					{find.data?.note && <p className="text-sm text-muted-foreground">{find.data.note}</p>}
					<CandidatesCard
						candidates={find.data?.candidates ?? []}
						onPick={(c) => {
							setParams(new URLSearchParams({ title: c.id }));
						}}
					/>
				</div>
			)}
		</Screen>
	);
}
