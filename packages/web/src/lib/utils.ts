import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import i18n, { intlLocale } from "./i18n";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number | null | undefined, decimals = 1): string {
	const sizes = ["B", "KB", "MB", "GB", "TB"] as const;
	if (!bytes || bytes <= 0) return `0 ${i18n.t("common:bytes.B")}`;
	const k = 1024;
	const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
	const n = new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: decimals }).format(bytes / k ** i);
	return `${n} ${i18n.t(`common:bytes.${sizes[i]!}`)}`;
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
	return i18n.t("common:bytes.perSecond", { size: formatBytes(bytesPerSecond ?? 0) });
}

export function formatEta(seconds: number | null | undefined): string {
	if (seconds == null || seconds < 0) return "∞";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (h > 24) return i18n.t("common:duration.days", { d: Math.floor(h / 24), h: h % 24 });
	if (h > 0) return i18n.t("common:duration.hours", { h, m });
	return i18n.t("common:duration.minutes", { m, s: Math.floor(seconds % 60) });
}

export function percent(progress: number | null | undefined): number {
	return Math.max(0, Math.min(100, Math.round((progress ?? 0) * 1000) / 10));
}

/** "3 min ago" style relative time for ISO strings, in the UI language. */
export function timeAgo(iso: string | null | undefined): string {
	if (!iso) return "";
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return iso;
	const s = Math.round((Date.now() - t) / 1000);
	if (s < 45) return i18n.t("common:justNow");
	const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto", style: "short" });
	if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
	if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
	if (s < 86400 * 7) return rtf.format(-Math.round(s / 86400), "day");
	return new Date(t).toLocaleDateString(intlLocale());
}

/** A number in the UI language (1 234,5 in French, 1 234,5 in Russian…). */
export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
	return new Intl.NumberFormat(intlLocale(), options).format(n);
}

export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" });
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
	return first.season === last.season ? `S${pad(first.season)}E${pad(first.episode)}–E${pad(last.episode)}` : i18n.t("common:episodes", { count: eps.length });
}

export function titleLabel(t: { name?: string | null; original_name?: string | null; year?: number | null }): string {
	return `${t.name ?? t.original_name ?? i18n.t("common:untitled")}${t.year ? ` (${t.year})` : ""}`;
}
