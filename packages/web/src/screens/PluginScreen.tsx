import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { Screen } from "../components/common/Screen";
import { ErrorState, Spinner } from "../components/common/States";
import { ApiError, endpoints } from "../lib/api";
import { findTheme, useTheme } from "../lib/theme";

/** The theme tokens a plugin's screen receives, as CSS variables of the same names (docs/ui-themes.md). */
const TOKENS = ["bg", "fg", "card", "popover", "popover-fg", "primary", "primary-fg", "secondary", "secondary-fg", "muted", "muted-fg", "accent", "accent-fg", "destructive", "destructive-fg", "border", "input", "ring", "success", "warning", "info", "surface", "surface-hover", "line", "well", "radius", "ui-font", "mono-font"];

/** The bridge to one document of the frame: the port it was given, and how often the frame has loaded. */
type Bridge = { port?: MessagePort; loads: number; closed: boolean };

/**
 * A plugin's own screen (docs/plugins.md §16, phase 8). Its document runs in a frame sandboxed to scripts
 * only: no origin of its own, so no cookies and no calls to /api with the owner's session, no forms, no
 * pop-ups, no navigating this page. It talks to Reelix only through a message port this page hands to the
 * frame's first document when it says `ready`, before the frame has finished loading; this page runs the
 * plugin's own operations for it, as the plugin, and sends it the language and the theme. If the frame
 * loads again (it navigated somewhere), the port is closed: the new document never gets one.
 */
export function PluginScreen() {
	const { id = "" } = useParams();
	const { t, i18n } = useTranslation("nav");
	const theme = useTheme();
	const frame = useRef<HTMLIFrameElement | null>(null);
	const bridge = useRef<Bridge>({ loads: 0, closed: false });
	const { data, dataUpdatedAt, error, isLoading, refetch } = useQuery({ queryKey: ["plugin-screen", id, i18n.language], queryFn: () => endpoints.pluginScreen(id, i18n.language) });

	const context = useCallback(() => {
		const style = getComputedStyle(document.documentElement);
		const tokens = Object.fromEntries(TOKENS.flatMap((n) => (style.getPropertyValue(`--${n}`).trim() ? [[`--${n}`, style.getPropertyValue(`--${n}`).trim()]] : [])));
		return { reelix: 1, type: "context", lang: i18n.language, theme: tokens, scheme: findTheme(theme.active)?.scheme ?? "dark" };
	}, [i18n.language, theme.active]);

	// A new frame element (a new document from the server) starts with a new bridge.
	const mount = useCallback((el: HTMLIFrameElement | null) => {
		bridge.current.port?.close();
		bridge.current = { loads: 0, closed: false };
		frame.current = el;
	}, []);

	const loaded = useCallback(() => {
		const b = bridge.current;
		if (++b.loads > 1) {
			b.port?.close();
			b.port = undefined;
			b.closed = true;
		}
	}, []);

	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			const win = frame.current?.contentWindow;
			const b = bridge.current;
			// Only the first document of this screen's frame, sandboxed (origin "null"), and only once, before it has loaded.
			if (!win || e.source !== win || e.origin !== "null" || b.port || b.closed || b.loads > 0) return;
			const m = e.data as { reelix?: unknown; type?: unknown } | null;
			if (!m || m.reelix !== 1 || m.type !== "ready") return;
			const { port1, port2 } = new MessageChannel();
			b.port = port1;
			port1.onmessage = async (ev: MessageEvent) => {
				const r = ev.data as { reelix?: unknown; type?: unknown; id?: unknown; operation?: unknown; input?: unknown } | null;
				if (!r || r.reelix !== 1 || r.type !== "run" || typeof r.id !== "number") return;
				try {
					const out = await endpoints.runScreenOperation(id, String(r.operation), r.input ?? {});
					if (b.port === port1) port1.postMessage({ reelix: 1, type: "result", id: r.id, output: out.output, text: out.text });
				} catch (err) {
					if (b.port === port1) port1.postMessage({ reelix: 1, type: "error", id: r.id, message: err instanceof Error ? err.message : String(err), code: err instanceof ApiError ? err.code : undefined });
				}
			};
			win.postMessage({ reelix: 1, type: "connect" }, "*", [port2]);
			port1.postMessage(context());
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [id, context]);

	// The theme or the language changed: the screen follows.
	useEffect(() => {
		bridge.current.port?.postMessage(context());
	}, [context]);

	return (
		<Screen title={data?.title ?? id} subtitle={id}>
			<div className="px-4 pb-6 md:px-6">
				{isLoading ? (
					<Spinner />
				) : error || !data ? (
					<ErrorState error={error ?? new Error(t("screenFailed", { id }))} onRetry={() => refetch()} />
				) : (
					<iframe key={dataUpdatedAt} ref={mount} onLoad={loaded} title={t("screenTitle", { title: data.title, id })} sandbox="allow-scripts" srcDoc={data.html} referrerPolicy="no-referrer" className="h-[calc(100vh-11rem)] w-full rounded-lg border border-border bg-background" data-testid="plugin-screen" />
				)}
			</div>
		</Screen>
	);
}
