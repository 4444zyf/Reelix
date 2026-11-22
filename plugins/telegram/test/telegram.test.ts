import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Reelix, addInbox, answerInbox, approvalRequest, channelRow, dismissInbox, doctor, getInbox, hasApproval, kvGet, runOperation, watchApprovals } from "@reelix/core";
import { linkChannel, startPlugins } from "@reelix/plugin-testing";
import { pluginSections, systemPrompt } from "../../../packages/server/src/agent/prompt.ts";
import { splitText } from "../src/client.ts";
import { type FakeTelegram, startFakeTelegram } from "./fake-telegram.ts";

const PLUGIN = join(import.meta.dirname, "..");
const TOKEN = "123456:test-bot-token";
const OWNER = 4242;
const STRANGER = 666;

const until = async (what: string, ok: () => boolean) => {
	for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
	assert.ok(ok(), `timed out waiting for ${what}`);
};
const settle = () => new Promise((r) => setTimeout(r, 60));
const deliveries = (t: { app: Reelix }, id: string) => t.app.db.prepare("SELECT provider, state, ref, error, attempts, closed_at FROM notice_deliveries WHERE inbox_id = ?").all(id) as { provider: string; state: string; ref: string | null; error: string | null; attempts: number; closed_at: string | null }[];

async function start(o: { linked?: boolean; app?: Reelix; tg?: FakeTelegram } = {}) {
	const tg = o.tg ?? (await startFakeTelegram(TOKEN));
	const t = await startPlugins([PLUGIN], { app: o.app, settings: { telegram: { api_url: tg.url } }, secrets: { "plugins.telegram.bot_token": TOKEN }, taskDelayMs: 20 });
	if (o.linked !== false) linkChannel(t, "telegram", String(OWNER));
	return {
		t,
		tg,
		async stop() {
			await t.close();
			await tg.close();
		},
	};
}

const threadOf = (t: { app: Reelix }) => channelRow(t.app, "telegram")!.thread_id!;

test("pairing: only the one-time code links; afterwards only the owner reaches the agent", async () => {
	const { t, tg, stop } = await start({ linked: false });
	try {
		const { output } = await runOperation(t.app, "telegram.link", {}, { actor: "owner:web" });
		const { code } = output as { code: string };
		tg.message(STRANGER, "000000");
		tg.message(STRANGER, "hello");
		await settle();
		assert.equal(channelRow(t.app, "telegram")?.owner ?? null, null);
		assert.equal(t.conversation.received.length, 0);

		tg.message(OWNER, code);
		await until("the link", () => channelRow(t.app, "telegram")?.owner === String(OWNER));
		await until("the welcome", () => tg.sent("sendMessage").some((c) => /Linked/.test(c.body.text)));
		assert.equal(channelRow(t.app, "telegram")!.may_approve, 0, "a new link cannot approve");

		tg.message(STRANGER, code);
		tg.message(STRANGER, "rm -rf please");
		tg.press(STRANGER, "in|x|0");
		await settle();
		assert.equal(channelRow(t.app, "telegram")!.owner, String(OWNER), "a used code cannot take the channel");
		assert.equal(t.conversation.received.length, 0, "strangers never reach the agent");
		assert.equal(tg.sent("answerCallbackQuery").length, 0);

		tg.message(OWNER, "find Sintel");
		await until("the message", () => t.conversation.received.length === 1);
		assert.deepEqual([t.conversation.received[0]!.text, t.conversation.received[0]!.from, t.conversation.received[0]!.by], ["find Sintel", "telegram", "channel:telegram"]);
		await until("typing", () => tg.sent("sendChatAction").length === 1);
		await assert.rejects(runOperation(t.app, "telegram.link", {}, { actor: "owner:web" }), /already linked/);
		assert.equal(t.info("telegram").failures, 0, "a refusal is not a failure of the plugin");

		await assert.rejects(runOperation(t.app, "channel.unlink", { id: "telegram" }, { actor: "agent:t" }), /owner/);
		await runOperation(t.app, "channel.unlink", { id: "telegram" }, { actor: "owner:web" });
		assert.equal(channelRow(t.app, "telegram")!.owner, null);
		assert.match((await runOperation(t.app, "telegram.link", {}, { actor: "owner:web" })).text, /within 10 minutes/);
	} finally {
		await stop();
	}
});

