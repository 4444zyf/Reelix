import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, CornerDownLeft, Globe, Keyboard, MonitorPlay, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Badge } from "../components/common/Badge";
import { Screen } from "../components/common/Screen";
import { Empty, ErrorState, Loading, Spinner } from "../components/common/States";
import { toast } from "../components/hooks/use-toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { endpoints, useEventStream } from "../lib/api";
import { useChat } from "../lib/chat";
import { cn } from "../lib/utils";

/** The page's viewport in the server's browser (frames are scaled to fit it). */
const VIEW_W = 1280;
const VIEW_H = 860;

const SPECIAL_KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

function LiveView({ tab }: { tab: string }) {
	const { t } = useTranslation(["activity", "common"]);
	const [frame, setFrame] = useState<{ data: string; url: string }>();
	const [url, setUrl] = useState("");
	const [text, setText] = useState("");
	const [connected, setConnected] = useState(false);
	const imgRef = useRef<HTMLImageElement>(null);
	const editingUrl = useRef(false);

	useEventStream({
		url: () => `/api/plugins/browser/${encodeURIComponent(tab)}/stream`,
		event: "frame",
		key: tab,
		onOpen: () => setConnected(true),
		onMessage: (f: { data: string; url: string }) => {
			setFrame(f);
			if (!editingUrl.current) setUrl(f.url);
		},
	});
	useEffect(() => {
		setFrame(undefined);
		setConnected(false);
	}, [tab]);

	const send = (input: Record<string, unknown>) =>
		endpoints.browserInput(tab, input).catch((e) => toast({ title: t("browser.inputNotDelivered"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }));

	const onClick = (e: MouseEvent<HTMLImageElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		const x = Math.round(((e.clientX - r.left) / r.width) * VIEW_W);
		const y = Math.round(((e.clientY - r.top) / r.height) * VIEW_H);
		e.currentTarget.focus();
		void send({ type: "click", x, y });
	};
	const onWheel = (e: WheelEvent<HTMLImageElement>) => void send({ type: "scroll", dy: Math.round(e.deltaY) });
	const onKey = (e: KeyboardEvent<HTMLImageElement>) => {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (SPECIAL_KEYS.has(e.key)) {
			e.preventDefault();
			void send({ type: "key", key: e.key });
		} else if (e.key.length === 1) {
			e.preventDefault();
			void send({ type: "text", text: e.key });
		}
	};

	return (
		<div className="space-y-2">
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					editingUrl.current = false;
					if (url.trim()) void send({ type: "goto", url: url.trim() });
				}}
			>
				<Button type="button" variant="outline" size="icon" aria-label={t("common:actions.back")} onClick={() => send({ type: "back" })}>
					<ArrowLeft />
				</Button>
				<Input value={url} onFocus={() => (editingUrl.current = true)} onBlur={() => (editingUrl.current = false)} onChange={(e) => setUrl(e.target.value)} className="font-mono text-xs" />
				<Button type="submit" variant="outline">
					{t("browser.go")}
				</Button>
			</form>
			<div className="relative overflow-hidden rounded-lg border border-border bg-black" style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}>
				{frame ? (
					<img
						ref={imgRef}
						src={`data:image/jpeg;base64,${frame.data}`}
						alt={t("browser.liveViewAlt")}
						tabIndex={0}
						onClick={onClick}
						onWheel={onWheel}
						onKeyDown={onKey}
						draggable={false}
						className="h-full w-full cursor-pointer select-none object-contain outline-none focus:ring-2 focus:ring-primary"
					/>
				) : (
					<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
						<Spinner /> {connected ? t("browser.waitingFrame") : t("browser.connecting")}
					</div>
				)}
			</div>
			<p className="text-xs text-muted-foreground">{t("browser.hint")}</p>
			<div className="flex flex-wrap gap-2">
				<form
					className="flex min-w-0 flex-1 gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (!text) return;
						void send({ type: "text", text });
						setText("");
					}}
				>
					<Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("browser.typePlaceholder")} className="min-w-0" />
					<Button type="submit" variant="outline" disabled={!text}>
						<Keyboard /> {t("browser.type")}
					</Button>
				</form>
				<Button variant="outline" size="icon" aria-label={t("browser.enter")} onClick={() => send({ type: "key", key: "Enter" })}>
					<CornerDownLeft />
				</Button>
				<Button variant="outline" size="icon" aria-label={t("browser.scrollUp")} onClick={() => send({ type: "scroll", dy: -400 })}>
					<ArrowUp />
				</Button>
				<Button variant="outline" size="icon" aria-label={t("browser.scrollDown")} onClick={() => send({ type: "scroll", dy: 400 })}>
					<ArrowDown />
				</Button>
			</div>
		</div>
	);
}

