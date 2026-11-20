import { createHash, randomBytes } from "node:crypto";
import { type Notice, type OperationCall, OperationError, type Outcome, type PluginContext, Type, definePlugin } from "@reelix/plugin";
import { encryptPush, isPushEndpoint, newVapidPrivateKey, validKeys, vapidAuthorization, vapidKey } from "./webpush.ts";

/*
 * Native notifications for the installed web app (docs/web-app.md), sent outward from the NAS.
 * Reelix's dispatcher decides what is sent and when it is tried again; this plugin knows the devices.
 */
type Device = { id: string; endpoint: string; p256dh: string; auth: string; origin: string; label: string; created_at: string; last_ok_at?: string; last_error?: string };
type Message = { title: string; body: string; path: string; tag: string; badge: number; urgent: boolean };
type Result = { id: string; ok: boolean; gone?: boolean; retry?: boolean; error?: string };

const DEVICES = "devices";
const MAX_DEVICES = 20;
/** Items whose second try is still to come: which devices already have them. */
const REMEMBERED_ITEMS = 50;
const SECURE_ORIGIN = /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const invalid = (message: string) => new OperationError("invalid_input", message);

const plainText = (s: string, n: number) => {
	const t = s.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** What the web app may see: no keys and no address. */
const publicDevice = (d: Device) => ({ id: d.id, label: d.label, service: new URL(d.endpoint).hostname, endpoint_id: createHash("sha256").update(d.endpoint).digest("hex").slice(0, 32), created_at: d.created_at, last_ok_at: d.last_ok_at, last_error: d.last_error });

const serviceOf = (endpoint: string | undefined) => (endpoint && URL.canParse(endpoint) ? new URL(endpoint).hostname : undefined);

function ownerOnly(call: OperationCall, what: string): void {
	if (!call.actor.startsWith("owner:")) throw new OperationError("owner_only", `${what} is done by the owner, in the web app.`);
}

async function vapid(ctx: PluginContext) {
	let key = await ctx.secret.get("vapid_private");
	if (!key) {
		key = newVapidPrivateKey();
		await ctx.secret.set("vapid_private", key);
	}
	return vapidKey(key);
}

export default definePlugin({
	async activate(ctx) {
		const key = await vapid(ctx);

		// Device changes wait for each other: sends to several devices finish at the same time.
		let changes: Promise<unknown> = Promise.resolve();
		const devices = async () => (await ctx.kv.get<Device[]>(DEVICES)) ?? [];
		const change = <T>(fn: (all: Device[]) => { next: Device[]; result: T }): Promise<T> => {
			const run = changes.then(async () => {
				const { next, result } = fn(await devices());
				await ctx.kv.set(DEVICES, next);
				return result;
			});
			changes = run.catch(() => undefined);
			return run;
		};
		const note = (id: string, update: Partial<Device>) => change((all) => ({ next: all.map((d) => (d.id === id ? { ...d, ...update } : d)), result: undefined }));
		const state = async () => ({ public_key: key.publicKey, devices: (await devices()).map(publicDevice) });

		async function sendTo(d: Device, m: Message, signal?: AbortSignal): Promise<Result> {
			const payload = {
				web_push: 8030,
				notification: { title: plainText(m.title, 100) || "Reelix", body: plainText(m.body, 180), navigate: new URL(m.path, d.origin).href, lang: ctx.t("lang"), silent: false, tag: m.tag, app_badge: String(m.badge) },
			};
			try {
				const res = await ctx.http.fetch(d.endpoint, {
					method: "POST",
					headers: { authorization: vapidAuthorization(key, d.endpoint, d.origin), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: m.urgent ? "high" : "normal" },
					body: encryptPush(Buffer.from(JSON.stringify(payload)), d.p256dh, d.auth),
					timeoutMs: 20_000,
					redirect: "manual",
					signal,
				});
				if (res.ok) {
					await note(d.id, { last_ok_at: new Date().toISOString(), last_error: undefined });
					return { id: d.id, ok: true };
				}
				if (res.status === 404 || res.status === 410) {
					await change((all) => ({ next: all.filter((x) => x.id !== d.id), result: undefined })); // the push service no longer knows it
					return { id: d.id, ok: false, gone: true, error: `gone (${res.status})` };
				}
				const text = Buffer.from(res.bytes).toString().slice(0, 160);
				const error = `push service answered ${res.status}${text ? `: ${text}` : ""}`;
				await note(d.id, { last_error: error });
				return { id: d.id, ok: false, retry: res.status === 429 || res.status >= 500, error };
			} catch (e) {
				if (signal?.aborted) throw e;
				const error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
				await note(d.id, { last_error: error });
				return { id: d.id, ok: false, retry: true, error };
			}
		}

		const sendAll = (list: Device[], m: Message, signal?: AbortSignal) => Promise.all(list.map((d) => sendTo(d, m, signal)));

		/** What a send to several devices comes to. */
		function outcomeOf(results: Result[]): Outcome | undefined {
			const failed = results.filter((r) => !r.ok && !r.gone);
			if (failed.some((r) => r.retry)) return { outcome: "unavailable", message: failed.find((r) => r.retry)!.error! };
			return failed.length && !results.some((r) => r.ok) ? { outcome: "needs_auth" } : undefined;
		}

		// A second try goes only to the devices that do not have the item yet.
		const delivered = new Map<string, Set<string>>();

		async function send(n: Notice, signal: AbortSignal): Promise<{ ref?: string } | Outcome> {
			const all = await devices();
			if (!all.length) return { outcome: "needs_auth" };
			const have = delivered.get(n.inboxId) ?? new Set<string>();
			const results = await sendAll(all.filter((d) => !have.has(d.id)), { title: n.title, body: n.body ?? "", path: n.path, tag: `inbox-${n.inboxId}`, badge: n.badge, urgent: n.urgent }, signal);
			for (const r of results) if (r.ok) have.add(r.id);
			const outcome = outcomeOf(results);
			delivered.delete(n.inboxId);
			if (outcome?.outcome === "unavailable") {
				delivered.set(n.inboxId, have);
				for (const old of delivered.keys()) if (delivered.size > REMEMBERED_ITEMS) delivered.delete(old);
			}
			return outcome ?? {};
		}

		const testMessage = (): Message => ({ title: ctx.t("testTitle"), body: ctx.t("testBody"), path: "/settings#notifications", tag: "push-test", badge: 0, urgent: true });

		await ctx.provide("reelix:notifier@1", {
			id: "push",
			label: "Web Push",
			can: { images: false, update: false, answers: false },
			send: (n, call) => send(n, call.signal),
		});

		await ctx.operation({
			name: "devices",
			summary: "The devices with native notifications turned on, and the key browsers subscribe with",
			effect: "read",
			input: Type.Object({}),
			run: state,
			toText: (o: Awaited<ReturnType<typeof state>>) => o.devices.map((d) => `${d.id} | ${d.label} | ${d.service} | ${d.last_error ?? d.last_ok_at ?? "not sent yet"}`).join("\n") || "No device has notifications turned on.",
		});

		await ctx.operation({
			name: "subscribe",
			summary: "Turn on notifications for the browser making this request (web app only)",
			effect: "write",
			input: Type.Object({
				subscription: Type.Object({ endpoint: Type.String(), keys: Type.Object({ p256dh: Type.String(), auth: Type.String() }) }),
				/** The page's own address; links and the signature's contact are built from it. */
				origin: Type.String(),
				label: Type.Optional(Type.String()),
			}),
			// The address and the keys are the device's credentials: they stay out of the ledger.
			recordInput: (i) => ({ service: serviceOf(i.subscription.endpoint), origin: i.origin, label: i.label }),
			async run(i, call) {
				// Reelix vouches for the origin of a browser's request; anything else cannot sign up a device.
				if (!call.request?.origin || call.request.origin !== i.origin) throw new OperationError("owner_only", "Notifications are turned on from the web app itself.");
				const { endpoint, keys } = i.subscription;
				if (!isPushEndpoint(endpoint)) throw invalid("That is not a known browser push service.");
				if (!SECURE_ORIGIN.test(i.origin)) throw invalid("Notifications need Reelix to be opened over HTTPS.");
				if (!validKeys(keys.p256dh, keys.auth)) throw invalid("The browser's push keys are not valid.");
				await change((all) => {
					const old = all.find((d) => d.endpoint === endpoint);
					const device: Device = { id: old?.id ?? `dev_${randomBytes(6).toString("hex")}`, endpoint, p256dh: keys.p256dh, auth: keys.auth, origin: i.origin, label: (i.label ?? "").trim().slice(0, 80) || "Device", created_at: old?.created_at ?? new Date().toISOString() };
					return { next: [...all.filter((d) => d.endpoint !== endpoint), device].slice(-MAX_DEVICES), result: undefined };
				});
				return state();
			},
			toText: () => "Notifications are on for this device.",
		});

		await ctx.operation({
			name: "unsubscribe",
			summary: "Turn off notifications for one device",
			effect: "write",
			input: Type.Object({ id: Type.Optional(Type.String()), endpoint: Type.Optional(Type.String()) }),
			recordInput: (i) => ({ id: i.id, service: serviceOf(i.endpoint) }),
			async run(i, call) {
				ownerOnly(call, "Turning off a device");
				await change((all) => ({ next: all.filter((d) => d.id !== i.id && d.endpoint !== i.endpoint), result: undefined }));
				return state();
			},
			toText: () => "Notifications are off for that device.",
		});

		await ctx.operation({
			name: "test",
			summary: "Send a test notification to every device, or to the one with this address",
			effect: "write",
			input: Type.Object({ endpoint: Type.Optional(Type.String()) }),
			recordInput: (i) => ({ service: serviceOf(i.endpoint) }),
			async run(i) {
				const list = (await devices()).filter((d) => !i.endpoint || d.endpoint === i.endpoint);
				if (!list.length) throw new OperationError("not_found", "No device has notifications turned on.");
				return { results: await sendAll(list, testMessage()) };
			},
			toText: (o: { results: Result[] }) => o.results.map((r) => `${r.id}: ${r.ok ? "sent" : r.error}`).join("\n"),
		});
	},
});
