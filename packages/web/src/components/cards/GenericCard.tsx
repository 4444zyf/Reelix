import { Captions, Info } from "lucide-react";
import { CardShell } from "./CardShell";

function rowsOf(card: Record<string, unknown>): Record<string, unknown>[] | undefined {
	for (const v of Object.values(card)) if (Array.isArray(v) && v.length && typeof v[0] === "object") return v as Record<string, unknown>[];
	return undefined;
}

const LABEL_KEYS = ["name", "title", "file", "path", "lang", "language", "format", "source", "release"];

/** Cards this version has no special view for (subtitles, future kinds): a readable list. */
export function GenericCard({ card }: { card: { kind: string; [k: string]: unknown } }) {
	const rows = rowsOf(card);
	return (
		<CardShell icon={card.kind === "subtitles" ? <Captions /> : <Info />} title={card.kind}>
			{rows ? (
				<div className="space-y-1">
					{rows.slice(0, 30).map((r, i) => (
						<div key={i} className="rounded-md bg-white/[0.03] px-2.5 py-1.5 text-xs">
							{LABEL_KEYS.filter((k) => r[k] != null && typeof r[k] !== "object").map((k) => (
								<span key={k} className="mr-3">
									<span className="text-muted-foreground">{k}: </span>
									{String(r[k])}
								</span>
							))}
							{!LABEL_KEYS.some((k) => r[k] != null) && <span className="break-all">{JSON.stringify(r).slice(0, 300)}</span>}
						</div>
					))}
				</div>
			) : (
				<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">{JSON.stringify(card, null, 2).slice(0, 4000)}</pre>
			)}
		</CardShell>
	);
}
