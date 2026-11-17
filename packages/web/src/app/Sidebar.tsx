import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, LogOut, Menu, Settings, User } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
import { ThreadList } from "../components/chat/ThreadList";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { endpoints } from "../lib/api";
import { cn } from "../lib/utils";
import { NAV, isActive } from "./nav";

export function useStatus() {
	return useQuery({ queryKey: ["status"], queryFn: endpoints.status, refetchInterval: 60_000 });
}

export function CountBadge({ n, className }: { n?: number; className?: string }) {
	if (!n) return null;
	return <span className={cn("inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-5 text-primary-foreground", className)}>{n > 99 ? "99+" : n}</span>;
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { data: status } = useStatus();
	const logout = async () => {
		await endpoints.logout().catch(() => undefined);
		qc.clear();
		window.location.href = "/";
	};
	return (
		<div className={cn("glass relative flex h-full flex-col border-r-0 transition-all duration-300", collapsed ? "w-16" : "w-64")}>
			<div className="flex h-16 shrink-0 items-center justify-between px-4">
				{!collapsed && <span className="text-xl font-bold tracking-tight text-white drop-shadow-md">Reelix</span>}
				<Button variant="ghost" size="icon" onClick={onToggle} className={cn("ml-auto", collapsed && "mx-auto")} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
					{collapsed ? <Menu className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
				</Button>
			</div>

			<nav className="grid shrink-0 gap-1 px-2 py-2">
				{NAV.map((item) => {
					const active = isActive(pathname, item.href);
					const count = item.badge === "inbox" ? status?.inbox : undefined;
					return (
						<Link
							key={item.href}
							to={item.href}
							className={cn(
								"relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
								active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
								collapsed && "justify-center px-2",
							)}
							title={collapsed ? item.title : undefined}
						>
							<item.icon className="h-4 w-4" />
							{!collapsed && <span className="flex-1">{item.title}</span>}
							{!collapsed && <CountBadge n={count} />}
							{collapsed && count ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" /> : null}
						</Link>
					);
				})}
			</nav>

			{!collapsed ? (
				<div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-white/10 pt-3">
					<p className="px-4 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Conversations</p>
					<ThreadList className="min-h-0 flex-1" onOpen={(id) => navigate(id ? `/chat/${encodeURIComponent(id)}` : "/chat")} />
				</div>
			) : (
				<div className="flex-1" />
			)}

			<div className="shrink-0 border-t border-white/10 p-2">
				{status?.spend.reached && !collapsed && <p className="mb-2 rounded-md bg-warning/15 px-2 py-1 text-[11px] text-warning">Background spending cap reached for today.</p>}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" className={cn("w-full justify-start gap-3 text-muted-foreground hover:bg-accent hover:text-foreground", collapsed && "justify-center px-2")}>
							<span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-primary">
								<User className="h-4 w-4" />
							</span>
							{!collapsed && <span>Owner</span>}
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent side="top" align={collapsed ? "center" : "start"} className="w-48">
						<DropdownMenuLabel>Reelix {status?.version ?? ""}</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuItem asChild>
							<Link to="/settings" className="cursor-pointer">
								<Settings className="mr-2 h-4 w-4" />
								Settings
							</Link>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={logout} className="text-destructive-foreground focus:text-destructive-foreground">
							<LogOut className="mr-2 h-4 w-4" />
							Sign out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}
