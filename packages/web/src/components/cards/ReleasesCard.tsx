import { ListVideo } from "lucide-react";
import { useState } from "react";
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
	const [all, setAll] = useState(false);
	const list = releases ?? [];
	// The recommended release first.
	const sorted = pick ? [...list.filter((r) => r.handle === pick), ...list.filter((r) => r.handle !== pick)] : list;
	const shown = all ? sorted : sorted.slice(0, FIRST);
	return (
		<CardShell icon={<ListVideo />} title={`${list.length} release${list.length === 1 ? "" : "s"}${total && total > list.length ? ` of ${total}` : ""}`}>
			{reason && (
				<p className="mb-2 rounded-md bg-primary/10 px-3 py-2 text-xs text-foreground/90">
					<span className="font-semibold text-primary">Pick{pick ? ` ${pick}` : ""}: </span>
					{reason}
				</p>
			)}
			<IndexerLine indexers={indexers} />
			<div className="mt-2">
				<ReleaseList releases={shown} pick={pick} onDownloaded={onDownloaded} />
			</div>
			{sorted.length > FIRST && (
				<Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setAll((a) => !a)}>
					{all ? "Show fewer" : `Show all ${sorted.length}`}
				</Button>
			)}
		</CardShell>
	);
}
