import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number | null | undefined, decimals = 1): string {
	if (!bytes || bytes <= 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
	return `${parseFloat((bytes / k ** i).toFixed(decimals))} ${sizes[i]}`;
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
	return `${formatBytes(bytesPerSecond ?? 0)}/s`;
}

export function formatEta(seconds: number | null | undefined): string {
	if (seconds == null || seconds < 0 || seconds >= 8640000) return "∞";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m ${Math.floor(seconds % 60)}s`;
}

export function percent(progress: number | null | undefined): number {
	return Math.max(0, Math.min(100, Math.round((progress ?? 0) * 1000) / 10));
}

/** "3 min ago" style relative time for ISO strings. */
export function timeAgo(iso: string | null | undefined): string {
	if (!iso) return "";
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return iso;
	const s = Math.round((Date.now() - t) / 1000);
	if (s < 45) return "just now";
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} h ago`;
	if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
	return new Date(t).toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** TMDB posters go through the server (it fetches through the proxy and caches). */
export function posterUrl(path: string | null | undefined, size = "w342"): string | undefined {
	if (!path) return undefined;
	return `/api/poster?path=${encodeURIComponent(path)}&size=${size}`;
}

export function fileUrl(path: string): string {
	return `/api/files?path=${encodeURIComponent(path)}`;
}

export function newRequestId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `web_${crypto.randomUUID()}`;
	return `web_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export function episodeLabel(eps: { season: number; episode: number }[] | undefined): string {
	if (!eps?.length) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	if (eps.length === 1) return `S${pad(eps[0]!.season)}E${pad(eps[0]!.episode)}`;
	const first = eps[0]!;
	const last = eps[eps.length - 1]!;
	return first.season === last.season ? `S${pad(first.season)}E${pad(first.episode)}–E${pad(last.episode)}` : `${eps.length} episodes`;
}

export function titleLabel(t: { name?: string | null; original_name?: string | null; year?: number | null }): string {
	return `${t.name ?? t.original_name ?? "Untitled"}${t.year ? ` (${t.year})` : ""}`;
}
