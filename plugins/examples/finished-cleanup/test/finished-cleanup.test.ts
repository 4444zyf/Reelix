import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { getProposal, listInbox, listProposals, pluginCard, runOperation } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { buildTools } from "@reelix/server/agent/tools.ts";
import { startFakeQb } from "../../../qbittorrent/test/fake-qbittorrent.ts";
import { insertTitle, tempApp } from "../../../../packages/core/test/helpers.ts";

const PLUGIN = join(import.meta.dirname, "..");
const QBITTORRENT = join(import.meta.dirname, "../../../qbittorrent");
const DAY = 86_400_000;
const GB = 1024 ** 3;

const until = async (what: string, ok: () => boolean) => {
	for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
	assert.ok(ok(), `timed out waiting for ${what}`);
};

/** Finished downloads in Reelix and in a fake qBittorrent, seeding for the given days. */
async function world() {
	const w = tempApp();
	const qb = await startFakeQb({ downloadsDir: w.downloads });
	w.app.setConfig("plugins.qbittorrent", { url: qb.url, username: qb.username });
	w.app.setSecret("plugins.qbittorrent.password", qb.password);
	insertTitle(w.app, { id: "movie:1", kind: "movie", name: "Old Film" });
	insertTitle(w.app, { id: "tv:2", kind: "tv", name: "Old Show" });
	const add = (hash: string, name: string, days: number, titleId: string, state = "filed") => {
		const completed = new Date(Date.now() - days * DAY).toISOString();
		w.app.db.prepare("INSERT INTO downloads (hash, title_id, name, state, progress, size, added_at, completed_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)").run(hash, titleId, name, state, 2 * GB, completed, completed);
		qb.torrents.set(hash, { hash, name, files: [{ name: `${name}.mkv`, size: 2 * GB, priority: 1, progress: 1 }], hasMetadata: true, stopped: false, progress: 1, completed: true, tags: new Set(["reelix"]), category: "", savePath: qb.theirsRoot, addedOn: 0, completionOn: 0 });
	};
	add("a".repeat(40), "Old.Film.2001.1080p", 20, "movie:1");
	add("b".repeat(40), "Old.Show.S01.1080p", 30, "tv:2");
	add("c".repeat(40), "Older.Film.1999.1080p", 25, "movie:1", "complete");
	add("d".repeat(40), "New.Film.2024.1080p", 2, "movie:1");
	return { ...w, qb };
}

