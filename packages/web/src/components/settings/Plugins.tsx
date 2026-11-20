import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, MessageSquare, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { endpoints, op, runOp } from "../../lib/api";
import { useChat } from "../../lib/chat";
import type { PluginInfo, PluginReview, PluginSettings, SecretInfo, SettingSchema } from "../../lib/types";
import { formatDateTime } from "../../lib/utils";
import { Badge } from "../common/Badge";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { ErrorState, Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { InstallBox, InstalledActions, RestartBanner, ReviewDialog } from "./PluginInstall";

const PLUGIN_TONE = { active: "success", waiting: "warning", failed: "danger", disabled: "muted", installed: "warning", incompatible: "danger", changed: "danger" } as const;
/** Not loaded until the owner acts: approve, approve again, or update (docs/plugins.md §13.3). */
const HELD = ["installed", "incompatible", "changed"];
const SHOW_WHEN = "x-reelix-show-when";
const OPTIONS_FROM = "x-reelix-options-from";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One secret: stored straight to the server's secrets file, never shown again. */
export function SecretRow({ s }: { s: SecretInfo }) {
	const { t } = useTranslation(["settings", "common"]);
	const qc = useQueryClient();
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const store = async (v: string) => {
		setBusy(true);
		try {
			await runOp("secret.set", { key: s.key, value: v });
			setValue("");
			toast({ title: v ? t("secrets.stored") : t("secrets.removed"), description: s.key });
			qc.invalidateQueries({ queryKey: ["secrets"] });
			qc.invalidateQueries({ queryKey: ["plugin-settings"] });
			qc.invalidateQueries({ queryKey: ["status"] });
		} catch (e) {
			toast({ title: t("secrets.notStored"), description: message(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="grid gap-1.5 md:grid-cols-[220px_1fr] md:gap-4">
			<div>
				<p className="flex items-center gap-2 text-sm font-medium">
					<span className="font-mono text-xs">{s.key}</span>
					{s.set ? <Badge tone="success">{t("secrets.set")}</Badge> : <Badge tone="warning">{t("secrets.missing")}</Badge>}
				</p>
				{s.what && <p className="text-xs text-muted-foreground">{s.what}</p>}
			</div>
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (value) void store(value);
				}}
			>
				<Input type="password" autoComplete="new-password" aria-label={s.key} value={value} onChange={(e) => setValue(e.target.value)} placeholder={s.set ? t("secrets.placeholderReplace") : t("secrets.placeholder")} />
				<Button type="submit" disabled={busy || !value} className="shrink-0">
					{busy && <Spinner />}
					{t("common:actions.save")}
				</Button>
				{s.set && (
					<Button type="button" variant="ghost" disabled={busy} className="shrink-0" onClick={() => store("")}>
						{t("secrets.clear")}
					</Button>
				)}
			</form>
		</div>
	);
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

type FieldProps = { plugin: string; path: (string | number)[]; schema: SettingSchema; value: unknown; onChange: (v: unknown) => void; siblings: Record<string, unknown>; strings: Record<string, string>; errors: Record<string, string> };

function SettingField({ plugin, path, schema, value, onChange, siblings, strings, errors }: FieldProps) {
	const { t } = useTranslation("settings");
	const key = path.filter((p) => typeof p === "string").join(".");
	const name = String(path[path.length - 1]);
	const label = strings[`settings.${key}`] ?? name.replace(/_/g, " ");
	const help = strings[`settings.${key}_help`];
	const error = errors[`/${path.join("/")}`];
	const id = `setting-${plugin}-${path.join("-")}`;
	const when = schema[SHOW_WHEN];
	const optionsFrom = schema[OPTIONS_FROM];
	const options = useQuery({ queryKey: ["plugin-options", plugin, optionsFrom], queryFn: () => op<{ value: string; label: string }[]>(`${plugin}.${optionsFrom}`), enabled: !!optionsFrom });
	if (when && siblings[when.field] !== when.equals) return null;

	const listed = choices(schema);
	let control: React.ReactNode;
	if (optionsFrom || listed) {
		const list = optionsFrom ? (options.data ?? []) : listed!.map((v) => ({ value: String(v), label: strings[`settings.${key}_${String(v)}`] ?? String(v) }));
		control = (
			<select id={id} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)} className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm">
				{list.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
				{value !== undefined && !list.some((o) => o.value === String(value)) && <option value={String(value)}>{String(value)}</option>}
			</select>
		);
	} else if (schema.type === "boolean") {
		control = <Switch id={id} checked={!!value} onCheckedChange={(v) => onChange(v)} />;
	} else if (schema.type === "number" || schema.type === "integer") {
		control = <Input id={id} type="number" value={value === undefined ? "" : String(value)} min={schema.minimum} max={schema.maximum} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />;
	} else if (schema.type === "array" && schema.items?.type === "object") {
		const entries = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
		const full = schema.maxItems !== undefined && entries.length >= schema.maxItems;
		control = (
			<div className="min-w-0 flex-1 space-y-2">
				{entries.map((entry, i) => (
					<div key={i} className="space-y-2 rounded-md border border-border p-2">
						<div className="flex items-center justify-between">
							<span className="text-xs text-muted-foreground">#{i + 1}</span>
							<Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onChange(entries.filter((_, j) => j !== i))}>
								<Trash2 /> {t("plugins.removeEntry")}
							</Button>
						</div>
						{Object.entries(schema.items!.properties ?? {}).map(([k, s]) => (
							<SettingField key={k} plugin={plugin} path={[...path, i, k]} schema={s} value={entry?.[k]} siblings={entry ?? {}} strings={strings} errors={errors} onChange={(v) => onChange(entries.map((e, j) => (j === i ? { ...e, [k]: v } : e)))} />
						))}
					</div>
				))}
				<Button type="button" variant="outline" size="sm" disabled={full} onClick={() => onChange([...entries, withDefaults(schema.items, {})])}>
					<Plus /> {t("plugins.addEntry")}
				</Button>
			</div>
		);
	} else if (schema.type === "array") {
		const words = Array.isArray(value) ? (value as unknown[]).map(String).join(", ") : "";
		control = <ListInput id={id} value={words} onChange={(text) => onChange(text.split(",").map((x) => x.trim()).filter(Boolean))} />;
	} else {
		control = <Input id={id} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />;
	}
	return (
		<div className="grid gap-1.5 md:grid-cols-[220px_1fr] md:gap-4">
			<label className="text-sm font-medium" htmlFor={id}>
				{label}
			</label>
			<div className="min-w-0">
				<div className="flex gap-2">{control}</div>
				{help && <p className="mt-1 text-xs text-muted-foreground">{help}</p>}
				{error && <p className="mt-1 text-xs text-destructive-foreground">{error}</p>}
			</div>
		</div>
	);
}

/** A comma-separated list, kept as typed until the field is left. */
function ListInput({ id, value, onChange }: { id: string; value: string; onChange: (text: string) => void }) {
	const [text, setText] = useState(value);
	useEffect(() => setText(value), [value]);
	return <Input id={id} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(text)} />;
}

function SettingsForm({ data }: { data: PluginSettings }) {
	const { t } = useTranslation(["settings", "common"]);
	const qc = useQueryClient();
	const [values, setValues] = useState(data.values);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	useEffect(() => setValues(data.values), [JSON.stringify(data.values)]);
	const schema = data.schema!;
	const dirty = JSON.stringify(values) !== JSON.stringify(data.values);
	const save = async () => {
		setBusy(true);
		try {
			const r = await endpoints.configurePlugin(data.id, values);
			setErrors(Object.fromEntries((r.errors ?? []).map((e) => [e.path, e.message])));
			toast({ title: t(r.result === "applied" ? "plugins.saved" : "plugins.notSaved", { id: data.id }), description: r.next, variant: r.result === "applied" ? undefined : "destructive" });
			if (r.result === "applied") await qc.invalidateQueries({ queryKey: ["plugin-settings", data.id] });
			qc.invalidateQueries({ queryKey: ["plugins"] });
		} catch (e) {
			toast({ title: t("plugins.notSaved", { id: data.id }), description: message(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			className="space-y-3"
			// Reelix checks the values against the schema and says what is wrong; the browser does not stop the form first.
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			{Object.entries(schema.properties ?? {}).map(([k, s]) => (
				<SettingField key={k} plugin={data.id} path={[k]} schema={s} value={values[k]} siblings={values} strings={data.strings} errors={errors} onChange={(v) => setValues((old) => ({ ...old, [k]: v }))} />
			))}
			{errors["/"] && <p className="text-xs text-destructive-foreground">{errors["/"]}</p>}
			<Button type="submit" disabled={busy || !dirty}>
				{busy && <Spinner />}
				{t("common:actions.save")}
			</Button>
		</form>
	);
}

/** Buttons that run one of the plugin's operations, such as "test" or "pair". What it answers is shown as it is. */
function PluginButtons({ data }: { data: PluginSettings }) {
	const { t } = useTranslation("settings");
	const [busy, setBusy] = useState<string>();
	const [answer, setAnswer] = useState<string>();
	if (!data.buttons.length) return null;
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap gap-2">
				{data.buttons.map((name) => {
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

/** Per plugin: settings, buttons, secrets, trial and typed tools (docs/plugins.md §12.1). */
function PluginPanel({ p }: { p: PluginInfo }) {
	const { t, i18n } = useTranslation("settings");
	const qc = useQueryClient();
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["plugin-settings", p.id, i18n.language], queryFn: () => endpoints.pluginSettings(p.id, i18n.language) });
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
	if (isLoading) return <Spinner />;
	if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
	return (
		<div className="mt-3 space-y-4 border-t border-border pt-3">
			{data.schema ? <SettingsForm data={data} /> : data.note && <p className="text-xs text-muted-foreground">{data.note}</p>}
			<PluginButtons data={data} />
			{data.secrets.length > 0 && (
				<div className="space-y-2">
					<p className="text-xs font-semibold text-muted-foreground">{t("plugins.secrets")}</p>
					{data.secrets.map((s) => (
						<SecretRow key={s.key} s={{ key: s.key, what: data.strings[`secrets.${s.name}`] ?? "", set: s.set }} />
					))}
				</div>
			)}
			{p.hooks.length > 0 && (
				<div className="flex items-start gap-3 rounded-md bg-well px-3 py-2">
					<Switch id={`trial-${p.id}`} checked={p.trial} onCheckedChange={(on) => void change(() => endpoints.setPluginTrial(p.id, on))} />
					<label htmlFor={`trial-${p.id}`} className="min-w-0 space-y-1 text-sm">
						<span className="font-medium">{t("plugins.trial")}</span>
						<span className="block text-xs text-muted-foreground">{t("plugins.trialHelp")}</span>
						{(p.trial || !!p.trialResult?.calls) && <TrialResult p={p} />}
					</label>
				</div>
			)}
			{p.jobPrompt !== undefined && (
				<div className="flex items-start gap-3 rounded-md bg-well px-3 py-2">
					<Switch id={`job-prompt-${p.id}`} checked={p.jobPrompt} onCheckedChange={(on) => void change(() => endpoints.setPluginJobPrompt(p.id, on))} />
					<label htmlFor={`job-prompt-${p.id}`} className="min-w-0 text-sm">
						<span className="font-medium">{t("plugins.jobPrompt")}</span>
						<span className="block text-xs text-muted-foreground">{t("plugins.jobPromptHelp")}</span>
					</label>
				</div>
			)}
			{p.model && <ModelUse p={p} change={change} />}
			{p.kind === "plugin" && (
				<div className="flex items-start gap-3 rounded-md bg-well px-3 py-2">
					<Switch id={`runtime-${p.id}`} checked={p.runtime === "process"} disabled={!p.processAllowed && p.runtime !== "process"} onCheckedChange={(on) => void change(() => endpoints.setPluginRuntime(p.id, on ? "process" : "in-process"))} />
					<label htmlFor={`runtime-${p.id}`} className="min-w-0 text-sm">
						<span className="font-medium">{t("plugins.runtime")}</span>
						<span className="block text-xs text-muted-foreground">{p.processAllowed ? t("plugins.runtimeHelp", { default: t(p.runtimeDefault === "process" ? "plugins.runtimeProcess" : "plugins.runtimeInProcess") }) : t("plugins.runtimeNotPossible")}</span>
					</label>
				</div>
			)}
			{p.tools.length > 0 && (
				<div className="flex items-start gap-3 rounded-md bg-well px-3 py-2">
					<Switch id={`tools-${p.id}`} checked={p.toolsOn} onCheckedChange={(on) => void change(() => endpoints.setPluginTools(p.id, on))} />
					<label htmlFor={`tools-${p.id}`} className="min-w-0 text-sm">
						<span className="font-medium">{t("plugins.tools")}</span>
						<span className="block text-xs text-muted-foreground">{t("plugins.toolsHelp", { tools: p.tools.join(", ") })}</span>
					</label>
				</div>
			)}
		</div>
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
		<div className="space-y-2 rounded-md bg-well px-3 py-2 text-sm">
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
						{r}
					</label>
				))}
			</div>
		</div>
	);
}

/** The order plugins run in, per pipeline hook; the owner's to change (docs/plugins.md §8). */
function HookOrder() {
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
		<div className="space-y-2 rounded-md bg-surface px-3 py-2">
			<p className="text-sm font-medium">{t("plugins.hookOrder")}</p>
			<p className="text-xs text-muted-foreground">{t("plugins.hookOrderHelp")}</p>
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
									<span className="font-mono">{x.plugin}</span>
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

/** Settings → Plugins (docs/plugins.md §12.1): the list, the on/off switch, and each plugin's own page. */
export function Plugins() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["plugins"], queryFn: endpoints.plugins });
	const [busy, setBusy] = useState<string>();
	const [open, setOpen] = useState<string>();
	const [confirming, setConfirming] = useState<{ id: string; next: string }>();
	const [review, setReview] = useState<PluginReview>();
	/** A plugin with a setup skill was just switched on: the assistant offers to walk the owner through it (docs/plugins.md §4). */
	const [setupOffer, setSetupOffer] = useState<string>();
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
	return (
		<div className="space-y-2">
			<InstallBox onReview={setReview} />
			<RestartBanner plugins={data ?? []} />
			{!data?.length && <p className="text-sm text-muted-foreground">{t("plugins.empty")}</p>}
			<HookOrder />
			{(data ?? []).map((p) => {
				const uses = [
					[t("plugins.provides"), p.provides],
					[t("plugins.operations"), p.operations],
					[t("plugins.jobs"), p.jobs],
					[t("plugins.events"), p.events],
					[t("plugins.runs"), p.runs],
				] as const;
				return (
					<div key={p.id} className="rounded-md bg-surface px-3 py-2" data-testid={`plugin-${p.id}`}>
						<div className="flex items-start gap-3">
							<div className="min-w-0 flex-1">
								<p className="flex flex-wrap items-center gap-2 text-sm">
									<span className="font-mono font-medium">{p.id}</span>
									{p.version && <span className="text-xs text-muted-foreground">{p.version}</span>}
									<Badge tone={PLUGIN_TONE[p.state]}>{t(`plugins.state.${p.state}`)}</Badge>
									{p.kind === "skills" && <Badge tone="info">{t("plugins.skillPack")}</Badge>}
									{p.restartNeeded && <Badge tone="warning">{t("plugins.afterRestart")}</Badge>}
									{p.update && <Badge tone="info">{t("plugins.updateStaged", { version: p.update.version })}</Badge>}
									{p.trial && <Badge tone="warning">{t("plugins.inTrial")}</Badge>}
									{p.failures > 0 && <Badge tone="warning">{t("plugins.failures", { count: p.failures })}</Badge>}
								</p>
								{p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
								{p.waitingFor.length > 0 && <p className="break-words text-xs text-warning">{t("plugins.waitingFor", { seams: p.waitingFor.join(", ") })}</p>}
								{p.waitingForPlugins.map((q) => (
									<p key={q.id} className="break-words text-xs text-warning" data-testid={`waits-${p.id}-${q.id}`}>
										{q.version === undefined ? t("plugins.waitsForMissing", { id: q.id, range: q.range }) : t("plugins.waitsForPlugin", { id: q.id, range: q.range, version: q.version, state: t(`plugins.state.${q.state}` as "plugins.state.active", { defaultValue: q.state }) })}
									</p>
								))}
								{uses
									.filter(([, names]) => names.length)
									.map(([label, names]) => (
										<p key={label} className="break-words text-xs text-muted-foreground">
											{label} <span className="font-mono">{names.join(", ")}</span>
										</p>
									))}
								{p.skills.length > 0 && (
									<p className="break-words text-xs text-muted-foreground">
										{t("plugins.skills")} <span className="font-mono">{p.skills.join(", ")}</span>
									</p>
								)}
								{p.error && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-warning">{t(HELD.includes(p.state) ? "plugins.why" : "plugins.lastError", { error: p.error })}</p>}
								{p.source && <InstalledActions p={p} onReview={setReview} />}
								{p.setup && p.state === "active" && <SetupOffer p={p} offered={setupOffer === p.id} />}
								<Button variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? undefined : p.id)}>
									{open === p.id ? <ChevronDown /> : <ChevronRight />}
									{t("plugins.open")}
								</Button>
							</div>
							<Switch aria-label={t("plugins.toggle", { id: p.id })} checked={p.state === "active" || p.state === "waiting"} disabled={busy === p.id || HELD.includes(p.state)} onCheckedChange={(on) => void toggle(p.id, on)} />
						</div>
						{open === p.id && <PluginPanel p={p} />}
					</div>
				);
			})}
			<ReviewDialog
				review={review}
				onClose={() => setReview(undefined)}
				onApproved={(r) => toast({ title: t(r.result === "failed" ? "plugins.failed" : "plugins.approved", { id: r.id }), description: r.next, variant: r.result === "failed" ? "destructive" : undefined })}
			/>
			<ConfirmDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(undefined)} title={t("plugins.confirmTitle", { id: confirming?.id })} description={confirming?.next} destructive confirmLabel={t("plugins.confirmLabel")} onConfirm={() => toggle(confirming!.id, false, true).then(() => setConfirming(undefined))} />
		</div>
	);
}
