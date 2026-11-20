import { existsSync, readFileSync } from "node:fs";
import { type Notice, isOutcome } from "@reelix/plugin";
import type { Reelix } from "./app.ts";
import { tr } from "./i18n.ts";
import { type InboxItem, getInbox, inboxNeedsOwner, listInbox } from "./inbox.ts";
import { type ReasonInput, replaceReasons } from "./reasons.ts";
import { type Provider, outcomeText } from "./seams.ts";
import { errorMessage, nowIso } from "./util.ts";

/**
 * The one place that decides what reaches the owner's devices (docs/plugins.md §7.3): it applies the
 * rule once, calls every notifier, retries a failed send once, records each delivery, and tells
 * notifiers when an item closes.
 */
const SEAM = "reelix:notifier@1";
const RETRY_MS = 30_000;
/** Worth a second try; the other outcomes need the owner to do something first. */
const RETRIED = new Set(["failed", "rate_limited", "unavailable"]);
/** What a notifier that was away is still sent: the newest few of what is open and recent. */
const CATCH_UP_ITEMS = 5;
const CATCH_UP_SCANNED = 100;
const CATCH_UP_MS = 3 * 86_400_000;

type Notifier = Provider<typeof SEAM>;
type DeliveryRow = { provider: string; ref: string };

const openInboxCount = (app: Reelix) => (app.db.prepare("SELECT COUNT(*) n FROM inbox WHERE status = 'open'").get() as { n: number }).n;

/**
 * The notice for an Inbox item, with what must never leave Reelix blanked out, after the plugins of
 * `notify.before` had their say. A question that can approve something stays in Reelix's words.
 */
async function noticeFor(app: Reelix, it: InboxItem): Promise<Notice> {
	const options = it.options.map((label, i) => ({ id: String(i), label }));
	const notice: Notice = {
		inboxId: it.id,
		kind: it.kind,
		title: app.redact(it.title),
		body: it.body ? app.redact(it.body) : undefined,
		answer: { kind: options.length ? "choice" : it.kind === "notice" || it.payload?.proposal ? "none" : "text", options },
		image: it.image_path && existsSync(it.image_path) ? new Uint8Array(readFileSync(it.image_path)) : undefined,
		path: `/inbox?item=${encodeURIComponent(it.id)}`,
		urgent: !!it.payload?.urgent || options.length > 0,
		badge: openInboxCount(app),
	};
	// What the owner approves is worded by Reelix alone.
	if (it.payload?.approval || it.payload?.proposal || !app.hooks.has("notify.before@1")) return notice;
	const reasons: ReasonInput[] = [];
	const edited = await app.hooks.pipeline("notify.before@1", notice, (value, { reason, ...change }, plugin) => {
		reasons.push({ kind: "edited", plugin, reason });
		return { ...value, ...change, title: app.redact(change.title ?? value.title), body: change.body === undefined ? value.body : app.redact(change.body) };
	});
	replaceReasons(app, `notice:${it.id}`, reasons);
	if (!reasons.length) return notice;
	const mark = tr(app, "notify.editedBy", { plugins: [...new Set(reasons.map((r) => r.plugin))].join(", ") });
	return { ...edited, body: edited.body ? `${edited.body}\n\n${mark}` : mark };
}

/** The Inbox item a provider's message belongs to. */
export const inboxOfDelivery = (app: Reelix, provider: string, ref: string) => (app.db.prepare("SELECT inbox_id FROM notice_deliveries WHERE provider = ? AND ref = ?").get(provider, ref) as { inbox_id: string } | undefined)?.inbox_id;

export class NotificationDispatcher {
	/** Replaces the wait before the second try (tests). */
	retryMs = RETRY_MS;
	private app: Reelix;
	private running = false;
	private timers = new Set<NodeJS.Timeout>();
	/** Sends under way, so that a catch-up does not repeat one. */
	private sending = new Set<string>();

	constructor(app: Reelix) {
		this.app = app;
	}

	private onEvent = (e: { type: string; id?: unknown; status?: unknown; item?: unknown }) => {
		if (e.type !== "inbox") return;
		if (e.status === "open") {
			if (e.item) this.dispatch(e.item as InboxItem).catch(this.logFailure);
		} else this.close(String(e.id)).catch(this.logFailure);
	};

	private logFailure = (e: unknown) => console.warn(`Notifications: ${this.app.redact(errorMessage(e))}`);

	start(): void {
		if (this.running) return;
		this.running = true;
		this.app.events.on("event", this.onEvent);
	}

	stop(): void {
		this.running = false;
		this.app.events.off("event", this.onEvent);
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
	}

