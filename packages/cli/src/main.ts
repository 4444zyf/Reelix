#!/usr/bin/env -S node --no-warnings
/**
 * The `reelix` command, generated from the operation registry (§3.3).
 * With a server running, requests go over its private local socket ("one writer");
 * otherwise the CLI takes the data lock and runs the operation itself.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { CORE_OPERATIONS, Reelix, dataPaths, effectLabel, errorMessage, newId, operationInfo, runOperation, type OperationInfo } from "@reelix/core";
import { acquireLock, serverAlive } from "@reelix/core/lock.ts";

type Parsed = { op: OperationInfo; input: Record<string, unknown>; json: boolean };

const NO_SERVER_NOTE = "The server is not running: plugin operations are not listed, and they need it to run (reelix serve).";

function usage(ops: OperationInfo[], viaServer: boolean): string {
	const width = Math.max(...ops.map((o) => o.name.length)) + 2;
	return [
		"reelix — Reelix's command line. Every operation is also an agent tool and a web UI action.",
		"",
		"Usage: reelix <command> [args] [--flag value] [--json]",
		"       reelix help <command>",
		"",
		...ops.map((o) => `  ${o.name.replace(/\./g, " ").padEnd(width)}${o.summary}${effectLabel(o) && ` ${effectLabel(o)}`}`),
		"",
		"Other: reelix chat [thread] (talk to the agent in the terminal), reelix serve (start the server), reelix secret set <key> (at a terminal; prompts for the value),",
		"       reelix plugin add <source> | remove <id> | update <id> [<version or commit>] (at a terminal; asks before it changes anything)",
		"       reelix plugin new [<folder>] [--kind <kind>] [--id <id>] (write a working plugin to start from), reelix plugin check <folder> [--write-settings] (the checks and conformance suites),",
		"       reelix plugin dev <folder> [--port <n>] (a Reelix with fake services and that plugin loaded; for writing plugins, see docs/plugin-guide.md)",
		...(viaServer ? [] : ["", NO_SERVER_NOTE]),
	].join("\n");
}

function opHelp(op: OperationInfo): string {
	const props = ((op.input as any).properties ?? {}) as Record<string, any>;
	const req = new Set(((op.input as any).required ?? []) as string[]);
	const lines = Object.entries(props).map(([k, s]) => {
		const t = s.type ?? (s.anyOf ? s.anyOf.map((x: any) => x.const ?? x.type).join("|") : "value");
		return `  --${k.replace(/_/g, "-")} <${t}>${req.has(k) ? " (required)" : ""}${s.description ? `  ${s.description}` : ""}`;
	});
	return `reelix ${op.name.replace(/\./g, " ")}${(op.positional ?? []).map((p) => ` <${p}>`).join("")}\n${op.summary}${op.description ? `\n${op.description}` : ""}\n${lines.join("\n")}\n  --json  print the full result as JSON`;
}

function parseArgs(ops: OperationInfo[], argv: string[]): Parsed | undefined {
	const words: string[] = [];
	let i = 0;
	while (i < argv.length && !argv[i]!.startsWith("--")) words.push(argv[i++]!);
	// longest operation name that matches the leading words
	let op: OperationInfo | undefined;
	let used = 0;
	for (let n = Math.min(3, words.length); n >= 1; n--) {
		const name = words.slice(0, n).join(".");
		const o = ops.find((x) => x.name === name);
		if (o) {
			op = o;
			used = n;
			break;
		}
	}
	if (!op) return undefined;
	const props = ((op.input as any).properties ?? {}) as Record<string, any>;
	const input: Record<string, unknown> = {};
	const positional = words.slice(used);
	(op.positional ?? []).forEach((name, idx) => {
		if (positional[idx] !== undefined) input[name] = idx === (op!.positional!.length - 1) ? positional.slice(idx).join(" ") : positional[idx];
	});
	let json = false;
	for (; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--json") {
			json = true;
			continue;
		}
		if (!a.startsWith("--")) continue;
		let [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
		k = k.replace(/-/g, "_");
		const schema = props[k];
		if (v === undefined) {
			if (schema?.type === "boolean") v = "true";
			else v = argv[++i];
		}
		if (v === undefined) continue;
		const isStructured = schema && (schema.type === "array" || schema.type === "object");
		if (isStructured) {
			try {
				input[k] = JSON.parse(v);
			} catch {
				input[k] = schema.type === "array" ? v.split(",").map((x) => (/^-?\d+$/.test(x) ? Number(x) : x)) : v;
			}
		} else input[k] = v;
	}
	return { op, input, json };
}

function readHidden(prompt: string): Promise<string> {
	let muted = false;
	const out = new Writable({ write: (c, _e, cb) => (muted ? cb() : process.stdout.write(c, cb)) });
	const rl = createInterface({ input: process.stdin, output: out, terminal: true });
	return new Promise((r) => {
		rl.question(prompt, (a) => {
			rl.close();
			process.stdout.write("\n");
			r(a.trim());
		});
		muted = true;
	});
}

/** The terminal's lines, one reader for the whole command, so an answer typed ahead is not lost. */
let terminal: { ask(question: string): Promise<string>; close(): void } | undefined;

