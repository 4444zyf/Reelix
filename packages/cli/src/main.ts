#!/usr/bin/env -S node --no-warnings
/**
 * The `reelix` command, generated from the operation registry (§3.3).
 * With a server running, requests go over its private local socket ("one writer");
 * otherwise the CLI takes the data lock and runs the operation itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { Reelix, dataPaths, errorMessage, getOperation, listOperations, newId, runOperation, type Operation } from "@reelix/core";
import { acquireLock, serverAlive } from "@reelix/core/lock.ts";

type Parsed = { op: Operation; input: Record<string, unknown>; json: boolean };

function usage(): string {
	const ops = listOperations();
	const width = Math.max(...ops.map((o) => o.name.length)) + 2;
	return [
		"reelix — Reelix's command line. Every operation is also an agent tool and a web UI action.",
		"",
		"Usage: reelix <command> [args] [--flag value] [--json]",
		"       reelix help <command>",
		"",
		...ops.map((o) => `  ${o.name.replace(/\./g, " ").padEnd(width)}${o.summary}${o.effect === "destructive" ? "  [destructive]" : ""}`),
		"",
		"Other: reelix chat [thread] (talk to the agent in the terminal), reelix serve (start the server), reelix secret set <key> (prompts for the value)",
	].join("\n");
}

function opHelp(op: Operation): string {
	const props = ((op.input as any).properties ?? {}) as Record<string, any>;
	const req = new Set(((op.input as any).required ?? []) as string[]);
	const lines = Object.entries(props).map(([k, s]) => {
		const t = s.type ?? (s.anyOf ? s.anyOf.map((x: any) => x.const ?? x.type).join("|") : "value");
		return `  --${k.replace(/_/g, "-")} <${t}>${req.has(k) ? " (required)" : ""}${s.description ? `  ${s.description}` : ""}`;
	});
	return `reelix ${op.name.replace(/\./g, " ")}${(op.positional ?? []).map((p) => ` <${p}>`).join("")}\n${op.summary}${op.description ? `\n${op.description}` : ""}\n${lines.join("\n")}\n  --json  print the full result as JSON`;
}

function parseArgs(argv: string[]): Parsed | undefined {
	const words: string[] = [];
	let i = 0;
	while (i < argv.length && !argv[i]!.startsWith("--")) words.push(argv[i++]!);
	// longest operation name that matches the leading words
	let op: Operation | undefined;
	let used = 0;
	for (let n = Math.min(3, words.length); n >= 1; n--) {
		const o = getOperation(words.slice(0, n).join("."));
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
	if (!process.stdin.isTTY) return new Promise((r) => {
		let s = "";
		process.stdin.on("data", (d) => (s += d));
		process.stdin.on("end", () => r(s.trim()));
	});
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

/** Send the request to the running server over its local socket. */
function viaSocket(socket: string, name: string, input: unknown, actor: string, requestId: string): Promise<{ status: number; body: any }> {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify(input);
		const req = request(
			{ socketPath: socket, path: `/api/op/${encodeURIComponent(name)}`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-reelix-actor": actor, "x-request-id": requestId } },
			(res) => {
				let data = "";
				res.on("data", (d) => (data += d));
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
					} catch {
						resolve({ status: res.statusCode ?? 0, body: { error: data } });
					}
				});
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

async function main() {
	const argv = process.argv.slice(2);
	if (!argv.length || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
		const p = argv[1] ? parseArgs(argv.slice(1)) : undefined;
		console.log(p ? opHelp(p.op) : usage());
		return;
	}
	if (argv[0] === "serve") {
		await import("@reelix/server/main.ts");
		return;
	}
	if (argv[0] === "chat") {
		const { terminalChat } = await import("@reelix/server/terminal.ts");
		await terminalChat(argv.slice(1));
		return;
	}
	if (argv[0] === "secret" && argv[1] === "set" && argv[2] && !argv.includes("--value")) {
		const value = await readHidden(`Value for ${argv[2]} (input hidden): `);
		argv.push("--value", value);
	}
	const parsed = parseArgs(argv);
	if (!parsed) {
		console.error(`Unknown command: ${argv.join(" ")}\n`);
		console.error(usage());
		process.exit(2);
	}
	if (argv.includes("--help")) {
		console.log(opHelp(parsed.op));
		return;
	}
	const actor = process.env.REELIX_ACTOR ?? "owner:cli";
	const requestId = process.env.REELIX_REQUEST_ID ?? newId("cli_");
	const paths = dataPaths();

	if (existsSync(paths.socket) && serverAlive(paths)) {
		const { status, body } = await viaSocket(paths.socket, parsed.op.name, parsed.input, actor, requestId);
		if (status >= 400) {
			console.error(`Error: ${body.error ?? JSON.stringify(body)}`);
			process.exit(1);
		}
		console.log(parsed.json ? JSON.stringify(body.output, null, 2) : body.text);
		return;
	}
	const release = acquireLock(paths, "cli");
	if (!release) {
		console.error("Reelix's server holds the data lock but its socket is not answering. Is it starting up?");
		process.exit(1);
	}
	const app = new Reelix();
	try {
		const r = await runOperation(app, parsed.op.name, parsed.input, { actor, requestId, progress: (t) => console.error(t) });
		console.log(parsed.json ? JSON.stringify(r.output, null, 2) : r.text);
	} finally {
		app.close();
		release();
	}
}

main().catch((e) => {
	console.error(`Error: ${errorMessage(e)}`);
	process.exit(1);
});

export { readFileSync };
