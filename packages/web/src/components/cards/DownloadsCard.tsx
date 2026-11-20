import { useTranslation } from "react-i18next";
import type { Download } from "../../lib/types";
import { DownloadRow } from "../media/DownloadRow";

export function DownloadsCard({ downloads }: { downloads: Download[] }) {
	const { t } = useTranslation("chat");
	if (!downloads?.length) return <p className="text-xs text-muted-foreground">{t("cards.downloads.none")}</p>;
	return (
		<div className="space-y-2">
			{downloads.map((d) => (
				<DownloadRow key={d.hash} download={d} compact />
			))}
		</div>
	);
}
