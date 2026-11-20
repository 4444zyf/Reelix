import { type Call, type ChatOut, type Notice, OperationError, type Outcome, type PluginContext, SETTINGS, Type, definePlugin } from "@reelix/plugin";
import { CAPTION_LIMIT, type InlineButton, TelegramError, type TelegramClient, type TgCallback, type TgMessage, type TgUpdate, splitText, telegramClient } from "./client.ts";

/*
 * Telegram (docs/plugins.md §7.3, §7.4): a notifier and a chat channel over one bot connection.
 * The bot connects outward by long polling; nothing on the NAS is opened to the internet.
 * Who the owner is, and what reaches the agent, is decided by Reelix.
 */
const CHANNEL = "telegram";
const POLL_SECONDS = 25;
const NO_TOKEN = "No bot token: set plugins.telegram.bot_token through the secret field.";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What an outside failure means for the seam: expected, so not counted against the plugin. */
function outcomeOf(e: unknown): Outcome {
	if (e instanceof TelegramError) {
		if (e.status === 401) return { outcome: "needs_auth" };
		if (e.status === 429) return { outcome: "rate_limited", until: e.retryAfter ? new Date(Date.now() + e.retryAfter * 1000).toISOString() : undefined };
		return { outcome: "unavailable", message: e.message };
	}
	if (/^network/.test(String((e as { code?: unknown } | null)?.code ?? ""))) return { outcome: "unavailable", message: message(e) };
	throw e;
}

async function answering<T>(fn: () => Promise<T>): Promise<T | Outcome> {
	try {
		return await fn();
	} catch (e) {
		return outcomeOf(e);
	}
}

const rows = (options: { id: string; label: string }[], data: (id: string) => string): InlineButton[][] | undefined => (options.length ? options.map((o) => [{ text: o.label.slice(0, 60), callback_data: data(o.id) }]) : undefined);

/** Long text in order, with the buttons on the last message, which is the one returned. */
async function sendLong(tg: TelegramClient, to: string, text: string, o: { buttons?: InlineButton[][]; signal: AbortSignal }): Promise<TgMessage> {
	const parts = splitText(text);
	let last!: TgMessage;
	for (const [i, part] of parts.entries()) last = await tg.sendMessage(to, part, { buttons: i === parts.length - 1 ? o.buttons : undefined, signal: o.signal });
	return last;
}

/** A picture with as much text as a caption takes; the rest follows as messages. */
async function sendPicture(tg: TelegramClient, to: string, image: Uint8Array, text: string, o: { buttons?: InlineButton[][]; signal: AbortSignal }): Promise<TgMessage> {
	const [caption = "", ...rest] = splitText(text, CAPTION_LIMIT);
	const photo = await tg.sendPhoto(to, image, caption, { buttons: rest.length ? undefined : o.buttons, signal: o.signal });
	return rest.length ? sendLong(tg, to, rest.join("\n"), o) : photo;
}

function createUpdates(ctx: PluginContext, tg: TelegramClient) {
	async function onMessage(m: TgMessage): Promise<void> {
		const sender = m.from ? String(m.from.id) : "";
		const owner = await ctx.owner.of(CHANNEL);
		// Pictures are fetched only for the owner.
		const photo = owner === sender ? m.photo?.at(-1) : undefined;
		const images = photo ? [{ data: await tg.downloadFile(photo.file_id), mimeType: "image/jpeg" }] : undefined;
		const r = await ctx.chat.receive({ channel: CHANNEL, sender, text: m.text ?? m.caption, images, answerTo: m.reply_to_message ? String(m.reply_to_message.message_id) : undefined });
		if (r.status === "paired") await tg.sendMessage(m.chat.id, ctx.t("linked"));
		else if (r.status === "answered") await tg.sendMessage(m.chat.id, ctx.t("gotIt"), { replyTo: m.message_id });
		else if (r.status === "approve_in_web") await tg.sendMessage(m.chat.id, ctx.t("approveInWeb"), { replyTo: m.message_id });
	}

	async function onCallback(q: TgCallback): Promise<void> {
		const sender = String(q.from.id);
		const [kind, id, optionId] = (q.data ?? "").split("|");
		if (!id || (kind !== "in" && kind !== "q")) return;
		const r = kind === "in" ? await ctx.inbox.answer(id, { optionId, sender }) : await ctx.chat.receive({ channel: CHANNEL, sender, answerTo: id, optionId });
		if (r.status === "ignored") return;
		const text = r.status === "answered" ? (kind === "in" ? ctx.t("answered", { answer: r.answer }) : r.answer) : r.status === "approve_in_web" ? ctx.t("approveInWeb") : ctx.t(kind === "in" ? "alreadyHandled" : "questionClosed");
		await tg.answerCallback(q.id, text);
	}

	return async (u: TgUpdate) => {
		if (u.callback_query) await onCallback(u.callback_query);
		else if (u.message) await onMessage(u.message);
	};
}

