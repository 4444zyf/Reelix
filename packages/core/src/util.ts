import { randomBytes } from "node:crypto";

/** An error whose message is meant for a person (or the model) to read. */
export class ReelixError extends Error {
	code: string;
	detail?: unknown;
	constructor(code: string, message: string, detail?: unknown) {
		super(message);
		this.code = code;
		this.detail = detail;
	}
}

export function newId(prefix = ""): string {
	return prefix + randomBytes(6).toString("base64url");
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

export function humanBytes(n: number | undefined | null): string {
	if (n == null || !Number.isFinite(n)) return "?";
	const u = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < u.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export function errorMessage(e: unknown): string {
	if (e instanceof Error) {
		const cause = (e as { cause?: unknown }).cause;
		if (cause instanceof Error && cause.message && !e.message.includes(cause.message)) return `${e.message} (${cause.message})`;
		return e.message;
	}
	return String(e);
}

/** Strip characters Jellyfin (and Windows/SMB) cannot have in names. */
export function safeName(s: string): string {
	return s
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
		.replace(/\s+/g, " ")
		.replace(/[. ]+$/g, "")
		.trim();
}

export function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

export function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