	/** A plugin came up: its notifiers get what they missed while it was away. */
	catchUp(plugin: string): void {
		if (this.running) this.sendMissed(plugin).catch(this.logFailure);
	}

	private async sendMissed(plugin: string): Promise<void> {
		const providers = this.app.seams.providers(SEAM).filter((p) => p.plugin === plugin);
		if (!providers.length) return;
		const since = new Date(Date.now() - CATCH_UP_MS).toISOString();
		const open = listInbox(this.app, { status: "open", limit: CATCH_UP_SCANNED }).filter((it) => it.created_at >= since && inboxNeedsOwner(it));
		const delivered = this.app.db.prepare("SELECT 1 FROM notice_deliveries WHERE inbox_id = ? AND provider = ?");
		for (const p of providers) {
			const missed = open.filter((it) => !delivered.get(it.id, p.id)).slice(0, CATCH_UP_ITEMS).reverse();
			for (const it of missed) await this.attempt(p, await noticeFor(this.app, it), true);
		}
	}

	private async dispatch(it: InboxItem): Promise<void> {
		if (!inboxNeedsOwner(it)) return;
		const notice = await noticeFor(this.app, it);
		await Promise.all(this.app.seams.providers(SEAM).map((p) => this.attempt(p, notice, true)));
	}

	private async attempt(p: Notifier, notice: Notice, mayRetry: boolean): Promise<void> {
		const sending = `${notice.inboxId} ${p.id}`;
		if (this.sending.has(sending)) return;
		this.sending.add(sending);
		let state = "sent";
		let ref: string | undefined;
		let error: string | undefined;
		const { images, answers } = p.impl.can;
		try {
			const r = await p.call("send", [{ ...notice, image: images ? notice.image : undefined, answer: answers ? notice.answer : { kind: "none", options: [] } }]);
			if (isOutcome(r)) {
				state = r.outcome;
				error = this.app.redact(outcomeText(p.label, r));
			} else ref = r.ref;
		} catch (e) {
			state = "failed";
			error = this.app.redact(errorMessage(e)).slice(0, 300);
		}
		this.sending.delete(sending);
		if (!this.running) return;
		this.record(notice.inboxId, p.id, state, ref, error);
		if (mayRetry && RETRIED.has(state)) this.retryLater(p.id, notice.inboxId);
		// Answered while the message was on its way: the close already went by.
		if (state === "sent" && getInbox(this.app, notice.inboxId)?.status !== "open") await this.close(notice.inboxId);
	}

	private retryLater(providerId: string, inboxId: string): void {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			const it = getInbox(this.app, inboxId);
			const p = this.app.seams.provider(SEAM, providerId);
			if (it?.status === "open" && p) void noticeFor(this.app, it).then((notice) => this.attempt(p, notice, false)).catch(this.logFailure);
		}, this.retryMs);
		timer.unref();
		this.timers.add(timer);
	}

	private record(inboxId: string, provider: string, state: string, ref: string | undefined, error: string | undefined): void {
		this.app.db
			.prepare("INSERT INTO notice_deliveries (inbox_id, provider, state, ref, error, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(inbox_id, provider) DO UPDATE SET state = excluded.state, ref = excluded.ref, error = excluded.error, attempts = attempts + 1, updated_at = excluded.updated_at")
			.run(inboxId, provider, state, ref ?? null, error ?? null, nowIso());
	}

	/** The item is answered or dismissed: providers that can, change what they sent. */
	private async close(inboxId: string): Promise<void> {
		const it = getInbox(this.app, inboxId);
		if (!it || it.status === "open") return;
		const rows = this.app.db.prepare("SELECT provider, ref FROM notice_deliveries WHERE inbox_id = ? AND state = 'sent' AND ref IS NOT NULL AND closed_at IS NULL").all(inboxId) as DeliveryRow[];
		if (!rows.length) return;
		const notice = await noticeFor(this.app, it);
		await Promise.all(
			rows.map(async ({ provider, ref }) => {
				const p = this.app.seams.provider(SEAM, provider);
				if (!p?.impl.can.update || !p.has("update")) return;
				let error: string | undefined;
				try {
					const r = await p.call("update", [ref, notice, { status: it.status, answer: it.answer ?? undefined }]);
					if (isOutcome(r)) error = this.app.redact(outcomeText(p.label, r));
				} catch (e) {
					error = this.app.redact(errorMessage(e)).slice(0, 300);
				}
				if (!this.running) return;
				this.app.db.prepare("UPDATE notice_deliveries SET closed_at = ?, error = ?, updated_at = ? WHERE inbox_id = ? AND provider = ?").run(error ? null : nowIso(), error ?? null, nowIso(), inboxId, provider);
			}),
		);
	}
}
