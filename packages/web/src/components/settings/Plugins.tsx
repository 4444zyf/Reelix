import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, MessageSquare, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { endpoints, op, runOp } from "../../lib/api";
import { useChat } from "../../lib/chat";
import type { PluginInfo, PluginReview, PluginSettings, SettingSchema } from "../../lib/types";
import { formatDateTime } from "../../lib/utils";
import { Badge } from "../common/Badge";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { ErrorState, Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Disclosure, Row, SaveBar, Searchable, SecretBadge, SecretInput, Technical, useSettingsView } from "./form";
import { InstallBox, InstalledActions, RestartBanner, ReviewDialog } from "./PluginInstall";

const PLUGIN_TONE = { active: "success", waiting: "warning", failed: "danger", disabled: "muted", installed: "warning", incompatible: "danger", changed: "danger" } as const;
/** Not loaded until the owner acts: approve, approve again, or update (docs/plugins.md §13.3). */
const HELD = ["installed", "incompatible", "changed"];
const SHOW_WHEN = "x-reelix-show-when";
const OPTIONS_FROM = "x-reelix-options-from";
const ADVANCED = "x-reelix-advanced";
const REQUIRED = "x-reelix-required";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Whether a plugin needs the owner: it failed, waits, or misses something it cannot work without. */
export const pluginNeedsAttention = (p: PluginInfo) => p.state === "failed" || p.state === "waiting" || HELD.includes(p.state) || p.needsSetup.length > 0;

/** The plugin's settings and secrets, read once per language. */
export function usePluginSettings(id: string) {
	const { i18n } = useTranslation();
	return useQuery({ queryKey: ["plugin-settings", id, i18n.language], queryFn: () => endpoints.pluginSettings(id, i18n.language) });
}

// ---------------------------------------------------------------- the generated form (docs/plugins.md §12.2)

/** A value with the schema's defaults filled in, for a new entry of a list. */
function withDefaults(schema: SettingSchema | undefined, value: unknown): unknown {
	if (value === undefined && schema && "default" in schema) value = structuredClone(schema.default);
	if (schema?.type === "object" && schema.properties && value && typeof value === "object" && !Array.isArray(value)) {
		const out = { ...(value as Record<string, unknown>) };
		for (const [k, s] of Object.entries(schema.properties)) {
			const v = withDefaults(s, out[k]);
			if (v !== undefined) out[k] = v;
		}
		return out;
	}
	return value;
}

const choices = (s: SettingSchema): unknown[] | undefined => s.enum ?? (s.anyOf?.every((x) => "const" in x) ? s.anyOf.map((x) => x.const) : undefined);

/** What the form keeps besides the values: secrets typed in, and which entry of a list each row was. */
type Extra = {
	/** By the name the plugin asks for; per-entry ones by `<list>#<uid>.<name>` until saved. */
	secrets: Record<string, string | null | undefined>;
	/** Per list with a secret per entry: a stable id per entry; ids below the saved length are the saved entries. */
	uids: Record<string, number[]>;
};

type FieldCtx = { data: PluginSettings; errors: Record<string, string>; extra: Extra; setExtra: (f: (x: Extra) => Extra) => void };

