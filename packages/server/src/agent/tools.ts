import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { APPROVE_OPTIONS, type ApprovalRequest, type InboxItem, type Reelix, activeHidden, addInbox, approvalRequest, askableSecret, configChange, createApproval, effectLabel, errorMessage, getHandle, getPath, getTitle, hasApproval, hiddenApprovalInput, newId, planNeedsApproval, playTarget, pluginCard, prepareInput, releaseOfHandle, requireTitle, runOperation, tr, typedToolsOff } from "@reelix/core";

/** How long the owner's yes to a hidden release or a setting stays good. */
const APPROVAL_MS = 60 * 60_000;

/** What a tool needs to know about the session it runs in. */
export type ToolContext = {
	app: Reelix;
	threadId: string;
	kind: "chat" | "job" | "channel" | "setup";
	actor: string;
	/** Emit a UI event into the thread's stream (cards, questions). */
	emit: (e: Record<string, unknown>) => void;
	/** Chat only: show a question and wait for the owner's answer. */
	ask?: (q: AskRequest, signal?: AbortSignal) => Promise<AskAnswer>;
	/** Whether an answer given in this conversation can be the owner's approval (docs/plugins.md §11.2). */
	mayApprove: () => boolean;
	/** Post to the Inbox (and the owner's devices when it matters). Returns the inbox id. */
	notify: (n: NotifyRequest) => Promise<string>;
	/** Background jobs: mark the job as parked on an inbox item. */
	park?: (inboxId: string) => void;
};

/** `by`: who answered, as the ledger names them. */
export type AskAnswer = { value: string; by: string };
export type AskRequest = { id: string; question: string; kind: "choice" | "text" | "secret" | "confirm"; options?: string[]; secret_key?: string; card?: unknown };
export type NotifyRequest = { title: string; body?: string; options?: string[]; image_path?: string; urgent?: boolean; kind?: string; payload?: unknown; wait?: boolean };

type AnyTool = ToolDefinition<any, any, any>;

/** What an agent session posts, as an Inbox item. Anything that asks or is marked urgent goes to the owner's devices. */
export function postToInbox(app: Reelix, n: NotifyRequest & { source: string; jobRunId?: string }): InboxItem {
	return addInbox(app, { kind: n.kind ?? "notice", title: n.title, body: n.body, options: n.options, image_path: n.image_path, source: n.source, job_run_id: n.jobRunId, payload: { ...(n.payload as object), urgent: n.urgent || n.wait || n.kind === "question" } });
}

function textResult(text: string, details?: unknown, images: { data: string; mimeType: string }[] = []) {
	return { content: [{ type: "text" as const, text }, ...images.map((i) => ({ type: "image" as const, ...i }))], details: details ?? {} };
}

function imageOf(path: string): { data: string; mimeType: string } | undefined {
	if (!existsSync(path)) return undefined;
	const ext = extname(path).toLowerCase();
	const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
	return { data: readFileSync(path).toString("base64"), mimeType };
}

type ApprovalAsk = { title: string; body: string; request: ApprovalRequest; what: string; again: string; againLater: string };

/**
 * Get the owner's approval: in this conversation when it can carry one, else through the Inbox.
 * Returns nothing when approved, otherwise the result the tool ends with.
 */
async function ownerApproves(tc: ToolContext, signal: AbortSignal | undefined, a: ApprovalAsk) {
	const [yes, no] = APPROVE_OPTIONS(tc.app) as [string, string];
	if (tc.ask && tc.mayApprove()) {
		const answer = await tc.ask({ id: newId("q_"), question: `${a.title}\n\n${a.body}`, kind: "choice", options: [yes, no] }, signal);
		if (answer.value !== yes) return textResult(`The owner declined: ${a.what}. Nothing was changed.`, { declined: true });
		createApproval(tc.app, { ...a.request, approvedBy: answer.by });
		return undefined;
	}
	const inboxId = await tc.notify({ title: a.title, body: a.body, options: [yes, no], kind: "question", payload: { approval: a.request }, wait: true });
	if (tc.kind === "job" && tc.park) {
		tc.park(inboxId);
		return textResult(`Asked the owner to approve (Inbox ${inboxId}). This job is now parked: end your turn now. When you are resumed with "${yes}", ${a.again}.`, { inboxId, parked: true });
	}
	return textResult(`Asked the owner to approve in the Inbox (${inboxId}). ${a.againLater}`, { inboxId });
}

