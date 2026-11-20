import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, FolderInput, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { AskAbout } from "../components/common/AskAbout";
import { Badge, StateBadge } from "../components/common/Badge";
import { Screen } from "../components/common/Screen";
import { Empty, ErrorState, Loading, Spinner } from "../components/common/States";
import { toast } from "../components/hooks/use-toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ApiError, endpoints, runOp } from "../lib/api";
import type { AdoptRow, AdoptScan } from "../lib/types";
import { cn } from "../lib/utils";
import { useShortPath } from "../lib/paths";

function SetTitle({ scan, row }: { scan: AdoptScan; row: AdoptRow }) {
	const { t } = useTranslation("library");
	const qc = useQueryClient();
	const [id, setId] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<form
			className="mt-2 flex gap-2"
			onSubmit={async (e) => {
				e.preventDefault();
				if (!id.trim()) return;
				setBusy(true);
				try {
					await runOp("adopt.set", { id: scan.id, n: row.n, title_id: id.trim() });
					setId("");
					await qc.invalidateQueries({ queryKey: ["adopt"] });
				} catch (err) {
					toast({ title: t("adopt.notSet"), description: err instanceof Error ? err.message : String(err), variant: "destructive" });
				} finally {
					setBusy(false);
				}
			}}
		>
			<Input value={id} onChange={(e) => setId(e.target.value)} placeholder={t("adopt.titleIdPlaceholder")} className="h-8 text-xs" />
			<Button type="submit" size="sm" variant="outline" className="h-8" disabled={busy || !id.trim()}>
				{busy && <Spinner />}
				{t("adopt.setTitle")}
			</Button>
		</form>
	);
}

function Row({ scan, row, checked, onToggle }: { scan: AdoptScan; row: AdoptRow; checked: boolean; onToggle: () => void }) {
	const { t } = useTranslation("library");
	const short = useShortPath();
	const [open, setOpen] = useState(false);
	const pending = row.status === "pending";
	const videos = row.plan?.items.filter((i) => i.kind === "video" || i.kind === "disc").length ?? 0;
	return (
		<div className={cn("rounded-lg border px-3 py-2", row.confident ? "border-line bg-surface" : "border-warning/30 bg-warning/5")}>
			<div className="flex items-start gap-3">
				<input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-primary)]" checked={checked} disabled={!pending || !row.plan} onChange={onToggle} aria-label={t("adopt.rowAria", { n: row.n })} />
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-mono text-xs text-muted-foreground">#{row.n}</span>
						<p className="min-w-0 break-all text-sm font-medium">{row.name}</p>
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
						{row.title_id ? (
							<Link to={`/library/${encodeURIComponent(row.title_id)}`} className="text-primary hover:underline">
								{row.title ?? row.title_id}
							</Link>
						) : (
							<span className="text-muted-foreground">{t("adopt.titleUnknown")}</span>
						)}
						{row.confident ? <Badge tone="success">{t("adopt.confident")}</Badge> : <Badge tone="warning">{t("adopt.uncertain")}</Badge>}
						{!row.complete && <Badge tone="muted">{t("adopt.incomplete")}</Badge>}
						{videos > 0 && <Badge tone="muted">{t("adopt.videos", { count: videos })}</Badge>}
						{row.status !== "pending" && <StateBadge state={row.status} />}
					</div>
					{row.why && !row.confident && <p className="mt-1 text-xs text-muted-foreground">{row.why}</p>}
					{row.problems.map((p, i) => (
						<p key={i} className="mt-1 flex items-start gap-1 text-xs text-warning">
							<TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
							{p}
						</p>
					))}
					{row.error && <p className="mt-1 text-xs text-destructive-foreground">{row.error}</p>}
					<div className="mt-1 flex flex-wrap items-center gap-1">
						{row.plan?.items.length ? (
							<Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setOpen((o) => !o)}>
								{open ? t("adopt.hidePlan") : t("adopt.showPlan")}
							</Button>
						) : null}
						<AskAbout className="ml-auto h-7" text={t("adopt.rowPrompt", { n: row.n, name: row.name, scan: scan.id })} />
					</div>
					{open && row.plan && (
						<div className="mt-1 space-y-1 text-[11px]">
							{row.plan.items.map((it, i) => (
								<div key={i} className="rounded bg-well px-2 py-1">
									<p className="break-all text-muted-foreground">{short(it.source)}</p>
									<p className="break-all">→ {short(it.dest)}</p>
								</div>
							))}
						</div>
					)}
					{pending && !row.confident && <SetTitle scan={scan} row={row} />}
				</div>
			</div>
		</div>
	);
}

