import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Reelix, addInbox, answerInbox, getInbox, kvGet, runOperation } from "@reelix/core";
import { type CannedAnswer, startPlugins } from "@reelix/plugin-testing";
import { webApp } from "../../../packages/server/src/http.ts";
import { isPushEndpoint } from "../src/webpush.ts";

const PLUGIN = join(import.meta.dirname, "..");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const APPLE = "https://web.push.apple.com/QAbc";
const FCM = "https://fcm.googleapis.com/fcm/send";
const ORIGIN = "https://nas.tail.ts.net";

/** What a browser holds, and how it reads a message (RFC 8291). */
function browser() {
	const ecdh = createECDH("prime256v1");
	const pub = ecdh.generateKeys();
	const auth = randomBytes(16);
	return {
		p256dh: b64(pub),
		auth: b64(auth),
		decrypt(msg: Uint8Array): string {
			const b = Buffer.from(msg);
			const salt = b.subarray(0, 16);
			const idlen = b[20]!;
			const as = b.subarray(21, 21 + idlen);
			const data = b.subarray(21 + idlen);
			const hkdf = (s: Uint8Array, k: Uint8Array, info: Uint8Array, n: number) => Buffer.from(hkdfSync("sha256", k, s, info, n));
			const ikm = hkdf(auth, ecdh.computeSecret(as), Buffer.concat([Buffer.from("WebPush: info\0"), pub, as]), 32);
			const d = createDecipheriv("aes-128-gcm", hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16), hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12));
			d.setAuthTag(data.subarray(-16));
			const plain = Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
			assert.equal(plain.at(-1), 2, "last-record delimiter");
			return plain.subarray(0, -1).toString();
		},
	};
}

