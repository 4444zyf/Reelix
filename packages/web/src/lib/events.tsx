import { useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { toast } from "../components/hooks/use-toast";
import { useEventStream } from "./api";
import type { AppEvent, Download } from "./types";

// ------------------------------------------------------------------ live download progress

type Live = { state: string; progress?: number; at: number };
const live = new Map<string, Live>();
const listeners = new Set<() => void>();
let version = 0;

function setLive(hash: string, v: Omit<Live, "at">) {
	live.set(hash, { ...live.get(hash), ...v, at: Date.now() });
	version++;
	for (const l of listeners) l();
}

function subscribe(l: () => void) {
	listeners.add(l);
	return () => listeners.delete(l);
}

/** The latest state/progress the event stream reported for a download, if any. */
export function useLiveDownload(hash: string | undefined): Live | undefined {
	useSyncExternalStore(subscribe, () => version);
	return hash ? live.get(hash) : undefined;
}

/** Merge what the event stream reported over a fetched row. */
export function withLive(d: Download, l: Live | undefined): Download {
	if (!l) return d;
	return { ...d, state: l.state ?? d.state, progress: l.progress ?? d.live?.progress ?? d.progress };
}

// ------------------------------------------------------------------ the app-wide stream

/** Listens to `GET /api/events` and keeps TanStack Query caches fresh. Mounted once. */
export function AppEvents({ onThreadEvent }: { onThreadEvent?: (e: Extract<AppEvent, { type: "thread" }>) => void }) {
	const qc = useQueryClient();
	useEventStream({
		url: () => "/api/events",
		event: "app",
		onOpen: () => {
			// After a reconnect anything may have changed.
			qc.invalidateQueries({ queryKey: ["status"] });
		},
		onMessage: (e: AppEvent) => {
			switch (e.type) {
				case "download": {
					const prev = live.get(e.hash);
					setLive(e.hash, { state: e.state, progress: e.progress });
					if (!prev || prev.state !== e.state) {
						qc.invalidateQueries({ queryKey: ["downloads"] });
						qc.invalidateQueries({ queryKey: ["download", e.hash] });
						qc.invalidateQueries({ queryKey: ["title"] });
						if (e.state === "filed") qc.invalidateQueries({ queryKey: ["library"] });
					}
					break;
				}
				case "inbox":
					qc.invalidateQueries({ queryKey: ["inbox"] });
					qc.invalidateQueries({ queryKey: ["status"] });
					break;
				case "action":
					qc.invalidateQueries({ queryKey: ["activity"] });
					break;
				case "job":
					qc.invalidateQueries({ queryKey: ["jobs"] });
					qc.invalidateQueries({ queryKey: ["status"] });
					break;
				case "config":
					qc.invalidateQueries({ queryKey: ["config"] });
					qc.invalidateQueries({ queryKey: ["status"] });
					qc.invalidateQueries({ queryKey: ["secrets"] });
					break;
				case "notice":
					toast({ title: e.level === "error" ? "Problem" : "Notice", description: e.text, variant: e.level === "error" ? "destructive" : "default" });
					break;
				case "thread":
					qc.invalidateQueries({ queryKey: ["threads"] });
					onThreadEvent?.(e);
					break;
			}
		},
	});
	return null;
}
