import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type AgentSession,
	type ToolDefinition,
	createAgentSession,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Reelix, errorMessage, newId, nowIso } from "@reelix/core";
import { type SessionKind, systemPrompt } from "./prompt.ts";
import { type AskRequest, type NotifyRequest, buildTools, describeToolCall } from "./tools.ts";

export type UiEvent = { seq: number; threadId: string; type: string; [k: string]: unknown };

export type ThreadRow = { id: string; name: string; kind: string; session_file: string | null; title_id: string | null; job_run_id: string | null; created_at: string; updated_at: string; archived: number };

type PendingAsk = { req: AskRequest; resolve: (v: string) => void; reject: (e: unknown) => void };

class ThreadRuntime {
	session!: AgentSession;
	events: UiEvent[] = [];
	seq = 0;
	running = false;
	runId?: string;
	listeners = new Set<(e: UiEvent) => void>();
	pendingAsk?: PendingAsk;
	parkedOn?: string;
	lastText = "";
	idleTimer?: NodeJS.Timeout;
	id: string;
	kind: SessionKind;
	actor: string;
	constructor(id: string, kind: SessionKind, actor: string) {
		this.id = id;
		this.kind = kind;
		this.actor = actor;
	}
}

export type HostOptions = {
	/** Where pi's own settings, sign-in and model list live (§3.2: /data/pi). */
	piDir: string;
	/** Folder containing the `reelix` wrapper, put on the agent shell's PATH. */
	binDir: string;
	/** Built-in skills shipped with Reelix. */
	skillsDir: string;
	/** Extra tools from other subsystems (subtitles, browser), built per session. */
	extraTools?: (ctx: { threadId: string; kind: SessionKind; actor: string; emit: (e: Record<string, unknown>) => void }) => ToolDefinition<any, any, any>[];
	/** Called when a notify needs to reach the owner (Inbox + Telegram). */
	notify: (n: NotifyRequest & { source: string; jobRunId?: string }) => Promise<string>;
};

/**
 * Hosts pi sessions in-process (§4.1): one per chat thread or background job, each with the
 * shell, file tools and Reelix's typed tools. Runs outlive the browser tab; events are numbered
 * and buffered while a run is active (§4.5).
 */
export class AgentHost {
	app: Reelix;
	opts: HostOptions;
	runtime?: ModelRuntime;
	threads = new Map<string, ThreadRuntime>();
	/** All UI events, for subscribers watching every thread (web sidebar, Telegram). */
	globalListeners = new Set<(e: UiEvent) => void>();

	constructor(app: Reelix, opts: HostOptions) {
		this.app = app;
		this.opts = opts;
	}

	async init(): Promise<void> {
		this.runtime = await ModelRuntime.create({
			authPath: join(this.opts.piDir, "auth.json"),
			modelsPath: join(this.opts.piDir, "models.json"),
			modelsStorePath: join(this.app.paths.pi, "models-store.json"),
		});
		// Runs that were active when the process stopped are marked interrupted (§4.5).
		this.app.db.prepare("UPDATE runs SET state = 'interrupted', finished_at = ? WHERE state = 'running'").run(nowIso());
	}

	modelFor(kind: SessionKind) {
		const spec = kind === "job" ? (this.app.config.models.background ?? this.app.config.models.main) : this.app.config.models.main;
		if (!spec || !this.runtime) return undefined;
		const [provider, ...rest] = spec.split("/");
		const m = this.runtime.getModel(provider!, rest.join("/"));
		if (!m) throw new Error(`Model "${spec}" is not known to pi. Check models.main / models.background and ${this.opts.piDir}/models.json.`);
		return m;
	}

	availableModels(): string[] {
		const rt: any = this.runtime;
		return (rt?.getModels() ?? []).filter((m: any) => (rt.hasConfiguredAuth ? rt.hasConfiguredAuth(m.provider) : true)).map((m: any) => `${m.provider}/${m.id}`);
	}

	// ------------------------------------------------------------------ threads

	listThreads(includeArchived = false): (ThreadRow & { running: boolean; pending_question: boolean })[] {
		const rows = this.app.db.prepare(`SELECT * FROM threads ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY updated_at DESC LIMIT 200`).all() as ThreadRow[];
		return rows.map((r) => ({ ...r, running: !!this.threads.get(r.id)?.running, pending_question: !!this.threads.get(r.id)?.pendingAsk }));
	}

	getThread(id: string): ThreadRow | undefined {
		return this.app.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
	}

