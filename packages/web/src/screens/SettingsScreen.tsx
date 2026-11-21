import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, Bot, CheckCircle2, CircleDashed, Cpu, Download, FolderOpen, FolderTree, Gauge, Globe, KeyRound, Lock, MessageSquare, Plug, Puzzle, Send, Stethoscope, Trash2, Tv, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStatus } from "../app/Sidebar";
import { Badge } from "../components/common/Badge";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { Screen } from "../components/common/Screen";
import { AppearanceSection } from "../components/common/ThemePicker";
import { FolderPicker } from "../components/settings/FolderPicker";
import { Plugins, SecretRow } from "../components/settings/Plugins";
import { ErrorState, Loading, Spinner } from "../components/common/States";
import { toast } from "../components/hooks/use-toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { ApiError, endpoints, op, runOp } from "../lib/api";
import { useChat } from "../lib/chat";
import { disablePush, enablePush, isIos, pushState, testPush, type PushState } from "../lib/push";
import { intlLocale } from "../lib/i18n";
import type { DoctorCheck } from "../lib/types";
import { cn, formatNumber, timeAgo } from "../lib/utils";

/** A dollar amount in the UI language's format (magpie limits are in USD). */
const usd = (x: number) => new Intl.NumberFormat(intlLocale(), { style: "currency", currency: "USD", maximumFractionDigits: x > 0 && x < 0.01 ? 4 : 2 }).format(x);

/** The operation does not exist: its plugin is switched off. */
const isPluginOff = (e: unknown) => e instanceof ApiError && e.code === "unknown_operation";

function get(obj: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function Section({ id, icon, title, description, children }: { id: string; icon: ReactNode; title: string; description?: string; children: ReactNode }) {
	return (
		<section id={id} className="surface-card scroll-mt-28 rounded-xl p-4 md:p-6">
			<div className="mb-4 flex items-start gap-3">
				<span className="mt-0.5 text-primary [&_svg]:h-5 [&_svg]:w-5">{icon}</span>
				<div>
					<h2 className="font-semibold">{title}</h2>
					{description && <p className="text-sm text-muted-foreground">{description}</p>}
				</div>
			</div>
			<div className="space-y-4">{children}</div>
		</section>
	);
}

type FieldType = "text" | "number" | "list" | "json" | "select" | "bool" | "folder";

function toText(v: unknown, type: FieldType): string {
	if (v === undefined || v === null) return "";
	if (type === "list") return Array.isArray(v) ? v.join(", ") : String(v);
	if (type === "json") return JSON.stringify(v, null, 2);
	return String(v);
}

function fromText(s: string, type: FieldType): unknown {
	if (type === "number") return s.trim() === "" ? "" : Number(s);
	if (type === "list")
		return s
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean);
	if (type === "json") return s.trim() === "" ? "" : JSON.parse(s);
	return s;
}

