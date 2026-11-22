import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStatus } from "../../app/Sidebar";
import { endpoints, op, runOp } from "../../lib/api";
import type { DoctorCheck, PluginInfo, PluginSettings } from "../../lib/types";
import { CheckRow } from "./Doctor";
import { cn } from "../../lib/utils";
import { Badge, type Tone } from "../common/Badge";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { ErrorState, Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Disclosure, PathMapEditor, Row, SaveBar, Searchable, SecretBadge, SecretInput, type PathMap, getPath, useConfigDraft } from "./form";
import { type AlsoInForm, PluginAdvanced, PluginButtons, PluginForm, PluginProblem, PluginTechnical, type SecretGroup, usePluginSettings, usePluginSwitch } from "./Plugins";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The states a connection can be in (docs/settings.md, "States"), each with its badge. */
export type ServiceState = "unused" | "off" | "paused" | "needs_setup" | "unreachable" | "connected" | "not_tested" | "failed" | "waiting";
const TONE: Record<ServiceState, Tone> = { unused: "muted", off: "muted", paused: "warning", needs_setup: "warning", unreachable: "danger", connected: "success", not_tested: "default", failed: "danger", waiting: "warning" };
export const serviceNeedsAttention = (s: ServiceState) => ["paused", "needs_setup", "unreachable", "failed", "waiting"].includes(s);

/** A provider that stopped on purpose says so in its impact (qBittorrent after a refused login: `checks.paused`). */
const paused = (c: DoctorCheck) => /(^|[.:])paused$/.test(c.impact?.key ?? "");

/** A plugin's state as a connection: off, waiting, needs setup, and else what its last test (here or in Doctor) said. */
export function pluginServiceState(p: PluginInfo | undefined, tested?: DoctorCheck[]): ServiceState {
	if (!p || p.state === "disabled") return "off";
	if (p.unused) return "unused";
	if (p.needsSetup.length) return "needs_setup";
	if (p.state === "failed" || ["installed", "incompatible", "changed"].includes(p.state)) return "failed";
	if (p.state === "waiting") return "waiting";
	const results = tested ?? p.lastCheck?.results;
	if (!results?.length) return "not_tested";
	if (results.some(paused)) return "paused";
	return results.some((c) => c.state === "failed") ? "unreachable" : "connected";
}

/** A card in Services: the connection's name, its state with what that means, and what to do. */
export function ServiceCard({ id, title, state, effect, children, search = [] }: { id: string; title: string; state: ServiceState; effect?: ReactNode; children: ReactNode; search?: string[] }) {
	const { t } = useTranslation("settings");
	return (
		<Searchable text={[title, ...search]} attention={serviceNeedsAttention(state)}>
			<div id={`service-${id}`} className="scroll-mt-40 space-y-4 rounded-lg border border-border p-4">
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="font-medium">{title}</h3>
					<Badge tone={TONE[state]}>{t(`services.state.${state}`)}</Badge>
				</div>
				{effect && <div className={cn("-mt-2 text-sm", serviceNeedsAttention(state) ? "text-warning" : "text-muted-foreground")}>{effect}</div>}
				{children}
			</div>
		</Searchable>
	);
}

/** "Test connection": the plugin's own check, alone (operation plugin.check). */
function useTest(plugin: string) {
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [results, setResults] = useState<DoctorCheck[]>();
	const run = async () => {
		setBusy(true);
		try {
			setResults(await op<DoctorCheck[]>("plugin.check", { plugin }));
		} catch (e) {
			toast({ title: message(e), variant: "destructive" });
		} finally {
			setBusy(false);
			qc.invalidateQueries({ queryKey: ["plugins"] });
		}
	};
	return { busy, results, run };
}

function TestResults({ results, rerun }: { results?: DoctorCheck[]; rerun: () => void }) {
	if (!results) return null;
	return (
		<div className="space-y-1.5">
			{results.map((r, i) => (
				<CheckRow key={i} check={r} onRerun={rerun} />
			))}
		</div>
	);
}

/**
 * A connection that a plugin makes (qBittorrent, Jackett, Jellyfin, subtitle sites): its form and secrets in one,
 * Test connection, and when it is off, the switch. `effect`: what its state means for the owner.
 */