const until = async (what: string, ok: () => boolean) => {
	for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
	assert.ok(ok(), `timed out waiting for ${what}`);
};
const service = (status = 201): CannedAnswer[] => [{ method: "POST", url: /^https:\/\/(web\.push\.apple\.com|fcm\.googleapis\.com)\//, status }];
const start = (http = service()) => startPlugins([PLUGIN], { http });
type T = Awaited<ReturnType<typeof start>>;

const subscribe = (t: T, endpoint: string, b = browser(), origin = ORIGIN, label?: string) => runOperation(t.app, "push.subscribe", { subscription: { endpoint, keys: { p256dh: b.p256dh, auth: b.auth } }, origin, label }, { actor: "owner:web", request: { origin } });
const stored = (t: T) => (t.kv("push", "devices") ?? []) as { id: string; endpoint: string; origin: string; last_ok_at?: string; last_error?: string }[];
const deliveries = (t: T, id: string) => t.app.db.prepare("SELECT provider, state, ref, error, attempts FROM notice_deliveries WHERE inbox_id = ?").all(id) as { provider: string; state: string; ref: string | null; error: string | null; attempts: number }[];
const sentTo = (t: T, url: string) => t.http.requests.filter((r) => r.url === url);

test("a choice or an urgent notice goes out with high priority, anything else with normal", async () => {
	const t = await start();
	try {
		await subscribe(t, APPLE);
		const urgency = async (item: Parameters<typeof addInbox>[1]) => {
			const before = sentTo(t, APPLE).length;
			addInbox(t.app, item);
			await until("the push", () => sentTo(t, APPLE).length > before);
			return sentTo(t, APPLE).at(-1)!.headers.urgency;
		};
		assert.equal(await urgency({ kind: "question", title: "Which?", options: ["a", "b"] }), "high");
		assert.equal(await urgency({ kind: "notice", title: "Disk full", payload: { urgent: true } }), "high");
		assert.equal(await urgency({ kind: "summary", title: "Last night" }), "normal");
	} finally {
		await t.close();
	}
});

test("only browser push services, only secure pages, valid keys, and only from a browser's own request", async () => {
	for (const ok of [APPLE, `${FCM}/x`, "https://updates.push.services.mozilla.com/wpush/v2/x", "https://db5.notify.windows.com/w/x"]) assert.ok(isPushEndpoint(ok), ok);
	for (const bad of ["http://web.push.apple.com/x", "https://web.push.apple.com.evil.test/x", "https://127.0.0.1/x", "https://web.push.apple.com:8443/x", "https://a@web.push.apple.com/x", "nonsense"]) assert.ok(!isPushEndpoint(bad), bad);
	const t = await start();
	try {
		const b = browser();
		const input = (endpoint: string, origin: string, keys = { p256dh: b.p256dh, auth: b.auth }) => ({ subscription: { endpoint, keys }, origin });
		const run = (i: unknown, o: { actor?: string; origin?: string } = {}) => runOperation(t.app, "push.subscribe", i, { actor: o.actor ?? "owner:web", request: o.origin ? { origin: o.origin } : undefined });
		await assert.rejects(run(input("https://evil.test/x", ORIGIN), { origin: ORIGIN }), /push service/);
		await assert.rejects(run(input(APPLE, "http://192.168.1.2:7878"), { origin: "http://192.168.1.2:7878" }), /HTTPS/);
		await assert.rejects(run(input(APPLE, ORIGIN, { p256dh: "AAAA", auth: b.auth }), { origin: ORIGIN }), /keys/);
		await assert.rejects(run(input(APPLE, "https://evil.test"), { origin: ORIGIN }), /web app/, "the page cannot claim another address");
		await assert.rejects(run(input(APPLE, ORIGIN)), /web app/, "no request: the CLI");
		await assert.rejects(run(input(APPLE, ORIGIN), { actor: "agent:t" }), /web app/, "the agent cannot sign up a device");
		assert.equal(stored(t).length, 0);
		assert.equal(t.info("push").failures, 0, "refusals are not failures");

		const first = (await subscribe(t, APPLE, b, ORIGIN, "iPhone")).output as { public_key: string; devices: { id: string; label: string }[] };
		const second = (await subscribe(t, APPLE, b, ORIGIN, "iPhone 2")).output as typeof first;
		assert.equal(second.devices[0]!.id, first.devices[0]!.id, "the same device is updated");
		assert.equal(stored(t).length, 1);
		const seen = JSON.stringify((await runOperation(t.app, "push.devices", {}, { actor: "agent:t" })).output);
		assert.doesNotMatch(seen, new RegExp(`${b.auth}|${b.p256dh}|QAbc`), "no keys or address");
		const ledger = JSON.stringify(t.app.db.prepare("SELECT input_json FROM actions WHERE op LIKE 'push.%'").all());
		assert.doesNotMatch(ledger, new RegExp(`${b.auth}|${b.p256dh}|QAbc`), "the ledger keeps neither");

		await assert.rejects(runOperation(t.app, "push.unsubscribe", { id: first.devices[0]!.id }, { actor: "agent:t" }), /owner/);
		await runOperation(t.app, "push.unsubscribe", { id: first.devices[0]!.id }, { actor: "owner:web" });
		assert.equal(stored(t).length, 0);
	} finally {
		await t.close();
	}
});

test("through the web route the origin is the checked one of the request", async () => {
	const t = await start();
	try {
		t.app.setSecret("web.password_hash", "x");
		const api = webApp({ app: t.app, host: {} as never, jobs: {} as never });
		const { makeSessionCookie } = await import("../../../packages/server/src/auth.ts");
		const cookie = makeSessionCookie(t.app, false).split(";")[0]!;
		const b = browser();
		const post = (origin: string, claimed: string, host = "nas.tail.ts.net") =>
			api.request(`http://${host}/api/op/push.subscribe`, { method: "POST", headers: { host, origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ subscription: { endpoint: APPLE, keys: { p256dh: b.p256dh, auth: b.auth } }, origin: claimed }) });
		assert.equal((await post("https://evil.test", "https://evil.test")).status, 403, "another site is refused before any operation");
		assert.equal((await post(ORIGIN, "https://evil.test")).status, 403, "the claim must match the request");
		assert.equal(stored(t).length, 0);
		assert.equal((await post(ORIGIN, ORIGIN)).status, 200);
		assert.equal(stored(t)[0]!.origin, ORIGIN);
		t.app.setConfig("web.allowed_origins", ["https://reelix.example"]);
		assert.equal((await post("https://reelix.example", "https://reelix.example", "10.0.0.2:7878")).status, 200, "a listed origin is allowed, as for every request");
	} finally {
		await t.close();
	}
});

test("an item that needs the owner reaches the device encrypted, signed, and opens that item", async () => {
	const t = await start();
	try {
		t.app.setConfig("language", "en");
		t.app.setSecret("tmdb.api_key", "super-secret-key-value");
		const b = browser();
		await subscribe(t, APPLE, b);

		addInbox(t.app, { kind: "notice", title: "Routine", body: "Nothing to do" });
		const q = addInbox(t.app, { kind: "question", title: "Which **version**?", body: `Pick one. key super-secret-key-value ${"x".repeat(400)}`, options: ["A", "B"] });
		await until("the send", () => deliveries(t, q.id).length === 1);
		assert.equal(sentTo(t, APPLE).length, 1, "routine notices stay in the Inbox");
		assert.deepEqual(deliveries(t, q.id).map((d) => [d.provider, d.state, d.ref]), [["push", "sent", null]]);
		const m = sentTo(t, APPLE)[0]!;
		assert.equal(m.headers["content-encoding"], "aes128gcm");
		assert.doesNotMatch(Buffer.from(m.bytes!).toString("latin1"), /version/, "the push service cannot read it");
		const n = JSON.parse(b.decrypt(m.bytes!));
		assert.equal(n.web_push, 8030, "declarative: iOS shows it without page code");
		assert.equal(n.notification.title, "Which version?");
		assert.equal(n.notification.navigate, `${ORIGIN}/inbox?item=${q.id}`);
		assert.equal(n.notification.tag, `inbox-${q.id}`);
		assert.equal(n.notification.lang, "en");
		assert.equal(n.notification.app_badge, "2", "the badge counts open items");
		assert.ok(n.notification.body.length <= 180);
		assert.doesNotMatch(n.notification.body, /super-secret/);

		// the signature checks out against the key browsers were given, for this push service
		const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(m.headers.authorization!)!;
		const { public_key } = (await runOperation(t.app, "push.devices", {}, { actor: "owner:web" })).output as { public_key: string };
		assert.equal(key, public_key);
		const [h, c, sig] = token!.split(".");
		const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
		assert.equal(claims.aud, "https://web.push.apple.com");
		assert.equal(claims.sub, ORIGIN, "a contact that is not the owner's e-mail");
		assert.ok(claims.exp - Date.now() / 1000 <= 86400);
		const raw = Buffer.from(key!, "base64url");
		const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64(raw.subarray(1, 33)), y: b64(raw.subarray(33)) }, format: "jwk" });
		assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url")));

		answerInbox(t.app, q.id, "A", "owner:web");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(sentTo(t, APPLE).length, 1, "answering sends nothing: iOS allows no silent push");
		assert.ok(stored(t)[0]!.last_ok_at);
	} finally {
		await t.close();
	}
});

