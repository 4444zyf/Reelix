import { type Reelix, addInbox, answeredByOwner, errorMessage, json, newId, nextMidnight, nowIso, spendDay, tr } from "@reelix/core";
import type { AgentHost, ThreadRow } from "./agent/host.ts";

export type JobRun = { id: string; job_id: string | null; kind: string; payload_json: string; state: string; lease_until: string | null; session_file: string | null; attempts: number; summary: string | null; created_at: string; started_at: string | null; finished_at: string | null };

export type AgentOutcome = { state: string; text: string; parkedOn?: string };

export type JobContext = {
	run: JobRun;
	payload: any;
	app: Reelix;
	/** Run (or continue) the job's agent conversation. Throws CapReached at the spending cap. */
	agent: (prompt: string, title?: string) => Promise<AgentOutcome>;
	log: (line: string) => void;
};

export type JobResult = { state: "succeeded" | "failed" | "parked"; summary: string };
export type JobHandler = (ctx: JobContext) => Promise<JobResult>;

export class CapReached extends Error {}

/** Not a failure: run this job again at the given time (a model that cannot answer for now). */
export class Postpone extends Error {
	until: Date;
	constructor(message: string, until: Date) {
		super(message);
		this.until = until;
	}
}

const LEASE_MS = 30 * 60_000;
const MAX_AGENT_RUNS = 2;
const STARTED_AT_ONCE = 10;

/**
 * Background work (§4.5): scheduled and one-off jobs, each run on a lease so a crashed run is
 * taken up again and a finished one is never repeated. Agent work runs in its own session with
 * the same tools as chat; a job needing the owner parks on an Inbox item and resumes on answer.
 */
export class JobRunner {
	app: Reelix;
	host: AgentHost;
	handlers = new Map<string, JobHandler>();
	private timer?: NodeJS.Timeout;
	private firstTick?: NodeJS.Timeout;
	private stopped = false;
	private active = new Set<string>();
	/** Job kinds that do not count against the two agent slots. */
	unmetered = new Set<string>();
	private activeUnmetered = new Set<string>();
	private ticking = false;

	constructor(app: Reelix, host: AgentHost) {
		this.app = app;
		this.host = host;
		this.register("agent", async (ctx) => {
			const r = await ctx.agent(ctx.payload.prompt, ctx.payload.title);
			return r.parkedOn ? { state: "parked", summary: r.text } : { state: r.state === "done" ? "succeeded" : "failed", summary: r.text };
		});
		app.events.on("event", (e: any) => {
			if (e.type === "inbox" && e.status === "answered" && e.item?.job_run_id && answeredByOwner(e.by)) void this.resume(e.item.job_run_id, e.item.answer ?? "", e.item.title);
		});
	}

	register(kind: string, handler: JobHandler): void {
		this.handlers.set(kind, handler);
	}

	unregister(kind: string): void {
		this.handlers.delete(kind);
	}

	/** End the queued runs of a kind nothing will handle any more. */
	cancelQueued(kind: string, summary: string): void {
		const rows = this.app.db.prepare("UPDATE job_runs SET state = 'interrupted', summary = ?, finished_at = ? WHERE kind = ? AND state = 'queued' RETURNING id").all(summary, nowIso(), kind) as { id: string }[];
		for (const r of rows) this.app.emit({ type: "job", id: r.id, state: "interrupted", kind });
	}

	/** A plugin's job (`<plugin>.<job>`) with no handler now: the plugin is restarting or waiting, and the run waits for it. */
	private waitsForPlugin(kind: string): boolean {
		return kind.includes(".") && !this.handlers.has(kind);
	}