function openTerminal() {
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	const lines: string[] = [];
	let waiting: ((line: string) => void) | undefined;
	rl.on("line", (line) => {
		if (waiting) waiting(line);
		else lines.push(line);
		waiting = undefined;
	});
	rl.once("close", () => waiting?.(""));
	return {
		ask(question: string) {
			rl.setPrompt(question);
			rl.prompt();
			const typed = lines.shift();
			return typed !== undefined ? Promise.resolve(typed) : new Promise<string>((resolve) => (waiting = resolve));
		},
		close: () => rl.close(),
	};
}

/** Ask at the terminal; only an explicit yes counts (docs/plugins.md §13.6). */
async function confirm(question: string): Promise<boolean> {
	terminal ??= openTerminal();
	return /^y(es)?$/i.test((await terminal.ask(`${question} [y/N] `)).trim());
}

function viaSocket(socket: string, method: string, path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: any }> {
	return new Promise((resolve, reject) => {
		const text = body === undefined ? undefined : JSON.stringify(body);
		const req = request({ socketPath: socket, path, method, headers: { ...(text === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }), ...headers } }, (res) => {
			let data = "";
			res.on("data", (d) => (data += d));
			res.on("end", () => {
				try {
					resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
				} catch {
					resolve({ status: res.statusCode ?? 0, body: { error: data } });
				}
			});
		});
		req.on("error", reject);
		req.end(text);
	});
}