test("the generated key is a redacted secret, kept, and storing it does not restart the plugin", async () => {
	const t = await start();
	try {
		const key = t.app.secrets["plugins.push.vapid_private"]!;
		assert.ok(key);
		assert.equal(t.app.redact(`x ${key} y`), "x [secret:plugins.push.vapid_private] y");
		await new Promise((r) => setTimeout(r, 30));
		await subscribe(t, APPLE);
		assert.equal(stored(t).length, 1);
		await t.manager.disable("push");
		await t.manager.enable("push");
		assert.equal(t.app.secrets["plugins.push.vapid_private"], key);
	} finally {
		await t.close();
	}
});

test("dispatcher: a failed send is retried once, only to the devices that lack it, and recorded", async () => {
	const gone = `${FCM}/gone`;
	const busy = `${FCM}/busy`;
	const t = await start([{ method: "POST", url: gone, status: 410 }, { method: "POST", url: busy, status: 503, body: "try later" }, ...service()]);
	t.app.notifications.retryMs = 30;
	try {
		for (const endpoint of [APPLE, gone, busy]) await subscribe(t, endpoint);
		const q = addInbox(t.app, { kind: "question", title: "Q" });
		await until("the first round", () => deliveries(t, q.id)[0]?.state === "unavailable");
		assert.match(deliveries(t, q.id)[0]!.error!, /503/);
		assert.deepEqual(stored(t).map((d) => d.endpoint), [APPLE, busy], "a device the service forgot is forgotten");
		assert.match(stored(t)[1]!.last_error!, /503/);
		t.http.answers.shift(); // the 410 is no longer needed
		t.http.answers.shift(); // the service recovers
		await until("the retry", () => deliveries(t, q.id)[0]?.state === "sent");
		assert.equal(deliveries(t, q.id)[0]!.attempts, 2);
		assert.equal(sentTo(t, APPLE).length, 1, "the device that had it is not told twice");
		assert.equal(sentTo(t, busy).length, 2);
		assert.equal(t.info("push").failures, 0, "a busy service is not the plugin's failure");

		// a second failure is final, and an item answered meanwhile is not retried
		t.http.answers.unshift({ method: "POST", url: busy, status: 503 });
		const r = addInbox(t.app, { kind: "question", title: "R" });
		await until("the first try", () => deliveries(t, r.id)[0]?.state === "unavailable");
		await until("the second try", () => deliveries(t, r.id)[0]?.attempts === 2);
		await new Promise((res) => setTimeout(res, 80));
		assert.equal(deliveries(t, r.id)[0]!.attempts, 2, "once, not more");
		const s = addInbox(t.app, { kind: "question", title: "S" });
		await until("its first try", () => deliveries(t, s.id)[0]?.state === "unavailable");
		answerInbox(t.app, s.id, "done", "owner:web");
		await new Promise((res) => setTimeout(res, 80));
		assert.equal(deliveries(t, s.id)[0]!.attempts, 1);
	} finally {
		await t.close();
	}
});

