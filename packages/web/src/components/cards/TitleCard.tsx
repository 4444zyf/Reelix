import { useQuery } from "@tanstack/react-query";
import { Library, Search, Star } from "lucide-react";
import { Link } from "react-router";
import { endpoints } from "../../lib/api";
import type { Title } from "../../lib/types";
import { Badge } from "../common/Badge";
import { Poster } from "../common/Poster";
import { Button } from "../ui/button";

/** Poster, names, year, rating, and where the title stands (in library, downloading, followed). */
export function TitleCard({ title }: { title: Title }) {
	const { data } = useQuery({ queryKey: ["title", title.id], queryFn: () => endpoints.titleShow(title.id), retry: false, staleTime: 30_000 });
	const inLibrary = (data?.have.files.length ?? 0) > 0;
	const downloading = data?.downloads.filter((d) => d.state === "downloading" || d.state === "added").length ?? 0;
	const followed = (data?.follows.length ?? 0) > 0;
	return (
		<div className="glass-card flex gap-3 rounded-xl p-3 md:gap-4 md:p-4">
			<Poster path={title.poster_path} alt={title.name} className="w-20 shrink-0 md:w-24" />
			<div className="min-w-0 flex-1 space-y-1.5">
				<div>
					<p className="font-semibold leading-tight">
						{title.name}
						{title.year ? <span className="font-normal text-muted-foreground"> ({title.year})</span> : null}
					</p>
					{title.original_name && title.original_name !== title.name && <p className="text-xs text-muted-foreground">{title.original_name}</p>}
				</div>
				<div className="flex flex-wrap gap-1">
					{title.media_class && <Badge tone="muted">{title.media_class}</Badge>}
					{title.rating ? (
						<Badge tone="warning">
							<Star className="h-3 w-3" /> {Number(title.rating).toFixed(1)}
						</Badge>
					) : null}
					{title.douban_rating ? <Badge tone="success">豆瓣 {title.douban_rating}</Badge> : null}
					{inLibrary && <Badge tone="success">in library · {data!.have.files.length} files</Badge>}
					{downloading > 0 && <Badge tone="primary">downloading</Badge>}
					{followed && <Badge tone="info">followed</Badge>}
				</div>
				{title.overview && <p className="line-clamp-3 text-xs text-muted-foreground">{title.overview}</p>}
				<div className="flex flex-wrap gap-1 pt-1">
					<Button asChild variant="outline" size="sm" className="h-8">
						<Link to={`/library/${encodeURIComponent(title.id)}`}>
							<Library /> Open
						</Link>
					</Button>
					<Button asChild variant="ghost" size="sm" className="h-8">
						<Link to={`/search?title=${encodeURIComponent(title.id)}`}>
							<Search /> Releases
						</Link>
					</Button>
				</div>
			</div>
		</div>
	);
}
