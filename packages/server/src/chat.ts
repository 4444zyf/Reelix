import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { type ChatIncoming, type ChatOut, type ChatReceipt, isOutcome } from "@reelix/plugin";
import { CHAT_SEAM, type Reelix, ReelixError, answerApproves, answerInbox, channelActor, channelMayApprove, channelOfThread, channelRow, errorMessage, getInbox, inboxOfDelivery, outcomeText, playTargetText, recordChannelResult, setChannelOwner, setChannelThread, tr } from "@reelix/core";
import type { AgentHost, UiEvent } from "./agent/host.ts";

const PAIRING_MS = 10 * 60_000;
/** A chat app is told the agent is working at most this often. */
const WORKING_EVERY_MS = 4_000;

export type ChatHost = Pick<AgentHost, "createThread" | "getThread" | "send" | "answer" | "pendingQuestion" | "globalListeners">;

/** A card as a chat app shows it. Cards it cannot say in words are left to the web app. */
function cardOut(app: Reelix, card: any): Extract<ChatOut, { type: "card" }> | undefined {
	const kind = String(card?.kind ?? "");
	if ((kind === "image" || kind === "verification") && card.path && existsSync(card.path)) return { type: "card", kind, text: card.text ?? "", image: new Uint8Array(readFileSync(card.path)) };
	if (kind === "play" && card.play) return { type: "card", kind, text: playTargetText(card.play) };
	if (kind === "releases") return { type: "card", kind, text: (card.releases ?? []).slice(0, 8).map((r: any) => `${r.handle}${r.handle === card.pick ? " ★" : ""} ${r.title}${r.hidden?.length ? ` (${tr(app, "chat.hiddenBy", { plugins: r.hidden.map((h: any) => h.plugin).join(", ") })})` : ""}`).join("\n") };
	if (kind === "text" && card.text) return { type: "card", kind, text: String(card.text) };
	if (kind === "plugin" && card.title) return { type: "card", kind, text: [card.title, ...(card.rows ?? []).map((r: any) => `- ${r.primary}${r.secondary ? ` (${r.secondary})` : ""}`), card.text, card.rows?.length ? "" : card.empty].filter(Boolean).join("\n") };
	if (kind === "title" && card.title?.name) return { type: "card", kind, text: `${card.title.name}${card.title.year ? ` (${card.title.year})` : ""}` };
	return undefined;
}

/**
 * Chat channels on the agent side (docs/plugins.md §7.4): pairing, one standing conversation per
 * channel, and carrying what the agent produces to the channel. Only the paired owner gets through.
 */
export class ChatBridge {
	private app: Reelix;
	private host: ChatHost;
	private codes = new Map<string, { code: string; until: number }>();
	private replies = new Map<string, string>();
	private queues = new Map<string, Promise<void>>();
	private lastWorking = new Map<string, number>();
	/** Reelix is stopping: a send still on its way records nothing (the database may be closed). */
	private stopped = false;

	constructor(app: Reelix, host: ChatHost) {
		this.app = app;
		this.host = host;
	}

	start(): void {
		this.stopped = false;
		this.host.globalListeners.add(this.onEvent);
	}

	stop(): void {
		this.stopped = true;
		this.host.globalListeners.delete(this.onEvent);
	}

	private channelsOf(plugin: string) {
		return this.app.seams.providers(CHAT_SEAM).filter((p) => p.plugin === plugin);
	}

	private requireOwn(plugin: string, channel: string) {
		const p = this.app.seams.provider(CHAT_SEAM, channel);
		if (p?.plugin !== plugin) throw new Error(`this plugin has no chat channel "${channel}"`);
		return p;
	}

	pair(plugin: string): { code: string; expiresAt: string } {
		const channels = this.channelsOf(plugin);
		if (!channels.length) throw new ReelixError("not_configured", "This plugin has no chat channel to link.");
		if (channels.every((c) => channelRow(this.app, c.id)?.owner)) throw new ReelixError("already_linked", "This chat channel is already linked. Unlink it first (`reelix channel unlink`, or Settings).");
		const code = String(randomInt(100000, 1000000));
		const until = Date.now() + PAIRING_MS;
		this.codes.set(plugin, { code, until });
		return { code, expiresAt: new Date(until).toISOString() };
	}

	ownerOf(plugin: string, channel: string): string | undefined {
		this.requireOwn(plugin, channel);
		return channelRow(this.app, channel)?.owner ?? undefined;
	}

	async receive(plugin: string, m: ChatIncoming): Promise<ChatReceipt> {
		const provider = this.requireOwn(plugin, m.channel);
		const row = channelRow(this.app, m.channel);
		const text = m.text?.trim() ?? "";
		if (!row?.owner) {
			const pairing = this.codes.get(plugin);
			if (!pairing || pairing.until <= Date.now() || text !== pairing.code || !m.sender) return { status: "ignored" };
			this.codes.delete(plugin);
			setChannelOwner(this.app, m.channel, m.sender);
			return { status: "paired" };
		}
		if (m.sender !== row.owner) return { status: "ignored" };

		const by = channelActor(this.app, m.channel);
		const threadId = this.threadOf(m.channel, provider.label);
		if (m.answerTo) {
			const pending = this.host.pendingQuestion(threadId);
			if (pending?.id === m.answerTo && pending.kind !== "secret") {
				const value = m.optionId === undefined ? text : pending.options?.[Number(m.optionId)];
				if (value === undefined) return { status: "closed" };
				return this.host.answer(threadId, pending.id, value, by) ? { status: "answered", answer: value } : { status: "closed" };
			}
			if (m.optionId !== undefined) return { status: "closed" }; // a button of a question that is over
			// A reply to a notice answers it; a reply to anything else is ordinary chat.
			const inboxId = text ? inboxOfDelivery(this.app, provider.id, m.answerTo) : undefined;
			if (inboxId && getInbox(this.app, inboxId)?.status === "open") return this.answerAs(m.channel, inboxId, text);
		}

		const images = (m.images ?? []).map((i) => ({ data: Buffer.from(i.data).toString("base64"), mimeType: i.mimeType }));
		if (!text && !images.length) return { status: "ignored" };
		this.say(m.channel, { type: "working" });
		try {
			await this.host.send(threadId, text || tr(this.app, "chat.photo"), { images, from: m.channel, by });
		} catch (e) {
			this.say(m.channel, { type: "text", text: tr(this.app, "chat.error", { message: this.app.redact(errorMessage(e)) }) });
		}
		return { status: "sent" };
	}