// The same plugin, unchanged, inside Reelix and in a process of its own (docs/plugins.md §11.7).
for (const runtime of ["in-process", "process"] as const)
test(`finished-cleanup (${runtime}): a typed tool and a card from the scan, a proposal from the card's button, only the approved steps run`, async () => {
	const w = await world();
	const t = await startPlugins([PLUGIN, QBITTORRENT], { app: w.app, settings: { "finished-cleanup": { seeded_days: 14 } } });
	try {
		assert.equal((await t.manager.setRuntime("finished-cleanup", runtime)).result, "applied");
		assert.equal(t.info("finished-cleanup").runtime, runtime);
		assert.equal(t.info("finished-cleanup").state, "active", t.info("finished-cleanup").error);
		assert.deepEqual(t.info("finished-cleanup").tools, ["finished-cleanup_scan"]);
		const tc = { app: w.app, threadId: "t1", kind: "chat" as const, actor: "agent:t1", emit: () => undefined, mayApprove: () => true, notify: async () => "" };
		const scanTool = buildTools(tc).find((x) => x.name === "finished-cleanup_scan");
		assert.ok(scanTool, "the scan is a typed tool");
		const result = await scanTool.execute("call-1", {}, undefined, undefined as never, undefined as never);
		assert.match((result.content[0] as { text: string }).text, /3 finished downloads seeded 14 days or more/);
		const card = (result.details as { card: ReturnType<typeof pluginCard> }).card!;
		assert.equal(card.kind, "plugin");
		assert.deepEqual(card.rows!.map((r) => r.primary), ["Old.Show.S01.1080p", "Older.Film.1999.1080p", "Old.Film.2001.1080p"]);
		assert.match(card.rows![0]!.secondary!, /seeding for 30 days/);
		assert.equal(card.buttons[0]!.label, "Propose removal");

		// The card's button runs the plugin's own operation as the plugin; that proposes, it removes nothing.
		await runOperation(w.app, "plugin.press", { card: card.card, button: 0 }, { actor: "owner:web" });
		await until("the proposal", () => listProposals(w.app).length === 1);
		const [first] = listProposals(w.app);
		assert.ok(first);
		assert.equal(first.steps.length, 3);
		assert.match(first.summary, /finished-cleanup proposes 3 steps: 3 downloads/);
		assert.equal(first.destructive, 3);
		assert.match(first.steps[0]!.preview.text, /Remove the torrent Old\.Show\.S01\.1080p \(2\.0 GB\); its files stay on disk/);
		const item = listInbox(w.app).find((i) => i.kind === "proposal")!;
		assert.equal(item.title, first.summary, "the Inbox carries Reelix's summary");
		assert.match(item.body, /> Remove 3 finished downloads/, "the plugin's words are quoted");
		assert.equal(w.qb.torrents.size, 4, "nothing removed yet");

		// The same key replaces the open proposal.
		await runOperation(w.app, "finished-cleanup.propose", {}, { actor: "owner:web" });
		await until("the new proposal", () => getProposal(w.app, first.id).status === "replaced");
		const [p] = listProposals(w.app);
		assert.ok(p && p.id !== first.id);

		// The show was removed in qBittorrent meanwhile: its step is skipped. The older film is unticked.
		w.qb.removeOutside("b".repeat(40));
		await assert.rejects(runOperation(w.app, "proposal.decide", { id: p.id, approve: true, steps: [0, 2] }, { actor: "agent:t1" }), (e: any) => e.code === "owner_only");
		const done = (await runOperation(w.app, "proposal.decide", { id: p.id, approve: true, steps: [0, 2] }, { actor: "owner:web" })).output as Awaited<ReturnType<typeof getProposal>>;
		assert.deepEqual(done.steps.map((s) => s.result?.status), ["skipped", "not_approved", "succeeded"]);
		assert.ok(!w.qb.torrents.has("a".repeat(40)), "the approved step ran");
		assert.ok(w.qb.torrents.has("c".repeat(40)), "the unticked step did not");
		const ledger = w.app.db.prepare("SELECT op, actor, status FROM actions WHERE op = 'download.remove'").all();
		assert.deepEqual(ledger.map((r) => ({ ...r })), [{ op: "download.remove", actor: "plugin:finished-cleanup", status: "succeeded" }]);
		assert.equal((w.app.db.prepare("SELECT COUNT(*) n FROM approvals WHERE used_at IS NULL").get() as { n: number }).n, 0, "no record is left over");
		await assert.rejects(runOperation(w.app, "proposal.decide", { id: p.id, approve: true }, { actor: "owner:web" }), (e: any) => e.code === "proposal_closed");
		await until("the plugin hears the outcome", () => (t.kv("finished-cleanup", "last") as { status?: string } | undefined)?.status === "approved");
		assert.equal(t.kv("finished-cleanup", "last").done, 1);

		// Declining runs nothing.
		await runOperation(w.app, "finished-cleanup.propose", {}, { actor: "owner:web" });
		await until("another proposal", () => listProposals(w.app).length === 1);
		const [again] = listProposals(w.app);
		const declined = (await runOperation(w.app, "proposal.decide", { id: again!.id, approve: false }, { actor: "owner:web" })).output as Awaited<ReturnType<typeof getProposal>>;
		assert.ok(declined.steps.every((s) => s.result?.status === "declined"));
		assert.ok(w.qb.torrents.has("c".repeat(40)));
	} finally {
		await t.close();
		await w.qb.close();
		w.app.close();
	}
});

test("finished-cleanup: the kind setting takes its options from an operation, and a daily schedule only when chosen", async () => {
	const w = await world();
	const t = await startPlugins([PLUGIN, QBITTORRENT], { app: w.app, settings: { "finished-cleanup": { kind: "tv", schedule: "daily", at_most: 1 } } });
	try {
		const kinds = (await runOperation(w.app, "finished-cleanup.kinds", {}, { actor: "owner:web" })).output as { value: string }[];
		assert.deepEqual(kinds.map((k) => k.value), ["all", "movie", "tv"]);
		assert.ok(w.app.db.prepare("SELECT id FROM jobs WHERE id = 'plugin:finished-cleanup:daily' AND schedule = 'every 1440m'").get());
		const out = (await runOperation(w.app, "finished-cleanup.scan", {}, { actor: "owner:web" })).output as { downloads: { name: string }[] };
		assert.deepEqual(out.downloads.map((d) => d.name), ["Old.Show.S01.1080p"]);
		const run = await t.runJob("finished-cleanup.daily");
		assert.equal(run.state, "succeeded");
		await until("the daily proposal", () => listProposals(w.app).length === 1);
		assert.equal(listProposals(w.app)[0]!.steps.length, 1, "at most this many a day");
	} finally {
		await t.close();
		await w.qb.close();
		w.app.close();
	}
});
