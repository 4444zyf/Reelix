import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * A screen with a sticky header that shrinks on scroll (the MovieCopilot look), written once
 * instead of copied into every page.
 */
export function Screen({
	title,
	subtitle,
	actions,
	toolbar,
	children,
	className,
	back,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	actions?: (scrolled: boolean) => ReactNode;
	toolbar?: ReactNode;
	children: ReactNode;
	className?: string;
	back?: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [scrolled, setScrolled] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const on = () => setScrolled(el.scrollTop > 20);
		el.addEventListener("scroll", on, { passive: true });
		return () => el.removeEventListener("scroll", on);
	}, []);
	return (
		<div ref={ref} className="h-full overflow-y-auto">
			<div className={cn("sticky top-0 z-20 transition-all duration-300 px-4 md:px-6", scrolled ? "bg-background/85 backdrop-blur-md py-3 border-b border-line" : "py-4 md:py-6")}>
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2">
						{back}
						<div className="min-w-0">
							<h1 className={cn("display truncate transition-all duration-300", scrolled ? "text-xl" : "text-3xl md:text-4xl")}>{title}</h1>
							{subtitle && <div className={cn("overflow-hidden text-muted-foreground transition-all duration-300", scrolled ? "h-0 opacity-0" : "h-auto opacity-100")}>{subtitle}</div>}
						</div>
					</div>
					{actions && <div className="flex shrink-0 items-center gap-2">{actions(scrolled)}</div>}
				</div>
				{toolbar && <div className={cn("transition-all duration-300", scrolled ? "mt-2" : "mt-4")}>{toolbar}</div>}
			</div>
			<div className={cn("px-4 pb-6 md:px-6", className)}>{children}</div>
		</div>
	);
}
