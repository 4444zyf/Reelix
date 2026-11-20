import { outsideLine } from "@reelix/plugin";
import { basename } from "node:path";
import { type Reelix, type TranslationRow, TranslationPaused, activeTranslator, addInbox, createTranslation, errorMessage, getTitle, getTranslation, kvGet, kvSet, markOutside, reportToText, runTranslation, tr, translationStatus, translationWishes } from "@reelix/core";
import type { AgentHost } from "./agent/host.ts";
import { type JobRunner, Postpone } from "./jobs.ts";

const BACKOFF_START_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

/**
 * Subtitle translation as a background job (docs/subtitle-translation.md). The work itself is in
 * the core; this gives it models (by role, through the router) for the glossary and the review and the
 * active translator for the lines, runs one translation at a time,
 * pauses instead of failing when no model can answer, and reports back where it was asked for.
 */
export function startTranslation({ app, host, jobs }: { app: Reelix; host: AgentHost; jobs: JobRunner }): void {
	jobs.unmetered.add("translate");
	const titleOf = (t: TranslationRow) => tr(app, "translate.jobTitle", { name: (t.title_id && getTitle(app, t.title_id)?.name) || t.title_id || "video", target: t.target });
	const enqueue = (id: string) => {
		const t = getTranslation(app, id);
		if (t) jobs.enqueue("translate", { translation_id: id, title: titleOf(t) }, { dedupe: `translate:${id}` });
	};
	app.events.on("event", (e: any) => {
		if (e.type === "translation" && e.state === "queued") enqueue(e.id);
	});
	// Those created while the server was down or from the command line.
	const sweep = () => {
		for (const r of app.db.prepare("SELECT id FROM translations WHERE state IN ('queued','running','paused')").all() as { id: string }[]) enqueue(r.id);
	};
	jobs.schedule("translations", "translation_sweep", "every 5m");
	jobs.register("translation_sweep", async () => (sweep(), { state: "succeeded", summary: "checked" }));
	sweep();

	// One translation at a time: each waits for the one before.
	let line: Promise<unknown> = Promise.resolve();

	jobs.register("translate", (ctx) => {
		const turn = line.then(() => work(ctx.payload.translation_id, ctx.run.id));
		line = turn.catch(() => undefined);
		return turn;
	});

	const tell = (t: TranslationRow, title: string, body: string, kind = "notice") => {
		const thread = t.thread_id ? host.getThread(t.thread_id) : undefined;
		if (thread && !thread.archived && host.runtime) {
			// The agent reports it in the conversation that asked, in the owner's language.
			void host.send(thread.id, `[Reelix, not the owner] ${outsideLine(title)}\n${markOutside("the translation", body)}\nTell the owner in a few lines, in their language. If something failed or lines are still too long, say so plainly.`, { from: "job" }).catch(() => addInbox(app, { kind, title, body, source: "translation" }));
		} else addInbox(app, { kind, title, body, source: "translation" });
	};

	async function work(id: string, runId: string): Promise<{ state: "succeeded" | "failed"; summary: string }> {
		const t = getTranslation(app, id);
		if (!t) return { state: "failed", summary: "translation gone" };
		if (t.state === "cancelled") return { state: "succeeded", summary: "Cancelled; finished episodes are kept." };
		if (t.state === "succeeded") return { state: "succeeded", summary: "Already done." };
		const name = (t.title_id && getTitle(app, t.title_id)?.name) || basename(translationStatus(app, id).items[0]?.video ?? id);
		const ctrl = new AbortController();
		const onEvent = (e: any) => {
			if (e.type === "translation" && e.id === id && e.state === "cancelled") ctrl.abort();
		};
		app.events.on("event", onEvent);
		let last = 0;
		try {
			const report = await runTranslation(app, id, (role, system, user, signal) => host.router.complete(role, system, user, { scope: "translation", signal }), activeTranslator(app), {
				signal: ctrl.signal,
				progress: (s) => {
					if (Date.now() - last < 3000) return;
					last = Date.now();
					const at = s.items.find((i) => i.state === "running");
					app.db.prepare("UPDATE job_runs SET summary = ? WHERE id = ?").run(`${s.lines.done} / ${s.lines.total}${at ? ` · ${basename(at.video)}` : ""}`, runId);
					app.emit({ type: "job", id: runId, state: "running", kind: "translate" });
				},
				itemDone: (item, index, total) => {
					// A season: the first episode is announced as a sample; the rest carries on.
					if (index === 0 && total > 1 && item.placed) addInbox(app, { kind: "notice", title: tr(app, "translate.sampleTitle", { target: t.target }), body: tr(app, "translate.sampleBody", { file: basename(item.placed), rest: total - 1 }), source: "translation", dedupeKey: `translate.sample:${id}` });
				},
			});
			kvSet(app.db, `translate.backoff:${id}`, "0");
			const now = getTranslation(app, id)!;
			const text = reportToText(report);
			if (now.state === "cancelled") return { state: "succeeded", summary: `Cancelled. ${text}` };
			const ok = now.state === "succeeded";
			tell(t, tr(app, ok ? "translate.doneTitle" : "translate.failedTitle", { target: t.target, name }), text);
			return { state: ok ? "succeeded" : "failed", summary: text };
		} catch (e) {
			if (e instanceof TranslationPaused) {
				// Five minutes, doubling up to an hour. One notice, not one per attempt.
				const n = Number(kvGet(app.db, `translate.backoff:${id}`) ?? 0);
				kvSet(app.db, `translate.backoff:${id}`, String(n + 1));
				const until = new Date(Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** n));
				addInbox(app, { kind: "notice", title: tr(app, "translate.pausedTitle"), body: tr(app, "translate.pausedBody", { reason: e.message, time: until.toLocaleTimeString(app.config.language ?? "en", { hour: "2-digit", minute: "2-digit" }) }), source: "translation", dedupeKey: `translate.paused:${id}` });
				throw new Postpone(e.message, until);
			}
			tell(t, tr(app, "translate.failedTitle", { target: t.target, name }), errorMessage(e));
			return { state: "failed", summary: errorMessage(e) };
		} finally {
			app.events.off("event", onEvent);
		}
	}

	// Standing wishes: whatever is filed for the title is translated the same way, without a model deciding.
	app.pluginEvents.on("download.filed", ({ titleId, via }) => {
		if (!titleId || via !== "download") return;
		for (const wish of translationWishes(app, titleId)) {
			// The ordinary subtitle search runs first; give it time to place a source.
			setTimeout(() => void startWish(app, titleId, wish).catch(() => undefined), Number(process.env.REELIX_WISH_DELAY_MS ?? 10 * 60_000)).unref();
		}
	});
}

async function startWish(app: Reelix, titleId: string, wish: ReturnType<typeof translationWishes>[number]): Promise<void> {
	try {
		await createTranslation(app, { ...wish, title_id: titleId, only_missing: true });
	} catch (e) {
		const code = (e as any)?.code;
		if (code === "nothing_missing") return;
		addInbox(app, { kind: "notice", title: tr(app, "translate.failedTitle", { target: wish.target, name: getTitle(app, titleId)?.name ?? titleId }), body: errorMessage(e), source: "translation", dedupeKey: `translate.wish:${titleId}:${wish.code}` });
	}
}