export default definePlugin({
	config: Type.Object(
		{
			/** Another Bot API server, or a stand-in for tests. */
			api_url: Type.String({ default: "https://api.telegram.org" }),
		},
		{ [SETTINGS.buttons]: ["status", "link", "test"] },
	),
	async activate(ctx, settings) {
		const token = await ctx.secret.get("bot_token");
		const tg = token ? telegramClient(ctx, settings.api_url, token) : undefined;
		const status: { bot?: string; error?: string } = {};
		/** An error as the owner may read it: the token is part of every address. */
		const shown = (e: unknown) => (token ? message(e).replaceAll(token, "[bot token]") : message(e));

		/** The client and the chat to send to, or the reason there is none. */
		async function target() {
			const to = await ctx.owner.of(CHANNEL);
			return tg && to ? { tg, to } : undefined;
		}

		async function send(n: Notice, call: Call) {
			const t = await target();
			if (!t) return { outcome: "needs_auth" } as const;
			return answering(async () => {
				const text = `${n.title}${n.body ? `\n\n${n.body}` : ""}${n.answer.kind === "text" ? `\n\n${ctx.t("replyToAnswer")}` : ""}`;
				const buttons = rows(n.answer.options, (id) => `in|${n.inboxId}|${id}`);
				const sent = n.image ? await sendPicture(t.tg, t.to, n.image, text, { buttons, signal: call.signal }) : await sendLong(t.tg, t.to, text, { buttons, signal: call.signal });
				return { ref: String(sent.message_id) };
			});
		}

		async function say(m: ChatOut, call: Call): Promise<void | Outcome> {
			const t = await target();
			if (!t) return { outcome: "needs_auth" };
			return answering(async () => {
				const signal = call.signal;
				if (m.type === "working") await t.tg.sendChatAction(t.to, signal);
				else if (m.type === "text") await sendLong(t.tg, t.to, m.text, { signal });
				else if (m.type === "card") {
					if (m.image) await sendPicture(t.tg, t.to, m.image, m.text, { signal });
					else if (m.text) await sendLong(t.tg, t.to, m.text, { signal });
				} else await sendLong(t.tg, t.to, m.question, { buttons: rows(m.options, (id) => `q|${m.id}|${id}`), signal });
			});
		}

		async function sendTest() {
			if (!tg) throw new OperationError("not_configured", NO_TOKEN);
			const to = await ctx.owner.of(CHANNEL);
			if (!to) throw new OperationError("not_linked", "The owner's account is not linked yet.");
			await tg.sendMessage(to, ctx.t("test"));
		}

		await ctx.provide("reelix:notifier@1", {
			id: CHANNEL,
			label: "Telegram",
			can: { images: true, update: true, answers: true },
			send,
			async update(ref, n, closed, call) {
				const t = await target();
				if (!t) return { outcome: "needs_auth" };
				const word = closed.status === "answered" ? ctx.t("answeredStatus") : ctx.t("dismissedStatus");
				const text = `${n.title}\n\n✓ ${word}${closed.answer ? `: ${closed.answer}` : ""} (${new Date().toISOString().slice(11, 16)})`;
				return answering(async () => {
					try {
						await t.tg.editText(t.to, Number(ref), text, call.signal);
					} catch (e) {
						// A picture has a caption and no text.
						if (!(e instanceof TelegramError) || !/no text in the message/i.test(e.message)) throw e;
						await t.tg.editCaption(t.to, Number(ref), text, call.signal);
					}
				});
			},
		});

		await ctx.provide("reelix:chat.channel@1", { id: CHANNEL, label: "Telegram", can: { buttons: true, images: true, typing: true }, say });

		await ctx.hook("agent.prompt@1", ({ session }) => (session.channel === CHANNEL ? { title: "Telegram", text: "This thread is the owner's Telegram chat. Keep replies short; rich cards become plain text there." } : undefined));

		const currentStatus = async () => ({ configured: !!tg, linked: !!(await ctx.owner.of(CHANNEL)), running: !!tg, bot: status.bot, error: status.error });

		await ctx.operation({
			name: "status",
			summary: "Whether the Telegram bot is set up, linked and connected",
			effect: "read",
			input: Type.Object({}),
			run: currentStatus,
			toText: (o: Awaited<ReturnType<typeof currentStatus>>) => `${o.configured ? `bot ${o.bot ? `@${o.bot}` : "set"}` : "no bot token"}; ${o.linked ? "owner linked" : "owner not linked"}${o.error ? `; ${o.error}` : ""}`,
		});

		await ctx.operation({
			name: "link",
			summary: "Show a one-time code to send to the bot, linking the owner's Telegram account",
			// Whoever holds the code becomes the owner on Telegram.
			effect: "admin",
			input: Type.Object({}),
			recordOutput: (o: { code: string }) => ({ ...o, code: "[not kept]" }),
			async run() {
				if (!tg) throw new OperationError("not_configured", NO_TOKEN);
				if (await ctx.owner.of(CHANNEL)) throw new OperationError("already_linked", "Telegram is already linked. Unlink it first, in Settings or with `reelix channel unlink telegram`.");
				return { ...(await ctx.owner.pair()), bot: status.bot };
			},
			toText: (o: { code: string; bot?: string }) => `Send this code to ${o.bot ? `@${o.bot}` : "the bot"} within 10 minutes: ${o.code}`,
		});

		await ctx.operation({
			name: "test",
			summary: "Send a test message to the owner on Telegram",
			effect: "write",
			input: Type.Object({}),
			async run() {
				const r = await answering(() => sendTest());
				if (r) throw new OperationError("unavailable", r.outcome === "unavailable" ? r.message : `Telegram answered: ${r.outcome}`);
				return { result: "sent" };
			},
			toText: () => "Test message sent.",
		});

		await ctx.check("telegram", async () => {
			if (!tg) return { ok: null, detail: "not configured (optional)" };
			const linked = !!(await ctx.owner.of(CHANNEL));
			try {
				const me = await tg.getMe();
				return { ok: linked, detail: `bot @${me.username}${linked ? ", owner linked" : ", owner not linked yet"}` };
			} catch (e) {
				return { ok: false, detail: shown(e) };
			}
		});

		if (!tg) return;
		const handle = createUpdates(ctx, tg);

		// Ending after a failure is the normal way out: Reelix starts the loop again after a growing delay.
		await ctx.task("poll", async ({ signal }) => {
			try {
				status.bot = (await tg.getMe(signal)).username;
				let offset = (await ctx.kv.get<number>("offset")) ?? 0;
				while (!signal.aborted) {
					const updates = await tg.getUpdates(offset, POLL_SECONDS, signal);
					status.error = undefined;
					for (const u of updates) {
						offset = u.update_id + 1;
						await ctx.kv.set("offset", offset);
						await handle(u).catch((e: unknown) => ctx.log(`could not handle an update: ${shown(e)}`));
					}
				}
			} catch (e) {
				if (!signal.aborted) status.error = shown(e);
			}
		});
	},
});
