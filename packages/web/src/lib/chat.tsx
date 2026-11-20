import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { toast } from "../components/hooks/use-toast";
import { ApiError, endpoints, useEventStream } from "./api";
import i18n from "./i18n";
import type { Ask, Card, ThreadDetail, ToolCall, UiEvent, UiMessage } from "./types";

/**
 * Chat state lives above the routes (design §7): navigating between screens never cuts off a
 * live conversation. Each thread is rebuilt from `GET /api/threads/:id`, followed live through
 * `GET /api/threads/:id/events?after=<seq>`, and rebuilt again after `run_end`.
 */

export type ChatItem =
	| { role: "user"; text: string; images?: number; queued?: boolean; local?: boolean; from?: string }
	| { role: "assistant"; text: string; tools: ToolCall[]; cards: Card[]; error?: string; streaming?: boolean }
	| { role: "notice"; text: string; level: "info" | "error" }
	| { role: "answer"; text: string };

export type ThreadState = {
	id: string;
	loaded: boolean;
	items: ChatItem[];
	seq: number;
	running: boolean;
	thinking: boolean;
	pending?: Ask;
	epoch: number;
	loadError?: string;
};

const empty = (id: string): ThreadState => ({ id, loaded: false, items: [], seq: 0, running: false, thinking: false, epoch: 0 });

function fromMessages(messages: UiMessage[]): ChatItem[] {
	return messages.map((m) => (m.role === "user" ? { role: "user", text: m.text, images: m.images } : { role: "assistant", text: m.text, tools: m.tools.map((t) => ({ ...t, done: true })), cards: [], error: m.error }));
}

type Action =
	| { type: "loaded"; id: string; detail: ThreadDetail; reset?: boolean }
	| { type: "loadError"; id: string; error: string }
	| { type: "event"; id: string; ev: UiEvent }
	| { type: "local"; id: string; item: ChatItem }
	| { type: "patch"; id: string; patch: Partial<ThreadState> };

type Store = Record<string, ThreadState>;

function lastAssistant(items: ChatItem[]): { item: Extract<ChatItem, { role: "assistant" }>; index: number } | undefined {
	const i = items.length - 1;
	const it = items[i];
	return it?.role === "assistant" ? { item: it, index: i } : undefined;
}

function withAssistant(items: ChatItem[], fn: (a: Extract<ChatItem, { role: "assistant" }>) => Extract<ChatItem, { role: "assistant" }>): ChatItem[] {
	const last = lastAssistant(items);
	if (last) {
		const copy = items.slice();
		copy[last.index] = fn(last.item);
		return copy;
	}
	return [...items, fn({ role: "assistant", text: "", tools: [], cards: [], streaming: true })];
}