export function PluginService({ plugin, title, effect, children, also, groups }: { plugin: string; title: string; effect: (state: ServiceState) => ReactNode; children?: ReactNode; also?: AlsoInForm; groups?: SecretGroup[] }) {
	const { t } = useTranslation("settings");
	const plugins = useQuery({ queryKey: ["plugins"], queryFn: endpoints.plugins });
	const p = plugins.data?.find((x) => x.id === plugin);
	const settings = usePluginSettings(plugin);
	const test = useTest(plugin);
	const turn = usePluginSwitch();
	const [busy, setBusy] = useState(false);
	if (plugins.isLoading) return <Spinner />;
	if (!p) return null;
	const state = pluginServiceState(p, test.results);
	return (
		<ServiceCard id={plugin} title={title} state={state} effect={effect(state)} search={[plugin, p.description]}>
			<PluginProblem p={p} setup={false} />
			{settings.data && p.state !== "disabled" && <SetupNeeds p={p} data={settings.data} />}
			{p.state === "disabled" ? (
				<Button
					variant="outline"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						await turn(plugin, true);
						setBusy(false);
					}}
				>
					{busy ? <Spinner /> : <Plug />} {t("services.turnOn")}
				</Button>
			) : settings.isLoading ? (
				<Spinner />
			) : settings.error || !settings.data ? (
				<ErrorState error={settings.error} onRetry={() => settings.refetch()} />
			) : (
				<>
					{children}
					<PluginForm
						data={settings.data}
						also={also}
						groups={groups}
						// Saved and started again: checked once, and the card shows what the check found.
						onSaved={(s) => s === "active" && void test.run()}
						footer={
							<div className="space-y-2">
								<Button type="button" variant="outline" disabled={test.busy || p.needsSetup.length > 0} onClick={() => void test.run()}>
									{test.busy && <Spinner />}
									{t("services.test")}
								</Button>
								{p.needsSetup.length > 0 && <p className="text-xs text-muted-foreground">{t("services.testAfterSetup")}</p>}
								<TestResults results={test.results ?? p.lastCheck?.results} rerun={() => void test.run()} />
							</div>
						}
					/>
					<PluginAdvanced p={p} />
					<PluginTechnical p={p} />
				</>
			)}
		</ServiceCard>
	);
}

/** What the plugin still needs, by the names its form shows, with a button to the first one. */
function SetupNeeds({ p, data }: { p: PluginInfo; data: PluginSettings }) {
	const { t } = useTranslation("settings");
	if (!p.needsSetup.length) return null;
	const secretNames = new Set([...data.secrets.map((s) => s.name), ...data.perEntry.map((s) => s.name)]);
	const named = p.needsSetup.map((path) => {
		const parts = path.split(".");
		const entry = parts.find((x) => /^\d+$/.test(x));
		const n = entry === undefined ? "" : ` #${Number(entry) + 1}`;
		const last = parts.at(-1)!;
		if (secretNames.has(last) && (parts.length === 1 || data.perEntry.some((s) => s.per === parts[0] && s.name === last)))
			return { label: `${data.strings[`secrets.${last}`] ?? last}${n}`, anchor: `secret-plugins.${p.id}.${path}` };
		const key = parts.filter((x) => !/^\d+$/.test(x)).join(".");
		return { label: `${data.strings[`settings.${key}`] ?? last.replace(/_/g, " ")}${n}`, anchor: `field-plugins.${p.id}.${path}` };
	});
	const go = () => {
		const el = document.getElementById(named[0]!.anchor);
		el?.scrollIntoView({ behavior: "smooth", block: "center" });
		(el?.matches("input, select, textarea") ? el : el?.querySelector<HTMLElement>("input, select, textarea"))?.focus({ preventScroll: true });
	};
	return (
		<div className="flex flex-wrap items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm">
			<span className="min-w-0 flex-1 text-warning">{t("services.needs", { what: named.map((x) => x.label).join(", ") })}</span>
			<Button type="button" size="sm" variant="outline" onClick={go}>
				{t("services.fillIn")}
			</Button>
		</div>
	);
}

type ProviderChoice = { active: string; running: boolean; providers: { id: string; label: string; plugin: string }[] };

/**
 * The one active provider of a kind (downloader, media server): only the owner switches, only to one that runs and
 * is set up, and is asked first. With one provider, there is nothing to switch.
 */
