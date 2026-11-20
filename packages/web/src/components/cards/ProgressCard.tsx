import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { endpoints } from "../../lib/api";
import { Spinner } from "../common/States";
import { DownloadRow } from "../media/DownloadRow";
import { CardShell } from "./CardShell";

/** A live download: fetched once, then kept current by the app event stream. */
export function ProgressCard({ hash, name }: { hash: string; name?: string }) {
	const { t } = useTranslation("chat");
	const { data, isLoading, error } = useQuery({ queryKey: ["download", hash], queryFn: () => endpoints.download(hash), enabled: !!hash, refetchInterval: 15_000 });
	const d = data?.[0];
	if (d) return <DownloadRow download={d} compact />;
	return (
		<CardShell title={name ?? hash}>
			<p className="flex items-center gap-2 text-xs text-muted-foreground">
				{isLoading ? (
					<>
						<Spinner /> {t("cards.progress.checking")}
					</>
				) : error ? (
					String((error as Error).message)
				) : (
					t("cards.progress.unknown")
				)}
			</p>
		</CardShell>
	);
}