function applyEvent(s: ThreadState, ev: UiEvent): ThreadState {
	if (typeof ev.seq === "number") {
		if (ev.seq <= s.seq) return s;
		s = { ...s, seq: ev.seq };
	}
	switch (ev.type) {
		case "run_start":
			return { ...s, running: true };
		case "run_end": {
			const items = s.items.map((it) => (it.role === "assistant" && it.streaming ? { ...it, streaming: false } : it));
			const state = ev.state as string;
			const extra: ChatItem[] = state === "interrupted" ? [{ role: "notice", text: i18n.t("chat:notices.stopped"), level: "info" }] : [];
			return { ...s, running: false, thinking: false, pending: undefined, items: [...items, ...extra] };
		}
		case "user_message": {
			const text = String(ev.text ?? "");
			const idx = s.items.findIndex((it) => it.role === "user" && it.local && it.text === text);
			if (idx >= 0) {
				const items = s.items.slice();
				items[idx] = { ...(items[idx] as Extract<ChatItem, { role: "user" }>), local: false, queued: !!ev.queued };
				return { ...s, items };
			}
			return { ...s, items: [...s.items, { role: "user", text, queued: !!ev.queued, from: ev.from as string | undefined, images: typeof ev.images === "number" && ev.images ? ev.images : undefined }] };
		}
		case "assistant_start":
			return {
				...s,
				thinking: false,
				items: withAssistant(s.items, (a) => ({ ...a, streaming: true, text: a.text && !a.text.endsWith("\n\n") ? `${a.text}\n\n` : a.text })),
			};
		case "text_delta":
			return { ...s, thinking: false, items: withAssistant(s.items, (a) => ({ ...a, text: a.text + String(ev.delta ?? "") })) };
		case "thinking":
			return s.thinking ? s : { ...s, thinking: true };
		case "assistant_end":
			return {
				...s,
				thinking: false,
				items: withAssistant(s.items, (a) => ({ ...a, text: a.text.replace(/\n\n$/, ""), error: (ev.error as string | undefined) ?? a.error })),
			};
		case "tool_start": {
			const tool: ToolCall = { id: String(ev.id), name: String(ev.name), label: String(ev.label ?? ev.name), done: false };
			return { ...s, thinking: false, items: withAssistant(s.items, (a) => ({ ...a, tools: [...a.tools, tool] })) };
		}
		case "tool_end":
			return {
				...s,
				items: withAssistant(s.items, (a) => {
					const found = a.tools.some((t) => t.id === ev.id);
					const end = { isError: !!ev.isError, summary: ev.summary as string | undefined, done: true };
					const card = ev.card as Card | undefined;
					const tools = found
						? a.tools.map((t) => (t.id === ev.id ? { ...t, ...end, card: card ?? t.card } : t))
						: [...a.tools, { id: String(ev.id), name: String(ev.name), label: String(ev.name), ...end, card }];
					return { ...a, tools };
				}),
			};
		case "card": {
			const card = ev.card as Card;
			// A card shown by a running tool belongs to it (its tool_end repeats the card).
			return {
				...s,
				items: withAssistant(s.items, (a) => {
					const running = [...a.tools].reverse().find((t) => !t.done);
					if (running) return { ...a, tools: a.tools.map((t) => (t === running ? { ...t, card } : t)) };
					return { ...a, cards: [...a.cards, card] };
				}),
			};
		}
		case "ask": {
			const { id, question, kind, options, secret_key } = ev as unknown as Ask;
			return { ...s, thinking: false, pending: { id, question, kind, options, secret_key } };
		}
		case "ask_answered":
			return {
				...s,
				pending: s.pending?.id === ev.id ? undefined : s.pending,
				items: typeof ev.text === "string" && ev.text ? [...s.items, { role: "answer", text: ev.text }] : s.items,
			};
		case "notice":
			return { ...s, items: [...s.items, { role: "notice", text: String(ev.text ?? ""), level: "info" }] };
		case "error":
			return { ...s, items: [...s.items, { role: "notice", text: String(ev.message ?? i18n.t("chat:notices.failed")), level: "error" }] };
		default:
			return s;
	}
}

function reducer(store: Store, a: Action): Store {
	const cur = store[a.id] ?? empty(a.id);
	switch (a.type) {
		case "loaded": {
			const items = fromMessages(a.detail.messages);
			const known = new Set(items.filter((i) => i.role === "user").map((i) => (i as { text: string }).text));
			// The latest turn as seen live: if the saved conversation lacks it (a run that failed
			// before anything was saved), keep it; otherwise keep only its error lines.
			let lastUser = -1;
			if (!a.reset) for (let i = cur.items.length - 1; i >= 0; i--) if (cur.items[i]!.role === "user") (lastUser = i), (i = -1);
			const after = lastUser >= 0 ? cur.items.slice(lastUser) : [];
			const turnSaved = lastUser >= 0 && known.has((cur.items[lastUser] as { text: string }).text);
			const tail = turnSaved ? after.filter((i) => i.role === "notice" && i.level === "error") : after.map((i) => (i.role === "assistant" ? { ...i, streaming: false } : i));
			// Keep messages typed here that the saved conversation does not have yet.
			const unsent = cur.items.filter((i) => i.role === "user" && i.local && !known.has(i.text) && !tail.includes(i));
			items.push(...tail);
			const seq = a.reset ? a.detail.seq : Math.max(cur.seq, a.detail.seq);
			return {
				...store,
				[a.id]: { ...cur, loaded: true, loadError: undefined, items: [...items, ...unsent], seq, running: a.detail.running, pending: a.detail.pending, thinking: false, epoch: a.reset ? cur.epoch + 1 : cur.epoch },
			};
		}
		case "loadError":
			return { ...store, [a.id]: { ...cur, loadError: a.error } };
		case "event":
			return { ...store, [a.id]: applyEvent(cur, a.ev) };
		case "local":
			return { ...store, [a.id]: { ...cur, items: [...cur.items, a.item] } };
		case "patch":
			return { ...store, [a.id]: { ...cur, ...a.patch } };
	}
}