function ProviderSwitch({ config, setting, operation, kind }: { config: Record<string, unknown>; setting: "downloader" | "media_server"; operation: string; kind: "downloader" | "mediaServer" }) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const list = useQuery({ queryKey: [operation, config[setting]], queryFn: () => op<ProviderChoice>(operation) });
	const [to, setTo] = useState<string>();
	const others = (list.data?.providers ?? []).filter((p) => p.id !== list.data?.active);
	if (!others.length) return null;
	return (
		<Row label={t(`${kind}.switchTo`)} help={t(`${kind}.switchHelp`)}>
			<div className="flex flex-wrap gap-2">
				{others.map((p) => (
					<Button key={p.id} type="button" variant="outline" size="sm" onClick={() => setTo(p.id)}>
						{p.label}
					</Button>
				))}
			</div>
			<ConfirmDialog
				open={!!to}
				onOpenChange={(o) => !o && setTo(undefined)}
				title={t(`${kind}.switchTitle`, { name: others.find((p) => p.id === to)?.label })}
				description={t(`${kind}.switchBody`)}
				confirmLabel={t(`${kind}.switchConfirm`)}
				onConfirm={async () => {
					try {
						await runOp("config.set", { path: setting, value: to });
						await qc.invalidateQueries({ queryKey: ["config"] });
						qc.invalidateQueries({ queryKey: [operation] });
					} catch (e) {
						toast({ title: t("field.notSaved"), description: message(e), variant: "destructive" });
					}
					setTo(undefined);
				}}
			/>
		</Row>
	);
}

/** A provider's path map, saved with the Save of its card (it belongs to the active provider, not to the plugin's settings). */
function usePathMap(config: Record<string, unknown>, path: string, service: string, example: { theirs: string; ours: string }, check?: string): AlsoInForm {
	const { t } = useTranslation("settings");
	const draft = useConfigDraft(config, [path]);
	// Doctor's view of it (the same quick run as Status): a folder Reelix cannot see, or the same path naming another folder here.
	const quick = useQuery({ queryKey: ["doctor-quick"], queryFn: () => endpoints.doctor(true), staleTime: 60_000, enabled: !!check });
	const problem = quick.data?.find((c) => c.name === check && c.state === "failed" && c.action && "anchor" in c.action && c.action.anchor === `field-${path}`);
	return {
		dirty: draft.dirty,
		save: async () => {
			await draft.save();
			void quick.refetch();
		},
		discard: draft.discard,
		node: (
			<Row label={t("pathMap.title")} help={t("pathMap.help", { service })} technical={path} error={draft.errors[path]}>
				<PathMapEditor service={service} value={(draft.get(path) as PathMap | undefined) ?? []} onChange={(v) => draft.set(path, v.length ? v : undefined)} example={example} />
				{problem && !draft.dirty && <CheckRow check={{ ...problem, action: undefined }} onRerun={() => void quick.refetch()} />}
			</Row>
		),
	};
}

/** The card of the active provider of a kind: its plugin's card, with the switch and the path map in it. */
function ActiveProvider({ config, setting, operation, kind, mapSetting, example, effect }: { config: Record<string, unknown>; setting: "downloader" | "media_server"; operation: string; kind: "downloader" | "mediaServer"; mapSetting: string; example: { theirs: string; ours: string }; effect: (state: ServiceState) => ReactNode }) {
	const { t } = useTranslation("settings");
	const list = useQuery({ queryKey: [operation, config[setting]], queryFn: () => op<ProviderChoice>(operation) });
	const plugins = useQuery({ queryKey: ["plugins"], queryFn: endpoints.plugins });
	if (list.isLoading || plugins.isLoading) return <Spinner />;
	if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
	const d = list.data!;
	const provider = d.providers.find((p) => p.id === d.active);
	// The active provider's plugin; when it does not run, the plugin that would provide it (same id), so it can be repaired.
	const plugin = provider?.plugin ?? plugins.data?.find((p) => p.id === d.active)?.id;
	if (!plugin)
		return (
			<ServiceCard id={kind} title={t(`${kind}.title`)} state="unused" effect={effect("unused")}>
				<ProviderSwitch config={config} setting={setting} operation={operation} kind={kind} />
			</ServiceCard>
		);
	return <ProviderCard config={config} setting={setting} operation={operation} kind={kind} plugin={plugin} name={provider?.label ?? d.active} mapPath={`${mapSetting}.${d.active}`} example={example} effect={effect} />;
}

