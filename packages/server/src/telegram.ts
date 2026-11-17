import { existsSync, readFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { type InboxItem, type Reelix, type TelegramClient, type TgMessage, answerInbox, errorMessage, getInbox, kvGet, kvSet, nowIso } from "@reelix/core";
import type { AgentHost, UiEvent } from "./agent/host.ts";

/**
 * The Telegram bot (§7.4): notices with pictures, answers by button or reply, and chat in one
 * standing "Telegram" thread. Acts only on the owner's own account, linked by a one-time code.
 * Connects outward (long polling); nothing on the NAS is opened to the internet.
 */
export class TelegramBot {
	app: Reelix;
	host: AgentHost;
	private abort?: AbortController;
	private linkCode?: { code: string; until: number };
	private lastError?: string;
	private running = false;
	private username?: string;
	/** Telegram message id → inbox id, so a reply to a notice answers it. */
	private replyMap = new Map<number, string>();

	constructor(app: Reelix, host: AgentHost) {
		this.app = app;
		this.host = host;
		app.events.on("event", (e: any) => {
			if (e.type === "inbox" && e.status === "open" && e.item) void this.sendInbox(e.item as InboxItem);
			if (e.type === "inbox" && e.status !== "open") void this.closeInbox(e.id, e.status, e.item?.answer);
			if (e.type === "config") this.restart();
		});
		host.globalListeners.add((e) => void this.onThreadEvent(e));
	}

	private client(): TelegramClient | undefined {
		return this.app.telegram();
	}

	private get ownerId(): number | undefined {
		return this.app.config.telegram.owner_id;
	}

	status() {
		return { configured: !!this.client(), linked: !!this.ownerId, running: this.running, bot: this.username, error: this.lastError };
	}

	newLinkCode(): string {
		const code = String(randomInt(100000, 999999));
		this.linkCode = { code, until: Date.now() + 10 * 60_000 };
		return code;
	}

	start(): void {
		if (this.running || !this.client()) return;
		this.running = true;
		this.abort = new AbortController();
		void this.loop(this.abort.signal);
	}

	restart(): void {
		const want = !!this.client();
		if (this.running && !want) this.stop();
		else if (!this.running && want) this.start();
	}

	stop(): void {
		this.abort?.abort();
		this.running = false;
	}

	private async loop(signal: AbortSignal): Promise<void> {
		let offset = Number(kvGet(this.app.db, "telegram.offset") ?? 0);
		let backoff = 2000;
		try {
			const me = await this.client()!.getMe();
			this.username = me.username;
		} catch (e) {
			this.lastError = errorMessage(e);
		}
		while (!signal.aborted) {
			const tg = this.client();
			if (!tg) break;
			try {
				const updates = await tg.getUpdates(offset, 25, signal);
				this.lastError = undefined;
				backoff = 2000;
				for (const u of updates) {
					offset = u.update_id + 1;
					kvSet(this.app.db, "telegram.offset", String(offset));
					try {
						if (u.callback_query) await this.onCallback(u.callback_query);
						else if (u.message) await this.onMessage(u.message);
					} catch (e) {
						console.error("[telegram]", errorMessage(e));
					}
				}
			} catch (e) {
				if (signal.aborted) break;
				this.lastError = errorMessage(e);
				await new Promise((r) => setTimeout(r, backoff));
				backoff = Math.min(backoff * 2, 120_000);
			}
		}
		this.running = false;
	}

	private async onMessage(m: TgMessage): Promise<void> {
		const tg = this.client()!;
		const from = m.from?.id;
		const text = (m.text ?? m.caption ?? "").trim();
		// Linking: a one-time code shown in the web UI.
		if (!this.ownerId) {
			if (this.linkCode && this.linkCode.until > Date.now() && text === this.linkCode.code && from) {
				this.app.setConfig("telegram.owner_id", from);
				this.linkCode = undefined;
				await tg.sendMessage(m.chat.id, "Linked. I'll send notices here, and you can chat with me in this conversation.");
			}
			return; // anyone else, or before linking: ignored
		}
		if (from !== this.ownerId) return; // only the owner (a chat thread has a shell)

		// A reply to a notice answers it (e.g. a verification code typed straight back).
		const repliedTo = m.reply_to_message?.message_id;
		const inboxId = repliedTo ? (this.replyMap.get(repliedTo) ?? this.inboxByMessage(repliedTo)) : undefined;
		if (inboxId && text) {
			const it = getInbox(this.app, inboxId);
			if (it?.status === "open") {
				answerInbox(this.app, inboxId, text, "owner:telegram");
				await tg.sendMessage(m.chat.id, "Got it.", undefined, m.message_id);
				return;
			}
		}
		// A pending question in the Telegram thread takes the text as its answer.
		const threadId = this.threadId();
		const images: { data: string; mimeType: string }[] = [];
		if (m.photo?.length) {
			const best = m.photo[m.photo.length - 1]!;
			const f = await tg.downloadFile(best.file_id);
			images.push({ data: Buffer.from(f.bytes).toString("base64"), mimeType: "image/jpeg" });
		}
		if (!text && !images.length) return;
		await tg.sendChatAction(m.chat.id).catch(() => {});
		await this.host.send(threadId, text || "(photo)", { images, from: "telegram" });
	}

	private inboxByMessage(messageId: number): string | undefined {
		return (this.app.db.prepare("SELECT id FROM inbox WHERE telegram_message_id = ?").get(messageId) as { id: string } | undefined)?.id;
	}

	private async onCallback(q: { id: string; from: { id: number }; message?: TgMessage; data?: string }): Promise<void> {
		const tg = this.client()!;
		if (q.from.id !== this.ownerId) return;
		const [kind, a, b] = (q.data ?? "").split("|");
		if (kind === "in" && a) {
			const it = getInbox(this.app, a);
			const answer = it?.options[Number(b)] ?? b ?? "";
			if (it?.status === "open") answerInbox(this.app, a, answer, "owner:telegram");
			await tg.answerCallback(q.id, it?.status === "open" ? `Answered: ${answer}` : "Already handled");
		} else if (kind === "q" && a) {
			const pending = this.host.pendingQuestion(this.threadId());
			const answer = pending?.options?.[Number(b)] ?? "";
			const ok = pending?.id === a && this.host.answer(this.threadId(), a, answer);
			await tg.answerCallback(q.id, ok ? answer : "That question is closed");
		}
	}

	/** The standing "Telegram" thread (§7.4). */
	threadId(): string {
		let id = kvGet(this.app.db, "telegram.thread");
		if (!id || !this.host.getThread(id)) {
			id = this.host.createThread("Telegram", "telegram").id;
			kvSet(this.app.db, "telegram.thread", id);
		}
		return id;
	}

	private replyBuffers = new Map<string, string>();

	private async onThreadEvent(e: UiEvent): Promise<void> {
		const owner = this.ownerId;
		const tg = this.client();
		if (!owner || !tg || e.threadId !== kvGet(this.app.db, "telegram.thread")) return;
		if (e.type === "assistant_start") this.replyBuffers.set(e.threadId, "");
		else if (e.type === "text_delta") this.replyBuffers.set(e.threadId, (this.replyBuffers.get(e.threadId) ?? "") + String(e.delta));
		else if (e.type === "assistant_end") {
			const text = this.replyBuffers.get(e.threadId)?.trim();
			this.replyBuffers.delete(e.threadId);
			if (text) await tg.sendMessage(owner, text).catch(() => {});
		} else if (e.type === "tool_start" && /download_add|organise|release_search/.test(String(e.name))) {
			await tg.sendChatAction(owner).catch(() => {});
		} else if (e.type === "card") {
			const card = e.card as any;
			if ((card?.kind === "image" || card?.kind === "verification") && card.path && existsSync(card.path)) await tg.sendPhoto(owner, readFileSync(card.path), card.text ?? "").catch(() => {});
			else if (card?.kind === "releases") await tg.sendMessage(owner, (card.releases ?? []).slice(0, 8).map((r: any) => `${r.handle}${r.handle === card.pick ? " ★" : ""} ${r.title}`).join("\n")).catch(() => {});
		} else if (e.type === "ask") {
			if (e.kind === "secret") {
				await tg.sendMessage(owner, `${e.question}\nPasswords and keys are entered in the web UI's secret field, not in Telegram.`).catch(() => {});
				return;
			}
			const opts = (e.options as string[] | undefined) ?? [];
			await tg.sendMessage(owner, String(e.question), opts.length ? opts.map((o, i) => [{ text: o.slice(0, 60), callback_data: `q|${e.id}|${i}` }]) : undefined).catch(() => {});
		} else if (e.type === "error") await tg.sendMessage(owner, `Error: ${e.message}`).catch(() => {});
	}

	/** Anything that needs the owner goes to Telegram; routine progress does not (§7.4). */
	private async sendInbox(it: InboxItem): Promise<void> {
		const owner = this.ownerId;
		const tg = this.client();
		if (!owner || !tg) return;
		const needsOwner = it.kind !== "notice" || !!it.payload?.urgent;
		if (!needsOwner) return;
		const text = `${it.title}${it.body ? `\n\n${it.body}` : ""}${it.options.length ? "" : "\n\n(Reply to this message to answer.)"}`;
		const buttons = it.options.length ? it.options.map((o, i) => [{ text: o.slice(0, 60), callback_data: `in|${it.id}|${i}` }]) : undefined;
		try {
			const msg = it.image_path && existsSync(it.image_path) ? await tg.sendPhoto(owner, readFileSync(it.image_path), text, buttons) : await tg.sendMessage(owner, text, buttons);
			this.replyMap.set(msg.message_id, it.id);
			this.app.db.prepare("UPDATE inbox SET telegram_message_id = ? WHERE id = ?").run(msg.message_id, it.id);
		} catch (e) {
			this.lastError = errorMessage(e);
		}
	}

	private async closeInbox(id: string, status: string, answer?: string): Promise<void> {
		const owner = this.ownerId;
		const tg = this.client();
		const it = getInbox(this.app, id);
		if (!owner || !tg || !it?.telegram_message_id) return;
		await tg.editMessageText(owner, it.telegram_message_id, `${it.title}\n\n✓ ${status}${answer ? `: ${answer}` : ""} (${nowIso().slice(11, 16)})`).catch(() => {});
	}

	/** Send a test message (setup step 8). */
	async test(): Promise<string> {
		const tg = this.client();
		if (!tg) throw new Error("No bot token: set telegram.bot_token through the secret field.");
		if (!this.ownerId) throw new Error("The owner's account is not linked yet.");
		await tg.sendMessage(this.ownerId, "Reelix test message: notices will arrive here.");
		return "sent";
	}
}
