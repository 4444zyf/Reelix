import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardCheck, ClipboardList, Inbox, KeyRound, MessageSquare, Newspaper, Send, Bell, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { ProposalCard } from "../components/cards/ProposalCard";
import { PluginProposalCard } from "../components/settings/PluginInstall";
import { AskAbout } from "../components/common/AskAbout";
import { StateBadge } from "../components/common/Badge";
import { Markdown } from "../components/common/Markdown";
import { Screen } from "../components/common/Screen";
import { Empty, ErrorState, Loading, Spinner } from "../components/common/States";
import { toast } from "../components/hooks/use-toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { endpoints } from "../lib/api";
import { useChat } from "../lib/chat";
import type { InboxItem } from "../lib/types";
import { cn, fileUrl, timeAgo } from "../lib/utils";

const ICONS: Record<string, React.ElementType> = { question: MessageSquare, plan: ClipboardList, verification: KeyRound, summary: Newspaper, notice: Bell, proposal: ClipboardCheck };

function InboxCard({ item, highlighted }: { item: InboxItem; highlighted?: boolean }) {
	const { t } = useTranslation(["activity", "common"]);
	const qc = useQueryClient();
	const navigate = useNavigate();
	const { setActive } = useChat();
	const [busy, setBusy] = useState<string>();
	const [text, setText] = useState("");
	const Icon = ICONS[item.kind] ?? Bell;
	const open = item.status === "open";
	const cardRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (highlighted) cardRef.current?.scrollIntoView({ block: "center" });
	}, [highlighted]);

	const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
		setBusy(key);
		try {
			await fn();
			if (done) toast({ title: done });
			qc.invalidateQueries({ queryKey: ["inbox"] });
			qc.invalidateQueries({ queryKey: ["status"] });
		} catch (e) {
			toast({ title: t("inbox.failed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};

	const continueInChat = () =>
		run("continue", async () => {
			const th = await endpoints.continueInbox(item.id);
			qc.invalidateQueries({ queryKey: ["threads"] });
			setActive(th.id);
			navigate(`/chat/${encodeURIComponent(th.id)}`);
		});

	const wantsText = open && (item.kind === "verification" || (item.kind === "question" && !item.options.length));
	const proposalId = (item.payload as { proposal?: unknown } | undefined)?.proposal;
	const proposal = typeof proposalId === "string" ? proposalId : undefined;
	const pluginProposalId = (item.payload as { pluginProposal?: unknown } | undefined)?.pluginProposal;
	const pluginProposal = typeof pluginProposalId === "string" ? pluginProposalId : undefined;

	return (
		<div ref={cardRef} id={`inbox-${item.id}`} className={cn("surface-card scroll-mt-28 rounded-xl p-4", highlighted && "ring-2 ring-primary")}>
			<div className="flex items-start gap-3">
				<div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
					<Icon className="h-4 w-4" />
				</div>
				<div className="min-w-0 flex-1 space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<p className="font-semibold leading-tight">{item.title}</p>
						<StateBadge state={item.status} />
					</div>
					<p className="text-xs text-muted-foreground">
						{t(`inbox.kind.${item.kind}` as "inbox.kind.question", { defaultValue: item.kind })} · {timeAgo(item.created_at)}
						{item.source ? ` · ${t("inbox.from", { source: item.source })}` : ""}
					</p>
					{proposal ? <ProposalCard id={proposal} /> : item.body && <Markdown text={item.body} />}
					{pluginProposal && <PluginProposalCard id={pluginProposal} open={open} />}
					{item.image_path && (
						<a href={fileUrl(item.image_path)} target="_blank" rel="noreferrer">
							<img src={fileUrl(item.image_path)} alt="" className="max-h-80 max-w-full rounded-lg border border-line bg-white" />
						</a>
					)}
					{item.answer && <p className="text-sm text-success">{t("inbox.answer", { answer: item.answer })}</p>}

					{open && item.options.length > 0 && (
						<div className="flex flex-wrap gap-2">
							{item.options.map((o) => (
								<Button key={o} size="sm" variant="outline" disabled={!!busy} onClick={() => run(o, () => endpoints.answerInbox(item.id, o), t("inbox.answered"))}>
									{busy === o && <Spinner />}
									{o}
								</Button>
							))}
						</div>
					)}
					{wantsText && (
						<form
							className="flex gap-2"
							onSubmit={(e) => {
								e.preventDefault();
								if (text.trim()) void run("text", () => endpoints.answerInbox(item.id, text.trim()), t("inbox.answered"));
							}}
						>
							<Input value={text} onChange={(e) => setText(e.target.value)} placeholder={item.kind === "verification" ? t("inbox.code") : t("inbox.yourAnswer")} className="h-9" />
							<Button type="submit" size="sm" className="h-9" disabled={!!busy || !text.trim()}>
								{busy === "text" ? <Spinner /> : <Send />}
								{t("inbox.send")}
							</Button>
						</form>
					)}

					<div className="flex flex-wrap items-center gap-1 pt-1">
						{item.job_run_id && (
							<Button size="sm" variant="secondary" className="h-8" disabled={!!busy} onClick={continueInChat}>
								{busy === "continue" ? <Spinner /> : <MessageSquare />}
								{t("inbox.continueInChat")}
							</Button>
						)}
						{open && !proposal && !pluginProposal && (
							<Button size="sm" variant="ghost" className="h-8 text-muted-foreground" disabled={!!busy} onClick={() => run("dismiss", () => endpoints.dismissInbox(item.id), t("inbox.dismissed"))}>
								{busy === "dismiss" ? <Spinner /> : item.kind === "notice" || item.kind === "summary" ? <Check /> : <X />}
								{item.kind === "notice" || item.kind === "summary" ? t("inbox.done") : t("common:actions.dismiss")}
							</Button>
						)}
						<AskAbout className="ml-auto" text={t("inbox.askAbout", { title: item.title, id: item.id, kind: item.kind })} />
					</div>
				</div>
			</div>
		</div>
	);
}

/** Things waiting for the owner: questions from jobs, plans, verification, summaries. */
export function InboxScreen() {
	const { t } = useTranslation("activity");
	// A notification opens its item; one already handled is found under "all".
	const [params] = useSearchParams();
	const wanted = params.get("item");
	const [status, setStatus] = useState("open");
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["inbox", status], queryFn: () => endpoints.inbox(status) });
	useEffect(() => {
		if (wanted && status === "open" && data && !data.some((it) => it.id === wanted)) setStatus("all");
	}, [wanted, status, data]);
	return (
		<Screen
			title={t("inbox.title")}
			subtitle={t("inbox.subtitle")}
			toolbar={
				<Tabs value={status} onValueChange={setStatus}>
					<TabsList>
						<TabsTrigger value="open">{t("inbox.tabs.open")}</TabsTrigger>
						<TabsTrigger value="answered">{t("inbox.tabs.answered")}</TabsTrigger>
						<TabsTrigger value="dismissed">{t("inbox.tabs.dismissed")}</TabsTrigger>
						<TabsTrigger value="all">{t("inbox.tabs.all")}</TabsTrigger>
					</TabsList>
				</Tabs>
			}
		>
			{isLoading ? (
				<Loading />
			) : error ? (
				<ErrorState error={error} onRetry={() => refetch()} />
			) : !data?.length ? (
				<Empty icon={<Inbox />} title={status === "open" ? t("inbox.emptyOpen") : t("inbox.empty")}>
					{status === "open" ? t("inbox.emptyOpenHint") : null}
				</Empty>
			) : (
				<div className="max-w-3xl space-y-3">
					{data.map((it) => (
						<InboxCard key={it.id} item={it} highlighted={it.id === wanted} />
					))}
				</div>
			)}
		</Screen>
	);
}
