import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { endpoints } from "./api";

/* The installed web app and native notifications (docs/web-app.md). */

export type PushState = "needs_https" | "needs_install" | "unsupported" | "denied" | "off" | "on";

export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isInstalled = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const hasPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function worker(): Promise<ServiceWorkerRegistration> {
	return navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready);
}

async function current(): Promise<PushSubscription | null> {
	const reg = await navigator.serviceWorker.getRegistration();
	return (await reg?.pushManager.getSubscription()) ?? null;
}

const keyBytes = (k: string) => Uint8Array.from(atob(k.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function endpointId(endpoint: string): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
	return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** What stands between this device and notifications. Known devices are matched by a hash of their address. */
export async function pushState(known: { endpoint_id: string }[] = []): Promise<PushState> {
	if (!window.isSecureContext) return "needs_https";
	if (isIos() && !isInstalled()) return "needs_install";
	if (!hasPush()) return "unsupported";
	if (Notification.permission === "denied") return "denied";
	if (Notification.permission !== "granted") return "off";
	const sub = await current();
	if (!sub) return "off";
	const id = await endpointId(sub.endpoint);
	return known.some((d) => d.endpoint_id === id) ? "on" : "off";
}

export function deviceLabel(): string {
	const ua = navigator.userAgent;
	const os = /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? (isIos() ? "iPad" : "Mac") : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
	const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
	return browser && !isInstalled() ? `${os} · ${browser}` : os;
}

/** Must run from a tap: iOS only asks for permission then. */
export async function enablePush(): Promise<"on" | "denied"> {
	if ((await Notification.requestPermission()) !== "granted") return "denied";
	const [reg, info] = await Promise.all([worker(), endpoints.push()]);
	let sub = await reg.pushManager.getSubscription();
	if (sub) {
		// Made with another key (Reelix's key was replaced): it can no longer be used.
		const had = sub.options.applicationServerKey;
		const want = keyBytes(info.public_key);
		if (had && sameBytes(new Uint8Array(had), want)) await endpoints.pushSubscribe(sub.toJSON(), deviceLabel());
		else {
			await sub.unsubscribe();
			sub = null;
		}
	}
	if (!sub) {
		sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.public_key) });
		await endpoints.pushSubscribe(sub.toJSON(), deviceLabel());
	}
	return "on";
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

export async function disablePush(): Promise<void> {
	const sub = await current();
	if (!sub) return;
	await endpoints.pushUnsubscribe({ endpoint: sub.endpoint });
	await sub.unsubscribe();
}

export async function testPush(): Promise<void> {
	const sub = await current();
	if (!sub) throw new Error("Notifications are off on this device.");
	const { results } = await endpoints.pushTest(sub.endpoint);
	const bad = results.find((r) => !r.ok);
	if (bad) throw new Error(bad.error ?? "Not delivered");
}

/** While signed in: keep the worker registered, follow notification taps, and keep badge and notifications true. */
export function AppSync() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const open = useQuery({ queryKey: ["inbox", "open"], queryFn: () => endpoints.inbox("open") });
	const ids = open.data?.map((i) => i.id).join(",");

	useEffect(() => {
		if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
		void navigator.serviceWorker.register("/sw.js").catch(() => {});
		const onMessage = (e: MessageEvent) => {
			if (e.data?.type !== "reelix.navigate") return;
			const u = new URL(e.data.url, location.origin);
			if (u.origin === location.origin) navigate(u.pathname + u.search + u.hash);
			void qc.invalidateQueries({ queryKey: ["inbox"] });
		};
		navigator.serviceWorker.addEventListener("message", onMessage);
		return () => navigator.serviceWorker.removeEventListener("message", onMessage);
	}, [navigate, qc]);

	useEffect(() => {
		if (ids === undefined) return;
		const openIds = new Set(ids ? ids.split(",") : []);
		const n = openIds.size;
		const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
		void (n ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
		if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
		// iOS allows no silent push, so what was handled elsewhere is cleared here.
		void navigator.serviceWorker.getRegistration().then(async (reg) => {
			for (const x of (await reg?.getNotifications()) ?? []) if (x.tag.startsWith("inbox-") && !openIds.has(x.tag.slice(6))) x.close();
		}).catch(() => {});
	}, [ids]);
	return null;
}