/** Whether this user may connect to the socket, if there is one (in the image only Reelix's user may open the owner's). */
function canOpen(socket: string): boolean {
	try {
		if (existsSync(socket)) accessSync(socket, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** The owner's token, if this user may read it; a server that just started may not have written it. */
function ownerToken(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Run an operation on the server. Exits on a refusal. */
async function runOnServer(socket: string, name: string, input: unknown, token: string | undefined, requestId: string): Promise<{ output: any; text: string }> {
	const { status, body } = await viaSocket(socket, "POST", `/api/op/${encodeURIComponent(name)}`, input, { "x-request-id": requestId, ...(token ? { "x-reelix-token": token } : {}) });
	if (status >= 400) {
		console.error(`Error: ${body.error ?? JSON.stringify(body)}`);
		process.exit(1);
	}
	return body;
}

/**
 * `reelix plugin add | remove | update` (docs/plugins.md §13.6): each a few operations with the owner's
 * yes at the terminal in between. They need the running server and a real terminal.
 */
async function pluginCommand(socket: string, token: string | undefined, args: string[]): Promise<void> {
	const [command, first, second] = args;
	const op = (name: string, input: Record<string, unknown>) => runOnServer(socket, name, input, token, newId("cli_"));
	const approve = async (review: { id: string; hash: string }, question: string, later: string) => {
		if (!(await confirm(question))) {
			console.log(later);
			return;
		}
		console.log((await op("plugin.approve", { id: review.id, hash: review.hash })).text);
	};
	if (command === "add" && first) {
		const r = await op("plugin.install", { source: first });
		console.log(r.text);
		await approve(r.output, `Approve ${r.output.id}?${r.output.declarations.kind === "plugin" ? " Its code runs inside Reelix and can do anything Reelix can." : ""}`, `${r.output.id} stays installed and off. Approve it in Settings → Plugins, or remove it with \`reelix plugin remove ${r.output.id}\`.`);
	} else if (command === "remove" && first) {
		if (!(await confirm(`Uninstall ${first}? Its code is removed.`))) return console.log("Nothing was changed.");
		const all = await confirm("Also delete its settings, secrets and stored data? They are kept unless you say yes.");
		console.log((await op("plugin.uninstall", { id: first, delete_data: all })).text);
	} else if (command === "update" && first && !second) {
		console.log((await op("plugin.check_updates", { id: first })).text);
	} else if (command === "update" && first) {
		const r = await op("plugin.update", { id: first, to: second });
		console.log(r.text);
		await approve(r.output, `Approve this update of ${first}?`, "The update stays staged. Approve it in Settings → Plugins, or run this again.");
	} else {
		console.error("Usage: reelix plugin add <source> | reelix plugin remove <id> | reelix plugin update <id> [<version or commit>]");
		process.exit(2);
	}
}

const SWITCH_QUESTIONS: Record<string, (id: string) => string> = {
	"plugin.enable": (id) => `Switch on the plugin ${id}? Its code runs inside Reelix and can do anything Reelix can.`,
	"plugin.disable": (id) => `Switch off the plugin ${id}?`,
};

async function main() {
	const argv = process.argv.slice(2);
	if (argv[0] === "serve") {
		const { startServer } = await import("@reelix/server/main.ts");
		await startServer();
		return;
	}
	if (argv[0] === "chat") {
		const { terminalChat } = await import("@reelix/server/terminal.ts");
		await terminalChat(argv.slice(1));
		return;
	}
	// For plugin authors; none of these needs a running Reelix (docs/plugins.md §14.2).
	if (argv[0] === "plugin" && ["new", "check", "dev"].includes(argv[1] ?? "")) {
		const tools = await import("./plugin-tools.ts");
		if (argv[1] === "new") await tools.pluginNew(argv.slice(2), process.stdin.isTTY ? (q) => (terminal ??= openTerminal()).ask(q) : undefined);
		else if (argv[1] === "check") process.exitCode = await tools.pluginCheck(argv.slice(2));
		else await tools.pluginDev(argv.slice(2));
		return;
	}
	// The agent's shell has a token, and uses only the agent's socket with it: the owner's socket and the data folder
	// are closed to it in the image. Anything else counts as the owner only at a real terminal (docs/plugins.md §11.3).
	const shellToken = process.env.REELIX_TOKEN;
	const atTerminal = !shellToken && !!process.stdin.isTTY && !!process.stdout.isTTY;
	const paths = dataPaths();
	const socket = shellToken ? paths.agentSocket : paths.socket;
	if (shellToken && !existsSync(socket)) throw new Error("Reelix's server is not running, and the agent's shell runs commands only through it.");
	// With a server running, its list is the truth: it has the plugins' operations too (§6.1).
	const viaServer = !!shellToken || (existsSync(socket) && serverAlive(paths));
	const ops: OperationInfo[] = viaServer ? (await viaSocket(socket, "GET", "/api/ops", undefined, shellToken ? { "x-reelix-token": shellToken } : {})).body : CORE_OPERATIONS.map(operationInfo).sort((a, b) => a.name.localeCompare(b.name));
	if (!Array.isArray(ops)) throw new Error((ops as { error?: string }).error ?? "Reelix's server refused the list of operations.");

	if (!argv.length || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
		const p = argv[1] ? parseArgs(ops, argv.slice(1)) : undefined;
		console.log(p ? opHelp(p.op) : usage(ops, viaServer));
		return;
	}
	if (argv[0] === "plugin" && ["add", "remove", "update"].includes(argv[1] ?? "")) {
		if (!viaServer) throw new Error("Installing, updating and removing plugins needs the running server (reelix serve).");
		if (!atTerminal) throw new Error(`reelix plugin ${argv[1]} is for the owner at a real terminal; use Settings → Plugins otherwise.`);
		await pluginCommand(socket, ownerToken(paths.ownerToken), argv.slice(1));
		return;
	}
	if (atTerminal && argv[0] === "secret" && argv[1] === "set" && argv[2] && !argv.includes("--value")) {
		const value = await readHidden(`Value for ${argv[2]} (input hidden): `);
		argv.push("--value", value);
	}
	const parsed = parseArgs(ops, argv);
	if (!parsed) {
		console.error(`Unknown command: ${argv.join(" ")}${viaServer ? "" : `\n${NO_SERVER_NOTE}`}\n`);
		console.error(usage(ops, viaServer));
		process.exit(2);
	}
	if (argv.includes("--help")) {
		console.log(opHelp(parsed.op));
		return;
	}
	const requestId = process.env.REELIX_REQUEST_ID ?? newId("cli_");
	const print = (r: { output: unknown; text: string }) => console.log(parsed.json ? JSON.stringify(r.output, null, 2) : r.text);

	if (viaServer) {
		const token = shellToken ?? (atTerminal ? ownerToken(paths.ownerToken) : undefined);
		const question = SWITCH_QUESTIONS[parsed.op.name];
		if (question && atTerminal && !(await confirm(question(String(parsed.input.id))))) {
			console.log("Nothing was changed.");
			return;
		}
		let r = await runOnServer(socket, parsed.op.name, parsed.input, token, requestId);
		// Others depend on this plugin: they stop with it only on a second yes (§7.11).
		if (r.output?.result === "needs_confirmation") {
			if (!atTerminal || !(await confirm(r.output.next))) {
				console.log(atTerminal ? "Nothing was changed." : r.text);
				return;
			}
			r = await runOnServer(socket, parsed.op.name, { ...parsed.input, with_dependents: true }, token, newId("cli_"));
		}
		print(r);
		return;
	}
	const release = acquireLock(paths, "cli");
	if (!release) {
		console.error(
			canOpen(paths.socket)
				? "Reelix's server holds the data lock but its socket is not answering. Is it starting up?"
				: "This user may not use Reelix's data folder or its socket (in the image only Reelix's user may). The agent's shell runs `reelix` with its session's token (REELIX_TOKEN).",
		);
		process.exit(1);
	}
	const app = new Reelix();
	try {
		print(await runOperation(app, parsed.op.name, parsed.input, { actor: atTerminal ? "owner:cli" : "agent:cli", requestId, progress: (t) => console.error(t) }));
	} finally {
		app.close();
		release();
	}
}

main()
	.then(() => terminal?.close())
	.catch((e) => {
		console.error(`Error: ${errorMessage(e)}`);
		process.exit(1);
	});