	/** Ensure a scheduled job exists (idempotent). */
	schedule(id: string, kind: string, schedule: string, payload: unknown = {}): void {
		const exists = this.app.db.prepare("SELECT id FROM jobs WHERE id = ?").get(id);
		if (exists) this.app.db.prepare("UPDATE jobs SET schedule = ?, kind = ? WHERE id = ?").run(schedule, kind, id);
		else this.app.db.prepare("INSERT INTO jobs (id, kind, schedule, payload_json, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, kind, schedule, JSON.stringify(payload), nextRunAt(schedule), nowIso());
	}

	unschedule(id: string): void {
		this.app.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
	}

	/** Queue a one-off run. A dedupe key prevents queuing the same thing twice. */
	enqueue(kind: string, payload: Record<string, unknown>, opts: { dedupe?: string; jobId?: string } = {}): string {
		if (opts.dedupe) {
			const existing = this.app.db.prepare("SELECT id FROM job_runs WHERE state IN ('queued','running','parked') AND json_extract(payload_json, '$.dedupe') = ?").get(opts.dedupe) as { id: string } | undefined;
			if (existing) return existing.id;
		}
		const id = newId("job_");
		this.app.db.prepare("INSERT INTO job_runs (id, job_id, kind, payload_json, state, created_at) VALUES (?, ?, ?, ?, 'queued', ?)").run(id, opts.jobId ?? null, kind, JSON.stringify({ ...payload, dedupe: opts.dedupe }), nowIso());
		this.app.emit({ type: "job", id, state: "queued", kind });
		setImmediate(() => void this.tick());
		return id;
	}

	start(): void {
		// Runs that were running when the process stopped are taken up again (§4.5).
		const stale = this.app.db.prepare("SELECT * FROM job_runs WHERE state = 'running'").all() as JobRun[];
		for (const r of stale) {
			if (r.attempts >= 3) this.app.db.prepare("UPDATE job_runs SET state = 'interrupted', finished_at = ?, summary = 'interrupted three times; given up' WHERE id = ?").run(nowIso(), r.id);
			else this.app.db.prepare("UPDATE job_runs SET state = 'queued', lease_until = NULL WHERE id = ?").run(r.id);
		}
		this.stopped = false;
		this.timer = setInterval(() => void this.tick(), 20_000);
		this.firstTick = setTimeout(() => void this.tick(), 2_000);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		if (this.firstTick) clearTimeout(this.firstTick);
	}

	async tick(): Promise<void> {
		// A stopped runner never touches the database again, started or only ticked by hand (tests).
		if (this.ticking || this.stopped) return;
		this.ticking = true;
		try {
			// Scheduled jobs that are due (missed ones run on the next start).
			const due = this.app.db.prepare("SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(nowIso()) as any[];
			for (const j of due) {
				this.app.db.prepare("UPDATE jobs SET next_run_at = ? WHERE id = ?").run(j.schedule ? nextRunAt(j.schedule) : null, j.id);
				this.enqueue(j.kind, json(j.payload_json, {}), { jobId: j.id, dedupe: `sched:${j.id}` });
			}
			const queued = this.app.db.prepare("SELECT * FROM job_runs WHERE state = 'queued' AND (lease_until IS NULL OR lease_until <= ?) ORDER BY created_at").all(nowIso()) as JobRun[];
			for (const r of queued.filter((q) => !this.waitsForPlugin(q.kind)).slice(0, STARTED_AT_ONCE)) {
				if (this.active.has(r.id)) continue;
				// Long direct-model jobs (translation) queue among themselves and do not hold an agent slot.
				if (!this.unmetered.has(r.kind) && [...this.active].filter((id) => !this.activeUnmetered.has(id)).length >= MAX_AGENT_RUNS) continue;
				void this.execute(r);
			}
		} finally {
			this.ticking = false;
		}
	}

	private claim(r: JobRun): boolean {
		// Claimed with a lease; a second claimer sees the changed state.
		const res = this.app.db.prepare("UPDATE job_runs SET state = 'running', lease_until = ?, attempts = attempts + 1, started_at = COALESCE(started_at, ?) WHERE id = ? AND state = 'queued'").run(new Date(Date.now() + LEASE_MS).toISOString(), nowIso(), r.id);
		return Number(res.changes) === 1;
	}

	private async execute(r: JobRun, resumeText?: string): Promise<void> {
		if (!resumeText && !this.claim(r)) return;
		this.active.add(r.id);
		if (this.unmetered.has(r.kind)) this.activeUnmetered.add(r.id);
		this.app.emit({ type: "job", id: r.id, state: "running", kind: r.kind });
		const handler = this.handlers.get(r.kind);
		const renew = setInterval(() => this.app.db.prepare("UPDATE job_runs SET lease_until = ? WHERE id = ?").run(new Date(Date.now() + LEASE_MS).toISOString(), r.id), LEASE_MS / 3);
		const payload = json<any>(r.payload_json, {});
		const ctx: JobContext = {
			run: r,
			payload,
			app: this.app,
			log: (line) => console.log(`[job ${r.id}] ${line}`),
			agent: (prompt, title) => this.agentTurn(r, resumeText ?? prompt, title ?? payload.title ?? r.kind),
		};
		let result: JobResult;
		try {
			if (!resumeText && !handler) throw new Error(`no handler for job kind ${r.kind}`);
			result = resumeText ? await this.handlers.get("agent")!({ ...ctx, payload: { prompt: resumeText } }) : await handler!(ctx);
		} catch (e) {
			if (e instanceof CapReached) {
				// Waiting jobs queue for the next day, which starts at local midnight; one Inbox notice says so (§4.5).
				const tomorrow = new Date(nextMidnight().getTime() + 5 * 60_000);
				this.app.db.prepare("UPDATE job_runs SET state = 'queued', lease_until = ?, attempts = attempts - 1 WHERE id = ?").run(tomorrow.toISOString(), r.id);
				addInbox(this.app, { kind: "notice", title: tr(this.app, "jobs.capTitle"), body: tr(this.app, "jobs.capBody", { usd: this.app.config.limits.background_daily_usd, tokens: this.app.config.limits.background_daily_tokens }), dedupeKey: `cap:${spendDay()}` });
				clearInterval(renew);
				this.active.delete(r.id);
				this.activeUnmetered.delete(r.id);
				return;
			}
			if (e instanceof Postpone) {
				this.app.db.prepare("UPDATE job_runs SET state = 'queued', lease_until = ?, attempts = attempts - 1, summary = ? WHERE id = ?").run(e.until.toISOString(), this.app.redact(e.message).slice(0, 4000), r.id);
				clearInterval(renew);
				this.active.delete(r.id);
				this.activeUnmetered.delete(r.id);
				this.app.emit({ type: "job", id: r.id, state: "queued", kind: r.kind });
				return;
			}
			result = { state: "failed", summary: errorMessage(e) };
		}
		clearInterval(renew);
		this.active.delete(r.id);
		this.activeUnmetered.delete(r.id);
		this.app.db.prepare("UPDATE job_runs SET state = ?, summary = ?, lease_until = NULL, finished_at = CASE WHEN ? = 'parked' THEN NULL ELSE ? END WHERE id = ?").run(result.state, this.app.redact(result.summary).slice(0, 4000), result.state, nowIso(), r.id);
		this.app.emit({ type: "job", id: r.id, state: result.state, kind: r.kind });
		setImmediate(() => void this.tick());
	}

	private jobThread(r: JobRun, title: string): ThreadRow {
		const existing = this.app.db.prepare("SELECT * FROM threads WHERE job_run_id = ?").get(r.id) as ThreadRow | undefined;
		return existing ?? this.host.createThread(`Job: ${title}`.slice(0, 80), "job", { job_run_id: r.id });
	}

	private async agentTurn(r: JobRun, prompt: string, title: string): Promise<AgentOutcome> {
		if (this.host.spendToday().reached) throw new CapReached();
		if (!this.host.runtime) throw new Error("the agent is not available");
		const t = this.jobThread(r, title);
		const out = await this.host.runToEnd(t.id, prompt);
		const row = this.host.getThread(t.id);
		if (row?.session_file) this.app.db.prepare("UPDATE job_runs SET session_file = ? WHERE id = ?").run(row.session_file, r.id);
		return out;
	}

	/** The owner answered a parked job's question: resume it in its saved session. */
	async resume(jobRunId: string, answer: string, question: string): Promise<void> {
		const r = this.app.db.prepare("SELECT * FROM job_runs WHERE id = ?").get(jobRunId) as JobRun | undefined;
		if (!r || r.state !== "parked") return;
		const thread = this.app.db.prepare("SELECT * FROM threads WHERE job_run_id = ?").get(jobRunId) as ThreadRow | undefined;
		if (thread && thread.kind !== "job") return; // the owner took it into chat
		this.app.db.prepare("UPDATE job_runs SET state = 'running', lease_until = ? WHERE id = ?").run(new Date(Date.now() + LEASE_MS).toISOString(), jobRunId);
		await this.execute(r, `The owner answered your question "${question}": ${answer}\nContinue the task.`);
	}

	/** "Continue in chat": the job's conversation becomes an ordinary thread (§4.5). */
	continueInChat(jobRunId: string): ThreadRow | undefined {
		const t = this.app.db.prepare("SELECT * FROM threads WHERE job_run_id = ?").get(jobRunId) as ThreadRow | undefined;
		if (!t) return undefined;
		this.host.unload(t.id); // reload with chat tools (ask) next time
		this.app.db.prepare("UPDATE threads SET kind = 'chat', name = ?, updated_at = ? WHERE id = ?").run(t.name.replace(/^Job: /, ""), nowIso(), t.id);
		this.app.db.prepare("UPDATE job_runs SET state = 'succeeded', summary = COALESCE(summary, '') || ' (continued in chat)', finished_at = ? WHERE id = ? AND state = 'parked'").run(nowIso(), jobRunId);
		for (const it of this.app.db.prepare("SELECT id FROM inbox WHERE job_run_id = ? AND status = 'open'").all(jobRunId) as { id: string }[]) this.app.db.prepare("UPDATE inbox SET status = 'dismissed' WHERE id = ?").run(it.id);
		return this.host.getThread(t.id);
	}

	list(): { jobs: unknown[]; runs: unknown[] } {
		return {
			jobs: this.app.db.prepare("SELECT * FROM jobs ORDER BY id").all(),
			runs: this.app.db.prepare("SELECT r.*, t.id AS thread_id FROM job_runs r LEFT JOIN threads t ON t.job_run_id = r.id ORDER BY r.created_at DESC LIMIT 100").all(),
		};
	}

	runNow(jobId: string): { id: string } {
		const j = this.app.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
		if (!j) throw new Error("no such job");
		return { id: this.enqueue(j.kind, json(j.payload_json, {}), { jobId, dedupe: `sched:${jobId}` }) };
	}

	summary(): { queued: number; running: number; parked: number } {
		const c = (s: string) => (this.app.db.prepare("SELECT COUNT(*) n FROM job_runs WHERE state = ?").get(s) as { n: number }).n;
		return { queued: c("queued"), running: c("running"), parked: c("parked") };
	}
}

/** "daily HH:MM" (local time) or "every Nm". */
export function nextRunAt(schedule: string, from = new Date()): string {
	const d = /^daily (\d{1,2}):(\d{2})$/.exec(schedule);
	if (d) {
		const t = new Date(from);
		t.setHours(Number(d[1]), Number(d[2]), 0, 0);
		if (t <= from) t.setDate(t.getDate() + 1);
		return t.toISOString();
	}
	const e = /^every (\d+)m$/.exec(schedule);
	if (e) return new Date(from.getTime() + Number(e[1]) * 60_000).toISOString();
	throw new Error(`bad schedule "${schedule}"`);
}
