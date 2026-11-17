import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CheckCircle2, CircleDashed, Cpu, FolderTree, Gauge, Globe, KeyRound, Lock, MessageSquare, Plug, Send, Stethoscope, Trash2, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useStatus } from "../app/Sidebar";
import { Badge } from "../components/common/Badge";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { Screen } from "../components/common/Screen";
import { ErrorState, Loading, Spinner } from "../components/common/States";
import { toast } from "../components/hooks/use-toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { endpoints, runOp } from "../lib/api";
import { useChat } from "../lib/chat";
import type { DoctorCheck, SecretInfo } from "../lib/types";
import { cn } from "../lib/utils";

function get(obj: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function Section({ id, icon, title, description, children }: { id: string; icon: ReactNode; title: string; description?: string; children: ReactNode }) {
	return (
		<section id={id} className="glass-card scroll-mt-28 rounded-xl p-4 md:p-6">
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

type FieldType = "text" | "number" | "list" | "json" | "select" | "bool";

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
	const qc = useQueryClient();
	const current = get(config, path);
	const [text, setText] = useState(toText(current, type));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	useEffect(() => setText(toText(current, type)), [JSON.stringify(current), type]);
	const dirty = text !== toText(current, type);

	const save = async (value: unknown) => {
		setBusy(true);
		setError(undefined);
		try {
			const r = await runOp("config.set", { path, value });
			toast({ title: "Saved", description: r.text });
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
			setError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
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
								<option value="">(not set)</option>
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
						{dirty && (
							<Button onClick={onSave} disabled={busy} className="shrink-0">
								{busy && <Spinner />}
								Save
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

function SecretRow({ s }: { s: SecretInfo }) {
	const qc = useQueryClient();
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const store = async (v: string) => {
		setBusy(true);
		try {
			await runOp("secret.set", { key: s.key, value: v });
			setValue("");
			toast({ title: v ? "Stored" : "Removed", description: s.key });
			qc.invalidateQueries({ queryKey: ["secrets"] });
			qc.invalidateQueries({ queryKey: ["status"] });
		} catch (e) {
			toast({ title: "Not stored", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="grid gap-1.5 md:grid-cols-[220px_1fr] md:gap-4">
			<div>
				<p className="flex items-center gap-2 text-sm font-medium">
					<span className="font-mono text-xs">{s.key}</span>
					{s.set ? <Badge tone="success">set</Badge> : <Badge tone="warning">missing</Badge>}
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
				<Input type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={s.set ? "Enter a new value to replace it" : "Enter the value"} />
				<Button type="submit" disabled={busy || !value} className="shrink-0">
					{busy && <Spinner />}
					Save
				</Button>
				{s.set && (
					<Button type="button" variant="ghost" disabled={busy} className="shrink-0" onClick={() => store("")}>
						Clear
					</Button>
				)}
			</form>
		</div>
	);
}

function Secrets() {
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["secrets"], queryFn: endpoints.secrets });
	if (isLoading) return <Spinner />;
	if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
	// The web password has its own form below.
	const list = (data ?? []).filter((s) => !s.key.startsWith("web."));
	return (
		<>
			<p className="text-xs text-muted-foreground">Values go straight to the server's secrets file. They are never shown again, and the agent never sees them.</p>
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
					Run all checks
				</Button>
				<Button variant="outline" onClick={() => run(true)} disabled={busy}>
					Quick check
				</Button>
				{failed.length > 0 && (
					<Button variant="ghost" onClick={() => askAbout(`Doctor found ${failed.length} problem(s): ${failed.map((c) => `${c.name}: ${c.detail}`).join("; ")}. Please help me fix them.`)}>
						<MessageSquare /> Ask the agent to fix
					</Button>
				)}
			</div>
			{error && <p className="text-sm text-destructive-foreground">{error}</p>}
			{checks && (
				<div className="space-y-1.5">
					{checks.map((c, i) => (
						<div key={`${c.name}${i}`} className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", c.ok === false ? "bg-destructive/15" : "bg-white/[0.03]")}>
							<CheckIcon ok={c.ok} />
							<div className="min-w-0 flex-1">
								<p className="font-medium">{c.name}</p>
								<p className="break-words text-xs text-muted-foreground">{c.detail}</p>
								{c.fix && c.ok === false && <p className="mt-0.5 text-xs text-warning">Fix: {c.fix}</p>}
							</div>
						</div>
					))}
				</div>
			)}
		</>
	);
}

function Telegram() {
	const { data: status } = useStatus();
	const [code, setCode] = useState<string>();
	const [busy, setBusy] = useState<string>();
	const tg = status?.telegram;
	return (
		<>
			<div className="flex flex-wrap gap-1.5">
				<Badge tone={tg?.configured ? "success" : "warning"}>{tg?.configured ? "bot token set" : "no bot token"}</Badge>
				<Badge tone={tg?.linked ? "success" : "muted"}>{tg?.linked ? "linked to you" : "not linked"}</Badge>
				{tg?.running && <Badge tone="primary">running{tg.bot ? ` as @${tg.bot}` : ""}</Badge>}
				{tg?.error && <Badge tone="danger">{tg.error}</Badge>}
			</div>
			<p className="text-sm text-muted-foreground">Create a bot with @BotFather and store its token as the secret telegram.bot_token above. Then get a one-time code and send it to your bot, so it answers only you.</p>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					disabled={!!busy || !tg?.configured}
					onClick={async () => {
						setBusy("link");
						try {
							setCode((await endpoints.telegramLink()).code);
						} catch (e) {
							toast({ title: "No code", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
						} finally {
							setBusy(undefined);
						}
					}}
				>
					{busy === "link" ? <Spinner /> : <KeyRound />}
					Get a link code
				</Button>
				<Button
					variant="outline"
					disabled={!!busy || !tg?.linked}
					onClick={async () => {
						setBusy("test");
						try {
							const r = await runOp("telegram.test");
							toast({ title: "Sent", description: r.text });
						} catch (e) {
							toast({ title: "Not sent", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
						} finally {
							setBusy(undefined);
						}
					}}
				>
					{busy === "test" ? <Spinner /> : <Send />}
					Send a test message
				</Button>
			</div>
			{code && (
				<div className="rounded-lg border border-primary/40 bg-primary/10 p-3">
					<p className="text-sm">
						Send this code to {tg?.bot ? `@${tg.bot}` : "your bot"} within 10 minutes:
					</p>
					<p className="mt-1 font-mono text-3xl font-bold tracking-[0.3em] text-primary">{code}</p>
				</div>
			)}
		</>
	);
}

function Learned() {
	const qc = useQueryClient();
	const { askAbout } = useChat();
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["skills"], queryFn: endpoints.skills });
	const [open, setOpen] = useState<string>();
	const [remove, setRemove] = useState<string>();
	if (isLoading) return <Spinner />;
	if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
	if (!data?.length) return <p className="text-sm text-muted-foreground">Nothing yet. When the agent works something out about your setup (a site's quirks, a naming habit), it writes it down as a skill and it shows up here.</p>;
	return (
		<div className="space-y-2">
			{data.map((s) => (
				<div key={s.name} className="rounded-md bg-white/[0.03] px-3 py-2">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-mono text-sm">{s.name}</span>
						<span className="min-w-0 flex-1 text-xs text-muted-foreground">{s.description}</span>
					</div>
					<div className="mt-1 flex flex-wrap gap-1">
						<Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setOpen(open === s.name ? undefined : s.name)}>
							{open === s.name ? "Hide" : "Read"}
						</Button>
						<Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => askAbout(`About the skill "${s.name}" you wrote: change this: `)}>
							<MessageSquare /> Change in chat
						</Button>
						<Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive-foreground" onClick={() => setRemove(s.name)}>
							<Trash2 /> Delete
						</Button>
					</div>
					{open === s.name && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-black/30 p-3 text-xs text-muted-foreground">{s.body}</pre>}
				</div>
			))}
			<ConfirmDialog
				open={!!remove}
				onOpenChange={(o) => !o && setRemove(undefined)}
				title={`Delete "${remove}"?`}
				description="The agent forgets what this skill told it."
				destructive
				confirmLabel="Delete"
				onConfirm={async () => {
					await runOp("skills.delete", { name: remove });
					await qc.invalidateQueries({ queryKey: ["skills"] });
				}}
			/>
		</div>
	);
}

function PasswordForm() {
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
				if (next.length < 8) return setError("Use at least 8 characters.");
				setBusy(true);
				try {
					await endpoints.changePassword(current, next);
					setCurrent("");
					setNext("");
					toast({ title: "Password changed" });
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			}}
		>
			<Input type="password" autoComplete="current-password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
			<Input type="password" autoComplete="new-password" placeholder="New password (8+ characters)" value={next} onChange={(e) => setNext(e.target.value)} />
			{error && <p className="text-xs text-destructive-foreground">{error}</p>}
			<Button type="submit" disabled={busy || !current || !next} className="justify-self-start">
				{busy && <Spinner />}
				Change password
			</Button>
		</form>
	);
}

const SECTIONS = [
	["status", "Status"],
	["doctor", "Doctor"],
	["paths", "Paths"],
	["services", "Services"],
	["secrets", "Secrets"],
	["proxy", "Proxy"],
	["models", "Models"],
	["limits", "Limits"],
	["telegram", "Telegram"],
	["agent", "Preferences"],
	["learned", "Learned"],
	["account", "Account"],
] as const;

/** Settings from config.yaml, secrets, doctor, Telegram and the account. */
export function SettingsScreen() {
	const { askAbout } = useChat();
	const config = useQuery({ queryKey: ["config"], queryFn: endpoints.config });
	const { data: status } = useStatus();
	const c = (config.data?.config ?? {}) as Record<string, unknown>;
	const models = (status?.models ?? []).map((m) => ({ value: m, label: m }));
	return (
		<Screen
			title="Settings"
			subtitle="Connections, paths, models, limits and access"
			toolbar={
				<div className="-mx-1 flex gap-1 overflow-x-auto pb-1">
					{SECTIONS.map(([id, label]) => (
						<a key={id} href={`#${id}`} className="shrink-0 rounded-full border border-white/10 px-3 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground">
							{label}
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
				<div className="mx-auto max-w-4xl space-y-4">
					<Section id="status" icon={<Gauge />} title="Status">
						{(config.data?.warning || status?.configWarning) && (
							<p className="flex items-start gap-2 rounded-md bg-warning/15 p-3 text-sm text-warning">
								<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
								{config.data?.warning ?? status?.configWarning}
							</p>
						)}
						<div className="grid gap-2 text-sm sm:grid-cols-2">
							<p>
								<span className="text-muted-foreground">Main model: </span>
								{status?.model.main ?? "not set"}
							</p>
							<p>
								<span className="text-muted-foreground">Background model: </span>
								{status?.model.background ?? "same as main"}
							</p>
							<p>
								<span className="text-muted-foreground">Background spend today: </span>${status?.spend.usd.toFixed(2) ?? "0"} / ${status?.spend.capUsd ?? "?"} · {(status?.spend.tokens ?? 0).toLocaleString()} / {(status?.spend.capTokens ?? 0).toLocaleString()} tokens
								{status?.spend.reached && <Badge tone="warning" className="ml-2">cap reached</Badge>}
							</p>
							<p>
								<span className="text-muted-foreground">Jobs: </span>
								{status?.jobs.running ?? 0} running · {status?.jobs.queued ?? 0} queued · {status?.jobs.parked ?? 0} waiting for you
							</p>
						</div>
						{config.data?.summary && (
							<details className="text-xs">
								<summary className="cursor-pointer text-muted-foreground">Summary as the agent sees it</summary>
								<pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-black/30 p-3 text-muted-foreground">{config.data.summary}</pre>
							</details>
						)}
					</Section>

					<Section id="doctor" icon={<Stethoscope />} title="Doctor" description="Checks connections, paths, hard links, permissions, space and indexers.">
						<Doctor />
					</Section>

					<Section id="paths" icon={<FolderTree />} title="Paths" description="Where media lives, as Reelix sees it. Downloads and library must be on the same file system for hard links.">
						<Field config={c} path="media_root" label="Media root" />
						<Field config={c} path="downloads" label="Downloads folder" />
						<Field config={c} path="library.movies" label="Films" />
						<Field config={c} path="library.shows" label="Shows" />
						<Field config={c} path="library.anime" label="Anime" />
						<Field config={c} path="path_maps.qbittorrent" label="qBittorrent path maps" type="json" help='How qBittorrent names the same folders: [{"theirs": "/downloads", "ours": "/media/downloads"}]' />
						<Field config={c} path="path_maps.jellyfin" label="Jellyfin path maps" type="json" />
					</Section>

					<Section id="services" icon={<Plug />} title="Services" description="Addresses of the services Reelix uses. Passwords and API keys go under Secrets.">
						<Field config={c} path="qbittorrent.url" label="qBittorrent URL" placeholder="http://qbittorrent:8080" />
						<Field config={c} path="qbittorrent.username" label="qBittorrent user" />
						<Field config={c} path="jackett.url" label="Jackett URL" placeholder="http://jackett:9117" />
						<Field config={c} path="jellyfin.url" label="Jellyfin URL" placeholder="http://jellyfin:8096" />
						<Field config={c} path="tmdb.language" label="TMDB language" />
						<Field config={c} path="subtitles.sources" label="Subtitle sources" type="list" help="Comma-separated, in order of preference." />
					</Section>

					<Section id="secrets" icon={<KeyRound />} title="Secrets">
						<Secrets />
					</Section>

					<Section id="proxy" icon={<Globe />} title="Proxy" description="For services that are blocked or slow from home (TMDB, Telegram, subtitle sites).">
						<Field config={c} path="proxy.default" label="Proxy URL" placeholder="http://192.168.1.2:7890 or socks5://…" />
						<Field config={c} path="proxy.use_for" label="Use it for" type="list" help="Comma-separated services, e.g. tmdb, telegram, subhd, models." />
						<Field config={c} path="proxy.per_service" label="Per service" type="json" help='{"telegram": "socks5://…"}' />
					</Section>

					<Section id="models" icon={<Cpu />} title="Models" description="Models come from pi's sign-in and models file; only those with credentials are listed.">
						<Field config={c} path="models.main" label="Main model" type="select" options={models} help="Used in chat." />
						<Field config={c} path="models.background" label="Background model" type="select" options={models} help="Used by background jobs; empty means the main model." />
						<Field
							config={c}
							path="models.thinking"
							label="Thinking"
							type="select"
							options={["off", "minimal", "low", "medium", "high"].map((v) => ({ value: v, label: v }))}
						/>
						<Field config={c} path="models.main_reads_images" label="Main model reads images" type="bool" />
					</Section>

					<Section id="limits" icon={<Gauge />} title="Limits and schedule" description="Background work stops starting new model runs at the cap; chat is not capped.">
						<Field config={c} path="limits.background_daily_usd" label="Daily cap (USD)" type="number" />
						<Field config={c} path="limits.background_daily_tokens" label="Daily cap (tokens)" type="number" />
						<Field config={c} path="limits.shell_timeout_s" label="Shell timeout (s)" type="number" />
						<Field config={c} path="limits.shell_timeout_max_s" label="Shell timeout max (s)" type="number" />
						<Field config={c} path="limits.stalled_after_h" label="Stalled after (h)" type="number" />
						<Field config={c} path="limits.trash_days" label="Keep trash (days)" type="number" />
						<Field config={c} path="schedule.nightly_at" label="Nightly tidy-up at" placeholder="03:30" />
						<Field config={c} path="schedule.timezone" label="Time zone" placeholder="Asia/Shanghai" />
					</Section>

					<Section id="telegram" icon={<Send />} title="Telegram" description="Notices with pictures, answers with buttons, and a standing chat thread.">
						<Telegram />
					</Section>

					<Section id="agent" icon={<Bot />} title="Preferences and what the agent learned" description="Your taste in releases and subtitles, and things the agent has learned, live in notes the agent keeps. Change them by talking to it.">
						<div className="flex flex-wrap gap-2">
							<Button variant="outline" onClick={() => askAbout("Show me my preferences note, then let's change it: ")}>
								<MessageSquare /> Edit preferences in chat
							</Button>
							<Button variant="ghost" onClick={() => askAbout("What have you learned about my setup and taste so far? List your notes.")}>
								<Bot /> What has it learned?
							</Button>
						</div>
					</Section>

					<Section id="learned" icon={<Bot />} title="Things I've learned" description="Skills the agent wrote for itself.">
						<Learned />
					</Section>

					<Section id="account" icon={<Lock />} title="Account">
						<PasswordForm />
					</Section>
				</div>
			)}
		</Screen>
	);
}
