import { Check, Download, FileStack, Magnet, Sparkles, Users } from "lucide-react";
import { useState } from "react";
import { runOp } from "../../lib/api";
import type { IndexerOutcome, Release } from "../../lib/types";
import { cn, formatBytes, formatDateTime, newRequestId, timeAgo } from "../../lib/utils";
import { AskAbout } from "../common/AskAbout";
import { Badge } from "../common/Badge";
import { Spinner } from "../common/States";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { toast } from "../hooks/use-toast";

export type AddResult = { hash: string; name: string; adopted: boolean; started: boolean; files: number; size?: number; warnings?: string[] };

export function releaseDescription(r: Release): string {
	return `release ${r.handle} "${r.title}" (${formatBytes(r.size)}, ${r.seeders ?? "?"} seeders, ${r.indexer ?? "unknown indexer"})`;
}

export function ReleaseBadges({ r }: { r: Release }) {
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
			{p.chineseSubs && <Badge tone="success">中字 {p.chineseSubs}</Badge>}
			{(p.season != null || eps) && (
				<Badge tone="info">
					{p.season != null ? `S${String(p.season).padStart(2, "0")}` : ""}
					{eps}
				</Badge>
			)}
			{p.seasons && p.seasons.length > 1 && <Badge tone="info">S{p.seasons.join(",")}</Badge>}
			{p.complete && <Badge tone="info">complete</Badge>}
			{p.group && <Badge tone="muted">{p.group}</Badge>}
			{r.freeleech && <Badge tone="success">free</Badge>}
			{r.hasMagnet && !r.size && (
				<Badge tone="muted">
					<Magnet className="h-3 w-3" /> magnet
				</Badge>
			)}
		</div>
	);
}

export function IndexerLine({ indexers, total }: { indexers?: IndexerOutcome[]; total?: number }) {
	if (!indexers?.length) return null;
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
			{total != null && <span>{total} results</span>}
			{indexers.map((i) => (
				<span key={i.indexer} title={i.error} className={cn("inline-flex items-center gap-1", !i.ok && "text-destructive-foreground")}>
					<span className={cn("h-1.5 w-1.5 rounded-full", i.ok ? "bg-success" : "bg-destructive-foreground")} />
					{i.name || i.indexer}: {i.ok ? `${i.count} in ${(i.ms / 1000).toFixed(1)}s` : (i.error ?? "failed")}
				</span>
			))}
		</div>
	);
}

function FilesDialog({ handle, open, onOpenChange }: { handle: string; open: boolean; onOpenChange: (o: boolean) => void }) {
	const [data, setData] = useState<{ name: string; files?: { path: string; size: number }[]; magnetOnly?: boolean } | { error: string }>();
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				onOpenChange(o);
				if (o && !data)
					runOp<{ name: string; files?: { path: string; size: number }[]; magnetOnly?: boolean }>("release.files", { handle })
						.then((r) => setData(r.output))
						.catch((e) => setData({ error: e instanceof Error ? e.message : String(e) }));
			}}
		>
			<DialogContent className="glass-card max-w-2xl rounded-xl">
				<DialogHeader>
					<DialogTitle>Files in {handle}</DialogTitle>
				</DialogHeader>
				{!data ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Spinner /> Fetching the torrent…
					</div>
				) : "error" in data ? (
					<p className="text-sm text-destructive-foreground">{data.error}</p>
				) : data.magnetOnly || !data.files ? (
					<p className="text-sm text-muted-foreground">Magnet link only: the file list is known once the download is added.</p>
				) : (
					<div className="max-h-[60vh] overflow-y-auto text-xs">
						<p className="mb-2 font-medium">{data.name}</p>
						{data.files.map((f) => (
							<div key={f.path} className="flex justify-between gap-3 border-b border-white/5 py-1">
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

function ReleaseRow({ r, titleId, picked, onDownloaded, showAsk }: { r: Release; titleId?: string; picked?: boolean; onDownloaded?: (r: Release, out: AddResult) => void; showAsk?: boolean }) {
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<AddResult>();
	const [files, setFiles] = useState(false);
	const download = async () => {
		setBusy(true);
		try {
			const res = await runOp<AddResult>("download.add", { handle: r.handle, title_id: titleId ?? r.titleId, reason: "Chosen by the owner from the release list." }, newRequestId());
			setDone(res.output);
			toast({ title: res.output.adopted ? "Already downloading" : "Download added", description: res.output.name });
			for (const w of res.output.warnings ?? []) toast({ title: "Note", description: w });
			onDownloaded?.(r, res.output);
		} catch (e) {
			toast({ title: "Download failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className={cn("rounded-lg border border-white/5 bg-white/[0.02] p-3", picked && "border-primary/50 bg-primary/5")}>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 flex-1 space-y-1.5">
					<div className="flex items-start gap-2">
						{picked && <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-label="Recommended" />}
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
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-1 sm:justify-end">
					<Button variant="ghost" size="sm" className="h-8 px-2 text-muted-foreground" onClick={() => setFiles(true)} title="Files in this release">
						<FileStack />
						<span className="sm:hidden lg:inline">Files</span>
					</Button>
					{showAsk && <AskAbout compact text={`Why this one? Tell me about ${releaseDescription(r)}.`} label="Why this one?" />}
					<Button size="sm" className="h-8" disabled={busy || !!done} onClick={download}>
						{busy ? <Spinner /> : done ? <Check /> : <Download />}
						{done ? (done.adopted ? "Adopted" : "Added") : "Download"}
					</Button>
				</div>
			</div>
			<FilesDialog handle={r.handle} open={files} onOpenChange={setFiles} />
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
	return (
		<div className="space-y-2">
			{releases.map((r) => (
				<ReleaseRow key={r.handle} r={r} titleId={titleId} picked={pick === r.handle} onDownloaded={onDownloaded} showAsk={showAsk} />
			))}
		</div>
	);
}