function SettingField({ ctx, path, schema, value, onChange, siblings }: { ctx: FieldCtx; path: (string | number)[]; schema: SettingSchema; value: unknown; onChange: (v: unknown) => void; siblings: Record<string, unknown> }) {
	const { t } = useTranslation("settings");
	const { data, errors } = ctx;
	const plugin = data.id;
	const key = path.filter((p) => typeof p === "string").join(".");
	const name = String(path[path.length - 1]);
	const label = data.strings[`settings.${key}`] ?? name.replace(/_/g, " ");
	const help = data.strings[`settings.${key}_help`];
	const error = errors[`/${path.join("/")}`];
	const id = `setting-${plugin}-${path.join("-")}`;
	const when = schema[SHOW_WHEN];
	const optionsFrom = schema[OPTIONS_FROM];
	const options = useQuery({ queryKey: ["plugin-options", plugin, optionsFrom], queryFn: () => op<{ value: string; label: string }[]>(`${plugin}.${optionsFrom}`), enabled: !!optionsFrom, retry: false });
	if (when && siblings[when.field] !== when.equals) return null;
	const missing = schema[REQUIRED] && (value === undefined || value === "" || (Array.isArray(value) && !value.length));

	const listed = choices(schema);
	let control: ReactNode;
	if (optionsFrom && !options.data) {
		// The options come from the plugin's code: while it cannot answer, the value is named, never shown raw.
		const named = data.strings[`settings.${key}_${String(value)}`];
		control = (
			<select id={id} disabled className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm">
				<option>{options.isLoading ? t("form.loading") : (named ?? t("form.optionsWhenOn"))}</option>
			</select>
		);
	} else if (optionsFrom || listed) {
		const list = optionsFrom ? options.data! : listed!.map((v) => ({ value: String(v), label: data.strings[`settings.${key}_${String(v)}`] ?? String(v) }));
		control = (
			<select id={id} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)} className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm">
				{list.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		);
	} else if (schema.type === "boolean") {
		control = <Switch id={id} checked={!!value} onCheckedChange={(v) => onChange(v)} />;
	} else if (schema.type === "number" || schema.type === "integer") {
		control = <Input id={id} type="number" value={value === undefined ? "" : String(value)} min={schema.minimum} max={schema.maximum} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />;
	} else if (schema.type === "array" && schema.items?.type === "object") {
		control = <EntryList ctx={ctx} path={path} schema={schema} value={value} onChange={onChange} />;
	} else if (schema.type === "array") {
		const words = Array.isArray(value) ? (value as unknown[]).map(String).join(", ") : "";
		control = <ListInput id={id} value={words} onChange={(text) => onChange(text.split(",").map((x) => x.trim()).filter(Boolean))} />;
	} else {
		control = <Input id={id} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />;
	}
	return (
		<Row label={label} htmlFor={id} help={help} error={error} technical={`plugins.${plugin}.${path.join(".")}`} badge={missing ? <Badge tone="warning">{t("form.needed")}</Badge> : undefined} attention={!!missing}>
			<div className="flex gap-2">{control}</div>
		</Row>
	);
}

/** A list of entries (Jackett's servers); a secret declared per entry is a field of its entry. */
function EntryList({ ctx, path, schema, value, onChange }: { ctx: FieldCtx; path: (string | number)[]; schema: SettingSchema; value: unknown; onChange: (v: unknown) => void }) {
	const { t } = useTranslation("settings");
	const listKey = String(path[0]);
	const entries = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
	const full = schema.maxItems !== undefined && entries.length >= schema.maxItems;
	const perEntry = ctx.data.perEntry.filter((s) => s.per === listKey);
	const uids = ctx.extra.uids[listKey] ?? entries.map((_, i) => i);
	const savedRows = ctx.data.secrets.filter((s) => s.per === listKey);
	const setUids = (next: number[]) => ctx.setExtra((x) => ({ ...x, uids: { ...x.uids, [listKey]: next } }));
	return (
		<div className="min-w-0 flex-1 space-y-2">
			{entries.map((entry, i) => {
				const uid = uids[i] ?? i;
				// A saved entry keeps its index as its id until saved again; a new one has no secret yet.
				const saved = (name: string) => savedRows.find((r) => r.name === name && r.entry === uid);
				return (
					<div key={uid} className="space-y-3 rounded-md border border-border p-3">
						<div className="flex items-center justify-between">
							<span className="text-xs text-muted-foreground">#{i + 1}</span>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 px-2 text-xs"
								onClick={() => {
									onChange(entries.filter((_, j) => j !== i));
									setUids(uids.filter((_, j) => j !== i));
								}}
							>
								<Trash2 /> {t("plugins.removeEntry")}
							</Button>
						</div>
						{Object.entries(schema.items!.properties ?? {}).map(([k, s]) => (
							<SettingField key={k} ctx={ctx} path={[...path, i, k]} schema={s} value={entry?.[k]} siblings={entry ?? {}} onChange={(v) => onChange(entries.map((e, j) => (j === i ? { ...e, [k]: v } : e)))} />
						))}
						{perEntry.map(({ name: n, required }) => {
							const row = saved(n);
							const draftKey = `${listKey}#${uid}.${n}`;
							return (
								<Row key={n} label={ctx.data.strings[`secrets.${n}`] ?? n} htmlFor={`secret-plugins.${ctx.data.id}.${listKey}.${i}.${n}`} technical={`plugins.${ctx.data.id}.${listKey}.${i}.${n}`} badge={<SecretBadge set={!!row?.set || !!ctx.extra.secrets[draftKey]} required={required} />} attention={required && !row?.set}>
									<SecretInput id={`secret-plugins.${ctx.data.id}.${listKey}.${i}.${n}`} set={!!row?.set} value={ctx.extra.secrets[draftKey]} required={required} onChange={(v) => ctx.setExtra((x) => ({ ...x, secrets: { ...x.secrets, [draftKey]: v } }))} />
								</Row>
							);
						})}
					</div>
				);
			})}
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={full}
				onClick={() => {
					onChange([...entries, withDefaults(schema.items, {})]);
					setUids([...uids, 1000 + Math.max(999, ...uids) + 1]);
				}}
			>
				<Plus /> {t("plugins.addEntry")}
			</Button>
		</div>
	);
}

