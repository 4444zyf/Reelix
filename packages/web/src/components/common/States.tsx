import { AlertCircle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

export function Spinner({ className }: { className?: string }) {
	return <Loader2 className={cn("h-4 w-4 animate-spin", className)} />;
}

export function Loading({ label }: { label?: string }) {
	const { t } = useTranslation();
	return (
		<div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
			<Spinner /> {label ?? t("loading")}
		</div>
	);
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
	const { t } = useTranslation();
	const msg = error instanceof Error ? error.message : String(error);
	return (
		<div className="rounded-xl bg-destructive/15 p-4 text-destructive-foreground">
			<div className="flex items-center gap-2 font-medium">
				<AlertCircle className="h-4 w-4" /> {msg}
			</div>
			{onRetry && (
				<button className="mt-2 text-sm underline underline-offset-4" onClick={onRetry}>
					{t("actions.retry")}
				</button>
			)}
		</div>
	);
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
			{icon && <div className="mb-1 opacity-60 [&_svg]:h-10 [&_svg]:w-10">{icon}</div>}
			<p className="text-lg">{title}</p>
			{children && <div className="max-w-md text-sm">{children}</div>}
		</div>
	);
}
