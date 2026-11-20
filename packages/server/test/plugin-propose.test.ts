import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getInbox, listInbox, runOperation } from "@reelix/core";
import { writePlugin } from "../../cli/src/plugin-tools.ts";
import { tempApp } from "../../core/test/helpers.ts";
import { shellEnv } from "../src/agent/host.ts";
import { JobRunner } from "../src/jobs.ts";
import { PluginManager } from "../src/plugins/manager.ts";

/** Phase 7: the agent writes a plugin and proposes it; only the owner's approval installs it (docs/plugins.md §16, §11.1). */
process.chdir(tmpdir());

const AGENT = { actor: "agent:t_writer" };
const OWNER = { actor: "owner:web" };

function setup() {
	const { app, root } = tempApp();
	const jobs = new JobRunner(app, {} as never);
	let current: PluginManager | undefined;
	const start = async () => {
		await current?.stop();
		current = new PluginManager({ app, jobs, host: { globalListeners: new Set() } as never, dirs: [], install: { dir: app.paths.plugins, npmCache: join(root, "npm-cache") }, stopGraceMs: 50 });
		app.plugins = current;
		await current.start();
		return current;
	};
	const done = async () => {
		await current?.stop();
		app.close();
		rmSync(root, { recursive: true, force: true });
	};
	return { app, start, done, info: (id: string) => current!.list().find((p) => p.id === id) };
}

const SAMPLE = { title: { id: "movie:1", name: "Sample", kind: "movie" as const, mediaClass: "movie" }, releases: [{ ref: "r1", title: "Sample.2024.1080p.CAM.x264-XYZ", site: "s", siteName: "S", hasMagnet: false }, { ref: "r2", title: "Sample.2024.1080p.WEB-DL.x264-GRP", site: "s", siteName: "S", hasMagnet: false }] };

