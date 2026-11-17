import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { CandidatesCard } from "../components/cards/CandidatesCard";
import { TitleCard } from "../components/cards/TitleCard";
import { AskAbout } from "../components/common/AskAbout";
import { Screen } from "../components/common/Screen";
import { Empty, ErrorState, Loading, Spinner } from "../components/common/States";
import { IndexerLine, ReleaseList } from "../components/media/ReleaseList";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { endpoints } from "../lib/api";
import type { Title } from "../lib/types";
import { titleLabel } from "../lib/utils";

const SORTS = [
	{ value: "", label: "Best match" },
	{ value: "seeders", label: "Most seeders" },
	{ value: "size", label: "Largest" },
	{ value: "date", label: "Newest" },
];

function Releases({ title }: { title: Title }) {
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
							Season
							<Input value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, ""))} placeholder="any" inputMode="numeric" className="mt-1 h-9 w-20" />
						</label>
						<label className="text-xs text-muted-foreground">
							Episode
							<Input value={episode} onChange={(e) => setEpisode(e.target.value.replace(/\D/g, ""))} placeholder="any" inputMode="numeric" className="mt-1 h-9 w-20" disabled={!season} />
						</label>
					</>
				)}
				<label className="text-xs text-muted-foreground">
					Sort
					<select value={sort} onChange={(e) => setSort(e.target.value)} className="mt-1 block h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground">
						{SORTS.map((s) => (
							<option key={s.value} value={s.value}>
								{s.label}
							</option>
						))}
					</select>
				</label>
				<Button type="submit" size="sm" className="h-9" disabled={q.isFetching}>
					{q.isFetching ? <Spinner /> : <RefreshCw />}
					Search releases
				</Button>
				<AskAbout className="ml-auto" text={`Find the best release of ${titleLabel(title)} [${title.id}] for me: `} label="Let the agent choose" />
			</form>
			{q.isLoading ? (
				<Loading label="Asking the indexers…" />
			) : q.error ? (
				<ErrorState error={q.error} onRetry={() => q.refetch()} />
			) : q.data ? (
				<>
					<IndexerLine indexers={q.data.indexers} total={q.data.total} />
					{q.data.queries?.length ? <p className="text-xs text-muted-foreground">Searched for: {q.data.queries.join(" · ")}</p> : null}
					{releases.length === 0 ? <Empty icon={<Search />} title="No releases found" /> : <ReleaseList releases={releases} titleId={title.id} />}
				</>
			) : null}
		</div>
	);
}

/** Find a title, see its releases, download one by hand. */
export function SearchScreen() {
	const [params, setParams] = useSearchParams();
	const titleParam = params.get("title");
	const qParam = params.get("q") ?? "";
	const [text, setText] = useState(qParam);
	const [kind, setKind] = useState(params.get("kind") ?? "");
	useEffect(() => setText(qParam), [qParam]);

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
			title="Search"
			subtitle="Find a title, compare releases, download one by hand"
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
						<Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Title, original name, IMDb or TMDB id" className="pl-9" />
					</div>
					<select value={kind} onChange={(e) => setKind(e.target.value)} className="h-10 rounded-md border border-input bg-background px-2 text-sm" aria-label="Kind">
						<option value="">Any kind</option>
						<option value="movie">Film</option>
						<option value="tv">TV / anime</option>
					</select>
					<Button type="submit" disabled={!text.trim()}>
						Find
					</Button>
					{(titleParam || qParam) && (
						<Button type="button" variant="ghost" size="icon" aria-label="Clear" onClick={() => setParams(new URLSearchParams())}>
							<X />
						</Button>
					)}
				</form>
			}
		>
			{!titleParam && !qParam ? (
				<Empty icon={<Search />} title="Search for a film or a show">
					Or just tell the agent in Chat what you want; it does the same steps and picks a release for you.
				</Empty>
			) : find.isLoading ? (
				<Loading label="Looking it up…" />
			) : find.error ? (
				<ErrorState error={find.error} onRetry={() => find.refetch()} />
			) : resolved ? (
				<div className="space-y-4">
					<TitleCard title={resolved} />
					{find.data?.how && <p className="text-xs text-muted-foreground">Matched by {find.data.how}.</p>}
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
