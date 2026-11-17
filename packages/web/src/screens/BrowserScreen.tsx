import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, CornerDownLeft, Globe, Keyboard, MonitorPlay, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
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
	const [frame, setFrame] = useState<{ data: string; url: string }>();
	const [url, setUrl] = useState("");
	const [text, setText] = useState("");
	const [connected, setConnected] = useState(false);
	const imgRef = useRef<HTMLImageElement>(null);
	const editingUrl = useRef(false);

	useEventStream({
		url: () => `/api/browser/${encodeURIComponent(tab)}/stream`,
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
		endpoints.browserInput(tab, input).catch((e) => toast({ title: "Input not delivered", description: e instanceof Error ? e.message : String(e), variant: "destructive" }));

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
				<Button type="button" variant="outline" size="icon" aria-label="Back" onClick={() => send({ type: "back" })}>
					<ArrowLeft />
				</Button>
				<Input value={url} onFocus={() => (editingUrl.current = true)} onBlur={() => (editingUrl.current = false)} onChange={(e) => setUrl(e.target.value)} className="font-mono text-xs" />
				<Button type="submit" variant="outline">
					Go
				</Button>
			</form>
			<div className="relative overflow-hidden rounded-lg border border-white/10 bg-black" style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}>
				{frame ? (
					<img
						ref={imgRef}
						src={`data:image/jpeg;base64,${frame.data}`}
						alt="Live view of the server's browser"
						tabIndex={0}
						onClick={onClick}
						onWheel={onWheel}
						onKeyDown={onKey}
						draggable={false}
						className="h-full w-full cursor-pointer select-none object-contain outline-none focus:ring-2 focus:ring-primary"
					/>
				) : (
					<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
						<Spinner /> {connected ? "Waiting for the first frame…" : "Connecting…"}
					</div>
				)}
			</div>
			<p className="text-xs text-muted-foreground">Click the picture to click the page; scroll over it to scroll. With the picture focused, typing goes to the page.</p>
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
					<Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type into the focused field" className="min-w-0" />
					<Button type="submit" variant="outline" disabled={!text}>
						<Keyboard /> Type
					</Button>
				</form>
				<Button variant="outline" size="icon" aria-label="Enter" onClick={() => send({ type: "key", key: "Enter" })}>
					<CornerDownLeft />
				</Button>
				<Button variant="outline" size="icon" aria-label="Scroll up" onClick={() => send({ type: "scroll", dy: -400 })}>
					<ArrowUp />
				</Button>
				<Button variant="outline" size="icon" aria-label="Scroll down" onClick={() => send({ type: "scroll", dy: 400 })}>
					<ArrowDown />
				</Button>
			</div>
		</div>
	);
}

/** Live view of the server's browser: watch and take over a page (verification, logins). */
export function BrowserScreen() {
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
			toast({ title: "Could not open", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setOpening(false);
		}
	};

	return (
		<Screen
			title="Browser"
			subtitle="The browser Reelix uses for sites without an API; take over when a check needs your clicks"
			actions={(scrolled) => (
				<Button variant="outline" size={scrolled ? "sm" : "default"} onClick={() => tabs.refetch()}>
					<RefreshCw />
					<span className="hidden sm:inline">Refresh</span>
				</Button>
			)}
		>
			<div className="mx-auto max-w-6xl space-y-4">
				{tabs.isLoading ? (
					<Loading />
				) : tabs.error ? (
					<ErrorState error={tabs.error} onRetry={() => tabs.refetch()} />
				) : (
					<>
						<div className="flex flex-wrap items-center gap-2">
							{list.map((t) => (
								<button
									key={t.id}
									type="button"
									onClick={() => setParams(new URLSearchParams({ tab: t.id }))}
									className={cn("flex max-w-xs items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-xs transition-colors", t.id === selected ? "border-primary/60 bg-primary/10" : "border-white/10 hover:bg-white/5")}
								>
									<Globe className="h-3.5 w-3.5 shrink-0" />
									<span className="min-w-0">
										<span className="block truncate">{t.url || "about:blank"}</span>
										<span className="block text-muted-foreground">
											{t.owner === "owner" ? "yours" : t.owner === thread ? "this conversation" : t.owner}
											{t.viewers ? ` · ${t.viewers} watching` : ""}
										</span>
									</span>
									{t.owner === thread && <Badge tone="primary">chat</Badge>}
								</button>
							))}
							<form
								className="flex gap-2"
								onSubmit={(e) => {
									e.preventDefault();
									void open();
								}}
							>
								<Input value={openUrl} onChange={(e) => setOpenUrl(e.target.value)} placeholder="Open a page…" className="h-9 w-56" />
								<Button type="submit" size="sm" className="h-9" disabled={opening || !openUrl.trim()}>
									{opening && <Spinner />}
									Open
								</Button>
							</form>
						</div>
						{selected ? <LiveView key={selected} tab={selected} /> : <Empty icon={<MonitorPlay />} title="No open pages">When the agent uses the browser, its page appears here.</Empty>}
					</>
				)}
			</div>
		</Screen>
	);
}