/** Live view of the server's browser: watch and take over a page (verification, logins). */
export function BrowserScreen() {
	const { t } = useTranslation(["activity", "common"]);
	const [params, setParams] = useSearchParams();
	const { activeId } = useChat();
	const thread = params.get("thread") ?? activeId;
	const tabs = useQuery({ queryKey: ["browser-tabs"], queryFn: endpoints.browserTabs, refetchInterval: 5000, retry: false });
	const [openUrl, setOpenUrl] = useState("");
	const [opening, setOpening] = useState(false);
	const list = tabs.data ?? [];
	const selected = params.get("tab") ?? list.find((t) => t.owner === thread)?.id ?? list[0]?.id;

	const open = async () => {
		if (!openUrl.trim()) return;
		setOpening(true);
		try {
			const { id } = await endpoints.browserOpen(/^[a-z]+:\/\//i.test(openUrl) ? openUrl.trim() : `https://${openUrl.trim()}`);
			await tabs.refetch();
			setParams(new URLSearchParams({ tab: id }));
			setOpenUrl("");
		} catch (e) {
			toast({ title: t("browser.couldNotOpen"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setOpening(false);
		}
	};

	return (
		<Screen
			title={t("browser.title")}
			subtitle={t("browser.subtitle")}
			actions={(scrolled) => (
				<Button variant="outline" size={scrolled ? "sm" : "default"} onClick={() => tabs.refetch()}>
					<RefreshCw />
					<span className="hidden sm:inline">{t("common:actions.refresh")}</span>
				</Button>
			)}
		>
			<div className="max-w-6xl space-y-4">
				{tabs.isLoading ? (
					<Loading />
				) : tabs.error ? (
					<ErrorState error={tabs.error} onRetry={() => tabs.refetch()} />
				) : (
					<>
						<div className="flex flex-wrap items-center gap-2">
							{list.map((tb) => (
								<button
									key={tb.id}
									type="button"
									onClick={() => setParams(new URLSearchParams({ tab: tb.id }))}
									className={cn("flex max-w-xs items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-xs transition-colors", tb.id === selected ? "border-primary/60 bg-primary/10" : "border-border hover:bg-surface-hover")}
								>
									<Globe className="h-3.5 w-3.5 shrink-0" />
									<span className="min-w-0">
										<span className="block truncate">{tb.url || "about:blank"}</span>
										<span className="block text-muted-foreground">
											{tb.owner === "owner" ? t("browser.yours") : tb.owner === thread ? t("browser.thisConversation") : tb.owner}
											{tb.viewers ? ` · ${t("browser.watching", { count: tb.viewers })}` : ""}
										</span>
									</span>
									{tb.owner === thread && <Badge tone="primary">{t("browser.chat")}</Badge>}
								</button>
							))}
							<form
								className="flex gap-2"
								onSubmit={(e) => {
									e.preventDefault();
									void open();
								}}
							>
								<Input value={openUrl} onChange={(e) => setOpenUrl(e.target.value)} placeholder={t("browser.openPlaceholder")} className="h-9 w-56" />
								<Button type="submit" size="sm" className="h-9" disabled={opening || !openUrl.trim()}>
									{opening && <Spinner />}
									{t("common:actions.open")}
								</Button>
							</form>
						</div>
						{selected ? <LiveView key={selected} tab={selected} /> : <Empty icon={<MonitorPlay />} title={t("browser.noPages")}>{t("browser.noPagesHint")}</Empty>}
					</>
				)}
			</div>
		</Screen>
	);
}
