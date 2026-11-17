import type { Download } from "../../lib/types";
import { DownloadRow } from "../media/DownloadRow";

export function DownloadsCard({ downloads }: { downloads: Download[] }) {
	if (!downloads?.length) return <p className="text-xs text-muted-foreground">No downloads.</p>;
	return (
		<div className="space-y-2">
			{downloads.map((d) => (
				<DownloadRow key={d.hash} download={d} compact />
			))}
		</div>
	);
}
