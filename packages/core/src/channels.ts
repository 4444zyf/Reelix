import { Type } from "typebox";
import type { Reelix } from "./app.ts";
import type { MovedOwner } from "./config.ts";
import type { Db } from "./db.ts";
import { defineOperation } from "./registry.ts";
import { ReelixError, nowIso } from "./util.ts";

/**
 * What core keeps about each chat channel (docs/plugins.md §7.4): who its owner is, its standing
 * conversation, and whether the owner's answers there may approve destructive actions (§11.2).
 */
export const CHAT_SEAM = "reelix:chat.channel@1";

export type ChatChannelRow = { id: string; owner: string | null; may_approve: number; thread_id: string | null; paired_at: string | null; last_error: string | null; last_error_at: string | null };

export const channelRow = (app: Reelix, id: string) => app.db.prepare("SELECT * FROM chat_channels WHERE id = ?").get(id) as ChatChannelRow | undefined;

function ensureRow(db: Db, id: string): void {
	db.prepare("INSERT OR IGNORE INTO chat_channels (id) VALUES (?)").run(id);
}

/** An owner linked before pairing moved here keeps every power that link had, approvals included (§11.2). */
export function adoptChannelOwner(db: Db, o: MovedOwner): void {
	ensureRow(db, o.channel);
	db.prepare("UPDATE chat_channels SET owner = ?, may_approve = 1, paired_at = COALESCE(paired_at, ?) WHERE id = ?").run(o.owner, nowIso(), o.channel);
}

export function setChannelOwner(app: Reelix, id: string, owner: string): void {
	ensureRow(app.db, id);
	app.db.prepare("UPDATE chat_channels SET owner = ?, paired_at = ? WHERE id = ?").run(owner, nowIso(), id);
}

export function setChannelThread(app: Reelix, id: string, threadId: string): void {
	ensureRow(app.db, id);
	app.db.prepare("UPDATE chat_channels SET thread_id = ? WHERE id = ?").run(threadId, id);
}

/** The outcome of the last thing said on a channel: an error stays visible until something gets through. */
export function recordChannelResult(app: Reelix, id: string, error?: string): void {
	if (error) app.db.prepare("UPDATE chat_channels SET last_error = ?, last_error_at = ? WHERE id = ?").run(error.slice(0, 300), nowIso(), id);
	else app.db.prepare("UPDATE chat_channels SET last_error = NULL, last_error_at = NULL WHERE id = ? AND last_error IS NOT NULL").run(id);
}

export const channelOfThread = (app: Reelix, threadId: string) => (app.db.prepare("SELECT id FROM chat_channels WHERE thread_id = ?").get(threadId) as { id: string } | undefined)?.id;

export const channelMayApprove = (app: Reelix, id: string | undefined) => !!id && channelRow(app, id)?.may_approve === 1;

/** Whose answer this is: the channel's answers count as the owner's only if the owner allowed that. */
export const channelActor = (app: Reelix, id: string) => (channelMayApprove(app, id) ? `owner:${id}` : `channel:${id}`);

type ChannelInfo = { id: string; label: string; active: boolean; linked: boolean; may_approve: boolean; last_error?: string; last_error_at?: string };

function listChannels(app: Reelix): ChannelInfo[] {
	const providers = app.plugins ? app.seams.providers(CHAT_SEAM) : [];
	for (const p of providers) ensureRow(app.db, p.id);
	const rows = app.db.prepare("SELECT * FROM chat_channels ORDER BY id").all() as ChatChannelRow[];
	return rows.map((r) => {
		const p = providers.find((x) => x.id === r.id);
		return { id: r.id, label: p?.label ?? r.id, active: !!p, linked: !!r.owner, may_approve: r.may_approve === 1, last_error: r.last_error ?? undefined, last_error_at: r.last_error_at ?? undefined };
	});
}

function requireChannel(app: Reelix, id: string): ChatChannelRow {
	const row = channelRow(app, id);
	if (!row) throw new ReelixError("not_found", `There is no chat channel "${id}". See \`reelix channel list\`.`);
	return row;
}

const channelText = (c: ChannelInfo) => `${c.id} | ${c.active ? "active" : "off"} | ${c.linked ? "linked" : "not linked"} | ${c.may_approve ? "may approve destructive actions" : "may not approve"}${c.last_error ? ` | last error: ${c.last_error}` : ""}`;

defineOperation({
	name: "channel.list",
	summary: "The chat channels (such as Telegram): linked or not, whether they may approve, the last send error",
	effect: "read",
	input: Type.Object({}),
	async run(ctx) {
		return listChannels(ctx.app);
	},
	toText: (o: ChannelInfo[]) => o.map(channelText).join("\n") || "No chat channels.",
});

defineOperation({
	name: "channel.allow_approval",
	summary: "Whether the owner's answers on a chat channel may approve destructive actions",
	effect: "admin",
	input: Type.Object({ id: Type.String(), allowed: Type.Boolean() }),
	positional: ["id", "allowed"],
	async run(ctx, i) {
		requireChannel(ctx.app, i.id);
		ctx.app.db.prepare("UPDATE chat_channels SET may_approve = ? WHERE id = ?").run(i.allowed ? 1 : 0, i.id);
		return listChannels(ctx.app).find((c) => c.id === i.id)!;
	},
	toText: channelText,
});

defineOperation({
	name: "channel.unlink",
	summary: "Forget a chat channel's owner, so a new one-time code can link it again",
	effect: "admin",
	input: Type.Object({ id: Type.String() }),
	positional: ["id"],
	async run(ctx, i) {
		requireChannel(ctx.app, i.id);
		ctx.app.db.prepare("UPDATE chat_channels SET owner = NULL, may_approve = 0, paired_at = NULL WHERE id = ?").run(i.id);
		return listChannels(ctx.app).find((c) => c.id === i.id)!;
	},
	toText: channelText,
});
