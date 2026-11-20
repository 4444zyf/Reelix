import type { PluginContext } from "@reelix/plugin";

export type TgMessage = {
	message_id: number;
	from?: { id: number; username?: string; first_name?: string };
	chat: { id: number; type: string };
	date: number;
	text?: string;
	caption?: string;
	photo?: { file_id: string; width: number; height: number }[];
	reply_to_message?: TgMessage;
};
export type TgCallback = { id: string; from: { id: number }; message?: TgMessage; data?: string };
export type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallback };
export type InlineButton = { text: string; callback_data: string };

/** Telegram said no. `retryAfter`: seconds it asks to wait. */
export class TelegramError extends Error {
	status: number;
	retryAfter?: number;
	constructor(message: string, status: number, retryAfter?: number) {
		super(message);
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

export const TEXT_LIMIT = 4000;
export const CAPTION_LIMIT = 1000;

/** Cut text into pieces Telegram accepts, at a line or word end when there is one. Nothing is dropped. */
export function splitText(text: string, limit = TEXT_LIMIT): string[] {
	const parts: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		let cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
		if (cut < limit / 2) cut = limit;
		const code = rest.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut--; // never between the halves of an emoji
		parts.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest || !parts.length) parts.push(rest);
	return parts;
}

function multipart(fields: Record<string, string>, file: { name: string; filename: string; type: string; bytes: Uint8Array }) {
	const boundary = `reelix${crypto.randomUUID().replaceAll("-", "")}`;
	const chunks: Buffer[] = [];
	for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
	chunks.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\ncontent-type: ${file.type}\r\n\r\n`), Buffer.from(file.bytes), Buffer.from(`\r\n--${boundary}--\r\n`));
	return { body: new Uint8Array(Buffer.concat(chunks)), type: `multipart/form-data; boundary=${boundary}` };
}

/** The Telegram Bot API. The bot connects outward only (long polling). */
export function telegramClient(ctx: PluginContext, apiUrl: string, token: string) {
	const api = apiUrl.replace(/\/+$/, "");
	const stopped = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, ctx.signal]) : ctx.signal);

	async function call<T>(method: string, o: { json?: Record<string, unknown>; form?: ReturnType<typeof multipart>; timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
		const res = await ctx.http.fetch(`${api}/bot${token}/${method}`, {
			method: "POST",
			headers: { "content-type": o.form?.type ?? "application/json" },
			body: o.form?.body ?? JSON.stringify(o.json ?? {}),
			timeoutMs: o.timeoutMs ?? 20_000,
			signal: stopped(o.signal),
		});
		let data: { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
		try {
			data = JSON.parse(Buffer.from(res.bytes).toString());
		} catch {
			throw new TelegramError(`Telegram ${method}: answered ${res.status}`, res.status);
		}
		if (!data.ok) throw new TelegramError(`Telegram ${method}: ${data.description ?? res.status}`, res.status, data.parameters?.retry_after);
		return data.result as T;
	}

	const keyboard = (buttons?: InlineButton[][]) => (buttons?.length ? { inline_keyboard: buttons } : undefined);

	return {
		getMe: (signal?: AbortSignal) => call<{ id: number; username: string }>("getMe", { signal }),
		getUpdates: (offset: number, timeoutS: number, signal: AbortSignal) => call<TgUpdate[]>("getUpdates", { json: { offset, timeout: timeoutS, allowed_updates: ["message", "callback_query"] }, timeoutMs: (timeoutS + 10) * 1000, signal }),
		/** One message of at most TEXT_LIMIT characters. */
		sendMessage: (chatId: string | number, text: string, o: { buttons?: InlineButton[][]; replyTo?: number; signal?: AbortSignal } = {}) =>
			call<TgMessage>("sendMessage", {
				json: { chat_id: chatId, text, reply_markup: keyboard(o.buttons), reply_parameters: o.replyTo ? { message_id: o.replyTo, allow_sending_without_reply: true } : undefined, link_preview_options: { is_disabled: true } },
				signal: o.signal,
			}),
		sendPhoto(chatId: string | number, image: Uint8Array, caption: string, o: { buttons?: InlineButton[][]; signal?: AbortSignal } = {}) {
			const fields: Record<string, string> = { chat_id: String(chatId), caption };
			if (o.buttons?.length) fields.reply_markup = JSON.stringify(keyboard(o.buttons));
			return call<TgMessage>("sendPhoto", { form: multipart(fields, { name: "photo", filename: "image.png", type: "image/png", bytes: image }), timeoutMs: 60_000, signal: o.signal });
		},
		sendChatAction: (chatId: string | number, signal?: AbortSignal) => call<boolean>("sendChatAction", { json: { chat_id: chatId, action: "typing" }, signal }),
		answerCallback: (id: string, text?: string) => call<boolean>("answerCallbackQuery", { json: { callback_query_id: id, text } }),
		editText: (chatId: string | number, messageId: number, text: string, signal?: AbortSignal) => call<unknown>("editMessageText", { json: { chat_id: chatId, message_id: messageId, text: text.slice(0, TEXT_LIMIT) }, signal }),
		editCaption: (chatId: string | number, messageId: number, caption: string, signal?: AbortSignal) => call<unknown>("editMessageCaption", { json: { chat_id: chatId, message_id: messageId, caption: caption.slice(0, CAPTION_LIMIT) }, signal }),
		async downloadFile(fileId: string): Promise<Uint8Array> {
			const f = await call<{ file_path: string }>("getFile", { json: { file_id: fileId } });
			const res = await ctx.http.fetch(`${api}/file/bot${token}/${f.file_path}`, { timeoutMs: 60_000, signal: ctx.signal });
			if (!res.ok) throw new TelegramError(`Telegram file: answered ${res.status}`, res.status);
			return res.bytes;
		},
	};
}

export type TelegramClient = ReturnType<typeof telegramClient>;
