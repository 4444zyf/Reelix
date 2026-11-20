/*
 * Reelix's service worker: native notifications only (docs/web-app.md). It does not cache anything,
 * because Reelix is a live connection to the NAS. iOS 18.4+ shows these declarative messages by
 * itself; this reads the same message everywhere else.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
	let n = {};
	try {
		n = e.data?.json()?.notification ?? {};
	} catch {}
	const badge = Number(n.app_badge);
	e.waitUntil(
		Promise.all([
			self.registration.showNotification(n.title || "Reelix", { body: n.body || "", tag: n.tag, lang: n.lang, silent: !!n.silent, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: n.navigate || "/inbox" } }),
			Number.isFinite(badge) && self.navigator.setAppBadge ? self.navigator.setAppBadge(badge).catch(() => {}) : undefined,
		]),
	);
});

self.addEventListener("notificationclick", (e) => {
	e.notification.close();
	const target = new URL(e.notification.data?.url || "/inbox", self.location.origin);
	const url = target.origin === self.location.origin ? target.href : new URL("/inbox", self.location.origin).href;
	e.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (all) => {
			const c = all[0];
			if (!c) return self.clients.openWindow(url);
			c.postMessage({ type: "reelix.navigate", url });
			return c.focus();
		}),
	);
});

// The browser replaced the subscription: tell Reelix, with the same key.
self.addEventListener("pushsubscriptionchange", (e) => {
	e.waitUntil(
		(async () => {
			const run = async (operation, input) => (await (await fetch(`/api/op/${operation}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).json()).output;
			const { public_key } = await run("push.devices", {});
			const key = Uint8Array.from(atob(public_key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
			const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
			await run("push.subscribe", { subscription: sub.toJSON(), origin: self.location.origin });
		})().catch(() => {}),
	);
});
