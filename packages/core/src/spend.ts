import type { Reelix } from "./app.ts";

/**
 * What the owner's models cost, per day and scope (§4.5, docs/plugins.md §10.2): `chat`, `background`,
 * `translation` (glossary and review), `suggestions`, and `plugin:<id>` for what a plugin spent or ran.
 * A day is the local date, so every daily limit resets at local midnight.
 */
export type SpendScope = "chat" | "background" | "translation" | "suggestions" | `plugin:${string}`;

export function spendDay(at = new Date()): string {
	const two = (n: number) => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

/** The next local midnight, when the daily limits reset. */
export function nextMidnight(from = new Date()): Date {
	const d = new Date(from);
	d.setHours(24, 0, 0, 0);
	return d;
}

/** Add what one model answer cost (pi's `usage`) to a scope's day. */
export function recordSpend(app: Reelix, scope: SpendScope, usage: { cost?: { total?: number }; totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined): void {
	if (!usage) return;
	const usd = Number(usage.cost?.total ?? 0) || 0;
	const tokens = Number(usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)) || 0;
	app.db.prepare("INSERT INTO spend (day, scope, usd, tokens) VALUES (?, ?, ?, ?) ON CONFLICT(day, scope) DO UPDATE SET usd = usd + excluded.usd, tokens = tokens + excluded.tokens").run(spendDay(), scope, usd, tokens);
}

export function spentToday(app: Reelix, scope: SpendScope): { usd: number; tokens: number } {
	const r = app.db.prepare("SELECT usd, tokens FROM spend WHERE day = ? AND scope = ?").get(spendDay(), scope) as { usd: number; tokens: number } | undefined;
	return { usd: r?.usd ?? 0, tokens: r?.tokens ?? 0 };
}
