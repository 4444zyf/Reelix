/**
 * The Reelix server: one Node process (§3). Web UI + API + event streams, the private local
 * socket for the CLI, the pi host, job runner, completion watcher and Telegram bot.
 */
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Type } from "typebox";
import { Reelix, addInbox, defineOperation, errorMessage, reconcileOnStartup } from "@reelix/core";
import { acquireLock } from "@reelix/core/lock.ts";
import { AgentHost, REPO_ROOT } from "./agent/host.ts";
import { socketApp, webApp } from "./http.ts";
import { JobRunner } from "./jobs.ts";
import { registerNightly } from "./nightly.ts";
import { TelegramBot } from "./telegram.ts";
import { Watcher } from "./watcher.ts";
import { plugins } from "./plugins.ts";

const app = new Reelix();
const release = acquireLock(app.paths, "server");
if (!release) {
	console.error(`Another Reelix process holds the lock on ${app.paths.root}.`);
	process.exit(1);
}
app.watchConfig();
if (app.configWarning) console.warn(app.configWarning);

const binDir = process.env.REELIX_BIN_DIR ?? join(REPO_ROOT, "bin");
process.env.REELIX_BIN_DIR = binDir;
let jobs!: JobRunner;
let telegram!: TelegramBot;

const host = new AgentHost(app, {
	piDir: process.env.REELIX_PI_DIR ?? app.paths.pi,
	binDir,
	skillsDir: join(REPO_ROOT, "skills"),
	extraTools: (ctx) => plugins.flatMap((p) => p.tools?.(ctx) ?? []),
	notify: async (n) => {
		const it = addInbox(app, { kind: n.kind ?? "notice", title: n.title, body: n.body, options: n.options, image_path: n.image_path, source: n.source, job_run_id: n.jobRunId, payload: { urgent: n.urgent || n.wait || n.kind === "question" } });
		return it.id;
	},
});
try {
	await host.init();
} catch (e) {
	console.error(`The agent could not start: ${errorMessage(e)}. Operations, the watcher and the web UI still run.`);
}

jobs = new JobRunner(app, host);
telegram = new TelegramBot(app, host);
const watcher = new Watcher(app, jobs);
registerNightly(app, jobs);

// Operations that need the running server.
defineOperation({
	name: "telegram.link",
	summary: "Show a one-time code to send to the bot, linking the owner's Telegram account",
	effect: "read",
	input: Type.Object({}),
	async run() {
		telegram.start();
		return { code: telegram.newLinkCode(), status: telegram.status() };
	},
	toText: (o: any) => `Send this code to ${o.status.bot ? "@" + o.status.bot : "the bot"} within 10 minutes: ${o.code}`,
});
defineOperation({
	name: "telegram.test",
	summary: "Send a test message to the owner on Telegram",
	effect: "write",
	input: Type.Object({}),
	async run() {
		return { result: await telegram.test() };
	},
	toText: () => "Test message sent.",
});
defineOperation({
	name: "job.run",
	summary: "Start a background agent job now with a task in plain words",
	effect: "write",
	input: Type.Object({ task: Type.String(), title: Type.Optional(Type.String()) }),
	positional: ["task"],
	async run(_ctx, i) {
		return { id: jobs.enqueue("agent", { prompt: i.task, title: i.title ?? i.task.slice(0, 60) }) };
	},
	toText: (o: any) => `Queued background job ${o.id}.`,
});
defineOperation({
	name: "job.list",
	summary: "Scheduled jobs and recent job runs",
	effect: "read",
	input: Type.Object({}),
	async run() {
		return jobs.list();
	},
	toText: (o: any) => `${o.jobs.map((j: any) => `${j.id} | ${j.kind} | ${j.schedule} | next ${j.next_run_at}`).join("\n")}\nruns:\n${o.runs.slice(0, 20).map((r: any) => `${r.id} | ${r.kind} | ${r.state} | ${r.created_at.slice(0, 16)} | ${(r.summary ?? "").slice(0, 80)}`).join("\n")}`,
});
for (const p of plugins) p.init?.({ app, host, jobs, watcher, telegram });

const settled = await reconcileOnStartup(app);
if (settled.settled || settled.unknown) console.log(`Ledger: settled ${settled.settled} interrupted actions; ${settled.unknown} remain unknown.`);

const deps = { app, host, jobs, telegram, webDir: process.env.REELIX_WEB_DIR ?? join(REPO_ROOT, "packages/web/dist"), extra: (api: any) => plugins.forEach((p) => p.routes?.(api, { app, host })) };

// Private local socket for the CLI and the agent's shell (§3.3).
if (existsSync(app.paths.socket)) unlinkSync(app.paths.socket);
const { createServer } = await import("node:http");
const { getRequestListener } = await import("@hono/node-server");
const socketServer = createServer(getRequestListener(socketApp(deps).fetch));
socketServer.listen(app.paths.socket, () => chmodSync(app.paths.socket, 0o600));

const web = serve({ fetch: webApp(deps).fetch, hostname: app.config.web.host, port: Number(process.env.REELIX_PORT ?? app.config.web.port) }, (info) => {
	console.log(`Reelix is listening on http://${info.address}:${info.port} (data: ${app.paths.root})`);
});

jobs.start();
watcher.start();
telegram.start();

let stopping = false;
async function shutdown() {
	if (stopping) return;
	stopping = true;
	console.log("Stopping…");
	watcher.stop();
	jobs.stop();
	telegram.stop();
	web.close();
	socketServer.close();
	host.dispose();
	try {
		unlinkSync(app.paths.socket);
	} catch {}
	app.close();
	release!();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