/** One review table for torrents that were in the downloader before Reelix: confident rows ticked, one Approve. */
export function AdoptScreen() {
	const { t } = useTranslation("library");
	const qc = useQueryClient();
	const scan = useQuery({ queryKey: ["adopt"], queryFn: endpoints.adoptShow, retry: false });
	const [picked, setPicked] = useState<Set<number>>(new Set());
	const [busy, setBusy] = useState<string>();
	const noScan = scan.error instanceof ApiError && scan.error.status < 500;

	useEffect(() => {
		if (scan.data) setPicked(new Set(scan.data.rows.filter((r) => r.confident && r.status === "pending" && r.plan).map((r) => r.n)));
	}, [scan.data?.id, scan.data?.rows.length]);

	const runScan = async () => {
		setBusy("scan");
		try {
			const r = await runOp<AdoptScan>("adopt.scan", { notify: false });
			qc.setQueryData(["adopt"], r.output);
		} catch (e) {
			toast({ title: t("adopt.scanFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};

	const approve = async () => {
		if (!scan.data || !picked.size) return;
		setBusy("apply");
		try {
			const r = await runOp("adopt.apply", { id: scan.data.id, rows: [...picked].sort((a, b) => a - b) });
			toast({ title: t("adopt.adopted"), description: r.text.slice(0, 400) });
			await qc.invalidateQueries({ queryKey: ["adopt"] });
			qc.invalidateQueries({ queryKey: ["library"] });
			qc.invalidateQueries({ queryKey: ["downloads"] });
		} catch (e) {
			toast({ title: t("adopt.notAdopted"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};

	const rows = scan.data?.rows ?? [];
	return (
		<Screen
			title={t("adopt.title")}
			subtitle={t("adopt.subtitle")}
			back={
				<Button asChild variant="ghost" size="icon" className="shrink-0">
					<Link to="/library" aria-label={t("title.backToLibrary")}>
						<ArrowLeft />
					</Link>
				</Button>
			}
			actions={(scrolled) => (
				<>
					<Button variant="outline" size={scrolled ? "sm" : "default"} disabled={!!busy} onClick={runScan}>
						{busy === "scan" ? <Spinner /> : <RefreshCw />}
						<span className="hidden sm:inline">{scan.data ? t("adopt.scanAgain") : t("adopt.scan")}</span>
					</Button>
					{rows.length > 0 && (
						<Button size={scrolled ? "sm" : "default"} disabled={!!busy || !picked.size} onClick={approve}>
							{busy === "apply" ? <Spinner /> : <Check />}
							{t("adopt.approve", { n: picked.size })}
						</Button>
					)}
				</>
			)}
		>
			<div className="mx-auto max-w-4xl space-y-2">
				{scan.isLoading ? (
					<Loading />
				) : noScan || (!scan.error && !rows.length) ? (
					<Empty icon={<FolderInput />} title={scan.data ? t("adopt.nothing") : t("adopt.noScan")}>
						<p>{t("adopt.scanHint")}</p>
						<Button className="mt-3" disabled={!!busy} onClick={runScan}>
							{busy === "scan" ? <Spinner /> : <RefreshCw />}
							{t("adopt.scanNow")}
						</Button>
					</Empty>
				) : scan.error ? (
					<ErrorState error={scan.error} onRetry={() => scan.refetch()} />
				) : (
					<>
						<p className="text-xs text-muted-foreground">
							{t("adopt.summary", { confident: rows.filter((r) => r.confident).length, uncertain: rows.filter((r) => !r.confident).length, applied: rows.filter((r) => r.status === "applied").length })}
						</p>
						{rows.map((r) => (
							<Row
								key={r.n}
								scan={scan.data!}
								row={r}
								checked={picked.has(r.n)}
								onToggle={() =>
									setPicked((s) => {
										const n = new Set(s);
										if (n.has(r.n)) n.delete(r.n);
										else n.add(r.n);
										return n;
									})
								}
							/>
						))}
					</>
				)}
			</div>
		</Screen>
	);
}
