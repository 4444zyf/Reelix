import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Notice } from "@reelix/plugin";
import { addInbox, reasonsFor } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";

const PLUGIN = join(import.meta.dirname, "..");

/** A notifier that remembers what reached it. */
function notifier(root: string): string {
	const dir = join(root, "fake-notifier");
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "n", version: "1.0.0", type: "module", reelix: { api: 0, id: "fake-notifier", entry: "./src/index.ts", runtime: "in-process", uses: { provides: ["reelix:notifier@1"] } } }));
	writeFileSync(join(dir, "src/index.ts"), `import { definePlugin } from "@reelix/plugin";
export default definePlugin({ async activate(ctx) { await ctx.provide("reelix:notifier@1", { id: "fake", label: "Fake", can: { images: true, update: false, answers: true }, send: async (n) => { globalThis.sentNotices.push(n); return {}; } }); } });`);
	return dir;
}

const sent = () => (globalThis as unknown as { sentNotices: Notice[] }).sentNotices;

test("a long notice is shortened on its way out and says who edited it; the Inbox keeps the full text; an approval question is left alone", async () => {
	(globalThis as any).sentNotices = [];
	const root = mkdtempSync(join(tmpdir(), "reelix-short-"));
	const t = await startPlugins([notifier(root), PLUGIN], { settings: { "short-notices": { max_body: 20 } } });
	try {
		const long = "A notice that is much longer than twenty characters.";
		const it = addInbox(t.app, { kind: "question", title: "Which one?", body: long, options: ["A", "B"] });
		for (let i = 0; i < 100 && !sent().length; i++) await new Promise((r) => setTimeout(r, 10));
		const n = sent()[0]!;
		assert.match(n.body!, /^A notice that is mu…\n\nEdited by short-notices$/);
		assert.equal(n.title, "Which one?");
		assert.deepEqual(n.answer.options.map((o) => o.label), ["A", "B"], "the answers are not its to change");
		assert.equal(it.body, long);
		assert.match(reasonsFor(t.app, `notice:${it.id}`)[0]!.reason, /Shortened to 20 characters/);

		addInbox(t.app, { kind: "question", title: "Approve?", body: long, options: ["Yes", "No"], payload: { approval: { operation: "x", input: {}, requestedBy: "a", expiresAt: "z" } } });
		for (let i = 0; i < 100 && sent().length < 2; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(sent()[1]!.body, long);
	} finally {
		await t.close();
		rmSync(root, { recursive: true, force: true });
	}
});