/** A comma-separated list, kept as typed until the field is left. */
function ListInput({ id, value, onChange }: { id: string; value: string; onChange: (text: string) => void }) {
	const [text, setText] = useState(value);
	useEffect(() => setText(value), [value]);
	return <Input id={id} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(text)} />;
}

/** Settings of config.yaml that belong in the same card (a provider's path map): saved with the same Save. */
export type AlsoInForm = { node: ReactNode; dirty: boolean; save: () => Promise<void>; discard: () => void };

/** Secrets shown in groups (one per subtitle site): a heading, a line about it, and the secrets whose names it claims. */
export type SecretGroup = { id: string; title: ReactNode; note?: ReactNode; owns: (secret: string) => boolean };

/**
 * A plugin's settings and secrets as one form with one Save (docs/settings.md, "Forms and saving"): the plugin
 * restarts once. Fields marked advanced go under Advanced; secrets it makes itself show as a state.
 */
export function PluginForm({ data, footer, also, groups }: { data: PluginSettings; footer?: ReactNode; also?: AlsoInForm; groups?: SecretGroup[] }) {
	const { t } = useTranslation(["settings", "common"]);
	const qc = useQueryClient();
	const schema = data.schema;
	const lists = data.perEntry.map((s) => s.per);
	const fresh = (): Extra => ({ secrets: {}, uids: Object.fromEntries(lists.map((k) => [k, (Array.isArray(data.values[k]) ? (data.values[k] as unknown[]) : []).map((_, i) => i)])) });
	const [values, setValues] = useState(data.values);
	const [extra, setExtra] = useState<Extra>(fresh);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const savedKey = JSON.stringify([data.values, data.secrets]);
	useEffect(() => {
		setValues(data.values);
		setExtra(fresh());
	}, [savedKey]);
	const secretsTyped = Object.entries(extra.secrets).filter(([, v]) => v !== undefined && v !== "");
	const own = !same(values, data.values) || secretsTyped.length > 0;
	const dirty = own || !!also?.dirty;
	const plain = data.secrets.filter((s) => !s.per);
	const fields = Object.entries(schema?.properties ?? {});
	const ctx: FieldCtx = { data, errors, extra, setExtra };

	const save = async () => {
		setBusy(true);
		try {
			if (also?.dirty) await also.save();
			if (!own) return;
			// Per-entry secrets get the entry's index now; each list says where its entries were before.
			const secrets: Record<string, string | null> = {};
			const origins: Record<string, (number | null)[]> = {};
			for (const k of lists) {
				const before = Array.isArray(data.values[k]) ? (data.values[k] as unknown[]).length : 0;
				const uids = extra.uids[k] ?? [];
				if (data.perEntry.some((s) => s.per === k)) origins[k] = uids.map((u) => (u < before ? u : null));
			}
			for (const [key, v] of secretsTyped) {
				const m = /^([^#]+)#(\d+)\.(.+)$/.exec(key);
				if (!m) secrets[key] = v as string | null;
				else {
					const index = (extra.uids[m[1]!] ?? []).indexOf(Number(m[2]));
					if (index >= 0) secrets[`${m[1]}.${index}.${m[3]}`] = v as string | null;
				}
			}
			const r = await endpoints.configurePlugin(data.id, { ...(schema ? { settings: values } : {}), ...(Object.keys(secrets).length ? { secrets } : {}), ...(Object.keys(origins).length ? { origins } : {}) });
			setErrors(Object.fromEntries((r.errors ?? []).map((e) => [e.path, e.message])));
			toast({ title: t(r.result === "applied" ? "plugins.saved" : "plugins.notSaved", { id: data.id }), description: r.next, variant: r.result === "applied" ? undefined : "destructive" });
			if (r.result === "applied") await qc.invalidateQueries({ queryKey: ["plugin-settings", data.id] });
			qc.invalidateQueries({ queryKey: ["plugins"] });
			qc.invalidateQueries({ queryKey: ["status"] });
		} catch (e) {
			toast({ title: t("plugins.notSaved", { id: data.id }), description: message(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};

	const secretRow = (s: PluginSettings["secrets"][number]) => {
		const label = data.strings[`secrets.${s.name}`] ?? s.name;
		if (s.managed)
			return (
				<Row key={s.key} label={label} technical={s.key}>
					<p className="flex min-h-10 items-center text-sm text-muted-foreground">{t(s.set ? "form.managedSet" : "form.managedNotYet")}</p>
				</Row>
			);
		return (
			<Row key={s.key} label={label} htmlFor={`secret-${s.key}`} technical={s.key} badge={<SecretBadge set={s.set} required={s.required} />} attention={s.required && !s.set}>
				<SecretInput id={`secret-${s.key}`} set={s.set} required={s.required} value={extra.secrets[s.name]} onChange={(v) => setExtra((x) => ({ ...x, secrets: { ...x.secrets, [s.name]: v } }))} />
			</Row>
		);
	};
	const grouped = (s: PluginSettings["secrets"][number]) => !!groups?.some((g) => g.owns(s.name));
	const field = ([k, s]: [string, SettingSchema]) => <SettingField key={k} ctx={ctx} path={[k]} schema={s} value={values[k]} siblings={values} onChange={(v) => setValues((old) => ({ ...old, [k]: v }))} />;
	const advanced = fields.filter(([, s]) => s[ADVANCED]);
	if (!fields.length && !data.secrets.length) return data.note ? <p className="text-xs text-muted-foreground">{data.note}</p> : null;
	return (
		<form
			className="space-y-4"
			// Reelix checks the values against the schema and says what is wrong; the browser does not stop the form first.
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			{also?.node}
			{fields.filter(([, s]) => !s[ADVANCED]).map(field)}
			{plain.filter((s) => !grouped(s)).map(secretRow)}
			{groups?.map((g) => (
				<Searchable key={g.id} text={[typeof g.title === "string" ? g.title : g.id]}>
					<div className="space-y-3 rounded-md bg-well p-3">
						<div>
							<div className="flex flex-wrap items-center gap-2 text-sm font-medium">{g.title}</div>
							{g.note && <div className="text-xs text-muted-foreground">{g.note}</div>}
						</div>
						{plain.filter((s) => g.owns(s.name)).map(secretRow)}
					</div>
				</Searchable>
			))}
			{advanced.length > 0 && <Disclosure title={t("form.advanced")}>{advanced.map(field)}</Disclosure>}
			{errors["/"] && <p className="text-xs text-destructive-foreground">{errors["/"]}</p>}
			{footer}
			{(fields.length > 0 || plain.some((s) => !s.managed) || also) && (
				<SaveBar
					dirty={dirty}
					busy={busy}
					onSave={() => void save()}
					onDiscard={() => {
						also?.discard();
						setValues(data.values);
						setExtra(fresh());
						setErrors({});
					}}
				/>
			)}
		</form>
	);
}

/** Buttons that run one of the plugin's operations, such as "test" or "pair". What it answers is shown as it is. */
export function PluginButtons({ data, only }: { data: PluginSettings; only?: string[] }) {
	const { t } = useTranslation("settings");
	const [busy, setBusy] = useState<string>();
	const [answer, setAnswer] = useState<string>();
	const buttons = data.buttons.filter((b) => !only || only.includes(b.slice(data.id.length + 1)));
	if (!buttons.length) return null;
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap gap-2">
				{buttons.map((name) => {
					const label = data.strings[`buttons.${name.slice(data.id.length + 1)}`] ?? name;
					return (
						<Button
							key={name}
							type="button"
							variant="outline"
							disabled={!!busy}
							onClick={async () => {
								setBusy(name);
								try {
									setAnswer((await runOp(name)).text);
								} catch (e) {
									toast({ title: t("plugins.buttonFailed", { label }), description: message(e), variant: "destructive" });
								} finally {
									setBusy(undefined);
								}
							}}
						>
							{busy === name && <Spinner />}
							{label}
						</Button>
					);
				})}
			</div>
			{answer && <pre className="whitespace-pre-wrap break-words rounded-md bg-well p-3 text-xs">{answer}</pre>}
		</div>
	);
}

function TrialResult({ p }: { p: PluginInfo }) {
	const { t } = useTranslation("settings");
	const r = p.trialResult;
	if (!r?.calls)
		return (
			<p className="text-xs text-muted-foreground" data-testid={`trial-${p.id}`}>
				{t("plugins.trialNone")}
			</p>
		);
	const parts = [r.hidden ? t("plugins.trialHidden", { count: r.hidden }) : "", r.firstChanged ? t("plugins.trialFirst", { count: r.firstChanged }) : "", r.changed - r.firstChanged > 0 ? t("plugins.trialChanged", { count: r.changed }) : ""].filter(Boolean);
	return (
		<p className="text-xs" data-testid={`trial-${p.id}`}>
			{t("plugins.trialSince", { count: r.calls, since: formatDateTime(r.since) })} {parts.join("; ") || t("plugins.trialNothing")}
		</p>
	);
}

function Toggle({ id, on, disabled, onChange, title, help, children }: { id: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void; title: string; help: string; children?: ReactNode }) {
	return (
		<div className="flex items-start gap-3">
			<Switch id={id} checked={on} disabled={disabled} onCheckedChange={onChange} />
			<label htmlFor={id} className="min-w-0 space-y-1 text-sm">
				<span className="font-medium">{title}</span>
				<span className="block text-xs text-muted-foreground">{help}</span>
				{children}
			</label>
		</div>
	);
}

/** How a plugin runs, for those who need it: trial, prompt text in jobs, models, its own process, typed tools (docs/plugins.md §12.1). */
export function PluginAdvanced({ p }: { p: PluginInfo }) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const change = async (fn: () => Promise<{ next: string }>) => {
		try {
			toast({ title: p.id, description: (await fn()).next });
		} catch (e) {
			toast({ title: p.id, description: message(e), variant: "destructive" });
		} finally {
			await qc.invalidateQueries({ queryKey: ["plugins"] });
			qc.invalidateQueries({ queryKey: ["plugin-hooks"] });
		}
	};
	const parts = [
		p.hooks.length > 0 && (
			<Toggle key="trial" id={`trial-${p.id}`} on={p.trial} onChange={(on) => void change(() => endpoints.setPluginTrial(p.id, on))} title={t("plugins.trial")} help={t("plugins.trialHelp")}>
				{(p.trial || !!p.trialResult?.calls) && <TrialResult p={p} />}
			</Toggle>
		),
		p.jobPrompt !== undefined && <Toggle key="job" id={`job-prompt-${p.id}`} on={p.jobPrompt} onChange={(on) => void change(() => endpoints.setPluginJobPrompt(p.id, on))} title={t("plugins.jobPrompt")} help={t("plugins.jobPromptHelp")} />,
		p.model && <ModelUse key="model" p={p} change={change} />,
		p.kind === "plugin" && (
			<Toggle
				key="runtime"
				id={`runtime-${p.id}`}
				on={p.runtime === "process"}
				disabled={!p.processAllowed && p.runtime !== "process"}
				onChange={(on) => void change(() => endpoints.setPluginRuntime(p.id, on ? "process" : "in-process"))}
				title={t("plugins.runtime")}
				help={p.processAllowed ? t("plugins.runtimeHelp", { default: t(p.runtimeDefault === "process" ? "plugins.runtimeProcess" : "plugins.runtimeInProcess") }) : t("plugins.runtimeNotPossible")}
			/>
		),
		p.tools.length > 0 && <Toggle key="tools" id={`tools-${p.id}`} on={p.toolsOn} onChange={(on) => void change(() => endpoints.setPluginTools(p.id, on))} title={t("plugins.tools")} help={t("plugins.toolsHelp", { tools: p.tools.join(", ") })} />,
	].filter(Boolean);
	if (!parts.length) return null;
	return <Disclosure title={t("plugins.howItRuns")}>{parts}</Disclosure>;
}

/** What a plugin is, for operators: id, version, what it provides, listens to and runs. */
export function PluginTechnical({ p }: { p: PluginInfo }) {
	const { t } = useTranslation("settings");
	const rows = [
		[t("plugins.idVersion"), [`${p.id} ${p.version}`]],
		[t("plugins.provides"), p.provides],
		[t("plugins.operations"), p.operations],
		[t("plugins.jobs"), p.jobs],
		[t("plugins.events"), p.events],
		[t("plugins.runs"), p.runs],
		[t("plugins.skills"), p.skills],
		[t("plugins.hooksLabel"), p.hooks],
	] as const;
	return (
		<Disclosure title={t("form.technical")}>
			<dl className="grid gap-1 text-xs sm:grid-cols-[160px_1fr]">
				{rows
					.filter(([, v]) => v.length)
					.map(([label, v]) => (
						<div key={label} className="contents">
							<dt className="text-muted-foreground">{label}</dt>
							<dd className="break-words font-mono">{v.join(", ")}</dd>
						</div>
					))}
			</dl>
		</Disclosure>
	);
}

const ROLES = ["chat", "background", "glossary", "translate", "review"] as const;

/** A plugin's use of the owner's models: spend today, its daily budget, the roles it may use (docs/plugins.md §10.2). */
function ModelUse({ p, change }: { p: PluginInfo; change: (fn: () => Promise<{ next: string }>) => Promise<void> }) {
	const { t } = useTranslation("settings");
	const m = p.model!;
	const [budget, setBudget] = useState(String(m.budgetUsd));
	const set = (input: Record<string, unknown>) => change(() => op<{ next: string }>("plugin.model", { id: p.id, ...input }));
	return (
		<div className="space-y-2 text-sm">
			<p className="font-medium">{t("plugins.model.title")}</p>
			<p className={`text-xs ${m.reached ? "text-warning" : "text-muted-foreground"}`}>
				{m.unmetered ? t("plugins.model.spentUnmetered", { usd: m.spentUsd.toFixed(2), tokens: m.tokens }) : t("plugins.model.spent", { usd: m.spentUsd.toFixed(2), budget: m.budgetUsd, tokens: m.tokens })}
				{m.reached && ` ${t("plugins.model.reached")}`}
			</p>
			<div className="flex items-center gap-3">
				<Switch id={`unmetered-${p.id}`} checked={m.unmetered} onCheckedChange={(on) => void set({ unmetered: on })} />
				<label htmlFor={`unmetered-${p.id}`} className="text-xs">
					{t("plugins.model.unmetered")}
				</label>
			</div>
			{!m.unmetered && (
				<form
					className="flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						void set({ daily_usd: Number(budget) });
					}}
				>
					<label htmlFor={`budget-${p.id}`} className="text-xs">
						{t("plugins.model.budget")}
					</label>
					<Input id={`budget-${p.id}`} className="h-8 w-24" type="number" min={0} step="0.05" value={budget} onChange={(e) => setBudget(e.target.value)} />
					<Button type="submit" size="sm" variant="outline" disabled={!budget || Number(budget) === m.budgetUsd}>
						{t("plugins.model.save")}
					</Button>
				</form>
			)}
			<div className="flex flex-wrap items-center gap-3 text-xs">
				<span>{t("plugins.model.roles")}</span>
				{ROLES.filter((r) => r !== "background").map((r) => (
					<label key={r} className="flex items-center gap-1">
						<input type="checkbox" checked={m.roles.includes(r)} onChange={(e) => void set({ roles: e.target.checked ? [...m.roles, r] : m.roles.filter((x) => x !== r) })} />
						{t(`models.role.${r}`)}
					</label>
				))}
			</div>
		</div>
	);
}

/** The order plugins run in, per pipeline hook; the owner's to change (docs/plugins.md §8). */
export function HookOrder() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { data } = useQuery({ queryKey: ["plugin-hooks"], queryFn: endpoints.pluginHooks });
	const [busy, setBusy] = useState(false);
	const hooks = (data ?? []).filter((h) => h.mode === "pipeline" && h.plugins.length > 1);
	if (!hooks.length) return null;
	const move = async (hook: string, order: string[]) => {
		setBusy(true);
		try {
			toast({ title: hook, description: (await endpoints.setHookOrder(hook, order)).next });
		} catch (e) {
			toast({ title: hook, description: message(e), variant: "destructive" });
		} finally {
			setBusy(false);
			await qc.invalidateQueries({ queryKey: ["plugin-hooks"] });
		}
	};
	return (
		<Row label={t("plugins.hookOrder")} help={t("plugins.hookOrderHelp")}>
			<div className="space-y-2">
				{hooks.map((h) => {
					const ids = h.plugins.map((x) => x.plugin);
					const swap = (i: number, j: number) => {
						const next = [...ids];
						[next[i], next[j]] = [next[j]!, next[i]!];
						void move(h.hook, next);
					};
					return (
						<div key={h.hook} data-testid={`hook-${h.hook}`}>
							<p className="font-mono text-xs text-muted-foreground">{h.hook}</p>
							<ol className="space-y-1">
								{h.plugins.map((x, i) => (
									<li key={x.plugin} className="flex items-center gap-2 text-sm">
										<span className="w-5 text-right text-xs text-muted-foreground">{i + 1}.</span>
										<span>{x.plugin}</span>
										{x.trial && <Badge tone="warning">{t("plugins.inTrial")}</Badge>}
										<Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("plugins.moveUp", { id: x.plugin })} disabled={busy || i === 0} onClick={() => swap(i, i - 1)}>
											<ArrowUp />
										</Button>
										<Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("plugins.moveDown", { id: x.plugin })} disabled={busy || i === h.plugins.length - 1} onClick={() => swap(i, i + 1)}>
											<ArrowDown />
										</Button>
									</li>
								))}
							</ol>
						</div>
					);
				})}
			</div>
		</Row>
	);
}

