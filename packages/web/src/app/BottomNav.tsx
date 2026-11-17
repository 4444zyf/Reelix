import { Activity, Download, Inbox, Library, MessageSquare, MonitorPlay, MoreHorizontal, Search, Settings } from "lucide-react";
import { Link, useLocation } from "react-router";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { cn } from "../lib/utils";
import { isActive } from "./nav";
import { CountBadge, useStatus } from "./Sidebar";

const MAIN = [
	{ title: "Chat", href: "/chat", icon: MessageSquare },
	{ title: "Inbox", href: "/inbox", icon: Inbox, badge: true },
	{ title: "Library", href: "/library", icon: Library },
	{ title: "Downloads", href: "/downloads", icon: Download },
];

const MORE = [
	{ title: "Search", href: "/search", icon: Search },
	{ title: "Activity", href: "/activity", icon: Activity },
	{ title: "Browser", href: "/browser", icon: MonitorPlay },
	{ title: "Settings", href: "/settings", icon: Settings },
];

/** Phone navigation: leads with Chat and Inbox (design §7.1). */
export function BottomNav() {
	const { pathname } = useLocation();
	const { data: status } = useStatus();
	const moreActive = MORE.some((m) => isActive(pathname, m.href));
	const cls = (active: boolean) => cn("relative flex flex-1 flex-col items-center justify-center gap-1 rounded-md px-2 py-2 text-xs font-medium transition-colors", active ? "text-primary" : "text-muted-foreground");
	return (
		<div className="pb-safe fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
			<nav className="flex h-16 items-center justify-around px-1">
				{MAIN.map((item) => (
					<Link key={item.href} to={item.href} className={cls(isActive(pathname, item.href))}>
						<item.icon className="h-5 w-5" />
						<span>{item.title}</span>
						{item.badge && <CountBadge n={status?.inbox} className="absolute right-[18%] top-0.5 min-w-4 px-1 text-[10px] leading-4" />}
					</Link>
				))}
				<DropdownMenu>
					<DropdownMenuTrigger className={cls(moreActive)}>
						<MoreHorizontal className="h-5 w-5" />
						<span>More</span>
					</DropdownMenuTrigger>
					<DropdownMenuContent side="top" align="end" className="w-44">
						{MORE.map((m) => (
							<DropdownMenuItem key={m.href} asChild>
								<Link to={m.href} className="cursor-pointer">
									<m.icon className="mr-2 h-4 w-4" />
									{m.title}
								</Link>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			</nav>
		</div>
	);
}
