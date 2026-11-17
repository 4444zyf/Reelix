import { HelpCircle, MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import { useChat } from "../../lib/chat";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/** "Ask about this": opens the chat with the item described in the composer (design §7.1). */
export function AskAbout({ text, label = "Ask about this", compact, className }: { text: string; label?: string; compact?: boolean; className?: string }) {
	const { askAbout } = useChat();
	return (
		<Button variant="ghost" size="sm" className={cn("h-8 px-2 text-muted-foreground hover:text-foreground", className)} title={label} onClick={() => askAbout(text)}>
			<MessageSquarePlus />
			{!compact && <span>{label}</span>}
		</Button>
	);
}

/** "Why?" where a reason was stored: expands in place (works on touch screens). */
export function Why({ reason, className }: { reason?: string | null; className?: string }) {
	const [open, setOpen] = useState(false);
	if (!reason) return null;
	return (
		<span className={cn("inline", className)}>
			<button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
				<HelpCircle className="h-3 w-3" />
				{open ? "Hide why" : "Why?"}
			</button>
			{open && <span className="mt-1 block rounded-md bg-white/5 px-2 py-1 text-xs text-muted-foreground">{reason}</span>}
		</span>
	);
}
