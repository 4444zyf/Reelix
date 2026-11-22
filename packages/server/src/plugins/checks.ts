import { CHECK_STATES, type Catalog, type CheckAction, type CheckMessage, type CheckResult, type Language, messageFrom } from "@reelix/core";
import type { PluginCheckResult, PluginMessage } from "@reelix/plugin";

/** Limits for what a plugin's check returns: it is data, never instructions (docs/plugins.md §10.7). */
const RAW_LIMIT = 4000;
const LINE_LIMIT = 500;

const clip = (s: unknown, limit: number) => (typeof s === "string" && s ? s.slice(0, limit) : undefined);
/** Without the fields that are absent, so results compare and print cleanly. */
const defined = (r: CheckResult): CheckResult => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as CheckResult;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A plugin's `ctx.check` result as Doctor shows it (docs/plugins.md §6): its messages worded from the
 * plugin's strings in the owner's language, its action turned into a place in Settings or one of its
 * operations, its `cause_id` prefixed with its id. The earlier shape `{ ok, detail, fix? }` keeps working.
 */
export function pluginCheckResult(o: { plugin: string; messages: Catalog; language: Language; operations: string[] }, r: PluginCheckResult | undefined): CheckResult | undefined {
	if (r === undefined || r === null) return undefined;
	if (!isRecord(r)) throw new Error("the check returned something that is not an object");
	if ("ok" in r) {
		if (r.ok !== true && r.ok !== false && r.ok !== null) throw new Error("the check's ok must be true, false or null");
		const detail = clip(r.detail, RAW_LIMIT);
		if (r.ok === null && !detail) return undefined;
		return defined({ state: r.ok ? "passed" : r.ok === false ? "failed" : "skipped", cause: { key: r.ok ? "check_passed" : r.ok === false ? "check_failed" : "check_not_run" }, raw: detail, cli: clip(r.fix, LINE_LIMIT) });
	}
	if (!CHECK_STATES.includes(r.state as never)) throw new Error(`the check's state must be one of ${CHECK_STATES.join(", ")}`);
	const word = (m: PluginMessage | undefined, what: string): CheckMessage | undefined => {
		if (m === undefined) return undefined;
		if (!isRecord(m) || typeof m.key !== "string" || !m.key) throw new Error(`the check's ${what} must be { key, values? }`);
		const values = isRecord(m.values) ? Object.fromEntries(Object.entries(m.values).filter(([, v]) => typeof v === "string" || typeof v === "number").map(([k, v]) => [k, typeof v === "string" ? v.slice(0, LINE_LIMIT) : v])) : undefined;
		const text = (messageFrom(o.messages, o.language, m.key, values) ?? m.key).slice(0, LINE_LIMIT);
		return { key: `${o.plugin}:${m.key}`, ...(values ? { values } : {}), text };
	};
	const cause = word(r.cause, "cause");
	if (!cause) throw new Error("the check has no cause");
	let action: CheckAction | undefined;
	if (r.action !== undefined) {
		const a = r.action;
		if (!isRecord(a)) throw new Error("the check's action must be an object");
		const label = word(a.label, "action label");
		if (typeof a.operation === "string") {
			if (!o.operations.includes(a.operation)) throw new Error(`the check's action names the operation "${a.operation}", which the plugin does not declare`);
			action = { label: label ?? { key: "actions.run" }, operation: `${o.plugin}.${a.operation}`, ...(isRecord(a.input) ? { input: a.input } : {}) };
		} else {
			const anchor = typeof a.setting === "string" ? `field-plugins.${o.plugin}.${a.setting}` : typeof a.secret === "string" ? `secret-plugins.${o.plugin}.${a.secret}` : `plugin-${o.plugin}`;
			action = { label: label ?? { key: "actions.open_plugin" }, anchor };
		}
	}
	return defined({
		state: r.state,
		cause,
		impact: word(r.impact, "impact"),
		action,
		cli: clip(r.cli, LINE_LIMIT),
		raw: clip(r.raw, RAW_LIMIT),
		cause_id: typeof r.cause_id === "string" && r.cause_id ? `${o.plugin}:${r.cause_id.slice(0, 100)}` : undefined,
	});
}