/** One setting from config.yaml; saved with config.set (validated and recorded by the server). */
function Field({ config, path, label, help, type = "text", options, placeholder }: { config: Record<string, unknown>; path: string; label: string; help?: string; type?: FieldType; options?: { value: string; label: string }[]; placeholder?: string }) {
	const { t } = useTranslation(["settings", "common"]);
	const qc = useQueryClient();
	const current = get(config, path);
	const [text, setText] = useState(toText(current, type));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [picking, setPicking] = useState(false);
	useEffect(() => setText(toText(current, type)), [JSON.stringify(current), type]);
	const dirty = text !== toText(current, type);

	const save = async (value: unknown) => {
		setBusy(true);
		setError(undefined);
		try {
			const r = await runOp("config.set", { path, value });
			toast({ title: t("field.saved"), description: r.text });
			await qc.invalidateQueries({ queryKey: ["config"] });
			qc.invalidateQueries({ queryKey: ["status"] });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const onSave = () => {
		try {
			void save(fromText(text, type));
		} catch (e) {
			setError(t("field.invalidJson", { error: e instanceof Error ? e.message : String(e) }));
		}
	};

	return (
		<div className="grid gap-1.5 md:grid-cols-[220px_1fr] md:gap-4">
			<div>
				<label className="text-sm font-medium" htmlFor={path}>
					{label}
				</label>
				<p className="font-mono text-[11px] text-muted-foreground">{path}</p>
			</div>
			<div className="min-w-0">
				{type === "bool" ? (
					<Switch id={path} checked={!!current} disabled={busy} onCheckedChange={(v) => void save(v)} />
				) : (
					<div className="flex gap-2">
						{type === "select" ? (
							<select id={path} value={text} onChange={(e) => setText(e.target.value)} className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm">
								<option value="">{t("field.notSet")}</option>
								{options?.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
								{text && !options?.some((o) => o.value === text) && <option value={text}>{text}</option>}
							</select>
						) : type === "json" ? (
							<textarea id={path} value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(8, Math.max(2, text.split("\n").length))} spellCheck={false} placeholder={placeholder} className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
						) : (
							<Input id={path} type={type === "number" ? "number" : "text"} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} onKeyDown={(e) => e.key === "Enter" && dirty && onSave()} />
						)}
						{type === "folder" && (
							<>
								<Button variant="outline" className="shrink-0" disabled={busy} onClick={() => setPicking(true)}>
									<FolderOpen />
									{t("folderPicker.browse")}
								</Button>
								<FolderPicker open={picking} onOpenChange={setPicking} start={text} onChoose={(p) => void save(p)} level={path === "downloads" ? "downloads" : "library"} />
							</>
						)}
						{dirty && (
							<Button onClick={onSave} disabled={busy} className="shrink-0">
								{busy && <Spinner />}
								{t("common:actions.save")}
							</Button>
						)}
					</div>
				)}
				{help && <p className="mt-1 text-xs text-muted-foreground">{help}</p>}
				{error && <p className="mt-1 text-xs text-destructive-foreground">{error}</p>}
			</div>
		</div>
	);
}

function Secrets() {
	const { t } = useTranslation("settings");
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["secrets"], queryFn: endpoints.secrets });
	if (isLoading) return <Spinner />;
	if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
	// The web password has its own form below; a plugin's secrets are on its own page under Plugins.
	const list = (data ?? []).filter((s) => !s.key.startsWith("web.") && !s.key.startsWith("plugins."));
	return (
		<>
			<p className="text-xs text-muted-foreground">{t("secrets.intro")}</p>
			{list.map((s) => (
				<SecretRow key={s.key} s={s} />
			))}
		</>
	);
}

