import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { endpoints } from "../../lib/api";
import type { Proposal } from "../../lib/types";
import { cn, formatDateTime } from "../../lib/utils";
import { Badge, type Tone } from "../common/Badge";
import { ErrorState, Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";

const RESULT_TONE: Record<string, Tone> = { succeeded: "success", failed: "danger", skipped: "warning", not_approved: "muted", declined: "muted", expired: "muted" };

/**
 * A plugin's proposal (docs/plugins.md §10.3). Reelix wrote every line from the steps' previews; the
 * plugin's title and reason are shown below as a quotation. The owner unticks what they do not want.
 */
export function ProposalCard({ id }: { id: string }) {
	const { t } = useTranslation("activity");
	const qc = useQueryClient();
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["proposal", id], queryFn: () => endpoints.proposal(id) });
	const [unticked, setUnticked] = useState<Set<number>>(new Set());
	const [busy, setBusy] = useState<string>();
	if (isLoading) return <Spinner />;
	if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
	const open = data.status === "open";
	const ticked = data.steps.map((_, i) => i).filter((i) => !unticked.has(i));
	const destructive = ticked.filter((i) => data.steps[i]!.effect === "destructive").length;
	const decide = async (approve: boolean) => {
		setBusy(approve ? "approve" : "decline");
		try {
			const r: Proposal = await endpoints.decideProposal(id, approve, approve ? ticked : undefined);
			qc.setQueryData(["proposal", id], r);
			toast({ title: approve ? t("proposal.approved") : t("proposal.declined") });
			qc.invalidateQueries({ queryKey: ["inbox"] });
			qc.invalidateQueries({ queryKey: ["status"] });
		} catch (e) {
			toast({ title: t("inbox.failed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};
	return (
		<div className="space-y-3" data-testid={`proposal-${id}`}>
			<ul className="space-y-1">
				{data.steps.map((s, i) => (
					<li key={i} className={cn("flex items-start gap-2 rounded-md bg-surface px-2.5 py-1.5 text-sm", open && unticked.has(i) && "opacity-60")}>
						{open && (
							<input
								type="checkbox"
								className="mt-1 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
								aria-label={s.preview.text}
								checked={!unticked.has(i)}
								onChange={(e) => {
									const next = new Set(unticked);
									if (e.target.checked) next.delete(i);
									else next.add(i);
									setUnticked(next);
								}}
							/>
						)}
						<div className="min-w-0 flex-1">
							<p className="break-words">{s.preview.text}</p>
							{s.result && (
								<p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
									<Badge tone={RESULT_TONE[s.result.status] ?? "muted"}>{t(`proposal.result.${s.result.status}`)}</Badge>
									{s.result.text && <span className="break-words text-muted-foreground">{s.result.text}</span>}
								</p>
							)}
						</div>
						{s.effect === "destructive" && <Badge tone="warning">{t("proposal.destructive")}</Badge>}
					</li>
				))}
			</ul>
			<blockquote className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
				<p className="text-xs">{t("proposal.from", { plugin: data.plugin })}</p>
				<p className="font-medium text-foreground">{data.title}</p>
				{data.why && <p className="whitespace-pre-wrap">{data.why}</p>}
			</blockquote>
			{open ? (
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" disabled={!!busy || !ticked.length} onClick={() => decide(true)}>
						{busy === "approve" && <Spinner />}
						{destructive ? t("proposal.approveDestructive", { count: destructive }) : t("proposal.approve")}
					</Button>
					<Button size="sm" variant="outline" disabled={!!busy} onClick={() => decide(false)}>
						{busy === "decline" && <Spinner />}
						{t("proposal.decline")}
					</Button>
					<span className="text-xs text-muted-foreground">{t("proposal.expires", { when: formatDateTime(data.expires_at) })}</span>
				</div>
			) : (
				<p className="text-xs text-muted-foreground">{t(`proposal.status.${data.status as Exclude<Proposal["status"], "open">}`)}</p>
			)}
		</div>
	);
}
