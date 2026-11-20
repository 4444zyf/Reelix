import { Check, Download, EyeOff, FileStack, HelpCircle, Magnet, Sparkles, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { runOp } from "../../lib/api";
import i18n from "../../lib/i18n";
import type { IndexerOutcome, Release, ReleaseWhy, ReleaseWhyRow } from "../../lib/types";
import { cn, formatBytes, formatDateTime, newRequestId, timeAgo, formatNumber } from "../../lib/utils";
import { AskAbout } from "../common/AskAbout";
import { Badge } from "../common/Badge";
import { Spinner } from "../common/States";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { toast } from "../hooks/use-toast";

export type AddResult = { hash: string; name: string; adopted: boolean; started: boolean; files: number; size?: number; warnings?: string[] };

export function releaseDescription(r: Release): string {
	return i18n.t("media:releases.describe", { handle: r.handle, title: r.title, size: formatBytes(r.size), seeders: r.seeders ?? "?", indexer: r.indexer ?? i18n.t("media:releases.unknownIndexer") });
}

export function ReleaseBadges({ r }: { r: Release }) {
	const { t } = useTranslation(["media", "common"]);
	const p = r.parsed ?? {};
	const eps = p.episodes?.length ? `E${p.episodes[0]}${p.episodes.length > 1 ? `–${p.episodes[p.episodes.length - 1]}` : ""}` : "";
	return (
		<div className="flex flex-wrap gap-1">
			{p.resolution && <Badge tone="primary">{p.resolution}</Badge>}
			{p.source && <Badge>{p.source}</Badge>}
			{p.codec && <Badge>{p.codec}</Badge>}
			{p.hdr?.map((h) => (
				<Badge key={h} tone="warning">
					{h}
				</Badge>
			))}
			{p.chineseSubs && <Badge tone="success">{t("releases.chineseSubs", { value: p.chineseSubs })}</Badge>}
			{(p.season != null || eps) && (
				<Badge tone="info">
					{p.season != null ? `S${String(p.season).padStart(2, "0")}` : ""}
					{eps}
				</Badge>
			)}
			{p.seasons && p.seasons.length > 1 && <Badge tone="info">S{p.seasons.join(",")}</Badge>}
			{p.complete && <Badge tone="info">{t("releases.complete")}</Badge>}
			{p.group && <Badge tone="muted">{p.group}</Badge>}
			{r.freeleech && <Badge tone="success">{t("releases.free")}</Badge>}
			{r.hasMagnet && !r.size && (
				<Badge tone="muted">
					<Magnet className="h-3 w-3" /> {t("releases.magnet")}
				</Badge>
			)}
		</div>
	);
}

export function IndexerLine({ indexers, total }: { indexers?: IndexerOutcome[]; total?: number }) {
	const { t } = useTranslation(["media", "common"]);
	if (!indexers?.length) return null;
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
			{total != null && <span>{t("releases.results", { count: total })}</span>}
			{indexers.map((i) => (
				<span key={i.indexer} title={i.error} className={cn("inline-flex items-center gap-1", !i.ok && "text-destructive-foreground")}>
					<span className={cn("h-1.5 w-1.5 rounded-full", i.ok ? "bg-success" : "bg-destructive-foreground")} />
					{i.name || i.indexer}: {i.ok ? t("releases.indexerOk", { count: i.count, seconds: formatNumber(i.ms / 1000, { maximumFractionDigits: 1 }) }) : (i.error ?? t("common:state.failed"))}
				</span>
			))}
		</div>
	);
}

