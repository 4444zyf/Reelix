import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, Bot, CheckCircle2, CircleDashed, Cpu, Film, FolderOpen, FolderTree, Gauge, Globe, Lock, MessageSquare, Play, Plug, Puzzle, Search, Send, SlidersHorizontal, Stethoscope, Subtitles, Trash2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStatus } from "../app/Sidebar";
import { Badge } from "../components/common/Badge";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { Screen } from "../components/common/Screen";
import { AppearanceSection } from "../components/common/ThemePicker";
import { ErrorState, Loading, Spinner } from "../components/common/States";
import { toast } from "../components/hooks/use-toast";
import { FolderPicker } from "../components/settings/FolderPicker";
import { type Folder, LibraryFolders, tidyFolders } from "../components/settings/LibraryFolders";
import { CheckRow, Doctor, FolderChecks } from "../components/settings/Doctor";
import { HookOrder, Plugins, pluginNeedsAttention } from "../components/settings/Plugins";
import { ModelSetup, ModelTest } from "../components/settings/ModelSetup";
import { Providers } from "../components/settings/Providers";
import { Services } from "../components/settings/Services";
import { type ConfigDraft, Disclosure, OrderedPicker, Row, SaveBar, Searchable, Section, type SettingsView, SettingsViewProvider, getPath, useConfigDraft } from "../components/settings/form";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { ApiError, endpoints, op, runOp } from "../lib/api";
import { useChat } from "../lib/chat";
import { disablePush, enablePush, isIos, pushState, testPush, type PushState } from "../lib/push";
import { intlLocale } from "../lib/i18n";
import type { ModelFailure } from "../lib/types";
import { failureReason } from "../components/common/ModelFailure";
import { cn, formatNumber, timeAgo } from "../lib/utils";

/** A dollar amount in the UI language's format (magpie limits are in USD). */
const usd = (x: number) => new Intl.NumberFormat(intlLocale(), { style: "currency", currency: "USD", maximumFractionDigits: x > 0 && x < 0.01 ? 4 : 2 }).format(x);

/** The operation does not exist: its plugin is switched off. */
const isPluginOff = (e: unknown) => e instanceof ApiError && e.code === "unknown_operation";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Jump to a section or card of this page. */
function jump(id: string) {
	const el = document.getElementById(id);
	if (!el) return;
	history.replaceState(null, "", `#${id}`);
	el.scrollIntoView({ behavior: "smooth", block: "start" });
	el.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
}

/** A form that saves with its SaveBar (Enter in a field saves too). */
function DraftForm({ draft, children }: { draft: ConfigDraft; children: React.ReactNode }) {
	return (
		<form
			className="space-y-4"
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				if (draft.dirty) void draft.save();
			}}
		>
			{children}
			<SaveBar dirty={draft.dirty} busy={draft.busy} onSave={() => void draft.save()} onDiscard={draft.discard} />
		</form>
	);
}

/** A text or number field of a config draft. */
function TextField({ draft, path, label, help, number, placeholder }: { draft: ConfigDraft; path: string; label: string; help?: string; number?: boolean; placeholder?: string }) {
	const v = draft.get(path);
	return (
		<Row label={label} htmlFor={path} help={help} technical={path} error={draft.errors[path]}>
			<Input
				id={path}
				type={number ? "number" : "text"}
				value={v === undefined || v === null ? "" : String(v)}
				placeholder={placeholder}
				onChange={(e) => draft.set(path, e.target.value === "" ? undefined : number ? Number(e.target.value) : e.target.value)}
			/>
		</Row>
	);
}

// ---------------------------------------------------------------- Status: what needs the owner, most important first

type Attention = { key: string; cause: string; effect: string; action: string; target: string };

