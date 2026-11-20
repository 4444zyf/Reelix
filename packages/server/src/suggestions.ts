import { type Reelix, ReelixError, type Suggestions, makeSuggestions, readSuggestions, spentToday, suggestionsStale } from "@reelix/core";
import type { ModelRouter } from "./models.ts";

/*
 * "For you" on the Trends page (docs/trends.md §2): the kept list is answered at once; a new one is
 * made in the background when it is stale, one at a time. Its model calls have their own scope and
 * daily limit (`limits.suggestions_daily_usd`), apart from translation and the background jobs.
 */

let making: Promise<Suggestions> | undefined;

const budgetUsed = (app: Reelix) => spentToday(app, "suggestions").usd >= app.config.limits.suggestions_daily_usd;

export function refreshSuggestions(app: Reelix, router: ModelRouter): Promise<Suggestions> {
	// The day's budget is used up: the kept list stays until midnight.
	const kept = budgetUsed(app) ? readSuggestions(app) : undefined;
	if (kept) return Promise.resolve(kept);
	making ??= makeSuggestions(app, (system, user) => {
		if (budgetUsed(app)) throw new ReelixError("budget_reached", `"For you" has used its model budget for today ($${app.config.limits.suggestions_daily_usd}, limits.suggestions_daily_usd); it resets at midnight.`);
		return router.complete("background", system, user, { scope: "suggestions" });
	}).finally(() => {
		making = undefined;
	});
	return making;
}

/** The kept list, and whether a new one is being made. Starts one when the kept list is stale. */
export async function currentSuggestions(app: Reelix, router: ModelRouter, opts: { refresh?: boolean } = {}): Promise<{ suggestions?: Suggestions; working: boolean }> {
	const kept = readSuggestions(app);
	if (opts.refresh || (await suggestionsStale(app, kept).catch(() => false))) void refreshSuggestions(app, router).catch(() => {});
	return { suggestions: kept, working: !!making };
}