	/** An answer to an Inbox item, from a button on a notice. */
	answerInbox(plugin: string, inboxId: string, a: { optionId: string; sender: string }): ChatReceipt {
		const channel = this.channelsOf(plugin).find((c) => channelRow(this.app, c.id)?.owner === a.sender);
		if (!channel) return { status: "ignored" };
		const it = getInbox(this.app, inboxId);
		if (it?.status !== "open") return { status: "closed" };
		const answer = it.options[Number(a.optionId)];
		return answer ? this.answerAs(channel.id, inboxId, answer) : { status: "closed" };
	}

	private answerAs(channel: string, inboxId: string, answer: string): ChatReceipt {
		const it = getInbox(this.app, inboxId)!;
		// A yes that would create an approval record needs a channel allowed to give one (§11.2).
		if (answerApproves(it, answer) && !channelMayApprove(this.app, channel)) return { status: "approve_in_web" };
		answerInbox(this.app, inboxId, answer, channelActor(this.app, channel));
		return { status: "answered", answer };
	}

	/** The channel's standing conversation. */
	private threadOf(channel: string, label: string): string {
		const id = channelRow(this.app, channel)?.thread_id;
		if (id && this.host.getThread(id)) return id;
		const thread = this.host.createThread(label, "channel");
		setChannelThread(this.app, channel, thread.id);
		return thread.id;
	}

	private onEvent = (e: UiEvent) => {
		if (!["assistant_start", "text_delta", "assistant_end", "tool_start", "card", "ask", "error"].includes(e.type)) return;
		const channel = channelOfThread(this.app, e.threadId);
		if (!channel || !channelRow(this.app, channel)?.owner) return;
		switch (e.type) {
			case "assistant_start":
				this.replies.set(channel, "");
				break;
			case "text_delta":
				this.replies.set(channel, (this.replies.get(channel) ?? "") + String(e.delta));
				break;
			case "assistant_end": {
				const text = this.replies.get(channel)?.trim();
				this.replies.delete(channel);
				if (text) this.say(channel, { type: "text", text });
				break;
			}
			case "tool_start":
				this.say(channel, { type: "working" });
				break;
			case "card": {
				const out = cardOut(this.app, e.card);
				if (out) this.say(channel, out);
				break;
			}
			case "ask":
				if (e.kind === "secret") this.say(channel, { type: "text", text: tr(this.app, "chat.secretInWeb") });
				else this.say(channel, { type: "ask", id: String(e.id), question: String(e.question), options: ((e.options as string[] | undefined) ?? []).map((label, i) => ({ id: String(i), label })) });
				break;
			case "error":
				this.say(channel, { type: "text", text: tr(this.app, "chat.error", { message: e.message }) });
				break;
		}
	};

	/** What leaves for the chat app: no known secret, and only what this channel can show. */
	private prepared(m: ChatOut, can: { buttons: boolean; images: boolean }): ChatOut {
		if (m.type === "text") return { ...m, text: this.app.redact(m.text) };
		if (m.type === "card") return { ...m, text: this.app.redact(m.text), image: can.images ? m.image : undefined };
		if (m.type !== "ask") return m;
		const question = this.app.redact(m.question);
		const options = m.options.map((o) => ({ ...o, label: this.app.redact(o.label) }));
		return can.buttons ? { ...m, question, options } : { ...m, question: [question, ...options.map((o) => `- ${o.label}`)].join("\n"), options: [] };
	}

	/** One at a time per channel, so messages arrive in order. A failed send stays visible in Settings. */
	private say(channel: string, m: ChatOut): void {
		if (m.type === "working") {
			const now = Date.now();
			if (!this.app.seams.provider(CHAT_SEAM, channel)?.impl.can.typing || now - (this.lastWorking.get(channel) ?? 0) < WORKING_EVERY_MS) return;
			this.lastWorking.set(channel, now);
		}
		const next = (this.queues.get(channel) ?? Promise.resolve()).then(async () => {
			const p = this.stopped ? undefined : this.app.seams.provider(CHAT_SEAM, channel);
			if (!p) return;
			let error: string | undefined;
			try {
				const r = await p.call("say", [this.prepared(m, p.impl.can)]);
				if (isOutcome(r)) error = this.app.redact(outcomeText(p.label, r));
			} catch (e) {
				error = this.app.redact(errorMessage(e));
			}
			if (m.type === "working" && !error) return; // says nothing about whether messages get through
			if (this.stopped) return;
			recordChannelResult(this.app, channel, error);
			if (error) console.warn(`Chat channel ${channel}: ${error}`);
		});
		this.queues.set(channel, next);
	}
}
