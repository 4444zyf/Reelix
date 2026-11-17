import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Reelix, errorMessage, getHandle, getOperation, getTitle, listOperations, newId, nowIso, requireTitle, runOperation, titleSummary } from "@reelix/core";

/** What a tool needs to know about the session it runs in. */
export type ToolContext = {
	app: Reelix;
	threadId: string;
	kind: "chat" | "job" | "telegram" | "setup";
	actor: string;
	/** Emit a UI event into the thread's stream (cards, questions). */
	emit: (e: Record<string, unknown>) => void;
	/** Chat only: show a question and wait for the owner's answer. */
	ask?: (q: AskRequest, signal?: AbortSignal) => Promise<string>;
	/** Post to the Inbox (and Telegram when it matters). Returns the inbox id. */
	notify: (n: NotifyRequest) => Promise<string>;
	/** Background jobs: mark the job as parked on an inbox item. */
	park?: (inboxId: string) => void;
	/** Extra tools contributed by other subsystems (browser, subtitles). */
	extraTools?: ToolDefinition[];
};

export type AskRequest = { id: string; question: string; kind: "choice" | "text" | "secret" | "confirm"; options?: string[]; secret_key?: string; card?: unknown };
export type NotifyRequest = { title: string; body?: string; options?: string[]; image_path?: string; urgent?: boolean; kind?: string; payload?: unknown; wait?: boolean };

type AnyTool = ToolDefinition<any, any, any>;

function textResult(text: string, details?: unknown, images: { data: string; mimeType: string }[] = []) {
	return { content: [{ type: "text" as const, text }, ...images.map((i) => ({ type: "image" as const, ...i }))], details: details ?? {} };
}

function imageOf(path: string): { data: string; mimeType: string } | undefined {
	if (!existsSync(path)) return undefined;
	const ext = extname(path).toLowerCase();
	const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
	return { data: readFileSync(path).toString("base64"), mimeType };
}

/** Run a registry operation as a tool call; the tool call ID is the ledger's request ID (§6.2). */
async function runAsTool(tc: ToolContext, opName: string, params: unknown, toolCallId: string, signal?: AbortSignal) {
	try {
		const r = await runOperation(tc.app, opName, params, { actor: tc.actor, requestId: `${tc.threadId}:${toolCallId}`, signal });
		const out = r.output as any;
		const images = out && typeof out === "object" && typeof out.frame === "string" ? [imageOf(out.frame)].filter((x): x is { data: string; mimeType: string } => !!x) : [];
		return textResult(r.text + (r.repeated ? "\n(This exact request already ran; this is its recorded result.)" : ""), { op: opName, output: out, actionId: r.actionId }, images);
	} catch (e) {
		throw new Error(tc.app.redact(errorMessage(e)));
	}
}

