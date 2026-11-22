import { AlertTriangle, Bot, Image as ImageIcon, Info, Send as SendIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatItem } from "../../lib/chat";
import { cn } from "../../lib/utils";
import { ChatCard } from "../cards/ChatCard";
import { Markdown } from "../common/Markdown";
import { FailureNote, FallbackNote } from "../common/ModelFailure";
import { ToolLines } from "./ToolLine";

export function MessageView({ item, threadId, live }: { item: ChatItem; threadId: string; live: boolean }) {
	const { t } = useTranslation("chat");
	switch (item.role) {
		case "user":
			return (
				<div className="flex justify-end">
					<div className={cn("user-msg max-w-[85%]", item.local && "opacity-70")}>
						{item.from && item.from !== "web" && <p className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{t("message.from", { source: item.from })}</p>}
						<p className="user-text whitespace-pre-wrap break-words">{item.text}</p>
						{(item.images || item.queued) && (
							<p className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
								{item.images ? (
									<span className="inline-flex items-center gap-1">
										<ImageIcon className="h-3 w-3" /> {t("message.images", { count: item.images })}
									</span>
								) : null}
								{item.queued && (
									<span className="inline-flex items-center gap-1">
										<SendIcon className="h-3 w-3" /> {t("message.queued")}
									</span>
								)}
							</p>
						)}
					</div>
				</div>
			);
		case "answer":
			return (
				<div className="flex justify-end">
					<div className="max-w-[85%] rounded-control border border-primary/30 px-3.5 py-1.5 text-xs text-muted-foreground">{t("message.answered", { text: item.text })}</div>
				</div>
			);
		case "notice":
			return (
				item.failure ? (
					<div className="flex justify-center">
						<FailureNote failure={item.failure} className="max-w-[85%] rounded-md bg-destructive/20 px-2.5 py-1.5 text-destructive-foreground" />
					</div>
				) : (
					<div className={cn("flex items-center justify-center gap-1.5 text-xs", item.level === "error" ? "text-destructive-foreground" : "text-muted-foreground")}>
						{item.level === "error" ? <AlertTriangle className="h-3 w-3" /> : <Info className="h-3 w-3" />}
						<span>{item.text}</span>
					</div>
				)
			);
		case "assistant": {
			const cards = [...item.tools.filter((t) => t.card).map((t) => ({ key: t.id, card: t.card! })), ...item.cards.map((c, i) => ({ key: `c${i}`, card: c }))];
			return (
				<div className="flex gap-2.5">
					<div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
						<Bot className="h-4 w-4" />
					</div>
					<div className="min-w-0 flex-1 space-y-2">
						{item.fallback && <FallbackNote failure={item.fallback} to={item.model} />}
						<ToolLines tools={item.tools} live={live} />
						{cards.map(({ key, card }) => (
							<ChatCard key={key} card={card} threadId={threadId} />
						))}
						{item.text && <Markdown text={item.text} />}
						{item.failure ? (
							<FailureNote failure={item.failure} className="rounded-md bg-destructive/20 px-2.5 py-1.5 text-destructive-foreground" />
						) : item.error && (
							<p className="flex items-start gap-1.5 rounded-md bg-destructive/20 px-2.5 py-1.5 text-xs text-destructive-foreground">
								<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
								{item.error}
							</p>
						)}
					</div>
				</div>
			);
		}
	}
}