function ProviderCard({ config, setting, operation, kind, plugin, name, mapPath, example, effect }: { config: Record<string, unknown>; setting: "downloader" | "media_server"; operation: string; kind: "downloader" | "mediaServer"; plugin: string; name: string; mapPath: string; example: { theirs: string; ours: string }; effect: (state: ServiceState) => ReactNode }) {
	const { t } = useTranslation("settings");
	const map = usePathMap(config, mapPath, name, example, setting === "media_server" ? "media server" : "downloader");
	return (
		<PluginService plugin={plugin} title={t(`${kind}.cardTitle`, { name })} effect={effect} also={map}>
			<ProviderSwitch config={config} setting={setting} operation={operation} kind={kind} />
		</PluginService>
	);
}

/** TMDB: titles, posters, descriptions and episode lists. A key Reelix sends to TMDB only. */
function TmdbCard() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const secrets = useQuery({ queryKey: ["secrets"], queryFn: endpoints.secrets });
	const [value, setValue] = useState<string | null | undefined>();
	const [busy, setBusy] = useState(false);
	const [tested, setTested] = useState<DoctorCheck>();
	const set = !!secrets.data?.find((s) => s.key === "tmdb.api_key")?.set;
	const state: ServiceState = !set ? "needs_setup" : tested ? (tested.state === "passed" ? "connected" : "unreachable") : "not_tested";
	const save = async () => {
		setBusy(true);
		try {
			await runOp("secret.set", { key: "tmdb.api_key", value: value ?? "" });
			setValue(undefined);
			setTested(undefined);
			toast({ title: t("secrets.stored") });
			await qc.invalidateQueries({ queryKey: ["secrets"] });
			qc.invalidateQueries({ queryKey: ["status"] });
		} catch (e) {
			toast({ title: t("secrets.notStored"), description: message(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	return (
		<ServiceCard id="tmdb" title={t("services.tmdb.title")} state={state} effect={t(set ? "services.tmdb.what" : "services.tmdb.missing")} search={["tmdb", "metadata"]}>
			<form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void save())}>
				<Row label={t("services.tmdb.key")} htmlFor="secret-tmdb.api_key" help={t("services.tmdb.keyHelp")} technical="tmdb.api_key" badge={<SecretBadge set={set} required />} attention={!set}>
					<SecretInput id="secret-tmdb.api_key" set={set} value={value} required onChange={setValue} />
				</Row>
				<div className="space-y-2">
					<Button
						type="button"
						variant="outline"
						disabled={!set || busy}
						onClick={async () => {
							setBusy(true);
							try {
								const checks = await endpoints.doctor(true);
								setTested(checks.find((x) => x.name === "tmdb"));
							} finally {
								setBusy(false);
							}
						}}
					>
						{t("services.test")}
					</Button>
					{tested && <CheckRow check={tested} onRerun={() => undefined} />}
				</div>
				<SaveBar dirty={value !== undefined && value !== ""} busy={busy} onSave={() => void save()} onDiscard={() => setValue(undefined)} />
			</form>
		</ServiceCard>
	);
}

/** magpie, the optional model gateway: its address and key together, and the admin key under Advanced. */
function MagpieCard({ config }: { config: Record<string, unknown> }) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { data: status } = useStatus();
	const secrets = useQuery({ queryKey: ["secrets"], queryFn: endpoints.secrets });
	const draft = useConfigDraft(config, ["magpie.url"]);
	const [keys, setKeys] = useState<Record<string, string | null | undefined>>({});
	const [busy, setBusy] = useState(false);
	const [open, setOpen] = useState(false);
	const isSet = (k: string) => !!secrets.data?.find((s) => s.key === k)?.set;
	const url = getPath(config, "magpie.url") as string | undefined;
	const m = status?.model.magpie;
	const state: ServiceState = !url ? "unused" : !isSet("magpie.api_key") ? "needs_setup" : m?.ok ? "connected" : m?.error ? "unreachable" : "not_tested";
	const typed = Object.entries(keys).filter(([, v]) => v !== undefined && v !== "");
	const save = async () => {
		setBusy(true);
		try {
			for (const [key, v] of typed) await runOp("secret.set", { key, value: v ?? "" });
			if (draft.dirty) await draft.save();
			setKeys({});
			await qc.invalidateQueries({ queryKey: ["secrets"] });
			qc.invalidateQueries({ queryKey: ["status"] });
		} catch (e) {
			toast({ title: t("secrets.notStored"), description: message(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	const key = (k: string, label: string, help: string) => (
		<Row label={label} htmlFor={`secret-${k}`} help={help} technical={k} badge={<SecretBadge set={isSet(k)} required={k === "magpie.api_key"} />}>
			<SecretInput id={`secret-${k}`} set={isSet(k)} value={keys[k]} onChange={(v) => setKeys((x) => ({ ...x, [k]: v }))} />
		</Row>
	);
	return (
		<ServiceCard
			id="magpie"
			title={t("services.magpie.title")}
			state={state}
			effect={state === "unused" ? t("services.magpie.unused") : m?.ok ? t("models.magpieOk", { count: m.models.length }) : m?.error ? t("models.magpieDown", { error: m.error }) : t("services.magpie.what")}
			search={["magpie", "gateway"]}
		>
			{state === "unused" && !open ? (
				<Button variant="outline" onClick={() => setOpen(true)}>
					{t("services.setUp")}
				</Button>
			) : (
				<form className="space-y-4" onSubmit={(e) => (e.preventDefault(), void save())}>
					<Row label={t("models.magpieUrl")} htmlFor="magpie-url" help={t("services.magpie.urlHelp")} technical="magpie.url" error={draft.errors["magpie.url"]}>
						<Input id="magpie-url" value={(draft.get("magpie.url") as string | undefined) ?? ""} placeholder="http://127.0.0.1:3425" onChange={(e) => draft.set("magpie.url", e.target.value || undefined)} />
					</Row>
					{key("magpie.api_key", t("services.magpie.key"), t("services.magpie.keyHelp"))}
					<Disclosure title={t("form.advanced")}>{key("magpie.admin_key", t("services.magpie.adminKey"), t("services.magpie.adminKeyHelp"))}</Disclosure>
					<SaveBar dirty={draft.dirty || typed.length > 0} busy={busy} onSave={() => void save()} onDiscard={() => (draft.discard(), setKeys({}))} />
				</form>
			)}
		</ServiceCard>
	);
}

/** Telegram, step by step: the token, the bot checked, the owner linked, a test message. A step waits for the one before. */
function TelegramCard() {
	const { t } = useTranslation("settings");
	const plugins = useQuery({ queryKey: ["plugins"], queryFn: endpoints.plugins });
	const p = plugins.data?.find((x) => x.id === "telegram");
	const settings = usePluginSettings("telegram");
	const status = useQuery({ queryKey: ["telegram-status"], queryFn: () => op<{ configured: boolean; linked: boolean; bot?: string; error?: string }>("telegram.status"), enabled: p?.state === "active", retry: false });
	const turn = usePluginSwitch();
	if (!p) return null;
	const s = status.data;
	const state: ServiceState = p.state === "disabled" || p.unused ? "unused" : p.needsSetup.length ? "needs_setup" : s?.error ? "unreachable" : s?.bot && s.linked ? "connected" : pluginServiceState(p);
	const steps: { done: boolean; title: string; body: ReactNode }[] = [
		{ done: !p.needsSetup.length, title: t("services.telegram.step1"), body: settings.data && <PluginForm data={settings.data} /> },
		{ done: !!s?.bot, title: t("services.telegram.step2"), body: settings.data && <PluginButtons data={settings.data} only={["status"]} /> },
		{ done: !!s?.linked, title: t("services.telegram.step3"), body: settings.data && <PluginButtons data={settings.data} only={["link"]} /> },
		{ done: false, title: t("services.telegram.step4"), body: settings.data && <PluginButtons data={settings.data} only={["test"]} /> },
	];
	const firstOpen = steps.findIndex((x) => !x.done);
	return (
		<ServiceCard id="telegram" title="Telegram" state={state} effect={state === "unused" ? t("services.telegram.unused") : s?.error ? s.error : t("services.telegram.what")} search={["telegram", "chat"]}>
			{p.state === "disabled" ? (
				<Button variant="outline" onClick={() => void turn("telegram", true)}>
					<Plug /> {t("services.setUp")}
				</Button>
			) : (
				<>
					<ol className="space-y-3">
						{steps.map((step, i) => {
							const waiting = firstOpen >= 0 && i > firstOpen && i > 0 && !steps[i - 1]!.done;
							return (
								<li key={i} className="space-y-2 rounded-md bg-well p-3">
									<p className="flex items-center gap-2 text-sm font-medium">
										<span className={cn("flex size-5 items-center justify-center rounded-full text-[11px]", step.done ? "bg-success/20 text-success" : "bg-muted text-muted-foreground")}>{i + 1}</span>
										{step.title}
									</p>
									{waiting ? <p className="text-xs text-muted-foreground">{t("services.telegram.after", { step: steps[i - 1]!.title })}</p> : step.body}
								</li>
							);
						})}
					</ol>
					<Button type="button" variant="ghost" size="sm" onClick={() => void status.refetch()}>
						{t("services.telegram.refresh")}
					</Button>
					<PluginAdvanced p={p} />
					<PluginTechnical p={p} />
				</>
			)}
		</ServiceCard>
	);
}

type Site = { id: string; label: string; enabled: boolean; ready: string; state: { limitUntil?: string; verificationSince?: string; downloadsToday?: number } };

/** Subtitle sites, one group per site: what it needs, what an account adds, and whether it is ready. */
function SubtitleSitesCard() {
	const { t } = useTranslation("settings");
	const sites = useQuery({ queryKey: ["site.status"], queryFn: () => op<Site[]>("site.status"), retry: false });
	return (
		<PluginService
			plugin="subtitle-sites"
			title={t("services.subtitles.title")}
			effect={(state) => (state === "off" ? t("services.subtitles.off") : t("services.subtitles.what"))}
			groups={sites.data?.map((s) => ({
				id: s.id,
				owns: (secret: string) => secret.startsWith(`${s.id}_`),
				title: (
					<>
						{s.label}
						<Badge tone={s.ready === "ready" ? "success" : "warning"}>{s.ready === "ready" ? t("services.subtitles.ready") : t("services.subtitles.needsKey")}</Badge>
						{!s.enabled && <Badge tone="muted">{t("services.subtitles.notUsed")}</Badge>}
					</>
				),
				note: (
					<>
						{t(`services.subtitles.site.${s.id}` as "services.subtitles.site.subhd", { defaultValue: "" })}
						{s.state.limitUntil && <span className="block text-warning">{t("services.subtitles.limit", { until: new Date(s.state.limitUntil).toLocaleString() })}</span>}
					</>
				),
			}))}
		/>
	);
}

/** Jackett's servers and the indexers they report; each indexer's own result only after a test of them. */
function IndexersCard() {
	const { t } = useTranslation("settings");
	return <PluginService plugin="jackett" title={t("services.indexers.title")} effect={(state) => (state === "connected" ? t("services.indexers.notEachTested") : t("services.indexers.what"))} />;
}

/** Settings → Services: one card per connection (docs/settings.md, "Services: one card per connection"). */
export function Services({ config }: { config: Record<string, unknown> }) {
	const { t } = useTranslation("settings");
	const effect = (kind: "downloads" | "mediaServer") => (state: ServiceState) => (state === "not_tested" ? t("services.notTested") : state === "connected" ? t(`services.${kind}.ok`) : state === "off" || state === "unused" ? t(`services.${kind}.off`) : t(`services.${kind}.broken`));
	return (
		<div className="space-y-4">
			<ActiveProvider config={config} setting="downloader" operation="download.downloaders" kind="downloader" mapSetting="path_maps.downloaders" example={{ theirs: "/downloads", ours: "/media/torrents" }} effect={effect("downloads")} />
			<IndexersCard />
			<ActiveProvider config={config} setting="media_server" operation="library.media_servers" kind="mediaServer" mapSetting="path_maps.media_servers" example={{ theirs: "/data/media", ours: "/media" }} effect={effect("mediaServer")} />
			<TmdbCard />
			<SubtitleSitesCard />
			<TelegramCard />
			<MagpieCard config={config} />
		</div>
	);
}

