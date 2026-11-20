import assert from "node:assert/strict";
import { test } from "node:test";
import { getInbox, planMagpieChange, watchApprovals, answerInbox } from "@reelix/core";
import { setupMagpie } from "../../core/test/fake-magpie.ts";
import { buildTools, type ToolContext } from "../src/agent/tools.ts";

/** Call a tool the way pi does and return its text. */
async function run(tool: any, id: string, params: unknown): Promise<string> {
	const r = await tool.execute(id, params, undefined, undefined, undefined);
	return r.content.map((c: any) => c.text ?? "").join("");
}

function tools(tc: Partial<ToolContext> & Pick<ToolContext, "app">) {
	const all = buildTools({ threadId: "t2", kind: "chat", actor: "agent:t2", emit: () => {}, notify: async () => "inbox-x", mayApprove: () => true, ...tc } as ToolContext);
	return Object.fromEntries(all.map((t) => [t.name, t]));
}

test("magpie tools: in chat the owner is asked before a change that needs approval; a no changes nothing", async () => {
	const { app, fake, close } = await setupMagpie();
	try {
		fake.state.groups.push({ id: "translate", name: "Translate", members: ["qwen/flash"] });
		app.setConfig("models.roles.translate", ["magpie/group/translate"]);
		const questions: string[] = [];
		let answer = "Decline";
		const t = tools({ app, ask: async (q) => (questions.push(q.question), { value: answer, by: "owner:web" }) });

		const plan = await planMagpieChange(app, { action: "group.update", id: "translate", members: ["qwen/plus"] }, "agent:t2");
		assert.equal(plan.level, "approve");
		const no = await run(t.magpie_apply, "c1", { plan: plan.id });
		assert.match(no, /declined/);
		assert.match(questions[0]!, /Change magpie\? Change group\/translate/);
		assert.deepEqual(fake.state.groups[0].members, ["qwen/flash"]);

		answer = "Approve";
		const yes = await run(t.magpie_apply, "c2", { plan: plan.id });
		assert.match(yes, /^Done:/);
		assert.deepEqual(fake.state.groups[0].members, ["qwen/plus"]);
	} finally {
		await close();
	}
});

test("magpie tools: in a chat channel the question is asked there only if the channel may approve", async () => {
	const { app, fake, close } = await setupMagpie();
	try {
		fake.state.groups.push({ id: "translate", name: "Translate", members: ["qwen/flash"] });
		app.setConfig("models.roles.translate", ["magpie/group/translate"]);
		const plan = await planMagpieChange(app, { action: "group.update", id: "translate", members: ["qwen/plus"] }, "agent:t2");
		const notes: any[] = [];
		let asked = 0;
		const ask = async () => (asked++, { value: "Approve", by: "owner:telegram" });
		const refused = tools({ app, kind: "channel", mayApprove: () => false, ask, notify: async (n) => (notes.push(n), "inbox-1") });
		assert.match(await run(refused.magpie_apply, "c1", { plan: plan.id }), /Asked the owner to approve in the Inbox/);
		assert.equal(asked, 0, "the channel is not asked");
		assert.equal(notes[0].payload.approval.operation, "magpie.apply");
		assert.deepEqual(fake.state.groups[0].members, ["qwen/flash"]);

		const allowed = tools({ app, kind: "channel", mayApprove: () => true, ask });
		assert.match(await run(allowed.magpie_apply, "c2", { plan: plan.id }), /^Done:/);
		assert.equal((app.db.prepare("SELECT approved_by FROM approvals").get() as { approved_by: string }).approved_by, "owner:telegram");
	} finally {
		await close();
	}
});

test("magpie tools: a background job posts the plan to the Inbox and parks; the owner's Approve lets it through", async () => {
	const { app, fake, close } = await setupMagpie();
	try {
		watchApprovals(app);
		fake.state.groups.push({ id: "translate", name: "Translate", members: ["qwen/flash"] });
		app.setConfig("models.roles.background", ["magpie/group/translate"]);
		const notes: any[] = [];
		let parked = "";
		const t = tools({ app, kind: "job", actor: "job:r1", notify: async (n) => (notes.push(n), "inbox-1"), park: (id) => (parked = id) });

		const plan = await planMagpieChange(app, { action: "group.update", id: "translate", routing: "order" }, "job:r1");
		const r = await run(t.magpie_apply, "c1", { plan: plan.id });
		assert.match(r, /parked/);
		assert.equal(parked, "inbox-1");
		assert.deepEqual(notes[0].options, ["Approve", "Decline"]);
		assert.deepEqual(notes[0].payload.approval.input, { plan: plan.id });
		assert.equal(fake.state.groups[0].routing, undefined, "nothing changed yet");

		// the owner answers in the web UI
		const { addInbox } = await import("@reelix/core");
		const item = addInbox(app, { kind: "question", title: notes[0].title, options: notes[0].options, payload: notes[0].payload });
		answerInbox(app, item.id, "Approve", "owner:web");
		assert.equal(getInbox(app, item.id)?.status, "answered");
		const done = await run(t.magpie_apply, "c2", { plan: plan.id });
		assert.match(done, /^Done:/);
		assert.equal(fake.state.groups[0].routing, "order");
	} finally {
		await close();
	}
});
