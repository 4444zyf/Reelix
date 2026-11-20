/**
 * Testing a plugin through the real loading path: manifest, loader, settings, activation
 * (docs/plugins.md §14.2). Nothing here mounts a plugin by hand.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ChatOut, type HookId, type HookRelease, type Ids, type Kind, type ModelRole, type Notice, type PlayRequest, type PluginAgentOutcome, type PluginHooks, type PluginSeamId, type SeamId, type SubtitleQuery, type IndexerQuery, type Transfer, type TranslateJob, isOutcome } from "@reelix/plugin";
import { type PluginInfo, Reelix, ReelixError, TranslationPaused, channelRow, kvGet, setChannelOwner } from "@reelix/core";
import { JobRunner } from "@reelix/server/jobs.ts";
import type { HttpTransport } from "@reelix/server/plugins/http.ts";
import { loadPlugin } from "@reelix/server/plugins/loader.ts";
import { PluginManager } from "@reelix/server/plugins/manager.ts";
import { readManifest } from "@reelix/server/plugins/manifest.ts";
import { sessionExtensions } from "@reelix/server/plugins/pi.ts";
import { Hono } from "hono";

export type CannedAnswer = {
	/** The whole address, or a pattern for it. */
	url: string | RegExp;
	method?: string;
	status?: number;
	headers?: Record<string, string>;
	cookies?: string[];
	body?: string | Uint8Array;
	/** Answer only this many times; later requests go to the next answer that matches (a service whose state changed). */
	times?: number;
};

export type RecordedRequest = { url: string; method: string; headers: Record<string, string>; body?: string; bytes?: Uint8Array };

/**
 * An answer of the owner's model, for `ctx.model.complete`: the first that matches the role and the user text
 * answers. `model`: which model it says answered (default `recorded/model`).
 */
export type CannedModelAnswer = { role?: ModelRole; user?: string | RegExp; text: string; model?: string; times?: number };

/** `testing.model`: canned model answers. `down`: no model can answer (as when all are failing); `hang`: none answers at all. */
function cannedModel(answers: CannedModelAnswer[]) {
	const calls: { role: ModelRole; system: string; user: string; scope: string }[] = [];
	const used = new Map<CannedModelAnswer, number>();
	const state = { down: false, hang: false, unreadable: false };
	const access = {
		async complete(role: ModelRole, system: string, user: string, o: { scope: string; signal?: AbortSignal }) {
			calls.push({ role, system, user, scope: o.scope });
			if (state.hang) await new Promise((_, reject) => o.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
			if (state.down) throw new TranslationPaused(`No model for "${role}" could answer. recorded/model: 503 overloaded`);
			if (state.unreadable) return { text: "Sorry, I cannot help with that.", model: "recorded/model" };
			const a = answers.find((x) => (x.role ?? role) === role && (x.user === undefined || (typeof x.user === "string" ? user.includes(x.user) : x.user.test(user))) && (x.times === undefined || (used.get(x) ?? 0) < x.times));
			if (!a) throw new Error(`no canned model answer for the role ${role}`);
			used.set(a, (used.get(a) ?? 0) + 1);
			return { text: a.text, model: a.model ?? "recorded/model" };
		},
	};
	return { access, calls, state };
}

/** `testing.http`: canned answers in place of the network. The plugin's declared hosts are still enforced. */
function cannedHttp(answers: CannedAnswer[]) {
	const requests: RecordedRequest[] = [];
	const used = new Map<CannedAnswer, number>();
	const state = { hang: false };
	const transport: HttpTransport = async (req) => {
		requests.push({ url: req.url, method: req.method, headers: req.headers, body: typeof req.body === "string" ? req.body : undefined, bytes: typeof req.body === "string" ? undefined : req.body });
		if (state.hang) {
			await new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new ReelixError("network_timeout", "cancelled")), { once: true }));
		}
		const a = answers.find((x) => (x.method ?? "GET") === req.method && (typeof x.url === "string" ? x.url === req.url : x.url.test(req.url)) && (x.times === undefined || (used.get(x) ?? 0) < x.times));
		if (!a) throw new ReelixError("network", `no canned answer for ${req.method} ${req.url}`);
		used.set(a, (used.get(a) ?? 0) + 1);
		const headers = new Headers(a.headers);
		for (const c of a.cookies ?? []) headers.append("set-cookie", c);
		const bytes = typeof a.body === "string" ? new TextEncoder().encode(a.body) : (a.body ?? new Uint8Array());
		return { status: a.status ?? 200, headers, url: req.url, bytes };
	};
	return { transport, requests, state, answers };
}

export type StartOptions = {
	/** The settings under `plugins.<id>`, by plugin id. */
	settings?: Record<string, unknown>;
	/** Secrets by full name. */
	secrets?: Record<string, string>;
	http?: CannedAnswer[];
	/** What the owner's model answers to `ctx.model.complete`. */
	model?: CannedModelAnswer[];
	/** What a background agent turn answers. */
	agent?: (prompt: string, title?: string) => PluginAgentOutcome | Promise<PluginAgentOutcome>;
	/** Use this app (with its data folder) rather than a new one. It stays open at `close`. */
	app?: Reelix;
	/** The first wait before a task that ended is started again. */
	taskDelayMs?: number;
};

