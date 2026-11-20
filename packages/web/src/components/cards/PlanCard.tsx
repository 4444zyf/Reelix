import { ArrowRight, Check, ClipboardList, Pencil } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { runOp } from "../../lib/api";
import type { PlanItem } from "../../lib/types";
import { episodeLabel } from "../../lib/utils";
import { Badge } from "../common/Badge";
import { Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import { CardShell } from "./CardShell";

type ApplyOutput = { plan?: { items: PlanItem[] }; problems?: string[]; results?: { ok?: boolean; dest?: string; error?: string }[] | unknown };

/** `source → destination` list with Approve (organise apply) and Edit. */
export function PlanCard({
	items,
	problems,
	results,
	mode,
	reason,
	onApplied,
	onEdit,
}: {
	items: PlanItem[];
	problems?: string[];
	results?: unknown;
	mode?: string;
	reason?: string;
	onApplied?: (out: ApplyOutput, text: string) => void;
	onEdit?: () => void;
}) {
	const { t } = useTranslation(["chat", "common"]);
	const [busy, setBusy] = useState(false);
	const [applied, setApplied] = useState<{ out: ApplyOutput; text: string }>();
	const alreadyApplied = mode === "apply" || !!results;
	const approve = async () => {
		setBusy(true);
		try {
			const r = await runOp<ApplyOutput>("organise", { mode: "apply", items });
			setApplied({ out: r.output, text: r.text });
			toast({ title: t("cards.plan.applied"), description: r.text.slice(0, 200) });
			onApplied?.(r.output, r.text);
		} catch (e) {
			toast({ title: t("cards.plan.notApplied"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	const allProblems = [...(problems ?? []), ...(applied?.out.problems ?? [])];
	return (
		<CardShell icon={<ClipboardList />} title={t(alreadyApplied ? "cards.plan.titleApplied" : "cards.plan.title", { count: items?.length ?? 0 })}>
			{reason && <p className="mb-2 text-xs text-muted-foreground">{reason}</p>}
			<div className="space-y-1.5">
				{(items ?? []).map((it, i) => (
					<div key={i} className="rounded-md bg-surface px-2.5 py-2 text-xs">
						<div className="flex flex-wrap items-center gap-1">
							{it.kind && <Badge tone="muted">{it.kind}</Badge>}
							{it.episodes?.length ? <Badge tone="info">{episodeLabel(it.episodes)}</Badge> : null}
						</div>
						<p className="mt-1 break-all text-muted-foreground">{it.source}</p>
						<p className="flex items-start gap-1 break-all">
							<ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
							{it.dest}
						</p>
						{it.reason && <p className="mt-0.5 text-muted-foreground/80">{it.reason}</p>}
					</div>
				))}
			</div>
			{allProblems.length > 0 && (
				<ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-warning">
					{allProblems.map((p, i) => (
						<li key={i}>{p}</li>
					))}
				</ul>
			)}
			{applied && <p className="mt-2 whitespace-pre-wrap text-xs text-success">{applied.text}</p>}
			{!alreadyApplied && !applied && (
				<div className="mt-3 flex flex-wrap gap-2">
					<Button size="sm" disabled={busy || !items?.length} onClick={approve}>
						{busy ? <Spinner /> : <Check />}
						{t("cards.plan.approve")}
					</Button>
					{onEdit && (
						<Button size="sm" variant="outline" disabled={busy} onClick={onEdit}>
							<Pencil />
							{t("common:actions.edit")}
						</Button>
					)}
				</div>
			)}
		</CardShell>
	);
}
