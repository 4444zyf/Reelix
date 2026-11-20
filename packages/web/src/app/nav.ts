import { Activity, Download, Inbox, Library, MessageSquare, MonitorPlay, Settings, TrendingUp } from "lucide-react";
import type { ElementType } from "react";

export type NavKey = "chat" | "inbox" | "library" | "trends" | "downloads" | "activity" | "browser" | "settings";
/** `key` names the label in locales/<lang>/nav.json (items.<key>). */
export type NavItem = { key: NavKey; href: string; icon: ElementType; badge?: "inbox" };

export const NAV: NavItem[] = [
	{ key: "chat", href: "/chat", icon: MessageSquare },
	{ key: "inbox", href: "/inbox", icon: Inbox, badge: "inbox" },
	{ key: "library", href: "/library", icon: Library },
	{ key: "trends", href: "/trends", icon: TrendingUp },
	{ key: "downloads", href: "/downloads", icon: Download },
	{ key: "activity", href: "/activity", icon: Activity },
	{ key: "browser", href: "/browser", icon: MonitorPlay },
	{ key: "settings", href: "/settings", icon: Settings },
];

export function isActive(pathname: string, href: string): boolean {
	return pathname === href || pathname.startsWith(`${href}/`);
}