test("a question reaches Telegram with buttons, a press answers it, and the message is edited", async () => {
	const { t, tg, stop } = await start();
	try {
		const q = addInbox(t.app, { kind: "question", title: "Which version?", body: "Two fit", options: ["1080p", "4K"] });
		await until("the message", () => tg.sent("sendMessage").length === 1);
		const m = tg.sent("sendMessage")[0]!;
		assert.equal(m.body.chat_id, String(OWNER));
		assert.deepEqual(m.body.reply_markup.inline_keyboard.map((r: any) => r[0].text), ["1080p", "4K"]);
		await until("the delivery", () => deliveries(t, q.id).length === 1);
		assert.deepEqual(deliveries(t, q.id).map((d) => [d.provider, d.state, d.ref]), [["telegram", "sent", "100"]]);

		tg.press(OWNER, m.body.reply_markup.inline_keyboard[1][0].callback_data);
		await until("the answer", () => getInbox(t.app, q.id)!.status === "answered");
		assert.equal(getInbox(t.app, q.id)!.answer, "4K");
		await until("the edit", () => tg.sent("editMessageText").length === 1);
		const edit = tg.sent("editMessageText")[0]!.body;
		assert.equal(edit.message_id, 100);
		assert.match(edit.text, /Which version\?\n\n✓ answered: 4K/);
		assert.equal(edit.reply_markup, undefined, "the buttons go");
		await until("the toast", () => tg.sent("answerCallbackQuery").length === 1);
		assert.match(tg.sent("answerCallbackQuery")[0]!.body.text, /Answered: 4K/);
		await until("closed", () => !!deliveries(t, q.id)[0]!.closed_at);

		tg.press(OWNER, m.body.reply_markup.inline_keyboard[0][0].callback_data);
		await until("the second toast", () => tg.sent("answerCallbackQuery").length === 2);
		assert.match(tg.sent("answerCallbackQuery")[1]!.body.text, /Already handled/);
		assert.equal(getInbox(t.app, q.id)!.answer, "4K");
		assert.equal(t.info("telegram").failures, 0);
	} finally {
		await stop();
	}
});