function StatusSection({ warning }: { warning?: string }) {
	const { t } = useTranslation("settings");
	const { data: status } = useStatus();
	const plugins = useQuery({ queryKey: ["plugins"], queryFn: endpoints.plugins });
	const secrets = useQuery({ queryKey: ["secrets"], queryFn: endpoints.secrets });
	// Doctor's quick checks add what the states above do not know (a folder, a path map, a tool).
	const quick = useQuery({ queryKey: ["doctor-quick"], queryFn: () => endpoints.doctor(true), staleTime: 60_000 });
	const items: Attention[] = [];
	if (warning) items.push({ key: "config", cause: warning, effect: t("attention.configEffect"), action: t("attention.openDoctor"), target: "doctor" });
	if (status && !status.models.length) items.push({ key: "model", cause: t("attention.noModel"), effect: t("attention.noModelEffect"), action: t("attention.connectModel"), target: "models" });
	if (secrets.data && !secrets.data.find((s) => s.key === "tmdb.api_key")?.set) items.push({ key: "tmdb", cause: t("attention.noTmdb"), effect: t("attention.noTmdbEffect"), action: t("attention.addKey"), target: "service-tmdb" });
	const services = ["qbittorrent", "jackett", "jellyfin", "subtitle-sites", "telegram"];
	for (const p of plugins.data ?? []) {
		if (p.state === "disabled" || !pluginNeedsAttention(p)) continue;
		const where = services.includes(p.id) ? `service-${p.id}` : `plugin-${p.id}`;
		const cause = p.needsSetup.length ? t("attention.needsSetup", { name: p.id }) : p.state === "waiting" ? t("attention.waiting", { name: p.id }) : t("attention.failed", { name: p.id });
		items.push({ key: p.id, cause, effect: p.description, action: p.needsSetup.length ? t("attention.setUp") : t("attention.look"), target: where });
	}
	if (status?.spend.reached) items.push({ key: "spend", cause: t("attention.capReached"), effect: t("attention.capReachedEffect"), action: t("attention.openLimits"), target: "limits" });
	const shown = new Set([...items.map((i) => i.key), "tmdb"]);
	const checks = (quick.data ?? []).filter((c) => (c.state === "failed" || c.state === "degraded") && !shown.has(c.name) && !c.also?.some((n) => shown.has(n)));
	const roles = status?.model.roles;
	return (
		<Section id="status" icon={<Gauge />} title={t("status.title")} keywords={[t("attention.title")]}>
			<Searchable text={[t("attention.title"), ...items.map((i) => i.cause), ...checks.map((c) => c.name)]} attention={items.length + checks.length > 0}>
				{items.length + checks.length ? (
					<ul className="space-y-2">
						{items.map((i) => (
							<li key={i.key} className="flex flex-wrap items-start gap-3 rounded-md bg-warning/10 px-3 py-2">
								<AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
								<div className="min-w-0 flex-1 text-sm">
									<p className="font-medium">{i.cause}</p>
									<p className="text-xs text-muted-foreground">{i.effect}</p>
								</div>
								<Button size="sm" variant="outline" onClick={() => jump(i.target)}>
									{i.action}
								</Button>
							</li>
						))}
						{checks.map((c) => (
							<li key={c.name}>
								<CheckRow check={c} onRerun={() => void quick.refetch()} />
							</li>
						))}
					</ul>
				) : (
					<p className="flex items-center gap-2 text-sm text-muted-foreground">
						<CheckCircle2 className="size-4 text-success" /> {t("attention.none")}
					</p>
				)}
			</Searchable>
			<Searchable text={[t("status.mainModel"), t("status.spendToday"), t("status.jobs")]}>
				<div className="grid gap-2 text-sm sm:grid-cols-2">
					<p>
						<span className="text-muted-foreground">{t("status.mainModel")} </span>
						{roles?.chat?.uses.join(" › ") || t("status.notSet")}
					</p>
					<p>
						<span className="text-muted-foreground">{t("status.backgroundModel")} </span>
						{roles?.background?.own.join(" › ") || t("status.sameAsMain")}
					</p>
					<p>
						<span className="text-muted-foreground">{t("status.spendToday")} </span>
						{t("status.spendValue", { usd: formatNumber(status?.spend.usd ?? 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), capUsd: status?.spend.capUsd ?? "?", tokens: (status?.spend.tokens ?? 0).toLocaleString(intlLocale()), capTokens: (status?.spend.capTokens ?? 0).toLocaleString(intlLocale()) })}
					</p>
					<p>
						<span className="text-muted-foreground">{t("status.jobs")} </span>
						{t("status.jobsValue", { running: status?.jobs.running ?? 0, queued: status?.jobs.queued ?? 0, parked: status?.jobs.parked ?? 0 })}
					</p>
				</div>
			</Searchable>
		</Section>
	);
}

// ---------------------------------------------------------------- Models

const ROLES = ["chat", "background", "glossary", "translate", "review"] as const;
const INHERITS = { background: "chat", glossary: "background", translate: "background", review: "translate" } as const;
type ProviderChoice = { active: string; running: boolean; providers: { id: string; label: string; plugin: string }[] };

