import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardList, Inbox, KeyRound, MessageSquare, Newspaper, Send, Bell, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
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
import { fileUrl, timeAgo } from "../lib/utils";

const ICONS: Record<string, React.ElementType> = { question: MessageSquare, plan: ClipboardList, verification: KeyRound, summary: Newspaper, notice: Bell };

function InboxCard({ item }: { item: InboxItem }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const { setActive } = useChat();
	const [busy, setBusy] = useState<string>();
	const [text, setText] = useState("");
	const Icon = ICONS[item.kind] ?? Bell;
	const open = item.status === "open";

	const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
		setBusy(key);
		try {
			await fn();
			if (done) toast({ title: done });
			qc.invalidateQueries({ queryKey: ["inbox"] });
			qc.invalidateQueries({ queryKey: ["status"] });
		} catch (e) {
			toast({ title: "Failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};

	const continueInChat = () =>
		run("continue", async () => {
			const t = await endpoints.continueInbox(item.id);
			qc.invalidateQueries({ queryKey: ["threads"] });
			setActive(t.id);
			navigate(`/chat/${encodeURIComponent(t.id)}`);
		});

	const wantsText = open && (item.kind === "verification" || (item.kind === "question" && !item.options.length));

	return (
		<div className="glass-card rounded-xl p-4">
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
						{item.kind} · {timeAgo(item.created_at)}
						{item.source ? ` · from ${item.source}` : ""}
					</p>
					{item.body && <Markdown text={item.body} />}
					{item.image_path && (
						<a href={fileUrl(item.image_path)} target="_blank" rel="noreferrer">
							<img src={fileUrl(item.image_path)} alt="" className="max-h-80 max-w-full rounded-lg border border-white/5 bg-white" />
						</a>
					)}
					{item.answer && <p className="text-sm text-success">Answer: {item.answer}</p>}

					{open && item.options.length > 0 && (
						<div className="flex flex-wrap gap-2">
							{item.options.map((o) => (
								<Button key={o} size="sm" variant="outline" disabled={!!busy} onClick={() => run(o, () => endpoints.answerInbox(item.id, o), "Answered")}>
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
								if (text.trim()) void run("text", () => endpoints.answerInbox(item.id, text.trim()), "Answered");
							}}
						>
							<Input value={text} onChange={(e) => setText(e.target.value)} placeholder={item.kind === "verification" ? "Code" : "Your answer"} className="h-9" />
							<Button type="submit" size="sm" className="h-9" disabled={!!busy || !text.trim()}>
								{busy === "text" ? <Spinner /> : <Send />}
								Send
							</Button>
						</form>
					)}

					<div className="flex flex-wrap items-center gap-1 pt-1">
						{item.job_run_id && (
							<Button size="sm" variant="secondary" className="h-8" disabled={!!busy} onClick={continueInChat}>
								{busy === "continue" ? <Spinner /> : <MessageSquare />}
								Continue in chat
							</Button>
						)}
						{open && (
							<Button size="sm" variant="ghost" className="h-8 text-muted-foreground" disabled={!!busy} onClick={() => run("dismiss", () => endpoints.dismissInbox(item.id), "Dismissed")}>
								{busy === "dismiss" ? <Spinner /> : item.kind === "notice" || item.kind === "summary" ? <Check /> : <X />}
								{item.kind === "notice" || item.kind === "summary" ? "Done" : "Dismiss"}
							</Button>
						)}
						<AskAbout className="ml-auto" text={`About the inbox item "${item.title}" (${item.id}, ${item.kind}): `} />
					</div>
				</div>
			</div>
		</div>
	);
}

/** Things waiting for the owner: questions from jobs, plans, verification, summaries. */
export function InboxScreen() {
	const [status, setStatus] = useState("open");
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["inbox", status], queryFn: () => endpoints.inbox(status) });
	return (
		<Screen
			title="Inbox"
			subtitle="Questions, plans to approve, verification and summaries from background work"
			toolbar={
				<Tabs value={status} onValueChange={setStatus}>
					<TabsList>
						<TabsTrigger value="open">Open</TabsTrigger>
						<TabsTrigger value="answered">Answered</TabsTrigger>
						<TabsTrigger value="dismissed">Dismissed</TabsTrigger>
						<TabsTrigger value="all">All</TabsTrigger>
					</TabsList>
				</Tabs>
			}
		>
			{isLoading ? (
				<Loading />
			) : error ? (
				<ErrorState error={error} onRetry={() => refetch()} />
			) : !data?.length ? (
				<Empty icon={<Inbox />} title={status === "open" ? "Nothing waiting for you" : "Nothing here"}>
					{status === "open" ? "When background work needs a decision, it shows up here (and on Telegram, if linked)." : null}
				</Empty>
			) : (
				<div className="mx-auto max-w-3xl space-y-3">
					{data.map((it) => (
						<InboxCard key={it.id} item={it} />
					))}
				</div>
			)}
		</Screen>
	);
}
