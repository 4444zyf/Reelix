import { Bot, ListTree, Loader2, MoreHorizontal, Pencil, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChat } from "../../lib/chat";
import { cn } from "../../lib/utils";
import { ErrorState, Loading } from "../common/States";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { AskPanel } from "./AskPanel";
import { Composer, DropZone, useAttachments } from "./Composer";
import { MessageView } from "./MessageView";
import { RenameThreadDialog, ThreadList, useThreads } from "./ThreadList";

const SUGGESTIONS = ["downloading", "newSeason", "doctor", "lastNight"] as const;

function Welcome() {
	const { t } = useTranslation("chat");
	const { setDraft } = useChat();
	return (
		<div className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
			<div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
				<Bot className="h-6 w-6" />
			</div>
			<div>
				<p className="display text-3xl">{t("welcome.title")}</p>
				<p className="text-sm text-muted-foreground">{t("welcome.subtitle")}</p>
			</div>
			<div className="flex max-w-lg flex-wrap justify-center gap-2">
				{SUGGESTIONS.map((k) => t(`welcome.suggestions.${k}`)).map((s) => (
					<button key={s} type="button" onClick={() => setDraft(s)} className="rounded-control border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
						{s}
					</button>
				))}
			</div>
		</div>
	);
}

/** The conversation, its open question and the composer. Used by the Chat screen and the dock. */
export function ChatPane({ variant, onClose }: { variant: "screen" | "dock"; onClose?: () => void }) {
	const { t } = useTranslation("chat");
	const { activeId, thread, newChat } = useChat();
	const { data: threads } = useThreads();
	const meta = threads?.find((t) => t.id === activeId);
	const attachments = useAttachments();
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [listOpen, setListOpen] = useState(false);
	const [rename, setRename] = useState(false);

	useEffect(() => {
		stick.current = true;
	}, [activeId]);

	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	});

	const items = thread?.items ?? [];
	const lastIsAssistant = items[items.length - 1]?.role === "assistant";

	return (
		<DropZone attachments={attachments} className="flex h-full min-h-0 flex-col">
			<div className={cn("flex items-center gap-2 border-b border-line px-3 py-2", variant === "screen" && "md:px-6 md:py-3")}>
				{variant === "screen" && (
					<Button variant="ghost" size="icon" className="h-9 w-9 md:hidden" onClick={() => setListOpen(true)} aria-label={t("pane.conversations")}>
						<ListTree />
					</Button>
				)}
				{variant === "dock" && (
					<Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setListOpen(true)} aria-label={t("pane.conversations")}>
						<ListTree />
					</Button>
				)}
				<div className="min-w-0 flex-1">
					<p className={cn("truncate", variant === "screen" ? "display text-lg md:text-xl" : "text-sm font-semibold")}>{activeId ? (meta?.name ?? t("pane.conversation")) : t("pane.newChat")}</p>
					{thread?.running && (
						<p className="flex items-center gap-1 text-[11px] text-primary">
							<Loader2 className="h-3 w-3 animate-spin" /> {t("pane.working")}
						</p>
					)}
				</div>
				{activeId && meta && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("pane.actions")}>
								<MoreHorizontal />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => setRename(true)}>
								<Pencil className="mr-2 h-4 w-4" /> {t("pane.rename")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				<Button variant="ghost" size="icon" className="h-8 w-8" onClick={newChat} title={t("pane.newChat")} aria-label={t("pane.newChat")}>
					<Plus />
				</Button>
				{onClose && (
					<Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label={t("pane.close")}>
						<X />
					</Button>
				)}
			</div>

			<div
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
				className="min-h-0 flex-1 overflow-y-auto"
			>
				{!activeId ? (
					<Welcome />
				) : thread?.loadError ? (
					<div className="p-4">
						<ErrorState error={thread.loadError} />
					</div>
				) : !thread?.loaded ? (
					<Loading />
				) : (
					<div className={cn("mx-auto w-full space-y-4 px-3 py-4", variant === "screen" && "max-w-3xl space-y-6 md:px-6")}>
						{items.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">{t("pane.noMessages")}</p>}
						{items.map((it, i) => (
							<MessageView key={i} item={it} threadId={activeId} live={!!thread.running && i === items.length - 1} />
						))}
						{thread.running && !thread.pending && (!lastIsAssistant || thread.thinking) && (
							<div className="flex items-center gap-1 pl-10 text-muted-foreground" aria-label={t("pane.thinking")}>
								<span className="typing-dot h-1.5 w-1.5 rounded-full bg-current" />
								<span className="typing-dot h-1.5 w-1.5 rounded-full bg-current [animation-delay:0.2s]" />
								<span className="typing-dot h-1.5 w-1.5 rounded-full bg-current [animation-delay:0.4s]" />
							</div>
						)}
					</div>
				)}
			</div>

			<div className={cn("space-y-2 px-3 pb-3 pt-1", variant === "screen" && "mx-auto w-full max-w-3xl md:px-6")}>
				{thread?.pending && <AskPanel ask={thread.pending} />}
				<Composer attachments={attachments} compact={variant === "dock"} />
			</div>

			<Dialog open={listOpen} onOpenChange={setListOpen}>
				<DialogContent className="surface-card flex h-[80vh] max-w-md flex-col rounded-xl px-0 pb-2">
					<DialogHeader className="px-4">
						<DialogTitle>{t("pane.conversations")}</DialogTitle>
					</DialogHeader>
					<ThreadList className="min-h-0 flex-1" onOpen={() => setListOpen(false)} />
				</DialogContent>
			</Dialog>
			{meta && <RenameThreadDialog thread={meta} open={rename} onOpenChange={setRename} />}
		</DropZone>
	);
}