	createThread(name: string, kind: SessionKind | "telegram" = "chat", extra: { title_id?: string; job_run_id?: string; id?: string } = {}): ThreadRow {
		const id = extra.id ?? newId("t_");
		this.app.db.prepare("INSERT INTO threads (id, name, kind, title_id, job_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, name, kind, extra.title_id ?? null, extra.job_run_id ?? null, nowIso(), nowIso());
		return this.getThread(id)!;
	}

	renameThread(id: string, name: string): void {
		this.app.db.prepare("UPDATE threads SET name = ?, updated_at = ? WHERE id = ?").run(name, nowIso(), id);
	}

	archiveThread(id: string, archived = true): void {
		this.app.db.prepare("UPDATE threads SET archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
		const rt = this.threads.get(id);
		if (rt && !rt.running) this.unload(id);
	}

	private actorFor(row: ThreadRow): string {
		return row.kind === "job" ? `job:${row.job_run_id ?? row.id}` : `agent:${row.id}`;
	}

	/** Open (or create) the pi session behind a thread. */
	async load(threadId: string): Promise<ThreadRuntime> {
		let rt = this.threads.get(threadId);
		if (rt) return rt;
		const row = this.getThread(threadId);
		if (!row) throw new Error(`No thread ${threadId}`);
		const kind = (row.kind === "telegram" ? "telegram" : row.kind === "job" ? "job" : row.kind === "setup" ? "setup" : "chat") as SessionKind;
		rt = new ThreadRuntime(threadId, kind, this.actorFor(row));
		const cwd = this.app.paths.workspace;
		const sessionManager = row.session_file && existsSync(row.session_file) ? SessionManager.open(row.session_file, this.app.paths.sessions, cwd) : SessionManager.create(cwd, this.app.paths.sessions);
		const file = sessionManager.getSessionFile();
		if (file && file !== row.session_file) this.app.db.prepare("UPDATE threads SET session_file = ? WHERE id = ?").run(file, threadId);

		const app = this.app;
		const limits = app.config.limits;
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: true },
			retry: { enabled: true, maxRetries: 3 },
			cacheWarming: "off", // it spends money while idle (§4.1)
		} as any);
		const hooks = (pi: any) => {
			// Shell time limit: pi has none (§4.1).
			pi.on("tool_call", (e: any) => {
				if (e.toolName === "bash") {
					const want = typeof e.input.timeout === "number" && e.input.timeout > 0 ? e.input.timeout : limits.shell_timeout_s;
					e.input.timeout = Math.min(want, limits.shell_timeout_max_s);
				}
				return undefined;
			});
			// Blank known secret values out of anything a tool returns (§9).
			pi.on("tool_result", (e: any) => {
				let changed = false;
				const content = (e.content ?? []).map((c: any) => {
					if (c.type !== "text") return c;
					const t = app.redact(c.text);
					if (t !== c.text) changed = true;
					return { ...c, text: t };
				});
				return changed ? { content } : undefined;
			});
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: this.app.paths.pi,
			settingsManager,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true, // an AGENTS.md planted in a download never becomes instructions
			additionalSkillPaths: [this.opts.skillsDir, this.app.paths.skills].filter((p) => existsSync(p)),
			extensionFactories: [hooks],
			systemPromptOverride: () => systemPrompt(app, kind),
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();

		const emit = (e: Record<string, unknown>) => this.push(rt!, e);
		const binDir = this.opts.binDir;
		const actor = rt.actor;
		const bash = createBashToolDefinition(cwd, {
			spawnHook: (c) => ({ ...c, env: { ...c.env, PATH: `${binDir}:${c.env.PATH ?? process.env.PATH}`, REELIX_ACTOR: actor, REELIX_DATA: app.paths.root } }),
		});
		const tools = [
			bash,
			createReadToolDefinition(cwd),
			createLsToolDefinition(cwd),
			createFindToolDefinition(cwd),
			createGrepToolDefinition(cwd),
			createWriteToolDefinition(cwd),
			createEditToolDefinition(cwd),
			...buildTools({
				app,
				threadId,
				kind,
				actor,
				emit,
				ask: kind === "job" ? undefined : (q, signal) => this.waitForAnswer(rt!, q, signal),
				notify: (n) => this.opts.notify({ ...n, source: kind === "job" ? actor : `agent:${threadId}`, jobRunId: row.job_run_id ?? undefined }),
				park: (inboxId) => {
					rt!.parkedOn = inboxId;
				},
				extraTools: this.opts.extraTools?.({ threadId, kind, actor, emit }),
			}),
		];
		const { session } = await createAgentSession({
			cwd,
			agentDir: this.app.paths.pi,
			modelRuntime: this.runtime,
			model: this.modelFor(kind),
			thinkingLevel: (this.app.config.models.thinking as any) ?? "low",
			resourceLoader,
			sessionManager,
			settingsManager,
			noTools: "builtin",
			customTools: tools as any,
		});
		rt.session = session;
		session.subscribe((ev: any) => this.onSessionEvent(rt!, ev));
		this.threads.set(threadId, rt);
		return rt;
	}

