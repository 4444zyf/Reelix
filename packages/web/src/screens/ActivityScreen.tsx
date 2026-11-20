import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ChevronDown, MessageSquare, Play, Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { AskAbout } from "../components/common/AskAbout";
import { StateBadge } from "../components/common/Badge";
import { Screen } from "../components/common/Screen";
import { Empty, ErrorState, Loading, Spinner } from "../components/common/States";
import { toast } from "../components/hooks/use-toast";
import { Button } from "../components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { endpoints, op } from "../lib/api";
import { useChat } from "../lib/chat";
import type { LedgerRow } from "../lib/types";
import { cn, formatDateTime, timeAgo } from "../lib/utils";

function prettyInput(json: string): string {
	try {
		const v = JSON.parse(json);
		return JSON.stringify(v, null, 2);
	} catch {
		return json;
	}
}

function LedgerItem({ a }: { a: LedgerRow }) {
	const { t } = useTranslation("activity");
	const [open, setOpen] = useState(false);
	return (
		<div className="rounded-lg border border-line bg-surface px-3 py-2">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<StateBadge state={a.status} />
				<span className="font-medium">{a.op}</span>
				<span className="text-xs text-muted-foreground">{a.actor}</span>
				{a.title_id && (
					<Link to={`/library/${encodeURIComponent(a.title_id)}`} className="text-xs text-primary hover:underline">
						{a.title_id}
					</Link>
				)}
				<span className="ml-auto text-xs text-muted-foreground" title={formatDateTime(a.started_at)}>
					{timeAgo(a.started_at)}
				</span>
			</div>
			{a.error && <p className="mt-1 text-xs text-destructive-foreground">{a.error}</p>}
			<div className="mt-1 flex flex-wrap items-center gap-1">
				<Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setOpen((o) => !o)}>
					<ChevronDown className={cn("transition-transform", open && "rotate-180")} />
					{t("ledger.input")}
				</Button>
				<AskAbout className="ml-auto h-7" text={a.error ? t("ledger.askAboutWithError", { id: a.id, op: a.op, actor: a.actor, status: a.status, error: a.error, at: a.started_at }) : t("ledger.askAbout", { id: a.id, op: a.op, actor: a.actor, status: a.status, at: a.started_at })} />
			</div>
			{open && <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-well p-2 text-[11px] text-muted-foreground">{prettyInput(a.input_json)}</pre>}
		</div>
	);
}

function Ledger() {
	const { t } = useTranslation("activity");
	const [status, setStatus] = useState("");
	const [limit, setLimit] = useState(50);
	const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ["activity", { status, limit }], queryFn: () => endpoints.activity({ limit, status: status || undefined }) });
	return (
		<div className="space-y-3">
			<Tabs value={status} onValueChange={setStatus}>
				<TabsList>
					<TabsTrigger value="">{t("ledger.all")}</TabsTrigger>
					<TabsTrigger value="failed">{t("ledger.failed")}</TabsTrigger>
					<TabsTrigger value="unknown">{t("ledger.unsettled")}</TabsTrigger>
				</TabsList>
			</Tabs>
			{isLoading ? (
				<Loading />
			) : error ? (
				<ErrorState error={error} onRetry={() => refetch()} />
			) : !data?.length ? (
				<Empty icon={<Activity />} title={t("ledger.empty")} />
			) : (
				<>
					<div className="space-y-2">
						{data.map((a) => (
							<LedgerItem key={a.id} a={a} />
						))}
					</div>
					{data.length >= limit && (
						<Button variant="ghost" className="w-full" disabled={isFetching} onClick={() => setLimit((l) => l + 50)}>
							{isFetching && <Spinner />}
							{t("ledger.showMore")}
						</Button>
					)}
				</>
			)}
		</div>
	);
}