/** Typed tools generated from the registry (§4.2), plus show / ask / notify / reelix. */
export function buildTools(tc: ToolContext): AnyTool[] {
	const tools: AnyTool[] = [];

	for (const op of listOperations()) {
		if (!op.tool) continue;
		tools.push({
			name: op.tool,
			label: op.tool,
			description: `${op.summary}.${op.description ? " " + op.description : ""}${op.effect !== "read" ? " (recorded in the ledger)" : ""}`,
			parameters: op.input,
			execute: (id: string, params: unknown, signal?: AbortSignal) => runAsTool(tc, op.name, params, id, signal),
		});
	}

	tools.push({
		name: "reelix",
		label: "reelix",
		description: "Run any Reelix operation by name without going through the shell (same as `reelix <command>`). List them with command=help.",
		parameters: Type.Object({
			command: Type.String({ description: "operation name, e.g. download.pause, library.remove, config.set — or 'help'" }),
			input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "the operation's input fields" })),
		}),
		async execute(id: string, p: { command: string; input?: Record<string, unknown> }, signal?: AbortSignal) {
			if (p.command === "help" || !p.command) {
				return textResult(listOperations().map((o) => `${o.name}${o.effect === "destructive" ? " [destructive]" : ""} — ${o.summary}`).join("\n"));
			}
			const name = p.command.trim().replace(/\s+/g, ".");
			const op = getOperation(name);
			if (!op) throw new Error(`No operation "${name}". Use command=help.`);
			if (name === "secret.set") throw new Error("Secrets are entered by the owner through the secret field (ask with kind=secret), not by you.");
			if (p.input === undefined && Object.keys((op.input as any).properties ?? {}).length) {
				return textResult(`${op.name}: ${op.summary}\ninput schema: ${JSON.stringify((op.input as any).properties)}`);
			}
			return runAsTool(tc, name, p.input ?? {}, id, signal);
		},
	});

	tools.push({
		name: "show",
		label: "show",
		description:
			"Put a rich card in the chat for the owner: kind=title (id), releases (handles, optional pick + reason), plan (items), image (path, e.g. a screenshot or QR code), verification (path + instructions), text (markdown). Cards with buttons let the owner act with one click.",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("title"), Type.Literal("releases"), Type.Literal("plan"), Type.Literal("image"), Type.Literal("verification"), Type.Literal("text"), Type.Literal("progress")]),
			id: Type.Optional(Type.String({ description: "title id for kind=title" })),
			handles: Type.Optional(Type.Array(Type.String(), { description: "release handles for kind=releases" })),
			pick: Type.Optional(Type.String({ description: "the handle you recommend" })),
			reason: Type.Optional(Type.String()),
			items: Type.Optional(Type.Array(Type.Unknown(), { description: "plan items for kind=plan" })),
			path: Type.Optional(Type.String({ description: "image file for kind=image/verification" })),
			text: Type.Optional(Type.String()),
			hash: Type.Optional(Type.String({ description: "download hash for kind=progress" })),
		}),
		async execute(_id: string, p: any) {
			let card: Record<string, unknown> = { kind: p.kind };
			if (p.kind === "title") {
				const t = requireTitle(tc.app, p.id);
				card = { kind: "title", title: t };
			} else if (p.kind === "releases") {
				const releases = (p.handles ?? []).map((h: string) => {
					const { link: _l, magnet: _m, details: _d, ...rest } = getHandle(tc.app, h) as any;
					return { handle: h, ...rest };
				});
				card = { kind: "releases", releases, pick: p.pick, reason: p.reason };
			} else if (p.kind === "plan") card = { kind: "plan", items: p.items ?? [], reason: p.reason };
			else if (p.kind === "image" || p.kind === "verification") {
				if (!p.path || !existsSync(p.path)) throw new Error(`No image at ${p.path}`);
				card = { kind: p.kind, image: `/api/files?path=${encodeURIComponent(p.path)}`, path: p.path, text: p.text };
			} else if (p.kind === "progress") card = { kind: "progress", hash: p.hash };
			else card = { kind: "text", text: p.text ?? "" };
			tc.emit({ type: "card", card });
			return textResult("Shown to the owner.", { card });
		},
	});

	tools.push({
		name: "notify",
		label: "notify",
		description: `Post to the owner's Inbox (and Telegram if urgent or a decision is needed). Use for things the owner must see or decide when they are not in this conversation.${tc.kind === "job" ? " With wait=true this background job PARKS: end your turn right after; you will be resumed in this conversation with the owner's answer." : ""}`,
		parameters: Type.Object({
			title: Type.String(),
			body: Type.Optional(Type.String()),
			options: Type.Optional(Type.Array(Type.String(), { description: "answer buttons, e.g. ['Approve','Skip']" })),
			image_path: Type.Optional(Type.String({ description: "attach an image (screenshot, QR code)" })),
			urgent: Type.Optional(Type.Boolean({ description: "also send to Telegram now" })),
			wait: Type.Optional(Type.Boolean({ description: "background jobs: park until the owner answers" })),
		}),
		async execute(_id: string, p: NotifyRequest) {
			const inboxId = await tc.notify({ ...p, kind: p.options?.length || p.wait ? "question" : "notice" });
			if (p.wait && tc.kind === "job" && tc.park) {
				tc.park(inboxId);
				return textResult(`Posted to the Inbox as ${inboxId}. This job is now parked: end your turn now with a one-line summary. You will be resumed here with the owner's answer.`, { inboxId, parked: true });
			}
			return textResult(`Posted to the Inbox as ${inboxId}.`, { inboxId });
		},
	});

	if (tc.ask) {
		const ask = tc.ask;
		tools.push({
			name: "ask",
			label: "ask",
			description:
				"Ask the owner a question in the chat and wait for the answer. kind=choice with options (buttons), confirm (yes/no), text, or secret (a password/API key field: the value goes straight to secrets.yaml under secret_key and is never shown to you). Only for real ties or missing facts.",
			parameters: Type.Object({
				question: Type.String(),
				kind: Type.Optional(Type.Union([Type.Literal("choice"), Type.Literal("confirm"), Type.Literal("text"), Type.Literal("secret")])),
				options: Type.Optional(Type.Array(Type.String())),
				secret_key: Type.Optional(Type.String({ description: "for kind=secret, e.g. jackett.api_key" })),
			}),
			async execute(_id: string, p: { question: string; kind?: AskRequest["kind"]; options?: string[]; secret_key?: string }, signal?: AbortSignal) {
				const kind = p.kind ?? (p.options?.length ? "choice" : "text");
				if (kind === "secret" && !p.secret_key) throw new Error("kind=secret needs secret_key");
				const answer = await ask({ id: newId("q_"), question: p.question, kind, options: kind === "confirm" ? ["Yes", "No"] : p.options, secret_key: p.secret_key }, signal);
				if (kind === "secret") return textResult(answer ? `The owner provided ${p.secret_key}; it is stored in secrets.yaml.` : `The owner did not provide ${p.secret_key}.`, { secret_key: p.secret_key, provided: !!answer });
				return textResult(`Owner answered: ${answer}`, { answer });
			},
		});
	}

	tools.push(...(tc.extraTools ?? []));
	return tools;
}