	unload(threadId: string): void {
		const rt = this.threads.get(threadId);
		if (!rt || rt.running) return;
		rt.session?.dispose();
		this.threads.delete(threadId);
	}

	// ------------------------------------------------------------------ runs

	/**
	 * Send the owner's message. Starts a run, or — while a run is active — is delivered after the
	 * current tool call (§4.5). While a question is pending, a typed message is its answer.
	 */
	async send(threadId: string, text: string, opts: { images?: { data: string; mimeType: string }[]; from?: string } = {}): Promise<{ runId?: string; queued?: boolean; answered?: boolean }> {
		const rt = await this.load(threadId);
		this.app.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(nowIso(), threadId);
		if (rt.pendingAsk && rt.pendingAsk.req.kind !== "secret") {
			this.push(rt, { type: "user_message", text, from: opts.from });
			const p = rt.pendingAsk;
			rt.pendingAsk = undefined;
			p.resolve(text);
			this.push(rt, { type: "ask_answered", id: p.req.id });
			return { answered: true };
		}
		if (rt.running) {
			this.push(rt, { type: "user_message", text, from: opts.from, queued: true });
			await rt.session.steer(text, opts.images as any);
			return { queued: true };
		}
		return { runId: this.startRun(rt, text, opts) };
	}

	private startRun(rt: ThreadRuntime, text: string, opts: { images?: { data: string; mimeType: string }[]; from?: string } = {}): string {
		const runId = newId("run_");
		rt.running = true;
		rt.runId = runId;
		rt.parkedOn = undefined;
		rt.lastText = "";
		if (rt.idleTimer) clearTimeout(rt.idleTimer);
		this.app.db.prepare("INSERT INTO runs (id, thread_id, state, prompt, started_at) VALUES (?, ?, 'running', ?, ?)").run(runId, rt.id, text.slice(0, 2000), nowIso());
		this.push(rt, { type: "run_start", runId });
		this.push(rt, { type: "user_message", text, from: opts.from, images: opts.images?.length ?? 0 });
		rt.session
			.prompt(text, { images: opts.images as any })
			.then(() => this.finishRun(rt, "done"))
			.catch((e) => {
				this.push(rt, { type: "error", message: this.app.redact(errorMessage(e)) });
				this.finishRun(rt, "failed");
			});
		return runId;
	}

	private finishRun(rt: ThreadRuntime, state: "done" | "failed" | "interrupted"): void {
		if (!rt.running) return;
		rt.running = false;
		this.app.db.prepare("UPDATE runs SET state = ?, finished_at = ? WHERE id = ?").run(state, nowIso(), rt.runId ?? "");
		this.push(rt, { type: "run_end", runId: rt.runId, state, parkedOn: rt.parkedOn });
		const waiters = this.runWaiters.get(rt.id);
		if (waiters) {
			this.runWaiters.delete(rt.id);
			for (const w of waiters) w({ state, text: rt.lastText, parkedOn: rt.parkedOn });
		}
		// Bound the buffer: after the run, the page is rebuilt from the saved conversation.
		rt.idleTimer = setTimeout(() => {
			if (!rt.running) rt.events = rt.events.filter((e) => e.seq > rt.seq - 1);
			if (!rt.running && !rt.listeners.size && rt.kind === "job") this.unload(rt.id);
		}, 60_000);
	}

	private runWaiters = new Map<string, ((r: { state: string; text: string; parkedOn?: string }) => void)[]>();

	/** For job runners and Telegram: start a run and wait for it to end. */
	async runToEnd(threadId: string, text: string): Promise<{ state: string; text: string; parkedOn?: string }> {
		const rt = await this.load(threadId);
		if (rt.running) throw new Error("thread is busy");
		return new Promise((resolve) => {
			const list = this.runWaiters.get(threadId) ?? [];
			list.push(resolve);
			this.runWaiters.set(threadId, list);
			this.startRun(rt, text, { from: rt.kind === "job" ? "job" : undefined });
		});
	}

	async abort(threadId: string): Promise<void> {
		const rt = this.threads.get(threadId);
		if (!rt) return;
		if (rt.pendingAsk) {
			const p = rt.pendingAsk;
			rt.pendingAsk = undefined;
			p.reject(new Error("The owner stopped the run."));
		}
		await rt.session.abort();
		this.finishRun(rt, "interrupted");
	}