test("a reply answers a notice; routine notices stay home; pictures go as photos and close by caption", async () => {
	const { t, tg, stop } = await start();
	const dir = mkdtempSync(join(tmpdir(), "reelix-tg-"));
	try {
		addInbox(t.app, { kind: "notice", title: "Routine" });
		const code = addInbox(t.app, { kind: "verification", title: "Type the code" });
		await until("the message", () => tg.sent("sendMessage").length === 1);
		assert.match(tg.sent("sendMessage")[0]!.body.text, /Type the code\n\n\(Reply to this message to answer\.\)/);
		await until("the delivery", () => deliveries(t, code.id)[0]?.ref === "100");
		tg.message(OWNER, "x7k2", { reply_to_message: { message_id: 100, chat: { id: OWNER, type: "private" }, date: 0 } });
		await until("the answer", () => getInbox(t.app, code.id)!.status === "answered");
		assert.equal(getInbox(t.app, code.id)!.answer, "x7k2");
		await until("the thanks", () => tg.sent("sendMessage").some((c) => c.body.text === "Got it."));
		assert.equal(t.conversation.received.length, 0, "the answer does not also go to the agent");

		const image = join(dir, "shot.png");
		writeFileSync(image, Buffer.from([1, 2, 3]));
		const pic = addInbox(t.app, { kind: "question", title: "Is this right?", image_path: image, options: ["Yes"] });
		await until("the photo", () => tg.sent("sendPhoto").length === 1);
		assert.deepEqual([...tg.sent("sendPhoto")[0]!.photo!], [1, 2, 3]);
		assert.equal(JSON.parse(tg.sent("sendPhoto")[0]!.body.reply_markup).inline_keyboard[0][0].text, "Yes");
		await until("the delivery", () => deliveries(t, pic.id)[0]?.state === "sent");
		tg.failNext("editMessageText", { status: 400, description: "Bad Request: there is no text in the message to edit" });
		dismissInbox(t.app, pic.id);
		await until("the caption", () => tg.sent("editMessageCaption").length === 1);
		assert.match(tg.sent("editMessageCaption")[0]!.body.caption, /✓ dismissed/);
	} finally {
		await stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("chat: a long reply is split, not cut; cards are text; photos reach the agent; a question's button answers it", async () => {
	const { t, tg, stop } = await start();
	try {
		tg.message(OWNER, "hi");
		await until("the message", () => t.conversation.received.length === 1);
		const thread = threadOf(t);
		const long = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ") + "\n" + "y".repeat(9000);
		t.conversation.reply(thread, long);
		await until("every part", () => tg.sent("sendMessage").map((c) => c.body.text).join("").replace(/\s/g, "").length >= long.replace(/\s/g, "").length);
		const parts = tg.sent("sendMessage").map((c) => c.body.text as string);
		assert.ok(parts.length >= 4, "several messages");
		assert.ok(parts.every((p) => p.length <= 4000));
		assert.equal(parts.join("").replace(/\s/g, ""), long.replace(/\s/g, ""), "nothing is lost, in order");

		t.conversation.emit(thread, { type: "card", card: { kind: "releases", pick: "r1", releases: [{ handle: "r1", title: "Sintel.2010.1080p" }] } });
		await until("the card", () => tg.sent("sendMessage").some((c) => c.body.text === "r1 ★ Sintel.2010.1080p"));

		t.conversation.ask(thread, { id: "q_1", question: "Which one?", kind: "choice", options: ["A", "B"] });
		await until("the question", () => tg.sent("sendMessage").some((c) => c.body.text === "Which one?"));
		tg.press(OWNER, "q|q_1|1");
		await until("the answer", () => t.conversation.answers.length === 1);
		assert.deepEqual(t.conversation.answers[0], { threadId: thread, id: "q_1", value: "B", by: "channel:telegram" });
		tg.press(OWNER, "q|q_1|0");
		await until("closed", () => tg.sent("answerCallbackQuery").some((c) => /closed/.test(c.body.text)));

		tg.message(OWNER, "", { text: undefined, caption: "look", photo: [{ file_id: "f", width: 1, height: 1 }] });
		await until("the photo", () => t.conversation.received.length === 2);
		assert.deepEqual([t.conversation.received[1]!.text, t.conversation.received[1]!.images], ["look", 1]);
	} finally {
		await stop();
	}
});

test("a question asking for a secret is never sent; the channel is sent to the web app", async () => {
	const { t, tg, stop } = await start();
	try {
		tg.message(OWNER, "hi");
		await until("the message", () => t.conversation.received.length === 1);
		t.conversation.ask(threadOf(t), { id: "q_s", question: "Your hunter2-style tracker password?", kind: "secret" });
		await until("the pointer", () => tg.sent("sendMessage").length === 1);
		const m = tg.sent("sendMessage")[0]!.body;
		assert.match(m.text, /web app/);
		assert.doesNotMatch(m.text, /tracker password/);
		assert.equal(m.reply_markup, undefined);
		tg.message(OWNER, "hunter2");
		await until("the typed text", () => t.conversation.received.length === 2);
		assert.equal(t.conversation.answers.length, 0, "typing in the chat does not answer a secret question");
	} finally {
		await stop();
	}
});

test("a chat send that fails is recorded and shown, and clears when one gets through", async () => {
	const { t, tg, stop } = await start();
	try {
		tg.message(OWNER, "hi");
		await until("the message", () => t.conversation.received.length === 1);
		tg.failNext("sendMessage", { status: 400, description: "Bad Request: chat not found" });
		t.conversation.reply(threadOf(t), "lost");
		await until("the error", () => !!channelRow(t.app, "telegram")!.last_error);
		const listed = (await runOperation(t.app, "channel.list", {}, { actor: "owner:web" })).output as { id: string; last_error?: string; linked: boolean }[];
		assert.match(listed.find((c) => c.id === "telegram")!.last_error!, /chat not found/);
		assert.equal(t.info("telegram").failures, 0, "an outside failure is not the plugin's");
		t.conversation.reply(threadOf(t), "back");
		await until("the clear", () => channelRow(t.app, "telegram")!.last_error === null);
	} finally {
		await stop();
	}
});

test("approval: an answer on Telegram makes a record only with the channel's switch on", async () => {
	const { t, tg, stop } = await start();
	watchApprovals(t.app);
	const expires = new Date(Date.now() + 60_000).toISOString();
	const ask = (plan: string) => addInbox(t.app, { kind: "question", title: `Apply ${plan}?`, options: ["Approve", "Decline"], payload: { approval: approvalRequest("magpie.apply", { plan }, "agent:t", expires) } });
	try {
		const first = ask("p1");
		await until("the delivery", () => deliveries(t, first.id)[0]?.state === "sent");
		tg.press(OWNER, `in|${first.id}|0`);
		await until("the refusal", () => tg.sent("answerCallbackQuery").some((c) => /web app/.test(c.body.text)));
		assert.equal(getInbox(t.app, first.id)!.status, "open", "it stays open for the web app");
		assert.equal(hasApproval(t.app, "magpie.apply", { plan: "p1" }, "agent:t"), false);
		tg.press(OWNER, `in|${first.id}|1`);
		await until("the decline", () => getInbox(t.app, first.id)!.status === "answered");
		assert.equal(getInbox(t.app, first.id)!.answer, "Decline", "saying no needs no switch");

		await assert.rejects(runOperation(t.app, "channel.allow_approval", { id: "telegram", allowed: true }, { actor: "agent:t" }), /owner/);
		await runOperation(t.app, "channel.allow_approval", { id: "telegram", allowed: true }, { actor: "owner:web" });
		const second = ask("p2");
		await until("the delivery", () => deliveries(t, second.id)[0]?.state === "sent");
		tg.press(OWNER, `in|${second.id}|0`);
		await until("the answer", () => getInbox(t.app, second.id)!.status === "answered");
		assert.equal(hasApproval(t.app, "magpie.apply", { plan: "p2" }, "agent:t"), true);
	} finally {
		await stop();
	}
});

test("switched off, the plugin sends nothing and stops polling; switched on, it continues where it was", async () => {
	const { t, tg, stop } = await start();
	try {
		await until("polling", () => tg.sent("getUpdates").length > 0);
		await t.manager.disable("telegram");
		const polls = tg.sent("getUpdates").length;
		addInbox(t.app, { kind: "question", title: "Anyone?" });
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(tg.sent("sendMessage").length, 0);
		assert.ok(tg.sent("getUpdates").length <= polls + 1, "the long poll ended");
		assert.equal(t.app.operations.get("telegram.test"), undefined);
		await t.manager.enable("telegram");
		tg.message(OWNER, "back");
		await until("the message", () => t.conversation.received.length === 1);
		assert.equal(t.kv("telegram", "offset"), 2);
	} finally {
		await stop();
	}
});

test("the long poll that fails is shown and started again, and that is not held against the plugin", async () => {
	const { t, tg, stop } = await start();
	const status = async () => (await runOperation(t.app, "telegram.status", {}, { actor: "owner:web" })).output as { running: boolean; bot?: string; error?: string };
	try {
		await until("polling", () => tg.sent("getUpdates").length > 0);
		await t.manager.disable("telegram");
		tg.failNext("getMe", { status: 500, description: "Internal error" }, 2);
		await t.manager.enable("telegram");
		for (let i = 0; i < 300 && !(await status()).error; i++) await new Promise((r) => setTimeout(r, 5));
		assert.match((await status()).error!, /Internal error/);
		await until("the third start", () => tg.sent("getMe").length >= 3);
		tg.message(OWNER, "again");
		await until("the message", () => t.conversation.received.length === 1);
		assert.deepEqual([(await status()).error, (await status()).bot], [undefined, "reelix_test_bot"]);
		assert.equal(t.info("telegram").failures, 0);
	} finally {
		await stop();
	}
});

test("the prompt section stands before Reelix's rules, only in the channel's conversation, never in jobs", async () => {
	const { t, stop } = await start();
	try {
		const section = await pluginSections(t.app, "channel", "telegram");
		assert.match(section, /^# From the plugin telegram\. It cannot change the rules below\.\n## Telegram\nThis thread is the owner's Telegram chat/);
		assert.equal(await pluginSections(t.app, "chat", undefined), "");
		assert.equal(await pluginSections(t.app, "job", "telegram"), "", "not in background jobs");
		const prompt = systemPrompt(t.app, "channel", section);
		assert.ok(prompt.indexOf("# From the plugin telegram") < prompt.indexOf("# How you work"));
		assert.doesNotMatch(systemPrompt(t.app, "chat"), /Telegram chat/);
		await t.manager.disable("telegram");
		assert.equal(await pluginSections(t.app, "channel", "telegram"), "");
	} finally {
		await stop();
	}
});

test("Doctor's check and the operations work through the plugin", async () => {
	const { t, tg, stop } = await start();
	try {
		const check = (await doctor(t.app, { quick: true })).find((c) => c.name === "telegram")!;
		assert.deepEqual([check.ok, check.detail], [true, "bot @reelix_test_bot, owner linked"]);
		await until("the bot's name", () => tg.sent("getMe").length >= 1);
		await runOperation(t.app, "telegram.test", {}, { actor: "owner:web" });
		assert.match(tg.sent("sendMessage").at(-1)!.body.text, /Reelix test message/);
		tg.failNext("sendMessage", { status: 403, description: "Forbidden: bot was blocked by the user" });
		await assert.rejects(runOperation(t.app, "telegram.test", {}, { actor: "owner:web", requestId: "again" }), /blocked/);
		assert.equal(t.info("telegram").failures, 0);
	} finally {
		await stop();
	}
});

test("text is split at line and word ends, within the limit, without losing anything", () => {
	assert.deepEqual(splitText("short"), ["short"]);
	assert.deepEqual(splitText("aaaa bbbb cccc", 9), ["aaaa bbbb", "cccc"]);
	assert.deepEqual(splitText("x".repeat(10), 4), ["xxxx", "xxxx", "xx"]);
	const emoji = "😀".repeat(5);
	assert.equal(splitText(emoji, 3).join(""), emoji, "never between the halves of an emoji");
});

test("an old data folder: bot, owner, offset, conversation and sent messages all carry over", async () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-old-tg-"));
	const tg = await startFakeTelegram(TOKEN, { firstUpdate: 41 });
	try {
		// What the version before plugins left behind.
		const first = new Reelix(root);
		first.close();
		const db = new DatabaseSync(join(root, "reelix.db"));
		assert.equal((db.prepare("SELECT v FROM schema_version").get() as { v: number }).v, 12);
		db.exec("ALTER TABLE inbox ADD COLUMN telegram_message_id INTEGER; DROP TABLE notice_deliveries; DROP TABLE chat_channels; DROP TABLE reasons; DROP TABLE proposals; DROP TABLE trial_results; ALTER TABLE downloads DROP COLUMN downloader; ALTER TABLE titles DROP COLUMN ratings_json; ALTER TABLE titles ADD COLUMN douban_rating REAL; ALTER TABLE titles DROP COLUMN original_language; ALTER TABLE titles DROP COLUMN origin_country_json; ALTER TABLE titles DROP COLUMN genres_json; ALTER TABLE titles DROP COLUMN library_choice; UPDATE schema_version SET v = 6;");
		db.prepare("INSERT INTO inbox (id, kind, title, status, telegram_message_id, created_at) VALUES ('in_old', 'question', 'Old question', 'open', 55, '2026-11-01T00:00:00Z')").run();
		db.prepare("INSERT INTO threads (id, name, kind, created_at, updated_at) VALUES ('t_tg', 'Telegram', 'telegram', 'x', 'x')").run();
		for (const [k, v] of [["telegram.offset", "41"], ["telegram.thread", "t_tg"]]) db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run(k, v);
		db.close();
		writeFileSync(join(root, "config.yaml"), `telegram:\n  owner_id: ${OWNER}\n  api_url: ${tg.url}\n`);
		writeFileSync(join(root, "secrets.yaml"), `telegram:\n  bot_token: "${TOKEN}"\n`);

		const app = new Reelix(root);
		const { t, stop } = await start({ app, tg, linked: false });
		try {
			assert.equal(app.config.plugins.telegram && (app.config.plugins.telegram as { api_url: string }).api_url, tg.url);
			assert.equal(app.secrets["plugins.telegram.bot_token"], TOKEN);
			assert.equal(app.secrets["telegram.bot_token"], undefined);
			const row = channelRow(app, "telegram")!;
			assert.deepEqual([row.owner, row.may_approve, row.thread_id], [String(OWNER), 1, "t_tg"], "an existing link keeps Magpie approvals working");
			assert.equal((app.db.prepare("SELECT kind FROM threads WHERE id = 't_tg'").get() as { kind: string }).kind, "channel");
			assert.equal(t.kv("telegram", "offset"), 41);
			assert.equal(kvGet(app.db, "telegram.thread"), undefined);
			assert.deepEqual(deliveries(t, "in_old").map((d) => [d.provider, d.state, d.ref]), [["telegram", "sent", "55"]]);

			// a reply to the old message still answers it, and closing edits the old message
			tg.message(OWNER, "yes", { reply_to_message: { message_id: 55, chat: { id: OWNER, type: "private" }, date: 0 } });
			await until("the answer", () => getInbox(app, "in_old")!.status === "answered");
			await until("the edit", () => tg.sent("editMessageText").some((c) => c.body.message_id === 55));
			tg.message(OWNER, "hello");
			await until("the conversation", () => t.conversation.received.length === 1);
			assert.equal(t.conversation.received[0]!.by, "owner:telegram");
		} finally {
			await stop();
			app.close();
		}
		const again = new Reelix(root);
		assert.equal(channelRow(again, "telegram")!.owner, String(OWNER), "it stays after the old settings are gone");
		again.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("answering while the message is on its way still closes it", async () => {
	const { t, tg, stop } = await start();
	try {
		const q = addInbox(t.app, { kind: "question", title: "Quick?", options: ["Yes"] });
		answerInbox(t.app, q.id, "Yes", "owner:web");
		await until("the edit", () => tg.sent("editMessageText").length === 1);
	} finally {
		await stop();
	}
});
