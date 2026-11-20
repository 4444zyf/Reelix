import { MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router";
import { ChatPane } from "../components/chat/ChatPane";
import { Button } from "../components/ui/button";
import { useChat } from "../lib/chat";
import { cn } from "../lib/utils";
import { BottomNav } from "./BottomNav";
import { Sidebar, useStatus } from "./Sidebar";

const DESKTOP = "(min-width: 768px)";

function useIsDesktop() {
	const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP).matches);
	useEffect(() => {
		const mq = window.matchMedia(DESKTOP);
		const on = () => setDesktop(mq.matches);
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, []);
	return desktop;
}

/** Desktop: the chat as a dock beside any screen. */
function ChatDock() {
	const { dockOpen, setDockOpen, thread } = useChat();
	const { t } = useTranslation("nav");
	if (!dockOpen)
		return (
			<Button onClick={() => setDockOpen(true)} className="glow fixed bottom-6 right-6 z-40 h-12 gap-2 rounded-full px-5 shadow-xl" aria-label={t("openChat")}>
				<MessageSquare />
				{t("items.chat")}
				{thread?.running && <span className="h-2 w-2 animate-pulse rounded-full bg-primary-foreground" />}
				{thread?.pending && <span className="h-2 w-2 rounded-full bg-warning" />}
			</Button>
		);
	return (
		<aside className="panel fixed bottom-4 right-4 top-4 z-40 flex w-[min(460px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl shadow-[var(--panel-shadow)]">
			<ChatPane variant="dock" onClose={() => setDockOpen(false)} />
		</aside>
	);
}

/** `reelix plugin dev`: this Reelix is not the owner's, and its plugin skipped approval (docs/plugins.md §13.3). */
function DevBanner() {
	const { data: status } = useStatus();
	const { t } = useTranslation("nav");
	if (!status?.devPlugin) return null;
	return (
		<div role="status" data-testid="dev-banner" className="shrink-0 border-b border-warning/40 bg-warning/15 px-4 py-1.5 text-center text-xs font-medium text-warning">
			{t("devPlugin", { folder: status.devPlugin })}
		</div>
	);
}

export function Layout() {
	const [collapsed, setCollapsed] = useState(() => window.matchMedia("(max-width: 1100px)").matches);
	const desktop = useIsDesktop();
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const { registerOpener, setDockOpen } = useChat();
	const onChat = pathname === "/chat" || pathname.startsWith("/chat/");

	// "Ask about this": a dock on desktop, the Chat screen on a phone.
	useEffect(() => {
		registerOpener(() => {
			if (desktop && !onChat) setDockOpen(true);
			else if (!onChat) navigate("/chat");
		});
	}, [desktop, onChat, navigate, registerOpener, setDockOpen]);

	useEffect(() => {
		if (onChat) setDockOpen(false);
	}, [onChat, setDockOpen]);

	return (
		<div className="ambient flex h-dvh w-full overflow-hidden">
			<div className="hidden shrink-0 md:block">
				<Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
			</div>
			<div className={cn("flex min-h-0 min-w-0 flex-1 flex-col pb-16 md:pb-0")}>
				<DevBanner />
				<main className="min-h-0 flex-1 overflow-hidden">
					<Outlet />
				</main>
			</div>
			<BottomNav />
			{desktop && !onChat && <ChatDock />}
		</div>
	);
}
