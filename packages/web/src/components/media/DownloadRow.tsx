import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Clock, FolderInput, Pause, Play, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { runOp } from "../../lib/api";
import i18n from "../../lib/i18n";
import { useLiveDownload, withLive } from "../../lib/events";
import type { Download } from "../../lib/types";
import { cn, formatBytes, formatEta, formatSpeed, percent, timeAgo } from "../../lib/utils";
import { AskAbout, Why } from "../common/AskAbout";
import { StateBadge } from "../common/Badge";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";

export function downloadDescription(d: Download): string {
	const vars = { hash: d.hash.slice(0, 10), name: d.name, state: d.state, pct: percent(d.live?.progress ?? d.progress) };
	return d.title_name ? i18n.t("media:download.describeFor", { ...vars, title: d.title_name }) : i18n.t("media:download.describe", vars);
}

export function DownloadRow({ download, compact, onChanged }: { download: Download; compact?: boolean; onChanged?: () => void }) {
	const { t } = useTranslation(["media", "common"]);
	const qc = useQueryClient();
	const live = useLiveDownload(download.hash);
	const d = withLive(download, live);
	const [busy, setBusy] = useState<string>();
	const [confirm, setConfirm] = useState(false);
	const [deleteData, setDeleteData] = useState(false);
	const pct = percent(live?.progress ?? d.live?.progress ?? d.progress);
	const paused = d.live?.state === "stopped";
	const active = !["removed", "gone", "filed"].includes(d.state);

	const act = async (name: string, input: object, done: string) => {
		setBusy(name);
		try {
			const r = await runOp(name, input);
			toast({ title: done, description: r.text?.slice(0, 200) });
			qc.invalidateQueries({ queryKey: ["downloads"] });
			qc.invalidateQueries({ queryKey: ["download", d.hash] });
			onChanged?.();
		} catch (e) {
			toast({ title: t("shared.failed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
			throw e;
		} finally {
			setBusy(undefined);
		}
	};

	return (
		<div className={cn("surface-card rounded-xl p-3 md:p-4", compact && "p-3 md:p-3")}>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<p className="break-all text-sm font-medium leading-snug">{d.name}</p>
					<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
						<StateBadge state={paused && d.state === "downloading" ? "paused" : d.state} />
						{d.title_id && (
							<Link to={`/library/${encodeURIComponent(d.title_id)}`} className="text-primary hover:underline">
								{d.title_name ?? d.title_id}
							</Link>
						)}
						<span>{formatBytes(d.size)}</span>
						<span>{t("download.added", { ago: timeAgo(d.added_at) })}</span>
					</div>
				</div>
				<span className="shrink-0 text-sm font-semibold tabular-nums">{pct}%</span>
			</div>
			<Progress value={pct} className="mt-2 h-1.5" />
			{d.live && d.state === "downloading" && (
				<div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
					<span className="inline-flex items-center gap-1">
						<ArrowDown className="h-3 w-3" />
						{formatSpeed(d.live.downSpeed)}
					</span>
					<span className="inline-flex items-center gap-1">
						<ArrowUp className="h-3 w-3" />
						{formatSpeed(d.live.upSpeed)}
					</span>
					<span className="inline-flex items-center gap-1">
						<Users className="h-3 w-3" />
						{d.live.peersSending ?? "?"}
					</span>
					<span className="inline-flex items-center gap-1">
						<Clock className="h-3 w-3" />
						{formatEta(d.live.etaSeconds)}
					</span>
				</div>
			)}
			{d.live?.problem && <p className="mt-1.5 text-xs text-warning">{t(d.live.problem.kind === "tracker" ? "download.trackerProblem" : "download.localProblem", { message: d.live.problem.message })}</p>}
			{d.note && <p className="mt-1.5 text-xs text-warning">{d.note}</p>}
			<div className="mt-1.5">
				<Why reason={d.reason} />
			</div>
			<div className="mt-2 flex flex-wrap items-center gap-1">
				{active && d.state !== "complete" && (
					<Button variant="outline" size="sm" className="h-8" disabled={!!busy} onClick={() => act(paused ? "download.resume" : "download.pause", { hash: d.hash }, paused ? t("download.resumed") : t("download.paused")).catch(() => undefined)}>
						{busy === "download.pause" || busy === "download.resume" ? <Spinner /> : paused ? <Play /> : <Pause />}
						{paused ? t("shared.resume") : t("shared.pause")}
					</Button>
				)}
				{(d.state === "complete" || d.state === "needs_agent") && (
					<Button variant="outline" size="sm" className="h-8" disabled={!!busy} onClick={() => act("download.file", { hash: d.hash }, t("download.filingDone")).catch(() => undefined)}>
						{busy === "download.file" ? <Spinner /> : <FolderInput />}
						{t("download.fileNow")}
					</Button>
				)}
				{d.state !== "removed" && (
					<Button variant="ghost" size="sm" className="h-8 text-destructive-foreground" disabled={!!busy} onClick={() => setConfirm(true)}>
						<Trash2 />
						{t("common:actions.remove")}
					</Button>
				)}
				<AskAbout text={t("download.askAbout", { desc: downloadDescription(d) })} className="ml-auto" />
			</div>
			<ConfirmDialog
				open={confirm}
				onOpenChange={(o) => {
					setConfirm(o);
					if (!o) setDeleteData(false);
				}}
				title={t("download.removeTitle")}
				description={d.name}
				destructive
				confirmLabel={deleteData ? t("download.removeAndDelete") : t("download.removeTorrent")}
				onConfirm={() => act("download.remove", { hash: d.hash, delete_data: deleteData }, t("download.removed"))}
			>
				<label className="flex items-start gap-2 text-sm">
					<input type="checkbox" className="mt-1 accent-[var(--color-primary)]" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
					<span>
						{t("download.alsoDelete")}
						<span className="block text-xs text-muted-foreground">{t("download.alsoDeleteHint")}</span>
					</span>
				</label>
			</ConfirmDialog>
		</div>
	);
}