function ModelsSection({ config }: { config: Record<string, unknown> }) {
	const { t } = useTranslation("settings");
	const { data: status } = useStatus();
	const translators = useQuery({ queryKey: ["translators", config.translator], queryFn: () => op<ProviderChoice>("subtitle.translators") });
	const draft = useConfigDraft(config, [...ROLES.map((r) => `models.roles.${r}`), "models.thinking", "translator"]);
	const available = status?.models ?? [];
	const magpie = status?.model.magpie;
	return (
		<Section id="models" icon={<Cpu />} title={t("models.title")} description={t("models.descriptionShort")}>
			<Searchable text={[t("attention.noModel")]} attention={!!status && !available.length}>
				<ModelSetup />
			</Searchable>
			{!!available.length && (
				<Row label={t("models.providers")} help={t("models.providersHelp")}>
					<Providers compact />
				</Row>
			)}
			<DraftForm draft={draft}>
				{ROLES.map((r) => {
					const path = `models.roles.${r}`;
					const value = (draft.get(path) as string[] | undefined) ?? [];
					const uses = status?.model.roles[r]?.uses ?? [];
					const resting = status?.model.roles[r]?.resting ?? [];
					const inherits = r !== "chat" && !value.length;
					return (
						<Row
							key={r}
							label={t(`models.role.${r}`)}
							technical={path}
							error={draft.errors[path]}
							help={
								<>
									{t(`models.roleHelp.${r}`)} {uses.length > 0 && (inherits ? t("models.usesInherited", { models: uses.join(" › "), role: t(`models.role.${INHERITS[r as keyof typeof INHERITS]}`) }) : t("models.uses", { models: uses.join(" › ") }))}
									{resting.map((m) => (
										<RestingNote key={m} model={m} rest={status?.model.rests.find((x) => x.model === m)} />
									))}
								</>
							}
							attention={r === "chat" && !uses.length}
						>
							<OrderedPicker items={available.map((m) => ({ id: m, label: m }))} value={value} onChange={(v) => draft.set(path, v.length ? v : undefined)} unknownNote={t("models.notAvailable")} />
						</Row>
					);
				})}
				<Row label={t("models.testRole")} help={t("models.testRoleHelp")}>
					<ModelTest disabled={!available.length} />
				</Row>
				<Row label={t("models.reasoning")} htmlFor="models.thinking" help={t("models.reasoningHelp")} technical="models.thinking" error={draft.errors["models.thinking"]}>
					<select id="models.thinking" value={(draft.get("models.thinking") as string | undefined) ?? ""} onChange={(e) => draft.set("models.thinking", e.target.value || undefined)} className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm">
						<option value="">{t("field.notSet")}</option>
						{(["off", "minimal", "low", "medium", "high"] as const).map((v) => (
							<option key={v} value={v}>
								{t(`models.thinkingLevel.${v}`)}
							</option>
						))}
					</select>
				</Row>
				<Row label={t("models.translator")} htmlFor="translator" help={t("models.translatorHelpShort")} technical="translator" error={draft.errors.translator}>
					{translators.data ? (
						<select id="translator" value={(draft.get("translator") as string | undefined) ?? translators.data.active} onChange={(e) => draft.set("translator", e.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm">
							{translators.data.providers.map((p) => (
								<option key={p.id} value={p.id}>
									{p.label}
								</option>
							))}
						</select>
					) : (
						<Spinner />
					)}
					{translators.data && !translators.data.running && <p className="mt-1 text-xs text-warning">{t("models.translatorNotRunning", { id: translators.data.active })}</p>}
				</Row>
			</DraftForm>
			{magpie?.ok && (
				<Searchable text={["magpie"]}>
					<p className="text-xs text-muted-foreground">
						{(magpie.limits ?? [])
							.filter((l) => l.costLimit)
							.map((l) => t(l.spent ? "models.magpieSpent" : "models.magpieLimit", { used: usd(l.cost ?? 0), limit: usd(l.costLimit ?? 0), period: t(`models.magpiePeriod.${(["day", "week", "month", "total"].includes(l.period) ? l.period : "other") as "day"}`), reset: l.reset ? new Date(l.reset).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" }) : "" }))
							.join(" ")}{" "}
						{t(magpie.admin ? "models.magpieAdmin" : "models.magpieReadOnly")}
					</p>
				</Searchable>
			)}
		</Section>
	);
}

/** A model resting after a failure: why, and from when it is tried again. */
function RestingNote({ model, rest }: { model: string; rest?: { until: string } & ModelFailure }) {
	const { t } = useTranslation("settings");
	const { t: tm } = useTranslation("models");
	return (
		<span className="block text-warning">
			{rest ? t("models.restingWhy", { model, reason: failureReason(tm, rest), until: new Date(rest.until).toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" }) }) : t("models.resting", { models: model })}
		</span>
	);
}

// ---------------------------------------------------------------- Folders

const KINDS = ["movies", "shows", "anime"] as const;

function FoldersSection({ config }: { config: Record<string, unknown> }) {
	const { t } = useTranslation("settings");
	const libraryPaths = KINDS.map((k) => `library.${k}`);
	const draft = useConfigDraft(config, ["media_root", "downloads", ...libraryPaths], Object.fromEntries(libraryPaths.map((p) => [p, (v: unknown) => tidyFolders((v as Folder[]) ?? [])])));
	const [picking, setPicking] = useState(false);
	const downloads = (draft.get("downloads") as string | undefined) ?? "";
	return (
		<Section id="folders" icon={<FolderTree />} title={t("folders.title")} description={t("folders.description")}>
			<DraftForm draft={draft}>
				<TextField draft={draft} path="media_root" label={t("folders.mediaRoot")} help={t("folders.mediaRootHelp")} />
				<Row label={t("folders.downloads")} htmlFor="downloads" help={t("folders.downloadsHelp")} technical="downloads" error={draft.errors.downloads} attention={!downloads}>
					<div className="flex gap-2">
						<Input id="downloads" value={downloads} onChange={(e) => draft.set("downloads", e.target.value || undefined)} />
						<Button type="button" variant="outline" className="shrink-0" onClick={() => setPicking(true)}>
							<FolderOpen />
							{t("folderPicker.browse")}
						</Button>
					</div>
					<FolderPicker open={picking} onOpenChange={setPicking} start={downloads} onChoose={(p) => draft.set("downloads", p)} level="downloads" />
					{typeof config.downloads === "string" && config.downloads === downloads && <FolderChecks path={downloads} className="mt-2" />}
				</Row>
				<p className="text-xs text-muted-foreground">{t("folders.libraryIntro")}</p>
				{KINDS.map((k) => (
					<LibraryFolders
						key={k}
						kind={k}
						label={t(`folders.${k}`)}
						value={(draft.get(`library.${k}`) as Folder[] | undefined) ?? []}
						onChange={(v) => draft.set(`library.${k}`, v)}
						showsFolders={((draft.get("library.shows") as unknown[]) ?? []).length}
						learn={((getPath(config, `library.${k}`) as unknown[]) ?? []).length > 1 && !draft.dirty}
						error={draft.errors[`library.${k}`]}
						saved={((getPath(config, `library.${k}`) as Folder[] | undefined) ?? []).map((f) => f.path)}
					/>
				))}
			</DraftForm>
		</Section>
	);
}

// ---------------------------------------------------------------- Subtitles, playback, proxy

const SUB_LANGS = ["zh", "en", "fr", "ru", "ja"] as const;
type Site = { id: string; label: string; ready: string };

function SubtitlesSection({ config }: { config: Record<string, unknown> }) {
	const { t } = useTranslation("settings");
	const sites = useQuery({ queryKey: ["site.status"], queryFn: () => op<Site[]>("site.status"), retry: false });
	const draft = useConfigDraft(config, ["subtitles.sources", "subtitles.languages"]);
	return (
		<Section id="subtitles" icon={<Subtitles />} title={t("subtitles.title")} description={t("subtitles.description")}>
			<DraftForm draft={draft}>
				<Row label={t("subtitles.sources")} help={t("subtitles.sourcesHelp")} technical="subtitles.sources" error={draft.errors["subtitles.sources"]}>
					{sites.data ? (
						<OrderedPicker
							items={sites.data.map((s) => ({ id: s.id, label: s.label, note: s.ready === "ready" ? undefined : t("subtitles.needsAccount"), warn: s.ready !== "ready" }))}
							value={(draft.get("subtitles.sources") as string[] | undefined) ?? []}
							onChange={(v) => draft.set("subtitles.sources", v)}
							unknownNote={t("subtitles.notRunning")}
						/>
					) : isPluginOff(sites.error) ? (
						<p className="text-sm text-muted-foreground">{t("subtitles.sitesOff")}</p>
					) : (
						<Spinner />
					)}
				</Row>
				<Row label={t("subtitles.languages")} help={t("subtitles.languagesHelp")} technical="subtitles.languages" error={draft.errors["subtitles.languages"]}>
					<OrderedPicker items={SUB_LANGS.map((l) => ({ id: l, label: t(`subtitles.lang.${l}`) }))} value={(draft.get("subtitles.languages") as string[] | undefined) ?? []} onChange={(v) => draft.set("subtitles.languages", v.length ? v : undefined)} />
				</Row>
			</DraftForm>
		</Section>
	);
}

type Player = { id: string; label: string; needs_media_server: boolean; works: boolean };

function PlaybackSection({ config }: { config: Record<string, unknown> }) {
	const { t } = useTranslation("settings");
	const players = useQuery({ queryKey: ["library.players", config.media_server], queryFn: () => op<Player[]>("library.players"), retry: false });
	const draft = useConfigDraft(config, ["players"]);
	return (
		<Section id="playback" icon={<Play />} title={t("playback.title")} description={t("playback.description")}>
			<DraftForm draft={draft}>
				<Row label={t("playback.players")} help={t("playback.playersHelp")} technical="players" error={draft.errors.players}>
					{players.data ? (
						<OrderedPicker
							items={players.data.map((p) => ({ id: p.id, label: p.label, note: p.needs_media_server ? t(p.works ? "playback.needsServer" : "playback.needsServerMissing") : undefined, warn: !p.works }))}
							value={(draft.get("players") as string[] | undefined) ?? []}
							onChange={(v) => draft.set("players", v)}
							unknownNote={t("playback.notRunning")}
						/>
					) : (
						<Spinner />
					)}
				</Row>
			</DraftForm>
		</Section>
	);
}

function ProxySection({ config }: { config: Record<string, unknown> }) {
	const { t } = useTranslation("settings");
	const services = useQuery({ queryKey: ["proxy.services"], queryFn: () => op<{ id: string; label: string }[]>("proxy.services") });
	const draft = useConfigDraft(config, ["proxy.default", "proxy.use_for"]);
	const useFor = (draft.get("proxy.use_for") as string[] | undefined) ?? [];
	const known = services.data ?? [];
	const listed = [...known, ...useFor.filter((s) => !known.some((k) => k.id === s)).map((id) => ({ id, label: id }))];
	return (
		<Section id="proxy" icon={<Globe />} title={t("proxy.title")} description={t("proxy.description")}>
			<DraftForm draft={draft}>
				<TextField draft={draft} path="proxy.default" label={t("proxy.url")} placeholder={t("proxy.urlPlaceholder")} />
				<Row label={t("proxy.useFor")} help={t("proxy.useForHelpNamed")} technical="proxy.use_for" error={draft.errors["proxy.use_for"]}>
					<div className="flex flex-wrap gap-x-4 gap-y-2">
						{listed.map((s) => (
							<label key={s.id} className="flex items-center gap-2 text-sm">
								<input type="checkbox" checked={useFor.includes(s.id)} onChange={(e) => draft.set("proxy.use_for", e.target.checked ? [...useFor, s.id] : useFor.filter((x) => x !== s.id))} />
								{s.label}
							</label>
						))}
					</div>
				</Row>
			</DraftForm>
		</Section>
	);
}

// ---------------------------------------------------------------- Limits and Advanced

function LimitsSection({ config }: { config: Record<string, unknown> }) {
	const { t } = useTranslation("settings");
	const { data: status } = useStatus();
	const draft = useConfigDraft(config, ["limits.background_daily_usd", "limits.background_daily_tokens", "limits.plugin_daily_usd", "limits.suggestions_daily_usd", "limits.stalled_after_h", "limits.trash_days", "schedule.nightly_at", "schedule.timezone"]);
	return (
		<Section id="limits" icon={<Gauge />} title={t("limits.title")} description={t("limits.description")}>
			{status?.spend.reached && (
				<p className="flex items-center gap-2 text-sm text-warning">
					<AlertTriangle className="size-4" /> {t("attention.capReachedEffect")}
				</p>
			)}
			<DraftForm draft={draft}>
				<TextField draft={draft} path="limits.background_daily_usd" number label={t("limits.dailyUsd")} help={t("limits.dailyHelp")} />
				<TextField draft={draft} path="limits.background_daily_tokens" number label={t("limits.dailyTokens")} help={t("limits.dailyHelp")} />
				<TextField draft={draft} path="limits.plugin_daily_usd" number label={t("limits.pluginDailyUsd")} help={t("limits.pluginDailyUsdHelp")} />
				<TextField draft={draft} path="limits.suggestions_daily_usd" number label={t("limits.suggestionsDailyUsd")} help={t("limits.suggestionsHelp")} />
				<TextField draft={draft} path="limits.stalled_after_h" number label={t("limits.stalledAfter")} help={t("limits.stalledHelp")} />
				<TextField draft={draft} path="limits.trash_days" number label={t("limits.trashDays")} help={t("limits.trashHelp")} />
				<TextField draft={draft} path="schedule.nightly_at" label={t("limits.nightlyAt")} placeholder="03:30" help={t("limits.nightlyHelp")} />
				<TextField draft={draft} path="schedule.timezone" label={t("limits.timezone")} placeholder="Asia/Shanghai" />
			</DraftForm>
		</Section>
	);
}

type PerService = { service: string; proxy: string }[];

function AdvancedSection({ config, summary }: { config: Record<string, unknown>; summary?: string }) {
	const { t } = useTranslation("settings");
	const services = useQuery({ queryKey: ["proxy.services"], queryFn: () => op<{ id: string; label: string }[]>("proxy.services") });
	const draft = useConfigDraft(config, ["limits.shell_timeout_s", "limits.shell_timeout_max_s", "proxy.per_service"], {
		"proxy.per_service": (v) => Object.fromEntries(((v as PerService | undefined) ?? []).filter((r) => r.service).map((r) => [r.service, r.proxy || "none"])),
	});
	// The per-service proxies as rows while they are edited; saved as the object config.yaml holds.
	const raw = draft.get("proxy.per_service");
	const rows: PerService = Array.isArray(raw) ? raw : Object.entries((raw as Record<string, string> | undefined) ?? {}).map(([service, proxy]) => ({ service, proxy: proxy === "none" ? "" : proxy }));
	const setRows = (r: PerService) => draft.set("proxy.per_service", r);
	return (
		<Section id="advanced" icon={<SlidersHorizontal />} title={t("advanced.title")} description={t("advanced.description")}>
			<DraftForm draft={draft}>
				<TextField draft={draft} path="limits.shell_timeout_s" number label={t("limits.shellTimeout")} help={t("advanced.shellHelp")} />
				<TextField draft={draft} path="limits.shell_timeout_max_s" number label={t("limits.shellTimeoutMax")} />
				<Row label={t("proxy.perService")} help={t("advanced.perServiceHelp")} technical="proxy.per_service" error={draft.errors["proxy.per_service"]}>
					<div className="space-y-2">
						{rows.map((r, i) => (
							<div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
								<select aria-label={t("advanced.service")} value={r.service} onChange={(e) => setRows(rows.map((x, n) => (n === i ? { ...x, service: e.target.value } : x)))} className="h-10 rounded-md border border-input bg-background px-2 text-sm">
									<option value="">{t("advanced.chooseService")}</option>
									{[...(services.data ?? []), ...(r.service && !services.data?.some((s) => s.id === r.service) ? [{ id: r.service, label: r.service }] : [])].map((s) => (
										<option key={s.id} value={s.id}>
											{s.label}
										</option>
									))}
								</select>
								<Input aria-label={t("proxy.url")} value={r.proxy} placeholder={t("advanced.noProxy")} onChange={(e) => setRows(rows.map((x, n) => (n === i ? { ...x, proxy: e.target.value } : x)))} />
								<Button type="button" variant="ghost" size="icon" aria-label={t("pathMap.remove")} onClick={() => setRows(rows.filter((_, n) => n !== i))}>
									<Trash2 />
								</Button>
							</div>
						))}
						<Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { service: "", proxy: "" }])}>
							{t("advanced.addService")}
						</Button>
					</div>
				</Row>
			</DraftForm>
			<HookOrder />
			{summary && (
				<Searchable text={[t("status.summary")]}>
					<Disclosure title={t("status.summary")}>
						<pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-well p-3 text-xs text-muted-foreground">{summary}</pre>
					</Disclosure>
				</Searchable>
			)}
		</Section>
	);
}

// ---------------------------------------------------------------- Notifications and chat apps

/** Native notifications on this device, and the other devices that have them (docs/web-app.md). */
function Notifications() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const info = useQuery({ queryKey: ["push"], queryFn: endpoints.push, retry: false });
	const [state, setState] = useState<PushState>();
	const [busy, setBusy] = useState<string>();
	const devices = info.data?.devices;
	useEffect(() => {
		if (devices) void pushState(devices).then(setState);
	}, [devices]);
	const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
		setBusy(key);
		try {
			await fn();
			if (done) toast({ title: done });
			await qc.invalidateQueries({ queryKey: ["push"] });
			setState(await pushState((await endpoints.push()).devices));
		} catch (e) {
			toast({ title: t("notifications.failed"), description: message(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};
	if (isPluginOff(info.error))
		return (
			<Searchable text={[t("notifications.thisDevice")]}>
				<p className="text-sm text-muted-foreground">{t("notifications.pluginOff")}</p>
			</Searchable>
		);
	const hint = state === "needs_https" ? null : state === "needs_install" ? t("notifications.needsInstall") : state === "unsupported" ? t(isIos() ? "notifications.unsupportedIos" : "notifications.unsupported") : state === "denied" ? t("notifications.denied") : null;
	return (
		<Row label={t("notifications.thisDevice")} badge={<Badge tone={state === "on" ? "success" : state === "off" ? "muted" : "warning"}>{state === "on" ? t("notifications.on") : state === "off" ? t("notifications.off") : t("notifications.notReady")}</Badge>} search={[hint ?? undefined]}>
			<div className="space-y-2">
				{hint && <p className="text-sm text-muted-foreground">{hint}</p>}
				{state === "needs_https" && <HttpsHelp />}
				<div className="flex flex-wrap items-center gap-2">
					{state === "off" && (
						<Button variant="outline" disabled={!!busy} onClick={() => run("on", enablePush)}>
							{busy === "on" ? <Spinner /> : <Bell />}
							{t("notifications.enable")}
						</Button>
					)}
					{state === "on" && (
						<>
							<Button variant="outline" disabled={!!busy} onClick={() => run("test", testPush, t("notifications.sent"))}>
								{busy === "test" ? <Spinner /> : <Send />}
								{t("notifications.sendTest")}
							</Button>
							<Button variant="ghost" disabled={!!busy} onClick={() => run("off", disablePush)}>
								{t("notifications.disable")}
							</Button>
						</>
					)}
					{state && state !== "on" && state !== "off" && <span className="text-xs text-muted-foreground">{t("notifications.inboxWorks")}</span>}
				</div>
				{!!devices?.length && (
					<div className="space-y-1">
						<p className="text-xs font-semibold text-muted-foreground">{t("notifications.devices")}</p>
						{devices.map((d) => (
							<div key={d.id} className="flex items-center gap-2 rounded-md bg-surface px-2.5 py-1.5 text-xs">
								<div className="min-w-0 flex-1">
									<p className="font-medium">{d.label}</p>
									<p className={cn("break-words text-muted-foreground", d.last_error && "text-warning")}>{d.last_error ?? (d.last_ok_at ? t("notifications.lastSent", { ago: timeAgo(d.last_ok_at) }) : t("notifications.notSentYet"))}</p>
								</div>
								<Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("notifications.remove")} title={t("notifications.remove")} disabled={!!busy} onClick={() => run(d.id, () => endpoints.pushUnsubscribe({ id: d.id }))}>
									<Trash2 />
								</Button>
							</div>
						))}
					</div>
				)}
			</div>
		</Row>
	);
}

/** Why this device gets no notifications over plain HTTP, what still works, and how to get HTTPS (docs/web-app.md). */
function HttpsHelp() {
	const { t } = useTranslation("settings");
	const channels = useQuery({ queryKey: ["channels"], queryFn: endpoints.channels });
	const linked = channels.data?.filter((c) => c.linked) ?? [];
	return (
		<div className="space-y-1 text-sm text-muted-foreground">
			<p>{t("notifications.needsHttpsInbox")}</p>
			<p>
				{t("notifications.httpsHow")}{" "}
				<a href="https://github.com/4444zyf/Reelix/blob/main/docs/web-app.md" target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
					{t("notifications.httpsGuide")}
				</a>
			</p>
			<p className="font-mono text-xs">tailscale serve --bg 7878</p>
			{linked.length > 0 && <p>{t("notifications.otherChannels", { channels: linked.map((c) => c.label).join(", ") })}</p>}
		</div>
	);
}

/** Chat apps the owner talks to Reelix from: who is linked and whether answers there may approve (docs/plugins.md §7.4). */
function Channels() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const channels = useQuery({ queryKey: ["channels"], queryFn: endpoints.channels, refetchInterval: 15_000 });
	const [busy, setBusy] = useState<string>();
	const [unlink, setUnlink] = useState<string>();
	const change = async (key: string, fn: () => Promise<unknown>) => {
		setBusy(key);
		try {
			await fn();
			await qc.invalidateQueries({ queryKey: ["channels"] });
		} catch (e) {
			toast({ title: t("channels.notChanged"), description: message(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};
	if (channels.isLoading) return <Spinner />;
	if (channels.error) return <ErrorState error={channels.error} onRetry={() => channels.refetch()} />;
	return (
		<Row label={t("channels.title")} help={t("channels.setUpHere")}>
			<div className="space-y-2">
				{!channels.data?.length && <p className="text-sm text-muted-foreground">{t("channels.empty")}</p>}
				{channels.data?.map((c) => (
					<div key={c.id} className="space-y-2 rounded-md bg-surface px-3 py-2">
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-sm font-medium">{c.label}</span>
							<Badge tone={c.linked ? "success" : "muted"}>{c.linked ? t("channels.linked") : t("channels.notLinked")}</Badge>
							{c.linked ? (
								<Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" disabled={!!busy} onClick={() => setUnlink(c.id)}>
									{t("channels.unlink")}
								</Button>
							) : (
								<Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={() => jump(`service-${c.id}`)}>
									{t("channels.link")}
								</Button>
							)}
						</div>
						{c.last_error && <p className="break-words text-xs text-warning">{t("channels.sendFailed", { ago: c.last_error_at ? timeAgo(c.last_error_at) : "", error: c.last_error })}</p>}
						{c.linked && (
							<div className="flex items-start gap-3">
								<Switch id={`approve-${c.id}`} checked={c.may_approve} disabled={!!busy} onCheckedChange={(on) => void change(c.id, () => endpoints.allowChannelApproval(c.id, on))} />
								<label htmlFor={`approve-${c.id}`} className="min-w-0 text-sm">
									<span className="font-medium">{t("channels.mayApprove")}</span>
									<span className="block text-xs text-muted-foreground">{t("channels.mayApproveHelp")}</span>
								</label>
							</div>
						)}
					</div>
				))}
			</div>
			<ConfirmDialog open={!!unlink} onOpenChange={(o) => !o && setUnlink(undefined)} title={t("channels.unlinkTitle", { channel: unlink })} description={t("channels.unlinkBody")} confirmLabel={t("channels.unlink")} destructive onConfirm={() => change(unlink!, () => endpoints.unlinkChannel(unlink!)).then(() => setUnlink(undefined))} />
		</Row>
	);
}

// ---------------------------------------------------------------- Assistant

/** The preferences note, edited in place; or in chat, when a model can be used. */
function Preferences() {
	const { t } = useTranslation("settings");
	const { askAbout } = useChat();
	const { data: status } = useStatus();
	const qc = useQueryClient();
	const note = useQuery({ queryKey: ["preferences"], queryFn: () => op<{ text: string }>("preferences.show") });
	const [text, setText] = useState<string>();
	const [busy, setBusy] = useState(false);
	useEffect(() => setText(note.data?.text), [note.data?.text]);
	const dirty = text !== undefined && text !== note.data?.text;
	const save = async () => {
		setBusy(true);
		try {
			await runOp("preferences.set", { text: text ?? "" });
			toast({ title: t("field.saved") });
			await qc.invalidateQueries({ queryKey: ["preferences"] });
		} catch (e) {
			toast({ title: t("field.notSaved"), description: message(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	return (
		<Row label={t("assistant.preferences")} htmlFor="preferences" search={[t("assistant.preferencesHelp")]}>
			<form className="space-y-2" onSubmit={(e) => (e.preventDefault(), void save())}>
				<p className="text-xs text-muted-foreground">{t("assistant.preferencesHelp")}</p>
				<textarea id="preferences" value={text ?? ""} onChange={(e) => setText(e.target.value)} rows={Math.min(14, Math.max(4, (text ?? "").split("\n").length + 1))} placeholder={t("assistant.preferencesEmpty")} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
				{!!status?.models.length && (
					<Button type="button" variant="ghost" size="sm" onClick={() => askAbout(t("agent.editPrefsPrompt"))}>
						<MessageSquare /> {t("assistant.editInChat")}
					</Button>
				)}
				<SaveBar dirty={dirty} busy={busy} onSave={() => void save()} onDiscard={() => setText(note.data?.text)} />
			</form>
		</Row>
	);
}

/** Skills the assistant wrote: the description first; the name and body under Technical details. */
function Learned() {
	const { t } = useTranslation(["settings", "common"]);
	const qc = useQueryClient();
	const { askAbout } = useChat();
	const { data: status } = useStatus();
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["skills"], queryFn: endpoints.skills });
	const [remove, setRemove] = useState<string>();
	if (isLoading) return <Spinner />;
	if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
	return (
		<Row label={t("assistant.learned")} search={[t("learned.description")]}>
			<div className="space-y-2">
				{!data?.length && <p className="text-sm text-muted-foreground">{t("learned.empty")}</p>}
				{data?.map((s) => (
					<div key={s.name} className="space-y-1 rounded-md bg-surface px-3 py-2">
						<p className="text-sm">{s.description}</p>
						<div className="flex flex-wrap gap-1">
							{!!status?.models.length && (
								<Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => askAbout(t("learned.changePrompt", { name: s.name }))}>
									<MessageSquare /> {t("learned.changeInChat")}
								</Button>
							)}
							<Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive-foreground" onClick={() => setRemove(s.name)}>
								<Trash2 /> {t("learned.delete")}
							</Button>
						</div>
						<Disclosure title={t("form.technical")}>
							<p className="font-mono text-xs">{s.name}</p>
							<pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-well p-3 text-xs text-muted-foreground">{s.body}</pre>
						</Disclosure>
					</div>
				))}
			</div>
			<ConfirmDialog
				open={!!remove}
				onOpenChange={(o) => !o && setRemove(undefined)}
				title={t("learned.deleteTitle", { name: remove })}
				description={t("learned.deleteDescription")}
				destructive
				confirmLabel={t("learned.delete")}
				onConfirm={async () => {
					await runOp("skills.delete", { name: remove });
					await qc.invalidateQueries({ queryKey: ["skills"] });
				}}
			/>
		</Row>
	);
}

function PasswordForm() {
	const { t } = useTranslation("settings");
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	return (
		<Row label={t("account.change")}>
			<form
				className="grid max-w-md gap-3"
				onSubmit={async (e) => {
					e.preventDefault();
					setError(undefined);
					if (next.length < 8) return setError(t("account.tooShort"));
					setBusy(true);
					try {
						await endpoints.changePassword(current, next);
						setCurrent("");
						setNext("");
						toast({ title: t("account.changed") });
					} catch (err) {
						setError(message(err));
					} finally {
						setBusy(false);
					}
				}}
			>
				<label className="grid gap-1 text-sm">
					{t("account.current")}
					<Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
				</label>
				<label className="grid gap-1 text-sm">
					{t("account.new")}
					<Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
				</label>
				{error && <p className="text-xs text-destructive-foreground">{error}</p>}
				<Button type="submit" disabled={busy || !current || !next} className="justify-self-end">
					{busy && <Spinner />}
					{t("account.change")}
				</Button>
			</form>
		</Row>
	);
}

// ---------------------------------------------------------------- the page

const SECTIONS = [
	["status", "nav.status"],
	["models", "nav.models"],
	["services", "nav.services"],
	["folders", "nav.folders"],
	["subtitles", "nav.subtitles"],
	["playback", "nav.playback"],
	["proxy", "nav.proxy"],
	["limits", "nav.limits"],
	["notifications", "nav.notifications"],
	["appearance", "nav.appearance"],
	["plugins", "nav.plugins"],
	["assistant", "nav.assistant"],
	["account", "nav.account"],
	["doctor", "nav.doctor"],
	["advanced", "nav.advanced"],
] as const;

function Toolbar({ view, setView }: { view: SettingsView; setView: (v: SettingsView) => void }) {
	const { t } = useTranslation("settings");
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				<label className="relative min-w-0 flex-1 basis-56">
					<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input type="search" value={view.query} onChange={(e) => setView({ ...view, query: e.target.value })} placeholder={t("search.placeholder")} aria-label={t("search.label")} className="h-9 pl-9" />
				</label>
				<Button type="button" size="sm" variant={view.attention ? "secondary" : "ghost"} aria-pressed={view.attention} onClick={() => setView({ ...view, attention: !view.attention })}>
					<AlertTriangle /> {t("search.attention")}
				</Button>
				<Button type="button" size="sm" variant={view.technical ? "secondary" : "ghost"} aria-pressed={view.technical} onClick={() => setView({ ...view, technical: !view.technical })}>
					{t("search.technical")}
				</Button>
			</div>
			<nav className="-mx-1 flex gap-1 overflow-x-auto pb-1" aria-label={t("search.sections")}>
				{SECTIONS.map(([id, labelKey]) => (
					<a key={id} href={`#${id}`} className="shrink-0 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground">
						{t(labelKey)}
					</a>
				))}
			</nav>
		</div>
	);
}

/** Settings (docs/settings.md): what needs attention first, then each part of Reelix as a form with one Save. */
export function SettingsScreen() {
	const { t } = useTranslation("settings");
	const config = useQuery({ queryKey: ["config"], queryFn: endpoints.config });
	const { data: status } = useStatus();
	const [view, setView] = useState<SettingsView>({ query: "", attention: false, technical: false });
	const c = (config.data?.config ?? {}) as Record<string, unknown>;
	// A link to a part of the page (#service-qbittorrent) lands there once the page has loaded.
	useEffect(() => {
		if (config.data && location.hash) setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" }), 300);
	}, [!!config.data]);
	return (
		<Screen title={t("title")} subtitle={t("subtitle")} toolbar={<Toolbar view={view} setView={setView} />} className="md:pr-36">
			{config.isLoading ? (
				<Loading />
			) : config.error ? (
				<ErrorState error={config.error} onRetry={() => config.refetch()} />
			) : (
				<SettingsViewProvider value={view}>
					<div className="max-w-4xl space-y-4">
						<StatusSection warning={config.data?.warning ?? status?.configWarning} />
						<ModelsSection config={c} />
						<Section id="services" icon={<Plug />} title={t("services.title")} description={t("services.descriptionCards")}>
							<Services config={c} />
						</Section>
						<FoldersSection config={c} />
						<SubtitlesSection config={c} />
						<PlaybackSection config={c} />
						<ProxySection config={c} />
						<LimitsSection config={c} />
						<Section id="notifications" icon={<Bell />} title={t("notifications.title")} description={t("notifications.description")}>
							<Notifications />
							<Channels />
						</Section>
						<AppearanceSection />
						<Section id="plugins" icon={<Puzzle />} title={t("plugins.title")} description={t("plugins.description")}>
							<Plugins />
						</Section>
						<Section id="assistant" icon={<Bot />} title={t("assistant.title")} description={t("assistant.description")}>
							<Preferences />
							<Learned />
						</Section>
						<Section id="account" icon={<Lock />} title={t("account.title")}>
							<PasswordForm />
						</Section>
						<Section id="doctor" icon={<Stethoscope />} title={t("doctor.title")} description={t("doctor.description")}>
							<Searchable text={[t("doctor.title"), t("doctor.description")]}>
								<Doctor />
							</Searchable>
						</Section>
						<AdvancedSection config={c} summary={config.data?.summary} />
						{view.query && <NothingFound />}
					</div>
				</SettingsViewProvider>
			)}
		</Screen>
	);
}

/** Shown under the sections; visible only when every section is hidden by the search. */
function NothingFound() {
	const { t } = useTranslation("settings");
	const [none, setNone] = useState(false);
	useEffect(() => {
		const check = () => setNone(![...document.querySelectorAll("section[id]")].some((s) => !(s as HTMLElement).hidden));
		check();
		const watch = new MutationObserver(check);
		watch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
		return () => watch.disconnect();
	}, []);
	if (!none) return null;
	return (
		<p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
			<Film className="size-4" /> {t("search.nothing")}
		</p>
	);
}
