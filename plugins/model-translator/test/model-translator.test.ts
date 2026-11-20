import assert from "node:assert/strict";
import { test } from "node:test";
import { isOutcome } from "@reelix/plugin";
import { recordSpend, runOperation } from "@reelix/core";
import { startPlugins } from "@reelix/plugin-testing";
import { ANSWER, JOB } from "./check.ts";

const DIR = new URL("..", import.meta.url).pathname;
const translator = (t: Awaited<ReturnType<typeof startPlugins>>) => t.app.seams.provider("reelix:translator@1", "model-translator")!;

test("a chunk goes to the translate role with the glossary and tone; only lines asked for come back, each once, with their flags", async () => {
	const answer = JSON.stringify({ lines: [{ n: 0, t: "Bonjour\\nà toi", u: true }, { n: 0, t: "again" }, { n: 9, t: "not asked" }, { n: 1, t: "  " }, { n: 2, t: "Klingon-ish", b: true }], terms: [{ source: "gatekeepers", target: "gardiens" }] });
	const t = await startPlugins([DIR], { model: [{ role: "translate", text: `Here it is:\n\`\`\`json\n${answer}\n\`\`\``, model: "m/tr" }] });
	try {
		const got = await translator(t).call("translate", [{ ...JOB, novelty: true, lines: [...JOB.lines.slice(0, 3), { n: 3, text: "SINTEL", sign: true }], context: [{ text: "Before.", translated: "Avant." }], instructions: "Use tu." }]);
		assert.ok(!isOutcome(got));
		assert.deepEqual(got, { lines: [{ n: 0, text: "Bonjour\nà toi", unsure: true }, { n: 2, text: "Klingon-ish", borrowed: true }], terms: [{ term: "gatekeepers", as: "gardiens" }], model: "m/tr" });
		const [call] = t.model.calls;
		assert.equal(call!.role, "translate");
		assert.equal(call!.scope, "plugin:model-translator", "spend is the plugin's");
		assert.match(call!.system, /into French[\s\S]*Mark every line that keeps such borrowed words[\s\S]*The owner's instructions: Use tu\.[\s\S]*Tone: Quiet[\s\S]*- Sintel → Sintel \(the heroine\)/);
		assert.match(call!.user, /^The lines just before[\s\S]*Before\. ⇒ Avant\.\n\nTranslate:\n0\|What brings you to the land\\nof the gatekeepers\?\n1\|.*\n2\|.*\n3\|\[sign\] SINTEL$/);
	} finally {
		await t.close();
	}
});

test("the daily budget: unmetered as it asks, until the owner sets one; then the outcome unavailable, said on its page", async () => {
	const t = await startPlugins([DIR], { model: [{ role: "translate", text: ANSWER }] });
	try {
		const info = () => t.info("model-translator").model!;
		assert.deepEqual([info().unmetered, info().roles, info().budgetUsd], [true, ["background", "translate"], 0.25], "what the manifest asks for, and the default budget");
		recordSpend(t.app, "plugin:model-translator", { cost: { total: 0.3 }, totalTokens: 900 });
		assert.equal(info().reached, false, "no limit while it is unmetered");
		const first = await translator(t).call("translate", [JOB]);
		assert.ok(!isOutcome(first) && first.lines.length === 4);

		await runOperation(t.app, "plugin.model", { id: "model-translator", unmetered: false, daily_usd: 0.25 }, { actor: "owner:test" });
		assert.deepEqual([info().reached, info().spentUsd, info().tokens], [true, 0.3, 900]);
		const calls = t.model.calls.length;
		const out = await translator(t).call("translate", [JOB]);
		assert.ok(isOutcome(out) && out.outcome === "unavailable" && /used its model budget for today \(\$0\.25\); it resets at midnight/.test(out.message), JSON.stringify(out));
		assert.equal(t.model.calls.length, calls, "the model is not asked");

		await runOperation(t.app, "plugin.model", { id: "model-translator", daily_usd: 1, roles: [] }, { actor: "owner:test" });
		const role = await translator(t).call("translate", [JOB]);
		assert.ok(isOutcome(role) && /may not use the model role "translate"/.test((role as { message: string }).message), "a role the owner took away");
		assert.equal(t.info("model-translator").failures, 0, "outcomes are not failures");
		await assert.rejects(runOperation(t.app, "plugin.model", { id: "model-translator", daily_usd: 5 }, { actor: "agent:t1" }), /owner/i, "only the owner sets it");
	} finally {
		await t.close();
	}
});