	private waitForAnswer(rt: ThreadRuntime, req: AskRequest, signal?: AbortSignal): Promise<string> {
		return new Promise((resolve, reject) => {
			rt.pendingAsk = { req, resolve, reject };
			this.push(rt, { type: "ask", ...req });
			signal?.addEventListener("abort", () => {
				if (rt.pendingAsk?.req.id === req.id) rt.pendingAsk = undefined;
				reject(new Error("aborted"));
			});
		});
	}

	/** The owner answered a question (button, text, or secret field). */
	answer(threadId: string, questionId: string, value: string): boolean {
		const rt = this.threads.get(threadId);
		const p = rt?.pendingAsk;
		if (!rt || !p || p.req.id !== questionId) return false;
		rt.pendingAsk = undefined;
		if (p.req.kind === "secret") {
			// Straight to secrets.yaml; the conversation only records that it was provided (§7.2).
			if (value) this.app.setSecret(p.req.secret_key!, value);
			this.push(rt, { type: "ask_answered", id: questionId, text: value ? `(${p.req.secret_key} provided)` : "(not provided)" });
			p.resolve(value ? "provided" : "");
		} else {
			this.push(rt, { type: "ask_answered", id: questionId, text: value });
			p.resolve(value);
		}
		return true;
	}

	pendingQuestion(threadId: string): AskRequest | undefined {
		return this.threads.get(threadId)?.pendingAsk?.req;
	}

	isRunning(threadId: string): boolean {
		return !!this.threads.get(threadId)?.running;
	}

	// ------------------------------------------------------------------ events

	private push(rt: ThreadRuntime, e: Record<string, unknown>): void {
		const ev = { ...e, seq: ++rt.seq, threadId: rt.id } as UiEvent;
		rt.events.push(ev);
		if (rt.events.length > 5000) rt.events.splice(0, rt.events.length - 5000);
		for (const l of rt.listeners) l(ev);
		for (const l of this.globalListeners) l(ev);
	}

	/** Subscribe to a thread's events after `after`. Returns the backlog and an unsubscribe. */
	subscribe(threadId: string, after: number, listener: (e: UiEvent) => void): { backlog: UiEvent[]; unsubscribe: () => void; seq: number } {
		const rt = this.threads.get(threadId);
		if (!rt) return { backlog: [], unsubscribe: () => {}, seq: 0 };
		rt.listeners.add(listener);
		return { backlog: rt.events.filter((e) => e.seq > after), unsubscribe: () => rt.listeners.delete(listener), seq: rt.seq };
	}

	private onSessionEvent(rt: ThreadRuntime, ev: any): void {
		switch (ev.type) {
			case "message_update": {
				const a = ev.assistantMessageEvent;
				if (a?.type === "text_delta") {
					rt.lastText += a.delta;
					this.push(rt, { type: "text_delta", delta: a.delta });
				} else if (a?.type === "thinking_delta") this.push(rt, { type: "thinking" });
				break;
			}
			case "message_start":
				if (ev.message?.role === "assistant") {
					rt.lastText = "";
					this.push(rt, { type: "assistant_start" });
				}
				break;
			case "message_end": {
				const m = ev.message;
				if (m?.role === "assistant") {
					this.push(rt, { type: "assistant_end", stopReason: m.stopReason, error: m.errorMessage });
					this.recordUsage(rt, m.usage);
				}
				break;
			}
			case "tool_execution_start":
				this.push(rt, { type: "tool_start", id: ev.toolCallId, name: ev.toolName, label: describeToolCall(this.app, ev.toolName, ev.args) });
				break;
			case "tool_execution_end": {
				const r = ev.result ?? {};
				const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
				this.push(rt, { type: "tool_end", id: ev.toolCallId, name: ev.toolName, isError: !!ev.isError, summary: this.app.redact(text.split("\n").slice(0, 3).join(" ").slice(0, 300)), card: cardFromDetails(ev.toolName, r.details) });
				break;
			}
			case "auto_retry_start":
				this.push(rt, { type: "notice", text: `Model error; retrying (${ev.attempt ?? ""})` });
				break;
			case "compaction_start":
				this.push(rt, { type: "notice", text: "Summarising older conversation to save space" });
				break;
		}
	}

