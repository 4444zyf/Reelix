import { createECDH, randomBytes } from "node:crypto";
import { runOperation } from "@reelix/core";
import type { PluginCheck } from "@reelix/plugin-testing";

/** Answers recorded from the browsers' push services, for `reelix plugin check`. */
const APPLE = "https://web.push.apple.com/QAbc";
const ORIGIN = "https://nas.tail.ts.net";

export default {
	http: [{ method: "POST", url: /^https:\/\/(web\.push\.apple\.com|fcm\.googleapis\.com)\//, status: 201 }],
	/** A browser that subscribed, so there is a device to send to. */
	async prepare(t) {
		const keys = { p256dh: createECDH("prime256v1").generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url") };
		await runOperation(t.app, "push.subscribe", { subscription: { endpoint: APPLE, keys }, origin: ORIGIN }, { actor: "owner:web", request: { origin: ORIGIN } });
	},
	seams: {
		"reelix:notifier@1": { provider: "push" },
	},
} satisfies PluginCheck;
