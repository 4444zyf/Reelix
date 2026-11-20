import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Screen } from "../components/common/Screen";
import { Empty, ErrorState, Loading, Spinner } from "../components/common/States";
import { DownloadRow } from "../components/media/DownloadRow";
import { Button } from "../components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { endpoints } from "../lib/api";

const ACTIVE = new Set(["added", "downloading", "stalled", "needs_agent", "complete"]);

/** Live progress (download.status + the app event stream), pause, resume, remove. */
export function DownloadsScreen() {
	const { t } = useTranslation(["media", "common"]);
	const [filter, setFilter] = useState("active");
	const all = filter === "history";
	const { data, isLoading, error, refetch, isFetching } = useQuery({
		queryKey: ["downloads", { all }],
		queryFn: () => endpoints.downloads(all),
		// Speeds and ETAs come only from the downloader: poll while something is moving.
		refetchInterval: (q) => (q.state.data?.some((d) => d.state === "downloading") ? 5000 : 30_000),
	});
	const list = (data ?? []).filter((d) => (filter === "active" ? ACTIVE.has(d.state) : true));
	return (
		<Screen
			title={t("downloads.title")}
			subtitle={t("downloads.subtitle")}
			actions={(scrolled) => (
				<Button variant="outline" size={scrolled ? "sm" : "default"} onClick={() => refetch()} disabled={isFetching}>
					{isFetching ? <Spinner /> : <RefreshCw />}
					<span className="hidden sm:inline">{t("common:actions.refresh")}</span>
				</Button>
			)}
			toolbar={
				<Tabs value={filter} onValueChange={setFilter}>
					<TabsList>
						<TabsTrigger value="active">{t("downloads.tabActive")}</TabsTrigger>
						<TabsTrigger value="recent">{t("downloads.tabRecent")}</TabsTrigger>
						<TabsTrigger value="history">{t("downloads.tabHistory")}</TabsTrigger>
					</TabsList>
				</Tabs>
			}
		>
			{isLoading ? (
				<Loading />
			) : error ? (
				<ErrorState error={error} onRetry={() => refetch()} />
			) : list.length === 0 ? (
				<Empty icon={<Download />} title={filter === "active" ? t("downloads.nothingDownloading") : t("downloads.noDownloads")}>
					{t("downloads.emptyHint")}
				</Empty>
			) : (
				<div className="mx-auto grid max-w-5xl gap-3 xl:grid-cols-2">
					{list.map((d) => (
						<DownloadRow key={d.hash} download={d} />
					))}
				</div>
			)}
		</Screen>
	);
}