test("the agent drafts a plugin in its workspace and proposes it; the owner reviews files and diff, and only the owner's approval installs it", async () => {
	const s = setup();
	try {
		await s.start();
		const folder = join(s.app.paths.workspace, "plugins", "hide-cam");
		writePlugin("filter", "hide-cam", folder);

		// The agent can never install, switch on or approve: those are the owner's.
		await assert.rejects(runOperation(s.app, "plugin.install", { source: folder }, AGENT), /owner/i);

		const proposed = await runOperation(s.app, "plugin.propose", { folder: "plugins/hide-cam", note: "Hides camera recordings." }, AGENT);
		const view = proposed.output as any;
		assert.match(proposed.text, /Proposed hide-cam 0\.1\.0 as pp_.*waits in the owner's Inbox\. Nothing is installed/);
		assert.equal(s.info("hide-cam"), undefined, "nothing is installed");
		assert.ok(view.files.some((f: any) => f.path === "src/index.ts" && f.change === "added"));
		assert.ok(!view.files.some((f: any) => f.path.startsWith("node_modules")), "its links to Reelix are not part of it");
		assert.match(view.diff, /\+\+\+ after\/src\/index\.ts/);

		const item = listInbox(s.app, { status: "open" }).find((i) => i.payload?.pluginProposal === view.id)!;
		assert.equal(item.title, "A plugin to review: hide-cam 0.1.0");
		assert.equal(item.source, AGENT.actor);
		await assert.rejects(runOperation(s.app, "inbox.answer", { id: item.id, answer: "approved" }, AGENT), /proposed plugin/);
		await assert.rejects(runOperation(s.app, "plugin.proposal_decide", { id: view.id, approve: true, hash: "x" }, AGENT), /owner/i, "admin, without agentMay");
		await assert.rejects(runOperation(s.app, "plugin.propose", { folder }, { actor: "plugin:other" }), /A plugin cannot propose plugins/);

		// The screen: the manifest's declarations only, the agent's note, files and the difference.
		const screen = await runOperation(s.app, "plugin.proposal", { id: view.id }, OWNER);
		const review = screen.output as any;
		assert.equal(review.what, "proposal");
		assert.deepEqual(review.declarations.hooks, ["release.filter@1"]);
		assert.match(screen.text, /Proposed by agent:t_writer .*hide-cam 0\.1\.0/);
		assert.match(screen.text, /The proposer's note: Hides camera recordings\./);
		assert.match(screen.text, /added {3}src\/index\.ts/);

		// What the agent changes afterwards is not part of the proposal; a changed copy is refused.
		writeFileSync(join(folder, "src/index.ts"), "throw new Error('later');\n");
		const copy = join(s.app.paths.plugins, ".proposed", view.id, "README.md");
		const saved = readFileSync(copy);
		writeFileSync(copy, "changed\n");
		await assert.rejects(runOperation(s.app, "plugin.proposal_decide", { id: view.id, approve: true, hash: review.hash }, OWNER), /not what was shown/);
		writeFileSync(copy, saved);

		const approved = await runOperation(s.app, "plugin.proposal_decide", { id: view.id, approve: true, hash: review.hash }, OWNER);
		assert.equal((approved.output as any).result, "saved-restart-needed");
		assert.equal(getInbox(s.app, item.id)!.status, "answered");
		assert.deepEqual(s.info("hide-cam")!.source, { kind: "folder", location: folder });
		assert.equal(s.info("hide-cam")!.state, "installed");

		// After a restart it runs, from its approved files.
		await s.start();
		assert.equal(s.info("hide-cam")!.state, "active");
		const hidden = await s.app.hooks.each("release.filter@1", SAMPLE as never);
		assert.deepEqual(hidden.flatMap((h: any) => h.item.map((x: any) => x.ref)), ["r1"]);
		assert.ok(!existsSync(join(s.app.paths.plugins, ".proposed", view.id)), "the copy went once installed");
	} finally {
		await s.done();
	}
});

test("a second proposal of the same plugin replaces the open one and shows what changed since; declining installs nothing", async () => {
	const s = setup();
	try {
		await s.start();
		const folder = mkdtempSync(join(tmpdir(), "reelix-draft-"));
		rmSync(folder, { recursive: true });
		writePlugin("filter", "hide-xyz", folder);
		const first = (await runOperation(s.app, "plugin.propose", { folder }, AGENT)).output as any;
		const source = join(folder, "src/index.ts");
		writeFileSync(source, readFileSync(source, "utf8").replace("const found", "// by group\n\t\t\t\tconst found"));
		const second = (await runOperation(s.app, "plugin.propose", { folder }, AGENT)).output as any;
		assert.equal(second.diffFrom, first.id);
		assert.deepEqual(second.files.filter((f: any) => f.change !== "same").map((f: any) => [f.path, f.change]), [["src/index.ts", "changed"]]);
		assert.match(second.diff, /\+\t+\/\/ by group/);
		assert.equal(listInbox(s.app, { status: "open" }).filter((i) => i.payload?.pluginProposal).length, 1, "the first item was dismissed");
		await assert.rejects(runOperation(s.app, "plugin.proposal_decide", { id: first.id, approve: true, hash: "h" }, OWNER), /is replaced/);

		const declined = await runOperation(s.app, "plugin.proposal_decide", { id: second.id, approve: false }, OWNER);
		assert.match(declined.text, /Declined: hide-xyz is not installed/);
		assert.equal(s.info("hide-xyz"), undefined);

		// Ids Reelix has, and plugins with dependencies of their own, are refused when proposed.
		const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
		writeFileSync(join(folder, "package.json"), JSON.stringify({ ...pkg, dependencies: { leftpad: "1.0.0" } }));
		await assert.rejects(runOperation(s.app, "plugin.propose", { folder }, AGENT), /no dependencies of its own/);
		rmSync(folder, { recursive: true, force: true });
	} finally {
		await s.done();
	}
});

test("the agent's shell, with its short environment, can write and check a plugin: reelix plugin new and check are not operations", () => {
	const { app, root } = tempApp();
	try {
		const bin = join(import.meta.dirname, "../../../bin");
		const env = shellEnv(process.env, { binDir: bin, token: "agent-session-token", data: app.paths.root });
		const folder = join(app.paths.workspace, "plugins", "hide-group");
		const run = (...args: string[]) => spawnSync("reelix", args, { cwd: app.paths.workspace, env, encoding: "utf8", timeout: 120_000 });
		const made = run("plugin", "new", "plugins/hide-group", "--kind", "filter", "--id", "hide-group");
		assert.equal(made.status, 0, made.stderr);
		assert.match(made.stdout, /Wrote the filter plugin "hide-group"/);
		const checked = run("plugin", "check", folder);
		assert.equal(checked.status, 0, checked.stdout + checked.stderr);
		assert.match(checked.stdout, /ok {4}hook release\.filter@1 answers an ordinary input[\s\S]*Passed\./);
	} finally {
		app.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("the install screen shows the plugins it requires and whether this Reelix has them", async () => {
	const s = setup();
	const base = mkdtempSync(join(tmpdir(), "reelix-requires-src-"));
	try {
		await s.start();
		const folder = join(base, "needs-tags");
		writePlugin("filter", "needs-tags", folder);
		const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
		writeFileSync(join(folder, "package.json"), JSON.stringify({ ...pkg, reelix: { ...pkg.reelix, requires: { plugins: { "release-tags": "^0.1.0", "hide-cam": ">=2" } } } }));
		const other = join(base, "hide-cam");
		writePlugin("filter", "hide-cam", other);
		await runOperation(s.app, "plugin.install", { source: other }, OWNER);
		const r = await runOperation(s.app, "plugin.install", { source: folder }, OWNER);
		assert.deepEqual((r.output as any).requirements, [
			{ id: "release-tags", range: "^0.1.0", satisfied: false },
			{ id: "hide-cam", range: ">=2", version: "0.1.0", state: "installed", satisfied: false },
		]);
		assert.match(r.text, /requires plugins: release-tags \^0\.1\.0 \(not installed\), hide-cam >=2 \(has only 0\.1\.0, installed\)/);
	} finally {
		await s.done();
		rmSync(base, { recursive: true, force: true });
	}
});
