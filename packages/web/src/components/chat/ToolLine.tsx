import { Check, ChevronDown, X } from "lucide-react";
import { useState } from "react";
import type { ToolCall } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Spinner } from "../common/States";

/** One tool call as a short human line; tap to see what came back. */
export function ToolLine({ tool, live }: { tool: ToolCall; live?: boolean }) {
	const [open, setOpen] = useState(false);
	const running = live && !tool.done;
	return (
		<div className="text-xs">
			<button
				type="button"
				onClick={() => tool.summary && setOpen((o) => !o)}
				className={cn("flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-muted-foreground transition-colors", tool.summary && "hover:bg-white/5", tool.isError && "text-destructive-foreground")}
			>
				<span className="mt-0.5 shrink-0">
					{running ? <Spinner className="h-3 w-3" /> : tool.isError ? <X className="h-3 w-3" /> : <Check className="h-3 w-3 text-success" />}
				</span>
				<span className="min-w-0 flex-1 break-words">{tool.label || tool.name}</span>
				{tool.summary && <ChevronDown className={cn("mt-0.5 h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />}
			</button>
			{open && tool.summary && <p className={cn("ml-6 whitespace-pre-wrap break-words rounded-md bg-black/20 px-2 py-1 font-mono text-[11px] text-muted-foreground", tool.isError && "text-destructive-foreground")}>{tool.summary}</p>}
		</div>
	);
}

const VISIBLE = 4;

export function ToolLines({ tools, live }: { tools: ToolCall[]; live?: boolean }) {
	const [all, setAll] = useState(false);
	if (!tools.length) return null;
	const hidden = all ? 0 : Math.max(0, tools.length - VISIBLE);
	return (
		<div className="space-y-0.5 border-l border-white/10 pl-1">
			{hidden > 0 && (
				<button type="button" onClick={() => setAll(true)} className="px-1.5 py-1 text-xs text-primary hover:underline">
					{hidden} earlier step{hidden === 1 ? "" : "s"}
				</button>
			)}
			{tools.slice(hidden).map((t) => (
				<ToolLine key={t.id} tool={t} live={live} />
			))}
		</div>
	);
}