/** A stand-in for the agent: what reaches it, and what it says in a channel's conversation. */
function fakeAgentHost(o: StartOptions) {
	type Ask = { id: string; question: string; kind: "choice" | "text" | "secret" | "confirm"; options?: string[] };
	const threads = new Map<string, { id: string; name: string; kind: string }>();
	const globalListeners = new Set<(e: any) => void>();
	const pending = new Map<string, Ask>();
	const received: { threadId: string; text: string; images: number; from?: string; by?: string }[] = [];
	const answers: { threadId: string; id: string; value: string; by?: string }[] = [];
	let seq = 0;
	const emit = (threadId: string, e: Record<string, unknown>) => {
		for (const l of globalListeners) l({ ...e, seq: ++seq, threadId });
	};
	return {
		conversation: {
			/** What reached the agent. */
			received,
			/** Answers to the agent's questions. */
			answers,
			/** The agent produces something in this thread. */
			emit,
			/** The agent asks in this thread. */
			ask(threadId: string, q: Ask) {
				pending.set(threadId, q);
				emit(threadId, { type: "ask", ...q });
			},
			/** The agent says one complete reply. */
			reply(threadId: string, text: string) {
				emit(threadId, { type: "assistant_start" });
				emit(threadId, { type: "text_delta", delta: text });
				emit(threadId, { type: "assistant_end" });
			},
		},
		host: {
			runtime: {},
			globalListeners,
			spendToday: () => ({ reached: false }),
			createThread(name: string, kind = "chat") {
				const t = { id: `test-thread-${threads.size + 1}`, name, kind };
				threads.set(t.id, t);
				return t;
			},
			getThread: (id: string) => threads.get(id),
			runToEnd: async (_thread: string, prompt: string) => (o.agent ? o.agent(prompt) : { state: "done", text: "no agent in this test" }),
			async send(threadId: string, text: string, opts: { images?: unknown[]; from?: string; by?: string } = {}) {
				received.push({ threadId, text, images: opts.images?.length ?? 0, from: opts.from, by: opts.by });
				return {};
			},
			answer(threadId: string, id: string, value: string, by?: string) {
				if (pending.get(threadId)?.id !== id) return false;
				pending.delete(threadId);
				answers.push({ threadId, id, value, by });
				return true;
			},
			pendingQuestion: (threadId: string) => pending.get(threadId),
		},
	};
}