function Jobs() {
	const { t } = useTranslation("activity");
	const qc = useQueryClient();
	const navigate = useNavigate();
	const { setActive } = useChat();
	const [busy, setBusy] = useState<string>();
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["jobs"], queryFn: endpoints.jobs, refetchInterval: 30_000 });
	if (isLoading) return <Loading />;
	if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
	return (
		<div className="space-y-5">
			<div>
				<h3 className="mb-2 text-sm font-semibold">{t("jobs.scheduled")}</h3>
				{!data?.jobs.length ? (
					<p className="text-sm text-muted-foreground">{t("jobs.noScheduled")}</p>
				) : (
					<div className="space-y-2">
						{data.jobs.map((j) => (
							<div key={j.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
								<span className="font-medium">{j.kind}</span>
								<span className="text-xs text-muted-foreground">{j.schedule ?? t("jobs.once")}</span>
								{!j.enabled && <StateBadge state="disabled" />}
								{j.next_run_at && <span className="text-xs text-muted-foreground">{t("jobs.next", { time: formatDateTime(j.next_run_at) })}</span>}
								<Button
									size="sm"
									variant="outline"
									className="ml-auto h-8"
									disabled={!!busy}
									onClick={async () => {
										setBusy(j.id);
										try {
											await endpoints.runJob(j.id);
											toast({ title: t("jobs.started"), description: j.kind });
											qc.invalidateQueries({ queryKey: ["jobs"] });
										} catch (e) {
											toast({ title: t("jobs.notStarted"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
										} finally {
											setBusy(undefined);
										}
									}}
								>
									{busy === j.id ? <Spinner /> : <Play />}
									{t("jobs.runNow")}
								</Button>
							</div>
						))}
					</div>
				)}
			</div>
			<div>
				<h3 className="mb-2 text-sm font-semibold">{t("jobs.recentRuns")}</h3>
				{!data?.runs.length ? (
					<p className="text-sm text-muted-foreground">{t("jobs.noRuns")}</p>
				) : (
					<div className="space-y-2">
						{data.runs.map((r) => (
							<div key={r.id} className="rounded-lg border border-line bg-surface px-3 py-2">
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<StateBadge state={r.state} />
									<span className="font-medium">{r.kind}</span>
									<span className="ml-auto text-xs text-muted-foreground" title={formatDateTime(r.created_at)}>
										{timeAgo(r.created_at)}
									</span>
								</div>
								{r.summary && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{r.summary}</p>}
								<div className="mt-1 flex flex-wrap gap-1">
									{r.thread_id && (
										<Button
											size="sm"
											variant="ghost"
											className="h-7 px-2 text-xs"
											onClick={() => {
												setActive(r.thread_id!);
												navigate(`/chat/${encodeURIComponent(r.thread_id!)}`);
											}}
										>
											<MessageSquare /> {t("jobs.openConversation")}
										</Button>
									)}
									{r.kind === "translate" && (r.state === "running" || r.state === "queued") && (
										<Button
											size="sm"
											variant="ghost"
											className="h-7 px-2 text-xs"
											onClick={async () => {
												try {
													const id = (JSON.parse(r.payload_json ?? "{}") as { translation_id?: string }).translation_id;
													if (id) await op("subtitle.translation_cancel", { id });
													toast({ title: t("jobs.translationStopped") });
													qc.invalidateQueries({ queryKey: ["jobs"] });
												} catch (e) {
													toast({ title: t("jobs.notStopped"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
												}
											}}
										>
											<Square /> {t("jobs.stopTranslation")}
										</Button>
									)}
									<AskAbout className="ml-auto h-7" text={t("jobs.askAbout", { id: r.id, kind: r.kind, state: r.state })} />
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/** The ledger of everything done, and background job runs. */
export function ActivityScreen() {
	const { t } = useTranslation("activity");
	const [tab, setTab] = useState("ledger");
	return (
		<Screen
			title={t("screen.title")}
			subtitle={t("screen.subtitle")}
			toolbar={
				<Tabs value={tab} onValueChange={setTab}>
					<TabsList>
						<TabsTrigger value="ledger">{t("screen.ledger")}</TabsTrigger>
						<TabsTrigger value="jobs">{t("screen.jobs")}</TabsTrigger>
					</TabsList>
				</Tabs>
			}
		>
			<div className="mx-auto max-w-4xl">{tab === "ledger" ? <Ledger /> : <Jobs />}</div>
		</Screen>
	);
}
