import { useEffect, useRef } from "react";
import type {
	AdoptScan,
	BrowserTab,
	FollowRow,
	PlacedSubtitle,
	Skill,
	SubtitleSearch,
	DoctorCheck,
	Download,
	InboxItem,
	Job,
	JobRun,
	LedgerRow,
	LibraryList,
	ReleaseSearch,
	SecretInfo,
	Session,
	Status,
	Thread,
	ThreadDetail,
	TitleFind,
	TitleShow,
} from "./types";
import { newRequestId } from "./utils";

export class ApiError extends Error {
	status: number;
	code?: string;
	constructor(status: number, message: string, code?: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** Fired when the server says the session is gone; the app shows the sign-in screen. */
export const UNAUTHORIZED_EVENT = "reelix:unauthorized";

/**
 * Typed fetch for `/api/*`. The session lives in an HttpOnly cookie that the browser sends by
 * itself; nothing about it is ever kept in browser storage.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
	const headers: Record<string, string> = { accept: "application/json", ...init.headers };
	let body: BodyInit | undefined;
	if (init.body instanceof FormData) body = init.body;
	else if (init.body !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(init.body);
	}
	const res = await fetch(path, { method: init.method ?? (body ? "POST" : "GET"), headers, body, credentials: "same-origin", signal: init.signal });
	const text = await res.text();
	let data: any = undefined;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = text;
		}
	}
	if (!res.ok) {
		if (res.status === 401 && !path.startsWith("/api/login") && !path.startsWith("/api/password")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
		const message = (data && typeof data === "object" && data.error) || (typeof data === "string" && data) || `${res.status} ${res.statusText}`;
		throw new ApiError(res.status, String(message), data?.code);
	}
	return data as T;
}

export type OpResult<T> = { output: T; text: string; actionId?: number | string; repeated?: boolean };

/** Run an operation from the registry. One request id per click: a resend returns the first result. */
export async function runOp<T = unknown>(name: string, input: object = {}, requestId = newRequestId()): Promise<OpResult<T>> {
	return api<OpResult<T>>(`/api/op/${encodeURIComponent(name)}`, { method: "POST", body: input, headers: { "x-request-id": requestId } });
}

export async function op<T = unknown>(name: string, input: object = {}): Promise<T> {
	return (await runOp<T>(name, input)).output;
}

// ------------------------------------------------------------------ endpoints

export const endpoints = {
	session: () => api<Session>("/api/session"),
	setupPassword: (password: string) => api<{ ok: true }>("/api/setup-password", { body: { password } }),
	login: (password: string) => api<{ ok: true }>("/api/login", { body: { password } }),
	logout: () => api<{ ok: true }>("/api/logout", { method: "POST" }),
	changePassword: (current: string, password: string) => api<{ ok: true }>("/api/password", { body: { current, password } }),
	status: () => api<Status>("/api/status"),

	threads: () => api<Thread[]>("/api/threads"),
	createThread: (name?: string) => api<Thread>("/api/threads", { body: { name } }),
	patchThread: (id: string, patch: { name?: string; archived?: boolean }) => api<Thread>(`/api/threads/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
	thread: (id: string) => api<ThreadDetail>(`/api/threads/${encodeURIComponent(id)}`),
	sendMessage: (id: string, text: string, images?: { data: string; mimeType: string }[]) =>
		api<{ runId?: string; queued?: boolean; answered?: boolean }>(`/api/threads/${encodeURIComponent(id)}/messages`, { body: { text, images: images?.length ? images : undefined } }),
	answer: (id: string, questionId: string, value: string) => api<{ ok: true }>(`/api/threads/${encodeURIComponent(id)}/answer`, { body: { questionId, value } }),
	abort: (id: string) => api<{ ok: true }>(`/api/threads/${encodeURIComponent(id)}/abort`, { method: "POST" }),

	inbox: (status = "open") => api<InboxItem[]>(`/api/inbox?status=${encodeURIComponent(status)}`),
	answerInbox: (id: string, answer: string) => api<InboxItem>(`/api/inbox/${encodeURIComponent(id)}/answer`, { body: { answer } }),
	dismissInbox: (id: string) => api<{ ok: true }>(`/api/inbox/${encodeURIComponent(id)}/dismiss`, { method: "POST" }),
	continueInbox: (id: string) => api<Thread>(`/api/inbox/${encodeURIComponent(id)}/continue`, { method: "POST" }),

	jobs: () => api<{ jobs: Job[]; runs: JobRun[] }>("/api/jobs"),
	runJob: (id: string) => api<{ id: string }>(`/api/jobs/${encodeURIComponent(id)}/run`, { method: "POST" }),
	telegramLink: () => api<{ code: string }>("/api/telegram/link", { method: "POST" }),

	upload: (file: File) => {
		const form = new FormData();
		form.append("file", file);
		return api<{ path: string; name: string; size: number; type: string }>("/api/upload", { method: "POST", body: form });
	},

	// operations used by the screens
	libraryList: () => op<LibraryList>("library.list"),
	titleShow: (id: string) => op<TitleShow>("title.show", { id }),
	titleFind: (input: { query?: string; id?: string; kind?: string; year?: number }) => op<TitleFind>("title.find", input),
	releaseSearch: (input: { title_id?: string; query?: string; season?: number; episode?: number; sort?: string; limit?: number }) => op<ReleaseSearch>("release.search", input),
	downloads: (all = false) => op<Download[]>("download.status", all ? { all: true } : {}),
	download: (hash: string) => op<Download[]>("download.status", { hash }),
	activity: (input: { limit?: number; title_id?: string; status?: string } = {}) => op<LedgerRow[]>("activity", input),
	doctor: (quick = false) => op<DoctorCheck[]>("doctor", { quick }),
	secrets: () => op<SecretInfo[]>("secret.list"),
	config: () => op<{ summary: string; config: Record<string, any>; warning?: string }>("config.show"),

	subtitleSearch: (title_id: string, season?: number) => op<SubtitleSearch>("subtitle.search", { title_id, season }),
	subtitleList: (title_id: string) => op<PlacedSubtitle[]>("subtitle.list", { title_id }),
	follows: (all = true) => op<FollowRow[]>("follow.list", { all }),
	adoptShow: () => op<AdoptScan>("adopt.show"),
	skills: () => op<Skill[]>("skills.list"),

	browserTabs: () => api<BrowserTab[]>("/api/browser/tabs"),
	browserOpen: (url: string) => api<{ id: string }>("/api/browser/open", { body: { url } }),
	browserInput: (tab: string, input: Record<string, unknown>) => api<unknown>(`/api/browser/${encodeURIComponent(tab)}/input`, { body: input }),
};

// ------------------------------------------------------------------ server-sent events

/**
 * Follow an SSE stream. Reconnects with backoff; `url` is re-read on every (re)connect so a
 * caller can resume after the last event it saw (`?after=<seq>`).
 */
export function useEventStream(opts: { url: () => string | null; event: string; onMessage: (data: any, id: string) => void; onOpen?: () => void; enabled?: boolean; key?: unknown }) {
	const ref = useRef(opts);
	ref.current = opts;
	const enabled = opts.enabled ?? true;
	useEffect(() => {
		if (!enabled) return;
		let es: EventSource | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let closed = false;
		let attempt = 0;
		const connect = () => {
			if (closed) return;
			const url = ref.current.url();
			if (!url) return;
			es = new EventSource(url, { withCredentials: true });
			es.addEventListener("open", () => {
				attempt = 0;
				ref.current.onOpen?.();
			});
			es.addEventListener(ref.current.event, (e) => {
				const me = e as MessageEvent<string>;
				let data: unknown;
				try {
					data = JSON.parse(me.data);
				} catch {
					return;
				}
				ref.current.onMessage(data, me.lastEventId);
			});
			es.addEventListener("error", () => {
				// The browser would retry on its own with a stale `after`; reconnect ourselves instead.
				es?.close();
				if (closed) return;
				attempt++;
				timer = setTimeout(connect, Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)));
			});
		};
		connect();
		return () => {
			closed = true;
			if (timer) clearTimeout(timer);
			es?.close();
		};
	}, [enabled, opts.key]);
}
