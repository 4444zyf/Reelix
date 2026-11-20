/**
 * `reelix chat`: the agent in the terminal (build step 2) — a working assistant over SSH.
 * Runs the agent in-process when no server is running.
 */
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { Reelix, errorMessage } from "@reelix/core";
import { acquireLock } from "@reelix/core/lock.ts";
import { AgentHost, REPO_ROOT, type UiEvent } from "./agent/host.ts";
import { postToInbox } from "./agent/tools.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

export async function terminalChat(args: string[]): Promise<void> {
	const app = new Reelix();
	const release = acquireLock(app.paths, "cli");
	if (!release) {
		console.error("The Reelix server is running; chat in its web UI or a linked chat app (terminal chat over the socket is not supported yet).");
		process.exit(1);
	}
	const host = new AgentHost(app, {
		piDir: process.env.REELIX_PI_DIR ?? app.paths.pi,
		binDir: join(REPO_ROOT, "bin"),
		skillsDir: join(REPO_ROOT, "skills"),
		notify: async (n) => {
			const it = postToInbox(app, n);
			console.log(yellow(`\n[inbox ${it.id}] ${n.title}${n.body ? `: ${n.body}` : ""}`));
			return it.id;
		},
	});
	await host.init();
	const name = args[0] && !args[0].startsWith("-") ? args.join(" ") : "Terminal";
	const existing = host.listThreads().find((t) => t.name === name);
	const thread = existing ?? host.createThread(name, "chat");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	console.log(dim(`Reelix — thread "${thread.name}". Ctrl+C stops a run; Ctrl+D quits. Models: ${host.availableModels().slice(0, 6).join(", ")}${host.availableModels().length > 6 ? ", …" : ""}`));
	for (const m of host.history(thread.id).slice(-6)) console.log(m.role === "user" ? bold(`> ${m.text}`) : m.text);

	await host.load(thread.id);
	let pending: { id: string; kind: string; options?: string[]; question: string; secret_key?: string } | undefined;
	let done: (() => void) | undefined;
	host.subscribe(thread.id, host.threadSeq(thread.id), (e: UiEvent) => {
		switch (e.type) {
			case "text_delta":
				process.stdout.write(String(e.delta));
				break;
			case "tool_start":
				process.stdout.write(dim(`\n  · ${e.label}\n`));
				break;
			case "tool_end":
				if (e.isError) process.stdout.write(yellow(`  ! ${e.summary}\n`));
				break;
			case "card":
				process.stdout.write(dim(`  [card: ${(e.card as any)?.kind}]\n`));
				break;
			case "ask":
				pending = e as any;
				process.stdout.write(`\n${bold("? " + String(e.question))}${(e.options as string[] | undefined)?.length ? ` [${(e.options as string[]).map((o, i) => `${i + 1}=${o}`).join(", ")}]` : ""}${e.kind === "secret" ? " (input will be stored as a secret)" : ""}\n`);
				done?.();
				break;
			case "error":
				process.stdout.write(yellow(`\nError: ${e.message}\n`));
				break;
			case "run_end":
				process.stdout.write("\n");
				done?.();
				break;
		}
	});
	process.on("SIGINT", () => {
		if (host.isRunning(thread.id)) {
			void host.abort(thread.id);
			process.stdout.write(yellow("\n(stopped)\n"));
		} else process.exit(0);
	});
	for (;;) {
		let line: string;
		try {
			line = await rl.question(bold("\n> "));
		} catch {
			break;
		}
		if (!line.trim()) continue;
		if (pending) {
			const p = pending;
			pending = undefined;
			const n = Number(line.trim());
			const value = p.options?.length && n >= 1 && n <= p.options.length ? p.options[n - 1]! : line.trim();
			host.answer(thread.id, p.id, value);
		} else {
			try {
				await host.send(thread.id, line);
			} catch (e) {
				console.log(yellow(errorMessage(e)));
				continue;
			}
		}
		await new Promise<void>((r) => {
			done = r;
			if (!host.isRunning(thread.id)) r();
		});
		done = undefined;
	}
	rl.close();
	host.dispose();
	app.close();
	release();
}