/** Start plugin folders in a Reelix of their own, the way the server does. */
export async function startPlugins(folders: string[], o: StartOptions = {}) {
	const root = o.app ? undefined : mkdtempSync(join(tmpdir(), "reelix-plugin-test-"));
	const app = o.app ?? new Reelix(root);
	for (const [id, value] of Object.entries(o.settings ?? {})) app.setConfig(`plugins.${id}`, value);
	for (const [k, v] of Object.entries(o.secrets ?? {})) app.setSecret(k, v);
	const http = cannedHttp(o.http ?? []);
	const model = cannedModel(o.model ?? []);
	const { host, conversation } = fakeAgentHost(o);
	const jobs = new JobRunner(app, host as never);
	const manager = new PluginManager({ app, jobs, host: host as never, dirs: [], plugins: folders, transport: o.http ? http.transport : undefined, model: model.access, stopGraceMs: 50, taskDelayMs: o.taskDelayMs });
	app.plugins = manager;
	await manager.start();

	const info = (id: string): PluginInfo => {
		const p = manager.list().find((x) => x.id === id);
		assert.ok(p, `plugin ${id} was not found`);
		return p;
	};
	return {
		app,
		jobs,
		manager,
		http,
		model,
		conversation,
		info,
		/**
		 * `testing.piSession`: load the plugins' raw pi extensions into a stand-in session the way Reelix does (names
		 * checked, `session_start` emitted) and call their tools. `cwd` is the session's working folder.
		 */
		async piSession(session: { threadId: string; kind: "chat" | "channel" | "job" | "setup"; cwd?: string }) {
			const tools = new Map<string, any>();
			const handlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
			const notices: string[] = [];
			const taken = new Set(["bash", "read", "ls", "find", "grep", "write", "edit", "reelix", "show", "notify", "ask"]);
			const pi = {
				registerTool: (tool: any) => void tools.set(tool.name, tool),
				on: (event: string, h: (e: unknown, c: unknown) => unknown) => void handlers.set(event, [...(handlers.get(event) ?? []), h]),
			};
			const cwd = session.cwd ?? app.paths.workspace;
			for (const { factory } of sessionExtensions(manager.pi.list(), { threadId: session.threadId, kind: session.kind, notice: (t) => void notices.push(t) }, taken)) await factory(pi as never);
			for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start", reason: "startup" }, { cwd });
			return {
				tools: [...tools.keys()],
				notices,
				/** Call one of its tools as the agent would. */
				call: (name: string, params: Record<string, unknown> = {}) => {
					const tool = tools.get(name);
					assert.ok(tool, `no tool ${name}`);
					return tool.execute(`call_${name}`, params, undefined, undefined, { cwd }) as Promise<{ content: { type: string; text?: string }[]; details: any }>;
				},
			};
		},
		/** `testing.route`: call a plugin's route as the signed-in owner's browser would; the response as fetch gives it. */
		route(plugin: string, method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
			const web = new Hono();
			web.all("/api/plugins/:plugin/*", (c) => manager.routes.dispatch(c));
			return Promise.resolve(web.request(`/api/plugins/${plugin}${path}`, { method, signal, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
		},
		/** `testing.hook`: every handler of a hook with this input, as Reelix calls them; their valid results. */
		hook: <H extends HookId>(name: H, input: PluginHooks[H]["input"]) => app.hooks.each(name, input),
		/** `testing.runJob`: queue one run of a plugin's job and wait for its end. */
		async runJob(kind: string, payload: Record<string, unknown> = {}) {
			const id = jobs.enqueue(kind, payload);
			const state = () => app.db.prepare("SELECT state, summary FROM job_runs WHERE id = ?").get(id) as { state: string; summary: string | null };
			for (let i = 0; i < 500; i++) {
				if (!["queued", "running"].includes(state().state)) return { ...state() };
				await jobs.tick();
				await new Promise((r) => setTimeout(r, 10));
			}
			assert.fail(`job ${kind} did not finish`);
		},
		kv: (pluginId: string, key: string) => {
			const raw = kvGet(app.db, `plugin:${pluginId}:${key}`);
			return raw === undefined ? undefined : JSON.parse(raw);
		},
		async close() {
			jobs.stop();
			await manager.stop();
			if (root) {
				app.close();
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
}

export type StartedPlugins = Awaited<ReturnType<typeof startPlugins>>;

// ---------------------------------------------------------------- the checker (§14.2 step 3)

/** `passed`: what was checked and held, in order, for `reelix plugin check`. */
export type CheckResult = { errors: string[]; warnings: string[]; passed: string[] };

/** Where a plugin keeps what its check runs with, relative to its folder. */
export const CHECK_FILE = "test/check.ts";

/**
 * What `reelix plugin check` and `checkPluginFolder` run a plugin with: the default export of its
 * `test/check.ts`. Every seam the plugin provides needs an entry under `seams`.
 */
export type PluginCheck = {
	/** The plugin's settings, as the owner would save them under `plugins.<id>`. */
	settings?: Record<string, unknown>;
	/** Its secrets, by the names in `uses.secrets`. */
	secrets?: Record<string, string>;
	/** Answers recorded from the real service. Anything else the plugin fetches is refused. */
	http?: CannedAnswer[];
	/** Answers recorded from a real model, for a plugin that uses the owner's models. */
	model?: CannedModelAnswer[];
	/** Folders of the plugins it requires (`requires.plugins`), relative to its own; they start with it. */
	plugins?: string[];
	/**
	 * For each seam another plugin owns that it provides: its provider id and calls to make. Each answer is
	 * checked against the owner's declared contract, and every call must answer.
	 */
	pluginSeams?: Record<string, { provider: string; calls: { method: string; args: unknown[] }[] }>;
	/** Work before the conformance suites run, such as adding the device a notifier sends to. */
	prepare?(t: StartedPlugins): Promise<void>;
	/** What each seam's conformance suite runs with. A chat channel is paired with `owner` before any suite runs. */
	seams?: {
		"reelix:subtitle.source@1"?: { provider: string } & SubtitleSourceRecording;
		"reelix:indexer@1"?: { provider: string } & IndexerRecording;
		"reelix:notifier@1"?: { provider: string };
		"reelix:chat.channel@1"?: { provider: string; owner: string };
		"reelix:downloader@1"?: { provider: string } & DownloaderRecording;
		"reelix:media.server@1"?: { provider: string } & MediaServerRecording;
		"reelix:player@1"?: { provider: string } & PlayerRecording;
		"reelix:metadata.source@1"?: { provider: string } & MetadataRecording;
		"reelix:trends.source@1"?: { provider: string } & TrendsRecording;
		"reelix:translator@1"?: { provider: string } & TranslatorRecording;
	};
};

/** A stand-in provider, so a plugin that requires a seam can start alone. */
const STAND_INS: { [S in SeamId]: () => any } = {
	"reelix:subtitle.source@1": () => ({ id: "stand-in-subtitles", label: "Stand-in", kinds: ["movie"], languages: ["en"], search: async () => [], download: async () => ({ outcome: "unavailable", message: "stand-in" }) }),
	"reelix:indexer@1": () => ({ id: "stand-in-indexer", label: "Stand-in", kinds: ["movie"], sites: async () => [], search: async () => ({ hits: [], sites: [] }), fetch: async () => ({ outcome: "unavailable", message: "stand-in" }) }),
	"reelix:notifier@1": () => ({ id: "stand-in-notifier", label: "Stand-in", can: { images: false, update: false, answers: false }, send: async () => ({}) }),
	"reelix:chat.channel@1": () => ({ id: "stand-in-channel", label: "Stand-in", can: { buttons: false, images: false, typing: false }, say: async () => undefined }),
	"reelix:downloader@1": () => {
		const none = async () => undefined;
		return { id: "stand-in-downloader", label: "Stand-in", add: async () => ({ outcome: "unavailable", message: "stand-in" }), get: none, list: async () => [], files: async () => [], setWanted: none, start: none, stop: none, remove: none, addMark: none, freeSpace: none, defaultFolder: async () => "/stand-in" };
	},
	"reelix:media.server@1": () => {
		const none = async () => undefined;
		const empty = async () => [];
		return { id: "stand-in-media-server", label: "Stand-in", info: async () => ({ serverId: "stand-in", name: "Stand-in", version: "0" }), libraries: empty, users: empty, changed: none, refreshAll: none, items: empty, episodes: empty, nextUp: empty };
	},
	"reelix:player@1": () => ({ id: "stand-in-player", label: "Stand-in", links: async (requests: unknown[]) => requests.map(() => null) }),
	"reelix:metadata.source@1": () => ({ id: "stand-in-metadata", label: "Stand-in", find: async () => [] }),
	"reelix:trends.source@1": () => ({ id: "stand-in-trends", label: "Stand-in", trending: async () => [] }),
	"reelix:translator@1": () => ({ id: "stand-in-translator", label: "Stand-in", translate: async () => ({ outcome: "unavailable", message: "stand-in" }) }),
};

const NOTICE: Notice = { inboxId: "in_conformance", kind: "question", title: "Which version?", body: "Two releases fit.", answer: { kind: "choice", options: [{ id: "0", label: "First" }, { id: "1", label: "Second" }] }, path: "/inbox?item=in_conformance", urgent: true, badge: 1 };

const SAMPLE_RELEASE: HookRelease = { ref: "r_sample", title: "Sample.Film.2024.1080p.WEB-DL.x264-GRP", site: "sample", siteName: "Sample", size: 1_000_000_000, seeders: 10, hasMagnet: false, downloadFactor: 0, resolution: "1080p", source: "WEB-DL", codec: "x264", group: "GRP" };
const SAMPLE_TITLE = { id: "movie:1", name: "Sample Film", kind: "movie" as const, mediaClass: "movie", year: 2024, tmdbId: 1 };
const SAMPLE_PATH = "Sample Film (2024) [tmdbid-1]/Sample Film (2024) [tmdbid-1].mkv";

/** What the checker calls each hook with: a handler must cope with an ordinary input. */
const HOOK_SAMPLES: { [H in HookId]: PluginHooks[H]["input"] } = {
	"agent.prompt@1": { session: { kind: "chat" } },
	"release.filter@1": { title: SAMPLE_TITLE, releases: [SAMPLE_RELEASE] },
	"release.rank@1": { title: SAMPLE_TITLE, releases: [SAMPLE_RELEASE, { ...SAMPLE_RELEASE, ref: "r_other", downloadFactor: 1 }] },
	"organise.name@1": { title: SAMPLE_TITLE, items: [{ source: "/downloads/Sample.Film.2024.1080p.mkv", path: SAMPLE_PATH, kind: "video", parsed: { resolution: "1080p" } }] },
	"notify.before@1": { ...NOTICE, body: "A notice with a body long enough to be worth shortening. ".repeat(10) },
	"download.before@1": { release: SAMPLE_RELEASE, title: SAMPLE_TITLE, options: { files: [{ path: "Sample.Film.2024.1080p.WEB-DL.x264-GRP.mkv", size: 1_000_000_000, wanted: true }], size: 1_000_000_000, episodes: [] } },
	"subtitle.pick@1": { files: [{ name: "Sample.Film.2024.zh.ass", languages: ["zh"], format: "ass", score: 52 }, { name: "Sample.Film.2024.zh.srt", languages: ["zh"], format: "srt", score: 51 }, { name: "Sample.Film.2024.en.srt", languages: ["en"], format: "srt", score: 41 }] },
	"agent.tool@1": { tool: "reelix", input: { command: "download.status" }, operation: { name: "download.status", effect: "read" }, session: { threadId: "t_sample", kind: "chat" } },
};

/** Each seam's conformance suite, as the checker runs it. */
const SUITES: { [S in SeamId]: (t: StartedPlugins, recording: NonNullable<NonNullable<PluginCheck["seams"]>[S]>) => Promise<void> } = {
	"reelix:subtitle.source@1": (t, r) => subtitleSourceConformance(t, r.provider, r),
	"reelix:indexer@1": (t, r) => indexerConformance(t, r.provider, r),
	"reelix:notifier@1": (t, r) => notifierConformance(t, r.provider),
	"reelix:chat.channel@1": (t, r) => chatChannelConformance(t, r.provider),
	"reelix:downloader@1": (t, r) => downloaderConformance(t, r.provider, r),
	"reelix:media.server@1": (t, r) => mediaServerConformance(t, r.provider, r),
	"reelix:player@1": (t, r) => playerConformance(t, r.provider, r),
	"reelix:metadata.source@1": (t, r) => metadataConformance(t, r.provider, r),
	"reelix:trends.source@1": (t, r) => trendsConformance(t, r.provider, r),
	"reelix:translator@1": (t, r) => translatorConformance(t, r.provider, r),
};

const problem = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;

/**
 * The checker (`reelix plugin check`): starts the plugin in a folder through the real loading path with what
 * its `test/check.ts` gives, then checks the manifest and entry, that what it registers is what it declares,
 * each of its hooks on an ordinary input, and the conformance suite of every seam it provides against the
 * recorded answers. Needs no running Reelix.
 */
export async function checkPluginFolder(folder: string): Promise<CheckResult> {
	const file = join(folder, CHECK_FILE);
	let check: PluginCheck = {};
	if (existsSync(file)) {
		try {
			check = ((await import(pathToFileURL(file).href)) as { default?: PluginCheck }).default ?? {};
		} catch (e) {
			return { errors: [`${CHECK_FILE} cannot be loaded: ${problem(e)}`], warnings: [], passed: [] };
		}
	}
	return checkPlugin(folder, check);
}

async function checkPlugin(folder: string, check: PluginCheck): Promise<CheckResult> {
	const errors: string[] = [];
	const warnings: string[] = [];
	const passed: string[] = [];
	const root = mkdtempSync(join(tmpdir(), "reelix-plugin-check-"));
	const app = new Reelix(root);
	for (const seam of Object.keys(STAND_INS) as SeamId[]) app.seams.register(seam, STAND_INS[seam](), { plugin: "checker", builtIn: true, order: 0, track: (fn) => fn(), isOpen: () => true, signal: new AbortController().signal, onFailure: () => undefined });
	let t: StartedPlugins | undefined;
	try {
		const id = (JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { reelix?: { id?: unknown } }).reelix?.id;
		const secrets = Object.fromEntries(Object.entries(check.secrets ?? {}).map(([name, value]) => [`plugins.${String(id)}.${name}`, value]));
		// A task that fails for want of a recorded answer is not started again while the check runs.
		const required = (check.plugins ?? []).map((d) => resolve(folder, d));
		t = await startPlugins([folder, ...required], { app, settings: check.settings ? { [String(id)]: check.settings } : undefined, secrets, http: check.http ?? [], model: check.model, taskDelayMs: 60_000 });
		const p = t.manager.list().find((x) => x.id === id);
		if (!p) throw new Error("no plugin was found in the folder");
		for (const other of t.manager.list()) if (other.id !== id && other.state !== "active") errors.push(`${other.id}, which it requires, did not start: ${other.state}${other.error ? `: ${other.error}` : ""}`);
		if (p.state !== "active") {
			errors.push(`${p.id} did not start: ${p.state}${p.error ? `: ${p.error}` : ""}`);
			return { errors, warnings, passed };
		}
		passed.push(p.kind === "plugin" ? "the manifest is valid and the entry starts" : "the manifest is valid and the skills load");
		if (p.kind !== "plugin") return { errors, warnings, passed };
		const got = t.manager.registrations(p.id)!;
		const before = warnings.length;
		const compare = (what: string, declared: string[], registered: string[]) => {
			for (const d of declared) if (!registered.includes(d)) warnings.push(`${what} "${d}" is declared but was not registered`);
		};
		compare("seam", p.provides, got.provides);
		compare("hook", p.hooks, got.hooks);
		compare("operation", p.operations.map((n) => n.slice(p.id.length + 1)), got.operations);
		compare("typed tool", p.tools.map((n) => n.slice(p.id.length + 1)), got.tools);
		compare("job", p.jobs, got.jobs);
		compare("event", p.events, got.events);
		if (warnings.length === before) passed.push("it registered everything it declares");
		for (const hook of got.hooks as HookId[]) {
			const failures = t.info(p.id).failures;
			await t.hook(hook, HOOK_SAMPLES[hook]);
			if (t.info(p.id).failures > failures) errors.push(`hook ${hook} failed on an ordinary input: ${t.info(p.id).error}`);
			else passed.push(`hook ${hook} answers an ordinary input`);
		}
		const seams = check.seams ?? {};
		const owned = new Map(t.app.seams.ownedSeams().map((s) => [s.id, s]));
		for (const seam of p.provides.filter((s) => !s.startsWith("reelix:"))) {
			const recording = check.pluginSeams?.[seam];
			const owner = owned.get(seam)?.owner;
			if (!recording) errors.push(`${seam}: no calls to check it with; add them under pluginSeams in ${CHECK_FILE}`);
			else if (!owner) errors.push(`${seam}: its owner is not running; name its folder under plugins in ${CHECK_FILE}`);
			else {
				const problems: string[] = [];
				for (const c of recording.calls) {
					const answer = (await t.app.seams.callOwned(seam as PluginSeamId, owner, c.method, c.args)).find((a) => a.provider === recording.provider);
					if (!answer) problems.push(`there is no provider "${recording.provider}"`);
					else if (answer.error) problems.push(`${c.method}: ${answer.error}`);
				}
				if (problems.length) errors.push(`${seam} (${recording.provider}): ${problems[0]}`);
				else passed.push(`${seam} (${recording.provider}): ${recording.calls.length} calls answered within the contract of ${owner}`);
			}
		}
		for (const seam of p.provides.filter((s) => s.startsWith("reelix:")) as SeamId[]) {
			if (!seams[seam]) errors.push(`${seam}: no recorded answers, so its conformance suite cannot run; add them under seams in ${CHECK_FILE}`);
		}
		const channel = seams["reelix:chat.channel@1"];
		if (channel) linkChannel(t, channel.provider, channel.owner);
		await check.prepare?.(t);
		for (const seam of p.provides.filter((s) => s.startsWith("reelix:")) as SeamId[]) {
			const recording = seams[seam];
			if (!recording) continue;
			try {
				await (SUITES[seam] as (t: StartedPlugins, r: typeof recording) => Promise<void>)(t, recording);
				passed.push(`${seam} conformance suite (${recording.provider}), against the recorded answers`);
			} catch (e) {
				errors.push(`${seam} conformance suite (${recording.provider}): ${problem(e)}`);
			}
		}
	} catch (e) {
		errors.push(problem(e));
	} finally {
		await t?.close();
		app.close();
		rmSync(root, { recursive: true, force: true });
	}
	return { errors, warnings, passed };
}

/**
 * The settings copy a plugin's manifest names (`reelix.settings`) and what it must hold: the code's settings
 * schema as JSON. Undefined when the plugin has neither. Loads the plugin's code.
 */
export async function settingsCopy(folder: string): Promise<{ file: string; expected: string } | undefined> {
	const manifest = readManifest(folder, new Set());
	if (!manifest.entry) return undefined; // a skill pack has no code
	const definition = await loadPlugin(folder, manifest.entry);
	if (!definition.config && !manifest.settings) return undefined;
	if (!definition.config || !manifest.settings) throw new Error(`${manifest.id}: the code has ${definition.config ? "settings" : "no settings"} and the manifest ${manifest.settings ? "names" : "does not name"} a settings file`);
	return { file: join(folder, manifest.settings), expected: `${JSON.stringify(definition.config, null, "\t")}\n` };
}

// ---------------------------------------------------------------- conformance suites (§7)

async function refusesToHang(t: StartedPlugins, run: () => Promise<unknown>): Promise<void> {
	t.app.seams.limitMs = 150;
	t.http.state.hang = true;
	const started = Date.now();
	try {
		const r = await run().catch((e: unknown) => e);
		if (r instanceof Error) assert.equal((r as ReelixError).code, "provider_timeout", r.message);
		else if (!isOutcome(r)) assert.fail("a provider whose service never answers must not produce a result");
		assert.ok(Date.now() - started < 2_000, "the call ended soon after its deadline");
	} finally {
		t.http.state.hang = false;
		t.app.seams.limitMs = undefined;
	}
}

type SubtitleSourceRecording = { query: SubtitleQuery; expectHits: number };

/** `reelix:subtitle.source@1`, against answers the provider's author recorded from the real service. */
async function subtitleSourceConformance(t: StartedPlugins, providerId: string, recording: SubtitleSourceRecording): Promise<void> {
	const p = t.app.seams.provider("reelix:subtitle.source@1", providerId);
	assert.ok(p, `no provider ${providerId}`);
	for (const language of recording.query.languages) assert.ok(p.impl.languages.includes(language), `${providerId} says it does not cover ${language}`);
	const hits = await p.call("search", [recording.query]);
	assert.ok(!isOutcome(hits), `search answered ${JSON.stringify(hits)}`);
	assert.equal(hits.length, recording.expectHits, "the recorded answer's hits");
	assert.equal(new Set(hits.map((h) => h.ref)).size, hits.length, "refs are unique");
	const got = await p.call("download", [hits[0]!.ref]);
	assert.ok(!isOutcome(got), `download answered ${JSON.stringify(got)}`);
	assert.ok(got.bytes.length > 0, "the download is not empty");
	assert.equal(t.info(p.plugin).failures, 0, "nothing counted as a failure");
	await refusesToHang(t, () => p.call("search", [recording.query]));
}

type IndexerRecording = { query: IndexerQuery; expectHits: number };

/** `reelix:indexer@1`, against answers the provider's author recorded from the real service. */
async function indexerConformance(t: StartedPlugins, providerId: string, recording: IndexerRecording): Promise<void> {
	const p = t.app.seams.provider("reelix:indexer@1", providerId);
	assert.ok(p, `no provider ${providerId}`);
	const sites = await p.call("sites", []);
	assert.ok(!isOutcome(sites), `sites answered ${JSON.stringify(sites)}`);
	const ids = sites.map((s) => s.id);
	const r = await p.call("search", [{ ...recording.query, sites: ids }]);
	assert.equal(r.hits.length, recording.expectHits, "the recorded answer's hits");
	assert.deepEqual(r.sites.map((s) => s.site).sort(), [...ids].sort(), "every site is reported");
	for (const h of r.hits) assert.ok(ids.includes(h.site), `hit ${h.title} names an unknown site`);
	assert.equal(t.info(p.plugin).failures, 0, "nothing counted as a failure");
	const got = await p.call("fetch", [r.hits[0]!.ref]);
	assert.ok(!isOutcome(got), `fetch answered ${JSON.stringify(got)}`);
	await refusesToHang(t, () => p.call("sites", []));
}


/** `reelix:notifier@1`, against answers the provider's author recorded. The provider must be ready to send. */
async function notifierConformance(t: StartedPlugins, providerId: string): Promise<void> {
	const p = t.app.seams.provider("reelix:notifier@1", providerId);
	assert.ok(p, `no provider ${providerId}`);
	const failuresBefore = t.info(p.plugin).failures;
	const sent = await p.call("send", [NOTICE]);
	assert.ok(!isOutcome(sent), `send answered ${JSON.stringify(sent)}`);
	assert.equal(p.has("update"), p.impl.can.update, "`update` exists exactly when can.update says so");
	if (p.impl.can.update) {
		assert.equal(typeof sent.ref, "string", "a provider that can update returns a ref");
		const updated = await p.call("update", [sent.ref!, NOTICE, { status: "answered", answer: "First" }]);
		assert.ok(!isOutcome(updated), `update answered ${JSON.stringify(updated)}`);
	}
	assert.equal(t.info(p.plugin).failures, failuresBefore, "nothing counted as a failure");
	await refusesToHang(t, () => p.call("send", [NOTICE]));
}

/** `reelix:chat.channel@1`: every kind of message is accepted, and a provider whose service hangs stops at the deadline. The channel must be linked. */
async function chatChannelConformance(t: StartedPlugins, channelId: string): Promise<void> {
	const p = t.app.seams.provider("reelix:chat.channel@1", channelId);
	assert.ok(p, `no provider ${channelId}`);
	assert.ok(channelRow(t.app, channelId)?.owner, "the channel must be linked (see linkChannel)");
	const failuresBefore = t.info(p.plugin).failures;
	const messages: ChatOut[] = [{ type: "text", text: "Hello" }, { type: "card", kind: "text", text: "A card as text" }, { type: "ask", id: "q_conformance", question: "Which?", options: [{ id: "0", label: "First" }] }];
	if (p.impl.can.typing) messages.push({ type: "working" });
	for (const m of messages) {
		const r = await p.call("say", [m]);
		assert.ok(!isOutcome(r), `say(${m.type}) answered ${JSON.stringify(r)}`);
	}
	assert.equal(t.info(p.plugin).failures, failuresBefore, "nothing counted as a failure");
	await refusesToHang(t, () => p.call("say", [{ type: "text", text: "Anyone there?" }]));
}

/** What the downloader suite runs with: transfers the recorded client has, and one it gets by `add`. */
type DownloaderRecording = {
	/** A transfer with metadata that carries `mark`. */
	known: { id: string; mark: string; magnet: string };
	/** An id the client does not have. */
	unknown: string;
	/** A transfer whose metadata has not arrived, when the client can have one. */
	withoutMetadata?: string;
	/** A magnet the client does not have before `add` and has after it, paused, with `mark`. */
	added: { id: string; magnet: string; mark: string };
};

/**
 * `reelix:downloader@1` (docs/plugins.md §7.5), against answers the provider's author recorded from the real
 * client. Checks the rules every provider follows; the shapes of what it returns are checked by Reelix on
 * every call anyway.
 */
async function downloaderConformance(t: StartedPlugins, providerId: string, r: DownloaderRecording): Promise<void> {
	const p = t.app.seams.provider("reelix:downloader@1", providerId);
	assert.ok(p, `no provider ${providerId}`);
	const failuresBefore = t.info(p.plugin).failures;
	const { known, unknown } = r;

	// An empty list does nothing: on some clients an empty or missing list means "everything".
	const sent = t.http.requests.length;
	assert.deepEqual(await p.call("list", [{ ids: [] }]), [], "list({ ids: [] }) is []");
	assert.deepEqual(await p.call("list", [{ ids: [], mark: known.mark }]), [], "list({ ids: [], mark }) is []");
	await p.call("start", [[]]);
	await p.call("stop", [[]]);
	await p.call("remove", [[], { deleteFiles: true }]);
	await p.call("addMark", [[], known.mark]);
	await p.call("setWanted", [known.id, [], false]);
	assert.equal(t.http.requests.length, sent, "an empty list never reaches the service");

	// list: ids and mark combine with AND; unknown ids are left out.
	const all = await p.call("list", [{}]);
	assert.equal(new Set(all.map((x) => x.id)).size, all.length, "every transfer once");
	assert.ok(all.some((x) => x.id === known.id), "list() holds every transfer");
	assert.deepEqual((await p.call("list", [{ ids: [known.id] }])).map((x) => x.id), [known.id]);
	assert.deepEqual((await p.call("list", [{ ids: [known.id, unknown] }])).map((x) => x.id), [known.id], "an unknown id is left out");
	const marked = await p.call("list", [{ mark: known.mark }]);
	assert.ok(marked.length && marked.every((x) => x.marks.includes(known.mark)), "list({ mark }) has only transfers with the mark");
	assert.deepEqual((await p.call("list", [{ ids: [known.id], mark: known.mark }])).map((x) => x.id), [known.id], "ids and mark together");

	// get, files
	const got = await p.call("get", [known.id]);
	assert.equal(got?.id, known.id);
	assert.ok(got.hasMetadata, "the known transfer has metadata");
	assert.equal(await p.call("get", [unknown]), undefined, "get of an unknown id is undefined");
	const files = await p.call("files", [known.id]);
	assert.ok(files.length > 0, "files of a transfer with metadata");
	const sizeOfWanted = files.filter((f) => f.wanted).reduce((n, f) => n + f.size, 0);
	assert.equal(got.size, sizeOfWanted, "size is the bytes of the wanted files");
	if (r.withoutMetadata) {
		const bare = (await p.call("get", [r.withoutMetadata])) as Transfer;
		assert.equal(bare.hasMetadata, false);
		assert.deepEqual(await p.call("files", [r.withoutMetadata]), [], "files is [] before metadata");
	}

	// add: the transfer exists with the mark when add returns; a duplicate says so.
	const added = await p.call("add", [{ magnet: r.added.magnet }, { paused: true, mark: r.added.mark }]);
	assert.ok(!isOutcome(added), `add answered ${JSON.stringify(added)}`);
	assert.deepEqual(added, { id: r.added.id, duplicate: false });
	const fresh = (await p.call("get", [r.added.id])) as Transfer;
	assert.ok(fresh?.marks.includes(r.added.mark), "after add the transfer exists with its mark");
	assert.ok(fresh.state === "stopped" || fresh.state === "queued", `added paused, but its state is ${fresh.state}`);
	assert.ok(!fresh.downSpeed, "a paused transfer requests no payload");
	const again = await p.call("add", [{ magnet: known.magnet }, { paused: true, mark: known.mark }]);
	assert.deepEqual(again, { id: known.id, duplicate: true }, "adding a transfer the client has is a duplicate");

	// changes: an undefined or unusable cursor gives a full answer.
	if (p.has("changes")) {
		const first = await p.call("changes", [undefined]);
		assert.ok(first.full, "changes(undefined) is full");
		assert.deepEqual(first.removed, []);
		assert.ok(first.changed.some((x) => x.id === known.id), "a full answer holds every transfer");
		assert.ok((await p.call("changes", ["not a cursor"])).full, "an unusable cursor gives a full answer");
		const next = await p.call("changes", [first.cursor]);
		assert.equal(typeof next.cursor, "string");
	}

	assert.ok((await p.call("defaultFolder", [])).length > 0);
	const free = await p.call("freeSpace", []);
	assert.ok(free === undefined || free >= 0);
	assert.equal(t.info(p.plugin).failures, failuresBefore, "nothing counted as a failure");
	await refusesToHang(t, () => p.call("list", [{}]));
}

/** What the media server suite runs with: a user the recorded server has, and one of their shows. */
type MediaServerRecording = {
	userId: string;
	/** A show of that user with episodes. */
	showId: string;
	/** Paths the server is told changed, as it names them. */
	changed: string[];
};

/**
 * `reelix:media.server@1` (docs/plugins.md §7.7), against answers the provider's author recorded from the real
 * server: the shapes are checked by Reelix on every call; this checks the rules.
 */
async function mediaServerConformance(t: StartedPlugins, providerId: string, r: MediaServerRecording): Promise<void> {
	const p = t.app.seams.provider("reelix:media.server@1", providerId);
	assert.ok(p, `no provider ${providerId}`);
	const failuresBefore = t.info(p.plugin).failures;
	const sent = t.http.requests.length;
	await p.call("changed", [[]]);
	assert.equal(t.http.requests.length, sent, "an empty list of changed paths never reaches the server");
	assert.ok((await p.call("info", [])).serverId, "info has the server's id");
	const users = await p.call("users", []);
	assert.ok(users.some((u) => u.id === r.userId), "the recorded user is listed");
	for (const lib of await p.call("libraries", [])) assert.ok(lib.paths.every((x) => x.length > 0), `library ${lib.name}: every path is named`);
	const all = await p.call("items", [{ userId: r.userId, kinds: ["movie", "show"] }]);
	assert.ok(all.some((i) => i.id === r.showId && i.kind === "show"), "items holds the recorded show");
	const movies = await p.call("items", [{ userId: r.userId, kinds: ["movie"] }]);
	assert.ok(movies.every((i) => i.kind === "movie"), "only the kinds asked for");
	const limited = await p.call("items", [{ userId: r.userId, kinds: ["movie", "show"], limit: 1 }]);
	assert.ok(limited.length <= 1, "at most `limit` items");
	const played = await p.call("items", [{ userId: r.userId, kinds: ["movie", "show"], filter: "played", sort: "lastPlayed" }]);
	const times = played.map((i) => i.lastPlayedAt ?? "");
	assert.deepEqual(times, [...times].sort().reverse(), "sorted by lastPlayed: the most recent first");
	assert.ok(played.filter((i) => i.kind === "show").every((i) => (i.episodesPlayed ?? 0) > 0), "a played show has played episodes");
	assert.ok((await p.call("items", [{ userId: r.userId, kinds: ["movie", "show"], filter: "favourite" }])).every((i) => i.favourite), "favourites are favourites");
	const episodes = await p.call("episodes", [{ userId: r.userId, showId: r.showId }]);
	assert.ok(episodes.length > 0 && episodes.every((e) => e.showId === r.showId), "the show's episodes, each naming it");
	for (const e of await p.call("nextUp", [r.userId])) assert.ok(e.showId, "a next episode names its show");
	await p.call("changed", [r.changed.map((path) => ({ path, change: "created" as const }))]);
	await p.call("refreshAll", []);
	assert.equal(t.info(p.plugin).failures, failuresBefore, "nothing counted as a failure");
	await refusesToHang(t, () => p.call("users", []));
}

/** What the player suite runs with: requests, and how many of them this player can open. */
type PlayerRecording = { requests: PlayRequest[]; expectLinks: number };

/** `reelix:player@1` (docs/plugins.md §7.9): one answer per request, in order; links are built, not fetched. */
async function playerConformance(t: StartedPlugins, providerId: string, r: PlayerRecording): Promise<void> {
	const p = t.app.seams.provider("reelix:player@1", providerId);
	assert.ok(p, `no provider ${providerId}`);
	const sent = t.http.requests.length;
	assert.deepEqual(await p.call("links", [[]]), [], "no requests, no answers");
	const links = await p.call("links", [r.requests]);
	assert.equal(links.length, r.requests.length, "one answer per request");
	assert.equal(links.filter(Boolean).length, r.expectLinks, "the recorded number of links");
	const again = await p.call("links", [[...r.requests].reverse()]);
	assert.deepEqual(again, [...links].reverse(), "answers follow the order of the requests");
	assert.equal(t.http.requests.length, sent, "a player builds links without the network");
	assert.equal(t.info(p.plugin).failures, 0, "nothing counted as a failure");
}

/** What the metadata suite runs with: a search, a link, and the ids of an entry with details. */
type MetadataRecording = { find?: { text: string; kind?: Kind; expectHits: number }; link?: { text: string; ids: Ids }; enrich?: Ids; notMine: string };

/** `reelix:metadata.source@1` (docs/plugins.md §7.6), against answers the provider's author recorded from the real service. */
async function metadataConformance(t: StartedPlugins, providerId: string, r: MetadataRecording): Promise<void> {
	const p = t.app.seams.provider("reelix:metadata.source@1", providerId);
	assert.ok(p, `no provider ${providerId}`);
	const failuresBefore = t.info(p.plugin).failures;
	for (const [method, given] of [["find", r.find], ["fromLink", r.link], ["enrich", r.enrich]] as const) assert.equal(p.has(method), !!given, `${method}: recorded answers exactly when the provider has it`);
	if (r.find) {
		const hits = await p.call("find", [{ text: r.find.text, kind: r.find.kind }]);
		assert.ok(!isOutcome(hits), `find answered ${JSON.stringify(hits)}`);
		assert.equal(hits.length, r.find.expectHits, "the recorded answer's hits");
		assert.ok(hits.every((h) => Object.values(h.ids).some((v) => v !== undefined)), "every hit carries an id of this source");
	}
	if (r.link) {
		const sent = t.http.requests.length;
		assert.equal(await p.call("fromLink", [r.notMine]), undefined, "another source's link is not this one's");
		assert.equal(t.http.requests.length, sent, "another source's link is recognised without the network");
		const hit = await p.call("fromLink", [r.link.text]);
		assert.ok(hit && !isOutcome(hit), `fromLink answered ${JSON.stringify(hit)}`);
		for (const [k, v] of Object.entries(r.link.ids)) assert.equal(hit.ids[k as keyof Ids], v, `the link's ids.${k}`);
	}
	if (r.enrich) {
		const e = await p.call("enrich", [r.enrich]);
		assert.ok(!isOutcome(e), `enrich answered ${JSON.stringify(e)}`);
		assert.ok(e.rating || e.episodes, "the recorded entry has details");
		const sent = t.http.requests.length;
		assert.deepEqual(await p.call("enrich", [{ tmdb: 1 }]), {}, "nothing for ids of other sources");
		assert.equal(t.http.requests.length, sent, "ids of other sources need no request");
	}
	assert.equal(t.info(p.plugin).failures, failuresBefore, "nothing counted as a failure");
	await refusesToHang(t, () => (r.find ? p.call("find", [{ text: r.find.text }]) : p.call("fromLink", [r.link!.text])));
}

/** What the trends suite runs with: how many hits the recorded list gives. */
type TrendsRecording = { expectHits: number };

/** `reelix:trends.source@1` (docs/plugins.md §7.10), against answers the provider's author recorded from the real service. */
async function trendsConformance(t: StartedPlugins, providerId: string, r: TrendsRecording): Promise<void> {
	const p = t.app.seams.provider("reelix:trends.source@1", providerId);
	assert.ok(p, `no provider ${providerId}`);
	const failuresBefore = t.info(p.plugin).failures;
	const week = await p.call("trending", [{ kind: "all", window: "week" }]);
	assert.ok(!isOutcome(week), `trending answered ${JSON.stringify(week)}`);
	assert.equal(week.length, r.expectHits, "the recorded answer's hits");
	assert.ok(week.every((h) => Object.values(h.ids).some((v) => v !== undefined)), "every hit carries an id of this source");
	for (const kind of ["movie", "show", "anime"] as const) {
		const got = await p.call("trending", [{ kind, window: "week" }]);
		assert.ok(isOutcome(got) || got.every((h) => h.kind === kind || (kind === "show" && h.kind === "anime")), `kind ${kind}: only that kind (an anime series counts as a show)`);
	}
	assert.equal(t.info(p.plugin).failures, failuresBefore, "nothing counted as a failure");
	await refusesToHang(t, () => p.call("trending", [{ kind: "all", window: "day" }]));
}

/** What the translator suite runs with: a chunk, and how many of its lines the recorded answers translate. */
type TranslatorRecording = { job: TranslateJob; expectLines: number };

/**
 * `reelix:translator@1` (docs/plugins.md §7.8), against answers its author recorded: only lines asked for come
 * back, each once; an answer that cannot be read is no lines, not a failure; a model that cannot answer now is an
 * outcome, not a failure; and a translator whose model or service never answers stops at the deadline.
 */
async function translatorConformance(t: StartedPlugins, providerId: string, r: TranslatorRecording): Promise<void> {
	const p = t.app.seams.provider("reelix:translator@1", providerId);
	assert.ok(p, `no provider ${providerId}`);
	const failuresBefore = t.info(p.plugin).failures;
	const got = await p.call("translate", [r.job]);
	assert.ok(!isOutcome(got), `translate answered ${JSON.stringify(got)}`);
	assert.equal(got.lines.length, r.expectLines, "the recorded answer's lines");
	const asked = new Set(r.job.lines.map((l) => l.n));
	assert.ok(got.lines.every((l) => asked.has(l.n)), "only lines asked for");
	if (!r.job.novelty) assert.ok(got.lines.every((l) => !l.borrowed), "borrowed words only for a constructed language or a style");
	const usesModel = t.model.calls.length > 0;
	if (usesModel) {
		t.model.state.unreadable = true;
		try {
			const none = await p.call("translate", [r.job]);
			assert.ok(!isOutcome(none) && none.lines.length === 0, "an answer that cannot be read gives no lines");
		} finally {
			t.model.state.unreadable = false;
		}
		t.model.state.down = true;
		try {
			const out = await p.call("translate", [r.job]);
			assert.ok(isOutcome(out) && out.outcome === "unavailable", "no model that can answer is the outcome unavailable");
		} finally {
			t.model.state.down = false;
		}
	}
	assert.equal(t.info(p.plugin).failures, failuresBefore, "nothing counted as a failure");
	if (usesModel) {
		t.app.seams.limitMs = 150;
		t.model.state.hang = true;
		const started = Date.now();
		try {
			const res = await p.call("translate", [r.job]).catch((e: unknown) => e);
			if (res instanceof Error) assert.equal((res as ReelixError).code, "provider_timeout", res.message);
			else assert.ok(isOutcome(res), "a translator whose model never answers must not produce lines");
			assert.ok(Date.now() - started < 2_000, "the call ended soon after its deadline");
		} finally {
			t.model.state.hang = false;
			t.app.seams.limitMs = undefined;
		}
	} else await refusesToHang(t, () => p.call("translate", [r.job]));
}

/** Pair a channel without going through a chat app. */
export const linkChannel = (t: StartedPlugins, channelId: string, owner: string) => setChannelOwner(t.app, channelId, owner);
