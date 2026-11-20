import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Briefcase, CircleHelp, MessageSquare, MoreHorizontal, Pencil, Plus, Send } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { endpoints } from "../../lib/api";
import { useChat } from "../../lib/chat";
import type { Thread } from "../../lib/types";
import { cn, timeAgo } from "../../lib/utils";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Input } from "../ui/input";

export function useThreads() {
	return useQuery({ queryKey: ["threads"], queryFn: endpoints.threads, refetchInterval: 60_000 });
}

function KindIcon({ kind }: { kind: string }) {
	if (kind === "channel") return <Send className="h-3.5 w-3.5" />;
	if (kind === "job") return <Briefcase className="h-3.5 w-3.5" />;
	return <MessageSquare className="h-3.5 w-3.5" />;
}

export function RenameThreadDialog({ thread, open, onOpenChange }: { thread: Thread; open: boolean; onOpenChange: (o: boolean) => void }) {
	const { t } = useTranslation("chat");
	const qc = useQueryClient();
	const [name, setName] = useState(thread.name);
	return (
		<ConfirmDialog
			open={open}
			onOpenChange={(o) => {
				if (o) setName(thread.name);
				onOpenChange(o);
			}}
			title={t("threads.renameTitle")}
			confirmLabel={t("pane.rename")}
			disabled={!name.trim()}
			onConfirm={async () => {
				await endpoints.patchThread(thread.id, { name: name.trim() });
				await qc.invalidateQueries({ queryKey: ["threads"] });
			}}
		>
			<Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} />
		</ConfirmDialog>
	);
}

function ThreadRow({ t, active, onOpen }: { t: Thread; active: boolean; onOpen: () => void }) {
	const { t: tr } = useTranslation("chat");
	const qc = useQueryClient();
	const { activeId, newChat } = useChat();
	const [rename, setRename] = useState(false);
	return (
		<div className={cn("group flex items-center rounded-lg pr-1 transition-colors hover:bg-accent", active && "bg-accent")}>
			<button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left">
				<span className={cn("shrink-0 text-muted-foreground", active && "text-primary")}>
					<KindIcon kind={t.kind} />
				</span>
				<span className="min-w-0 flex-1">
					<span className={cn("block truncate text-sm", active ? "text-foreground" : "text-muted-foreground")}>{t.name}</span>
					<span className="block text-[11px] text-muted-foreground/70">{timeAgo(t.updated_at)}</span>
				</span>
				{t.pending_question && <CircleHelp className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={tr("threads.waiting")} />}
				{t.running && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" aria-label={tr("threads.running")} />}
			</button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label={tr("pane.actions")}>
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-40">
					<DropdownMenuItem onClick={() => setRename(true)}>
						<Pencil className="mr-2 h-4 w-4" /> {tr("pane.rename")}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={async () => {
							await endpoints.patchThread(t.id, { archived: true });
							if (activeId === t.id) newChat();
							qc.invalidateQueries({ queryKey: ["threads"] });
						}}
					>
						<Archive className="mr-2 h-4 w-4" /> {tr("threads.archive")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<RenameThreadDialog thread={t} open={rename} onOpenChange={setRename} />
		</div>
	);
}

export function ThreadList({ onOpen, className }: { onOpen?: (id: string | null) => void; className?: string }) {
	const { t } = useTranslation(["chat", "common"]);
	const { data, isLoading } = useThreads();
	const { activeId, setActive } = useChat();
	const open = (id: string | null) => {
		setActive(id);
		onOpen?.(id);
	};
	return (
		<div className={cn("flex min-h-0 flex-col", className)}>
			<Button variant="outline" size="sm" className="mx-2 mb-2 justify-start gap-2" onClick={() => open(null)}>
				<Plus /> {t("pane.newChat")}
			</Button>
			<div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
				{isLoading && <p className="px-3 py-2 text-xs text-muted-foreground">{t("common:loading")}</p>}
				{data?.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">{t("threads.empty")}</p>}
				{data?.map((t) => (
					<ThreadRow key={t.id} t={t} active={t.id === activeId} onOpen={() => open(t.id)} />
				))}
			</div>
		</div>
	);
}