/** Short human line for a tool call in the UI (§14.1: "show tool activity as short human lines"). */
export function describeToolCall(app: Reelix, name: string, args: any): string {
	try {
		switch (name) {
			case "bash":
				return `$ ${String(args?.command ?? "").split("\n")[0]!.slice(0, 160)}`;
			case "read":
				return `Reading ${args?.path}`;
			case "write":
				return `Writing ${args?.path}`;
			case "edit":
				return `Editing ${args?.path}`;
			case "ls":
			case "find":
			case "grep":
				return `${name} ${args?.path ?? args?.pattern ?? ""}`;
			case "title_find":
				return `Identifying “${args?.query ?? args?.id}”`;
			case "release_search": {
				const t = args?.title_id ? getTitle(app, args.title_id) : undefined;
				return `Searching releases for ${t?.name ?? args?.query ?? args?.title_id}${args?.season !== undefined ? ` S${args.season}` : ""}`;
			}
			case "release_files":
				return `Looking inside release ${args?.handle}`;
			case "download_add":
				return `Adding release ${args?.handle ?? "magnet"} to qBittorrent`;
			case "download_status":
				return "Checking downloads";
			case "organise":
				return args?.mode === "apply" ? "Filing into the library" : "Planning how to file";
			case "media_probe":
				return `Inspecting ${String(args?.path ?? "").split("/").pop()}`;
			case "reelix":
				return `reelix ${args?.command}`;
			case "show":
				return `Showing a ${args?.kind} card`;
			case "ask":
				return "Asking you";
			case "notify":
				return `Notifying: ${args?.title}`;
			default:
				return name.replace(/_/g, " ");
		}
	} catch {
		return name;
	}
}

export { titleSummary, nowIso };
