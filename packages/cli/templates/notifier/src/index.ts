import { Type, definePlugin } from "@reelix/plugin";
import type { Outcome } from "@reelix/plugin";

/**
 * A notifier that posts each notice as JSON to an address the owner types in its settings.
 * `network: ["config:url"]` lets it reach that address, even on the home network.
 * Without an address it provides nothing, and Reelix sends to the other notifiers.
 */
export default definePlugin({
	config: Type.Object({ url: Type.String({ default: "" }) }),
	async activate(ctx, settings) {
		if (!settings.url) return;
		await ctx.provide("reelix:notifier@1", {
			id: "example-notifier",
			label: "Example notifier",
			can: { images: false, update: false, answers: false },
			async send(n, call): Promise<{ ref?: string } | Outcome> {
				const token = await ctx.secret.get("token");
				const res = await ctx.http.fetch(settings.url, {
					method: "POST",
					signal: call.signal,
					headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
					body: JSON.stringify({ title: n.title, body: n.body, urgent: n.urgent, path: n.path }),
				});
				if (res.status === 401 || res.status === 403) return { outcome: "needs_auth" };
				if (res.status === 429) return { outcome: "rate_limited" };
				if (!res.ok) return { outcome: "unavailable", message: ctx.t("httpError", { status: res.status }) };
				return {};
			},
		});
	},
});
