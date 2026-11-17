import { http } from "../http.ts";
import { ReelixError } from "../util.ts";

export type TgUpdate = {
	update_id: number;
	message?: TgMessage;
	callback_query?: { id: string; from: { id: number }; message?: TgMessage; data?: string };
};
export type TgMessage = {
	message_id: number;
	from?: { id: number; username?: string; first_name?: string };
	chat: { id: number; type: string };
	date: number;
	text?: string;
	caption?: string;
	photo?: { file_id: string; width: number; height: number }[];
	document?: { file_id: string; file_name?: string; mime_type?: string };
	reply_to_message?: TgMessage;
};
export type InlineButton = { text: string; callback_data: string };

/** A thin Telegram Bot API client. The bot connects outward only (long polling, §7.4). */
export class TelegramClient {
	private base: string;
	private fileBase: string;
	proxy?: string;
	constructor(opts: { token: string; apiUrl?: string; proxy?: string }) {
		const api = (opts.apiUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
		this.base = `${api}/bot${opts.token}`;
		this.fileBase = `${api}/file/bot${opts.token}`;
		this.proxy = opts.proxy;
	}

	private async call<T>(method: string, body?: Record<string, unknown> | FormData, timeoutMs = 20_000, signal?: AbortSignal): Promise<T> {
		const isForm = body instanceof FormData;
		const res = await http(`${this.base}/${method}`, {
			method: "POST",
			headers: isForm ? {} : { "content-type": "application/json" },
			body: isForm ? body : JSON.stringify(body ?? {}),
			timeoutMs,
			signal,
			proxy: this.proxy,
		});
		const data = await res.json<{ ok: boolean; result: T; description?: string }>();
		if (!data.ok) throw new ReelixError("telegram", `Telegram ${method}: ${data.description ?? res.status}`);
		return data.result;
	}

	getMe(): Promise<{ id: number; username: string }> {
		return this.call("getMe");
	}

	getUpdates(offset: number, timeoutS = 25, signal?: AbortSignal): Promise<TgUpdate[]> {
		return this.call("getUpdates", { offset, timeout: timeoutS, allowed_updates: ["message", "callback_query"] }, (timeoutS + 10) * 1000, signal);
	}

	sendMessage(chatId: number, text: string, buttons?: InlineButton[][], replyTo?: number): Promise<TgMessage> {
		return this.call("sendMessage", {
			chat_id: chatId,
			text: text.slice(0, 4000),
			reply_markup: buttons?.length ? { inline_keyboard: buttons } : undefined,
			reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
			link_preview_options: { is_disabled: true },
		});
	}

	sendPhoto(chatId: number, image: Uint8Array, caption: string, buttons?: InlineButton[][]): Promise<TgMessage> {
		const fd = new FormData();
		fd.append("chat_id", String(chatId));
		fd.append("caption", caption.slice(0, 1000));
		fd.append("photo", new Blob([image as BlobPart], { type: "image/png" }), "image.png");
		if (buttons?.length) fd.append("reply_markup", JSON.stringify({ inline_keyboard: buttons }));
		return this.call("sendPhoto", fd, 60_000);
	}

	sendChatAction(chatId: number, action = "typing"): Promise<boolean> {
		return this.call("sendChatAction", { chat_id: chatId, action });
	}

	answerCallback(id: string, text?: string): Promise<boolean> {
		return this.call("answerCallbackQuery", { callback_query_id: id, text });
	}

	editMessageText(chatId: number, messageId: number, text: string): Promise<unknown> {
		return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: text.slice(0, 4000) });
	}

	async downloadFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
		const f = await this.call<{ file_path: string }>("getFile", { file_id: fileId });
		const res = await http(`${this.fileBase}/${f.file_path}`, { proxy: this.proxy, timeoutMs: 60_000 });
		return { bytes: await res.bytes(), path: f.file_path };
	}
}