/** Run a registry operation as a tool call; the tool call ID is the ledger's request ID (§6.2). */
async function runAsTool(tc: ToolContext, opName: string, params: unknown, toolCallId: string, signal?: AbortSignal) {
	try {
		// A translation reports back in the conversation that started it.
		if (opName === "subtitle.translate" && params && typeof params === "object") params = { ...(params as object), thread_id: tc.kind === "job" ? undefined : tc.threadId };
		// A magpie change that needs approval asks the owner first (docs/magpie.md).
		if (opName === "magpie.apply") {
			const planId = String((params as any)?.plan ?? "");
			const plan = planNeedsApproval(tc.app, planId, tc.actor);
			if (plan) {
				const refused = await ownerApproves(tc, signal, {
					title: tr(tc.app, "magpie.approvalTitle", { summary: plan.summary }),
					body: tr(tc.app, "magpie.approvalBody", { reasons: plan.reasons.map((r) => `- ${r}`).join("\n") }),
					request: approvalRequest("magpie.apply", { plan: plan.id }, tc.actor, plan.expires_at),
					what: plan.summary,
					again: `call magpie_apply with plan ${plan.id} again (plan again if it expired); otherwise leave magpie as it is`,
					againLater: `Apply plan ${plan.id} again once they have approved it.`,
				});
				if (refused) return refused;
			}
		}
		// Only the owner can take a release a plugin hid: the agent asks (docs/plugins.md §8).
		if (opName === "download.add" && (params as any)?.allow_hidden && (params as any)?.handle) {
			const handle = String((params as any).handle);
			const payload = getHandle(tc.app, handle);
			const hidden = activeHidden(tc.app, payload);
			const input = hiddenApprovalInput(handle);
			if (hidden.length && !hasApproval(tc.app, "download.add", input, tc.actor)) {
				const refused = await ownerApproves(tc, signal, {
					title: tr(tc.app, "hiddenRelease.approvalTitle"),
					body: tr(tc.app, "hiddenRelease.approvalBody", { name: payload.title, why: hidden.map((h) => `${h.plugin}: ${h.reason}`).join("; ") }),
					request: approvalRequest("download.add", input, tc.actor, new Date(Date.now() + APPROVAL_MS).toISOString()),
					what: payload.title,
					again: `call download_add with handle ${handle} and allow_hidden=true again; otherwise choose another release`,
					againLater: `Call download_add with handle ${handle} and allow_hidden=true again once they have approved it.`,
				});
				if (refused) return refused;
			}
		}
		// A setting that decides where Reelix connects is changed on the owner's word (docs/plugins.md §11.2).
		if (opName === "config.set") {
			const input = prepareInput(tc.app.operations.get(opName)!, params) as { path: string; value?: unknown };
			const { value, needsOwner } = configChange(tc.app, input);
			if (needsOwner && !tc.actor.startsWith("owner:") && !hasApproval(tc.app, opName, input, tc.actor)) {
				const shown = (v: unknown) => JSON.stringify(v) ?? "-";
				const refused = await ownerApproves(tc, signal, {
					title: tr(tc.app, "setting.approvalTitle"),
					body: tr(tc.app, "setting.approvalBody", { path: input.path, before: shown(getPath(tc.app.config, input.path)), after: shown(value) }),
					request: approvalRequest(opName, input, tc.actor, new Date(Date.now() + APPROVAL_MS).toISOString()),
					what: `the change of ${input.path}`,
					again: `call reelix with command=config.set and the same path and value again; otherwise leave the setting as it is`,
					againLater: `Call reelix with command=config.set and the same path and value again once they have approved it.`,
				});
				if (refused) return refused;
			}
		}
		const r = await runOperation(tc.app, opName, params, { actor: tc.actor, requestId: `${tc.threadId}:${toolCallId}`, signal });
		const out = r.output as any;
		const images = out && typeof out === "object" && typeof out.frame === "string" ? [imageOf(out.frame)].filter((x): x is { data: string; mimeType: string } => !!x) : [];
		// A plugin's card is built now, so the conversation keeps it after the plugin is gone (§12.3).
		const card = pluginCard(tc.app, opName, out);
		return textResult(r.text + (r.repeated ? "\n(This exact request already ran; this is its recorded result.)" : ""), { op: opName, output: out, actionId: r.actionId, card }, images);
	} catch (e) {
		throw new Error(tc.app.redact(errorMessage(e)));
	}
}

