import assert from "node:assert/strict";
import { test } from "node:test";
import { runOperation } from "@reelix/core";
import { tempApp } from "../../core/test/helpers.ts";
import { type LoginRuntime, ProviderLogins, providerOperations } from "../src/model-login.ts";

/** pi's runtime as far as signing in goes: one provider with a key, one with its own sign-in (a link and a code). */
function fakeRuntime() {
	const signedIn = new Map<string, string>();
	const rt: LoginRuntime = {
		getProviders: () => [
			{ id: "acme", name: "Acme", auth: { apiKey: { name: "Acme API key", login: () => undefined } }, getModels: () => [1, 2] },
			{ id: "big", name: "Big AI", auth: { oauth: { name: "Big AI account" } }, getModels: () => [1] },
			{ id: "ambient", name: "Ambient", auth: { apiKey: { name: "env only" } }, getModels: () => [] },
		],
		getProviderAuthStatus: (id) => ({ configured: signedIn.has(id), ...(signedIn.has(id) ? { source: "stored" } : {}) }),
		async login(id, type, ui) {
			if (type === "api_key") {
				const key = await ui.prompt({ type: "secret", message: "Acme API key" });
				if (key !== "ak-good") throw new Error("Acme refused the key");
				signedIn.set(id, key);
			} else {
				ui.notify({ type: "auth_url", url: "https://big.example/authorize?x=1", instructions: "Sign in, then paste the code" });
				const code = await ui.prompt({ type: "manual_code", message: "Code" });
				signedIn.set(id, code);
			}
			return {};
		},
		async logout(id) {
			signedIn.delete(id);
		},
	};
	return { rt, signedIn };
}

const until = async (ok: () => boolean) => {
	for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
	assert.ok(ok());
};

test("signing in to a model provider from the page: a key, a link and a code, a refusal, cancelling, signing out", async () => {
	const { rt, signedIn } = fakeRuntime();
	const logins = new ProviderLogins(() => rt);
	assert.deepEqual(
		logins.providers().map((p) => [p.id, p.configured, p.methods.map((m) => m.type)]),
		[["acme", false, ["api_key"]], ["big", false, ["oauth"]]],
		"a provider that can only be set up by the machine's environment is not offered",
	);

	let l = logins.start("acme", "api_key");
	await until(() => logins.state(l.id).status === "asking");
	l = logins.state(l.id);
	assert.equal(l.question!.type, "secret");
	logins.answer(l.id, l.question!.id, "ak-bad");
	await until(() => logins.state(l.id).status === "failed");
	assert.match(logins.state(l.id).error!, /refused/);

	l = logins.start("acme", "api_key");
	await until(() => logins.state(l.id).status === "asking");
	assert.throws(() => logins.answer(l.id, "not-the-question", "x"), /no longer open/);
	logins.answer(l.id, logins.state(l.id).question!.id, "ak-good");
	await until(() => logins.state(l.id).status === "done");
	assert.equal(logins.providers()[0]!.configured, true, "signed-in providers come first");

	l = logins.start("big", "oauth");
	await until(() => logins.state(l.id).status === "asking");
	assert.deepEqual(logins.state(l.id).events, [{ type: "auth_url", url: "https://big.example/authorize?x=1", instructions: "Sign in, then paste the code" }]);
	logins.cancel(l.id);
	assert.equal(logins.state(l.id).status, "cancelled");
	assert.equal(signedIn.has("big"), false);

	await logins.logout("acme");
	assert.equal(signedIn.has("acme"), false);
	assert.throws(() => logins.start("nobody", "api_key"), /no provider/);
	assert.throws(() => logins.start("big", "api_key"), /cannot be signed in/);
});

test("the sign-in operations are the owner's, and a key typed in never reaches the ledger", async () => {
	const { app } = tempApp();
	const { rt } = fakeRuntime();
	for (const o of providerOperations(new ProviderLogins(() => rt))) app.operations.add(o);
	await assert.rejects(runOperation(app, "model.login", { provider: "acme", type: "api_key" }, { actor: "agent:t1" }), /owner/);
	const l = (await runOperation(app, "model.login", { provider: "acme", type: "api_key" }, { actor: "owner:web" })).output as { id: string };
	let q: { id: string } | undefined;
	for (let i = 0; i < 200 && !q; i++) {
		q = ((await runOperation(app, "model.login_state", { id: l.id }, { actor: "owner:web" })).output as { question?: { id: string } }).question;
		await new Promise((r) => setTimeout(r, 5));
	}
	await runOperation(app, "model.login_answer", { id: l.id, question: q!.id, value: "ak-good" }, { actor: "owner:web" });
	const rows = app.db.prepare("SELECT input_json FROM actions WHERE op = 'model.login_answer'").all() as { input_json: string }[];
	assert.equal(rows.length, 1);
	assert.ok(!rows[0]!.input_json.includes("ak-good"));
	app.close();
});