/** The plugin's setup skill: a conversation where the assistant walks the owner through its settings; secrets go through the secret field (§4). */
function SetupOffer({ p, offered }: { p: PluginInfo; offered: boolean }) {
	const { t } = useTranslation("settings");
	const navigate = useNavigate();
	const { setActive } = useChat();
	const [busy, setBusy] = useState(false);
	const start = async () => {
		setBusy(true);
		try {
			const thread = await endpoints.createThread(t("plugins.setupThread", { id: p.id }));
			await endpoints.sendMessage(thread.id, t("plugins.setupMessage", { id: p.id, skill: p.setup }));
			setActive(thread.id);
			navigate(`/chat/${encodeURIComponent(thread.id)}`);
		} catch (e) {
			toast({ title: p.id, description: message(e), variant: "destructive" });
			setBusy(false);
		}
	};
	return (
		<div className={`mt-1 flex flex-wrap items-center gap-2 ${offered ? "rounded-md bg-info/10 px-3 py-2" : ""}`} data-testid={`setup-${p.id}`}>
			{offered && <span className="text-sm">{t("plugins.setupOffer", { id: p.id })}</span>}
			<Button size="sm" variant={offered ? "default" : "ghost"} className={offered ? "" : "h-7 px-2 text-xs"} disabled={busy} onClick={start}>
				{busy ? <Spinner /> : <MessageSquare />}
				{t("plugins.setupStart")}
			</Button>
		</div>
	);
}

