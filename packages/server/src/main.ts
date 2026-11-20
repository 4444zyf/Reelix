/**
 * The Reelix server: one Node process (§3). Web UI + API + event streams, the private local
 * socket for the CLI, the pi host, job runner, completion watcher and the plugins.
 * Run this file to start it; `reelix serve`, `reelix plugin dev` and scripts/demo.ts call `startServer`.
 */
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Type } from "typebox";
import { Reelix, applyEnvDefaults, errorMessage, reconcileOnStartup } from "@reelix/core";
import { acquireLock } from "@reelix/core/lock.ts";
import { AgentHost, REPO_ROOT } from "./agent/host.ts";
import { postToInbox } from "./agent/tools.ts";
import { startFollows } from "./follows.ts";
import { agentSocketApp, socketApp, webApp } from "./http.ts";
import { ISOLATION, isolateData } from "./isolation.ts";
import { JobRunner } from "./jobs.ts";
import { registerNightly } from "./nightly.ts";
import { Watcher } from "./watcher.ts";
import { PluginManager } from "./plugins/manager.ts";
import { PiExtensions } from "./plugins/pi.ts";
import { PluginRoutes } from "./plugins/routes.ts";
import { startTranslation } from "./translation.ts";

/**
 * Start Reelix on the data folder of `REELIX_DATA`.
 * `devPlugin`: a plugin folder loaded as well, without install record or hash (`reelix plugin dev`, docs/plugins.md §13.3);
 * only the command line can name one.
 */
export async function startServer(o: { devPlugin?: string } = {}): Promise<void> {
	// SIGUSR1 would open Node's debugger, code execution in Reelix for any process of its user (a plugin's too). Every
	// start passes --disable-sigusr1; a listener keeps it closed for a start by hand without it (docs/plugins.md §11.7).
	process.on("SIGUSR1", () => undefined);
	const app = new Reelix();
	const release = acquireLock(app.paths, "server");
	if (!release) {
		console.error(`Another Reelix process holds the lock on ${app.paths.root}.`);
		process.exit(1);
	}
	// In the image the agent's shell and plugins' processes run as other users: close the data folder to them first.
	if (ISOLATION) isolateData(app.paths, ISOLATION);
	app.watchConfig();
	if (app.configWarning) console.warn(app.configWarning);
	// Addresses docker-compose.yml passes for the services it started (only into empty settings).
	for (const a of applyEnvDefaults(app)) console.log(`Setting from the environment: ${a}`);

	const binDir = process.env.REELIX_BIN_DIR ?? join(REPO_ROOT, "bin");
	process.env.REELIX_BIN_DIR = binDir;
	let jobs!: JobRunner;
	// Plugins' raw pi extensions and routes: the agent host and the web server read what the plugins register.
	const extensions = new PiExtensions();
	const routes = new PluginRoutes();

	const host = new AgentHost(app, {
		piDir: process.env.REELIX_PI_DIR ?? app.paths.pi,
		binDir,
		skillsDir: join(REPO_ROOT, "skills"),
		extensions,
		notify: async (n) => postToInbox(app, n).id,
	});
	try {
		await host.init();
	} catch (e) {
		console.error(`The agent could not start: ${errorMessage(e)}. Operations, the watcher and the web UI still run.`);
	}

	jobs = new JobRunner(app, host);
	const watcher = new Watcher(app, jobs);
	registerNightly(app, jobs);

	// Operations that need the running server.
	app.operations.add({
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
	app.operations.add({
		name: "job.list",
		summary: "Scheduled jobs and recent job runs",
		effect: "read",
		input: Type.Object({}),
		async run() {
			return jobs.list();
		},
		toText: (o: any) => `${o.jobs.map((j: any) => `${j.id} | ${j.kind} | ${j.schedule} | next ${j.next_run_at}`).join("\n")}\nruns:\n${o.runs.slice(0, 20).map((r: any) => `${r.id} | ${r.kind} | ${r.state} | ${r.created_at.slice(0, 16)} | ${(r.summary ?? "").slice(0, 80)}`).join("\n")}`,
	});
	startFollows({ app, host, jobs });
	startTranslation({ app, host, jobs });
	const builtInPlugins = join(REPO_ROOT, "plugins");
	const pluginManager = new PluginManager({ app, jobs, host, dirs: [builtInPlugins], builtInDirs: [builtInPlugins], plugins: o.devPlugin ? [o.devPlugin] : [], install: { dir: app.paths.plugins, npmCache: join(app.paths.cache, "npm") }, model: host.router, routes, pi: extensions });
	// Restarting is offered only where something starts Reelix again: docker-compose.yml (restart: unless-stopped) says so.
	if (process.env.REELIX_RESTART === "exit") {
		app.operations.add({
			name: "server.restart",
			summary: "Restart Reelix: it stops and its supervisor starts it again, loading plugins installed or updated since it started",
			effect: "admin",
			input: Type.Object({}),
			async run() {
				setTimeout(() => void shutdown(75), 300).unref();
				return { next: "Reelix is restarting; the page reconnects by itself." };
			},
			toText: (o: { next: string }) => o.next,
		});
	}
	app.plugins = pluginManager;
	await pluginManager.start();

	const settled = await reconcileOnStartup(app);
	if (settled.settled || settled.unknown) console.log(`Ledger: settled ${settled.settled} interrupted actions; ${settled.unknown} remain unknown.`);

	const deps = { app, host, jobs, webDir: process.env.REELIX_WEB_DIR ?? join(REPO_ROOT, "packages/web/dist"), routes, devPlugin: o.devPlugin };

	// Local sockets (§3.3): the owner's, private to Reelix's user, and the agent shell's, which needs a session's token.
	for (const f of [app.paths.socket, app.paths.agentSocket]) if (existsSync(f)) unlinkSync(f);
	host.tokens.writeOwnerToken(app);
	const { createServer } = await import("node:http");
	const { getRequestListener } = await import("@hono/node-server");
	const socketServer = createServer(getRequestListener(socketApp(deps).fetch));
	socketServer.listen(app.paths.socket, () => chmodSync(app.paths.socket, 0o600));
	const agentSocketServer = createServer(getRequestListener(agentSocketApp(deps).fetch));
	agentSocketServer.listen(app.paths.agentSocket, () => chmodSync(app.paths.agentSocket, 0o666));

	const web = serve({ fetch: webApp(deps).fetch, hostname: app.config.web.host, port: Number(process.env.REELIX_PORT ?? app.config.web.port) }, (info) => {
		console.log(`Reelix is listening on http://${info.address}:${info.port} (data: ${app.paths.root})`);
	});

	jobs.start();
	watcher.start();

	let stopping = false;
	/** `code` 75: stopped to be started again (server.restart). */
	async function shutdown(code = 0) {
		if (stopping) return;
		stopping = true;
		console.log("Stopping…");
		watcher.stop();
		jobs.stop();
		// Stopping the plugins closes what they started (the browser's Chromium).
		await pluginManager.stop();
		web.close();
		socketServer.close();
		agentSocketServer.close();
		host.dispose();
		for (const f of [app.paths.socket, app.paths.agentSocket, app.paths.ownerToken]) {
			try {
				unlinkSync(f);
			} catch {}
		}
		app.close();
		release!();
		process.exit(code);
	}
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

if (process.argv[1] === import.meta.filename) await startServer();