	private recordUsage(rt: ThreadRuntime, usage: any): void {
		if (!usage) return;
		const usd = Number(usage.cost?.total ?? 0) || 0;
		const tokens = Number(usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)) || 0;
		const scope = rt.kind === "job" ? "background" : "chat";
		const day = nowIso().slice(0, 10);
		this.app.db.prepare("INSERT INTO spend (day, scope, usd, tokens) VALUES (?, ?, ?, ?) ON CONFLICT(day, scope) DO UPDATE SET usd = usd + excluded.usd, tokens = tokens + excluded.tokens").run(day, scope, usd, tokens);
	}

	/** Background spend today against the cap (§4.5). */
	spendToday(): { usd: number; tokens: number; capUsd: number; capTokens: number; reached: boolean } {
		const r = this.app.db.prepare("SELECT usd, tokens FROM spend WHERE day = ? AND scope = 'background'").get(nowIso().slice(0, 10)) as { usd: number; tokens: number } | undefined;
		const l = this.app.config.limits;
		const usd = r?.usd ?? 0;
		const tokens = r?.tokens ?? 0;
		return { usd, tokens, capUsd: l.background_daily_usd, capTokens: l.background_daily_tokens, reached: usd >= l.background_daily_usd || tokens >= l.background_daily_tokens };
	}

	// ------------------------------------------------------------------ history

	/** The saved conversation as UI messages (survives restarts). */
	history(threadId: string): UiMessage[] {
		const rt = this.threads.get(threadId);
		let messages: any[];
		if (rt) messages = rt.session.messages as any[];
		else {
			const row = this.getThread(threadId);
			if (!row?.session_file || !existsSync(row.session_file)) return [];
			messages = SessionManager.open(row.session_file, this.app.paths.sessions, this.app.paths.workspace).buildSessionContext().messages as any[];
		}
		return toUiMessages(this.app, messages);
	}

	threadSeq(threadId: string): number {
		return this.threads.get(threadId)?.seq ?? 0;
	}

	dispose(): void {
		for (const id of [...this.threads.keys()]) {
			const rt = this.threads.get(id)!;
			rt.session?.dispose();
		}
		this.threads.clear();
	}
}

export type UiMessage =
	| { role: "user"; text: string; images?: number }
	| { role: "assistant"; text: string; tools: { id: string; name: string; label: string; isError?: boolean; summary?: string; card?: unknown }[]; error?: string };

function cardFromDetails(toolName: string, details: any): unknown {
	if (!details) return undefined;
	if (details.card) return details.card;
	const o = details.output;
	if (!o) return undefined;
	switch (details.op) {
		case "release.search":
			return { kind: "releases", releases: o.all?.slice(0, 50) ?? o.releases, total: o.total, indexers: o.indexers };
		case "title.find":
			return o.resolved ? { kind: "title", title: o.resolved } : { kind: "candidates", candidates: o.candidates };
		case "organise":
			return { kind: "plan", items: o.plan?.items ?? [], results: o.results, problems: o.problems, mode: o.mode };
		case "download.add":
			return { kind: "progress", hash: o.hash, name: o.name };
		case "download.status":
			return { kind: "downloads", downloads: o };
		default:
			return toolName === "subtitle_search" ? { kind: "subtitles", ...o } : undefined;
	}
}

function toUiMessages(app: Reelix, messages: any[]): UiMessage[] {
	const out: UiMessage[] = [];
	const toolResults = new Map<string, any>();
	for (const m of messages) if (m.role === "toolResult") toolResults.set(m.toolCallId, m);
	for (const m of messages) {
		if (m.role === "user") {
			const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
			const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
			out.push({ role: "user", text, images: content.filter((c: any) => c.type === "image").length || undefined });
		} else if (m.role === "assistant") {
			const text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
			const tools = (m.content ?? [])
				.filter((c: any) => c.type === "toolCall")
				.map((c: any) => {
					const r = toolResults.get(c.id);
					const rtext = (r?.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
					return { id: c.id, name: c.name, label: describeToolCall(app, c.name, c.arguments), isError: r?.isError, summary: rtext.split("\n").slice(0, 3).join(" ").slice(0, 300), card: cardFromDetails(c.name, r?.details) };
				});
			const prev = out[out.length - 1];
			// Merge consecutive assistant turns (tool loop) into one bubble.
			if (prev && prev.role === "assistant") {
				prev.text = [prev.text, text].filter(Boolean).join("\n\n");
				prev.tools.push(...tools);
				if (m.errorMessage) prev.error = m.errorMessage;
			} else out.push({ role: "assistant", text, tools, error: m.errorMessage });
		} else if (m.role === "custom" && m.display) {
			out.push({ role: "user", text: typeof m.content === "string" ? m.content : "" });
		}
	}
	return out;
}

export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