test("no device: nothing is sent and the record says the owner must act; a test goes to the chosen device", async () => {
	const t = await start();
	try {
		const q = addInbox(t.app, { kind: "question", title: "Q" });
		await until("the record", () => deliveries(t, q.id).length === 1);
		assert.equal(deliveries(t, q.id)[0]!.state, "needs_auth");
		await assert.rejects(runOperation(t.app, "push.test", {}, { actor: "owner:web" }), /No device/);
		await subscribe(t, APPLE);
		await subscribe(t, `${FCM}/other`);
		t.http.requests.length = 0;
		const r = (await runOperation(t.app, "push.test", { endpoint: APPLE }, { actor: "owner:web" })).output as { results: { ok: boolean }[] };
		assert.deepEqual(r.results.map((x) => x.ok), [true]);
		assert.deepEqual(t.http.requests.map((x) => x.url), [APPLE]);
	} finally {
		await t.close();
	}
});

test("switched off, it sends nothing", async () => {
	const t = await start();
	try {
		await subscribe(t, APPLE);
		await t.manager.disable("push");
		t.http.requests.length = 0;
		const q = addInbox(t.app, { kind: "question", title: "Q" });
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(t.http.requests.length, 0);
		assert.equal(deliveries(t, q.id).length, 0);
		assert.equal(getInbox(t.app, q.id)!.status, "open");
	} finally {
		await t.close();
	}
});

test("an old data folder: the devices and the signing key carry over", async () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-old-push-"));
	try {
		const first = new Reelix(root);
		first.close();
		const db = new DatabaseSync(join(root, "reelix.db"));
		db.exec("ALTER TABLE inbox ADD COLUMN telegram_message_id INTEGER; DROP TABLE notice_deliveries; DROP TABLE chat_channels; DROP TABLE reasons; DROP TABLE proposals; DROP TABLE trial_results; ALTER TABLE downloads DROP COLUMN downloader; ALTER TABLE titles DROP COLUMN ratings_json; ALTER TABLE titles ADD COLUMN douban_rating REAL; ALTER TABLE titles DROP COLUMN original_language; ALTER TABLE titles DROP COLUMN origin_country_json; ALTER TABLE titles DROP COLUMN genres_json; ALTER TABLE titles DROP COLUMN library_choice; UPDATE schema_version SET v = 6;");
		const b = browser();
		const device = { id: "dev_old", endpoint: APPLE, p256dh: b.p256dh, auth: b.auth, origin: ORIGIN, label: "Old phone", created_at: "2026-11-01T00:00:00Z" };
		db.prepare("INSERT INTO kv (k, v) VALUES ('push.devices', ?)").run(JSON.stringify([device]));
		db.close();
		const old = createECDH("prime256v1");
		old.generateKeys();
		const key = b64(old.getPrivateKey());
		writeFileSync(join(root, "secrets.yaml"), `push:\n  vapid_private: ${key}\n`);

		const app = new Reelix(root);
		const t = await startPlugins([PLUGIN], { app, http: service() });
		try {
			assert.equal(kvGet(app.db, "push.devices"), undefined);
			assert.equal(app.secrets["plugins.push.vapid_private"], key);
			assert.equal(app.secrets["push.vapid_private"], undefined);
			const out = (await runOperation(app, "push.devices", {}, { actor: "owner:web" })).output as { public_key: string; devices: { id: string }[] };
			assert.equal(out.public_key, b64(old.getPublicKey()), "browsers keep working with the same key");
			assert.deepEqual(out.devices.map((d) => d.id), ["dev_old"]);
			const q = addInbox(app, { kind: "question", title: "Hello again" });
			await until("the send", () => t.http.requests.length === 1);
			assert.equal(JSON.parse(b.decrypt(t.http.requests[0]!.bytes!)).notification.navigate, `${ORIGIN}/inbox?item=${q.id}`);
		} finally {
			await t.close();
			app.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
