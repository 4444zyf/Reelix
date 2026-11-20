import { useQuery } from "@tanstack/react-query";
import { formatNumber } from "../../lib/utils";
import { Library, Search, Star } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { endpoints } from "../../lib/api";
import type { Title } from "../../lib/types";
import { Badge } from "../common/Badge";
import { Poster } from "../common/Poster";
import { Button } from "../ui/button";

/** Poster, names, year, rating, and where the title stands (in library, downloading, followed). */
export function TitleCard({ title }: { title: Title }) {
	const { t } = useTranslation(["chat", "common"]);
	const { data } = useQuery({ queryKey: ["title", title.id], queryFn: () => endpoints.titleShow(title.id), retry: false, staleTime: 30_000 });
	const inLibrary = (data?.have.files.length ?? 0) > 0;
	const downloading = data?.downloads.filter((d) => d.state === "downloading" || d.state === "added").length ?? 0;
	const followed = (data?.follows.length ?? 0) > 0;
	return (
		<div className="feature flex gap-4 p-3 md:gap-6 md:p-5">
			<Poster path={title.poster_path} alt={title.name} className="w-24 shrink-0 shadow-[0_16px_40px_rgb(0_0_0/0.35)] md:w-32" />
			<div className="min-w-0 flex-1 space-y-2">
				<div>
					<p className="display text-2xl leading-tight md:text-4xl">{title.name}</p>
					<p className="mt-1 text-sm text-muted-foreground">
						{[title.original_name && title.original_name !== title.name ? title.original_name : null, title.year].filter(Boolean).join(" · ")}
					</p>
				</div>
				<div className="flex flex-wrap gap-1">
					{title.media_class && <Badge tone="muted">{title.media_class}</Badge>}
					{title.rating ? (
						<Badge tone="warning">
							<Star className="h-3 w-3" /> {formatNumber(Number(title.rating), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
						</Badge>
					) : null}
					{Object.entries(title.ratings ?? {}).map(([id, r]) => (
						<Badge key={id} tone="success">
							{r.label} {r.value}
						</Badge>
					))}
					{inLibrary && <Badge tone="success">{t("cards.title.inLibrary", { count: data!.have.files.length })}</Badge>}
					{downloading > 0 && <Badge tone="primary">{t("common:state.downloading")}</Badge>}
					{followed && <Badge tone="info">{t("cards.title.followed")}</Badge>}
				</div>
				{title.overview && <p className="line-clamp-3 text-xs text-muted-foreground">{title.overview}</p>}
				<div className="flex flex-wrap gap-1 pt-1">
					<Button asChild variant="outline" size="sm" className="h-8">
						<Link to={`/library/${encodeURIComponent(title.id)}`}>
							<Library /> {t("common:actions.open")}
						</Link>
					</Button>
					<Button asChild variant="ghost" size="sm" className="h-8">
						<Link to={`/trends?title=${encodeURIComponent(title.id)}`}>
							<Search /> {t("cards.title.releases")}
						</Link>
					</Button>
				</div>
			</div>
		</div>
	);
}
