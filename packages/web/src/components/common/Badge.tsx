import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

export type Tone = "default" | "primary" | "success" | "warning" | "danger" | "info" | "muted";

const tones: Record<Tone, string> = {
	default: "bg-surface-hover text-foreground",
	primary: "bg-primary/20 text-primary",
	success: "bg-success/15 text-success",
	warning: "bg-warning/15 text-warning",
	danger: "bg-destructive/30 text-destructive-foreground",
	info: "bg-info/15 text-info",
	muted: "bg-muted text-muted-foreground",
};

export function Badge({ tone = "default", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
	return (
		<span title={title} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium leading-none", tones[tone], className)}>
			{children}
		</span>
	);
}

const stateTones: Record<string, Tone> = {
	downloading: "primary",
	added: "primary",
	complete: "info",
	filed: "success",
	needs_agent: "warning",
	stalled: "warning",
	gone: "danger",
	removed: "muted",
	paused: "muted",
	succeeded: "success",
	failed: "danger",
	pending: "warning",
	unknown: "warning",
	queued: "muted",
	running: "primary",
	parked: "warning",
	interrupted: "warning",
	open: "primary",
	answered: "success",
	dismissed: "muted",
};

export function StateBadge({ state, className }: { state: string; className?: string }) {
	const { t } = useTranslation();
	return (
		<Badge tone={stateTones[state] ?? "default"} className={className}>
			{t(`state.${state}` as "state.open", { defaultValue: state.replace(/_/g, " ") })}
		</Badge>
	);
}
