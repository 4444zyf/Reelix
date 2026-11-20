import type { PluginCheck } from "@reelix/plugin-testing";

/** Answers recorded from Telegram's Bot API, for `reelix plugin check`. */
const TOKEN = "123456:test-bot-token";
const OWNER = 4242;
const api = `https://api.telegram.org/bot${TOKEN}`;
const ok = (result: unknown) => JSON.stringify({ ok: true, result });

export default {
	secrets: { bot_token: TOKEN },
	http: [
		{ method: "POST", url: `${api}/sendMessage`, body: ok({ message_id: 7, chat: { id: OWNER, type: "private" }, date: 0 }) },
		{ method: "POST", url: `${api}/editMessageText`, body: ok(true) },
		{ method: "POST", url: `${api}/sendChatAction`, body: ok(true) },
	],
	seams: {
		"reelix:notifier@1": { provider: "telegram" },
		"reelix:chat.channel@1": { provider: "telegram", owner: String(OWNER) },
	},
} satisfies PluginCheck;