/** Typed tools generated from the registry (§4.2), plus show / ask / notify / reelix. */
export function buildTools(tc: ToolContext): AnyTool[] {
	const tools: AnyTool[] = [];

	// A plugin's typed tools, unless the owner switched them off; its operations stay reachable through `reelix` (§6.1).
	const off = typedToolsOff(tc.app);
	for (const op of tc.app.operations.list()) {
		if (!op.tool || (op.plugin && off.includes(op.plugin))) continue;
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
				return textResult(tc.app.operations.list().map((o) => `${o.name}${effectLabel(o)} — ${o.summary}`).join("\n"));
			}
			const name = p.command.trim().replace(/\s+/g, ".");
			const op = tc.app.operations.get(name);
			if (!op) throw new Error(`No operation "${name}". Use command=help.`);
			if (name === "secret.set" || (name === "plugin.configure" && p.input?.secrets)) throw new Error("Secrets are entered by the owner through the secret field (ask with kind=secret), not by you.");
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
			"Put a rich card in the chat for the owner: kind=title (id), play (id, optional season/episode: buttons that open it in the owner's player; use it when they want to watch something in the library), releases (handles, optional pick + reason), plan (items), image (path, e.g. a screenshot or QR code), verification (path + instructions), text (markdown). Cards with buttons let the owner act with one click.",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("title"), Type.Literal("play"), Type.Literal("releases"), Type.Literal("plan"), Type.Literal("image"), Type.Literal("verification"), Type.Literal("text"), Type.Literal("progress")]),
			id: Type.Optional(Type.String({ description: "title id for kind=title or play" })),
			season: Type.Optional(Type.Integer({ description: "for kind=play" })),
			episode: Type.Optional(Type.Integer({ description: "for kind=play" })),
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
			} else if (p.kind === "play") {
				card = { kind: "play", play: await playTarget(tc.app, p.id, { season: p.season, episode: p.episode }) };
			} else if (p.kind === "releases") {
				const releases = (p.handles ?? []).map((h: string) => releaseOfHandle(tc.app, h));
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
		description: `Post to the owner's Inbox (and their phone if urgent or a decision is needed). Use for things the owner must see or decide when they are not in this conversation.${tc.kind === "job" ? " With wait=true this background job PARKS: end your turn right after; you will be resumed in this conversation with the owner's answer." : ""}`,
		parameters: Type.Object({
			title: Type.String(),
			body: Type.Optional(Type.String()),
			options: Type.Optional(Type.Array(Type.String(), { description: "answer buttons, e.g. ['Approve','Skip']" })),
			image_path: Type.Optional(Type.String({ description: "attach an image (screenshot, QR code)" })),
			urgent: Type.Optional(Type.Boolean({ description: "also send to the owner's phone now" })),
			wait: Type.Optional(Type.Boolean({ description: "background jobs: park until the owner answers" })),
		}),
		async execute(_id: string, p: NotifyRequest) {
			// Field by field: what else the model puts in its arguments (a forged `payload`) stops here.
			const { title, body, options, image_path, urgent, wait } = p;
			const inboxId = await tc.notify({ title, body, options, image_path, urgent, wait, kind: options?.length || wait ? "question" : "notice" });
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
				secret_key: Type.Optional(Type.String({ description: "for kind=secret, e.g. plugins.jackett.servers.0.api_key" })),
			}),
			async execute(_id: string, p: { question: string; kind?: AskRequest["kind"]; options?: string[]; secret_key?: string }, signal?: AbortSignal) {
				const kind = p.kind ?? (p.options?.length ? "choice" : "text");
				if (kind === "secret" && !p.secret_key) throw new Error("kind=secret needs secret_key");
				if (kind === "secret" && !askableSecret(tc.app, p.secret_key!)) throw new Error(`"${p.secret_key}" is not a secret you can ask for: use a name from \`reelix secret list\` or one a plugin declares; the web login is never asked for here.`);
				const { value: answer } = await ask({ id: newId("q_"), question: p.question, kind, options: kind === "confirm" ? [tr(tc.app, "ask.yes"), tr(tc.app, "ask.no")] : p.options, secret_key: p.secret_key }, signal);
				if (kind === "secret") return textResult(answer ? `The owner provided ${p.secret_key}; it is stored in secrets.yaml.` : `The owner did not provide ${p.secret_key}.`, { secret_key: p.secret_key, provided: !!answer });
				return textResult(`Owner answered: ${answer}`, { answer });
			},
		});
	}

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
				return `Adding release ${args?.handle ?? "magnet"} to the downloader`;
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
