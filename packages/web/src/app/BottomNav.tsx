import { Activity, Download, Inbox, LayoutPanelLeft, Library, MessageSquare, MonitorPlay, MoreHorizontal, Settings, TrendingUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { cn } from "../lib/utils";
import { isActive } from "./nav";
import { CountBadge, usePluginScreens, useStatus } from "./Sidebar";

const MAIN = [
	{ key: "chat" as const, href: "/chat", icon: MessageSquare },
	{ key: "inbox" as const, href: "/inbox", icon: Inbox, badge: true },
	{ key: "library" as const, href: "/library", icon: Library },
	{ key: "downloads" as const, href: "/downloads", icon: Download },
];

const MORE = [
	{ key: "trends" as const, href: "/trends", icon: TrendingUp },
	{ key: "activity" as const, href: "/activity", icon: Activity },
	{ key: "browser" as const, href: "/browser", icon: MonitorPlay },
	{ key: "settings" as const, href: "/settings", icon: Settings },
];

/** Phone navigation: leads with Chat and Inbox (design §7.1). */
export function BottomNav() {
	const { t } = useTranslation("nav");
	const { pathname } = useLocation();
	const { data: status } = useStatus();
	const screens = usePluginScreens();
	const moreActive = [...MORE, ...screens].some((m) => isActive(pathname, m.href));
	const cls = (active: boolean) => cn("relative flex flex-1 flex-col items-center justify-center gap-1 rounded-md px-2 py-2 text-xs font-medium transition-colors", active ? "text-primary" : "text-muted-foreground");
	return (
		<div className="pb-safe fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
			<nav className="flex h-16 items-center justify-around px-1">
				{MAIN.map((item) => (
					<Link key={item.href} to={item.href} className={cls(isActive(pathname, item.href))}>
						<item.icon className="h-5 w-5" />
						<span>{t(`items.${item.key}`)}</span>
						{item.badge && <CountBadge n={status?.inbox} className="absolute right-[18%] top-0.5 min-w-4 px-1 text-[10px] leading-4" />}
					</Link>
				))}
				<DropdownMenu>
					<DropdownMenuTrigger className={cls(moreActive)}>
						<MoreHorizontal className="h-5 w-5" />
						<span>{t("more")}</span>
					</DropdownMenuTrigger>
					<DropdownMenuContent side="top" align="end" className="w-44">
						{MORE.map((m) => (
							<DropdownMenuItem key={m.href} asChild>
								<Link to={m.href} className="cursor-pointer">
									<m.icon className="mr-2 h-4 w-4" />
									{t(`items.${m.key}`)}
								</Link>
							</DropdownMenuItem>
						))}
						{screens.length > 0 && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuLabel className="text-xs text-muted-foreground">{t("plugins")}</DropdownMenuLabel>
								{screens.map((s) => (
									<DropdownMenuItem key={s.href} asChild>
										<Link to={s.href} className="cursor-pointer">
											<LayoutPanelLeft className="mr-2 h-4 w-4" />
											{s.title}
										</Link>
									</DropdownMenuItem>
								))}
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</nav>
		</div>
	);
}
