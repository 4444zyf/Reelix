import assert from "node:assert/strict";
import { test } from "node:test";
import { answerInbox, addInbox } from "../src/inbox.ts";
import { approvalRequest, createApproval, hasApproval, watchApprovals } from "../src/approvals.ts";
import { applyMagpiePlan, planMagpieChange, planNeedsApproval, planUndo, readMagpie } from "../src/magpie.ts";
import { runOperation } from "../src/registry.ts";
import { ADMIN, USE, setupMagpie as setup } from "./fake-magpie.ts";

test("magpie: status reads groups, providers, keys and Reelix's own limit (plain HTTP, no browser headers)", async () => {
	const { app, close } = await setup();
	try {
		const st = await readMagpie(app);
		assert.equal(st.admin, true, "the admin API answered our plain node:http request");
		assert.deepEqual(st.providers.map((p) => p.id), ["qwen", "deepseek"]);
		assert.equal(st.keys.find((k) => k.id === "use1")?.own, true);
		assert.equal(st.keys.find((k) => k.id === "adm1")?.own, true);
		assert.equal(st.keys.find((k) => k.id === "other")?.own, false);
		const r = await runOperation(app, "magpie.status", {}, { actor: "owner:cli" });
		assert.match(r.text, /Reelix's key "Reelix": day: \$0\.40 of \$1\.00/);
		assert.ok(!r.text.includes(USE) && !r.text.includes(ADMIN), "no key in the text");
	} finally {
		await close();
	}
});

test("magpie: a new group is safe and checked; unknown members and loops are refused", async () => {
	const { app, fake, close } = await setup();
	try {
		const bad = await planMagpieChange(app, { action: "group.create", name: "Translate", members: ["qwen/flash", "nope/x"] }, "agent:t1");
		assert.equal(bad.level, "refused");
		assert.match(bad.reasons.join(" "), /does not serve "nope\/x"/);

		const plan = await planMagpieChange(app, { action: "group.create", name: "Translate", members: ["qwen/flash", "deepseek/v4"], routing: "order" }, "agent:t1");
		assert.equal(plan.level, "safe", plan.reasons.join("; "));
		const r = await applyMagpiePlan(app, plan.id, "agent:t1");
		assert.equal(r.applied, true);
		assert.deepEqual(r.checks, [{ ref: "group/translate", ok: true, error: undefined, used_by_role: false, worked_before: false }]);
		assert.deepEqual(fake.state.groups[0].members, ["qwen/flash", "deepseek/v4"]);
		await assert.rejects(applyMagpiePlan(app, plan.id, "agent:t1"), /more than 30 minutes|plan again/, "a plan is used once");

		fake.state.groups.push({ id: "outer", name: "Outer", members: ["group/translate"] });
		const loop = await planMagpieChange(app, { action: "group.update", id: "translate", members: ["group/outer"] }, "agent:t1");
		assert.equal(loop.level, "refused");
		assert.match(loop.reasons.join(" "), /loop/);
	} finally {
		await close();
	}
});

test("magpie: the agent may not change the model it runs on, nor leave a role empty; the owner may with approval", async () => {
	const { app, fake, close } = await setup();
	try {
		fake.state.groups.push({ id: "chat", name: "Chat", members: ["qwen/flash"] });
		fake.state.groups.push({ id: "outer", name: "Outer", members: ["group/chat", "deepseek/v4"] });
		app.setConfig("models.roles.chat", ["magpie/group/outer"]);
		app.setConfig("models.roles.translate", ["magpie/group/chat"]);
		// conversation t1 runs on group/outer, which contains group/chat, which is served by qwen
		app.modelsInUse = () => [{ actor: "agent:t1", spec: "magpie/group/outer", label: "conversation t1" }];

		const self = await planMagpieChange(app, { action: "provider.off", id: "qwen" }, "agent:t1");
		assert.equal(self.level, "refused");
		assert.match(self.reasons.join(" "), /the model you are running on/);
		assert.match(self.reasons.join(" "), /role "translate" would have no usable model left/);
		await assert.rejects(applyMagpiePlan(app, self.id, "agent:t1"), /refused/);

		// another conversation's agent: not itself, but it still leaves translate empty
		const other = await planMagpieChange(app, { action: "provider.off", id: "qwen" }, "agent:t2");
		assert.equal(other.level, "refused");
		assert.doesNotMatch(other.reasons.join(" "), /running on right now/);

		// the owner may, after seeing it
		const owner = await planMagpieChange(app, { action: "provider.off", id: "qwen" }, "owner:web");
		assert.equal(owner.level, "approve");
		assert.match(owner.reasons.join(" "), /in use right now by conversation t1/);

		// changing a group a role uses, without emptying anything: needs approval from the owner
		const swap = await planMagpieChange(app, { action: "group.update", id: "chat", members: ["qwen/plus"] }, "agent:t2");
		assert.equal(swap.level, "approve");
		assert.ok(planNeedsApproval(app, swap.id, "agent:t2"));
		await assert.rejects(applyMagpiePlan(app, swap.id, "agent:t2"), /needs the owner's approval/);
		const request = approvalRequest("magpie.apply", { plan: swap.id }, "agent:t2", swap.expires_at);
		assert.throws(() => createApproval(app, { ...request, approvedBy: "agent:t2" }), /Only the owner/, "an agent cannot approve");
		createApproval(app, { ...request, approvedBy: "owner:web" });
		assert.equal(planNeedsApproval(app, swap.id, "agent:t2"), undefined);
		await assert.rejects(applyMagpiePlan(app, swap.id, "agent:other"), /needs the owner's approval/, "the record is for the one who asked");
		const r = await applyMagpiePlan(app, swap.id, "agent:t2");
		assert.equal(r.applied, true);
		assert.equal(hasApproval(app, "magpie.apply", { plan: swap.id }, "agent:t2"), false, "a record is used once");
		assert.deepEqual(fake.state.groups.find((g) => g.id === "chat").members, ["qwen/plus"]);
		assert.ok(r.checks.some((c) => c.ref === "group/chat" && c.ok && c.used_by_role));
	} finally {
		await close();
	}
});

test("magpie: a change that breaks a role is rolled back automatically; undo reverses a kept change", async () => {
	const { app, fake, close } = await setup();
	try {
		fake.state.groups.push({ id: "translate", name: "Translate", members: ["qwen/flash"], routing: "order" });
		app.setConfig("models.roles.translate", ["magpie/group/translate", "other/model"]);
		fake.state.failing.add("deepseek/v4");

		const plan = await planMagpieChange(app, { action: "group.update", id: "translate", members: ["deepseek/v4"] }, "owner:cli");
		assert.equal(plan.level, "approve");
		const r = await applyMagpiePlan(app, plan.id, "owner:cli");
		assert.equal(r.applied, false);
		assert.deepEqual(r.rolled_back, { ok: true });
		assert.deepEqual(fake.state.groups[0].members, ["qwen/flash"], "put back as it was");

		// switching a provider on whose model fails: it did not work before either, so nothing to put back
		fake.state.providers.find((x) => x.id === "deepseek")!.off = true;
		app.setConfig("models.roles.review", ["magpie/deepseek/v4", "other/model"]);
		const on = await applyMagpiePlan(app, (await planMagpieChange(app, { action: "provider.on", id: "deepseek" }, "owner:cli")).id, "owner:cli");
		assert.equal(on.applied, true);
		assert.equal(on.rolled_back, undefined);
		assert.deepEqual(on.checks.map((c) => [c.ref, c.ok, c.worked_before]), [["deepseek/v4", false, false]]);
		assert.equal(fake.state.providers.find((x) => x.id === "deepseek")!.off, false, "kept on");
		app.setConfig("models.roles.review", []);

		fake.state.failing.clear();
		const viaOp = await runOperation(app, "magpie.plan", { action: "group.update", id: "group/translate", members: ["deepseek/v4", "qwen/flash"] }, { actor: "owner:cli" });
		const applied = await runOperation(app, "magpie.apply", { plan: (viaOp.output as any).id }, { actor: "owner:cli" });
		assert.match(applied.text, /^Done:/);
		assert.deepEqual(fake.state.groups[0].members, ["deepseek/v4", "qwen/flash"]);

		const undo = await planUndo(app, applied.actionId!, "owner:cli");
		assert.equal(undo.change.action, "group.update");
		await applyMagpiePlan(app, undo.id, "owner:cli");
		assert.deepEqual(fake.state.groups[0].members, ["qwen/flash"]);
		assert.equal(fake.state.groups[0].routing, "order");
	} finally {
		await close();
	}
});

test("magpie: Reelix's own keys are never changed; other keys need approval; only the owner's Inbox answer approves", async () => {
	const { app, fake, close } = await setup();
	try {
		const own = await planMagpieChange(app, { action: "key.limit", key: "use1", limits: [] }, "owner:web");
		assert.equal(own.level, "refused", "not even the owner, through Reelix");
		assert.match(own.reasons.join(" "), /Reelix's own key/);
		const adm = await planMagpieChange(app, { action: "key.limit", key: "Reelix admin", limits: [{ period: "day", cost: 100 }] }, "owner:web");
		assert.equal(adm.level, "refused");

		const other = await planMagpieChange(app, { action: "key.limit", key: "other", limits: [{ period: "week", cost: 5 }] }, "job:r1");
		assert.equal(other.level, "approve");
		watchApprovals(app);
		const payload = { approval: approvalRequest("magpie.apply", { plan: other.id }, "job:r1", other.expires_at) };
		const item = addInbox(app, { kind: "question", title: "Change magpie?", options: ["Approve", "Decline"], payload });
		assert.throws(() => answerInbox(app, item.id, "Approve", "agent:t9"), /owner's own answer/, "an agent cannot answer it");
		assert.throws(() => answerInbox(app, item.id, "Approve", "plugin:x"), /owner's own answer/, "nor can a plugin");
		assert.equal(hasApproval(app, "magpie.apply", { plan: other.id }, "job:r1"), false);
		answerInbox(app, item.id, "Approve", "owner:telegram");
		assert.equal(hasApproval(app, "magpie.apply", { plan: other.id }, "job:r1"), true);
		const r = await applyMagpiePlan(app, other.id, "job:r1");
		assert.equal(r.applied, true);
		assert.deepEqual(fake.state.keys.find((k) => k.id === "other").limit, { period: "week", cost: 5 });

		// several limits: all kept, and undo puts back every one (magpie reports the 2nd onwards as moreLimits)
		const two = await planMagpieChange(app, { action: "key.limit", key: "other", limits: [{ period: "day", cost: 1 }, { period: "5h", tokens: 1000 }] }, "owner:web");
		const applied = await runOperation(app, "magpie.apply", { plan: two.id }, { actor: "owner:web" });
		const k = fake.state.keys.find((x) => x.id === "other");
		assert.deepEqual([k.limit, k.moreLimits], [{ period: "day", cost: 1 }, [{ period: "hours", hours: 5, tokens: 1000 }]]);
		assert.equal((await readMagpie(app)).keys.find((x) => x.id === "other")!.limits.length, 2);
		await applyMagpiePlan(app, (await planUndo(app, applied.actionId!, "owner:web")).id, "owner:web");
		assert.deepEqual([k.limit, k.moreLimits], [{ period: "week", cost: 5 }, undefined], "undo restored the single week limit");

		// magpie changed between plan and apply: refused
		const p = await planMagpieChange(app, { action: "provider.off", id: "deepseek" }, "owner:web");
		fake.state.providers.find((x) => x.id === "deepseek")!.off = true;
		await assert.rejects(applyMagpiePlan(app, p.id, "owner:web"), /changed since/);
	} finally {
		await close();
	}
});

test("magpie: a group magpie made itself (auto/<model>) is followed like any other", async () => {
	const { app, fake, close } = await setup();
	try {
		fake.state.groups.push({ id: "auto-v4", ref: "auto/v4", auto: true, name: "V4", members: ["qwen/flash", "deepseek/v4"] });
		app.setConfig("models.roles.translate", ["magpie/auto/v4"]);
		app.modelsInUse = () => [{ actor: "agent:t1", spec: "magpie/auto/v4", label: "conversation t1" }];
		const st = await readMagpie(app);
		assert.equal(st.groups[0]!.ref, "auto/v4");

		const one = await planMagpieChange(app, { action: "provider.off", id: "deepseek" }, "agent:t1");
		assert.equal(one.level, "refused", "the agent runs on auto/v4, which deepseek serves");
		assert.deepEqual(one.roles.map((r) => [r.role, r.affected, r.empty_after]), [["translate", ["magpie/auto/v4"], false], ["review", ["magpie/auto/v4"], false]]);

		// named by its ref, the change goes to magpie's own id
		const upd = await planMagpieChange(app, { action: "group.update", id: "auto/v4", routing: "order" }, "owner:cli");
		assert.equal((upd.change as any).id, "auto-v4");
		await applyMagpiePlan(app, upd.id, "owner:cli");
		assert.equal(fake.state.groups[0].routing, "order");
	} finally {
		await close();
	}
});
