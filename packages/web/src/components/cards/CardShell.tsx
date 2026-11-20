import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function CardShell({ icon, title, children, className, actions }: { icon?: ReactNode; title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
	return (
		<div className={cn("surface-card rounded-xl p-3 md:p-4", className)}>
			{(title || actions) && (
				<div className="mb-2 flex items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-2 text-sm font-semibold [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-primary">
						{icon}
						<span className="truncate">{title}</span>
					</div>
					{actions}
				</div>
			)}
			{children}
		</div>
	);
}
