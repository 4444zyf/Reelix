import { useQuery } from "@tanstack/react-query";
import { endpoints } from "../../lib/api";
import { Spinner } from "../common/States";
import { DownloadRow } from "../media/DownloadRow";
import { CardShell } from "./CardShell";

/** A live download: fetched once, then kept current by the app event stream. */
export function ProgressCard({ hash, name }: { hash: string; name?: string }) {
	const { data, isLoading, error } = useQuery({ queryKey: ["download", hash], queryFn: () => endpoints.download(hash), enabled: !!hash, refetchInterval: 15_000 });
	const d = data?.[0];
	if (d) return <DownloadRow download={d} compact />;
	return (
		<CardShell title={name ?? hash}>
			<p className="flex items-center gap-2 text-xs text-muted-foreground">
				{isLoading ? (
					<>
						<Spinner /> Checking the download…
					</>
				) : error ? (
					String((error as Error).message)
				) : (
					"This download is not known (it may have been removed)."
				)}
			</p>
		</CardShell>
	);
}