/** What stops a plugin, in words, or nothing. */
export function PluginProblem({ p }: { p: PluginInfo }) {
	const { t } = useTranslation("settings");
	const label = (name: string) => name.replace(/\.(\d+)\./g, (_m, n) => ` #${Number(n) + 1} `).replace(/_/g, " ");
	return (
		<>
			{p.needsSetup.length > 0 && <p className="text-xs text-warning">{t("plugins.needsSetup", { what: p.needsSetup.map(label).join(", ") })}</p>}
			{p.waitingFor.length > 0 && <p className="break-words text-xs text-warning">{t("plugins.waitingFor", { seams: p.waitingFor.join(", ") })}</p>}
			{p.waitingForPlugins.map((q) => (
				<p key={q.id} className="break-words text-xs text-warning" data-testid={`waits-${p.id}-${q.id}`}>
					{q.version === undefined ? t("plugins.waitsForMissing", { id: q.id, range: q.range }) : t("plugins.waitsForPlugin", { id: q.id, range: q.range, version: q.version, state: t(`plugins.state.${q.state}` as "plugins.state.active", { defaultValue: q.state }) })}
				</p>
			))}
			{p.error && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-warning">{t(HELD.includes(p.state) ? "plugins.why" : "plugins.lastError", { error: p.error })}</p>}
		</>
	);
}

/** One plugin's page: its form, its buttons, how it runs, what it is. */
function PluginPanel({ p }: { p: PluginInfo }) {
	const { data, isLoading, error, refetch } = usePluginSettings(p.id);
	if (isLoading) return <Spinner />;
	if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
	return (
		<div className="mt-3 space-y-4 border-t border-border pt-3">
			<PluginForm data={data} />
			<PluginButtons data={data} />
			<PluginAdvanced p={p} />
			<PluginTechnical p={p} />
		</div>
	);
}

type Show = "all" | "on" | "off";

/** Settings → Plugins (docs/plugins.md §12.1): the list, the on/off switch, and each plugin's own page. */
export function Plugins() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const view = useSettingsView();
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["plugins"], queryFn: endpoints.plugins });
	const [busy, setBusy] = useState<string>();
	const [open, setOpen] = useState<string>();
	const [show, setShow] = useState<Show>("all");
	const [confirming, setConfirming] = useState<{ id: string; next: string }>();
	const [review, setReview] = useState<PluginReview>();
	/** A plugin with a setup skill was just switched on: the assistant offers to walk the owner through it (docs/plugins.md §4). */
	const [setupOffer, setSetupOffer] = useState<string>();
	const opened = useRef<string | undefined>(undefined);
	// A plugin reached from a link (#plugin-<id>) opens.
	useEffect(() => {
		const id = /^#plugin-(.+)$/.exec(location.hash)?.[1];
		if (id && data?.some((p) => p.id === id) && opened.current !== id) {
			opened.current = id;
			setOpen(id);
		}
	}, [data]);
	const toggle = async (id: string, on: boolean, withDependents?: boolean) => {
		setBusy(id);
		try {
			const r = await endpoints.setPluginEnabled(id, on, withDependents);
			if (r.result === "needs_confirmation") {
				setConfirming({ id, next: r.next });
				return;
			}
			setSetupOffer(on && r.state === "active" && data?.find((x) => x.id === id)?.setup ? id : undefined);
			toast({ title: t(r.result === "applied" ? "plugins.applied" : "plugins.failed", { id }), description: r.next, variant: r.result === "applied" ? undefined : "destructive" });
		} catch (e) {
			toast({ title: t("plugins.failed", { id }), description: message(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
			await qc.invalidateQueries({ queryKey: ["plugins"] });
			qc.invalidateQueries({ queryKey: ["plugin-settings", id] });
			qc.invalidateQueries({ queryKey: ["plugin-hooks"] });
		}
	};
	if (isLoading) return <Spinner />;
	if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
	const isOn = (p: PluginInfo) => p.state === "active" || p.state === "waiting";
	const list = (data ?? []).filter((p) => show === "all" || (show === "on") === isOn(p));
	return (
		<div className="space-y-2">
			<RestartBanner plugins={data ?? []} />
			<div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("plugins.show")}>
				{(["all", "on", "off"] as const).map((s) => (
					<Button key={s} type="button" size="sm" variant={show === s ? "secondary" : "ghost"} aria-pressed={show === s} className="h-7 px-2.5 text-xs" onClick={() => setShow(s)}>
						{t(`plugins.showWhich.${s}`, { count: (data ?? []).filter((p) => s === "all" || (s === "on") === isOn(p)).length })}
					</Button>
				))}
			</div>
			{!data?.length && <p className="text-sm text-muted-foreground">{t("plugins.empty")}</p>}
			{list.map((p) => (
				<Searchable key={p.id} text={[p.id, p.description, ...p.provides]} attention={pluginNeedsAttention(p)}>
					<div id={`plugin-${p.id}`} className="scroll-mt-40 rounded-md bg-surface px-3 py-2" data-testid={`plugin-${p.id}`}>
						<div className="flex items-start gap-3">
							<div className="min-w-0 flex-1">
								<p className="flex flex-wrap items-center gap-2 text-sm">
									<span className="font-medium">{p.id}</span>
									<Badge tone={PLUGIN_TONE[p.state]}>{t(`plugins.state.${p.state}`)}</Badge>
									{p.kind === "skills" && <Badge tone="info">{t("plugins.skillPack")}</Badge>}
									{p.restartNeeded && <Badge tone="warning">{t("plugins.afterRestart")}</Badge>}
									{p.update && <Badge tone="info">{t("plugins.updateStaged", { version: p.update.version })}</Badge>}
									{p.trial && <Badge tone="warning">{t("plugins.inTrial")}</Badge>}
									{p.failures > 0 && <Badge tone="warning">{t("plugins.failures", { count: p.failures })}</Badge>}
								</p>
								{p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
								{view.technical && <Technical>{`${p.id} ${p.version}`}</Technical>}
								<PluginProblem p={p} />
								{p.source && <InstalledActions p={p} onReview={setReview} />}
								{p.setup && p.state === "active" && <SetupOffer p={p} offered={setupOffer === p.id} />}
								<Button variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? undefined : p.id)}>
									{open === p.id ? <ChevronDown /> : <ChevronRight />}
									{t("plugins.open")}
								</Button>
							</div>
							<Switch aria-label={t("plugins.toggle", { id: p.id })} checked={isOn(p)} disabled={busy === p.id || HELD.includes(p.state)} onCheckedChange={(on) => void toggle(p.id, on)} />
						</div>
						{open === p.id && <PluginPanel p={p} />}
					</div>
				</Searchable>
			))}
			<Searchable text={[t("plugins.installTitle")]}>
				<InstallBox onReview={setReview} />
			</Searchable>
			<ReviewDialog
				review={review}
				onClose={() => setReview(undefined)}
				onApproved={(r) => toast({ title: t(r.result === "failed" ? "plugins.failed" : "plugins.approved", { id: r.id }), description: r.next, variant: r.result === "failed" ? "destructive" : undefined })}
			/>
			<ConfirmDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(undefined)} title={t("plugins.confirmTitle", { id: confirming?.id })} description={confirming?.next} destructive confirmLabel={t("plugins.confirmLabel")} onConfirm={() => toggle(confirming!.id, false, true).then(() => setConfirming(undefined))} />
		</div>
	);
}

/** Switch a plugin on from somewhere else (a service card). */
export function usePluginSwitch() {
	const qc = useQueryClient();
	const { t } = useTranslation("settings");
	return async (id: string, on: boolean) => {
		try {
			const r = await endpoints.setPluginEnabled(id, on);
			toast({ title: t(r.result === "applied" ? "plugins.applied" : "plugins.failed", { id }), description: r.next, variant: r.result === "applied" ? undefined : "destructive" });
		} catch (e) {
			toast({ title: t("plugins.failed", { id }), description: message(e), variant: "destructive" });
		} finally {
			await qc.invalidateQueries({ queryKey: ["plugins"] });
			qc.invalidateQueries({ queryKey: ["plugin-settings", id] });
		}
	};
}