export type ImageAttachment = { data: string; mimeType: string; name: string };

type ChatApi = {
	activeId: string | null;
	setActive: (id: string | null) => void;
	thread: ThreadState | undefined;
	draft: string;
	setDraft: (s: string | ((prev: string) => string)) => void;
	send: (text: string, images?: ImageAttachment[]) => Promise<void>;
	/** A card action already ran an operation: tell the agent what the owner did. */
	note: (threadId: string, text: string) => Promise<void>;
	answer: (value: string) => Promise<boolean>;
	abort: () => Promise<void>;
	newChat: () => void;
	/** Open the chat with an item described in the composer ("ask about this"). */
	askAbout: (text: string) => void;
	dockOpen: boolean;
	setDockOpen: (open: boolean) => void;
	/** Set by the shell: how to show the chat (dock on desktop, the Chat screen on a phone). */
	registerOpener: (fn: () => void) => void;
	sending: boolean;
};

const ChatContext = createContext<ChatApi | null>(null);

export function useChat(): ChatApi {
	const c = useContext(ChatContext);
	if (!c) throw new Error("useChat outside ChatProvider");
	return c;
}

export function ChatProvider({ children }: { children: ReactNode }) {
	const qc = useQueryClient();
	const [store, dispatch] = useReducer(reducer, {});
	const [activeId, setActiveId] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [dockOpen, setDockOpen] = useState(false);
	const [sending, setSending] = useState(false);
	const storeRef = useRef(store);
	storeRef.current = store;
	const activeRef = useRef(activeId);
	activeRef.current = activeId;
	const skipLoad = useRef(new Set<string>());
	const opener = useRef<() => void>(() => setDockOpen(true));

	const load = useCallback(async (id: string, reset = false) => {
		try {
			const detail = await endpoints.thread(id);
			// A lower number than we saw means the server restarted and numbers events afresh.
			dispatch({ type: "loaded", id, detail, reset: reset || detail.seq < (storeRef.current[id]?.seq ?? 0) });
		} catch (e) {
			dispatch({ type: "loadError", id, error: e instanceof Error ? e.message : String(e) });
		}
	}, []);

	useEffect(() => {
		if (!activeId) return;
		if (skipLoad.current.has(activeId)) {
			skipLoad.current.delete(activeId);
			return;
		}
		void load(activeId);
	}, [activeId, load]);

	const thread = activeId ? store[activeId] : undefined;
	const opens = useRef(0);

	useEventStream({
		enabled: !!activeId && !!thread?.loaded,
		key: `${activeId}:${thread?.epoch ?? 0}`,
		event: "ui",
		url: () => {
			const id = activeRef.current;
			if (!id) return null;
			return `/api/threads/${encodeURIComponent(id)}/events?after=${storeRef.current[id]?.seq ?? 0}`;
		},
		onOpen: () => {
			const id = activeRef.current;
			if (!id) return;
			if (opens.current++ === 0) return;
			// A reconnect: if the server restarted, its numbering began again; rebuild from scratch.
			void endpoints
				.thread(id)
				.then((detail) => {
					if (detail.seq < (storeRef.current[id]?.seq ?? 0)) dispatch({ type: "loaded", id, detail, reset: true });
				})
				.catch(() => undefined);
		},
		onMessage: (ev: UiEvent) => {
			const id = activeRef.current;
			if (!id || (ev.threadId && ev.threadId !== id)) return;
			dispatch({ type: "event", id, ev });
			if (ev.type === "run_end") {
				void load(id);
				qc.invalidateQueries({ queryKey: ["threads"] });
				qc.invalidateQueries({ queryKey: ["downloads"] });
			}
			if (ev.type === "run_start") qc.invalidateQueries({ queryKey: ["threads"] });
		},
	});

	useEffect(() => {
		opens.current = 0;
	}, [activeId]);

	const draftKey = activeId ?? "new";
	const draft = drafts[draftKey] ?? "";
	const setDraft = useCallback(
		(v: string | ((prev: string) => string)) => setDrafts((d) => ({ ...d, [draftKey]: typeof v === "function" ? v(d[draftKey] ?? "") : v })),
		[draftKey],
	);

	const setActive = useCallback((id: string | null) => setActiveId(id), []);

	const ensureThread = useCallback(async (nameHint?: string): Promise<string> => {
		const cur = activeRef.current;
		if (cur) return cur;
		const t = await endpoints.createThread(nameHint);
		dispatch({ type: "loaded", id: t.id, detail: { thread: t, messages: [], seq: 0, running: false } });
		skipLoad.current.add(t.id);
		activeRef.current = t.id;
		setActiveId(t.id);
		qc.invalidateQueries({ queryKey: ["threads"] });
		return t.id;
	}, [qc]);

	const send = useCallback(
		async (text: string, images: ImageAttachment[] = []) => {
			const body = text.trim();
			if (!body && !images.length) return;
			setSending(true);
			const keyBefore = activeRef.current ?? "new";
			try {
				const id = await ensureThread();
				dispatch({ type: "local", id, item: { role: "user", text: body, images: images.length || undefined, local: true } });
				setDrafts((d) => ({ ...d, [keyBefore]: "", [id]: "" }));
				const r = await endpoints.sendMessage(id, body, images.map(({ data, mimeType }) => ({ data, mimeType })));
				if (r.runId) dispatch({ type: "patch", id, patch: { running: true } });
				qc.invalidateQueries({ queryKey: ["threads"] });
			} catch (e) {
				toast({ title: i18n.t("chat:notices.messageNotSent"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
				setDrafts((d) => ({ ...d, [keyBefore]: body }));
			} finally {
				setSending(false);
			}
		},
		[ensureThread, qc],
	);

	const note = useCallback(
		async (threadId: string, text: string) => {
			if (threadId === activeRef.current) dispatch({ type: "local", id: threadId, item: { role: "user", text, local: true } });
			try {
				await endpoints.sendMessage(threadId, text);
			} catch (e) {
				toast({ title: i18n.t("chat:notices.noteFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
			}
		},
		[],
	);

	const answer = useCallback(async (value: string) => {
		const id = activeRef.current;
		const q = id ? storeRef.current[id]?.pending : undefined;
		if (!id || !q) return false;
		try {
			await endpoints.answer(id, q.id, value);
			dispatch({ type: "patch", id, patch: { pending: undefined } });
			return true;
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) dispatch({ type: "patch", id, patch: { pending: undefined } });
			toast({ title: i18n.t("chat:notices.answerFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
			return false;
		}
	}, []);

	const abort = useCallback(async () => {
		const id = activeRef.current;
		if (!id) return;
		try {
			await endpoints.abort(id);
		} catch (e) {
			toast({ title: i18n.t("chat:notices.stopFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		}
	}, []);

	const newChat = useCallback(() => setActiveId(null), []);

	const askAbout = useCallback((text: string) => {
		const key = activeRef.current ?? "new";
		setDrafts((d) => {
			const prev = d[key]?.trim();
			return { ...d, [key]: prev ? `${prev}\n\n${text}` : text };
		});
		opener.current();
	}, []);

	const registerOpener = useCallback((fn: () => void) => {
		opener.current = fn;
	}, []);

	const value = useMemo<ChatApi>(
		() => ({ activeId, setActive, thread, draft, setDraft, send, note, answer, abort, newChat, askAbout, dockOpen, setDockOpen, registerOpener, sending }),
		[activeId, setActive, thread, draft, setDraft, send, note, answer, abort, newChat, askAbout, dockOpen, registerOpener, sending],
	);
	return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
