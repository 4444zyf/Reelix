import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { type Operation, ReelixError, errorMessage, newId } from "@reelix/core";
import { Type } from "typebox";

/**
 * Signing in to a model provider from the web page (docs/models.md, "Connecting a provider"): pi's own login,
 * whose questions (a key, a code, a choice) and messages (a link to open, a device code) go to the page and back.
 * The owner never needs a terminal for it.
 */

/** The part of pi's model runtime this uses (tests pass a fake). */
export type LoginRuntime = {
	getProviders(): readonly { id: string; name: string; auth: { apiKey?: { name: string; login?: unknown }; oauth?: { name: string } }; getModels(): readonly unknown[] }[];
	getProviderAuthStatus(providerId: string): { configured: boolean; source?: string; label?: string };
	login(providerId: string, type: "api_key" | "oauth", interaction: AuthInteraction): Promise<unknown>;
	logout(providerId: string): Promise<void>;
};

export type ProviderView = { id: string; name: string; configured: boolean; source?: string; models: number; methods: { type: "api_key" | "oauth"; name: string }[] };

type Question = { id: string; type: AuthPrompt["type"]; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] };
export type LoginView = { id: string; provider: string; type: "api_key" | "oauth"; status: "running" | "asking" | "done" | "failed" | "cancelled"; events: AuthEvent[]; question?: Question; error?: string };

type Login = LoginView & { abort: AbortController; answer?: (value: string) => void; reject?: (e: Error) => void; at: number };

/** A login nobody answers is given up after this long. */
const LOGIN_TTL_MS = 15 * 60_000;

export class ProviderLogins {
	private logins = new Map<string, Login>();
	private runtime: () => LoginRuntime | undefined;

	constructor(runtime: () => LoginRuntime | undefined) {
		this.runtime = runtime;
	}

	private rt(): LoginRuntime {
		const r = this.runtime();
		if (!r) throw new ReelixError("unavailable", "The model runtime is not available.");
		return r;
	}

	/** The providers pi knows that can be signed in to here, and which are. */
	providers(): ProviderView[] {
		const rt = this.rt();
		return rt
			.getProviders()
			.map((p) => {
				const methods: ProviderView["methods"] = [];
				if (p.auth.oauth) methods.push({ type: "oauth", name: p.auth.oauth.name });
				if (p.auth.apiKey?.login) methods.push({ type: "api_key", name: p.auth.apiKey.name });
				const status = rt.getProviderAuthStatus(p.id);
				return { id: p.id, name: p.name, configured: status.configured, source: status.source, models: p.getModels().length, methods };
			})
			.filter((p) => p.methods.length || p.configured)
			.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
	}

	start(provider: string, type: "api_key" | "oauth"): LoginView {
		this.sweep();
		const p = this.rt()
			.getProviders()
			.find((x) => x.id === provider);
		if (!p) throw new ReelixError("not_found", `pi knows no provider "${provider}".`);
		if (type === "oauth" ? !p.auth.oauth : !p.auth.apiKey?.login) throw new ReelixError("invalid_input", `${p.name} cannot be signed in to that way.`);
		for (const l of this.logins.values()) if (l.provider === provider && (l.status === "running" || l.status === "asking")) this.cancel(l.id);
		const login: Login = { id: newId(), provider, type, status: "running", events: [], abort: new AbortController(), at: Date.now() };
		this.logins.set(login.id, login);
		const interaction: AuthInteraction = {
			signal: login.abort.signal,
			notify: (e) => {
				login.events.push(e);
				login.at = Date.now();
			},
			prompt: (q) =>
				new Promise<string>((resolve, reject) => {
					login.question = { id: newId(), type: q.type, message: q.message, ...("placeholder" in q && q.placeholder ? { placeholder: q.placeholder } : {}), ...(q.type === "select" ? { options: q.options.map((o) => ({ ...o })) } : {}) };
					login.status = "asking";
					login.at = Date.now();
					const done = () => {
						login.question = undefined;
						login.answer = login.reject = undefined;
						if (login.status === "asking") login.status = "running";
					};
					login.answer = (v) => (done(), resolve(v));
					login.reject = (e) => (done(), reject(e));
					// The flow itself may settle the question (a callback that arrived first).
					q.signal?.addEventListener("abort", () => login.reject?.(new Error("answered elsewhere")), { once: true });
				}),
		};
		void this.rt()
			.login(provider, type, interaction)
			.then(() => {
				if (login.status !== "cancelled") login.status = "done";
			})
			.catch((e) => {
				if (login.status === "cancelled") return;
				login.status = "failed";
				login.error = errorMessage(e);
			})
			.finally(() => {
				login.question = undefined;
				login.at = Date.now();
			});
		return this.view(login);
	}