function CheckIcon({ ok }: { ok: boolean | null }) {
	if (ok === true) return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />;
	if (ok === false) return <XCircle className="h-4 w-4 shrink-0 text-destructive-foreground" />;
	return <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function Doctor() {
	const { t } = useTranslation("settings");
	const { askAbout } = useChat();
	const [checks, setChecks] = useState<DoctorCheck[]>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const run = async (quick: boolean) => {
		setBusy(true);
		setError(undefined);
		try {
			setChecks(await endpoints.doctor(quick));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const failed = checks?.filter((c) => c.ok === false) ?? [];
	return (
		<>
			<div className="flex flex-wrap gap-2">
				<Button onClick={() => run(false)} disabled={busy}>
					{busy ? <Spinner /> : <Stethoscope />}
					{t("doctor.runAll")}
				</Button>
				<Button variant="outline" onClick={() => run(true)} disabled={busy}>
					{t("doctor.quick")}
				</Button>
				{failed.length > 0 && (
					<Button variant="ghost" onClick={() => askAbout(t("doctor.askFixPrompt", { count: failed.length, list: failed.map((c) => `${c.name}: ${c.detail}`).join("; ") }))}>
						<MessageSquare /> {t("doctor.askFix")}
					</Button>
				)}
			</div>
			{error && <p className="text-sm text-destructive-foreground">{error}</p>}
			{checks && (
				<div className="space-y-1.5">
					{checks.map((c, i) => (
						<div key={`${c.name}${i}`} className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", c.ok === false ? "bg-destructive/15" : "bg-surface")}>
							<CheckIcon ok={c.ok} />
							<div className="min-w-0 flex-1">
								<p className="font-medium">{c.name}</p>
								<p className="break-words text-xs text-muted-foreground">{c.detail}</p>
								{c.fix && c.ok === false && <p className="mt-0.5 text-xs text-warning">{t("doctor.fix", { fix: c.fix })}</p>}
							</div>
						</div>
					))}
				</div>
			)}
		</>
	);
}

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
			toast({ title: t("notifications.failed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};
	if (isPluginOff(info.error)) return <p className="text-sm text-muted-foreground">{t("notifications.pluginOff")}</p>;
	const hint = state === "needs_https" ? t("notifications.needsHttps") : state === "needs_install" ? t("notifications.needsInstall") : state === "unsupported" ? t(isIos() ? "notifications.unsupportedIos" : "notifications.unsupported") : state === "denied" ? t("notifications.denied") : null;
	return (
		<>
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone={state === "on" ? "success" : state === "off" ? "muted" : "warning"}>{state === "on" ? t("notifications.on") : state === "off" ? t("notifications.off") : t("notifications.notReady")}</Badge>
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
			</div>
			{hint && <p className="text-sm text-muted-foreground">{hint}</p>}
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
		</>
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
			toast({ title: t("channels.notChanged"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};
	if (channels.isLoading) return <Spinner />;
	if (channels.error) return <ErrorState error={channels.error} onRetry={() => channels.refetch()} />;
	if (!channels.data?.length) return <p className="text-sm text-muted-foreground">{t("channels.empty")}</p>;
	return (
		<div className="space-y-2">
			{channels.data.map((c) => (
				<div key={c.id} className="space-y-2 rounded-md bg-surface px-3 py-2">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm font-medium">{c.label}</span>
						<Badge tone={c.linked ? "success" : "muted"}>{c.linked ? t("channels.linked") : t("channels.notLinked")}</Badge>
						{c.linked && (
							<Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" disabled={!!busy} onClick={() => setUnlink(c.id)}>
								{t("channels.unlink")}
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
			<p className="text-xs text-muted-foreground">{t("channels.setUp")}</p>
			<ConfirmDialog open={!!unlink} onOpenChange={(o) => !o && setUnlink(undefined)} title={t("channels.unlinkTitle", { channel: unlink })} description={t("channels.unlinkBody")} confirmLabel={t("channels.unlink")} destructive onConfirm={() => change(unlink!, () => endpoints.unlinkChannel(unlink!)).then(() => setUnlink(undefined))} />
		</div>
	);
}

function Learned() {
	const { t } = useTranslation(["settings", "common"]);
	const qc = useQueryClient();
	const { askAbout } = useChat();
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["skills"], queryFn: endpoints.skills });
	const [open, setOpen] = useState<string>();
	const [remove, setRemove] = useState<string>();
	if (isLoading) return <Spinner />;
	if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
	if (!data?.length) return <p className="text-sm text-muted-foreground">{t("learned.empty")}</p>;
	return (
		<div className="space-y-2">
			{data.map((s) => (
				<div key={s.name} className="rounded-md bg-surface px-3 py-2">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-mono text-sm">{s.name}</span>
						<span className="min-w-0 flex-1 text-xs text-muted-foreground">{s.description}</span>
					</div>
					<div className="mt-1 flex flex-wrap gap-1">
						<Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setOpen(open === s.name ? undefined : s.name)}>
							{open === s.name ? t("common:actions.hide") : t("learned.read")}
						</Button>
						<Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => askAbout(t("learned.changePrompt", { name: s.name }))}>
							<MessageSquare /> {t("learned.changeInChat")}
						</Button>
						<Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive-foreground" onClick={() => setRemove(s.name)}>
							<Trash2 /> {t("learned.delete")}
						</Button>
					</div>
					{open === s.name && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-well p-3 text-xs text-muted-foreground">{s.body}</pre>}
				</div>
			))}
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
		</div>
	);
}

function PasswordForm() {
	const { t } = useTranslation("settings");
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	return (
		<form
			className="grid max-w-md gap-2"
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
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			}}
		>
			<Input type="password" autoComplete="current-password" placeholder={t("account.current")} value={current} onChange={(e) => setCurrent(e.target.value)} />
			<Input type="password" autoComplete="new-password" placeholder={t("account.new")} value={next} onChange={(e) => setNext(e.target.value)} />
			{error && <p className="text-xs text-destructive-foreground">{error}</p>}
			<Button type="submit" disabled={busy || !current || !next} className="justify-self-start">
				{busy && <Spinner />}
				{t("account.change")}
			</Button>
		</form>
	);
}

/** The providers of a seam of the kind "one of several", and the owner's choice among them. */
type ProviderChoice = { active: string; running: boolean; providers: { id: string; label: string; plugin: string }[] };

/** Which downloader Reelix uses (the owner's choice; Reelix never switches by itself), and how its folders look here. */
function DownloaderChoice({ config }: { config: Record<string, unknown> }) {
	const { t } = useTranslation("settings");
	const list = useQuery({ queryKey: ["downloaders", config.downloader], queryFn: () => op<ProviderChoice>("download.downloaders") });
	if (list.isLoading) return <Loading />;
	if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
	const d = list.data!;
	return (
		<>
			<Field config={config} path="downloader" label={t("downloader.active")} type="select" options={d.providers.map((p) => ({ value: p.id, label: p.label }))} help={t("downloader.activeHelp")} />
			{!d.running && <p className="text-sm text-warning">{t("downloader.notRunning", { id: d.active })}</p>}
			<Field config={config} path={`path_maps.downloaders.${d.active}`} label={t("downloader.pathMap")} type="json" help={t("downloader.pathMapHelp", { example: '[{"theirs": "/downloads", "ours": "/media/downloads"}]' })} />
		</>
	);
}

/** Which media server Reelix tells about filed files and reads watch history from (the owner's choice), and how its folders look. */
function MediaServerChoice({ config }: { config: Record<string, unknown> }) {
	const { t } = useTranslation("settings");
	const list = useQuery({ queryKey: ["media-servers", config.media_server], queryFn: () => op<ProviderChoice>("library.media_servers") });
	if (list.isLoading) return <Loading />;
	if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
	const d = list.data!;
	return (
		<>
			<Field config={config} path="media_server" label={t("mediaServer.active")} type="select" options={d.providers.map((p) => ({ value: p.id, label: p.label }))} help={t("mediaServer.activeHelp")} />
			{!d.running && <p className="text-sm text-muted-foreground">{t("mediaServer.notRunning", { id: d.active })}</p>}
			<Field config={config} path={`path_maps.media_servers.${d.active}`} label={t("mediaServer.pathMap")} type="json" help={t("mediaServer.pathMapHelp", { example: '[{"theirs": "/data/media", "ours": "/media"}]' })} />
			<Field config={config} path="players" label={t("mediaServer.players")} type="list" help={t("mediaServer.playersHelp")} />
		</>
	);
}

/** Which translator writes the lines of a subtitle translation (the owner's choice; Reelix never switches by itself). */
function TranslatorChoice({ config }: { config: Record<string, unknown> }) {
	const { t } = useTranslation("settings");
	const list = useQuery({ queryKey: ["translators", config.translator], queryFn: () => op<ProviderChoice>("subtitle.translators") });
	if (list.isLoading) return <Loading />;
	if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
	const d = list.data!;
	return (
		<>
			<Field config={config} path="translator" label={t("models.translator")} type="select" options={d.providers.map((p) => ({ value: p.id, label: p.label }))} help={t("models.translatorHelp")} />
			{!d.running && <p className="text-sm text-warning">{t("models.translatorNotRunning", { id: d.active })}</p>}
		</>
	);
}

const SECTIONS = [
	["status", "nav.status"],
	["appearance", "nav.appearance"],
	["doctor", "nav.doctor"],
	["paths", "nav.paths"],
	["downloaders", "nav.downloader"],
	["media-server", "nav.mediaServer"],
	["services", "nav.services"],
	["secrets", "nav.secrets"],
	["proxy", "nav.proxy"],
	["models", "nav.models"],
	["limits", "nav.limits"],
	["notifications", "nav.notifications"],
	["channels", "nav.channels"],
	["agent", "nav.agent"],
	["learned", "nav.learned"],
	["plugins", "nav.plugins"],
	["account", "nav.account"],
] as const;

/** Settings from config.yaml, secrets, doctor, chat channels, plugins and the account. */
export function SettingsScreen() {
	const { t } = useTranslation("settings");
	const { askAbout } = useChat();
	const config = useQuery({ queryKey: ["config"], queryFn: endpoints.config });
	const { data: status } = useStatus();
	const c = (config.data?.config ?? {}) as Record<string, unknown>;
	const models = (status?.models ?? []).map((m) => ({ value: m, label: m }));
	return (
		<Screen
			title={t("title")}
			subtitle={t("subtitle")}
			toolbar={
				<div className="-mx-1 flex gap-1 overflow-x-auto pb-1">
					{SECTIONS.map(([id, labelKey]) => (
						<a key={id} href={`#${id}`} className="shrink-0 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground">
							{t(labelKey)}
						</a>
					))}
				</div>
			}
		>
			{config.isLoading ? (
				<Loading />
			) : config.error ? (
				<ErrorState error={config.error} onRetry={() => config.refetch()} />
			) : (
				<div className="max-w-4xl space-y-4">
					<Section id="status" icon={<Gauge />} title={t("status.title")}>
						{(config.data?.warning || status?.configWarning) && (
							<p className="flex items-start gap-2 rounded-md bg-warning/15 p-3 text-sm text-warning">
								<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
								{config.data?.warning ?? status?.configWarning}
							</p>
						)}
						<div className="grid gap-2 text-sm sm:grid-cols-2">
							<p>
								<span className="text-muted-foreground">{t("status.mainModel")} </span>
								{status?.model.roles.chat?.uses.join(" › ") || t("status.notSet")}
							</p>
							<p>
								<span className="text-muted-foreground">{t("status.backgroundModel")} </span>
								{status?.model.roles.background?.own.join(" › ") || t("status.sameAsMain")}
							</p>
							<p>
								<span className="text-muted-foreground">{t("status.spendToday")} </span>
								{t("status.spendValue", { usd: formatNumber(status?.spend.usd ?? 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), capUsd: status?.spend.capUsd ?? "?", tokens: (status?.spend.tokens ?? 0).toLocaleString(intlLocale()), capTokens: (status?.spend.capTokens ?? 0).toLocaleString(intlLocale()) })}
								{status?.spend.reached && <Badge tone="warning" className="ml-2">{t("status.capReached")}</Badge>}
							</p>
							<p>
								<span className="text-muted-foreground">{t("status.jobs")} </span>
								{t("status.jobsValue", { running: status?.jobs.running ?? 0, queued: status?.jobs.queued ?? 0, parked: status?.jobs.parked ?? 0 })}
							</p>
						</div>
						{config.data?.summary && (
							<details className="text-xs">
								<summary className="cursor-pointer text-muted-foreground">{t("status.summary")}</summary>
								<pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-well p-3 text-muted-foreground">{config.data.summary}</pre>
							</details>
						)}
					</Section>

					<AppearanceSection />
					<Section id="doctor" icon={<Stethoscope />} title={t("doctor.title")} description={t("doctor.description")}>
						<Doctor />
					</Section>

					<Section id="paths" icon={<FolderTree />} title={t("paths.title")} description={t("paths.description")}>
						<Field config={c} path="media_root" label={t("paths.mediaRoot")} />
						<Field config={c} path="downloads" label={t("paths.downloads")} type="folder" />
						<Field config={c} path="library.movies" label={t("paths.films")} type="folder" />
						<Field config={c} path="library.shows" label={t("paths.shows")} type="folder" />
						<Field config={c} path="library.anime" label={t("paths.anime")} type="folder" />
					</Section>

					<Section id="downloaders" icon={<Download />} title={t("downloader.title")} description={t("downloader.description")}>
						<DownloaderChoice config={c} />
					</Section>

					<Section id="media-server" icon={<Tv />} title={t("mediaServer.title")} description={t("mediaServer.description")}>
						<MediaServerChoice config={c} />
					</Section>

					<Section id="services" icon={<Plug />} title={t("services.title")} description={t("services.description")}>
						<Field config={c} path="subtitles.sources" label={t("services.subtitleSources")} type="list" help={t("services.subtitleSourcesHelp")} />
						<Field config={c} path="subtitles.languages" label={t("services.subtitleLanguages")} type="list" placeholder="zh, en" help={t("services.subtitleLanguagesHelp")} />
					</Section>

					<Section id="secrets" icon={<KeyRound />} title={t("secrets.title")}>
						<Secrets />
					</Section>

					<Section id="proxy" icon={<Globe />} title={t("proxy.title")} description={t("proxy.description")}>
						<Field config={c} path="proxy.default" label={t("proxy.url")} placeholder={t("proxy.urlPlaceholder")} />
						<Field config={c} path="proxy.use_for" label={t("proxy.useFor")} type="list" help={t("proxy.useForHelp")} />
						<Field config={c} path="proxy.per_service" label={t("proxy.perService")} type="json" help='{"telegram": "socks5://…"}' />
					</Section>

					<Section id="models" icon={<Cpu />} title={t("models.title")} description={t("models.description")}>
						{(["chat", "background", "glossary", "translate", "review"] as const).map((r) => (
							<Field
								key={r}
								config={c}
								path={`models.roles.${r}`}
								label={t(`models.role.${r}`)}
								type="list"
								placeholder={r === "chat" ? (models[0]?.value ?? "provider/model") : t("models.inherits", { role: t(`models.role.${({ background: "chat", glossary: "background", translate: "background", review: "translate" } as const)[r]}`) })}
								help={`${t(`models.roleHelp.${r}`)}${status?.model.roles[r]?.resting.length ? ` ${t("models.resting", { models: status.model.roles[r]!.resting.join(", ") })}` : ""}`}
							/>
						))}
						<p className="text-xs text-muted-foreground">{t("models.listHelp", { models: models.map((m) => m.value).join(", ") || "—" })}</p>
						<Field config={c} path="magpie.url" label={t("models.magpieUrl")} placeholder="http://127.0.0.1:3425" help={t("models.magpieHelp")} />
						{status?.model.magpie.url && <p className={`text-xs ${status.model.magpie.ok ? "text-muted-foreground" : "text-warning"}`}>{status.model.magpie.ok ? t("models.magpieOk", { count: status.model.magpie.models.length }) : t("models.magpieDown", { error: status.model.magpie.error ?? "" })}</p>}
						{status?.model.magpie.ok && (
							<p className="text-xs text-muted-foreground">
								{(status.model.magpie.limits ?? []).filter((l) => l.costLimit).map((l) => t(l.spent ? "models.magpieSpent" : "models.magpieLimit", { used: usd(l.cost ?? 0), limit: usd(l.costLimit ?? 0), period: t(`models.magpiePeriod.${(["day", "week", "month", "total"].includes(l.period) ? l.period : "other") as "day" | "week" | "month" | "total" | "other"}`), reset: l.reset ? new Date(l.reset).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" }) : "" })).join(" ")}{" "}
								{t(status.model.magpie.admin ? "models.magpieAdmin" : "models.magpieReadOnly")}
							</p>
						)}
						<Field
							config={c}
							path="models.thinking"
							label={t("models.thinking")}
							type="select"
							options={(["off", "minimal", "low", "medium", "high"] as const).map((v) => ({ value: v, label: t(`models.thinkingLevel.${v}`) }))}
						/>
						<Field config={c} path="models.main_reads_images" label={t("models.readsImages")} type="bool" />
						<TranslatorChoice config={c} />
					</Section>

					<Section id="limits" icon={<Gauge />} title={t("limits.title")} description={t("limits.description")}>
						<Field config={c} path="limits.background_daily_usd" label={t("limits.dailyUsd")} type="number" />
						<Field config={c} path="limits.background_daily_tokens" label={t("limits.dailyTokens")} type="number" />
						<Field config={c} path="limits.plugin_daily_usd" label={t("limits.pluginDailyUsd")} type="number" help={t("limits.pluginDailyUsdHelp")} />
						<Field config={c} path="limits.suggestions_daily_usd" label={t("limits.suggestionsDailyUsd")} type="number" />
						<Field config={c} path="limits.shell_timeout_s" label={t("limits.shellTimeout")} type="number" />
						<Field config={c} path="limits.shell_timeout_max_s" label={t("limits.shellTimeoutMax")} type="number" />
						<Field config={c} path="limits.stalled_after_h" label={t("limits.stalledAfter")} type="number" />
						<Field config={c} path="limits.trash_days" label={t("limits.trashDays")} type="number" />
						<Field config={c} path="schedule.nightly_at" label={t("limits.nightlyAt")} placeholder="03:30" />
						<Field config={c} path="schedule.timezone" label={t("limits.timezone")} placeholder="Asia/Shanghai" />
					</Section>

					<Section id="notifications" icon={<Bell />} title={t("notifications.title")} description={t("notifications.description")}>
						<Notifications />
					</Section>

					<Section id="channels" icon={<Send />} title={t("channels.title")} description={t("channels.description")}>
						<Channels />
					</Section>

					<Section id="agent" icon={<Bot />} title={t("agent.title")} description={t("agent.description")}>
						<div className="flex flex-wrap gap-2">
							<Button variant="outline" onClick={() => askAbout(t("agent.editPrefsPrompt"))}>
								<MessageSquare /> {t("agent.editPrefs")}
							</Button>
							<Button variant="ghost" onClick={() => askAbout(t("agent.whatLearnedPrompt"))}>
								<Bot /> {t("agent.whatLearned")}
							</Button>
						</div>
					</Section>

					<Section id="learned" icon={<Bot />} title={t("learned.title")} description={t("learned.description")}>
						<Learned />
					</Section>

					<Section id="plugins" icon={<Puzzle />} title={t("plugins.title")} description={t("plugins.description")}>
						<Plugins />
					</Section>

					<Section id="account" icon={<Lock />} title={t("account.title")}>
						<PasswordForm />
					</Section>
				</div>
			)}
		</Screen>
	);
}
