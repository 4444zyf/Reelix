import { formOf, sendJson, startServer } from "../../../packages/core/test/fakes/server.ts";

export type TgCall = { method: string; body: Record<string, any>; photo?: Uint8Array };

/** A stand-in for the Telegram Bot API, over real HTTP: it records calls, and long polling really waits. */
export async function startFakeTelegram(token: string, o: { firstUpdate?: number } = {}) {
	const calls: TgCall[] = [];
	let updates: Record<string, any>[] = [];
	const failures = new Map<string, { status: number; description: string; retry_after?: number }[]>();
	let waiting: (() => void) | undefined;
	let nextMessage = 100;
	let nextUpdate = o.firstUpdate ?? 1;
	const FILE = new Uint8Array([9, 8, 7]);

	const server = await startServer(async (req, res) => {
		if (req.url.pathname === `/file/bot${token}/photos/1.jpg`) {
			res.writeHead(200, { "content-type": "image/jpeg" });
			res.end(FILE);
			return;
		}
		const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url.pathname);
		if (!m || m[1] !== token) return sendJson(res, 401, { ok: false, description: "Unauthorized" });
		const method = m[2]!;
		let body: Record<string, any> = {};
		let photo: Uint8Array | undefined;
		if (String(req.headers["content-type"]).startsWith("multipart/")) {
			const form = await formOf(req);
			for (const [k, v] of form) {
				if (typeof v === "string") body[k] = v;
				else photo = new Uint8Array(await v.arrayBuffer());
			}
		} else body = JSON.parse(req.body.toString() || "{}");
		if (method === "getUpdates") {
			// As in Telegram, an update stays until a later offset confirms it.
			updates = updates.filter((u) => u.update_id >= (body.offset ?? 0));
			if (!updates.length) await Promise.race([new Promise<void>((r) => (waiting = r)), new Promise((r) => setTimeout(r, 300))]);
			calls.push({ method, body });
			return sendJson(res, 200, { ok: true, result: updates.filter((u) => u.update_id >= (body.offset ?? 0)) });
		}
		calls.push({ method, body, photo });
		const fail = failures.get(method)?.shift();
		if (fail) return sendJson(res, fail.status, { ok: false, description: fail.description, parameters: fail.retry_after ? { retry_after: fail.retry_after } : undefined });
		switch (method) {
			case "getMe":
				return sendJson(res, 200, { ok: true, result: { id: 1, username: "reelix_test_bot" } });
			case "sendMessage":
			case "sendPhoto":
				return sendJson(res, 200, { ok: true, result: { message_id: nextMessage++, chat: { id: Number(body.chat_id), type: "private" }, date: 0 } });
			case "getFile":
				return sendJson(res, 200, { ok: true, result: { file_path: "photos/1.jpg" } });
			default:
				return sendJson(res, 200, { ok: true, result: true });
		}
	});

	const push = (u: Record<string, unknown>) => {
		updates.push({ update_id: nextUpdate++, ...u });
		waiting?.();
	};
	return {
		url: server.url,
		close: server.close,
		calls,
		sent: (method: string) => calls.filter((c) => c.method === method),
		failNext: (method: string, f: { status: number; description: string; retry_after?: number }, times = 1) => failures.set(method, Array.from({ length: times }, () => f)),
		/** Someone writes to the bot. */
		message: (from: number, text: string, extra: Record<string, unknown> = {}) => push({ message: { message_id: nextMessage++, from: { id: from }, chat: { id: from, type: "private" }, date: 0, text, ...extra } }),
		/** Someone presses a button. */
		press: (from: number, data: string) => push({ callback_query: { id: `cb${nextUpdate}`, from: { id: from }, data } }),
	};
}

export type FakeTelegram = Awaited<ReturnType<typeof startFakeTelegram>>;
