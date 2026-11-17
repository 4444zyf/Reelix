import { Activity, Download, Inbox, Library, MessageSquare, MonitorPlay, Search, Settings } from "lucide-react";
import type { ElementType } from "react";

export type NavItem = { title: string; href: string; icon: ElementType; badge?: "inbox" };

export const NAV: NavItem[] = [
	{ title: "Chat", href: "/chat", icon: MessageSquare },
	{ title: "Inbox", href: "/inbox", icon: Inbox, badge: "inbox" },
	{ title: "Library", href: "/library", icon: Library },
	{ title: "Search", href: "/search", icon: Search },
	{ title: "Downloads", href: "/downloads", icon: Download },
	{ title: "Activity", href: "/activity", icon: Activity },
	{ title: "Browser", href: "/browser", icon: MonitorPlay },
	{ title: "Settings", href: "/settings", icon: Settings },
];

export function isActive(pathname: string, href: string): boolean {
	return pathname === href || pathname.startsWith(`${href}/`);
}