	state(id: string): LoginView {
		return this.view(this.get(id));
	}

	answer(id: string, question: string, value: string): LoginView {
		const l = this.get(id);
		if (l.question?.id !== question || !l.answer) throw new ReelixError("invalid_input", "That question is no longer open.");
		l.answer(value);
		return this.view(l);
	}

	cancel(id: string): LoginView {
		const l = this.get(id);
		if (l.status === "running" || l.status === "asking") {
			l.status = "cancelled";
			l.reject?.(new Error("cancelled"));
			l.abort.abort();
		}
		return this.view(l);
	}

	async logout(provider: string): Promise<void> {
		await this.rt().logout(provider);
	}

	private get(id: string): Login {
		const l = this.logins.get(id);
		if (!l) throw new ReelixError("not_found", "No such sign-in; start it again.");
		return l;
	}

	private view(l: Login): LoginView {
		return { id: l.id, provider: l.provider, type: l.type, status: l.status, events: l.events, ...(l.question ? { question: l.question } : {}), ...(l.error ? { error: l.error } : {}) };
	}

	/** Logins that ended or that nobody answered for a while are forgotten. */
	private sweep(): void {
		const now = Date.now();
		for (const [id, l] of this.logins) {
			if (now - l.at < LOGIN_TTL_MS) continue;
			if (l.status === "running" || l.status === "asking") this.cancel(id);
			this.logins.delete(id);
		}
	}
}

const ID = Type.Object({ id: Type.String() });

/** The operations of the web page's sign-in (owner only: `admin`, no `agentMay`). */
export function providerOperations(logins: ProviderLogins): Operation<any, any>[] {
	return [
		{
			name: "model.providers",
			summary: "The model providers pi knows, which are signed in, and how one can be signed in to (a key, or the provider's own sign-in)",
			effect: "read",
			input: Type.Object({}),
			async run() {
				return logins.providers();
			},
			toText: (o: ProviderView[]) => o.map((p) => `${p.configured ? "●" : "○"} ${p.id} (${p.name}): ${p.models} models${p.configured ? `, signed in (${p.source})` : `; sign in with ${p.methods.map((m) => m.name).join(" or ")}`}`).join("\n"),
		},
		{
			name: "model.login",
			summary: "Start signing in to a model provider; its questions are answered with model.login_answer",
			effect: "admin",
			input: Type.Object({ provider: Type.String(), type: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]) }),
			positional: ["provider", "type"],
			async run(_ctx, i: { provider: string; type: "api_key" | "oauth" }) {
				return logins.start(i.provider, i.type);
			},
		},
		{
			name: "model.login_state",
			summary: "Where a sign-in is: what it says, what it asks",
			effect: "admin",
			input: ID,
			positional: ["id"],
			async run(_ctx, i: { id: string }) {
				return logins.state(i.id);
			},
		},
		{
			name: "model.login_answer",
			summary: "Answer the open question of a sign-in (a key, a code, a choice)",
			effect: "admin",
			input: Type.Object({ id: Type.String(), question: Type.String(), value: Type.String() }),
			// A key or a code is never kept in the ledger.
			recordInput: (i: { id: string; question: string }) => ({ id: i.id, question: i.question, value: "[secret]" }),
			async run(_ctx, i: { id: string; question: string; value: string }) {
				return logins.answer(i.id, i.question, i.value);
			},
		},
		{
			name: "model.login_cancel",
			summary: "Stop a sign-in",
			effect: "admin",
			input: ID,
			positional: ["id"],
			async run(_ctx, i: { id: string }) {
				return logins.cancel(i.id);
			},
		},
		{
			name: "model.logout",
			summary: "Remove the stored sign-in of a model provider",
			effect: "admin",
			input: Type.Object({ provider: Type.String() }),
			positional: ["provider"],
			async run(_ctx, i: { provider: string }) {
				await logins.logout(i.provider);
				return { provider: i.provider, signed_out: true };
			},
		},
	];
}
