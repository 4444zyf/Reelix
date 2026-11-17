import { type Reelix, addInbox, errorMessage, fileDownload, getDownload, getTitle, json, watchTick } from "@reelix/core";
import type { JobRunner } from "./jobs.ts";

/**
 * The completion watcher (§5.3): ordinary code, no model. Polls qBittorrent's change feed, files
 * routine downloads by code, and hands anything unexpected to a background agent job.
 */
export class Watcher {
	app: Reelix;
	jobs: JobRunner;
	private state = { rid: 0, known: new Map() };
	private timer?: NodeJS.Timeout;
	private failingSince?: number;
	private backoffMs = 10_000;
	private notified = false;
	/** Called after a download is filed (subtitles hook in here). */
	onFiled: ((hash: string, titleId?: string) => void)[] = [];

	constructor(app: Reelix, jobs: JobRunner) {
		this.app = app;
		this.jobs = jobs;
		jobs.register("file_download", async (ctx) => {
			const hash = ctx.payload.hash as string;
			const out = await fileDownload(ctx.app, hash).catch((e) => ({ filed: false, problems: [errorMessage(e)], plan: { items: [] } }) as any);
			if (out.filed) {
				this.afterFiled(hash);
				return { state: "succeeded", summary: `Filed ${out.plan.items.length} items by code.` };
			}
			const d = getDownload(ctx.app, hash);
			const t = d?.title_id ? getTitle(ctx.app, d.title_id) : undefined;
			const r = await ctx.agent(
				`A finished download needs filing and code could not do it alone.\n\nDownload: ${d?.name} (hash ${hash})\nTitle: ${t ? `${t.id} ${t.name} (${t.year})` : "not recorded — identify it"}\nWanted episodes: ${d?.episodes_json}\nWhere the files are now: ${d?.content_path}\nWhy code stopped: ${out.problems.join("; ")}\n\nLoad the organise skill. Inspect the folder with your shell and media_probe, write a plan, and apply it if you are confident (organise mode=apply with explicit items, hash=${hash}). If you are not confident, post the plan with notify (wait=true) and stop. Do not touch the download folder.`,
				`File ${d?.name ?? hash}`,
			);
			if (r.parkedOn) return { state: "parked", summary: r.text };
			if (getDownload(ctx.app, hash)?.state === "filed") this.afterFiled(hash);
			return { state: r.state === "done" ? "succeeded" : "failed", summary: r.text };
		});
		jobs.register("stalled", async (ctx) => {
			const d = getDownload(ctx.app, ctx.payload.hash);
			const r = await ctx.agent(
				`Download "${d?.name}" (hash ${ctx.payload.hash}) for ${d?.title_id ?? "an unknown title"} has made no progress for ${ctx.payload.hours} hours. Wanted episodes: ${d?.episodes_json}.\nCheck its state (download_status, seeds). Look for a healthier release of the same thing (release_search). Unless the preferences note explicitly allows automatic swaps, propose the swap with notify (wait=true, options like ["Swap to <handle>", "Keep waiting", "Remove it"]) and stop; if it allows, add the new one and remove the stalled torrent (keeping no data).`,
				`Stalled: ${d?.name ?? ctx.payload.hash}`,
			);
			return r.parkedOn ? { state: "parked", summary: r.text } : { state: "succeeded", summary: r.text };
		});
	}

	start(): void {
		const loop = async () => {
			await this.tick();
			this.timer = setTimeout(loop, this.failingSince ? this.backoffMs : 15_000);
		};
		this.timer = setTimeout(loop, 3_000);
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
	}

	afterFiled(hash: string): void {
		const d = getDownload(this.app, hash);
		for (const f of this.onFiled) f(hash, d?.title_id ?? undefined);
	}

	async tick(): Promise<void> {
		if (!this.app.config.qbittorrent?.url) return;
		let events;
		try {
			events = await watchTick(this.app, this.state);
			if (this.failingSince) this.app.emit({ type: "notice", level: "info", text: "qBittorrent is reachable again." });
			this.failingSince = undefined;
			this.backoffMs = 10_000;
			this.notified = false;
		} catch (e) {
			// Back off and retry; one Inbox notice after an hour, not one per attempt.
			this.failingSince ??= Date.now();
			this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60_000);
			if (!this.notified && Date.now() - this.failingSince > 3600_000) {
				this.notified = true;
				addInbox(this.app, { kind: "notice", title: "qBittorrent is unreachable", body: `For over an hour: ${errorMessage(e)}`, dedupeKey: "qb-unreachable" });
			}
			return;
		}
		for (const ev of events) {
			if (ev.kind === "completed") this.jobs.enqueue("file_download", { hash: ev.hash, title: "file download" }, { dedupe: `file:${ev.hash}` });
			else if (ev.kind === "removed_outside" && !ev.filed) {
				const d = getDownload(this.app, ev.hash);
				addInbox(this.app, { kind: "notice", title: "A download was removed outside Reelix", body: `${d?.name} was removed from qBittorrent before it was filed.`, payload: { hash: ev.hash }, dedupeKey: `gone:${ev.hash}` });
			} else if (ev.kind === "stalled") this.jobs.enqueue("stalled", { hash: ev.hash, hours: ev.hours, title: "stalled download" }, { dedupe: `stalled:${ev.hash}` });
		}
	}
}

export { json };
