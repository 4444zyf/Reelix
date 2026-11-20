import { ListVideo } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { IndexerOutcome, Release } from "../../lib/types";
import { Button } from "../ui/button";
import { IndexerLine, ReleaseList, type AddResult } from "../media/ReleaseList";
import { CardShell } from "./CardShell";

const FIRST = 8;

export function ReleasesCard({
	releases,
	pick,
	reason,
	total,
	indexers,
	onDownloaded,
}: {
	releases: Release[];
	pick?: string;
	reason?: string;
	total?: number;
	indexers?: IndexerOutcome[];
	onDownloaded?: (r: Release, out: AddResult) => void;
}) {
	const { t } = useTranslation("chat");
	const [all, setAll] = useState(false);
	const list = releases ?? [];
	// The recommended release first.
	const open = list.filter((r) => !r.hidden?.length);
	const hidden = list.filter((r) => r.hidden?.length);
	const sorted = pick ? [...open.filter((r) => r.handle === pick), ...open.filter((r) => r.handle !== pick)] : open;
	const shown = [...(all ? sorted : sorted.slice(0, FIRST)), ...hidden];
	return (
		<CardShell icon={<ListVideo />} title={total && total > open.length ? t("cards.releases.countOf", { count: open.length, total }) : t("cards.releases.count", { count: open.length })}>
			{reason && (
				<p className="mb-2 rounded-md bg-primary/10 px-3 py-2 text-xs text-foreground/90">
					<span className="font-semibold text-primary">{pick ? t("cards.releases.pickHandle", { handle: pick }) : t("cards.releases.pick")} </span>
					{reason}
				</p>
			)}
			<IndexerLine indexers={indexers} />
			<div className="mt-2">
				<ReleaseList releases={shown} pick={pick} onDownloaded={onDownloaded} />
			</div>
			{sorted.length > FIRST && (
				<Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setAll((a) => !a)}>
					{all ? t("cards.releases.showFewer") : t("cards.releases.showAll", { n: sorted.length })}
				</Button>
			)}
		</CardShell>
	);
}
