import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ChevronDown, MessageSquare, Play } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { AskAbout } from "../components/common/AskAbout";
import { StateBadge } from "../components/common/Badge";
import { Screen } from "../components/common/Screen";
import { Empty, ErrorState, Loading, Spinner } from "../components/common/States";
import { toast } from "../components/hooks/use-toast";
import { Button } from "../components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { endpoints } from "../lib/api";
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
	const [open, setOpen] = useState(false);
	return (
		<div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
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
					Input
				</Button>
				<AskAbout className="ml-auto h-7" text={`About ledger entry #${a.id} (${a.op} by ${a.actor}, ${a.status}${a.error ? `: ${a.error}` : ""}, ${a.started_at}): `} />
			</div>
			{open && <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-black/30 p-2 text-[11px] text-muted-foreground">{prettyInput(a.input_json)}</pre>}
		</div>
	);
}

function Ledger() {
	const [status, setStatus] = useState("");
	const [limit, setLimit] = useState(50);
	const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ["activity", { status, limit }], queryFn: () => endpoints.activity({ limit, status: status || undefined }) });
	return (
		<div className="space-y-3">
			<Tabs value={status} onValueChange={setStatus}>
				<TabsList>
					<TabsTrigger value="">All</TabsTrigger>
					<TabsTrigger value="failed">Failed</TabsTrigger>
					<TabsTrigger value="unknown">Unsettled</TabsTrigger>
				</TabsList>
			</Tabs>
			{isLoading ? (
				<Loading />
			) : error ? (
				<ErrorState error={error} onRetry={() => refetch()} />
			) : !data?.length ? (
				<Empty icon={<Activity />} title="Nothing recorded yet" />
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
							Show more
						</Button>
					)}
				</>
			)}
		</div>
	);
}

function Jobs() {
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
				<h3 className="mb-2 text-sm font-semibold">Scheduled</h3>
				{!data?.jobs.length ? (
					<p className="text-sm text-muted-foreground">No scheduled jobs.</p>
				) : (
					<div className="space-y-2">
						{data.jobs.map((j) => (
							<div key={j.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-sm">
								<span className="font-medium">{j.kind}</span>
								<span className="text-xs text-muted-foreground">{j.schedule ?? "once"}</span>
								{!j.enabled && <StateBadge state="disabled" />}
								{j.next_run_at && <span className="text-xs text-muted-foreground">next {formatDateTime(j.next_run_at)}</span>}
								<Button
									size="sm"
									variant="outline"
									className="ml-auto h-8"
									disabled={!!busy}
									onClick={async () => {
										setBusy(j.id);
										try {
											await endpoints.runJob(j.id);
											toast({ title: "Started", description: j.kind });
											qc.invalidateQueries({ queryKey: ["jobs"] });
										} catch (e) {
											toast({ title: "Not started", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
										} finally {
											setBusy(undefined);
										}
									}}
								>
									{busy === j.id ? <Spinner /> : <Play />}
									Run now
								</Button>
							</div>
						))}
					</div>
				)}
			</div>
			<div>
				<h3 className="mb-2 text-sm font-semibold">Recent runs</h3>
				{!data?.runs.length ? (
					<p className="text-sm text-muted-foreground">No job has run yet.</p>
				) : (
					<div className="space-y-2">
						{data.runs.map((r) => (
							<div key={r.id} className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
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
											<MessageSquare /> Open conversation
										</Button>
									)}
									<AskAbout className="ml-auto h-7" text={`About job run ${r.id} (${r.kind}, ${r.state}): `} />
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
	const [tab, setTab] = useState("ledger");
	return (
		<Screen
			title="Activity"
			subtitle="What was done, by whom, and with what result"
			toolbar={
				<Tabs value={tab} onValueChange={setTab}>
					<TabsList>
						<TabsTrigger value="ledger">Ledger</TabsTrigger>
						<TabsTrigger value="jobs">Jobs</TabsTrigger>
					</TabsList>
				</Tabs>
			}
		>
			<div className="mx-auto max-w-4xl">{tab === "ledger" ? <Ledger /> : <Jobs />}</div>
		</Screen>
	);
}