function FilesDialog({ handle, open, onOpenChange }: { handle: string; open: boolean; onOpenChange: (o: boolean) => void }) {
	const { t } = useTranslation(["media", "common"]);
	const [data, setData] = useState<{ name: string; files?: { path: string; size: number }[]; magnetOnly?: boolean } | { error: string }>();
	// The row opens this dialog, so it is the open state that starts the fetch.
	useEffect(() => {
		if (!open || data) return;
		runOp<{ name: string; files?: { path: string; size: number }[]; magnetOnly?: boolean }>("release.files", { handle })
			.then((r) => setData(r.output))
			.catch((e) => setData({ error: e instanceof Error ? e.message : String(e) }));
	}, [open, data, handle]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="surface-card max-w-2xl rounded-xl">
				<DialogHeader>
					<DialogTitle>{t("releases.filesIn", { handle })}</DialogTitle>
				</DialogHeader>
				{!data ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Spinner /> {t("releases.fetchingTorrent")}
					</div>
				) : "error" in data ? (
					<p className="text-sm text-destructive-foreground">{data.error}</p>
				) : data.magnetOnly || !data.files ? (
					<p className="text-sm text-muted-foreground">{t("releases.magnetOnly")}</p>
				) : (
					<div className="max-h-[60vh] overflow-y-auto text-xs">
						<p className="mb-2 font-medium">{data.name}</p>
						{data.files.map((f) => (
							<div key={f.path} className="flex justify-between gap-3 border-b border-line py-1">
								<span className="break-all">{f.path}</span>
								<span className="shrink-0 text-muted-foreground">{formatBytes(f.size)}</span>
							</div>
						))}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function whyLine(t: (key: string, vars?: Record<string, unknown>) => string, row: ReleaseWhyRow): string {
	if (row.kind === "provider") return row.reason;
	return t(`releases.why.${row.kind}`, { plugin: row.plugin, reason: row.reason, from: row.detail.from, to: row.detail.to });
}

/** "Why this release?": the same record the agent reads (docs/plugins.md §10.1). */
function WhyDialog({ r, open, onOpenChange, showAsk }: { r: Release; open: boolean; onOpenChange: (o: boolean) => void; showAsk?: boolean }) {
	const { t } = useTranslation(["media", "common"]);
	const [data, setData] = useState<ReleaseWhy | { error: string }>();
	useEffect(() => {
		if (!open) return;
		runOp<ReleaseWhy>("release.why", { handle: r.handle })
			.then((res) => setData(res.output))
			.catch((e) => setData({ error: e instanceof Error ? e.message : String(e) }));
	}, [open, r.handle]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="surface-card max-w-2xl rounded-xl">
				<DialogHeader>
					<DialogTitle>{t("releases.whyThisOne")}</DialogTitle>
				</DialogHeader>
				<p className="break-all text-xs text-muted-foreground">{r.title}</p>
				{!data ? (
					<Spinner />
				) : "error" in data ? (
					<p className="text-sm text-destructive-foreground">{data.error}</p>
				) : (
					<div className="space-y-3 text-sm">
						<ul className="space-y-1">
							{data.reasons.length ? data.reasons.map((row, i) => <li key={i}>{whyLine(t as never, row)}</li>) : <li className="text-muted-foreground">{t("releases.why.none")}</li>}
						</ul>
						{data.providers.length > 0 && (
							<div>
								<p className="mb-1 text-xs font-medium text-muted-foreground">{t("releases.why.search")}</p>
								<ul className="space-y-0.5 text-xs text-muted-foreground">
									{data.providers.map((row, i) => (
										<li key={i}>{whyLine(t as never, row)}</li>
									))}
								</ul>
							</div>
						)}
					</div>
				)}
				{showAsk && <AskAbout text={t("releases.askWhy", { desc: releaseDescription(r) })} label={t("releases.askAgent")} className="self-start" />}
			</DialogContent>
		</Dialog>
	);
}

function ReleaseRow({ r, titleId, picked, onDownloaded, showAsk }: { r: Release; titleId?: string; picked?: boolean; onDownloaded?: (r: Release, out: AddResult) => void; showAsk?: boolean }) {
	const { t } = useTranslation(["media", "common"]);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<AddResult>();
	const [files, setFiles] = useState(false);
	const [why, setWhy] = useState(false);
	const hidden = !!r.hidden?.length;
	const download = async () => {
		setBusy(true);
		try {
			const res = await runOp<AddResult>("download.add", { handle: r.handle, title_id: titleId ?? r.titleId, reason: t("releases.pickedByOwner"), ...(hidden && { allow_hidden: true }) }, newRequestId());
			setDone(res.output);
			toast({ title: res.output.adopted ? t("releases.alreadyDownloading") : t("releases.downloadAdded"), description: res.output.name });
			for (const w of res.output.warnings ?? []) toast({ title: t("releases.note"), description: w });
			onDownloaded?.(r, res.output);
		} catch (e) {
			toast({ title: t("releases.downloadFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className={cn("rounded-lg border border-line bg-surface p-3", picked && "border-primary/50 bg-primary/5", hidden && "border-dashed opacity-80")}>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 flex-1 space-y-1.5">
					<div className="flex items-start gap-2">
						{picked && <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-label={t("releases.recommended")} />}
						<p className="break-all text-sm font-medium leading-snug">{r.title}</p>
					</div>
					<ReleaseBadges r={r} />
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						<span className="font-mono text-[11px] text-foreground/70">{r.handle}</span>
						<span>{formatBytes(r.size)}</span>
						<span className="inline-flex items-center gap-1">
							<Users className="h-3 w-3" />
							{r.seeders ?? "?"}
							{r.peers != null && <span className="opacity-60">/ {r.peers}</span>}
						</span>
						{r.indexer && <span>{r.indexer}</span>}
						{r.publishDate && <span title={formatDateTime(r.publishDate)}>{timeAgo(r.publishDate)}</span>}
					</div>
					{r.hidden?.map((h) => (
						<p key={h.plugin} className="flex items-start gap-1 text-xs text-warning">
							<EyeOff className="mt-0.5 h-3 w-3 shrink-0" />
							{t("releases.hiddenBy", { plugin: h.plugin, reason: h.reason })}
						</p>
					))}
					{r.notes?.map((n) => (
						<p key={n.plugin} className="text-xs text-muted-foreground">
							{t("releases.noteFrom", { plugin: n.plugin, note: n.note })}
						</p>
					))}
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-1 sm:justify-end">
					<Button variant="ghost" size="sm" className="h-8 px-2 text-muted-foreground" onClick={() => setFiles(true)} title={t("releases.filesTitle")}>
						<FileStack />
						<span className="sm:hidden lg:inline">{t("releases.files")}</span>
					</Button>
					<Button variant="ghost" size="sm" className="h-8 px-2 text-muted-foreground" onClick={() => setWhy(true)} title={t("releases.whyThisOne")}>
						<HelpCircle />
						<span className="sr-only">{t("releases.whyThisOne")}</span>
					</Button>
					<Button size="sm" variant={hidden ? "outline" : "default"} className="h-8" disabled={busy || !!done} onClick={download}>
						{busy ? <Spinner /> : done ? <Check /> : <Download />}
						{done ? (done.adopted ? t("releases.adopted") : t("releases.added")) : hidden ? t("releases.downloadAnyway") : t("releases.download")}
					</Button>
				</div>
			</div>
			<FilesDialog handle={r.handle} open={files} onOpenChange={setFiles} />
			<WhyDialog r={r} open={why} onOpenChange={setWhy} showAsk={showAsk} />
		</div>
	);
}

export function ReleaseList({
	releases,
	titleId,
	pick,
	onDownloaded,
	showAsk = true,
}: {
	releases: Release[];
	titleId?: string;
	pick?: string;
	onDownloaded?: (r: Release, out: AddResult) => void;
	showAsk?: boolean;
}) {
	const { t } = useTranslation("media");
	const [showHidden, setShowHidden] = useState(false);
	const hidden = releases.filter((r) => r.hidden?.length);
	const row = (r: Release) => <ReleaseRow key={r.handle} r={r} titleId={titleId} picked={pick === r.handle} onDownloaded={onDownloaded} showAsk={showAsk} />;
	return (
		<div className="space-y-2">
			{releases.filter((r) => !r.hidden?.length).map(row)}
			{hidden.length > 0 && (
				<Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => setShowHidden((s) => !s)}>
					<EyeOff />
					{showHidden ? t("releases.hideHidden") : t("releases.showHidden", { count: hidden.length })}
				</Button>
			)}
			{showHidden && hidden.map(row)}
		</div>
	);
}
