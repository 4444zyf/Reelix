import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { getRequestListener } from "@hono/node-server";
import { tempApp } from "../../core/test/helpers.ts";
import { fileToolRefusal } from "../src/agent/file-paths.ts";
import { shellAs } from "../src/agent/host.ts";
import { agentSocketApp } from "../src/http.ts";
import { agentHome, isolateData, isolationOf, pluginFolderAccess, runAs } from "../src/isolation.ts";
import { SocketTokens } from "../src/socket-tokens.ts";

/**
 * D2 (docs/plugins.md §11.3): what of it runs without the image. Changing user needs the capabilities the
 * image's entrypoint gives Reelix, so that part is tested in the image (docs/plugins.md §21); here the
 * same code runs with this user's own group in place of the agent's and the plugins'.
 */

const REPO = resolve(import.meta.dirname, "../../..");
const mode = (p: string) => statSync(p).mode & 0o7777;

test("isolation: only the image's two ids switch it on; the command drops every capability", () => {
	assert.equal(isolationOf({}), undefined, "outside the image nothing changes");
	assert.equal(isolationOf({ REELIX_AGENT_ID: "61871" }), undefined);
	assert.equal(isolationOf({ REELIX_AGENT_ID: "0", REELIX_PLUGIN_ID: "61872" }), undefined, "never root");
	assert.deepEqual(isolationOf({ REELIX_AGENT_ID: "61871", REELIX_PLUGIN_ID: "61872" }), { agent: 61871, plugin: 61872 });
	assert.deepEqual(runAs(61871, [1000]), ["/usr/bin/setpriv", "--reuid=61871", "--regid=61871", "--groups=1000", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--"]);
	assert.ok(runAs(61872, []).includes("--clear-groups"));
});

test("isolation: the data folder's modes; only the agent's folders and plugins/ are open, each plugin's folder opens to its own process", () => {
	const { app, root } = tempApp();
	try {
		const gid = process.getgid!();
		const p = app.paths;
		writeFileSync(p.ownerToken, "t", { mode: 0o600 });
		mkdirSync(join(p.workspace, "old"), { recursive: true });
		writeFileSync(join(p.workspace, "old", "notes.txt"), "x", { mode: 0o644 });
		mkdirSync(join(p.pluginData, "jackett"), { recursive: true });
		writeFileSync(join(p.pluginData, "jackett", "state.json"), "{}", { mode: 0o644 });
		mkdirSync(join(p.pluginData, "browser"), { recursive: true });
		mkdirSync(join(p.plugins, "x"), { recursive: true });
		app.setSecret("tmdb.api_key", "k");

		isolateData(p, { agent: gid, plugin: gid });
		assert.equal(mode(p.root) & 0o777, 0o711, "the others pass through, never list");
		for (const f of [p.secrets, p.db, p.config, p.ownerToken]) assert.equal(mode(f) & 0o007, 0, `${f} is closed to the others`);
		for (const d of [p.pi, p.sessions, p.backups, p.cache, join(p.root, "home")]) assert.equal(mode(d) & 0o007, 0, `${d} is closed to the others`);
		for (const d of [p.workspace, p.notes, p.skills, p.themes, agentHome(p)]) assert.equal(mode(d), 0o2770, `${d}: the agent's group reads and writes, new entries keep the group`);
		assert.equal(mode(join(p.workspace, "old")), 0o2775);
		assert.equal(mode(join(p.workspace, "old", "notes.txt")), 0o664, "what was there before is shared too");
		assert.equal(mode(p.plugins) & 0o777, 0o755, "plugins are read, never written, by the others");
		assert.equal(mode(p.pluginData), 0o2710, "only the plugins' group passes");
		for (const id of ["jackett", "browser"]) assert.equal(mode(join(p.pluginData, id)), 0o2700, `${id}: closed until its process opens it`);

		pluginFolderAccess(join(p.pluginData, "jackett"), { agent: gid, plugin: gid }, true);
		assert.equal(mode(join(p.pluginData, "jackett")), 0o2770);
		assert.equal(mode(join(p.pluginData, "jackett", "state.json")), 0o664, "its process may write what Reelix wrote there");
		pluginFolderAccess(join(p.pluginData, "jackett"), { agent: gid, plugin: gid }, false);
		assert.equal(mode(join(p.pluginData, "jackett")), 0o2700, "back inside Reelix: closed again");
	} finally {
		app.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("file tools keep to what the agent's shell reaches: its folders, plugins/ to read, nothing in /proc, no search over the data folder", () => {
	const { app, root, library } = tempApp();
	try {
		const p = app.paths;
		const cwd = p.workspace;
		const no = (tool: string, path?: string) => assert.ok(fileToolRefusal(p, cwd, tool, { path }), `${tool} ${path} is refused`);
		const yes = (tool: string, path?: string) => assert.equal(fileToolRefusal(p, cwd, tool, { path }), undefined, `${tool} ${path} is allowed`);
		for (const tool of ["read", "write", "edit", "ls"]) for (const f of [p.secrets, p.db, p.ownerToken, p.config, join(p.pi, "auth.json"), join(p.pluginData, "x", "y")]) no(tool, f);
		no("read", "../secrets.yaml");
		no("read", "/proc/self/environ");
		no("grep", p.root);
		no("grep", "/");
		no("grep", root);
		no("write", join(p.plugins, "x", "index.ts"));
		yes("read", join(p.plugins, "x", "index.ts"));
		yes("read", "notes.md");
		yes("ls");
		yes("grep");
		yes("write", join(p.notes, "preferences.md"));
		yes("edit", join(p.themes, "mine", "theme.css"));
		yes("write", join(p.skills, "new", "SKILL.md"));
		yes("read", join(library, "Movies", "a.srt"));
		yes("grep", library);
		yes("read", join(REPO, "docs", "plugins.md"));
		assert.equal(fileToolRefusal(p, cwd, "bash", { path: p.secrets }), undefined, "not a file tool");
		// A link in the workspace is judged by where it leads.
		symlinkSync(p.secrets, join(cwd, "s.yaml"));
		symlinkSync(p.root, join(cwd, "all"));
		no("read", "s.yaml");
		no("write", "all/config.yaml");
		no("grep", "all");
	} finally {
		app.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("shellAs: pi's shell replaces itself with the prefix and the command, quotes and exit codes intact", async () => {
	const ops = shellAs(["/usr/bin/env", "REELIX_PREFIX_RAN=yes"]);
	let out = "";
	const r = await ops.exec(`echo "$REELIX_PREFIX_RAN" 'it''s' "$$"; exit 3`, REPO, { onData: (d) => (out += d), env: { PATH: process.env.PATH } });
	assert.equal(r.exitCode, 3);
	const [ran, quoted] = out.trim().split(" ");
	assert.equal(ran, "yes");
	assert.equal(quoted, "its");
});

test("agent socket: a session's token is required, the owner's is refused, and the CLI with REELIX_TOKEN uses it", async () => {
	const { app, root } = tempApp();
	const tokens = new SocketTokens();
	const server = createServer(getRequestListener(agentSocketApp({ app, host: { tokens }, jobs: {} } as never).fetch));
	await new Promise<void>((r) => server.listen(app.paths.agentSocket, r));
	try {
		const api = agentSocketApp({ app, host: { tokens }, jobs: {} } as never);
		const call = (headers: Record<string, string>) => api.request("/api/op/config.set", { method: "POST", body: JSON.stringify({ path: "translation.chunk_lines", value: 41 }), headers: { "content-type": "application/json", ...headers } });
		assert.equal((await call({})).status, 401, "no token");
		assert.equal((await call({ "x-reelix-token": "made-up" })).status, 401, "unknown token");
		assert.equal((await api.request("/api/ops")).status, 401, "not even the list");
		tokens.writeOwnerToken(app);
		assert.equal((await call({ "x-reelix-token": readFileSync(app.paths.ownerToken, "utf8").trim() })).status, 401, "the owner's token is nobody here");
		const session = tokens.issue("agent:thread1");
		assert.equal((await call({ "x-reelix-token": session })).status, 200);
		assert.equal((app.db.prepare("SELECT actor FROM actions ORDER BY id DESC LIMIT 1").get() as { actor: string }).actor, "agent:thread1");
		assert.equal((await call({ "x-reelix-token": session.replace(/.$/, "x") })).status, 401);

		const cli = (env: Record<string, string>) =>
			new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
				const c = spawn(process.execPath, ["--no-warnings", join(REPO, "packages/cli/src/main.ts"), "config", "set", "translation.chunk_lines", "42"], { env: { ...process.env, REELIX_DATA: app.paths.root, ...env }, stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				c.stdout.on("data", (d) => (stdout += d));
				c.stderr.on("data", (d) => (stderr += d));
				c.on("close", (status) => done({ status, stdout, stderr }));
			});
		const ok = await cli({ REELIX_TOKEN: session });
		assert.equal(ok.status, 0, ok.stderr);
		assert.equal(app.config.translation.chunk_lines, 42);
		const refused = await cli({ REELIX_TOKEN: "made-up" });
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /needs the token of a running session/);
	} finally {
		server.close();
		app.close();
		rmSync(root, { recursive: true, force: true });
	}
});
