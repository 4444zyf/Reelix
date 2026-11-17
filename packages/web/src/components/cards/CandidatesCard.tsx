import { Check, ListChecks } from "lucide-react";
import { useState } from "react";
import type { Candidate } from "../../lib/types";
import { Poster } from "../common/Poster";
import { Button } from "../ui/button";
import { CardShell } from "./CardShell";

/** Possible matches for a title; picking one tells the agent which. */
export function CandidatesCard({ candidates, onPick }: { candidates: Candidate[]; onPick?: (c: Candidate) => void }) {
	const [picked, setPicked] = useState<string>();
	if (!candidates?.length) return <CardShell icon={<ListChecks />} title="No matches found">{null}</CardShell>;
	return (
		<CardShell icon={<ListChecks />} title={`${candidates.length} possible matches`}>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
				{candidates.slice(0, 12).map((c) => (
					<div key={c.id} className="flex flex-col gap-1.5">
						<Poster path={c.poster_path} alt={c.name} size="w185" />
						<div className="min-w-0">
							<p className="line-clamp-2 text-xs font-medium leading-tight">{c.name}</p>
							<p className="text-[11px] text-muted-foreground">
								{c.year ?? "?"} · {c.kind === "tv" ? "TV" : c.kind === "movie" ? "Film" : c.kind}
								{c.original_name && c.original_name !== c.name ? ` · ${c.original_name}` : ""}
							</p>
						</div>
						{onPick && (
							<Button
								size="sm"
								variant={picked === c.id ? "default" : "outline"}
								className="h-7 text-xs"
								disabled={!!picked}
								onClick={() => {
									setPicked(c.id);
									onPick(c);
								}}
							>
								{picked === c.id && <Check />}
								{picked === c.id ? "Chosen" : "This one"}
							</Button>
						)}
					</div>
				))}
			</div>
		</CardShell>
	);
}
